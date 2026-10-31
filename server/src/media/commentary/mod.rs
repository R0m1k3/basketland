//! File de traduction des commentaires des replays (équivalent de
//! `src/lib/commentary.ts`) — portée en Rust à l'étape 6b, **pas encore
//! branchée** : aucune route ni aucun job ne la construit ; Node fait
//! toujours tourner sa file tant que les routes médias ne sont pas basculées
//! ensemble.
//!
//! TRADUCTION À LA DEMANDE, devant la tête de lecture : tronçons (1 à
//! 2 min) à partir de la position du spectateur — audio (ffmpeg) → Whisper →
//! filtre des hallucinations, sous-titres → traduction → publication du
//! tronçon (`commentary_cues` + `commentary_chunks`) → tronçon suivant.
//! Sans signe de vie du spectateur, le travail se met en pause et les
//! modèles sont déchargés ; en tâche de fond, seule la fenêtre de nuit
//! (`COMMENTARY_NIGHT_WINDOW`) traduit les matchs récents.
//!
//! File : un seul travail à la fois (GPU partagé). Backoff (état dans
//! `kv_cache`, clé `commentary:<id>`) : flux vidéo ou service injoignable →
//! nouvel essai rapide (15 min → 6 h), sans compter dans l'abandon ; autre
//! échec → 1 h, 4 h, 16 h, 24 h, puis abandon tant que la vidéo ne change pas.
//!
//! # Service
//!
//! [`Commentary`] porte l'état de la file (en mémoire, comme le
//! `globalThis.__commentaryQueue` de Node) : un seul par processus, partagé
//! par `Clone` (`Arc`). Il doit être utilisé dans un runtime Tokio (les
//! travaux sont lancés par `tokio::spawn`). Ses méthodes de file sont
//! synchrones, comme celles de Node (base SQLite locale lue directement).
//!
//! # Points de branchement du doublage
//!
//! Le doublage ([`crate::media::dub`]) se branche par deux crochets posés
//! APRÈS la construction, par `Dub::new` / `Dub::with_options` (le doublage
//! tient lui-même un `Commentary`) :
//! - [`Commentary::set_gpu_gate`] (`__commentaryGpuGate`) : appelé de façon
//!   synchrone au démarrage de chaque travail de traduction ; rend `None`
//!   s'il n'y a rien à libérer (la traduction part aussitôt), sinon une
//!   attente (le doublage en cours a été interrompu et ferme sa session de
//!   voix ; Node attend au plus 20 s) ;
//! - [`Commentary::set_dub_wants_audio`] (`__dubWantsAudio`) : le doublage
//!   veut-il le son complet de ce match (doublage en cours ou en file) ? Si
//!   oui, la fin d'une traduction garde `full.ogg` dans le dossier de travail.
//!
//! Les crochets doivent capturer le doublage par référence faible (`Weak`)
//! pour ne pas créer de cycle d'`Arc`. Le doublage appelle en retour
//! [`Commentary::slice_full_audio`], [`Commentary::drop_full_audio`],
//! [`audio_sources`], [`Commentary::activity`],
//! [`Commentary::queue_position`], [`Commentary::ready`],
//! [`Commentary::running_match_id`] et [`Commentary::enqueue`], et partage la
//! table des spectateurs et l'horloge du service ([`Commentary::viewers`],
//! [`Commentary::now`]). Les routes appelleront [`Commentary::status`],
//! [`Commentary::served_cues`], [`Commentary::touch_viewer`],
//! [`Commentary::nudge`], [`Commentary::prioritize_on_view`] ; le cron
//! [`Commentary::enqueue_recent`].

mod plan;
mod run;
mod workdir;

pub use plan::{
    analysis_sources, audio_sources, backoff_ms, chunk_at, chunk_cues, chunk_name, chunk_words,
    covered_from, cues_from_chunks, network_backoff_ms, next_chunk, pick_analysis_source,
    pick_audio_source, plan_chunks, words_from_chunks, AnalysisSource, ChunkCue, ChunkPlan,
    SourceKind, StreamInfo, CHUNK_OVERLAP_SEC, MAX_AUTO_FAILURES,
};
pub use run::{
    CloseFn, CommentaryDeps, CutFn, EnvelopeFn, ExtractFn, ExtractRequest, OpenTranscriberFn,
    OpenTranslatorFn, ResolveStreamFn, SessionTranscribeFn, TranscribeFn, Transcriber, TranslateFn,
    TranslatorSession,
};
pub use workdir::{
    full_audio_file, full_audio_wanted, prune_work_dirs, work_dir, ExtractFullFn, FullAudioState,
};

use crate::commentary_db::{self as cdb, CommentaryCueRow, CommentaryTrackRow};
use crate::db::{self, Db, MatchRow};
use crate::media::abort::AbortSignal;
use crate::media::commentary_ai::{commentary_config, CommentaryConfig, Service, ServiceError};
use crate::media::viewers::{viewers, Viewers};
use crate::settings::Settings;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::Notify;

/// Futur « boxé » des dépendances et crochets injectables.
pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Horloge (ms depuis l'époque, comme `Date.now()`), injectable pour les tests.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `Number(process.env[name]) || def` (absente, vide, non numérique ou 0 : `def`).
pub(crate) fn env_num_or(name: &str, def: f64) -> f64 {
    let n = std::env::var(name)
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    if n.is_nan() || n == 0.0 {
        def
    } else {
        n
    }
}

// ---------------------------------------------------------------- contrat de l'API

/// Phase d'un travail (`CommentaryPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentaryPhase {
    Extraction,
    Preparation,
    Transcription,
    Traduction,
}

impl CommentaryPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            CommentaryPhase::Extraction => "extraction",
            CommentaryPhase::Preparation => "preparation",
            CommentaryPhase::Transcription => "transcription",
            CommentaryPhase::Traduction => "traduction",
        }
    }
}

/// Avancement d'un travail (`CommentaryProgress`). Extraction, transcription,
/// traduction : en tronçons ; préparation : téléchargement d'un modèle, en Mo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CommentaryProgress {
    pub phase: CommentaryPhase,
    pub done: f64,
    pub total: f64,
    /// Secondes de vidéo couvertes par les sous-titres publiés jusqu'ici.
    pub available_until: Option<f64>,
}

/// Rappel d'avancement d'un travail.
pub type ProgressFn = Arc<dyn Fn(CommentaryProgress) + Send + Sync>;

/// Statut de la traduction d'un match (`CommentaryStatus`, contrat de l'API).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryStatus {
    /// 'disabled' | 'none' | 'queued' | 'running' | 'ready' | 'failed'.
    pub status: &'static str,
    pub phase: Option<CommentaryPhase>,
    pub progress: Option<(f64, f64)>,
    pub available_until: Option<f64>,
    pub position: Option<usize>,
    pub covered: Option<Vec<[f64; 2]>>,
    pub reason: Option<String>,
    /// (transcription, traduction).
    pub models: Option<(String, String)>,
}

impl CommentaryStatus {
    fn new(status: &'static str) -> Self {
        CommentaryStatus {
            status,
            phase: None,
            progress: None,
            available_until: None,
            position: None,
            covered: None,
            reason: None,
            models: None,
        }
    }

    /// Objet JSON de Node, clés dans l'ordre où chaque branche de
    /// `commentaryStatus` les écrit.
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let mut m = Map::new();
        m.insert("status".into(), Value::from(self.status));
        if let Some(p) = self.phase {
            m.insert("phase".into(), Value::from(p.as_str()));
        }
        if let Some((d, t)) = self.progress {
            m.insert("progress".into(), json!({ "done": n(d), "total": n(t) }));
        }
        if let Some(p) = self.position {
            m.insert("position".into(), Value::from(p));
        }
        let models = self
            .models
            .as_ref()
            .map(|(t, l)| json!({ "transcribe": t, "translate": l }));
        if self.status == "ready" {
            if let Some(v) = models.clone() {
                m.insert("models".into(), v);
            }
        }
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::from(r.clone()));
        }
        if let Some(u) = self.available_until {
            m.insert("available_until".into(), n(u));
        }
        if let Some(c) = &self.covered {
            m.insert(
                "covered".into(),
                Value::Array(c.iter().map(|[a, b]| json!([n(*a), n(*b)])).collect()),
            );
        }
        if self.status != "ready" {
            if let Some(v) = models {
                m.insert("models".into(), v);
            }
        }
        Value::Object(m)
    }
}

/// Nature d'un échec (`CommentaryFailureKind`) : `Reseau` et `Service` sont
/// réessayés vite, sans compter dans l'abandon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Reseau,
    Service,
    Contenu,
    Erreur,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureKind::Reseau => "reseau",
            FailureKind::Service => "service",
            FailureKind::Contenu => "contenu",
            FailureKind::Erreur => "erreur",
        }
    }

    fn parse(s: &str) -> Option<FailureKind> {
        Some(match s {
            "reseau" => FailureKind::Reseau,
            "service" => FailureKind::Service,
            "contenu" => FailureKind::Contenu,
            "erreur" => FailureKind::Erreur,
            _ => return None,
        })
    }
}

/// `quickRetry`.
fn quick_retry(k: Option<FailureKind>) -> bool {
    matches!(k, Some(FailureKind::Reseau | FailureKind::Service))
}

/// Dernier résultat d'un match (`CommentaryRecord`, `kv_cache` `commentary:<id>`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryRecord {
    pub at: String,
    pub ok: bool,
    /// Absent du JSON : `None` (se comporte comme `undefined` côté Node).
    pub failures: Option<f64>,
    pub net_failures: Option<f64>,
    pub kind: Option<FailureKind>,
    pub reason: String,
    pub ok_id: Option<String>,
}

impl CommentaryRecord {
    pub fn from_json(v: &Value) -> Option<CommentaryRecord> {
        let o = v.as_object()?;
        Some(CommentaryRecord {
            at: crate::js::str_or_empty(o.get("at")),
            ok: crate::js::truthy(o.get("ok")),
            failures: o.get("failures").and_then(Value::as_f64),
            net_failures: o.get("netFailures").and_then(Value::as_f64),
            kind: o
                .get("kind")
                .and_then(Value::as_str)
                .and_then(FailureKind::parse),
            reason: crate::js::str_or_empty(o.get("reason")),
            ok_id: o.get("okId").and_then(Value::as_str).map(String::from),
        })
    }

    /// Objet écrit par Node : `{ at, ok, failures, reason, okId, kind?, netFailures? }`.
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let mut m = Map::new();
        m.insert("at".into(), Value::from(self.at.clone()));
        m.insert("ok".into(), Value::from(self.ok));
        m.insert("failures".into(), n(self.failures.unwrap_or(0.0)));
        m.insert("reason".into(), Value::from(self.reason.clone()));
        m.insert(
            "okId".into(),
            self.ok_id.clone().map_or(Value::Null, Value::from),
        );
        if let Some(k) = self.kind {
            m.insert("kind".into(), Value::from(k.as_str()));
        }
        if let Some(nf) = self.net_failures.filter(|x| *x != 0.0) {
            m.insert("netFailures".into(), n(nf));
        }
        Value::Object(m)
    }
}

fn parse_ms(at: &str) -> f64 {
    crate::time::parse_instant(at).map_or(f64::NAN, |d| d.timestamp_millis() as f64)
}

/// `commentaryRetryAllowed` : une mise en file AUTOMATIQUE est-elle permise
/// maintenant (`now` en ms) ?
pub fn commentary_retry_allowed(
    rec: Option<&CommentaryRecord>,
    ok_id: Option<&str>,
    now: f64,
) -> bool {
    let Some(rec) = rec else { return true };
    if rec.ok {
        return true; // succès : seule l'absence de piste pour la vidéo actuelle compte
    }
    if let (Some(a), Some(b)) = (
        ok_id.filter(|s| !s.is_empty()),
        rec.ok_id.as_deref().filter(|s| !s.is_empty()),
    ) {
        if a != b {
            return true; // nouvelle vidéo : on repart de zéro
        }
    }
    let at = parse_ms(&rec.at);
    if quick_retry(rec.kind) {
        return now - at >= network_backoff_ms_f(rec.net_failures.unwrap_or(1.0));
    }
    let failures = rec.failures.unwrap_or(f64::NAN);
    if failures >= MAX_AUTO_FAILURES as f64 {
        return false;
    }
    now - at >= backoff_ms_f(failures)
}

fn backoff_ms_f(f: f64) -> f64 {
    if f <= 0.0 {
        return 0.0;
    }
    crate::js::min(24.0 * 3_600_000.0, 3_600_000.0 * 4f64.powf(f - 1.0))
}

fn network_backoff_ms_f(f: f64) -> f64 {
    if f <= 0.0 {
        return 0.0;
    }
    crate::js::min(6.0 * 3_600_000.0, 15.0 * 60_000.0 * 2f64.powf(f - 1.0))
}

/// Erreur d'un travail ou d'une dépendance : panne d'un service
/// (transcription, traduction : échec « service ») ou autre (échec « erreur »).
#[derive(Debug, Clone, PartialEq)]
pub enum CommentaryError {
    Service(ServiceError),
    Other(String),
}

impl CommentaryError {
    pub fn message(&self) -> &str {
        match self {
            CommentaryError::Service(e) => &e.message,
            CommentaryError::Other(m) => m,
        }
    }

    /// `new ServiceError(msg, service)`.
    pub fn service(message: impl Into<String>, service: Service) -> Self {
        CommentaryError::Service(ServiceError {
            message: message.into(),
            service,
        })
    }
}

impl std::fmt::Display for CommentaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<ServiceError> for CommentaryError {
    fn from(e: ServiceError) -> Self {
        CommentaryError::Service(e)
    }
}

impl From<crate::media::commentary_ai::AiError> for CommentaryError {
    fn from(e: crate::media::commentary_ai::AiError) -> Self {
        match e {
            crate::media::commentary_ai::AiError::Service(s) => CommentaryError::Service(s),
            crate::media::commentary_ai::AiError::Other(m) => CommentaryError::Other(m),
        }
    }
}

impl From<String> for CommentaryError {
    fn from(m: String) -> Self {
        CommentaryError::Other(m)
    }
}

/// Résultat d'un travail (`CommentaryOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryOutcome {
    pub ok: bool,
    pub reason: String,
    pub kind: Option<FailureKind>,
    /// Mis en pause (plus de spectateur, fin de la fenêtre de nuit) : ni succès ni échec.
    pub paused: bool,
}

impl CommentaryOutcome {
    pub fn ok(reason: impl Into<String>) -> Self {
        CommentaryOutcome {
            ok: true,
            reason: reason.into(),
            kind: None,
            paused: false,
        }
    }

    pub fn failed(kind: FailureKind, reason: impl Into<String>) -> Self {
        CommentaryOutcome {
            ok: false,
            reason: reason.into(),
            kind: Some(kind),
            paused: false,
        }
    }

    pub fn paused(reason: impl Into<String>) -> Self {
        CommentaryOutcome {
            ok: false,
            reason: reason.into(),
            kind: None,
            paused: true,
        }
    }
}

/// Un travail de la file (`Job`).
#[derive(Debug, Clone)]
pub struct Job {
    pub match_id: i64,
    /// Relance explicite (« retry ») : refait même une piste prête.
    pub force: bool,
    /// Demandé par quelqu'un qui regarde la fiche : passe devant un travail de fond.
    pub viewer: bool,
    /// Demande EXPLICITE : traduit jusqu'au bout, fiche fermée, hors fenêtre.
    /// Partagé : une demande explicite pendant le travail le rend explicite.
    explicit: Arc<AtomicBool>,
}

impl Job {
    pub fn new(match_id: i64, force: bool) -> Job {
        Job {
            match_id,
            force,
            viewer: false,
            explicit: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with(match_id: i64, force: bool, viewer: bool, explicit: bool) -> Job {
        Job {
            match_id,
            force,
            viewer,
            explicit: Arc::new(AtomicBool::new(explicit)),
        }
    }

    pub fn explicit(&self) -> bool {
        self.explicit.load(Ordering::SeqCst)
    }

    /// Copie détachée (`{ ...job }`) : la valeur d'`explicit` est recopiée.
    fn copy(&self, viewer: bool) -> Job {
        Job::with(self.match_id, self.force, viewer, self.explicit())
    }
}

/// Pilotage d'un travail par la file (`CommentaryControl`).
#[derive(Clone)]
pub struct CommentaryControl {
    /// Continuer ? Sinon pause après le tronçon en cours (modèles déchargés).
    pub keep_going: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Position (s) à traduire en priorité (celle du spectateur).
    pub target: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// Quelqu'un regarde ce match.
    pub watching: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Vidéo en lecture : pas plus de `COMMENTARY_MAX_LEAD_SEC` d'avance.
    pub playing: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl CommentaryControl {
    /// `RUN_TO_END` : jusqu'au bout, depuis le début.
    pub fn run_to_end() -> Self {
        CommentaryControl {
            keep_going: Arc::new(|| true),
            target: Arc::new(|| 0.0),
            watching: None,
            playing: None,
        }
    }
}

/// Exécuteur d'un travail (`CommentaryRunner`) ; par défaut
/// [`Commentary::run_commentary`] avec les dépendances du service.
pub type Runner = Arc<
    dyn Fn(
            Job,
            ProgressFn,
            AbortSignal,
            CommentaryControl,
        ) -> BoxFut<Result<CommentaryOutcome, CommentaryError>>
        + Send
        + Sync,
>;

/// Crochet `__commentaryGpuGate` (voir la documentation du module).
pub type GpuGate = Arc<dyn Fn() -> Option<BoxFut<()>> + Send + Sync>;
/// Crochet `__dubWantsAudio` (voir la documentation du module).
pub type DubWantsAudio = Arc<dyn Fn(i64) -> bool + Send + Sync>;

/// Options d'une mise en file (`enqueueCommentary`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnqueueOptions {
    /// En tête de file (demande de quelqu'un qui regarde la fiche).
    pub priority: bool,
    /// Refait même une piste déjà prête.
    pub force: bool,
    /// Demande explicite : jusqu'au bout.
    pub explicit: bool,
}

/// Résultat d'une mise en file (`CommentaryEnqueueResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueResult {
    pub queued: bool,
    pub started: bool,
    pub position: Option<usize>,
    pub message: String,
}

impl EnqueueResult {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("queued".into(), Value::from(self.queued));
        m.insert("started".into(), Value::from(self.started));
        if let Some(p) = self.position {
            m.insert("position".into(), Value::from(p));
        }
        m.insert("message".into(), Value::from(self.message.clone()));
        Value::Object(m)
    }
}

/// Travail en cours vu par le panneau d'activité.
#[derive(Debug, Clone, PartialEq)]
pub struct RunningActivity {
    pub match_id: i64,
    pub phase: Option<CommentaryPhase>,
    pub done: f64,
    pub total: f64,
    pub watched: bool,
}

/// Activité de la file (`CommentaryActivity`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryActivity {
    pub running: Option<RunningActivity>,
    /// Matchs en attente, dans l'ordre.
    pub queued: Vec<i64>,
    /// Des travaux de fond attendent la fin d'une lecture.
    pub waiting_for_viewer: bool,
}

impl CommentaryActivity {
    /// Objet de Node (`{ running: { matchId, phase, done, total, watched } | null, queued, waitingForViewer }`).
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        json!({
            "running": self.running.as_ref().map(|r| json!({
                "matchId": r.match_id,
                "phase": r.phase.map(CommentaryPhase::as_str),
                "done": n(r.done),
                "total": n(r.total),
                "watched": r.watched,
            })),
            "queued": self.queued,
            "waitingForViewer": self.waiting_for_viewer,
        })
    }
}

/// Réglages du service (injectables pour les tests).
#[derive(Clone)]
pub struct CommentaryOptions {
    /// Table des spectateurs (par défaut celle du processus).
    pub viewers: &'static Viewers,
    /// Horloge des spectateurs, des enregistrements et de la fenêtre de nuit.
    pub clock: Clock,
    /// `ffmpegAvailable`.
    pub ffmpeg_available: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl Default for CommentaryOptions {
    fn default() -> Self {
        CommentaryOptions {
            viewers: viewers(),
            clock: Arc::new(crate::media::viewers::now_ms),
            ffmpeg_available: Arc::new(crate::media::audio::ffmpeg_available),
        }
    }
}

// ---------------------------------------------------------------- état de la file

struct Running {
    id: u64,
    job: Job,
    progress: Option<CommentaryProgress>,
    ok_id: Option<String>,
    signal: AbortSignal,
    /// Interrompu pour laisser passer un match regardé : remis en file, sans compter d'échec.
    preempted: bool,
}

#[derive(Default)]
struct QueueState {
    queue: Vec<Job>,
    running: Option<Running>,
    next_id: u64,
}

#[derive(Default)]
struct Hooks {
    gpu_gate: Option<GpuGate>,
    dub_wants_audio: Option<DubWantsAudio>,
}

pub(crate) struct Inner {
    db: Db,
    opts: CommentaryOptions,
    pub(crate) deps: CommentaryDeps,
    state: Mutex<QueueState>,
    pub(crate) full_audio: Mutex<HashMap<String, workdir::FullAudio>>,
    hooks: Mutex<Hooks>,
    runner: Mutex<Option<Runner>>,
    repump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    idle: Notify,
}

/// Service de traduction des commentaires (file, statuts, travaux).
#[derive(Clone)]
pub struct Commentary(pub(crate) Arc<Inner>);

/// `jobTimeoutMs` : `COMMENTARY_TIMEOUT_MS`, 6 h par défaut.
fn job_timeout_ms() -> f64 {
    let n = std::env::var("COMMENTARY_TIMEOUT_MS")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    if n.is_finite() && n > 0.0 {
        n
    } else {
        6.0 * 3_600_000.0
    }
}

/// Identifiant de replay non vide (`m.video_ok_id` vrai au sens JavaScript).
fn ok_id_of(m: &MatchRow) -> Option<&str> {
    m.video_ok_id.as_deref().filter(|s| !s.is_empty())
}

impl Commentary {
    /// Service de production : spectateurs du processus, horloge réelle,
    /// dépendances par défaut (flux résolus par le proxy vidéo `video`).
    pub fn new(db: Db, video: crate::video::Video) -> Commentary {
        Commentary::with_options(
            db,
            CommentaryDeps::defaults(video),
            CommentaryOptions::default(),
        )
    }

    /// Service aux dépendances et réglages choisis (tests).
    pub fn with_options(db: Db, deps: CommentaryDeps, opts: CommentaryOptions) -> Commentary {
        Commentary(Arc::new(Inner {
            db,
            opts,
            deps,
            state: Mutex::new(QueueState::default()),
            full_audio: Mutex::new(HashMap::new()),
            hooks: Mutex::new(Hooks::default()),
            runner: Mutex::new(None),
            repump: Mutex::new(None),
            idle: Notify::new(),
        }))
    }

    fn weak(&self) -> Weak<Inner> {
        Arc::downgrade(&self.0)
    }

    fn st(&self) -> MutexGuard<'_, QueueState> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Base partagée.
    pub fn db(&self) -> &Db {
        &self.0.db
    }

    /// Instant courant (horloge du service).
    pub fn now(&self) -> f64 {
        (self.0.opts.clock)()
    }

    /// Table des spectateurs du service (le doublage doit utiliser la même).
    pub fn viewers(&self) -> &'static Viewers {
        self.0.opts.viewers
    }

    // ------------------------------------------------------------ crochets

    /// Pose le crochet `__commentaryGpuGate` (doublage) ; `None` le retire.
    pub fn set_gpu_gate(&self, gate: Option<GpuGate>) {
        self.0
            .hooks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .gpu_gate = gate;
    }

    /// Pose le crochet `__dubWantsAudio` (doublage) ; `None` le retire.
    pub fn set_dub_wants_audio(&self, f: Option<DubWantsAudio>) {
        self.0
            .hooks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dub_wants_audio = f;
    }

    /// `dubWantsAudio` : faux sans crochet, ou si le crochet panique.
    pub(crate) fn dub_wants_audio(&self, match_id: i64) -> bool {
        let f = self
            .0
            .hooks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dub_wants_audio
            .clone();
        f.is_some_and(|f| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(match_id))).unwrap_or(false)
        })
    }

    /// Remplace l'exécuteur des travaux (`__setCommentaryRunnerForTests`) ;
    /// `None` : [`Commentary::run_commentary`] avec les dépendances du service.
    /// Vide la file et oublie les spectateurs, comme Node.
    pub fn set_runner(&self, runner: Option<Runner>) {
        *self.0.runner.lock().unwrap_or_else(|e| e.into_inner()) = runner;
        self.viewers().clear();
        {
            let mut st = self.st();
            st.queue.clear();
            st.running = None;
        }
        self.0.idle.notify_waiters();
    }

    /// `__commentaryIdle` : attend que la file soit vide (rien en cours, rien en attente).
    pub async fn idle(&self) {
        loop {
            let n = self.0.idle.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            {
                let st = self.st();
                if st.running.is_none() && st.queue.is_empty() {
                    return;
                }
            }
            n.await;
        }
    }

    // ------------------------------------------------------------ lectures

    pub(crate) fn settings(&self) -> Settings {
        self.0
            .db
            .with(Settings::load)
            .unwrap_or_else(|_| Settings::unreadable())
    }

    pub(crate) fn config(&self) -> CommentaryConfig {
        commentary_config(&self.settings())
    }

    pub(crate) fn get_match(&self, id: i64) -> Option<MatchRow> {
        self.0.db.with(|c| db::get_match(c, id)).ok().flatten()
    }

    pub(crate) fn track(&self, id: i64) -> Option<CommentaryTrackRow> {
        self.0
            .db
            .with(|c| cdb::get_commentary_track(c, id))
            .ok()
            .flatten()
    }

    /// `inNightWindow` (réglage « Traduction automatique » compris), à l'heure du service.
    pub fn in_night_window(&self) -> bool {
        let now = chrono::DateTime::from_timestamp_millis(self.now() as i64).unwrap_or_default();
        crate::media::night_window::in_night_window(&self.settings(), now)
    }

    /// `touchViewer` : signe de vie de la fiche (position en secondes si connue).
    pub fn touch_viewer(&self, match_id: i64, t: Option<f64>) {
        self.viewers().touch_at(match_id, t, self.now());
    }

    /// `viewerActive`, à l'heure du service.
    pub fn viewer_active(&self, id: i64) -> bool {
        self.viewers().active_at(id, self.now())
    }

    /// `someoneWatching(except)`, à l'heure du service.
    pub fn someone_watching(&self, except: i64) -> bool {
        self.viewers().someone_watching_at(Some(except), self.now())
    }

    /// `viewerPosition`, à l'heure du service.
    pub fn viewer_position(&self, id: i64) -> Option<f64> {
        self.viewers().position_at(id, self.now())
    }

    /// `getCommentaryRecord`.
    pub fn record(&self, match_id: i64) -> Option<CommentaryRecord> {
        self.0
            .db
            .with(|c| db::kv_get(c, &format!("commentary:{match_id}"), None))
            .ok()
            .flatten()
            .and_then(|v| CommentaryRecord::from_json(&v))
    }

    /// `commentaryDisabledReason` : fonctionnalité inactive (configuration, ffmpeg) : la raison.
    pub fn disabled_reason(&self) -> Option<String> {
        let cfg = self.config();
        if let Some(r) = cfg.disabled_reason {
            return Some(r);
        }
        if !(self.0.opts.ffmpeg_available)() {
            return Some("ffmpeg absent du serveur".into());
        }
        None
    }

    /// `unavailableReason` : le match a-t-il un replay exploitable ?
    fn unavailable_reason(&self, id: i64) -> Option<&'static str> {
        let Some(m) = self.get_match(id) else {
            return Some("match introuvable");
        };
        if ok_id_of(&m).is_none() || !m.video_available {
            return Some("pas de replay disponible");
        }
        None
    }

    /// `currentTrack` : piste (complète ou partielle) du replay ACTUEL.
    fn current_track(&self, id: i64) -> Option<CommentaryTrackRow> {
        let m = self.get_match(id)?;
        let ok = ok_id_of(&m)?.to_string();
        self.track(id).filter(|t| t.ok_id == ok && t.cues > 0)
    }

    /// `commentaryReady` : piste du replay actuel complète.
    pub fn ready(&self, match_id: i64) -> bool {
        self.current_track(match_id)
            .is_some_and(|t| t.complete == 1)
    }

    /// `commentaryLeftoversPending` : piste complète avec des lignes restées
    /// en anglais, pas encore rattrapée (un seul essai par piste et modèle).
    pub fn leftovers_pending(&self, match_id: i64) -> bool {
        let Some(t) = self.current_track(match_id) else {
            return false;
        };
        if t.complete != 1 || t.untranslated == 0 {
            return false;
        }
        let rec = self
            .0
            .db
            .with(|c| db::kv_get(c, &format!("commentary-leftovers:{match_id}"), None))
            .ok()
            .flatten();
        !rec.is_some_and(|r| {
            r.get("okId").and_then(Value::as_str) == Some(t.ok_id.as_str())
                && r.get("model").and_then(Value::as_str) == Some(t.translate_model.as_str())
        })
    }

    /// `commentaryDone` : piste complète, sans rattrapage en attente.
    fn done(&self, id: i64) -> bool {
        self.ready(id) && !self.leftovers_pending(id)
    }

    /// `leftoversOnly` : travail de simple rattrapage.
    fn leftovers_only(&self, job: &Job) -> bool {
        !job.force && self.ready(job.match_id)
    }

    /// `servedCommentaryCues` : sous-titres publiés pour le replay actuel, sans
    /// les lignes restées en anglais.
    pub fn served_cues(&self, match_id: i64) -> Vec<CommentaryCueRow> {
        if self.current_track(match_id).is_none() {
            return Vec::new();
        }
        self.0
            .db
            .with(|c| cdb::get_commentary_cues(c, match_id))
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.untranslated == 0)
            .collect()
    }

    /// `availableUntil`.
    fn available_until(&self, id: i64, progress: Option<&CommentaryProgress>) -> Option<f64> {
        if let Some(u) = progress
            .and_then(|p| p.available_until)
            .filter(|u| *u != 0.0 && !u.is_nan())
        {
            return Some(u);
        }
        let t = self.current_track(id)?;
        if t.complete != 0 {
            return None;
        }
        let pos = self.viewer_position(id).unwrap_or(0.0);
        let ranges = self
            .0
            .db
            .with(|c| cdb::commentary_coverage(c, id))
            .unwrap_or_default();
        if ranges.is_empty() {
            let u = self
                .0
                .db
                .with(|c| cdb::commentary_published_until(c, id))
                .unwrap_or(0.0);
            return (u != 0.0 && !u.is_nan()).then_some(u);
        }
        ranges
            .iter()
            .find(|[a, b]| pos >= a - 0.5 && pos < *b)
            .map(|r| r[1])
            .filter(|u| *u != 0.0)
    }

    /// `coveredRanges` : plages traduites d'une piste partielle.
    fn covered_ranges(&self, id: i64) -> Option<Vec<[f64; 2]>> {
        let t = self.current_track(id)?;
        if t.complete != 0 {
            return None;
        }
        let r = self
            .0
            .db
            .with(|c| cdb::commentary_coverage(c, id))
            .unwrap_or_default();
        (!r.is_empty()).then_some(r)
    }

    /// `commentaryActivity` (panneau « En cours de traitement »).
    pub fn activity(&self) -> CommentaryActivity {
        let st = self.st();
        CommentaryActivity {
            running: st.running.as_ref().map(|r| RunningActivity {
                match_id: r.job.match_id,
                phase: r.progress.map(|p| p.phase),
                done: r.progress.map_or(0.0, |p| p.done),
                total: r.progress.map_or(0.0, |p| p.total),
                watched: self.viewer_active(r.job.match_id),
            }),
            queued: st.queue.iter().map(|j| j.match_id).collect(),
            waiting_for_viewer: st.queue.iter().any(|j| self.must_wait(j)),
        }
    }

    /// `commentaryRunningMatchId` : match en cours de traduction.
    pub fn running_match_id(&self) -> Option<i64> {
        self.st().running.as_ref().map(|r| r.job.match_id)
    }

    fn running_ok_id(&self) -> Option<String> {
        self.st().running.as_ref().and_then(|r| r.ok_id.clone())
    }

    /// `commentaryQueuePosition` : rang dans la file (1 = prochain travail).
    pub fn queue_position(&self, match_id: i64) -> Option<usize> {
        position_in(&self.st().queue, match_id)
    }

    // ------------------------------------------------------------ file

    /// `enqueueCommentary` : met un match en file.
    pub fn enqueue(&self, match_id: i64, opts: EnqueueOptions) -> EnqueueResult {
        if let Some(d) = self.disabled_reason() {
            return EnqueueResult {
                queued: false,
                started: false,
                position: None,
                message: format!("Traduction des commentaires inactive : {d}"),
            };
        }
        if let Some(u) = self.unavailable_reason(match_id) {
            return EnqueueResult {
                queued: false,
                started: false,
                position: None,
                message: format!("Traduction impossible : {u}"),
            };
        }
        {
            let st = self.st();
            if let Some(r) = st.running.as_ref().filter(|r| r.job.match_id == match_id) {
                // Demande explicite pendant un travail déjà lancé : il ira jusqu'au bout.
                if opts.explicit {
                    r.job.explicit.store(true, Ordering::SeqCst);
                }
                return EnqueueResult {
                    queued: false,
                    started: true,
                    position: None,
                    message: "Traduction déjà en cours".into(),
                };
            }
        }
        if !opts.force && self.done(match_id) {
            return EnqueueResult {
                queued: false,
                started: false,
                position: None,
                message: "Traduction des commentaires déjà prête".into(),
            };
        }
        let existed = {
            let mut st = self.st();
            // Revérifié sous le verrou de la file : un appel concurrent a pu
            // démarrer ce match depuis le premier contrôle (Node n'a qu'un fil :
            // le contrôle et l'insertion y sont d'un seul tenant).
            if let Some(r) = st.running.as_ref().filter(|r| r.job.match_id == match_id) {
                if opts.explicit {
                    r.job.explicit.store(true, Ordering::SeqCst);
                }
                return EnqueueResult {
                    queued: false,
                    started: true,
                    position: None,
                    message: "Traduction déjà en cours".into(),
                };
            }
            let existing = st.queue.iter().position(|j| j.match_id == match_id);
            let prev = existing.map(|i| st.queue[i].clone());
            let job = Job::with(
                match_id,
                opts.force || prev.as_ref().is_some_and(|p| p.force),
                opts.priority || prev.as_ref().is_some_and(|p| p.viewer),
                opts.explicit || prev.as_ref().is_some_and(|p| p.explicit()),
            );
            match existing {
                Some(i) if opts.priority => {
                    st.queue.remove(i);
                    st.queue.insert(0, job);
                }
                Some(i) => st.queue[i] = job,
                None if opts.priority => st.queue.insert(0, job),
                None => st.queue.push(job),
            }
            existing.is_some()
        };
        if opts.priority {
            self.preempt_background();
        }
        self.pump();
        if self.running_match_id() == Some(match_id) {
            return EnqueueResult {
                queued: true,
                started: true,
                position: None,
                message: "Traduction des commentaires lancée".into(),
            };
        }
        let position = self.queue_position(match_id);
        let pos_text = position.map_or("undefined".to_string(), |p| p.to_string());
        EnqueueResult {
            queued: true,
            started: false,
            position,
            message: if existed && !opts.priority {
                format!("Traduction déjà en file (position {pos_text})")
            } else {
                format!("Traduction en file (position {pos_text})")
            },
        }
    }

    /// `preemptBackground` : un match regardé passe devant un travail de
    /// FOND (ou explicite dont la fiche n'est plus regardée, ou dont la fiche
    /// a été quittée — `viewerGone`) : celui-ci est interrompu puis remis en
    /// file juste derrière, sans compter comme un échec.
    fn preempt_background(&self) {
        let now = self.now();
        let mut st = self.st();
        let watched = st.queue.iter().find(|j| j.viewer).map(|j| j.match_id);
        let Some(watched) = watched else { return };
        let Some(r) = st.running.as_mut() else { return };
        if r.preempted {
            return;
        }
        let id = r.job.match_id;
        let yields = !r.job.viewer
            || (r.job.explicit() && !self.viewers().active_at(id, now))
            || self.viewers().gone_at(id, now);
        if !yields {
            return;
        }
        r.preempted = true;
        println!(
            "[commentaires] match {id} mis en pause : le match {watched} est regardé, il passe en premier"
        );
        r.signal.abort();
    }

    /// `nudgeCommentaryQueue` : signe de vie de la fiche d'un match EN FILE :
    /// le travail en cours est réexaminé (il cède la place dès que sa propre
    /// fiche est quittée).
    pub fn nudge(&self, match_id: i64) {
        {
            let st = self.st();
            if st
                .running
                .as_ref()
                .is_some_and(|r| r.job.match_id == match_id)
            {
                return;
            }
            if !st.queue.iter().any(|j| j.match_id == match_id && j.viewer) {
                return;
            }
        }
        self.preempt_background();
    }

    /// `outsideWindow` : travail de fond hors de la fenêtre (et personne ne regarde ce match).
    fn outside_window(&self, job: &Job) -> bool {
        !job.viewer
            && !job.explicit()
            && !self.viewer_active(job.match_id)
            && !self.in_night_window()
    }

    /// `mustWait` : travail de fond (ou explicite, fiche fermée) qui attend :
    /// quelqu'un regarde un autre match.
    fn must_wait(&self, job: &Job) -> bool {
        (!job.viewer || job.explicit())
            && !self.viewer_active(job.match_id)
            && self.someone_watching(job.match_id)
    }

    fn schedule_repump(&self) {
        let ms = env_num_or("COMMENTARY_REPUMP_MS", 20_000.0);
        let weak = self.weak();
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let h = rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(crate::js::max(0.0, ms) as u64)).await;
            if let Some(inner) = weak.upgrade() {
                Commentary(inner).pump();
            }
        });
        if let Some(old) = self
            .0
            .repump
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(h)
        {
            old.abort();
        }
    }

    /// `pump` : lance le premier travail qui peut partir.
    fn pump(&self) {
        if let Some(t) = self
            .0
            .repump
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            t.abort();
        }
        let start = {
            let mut st = self.st();
            let mut start = None;
            while st.running.is_none() && !st.queue.is_empty() {
                let queue = std::mem::take(&mut st.queue);
                st.queue = queue
                    .into_iter()
                    .filter(|j| !self.outside_window(j))
                    .collect();
                // Ceux des spectateurs partent toujours ; ceux de fond quand personne ne regarde.
                let Some(i) = st.queue.iter().position(|j| !self.must_wait(j)) else {
                    if !st.queue.is_empty() {
                        self.schedule_repump();
                    }
                    break;
                };
                let job = st.queue.remove(i);
                if self.disabled_reason().is_some()
                    || self.unavailable_reason(job.match_id).is_some()
                {
                    continue;
                }
                if !job.force && self.done(job.match_id) {
                    continue;
                }
                st.next_id += 1;
                let id = st.next_id;
                let signal = AbortSignal::new();
                st.running = Some(Running {
                    id,
                    ok_id: self.get_match(job.match_id).and_then(|m| m.video_ok_id),
                    job: job.clone(),
                    progress: None,
                    signal: signal.clone(),
                    preempted: false,
                });
                start = Some((id, job, signal, st.queue.len()));
            }
            start
        };
        if let Some((id, job, signal, waiting)) = start {
            self.start(id, job, signal, waiting);
        }
        let idle = {
            let st = self.st();
            st.running.is_none() && st.queue.is_empty()
        };
        if idle {
            self.0.idle.notify_waiters();
        }
    }

    /// `controlFor` : continuer tant qu'on regarde le match (ou, pour un travail de fond, la nuit).
    fn control_for(&self, job: &Job) -> CommentaryControl {
        let id = job.match_id;
        let viewer = job.viewer;
        let explicit = job.explicit.clone();
        let w = self.weak();
        let up = move || w.upgrade().map(Commentary);
        let (u1, u2, u3, u4) = (up.clone(), up.clone(), up.clone(), up);
        CommentaryControl {
            // Un travail de fond cède la place dès que quelqu'un regarde un AUTRE match.
            keep_going: Arc::new(move || {
                u1().is_some_and(|c| {
                    c.viewer_active(id)
                        || ((explicit.load(Ordering::SeqCst) || (!viewer && c.in_night_window()))
                            && !c.someone_watching(id))
                })
            }),
            target: Arc::new(move || u2().and_then(|c| c.viewer_position(id)).unwrap_or(0.0)),
            watching: Some(Arc::new(move || u3().is_some_and(|c| c.viewer_active(id)))),
            playing: Some(Arc::new(move || {
                u4().is_some_and(|c| c.viewers().playing_at(id, c.now()))
            })),
        }
    }

    fn runner(&self) -> Runner {
        if let Some(r) = self
            .0
            .runner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return r;
        }
        self.runner_with(self.0.deps.clone())
    }

    /// Exécuteur [`Commentary::run_commentary`] avec d'autres dépendances
    /// (`(job, p, sig, c) => runCommentary(job, p, sig, deps, c)` des tests de
    /// Node), à passer à [`Commentary::set_runner`]. Le service est tenu par
    /// référence faible : pas de cycle.
    pub fn runner_with(&self, deps: CommentaryDeps) -> Runner {
        let w = self.weak();
        Arc::new(move |job, progress, signal, ctl| {
            let (w, deps) = (w.clone(), deps.clone());
            Box::pin(async move {
                let Some(inner) = w.upgrade() else {
                    return Err(CommentaryError::Other("service arrêté".into()));
                };
                Commentary(inner)
                    .run_commentary(&job, progress, signal, &deps, &ctl)
                    .await
            })
        })
    }

    /// `start` : lance un travail (déjà inscrit comme en cours).
    fn start(&self, id: u64, job: Job, signal: AbortSignal, waiting: usize) {
        let match_id = job.match_id;
        let log_id = self
            .0
            .db
            .with(|c| crate::ingest_db::log_ingest_start(c, &format!("commentaires-{match_id}")))
            .ok();
        let ok_id = self.get_match(match_id).and_then(|m| m.video_ok_id);
        let t0 = std::time::Instant::now();
        println!(
            "[commentaires] match {match_id} : traduction démarrée{}",
            if waiting > 0 {
                format!(" ({waiting} en attente)")
            } else {
                String::new()
            }
        );
        let w = self.weak();
        let progress: ProgressFn = Arc::new(move |p: CommentaryProgress| {
            if let Some(inner) = w.upgrade() {
                let c = Commentary(inner);
                let mut st = c.st();
                if let Some(r) = st.running.as_mut().filter(|r| r.id == id) {
                    r.progress = Some(p);
                }
            }
        });
        let runner = self.runner();
        let ctl = self.control_for(&job);
        // La carte graphique d'abord libérée par un doublage en cours (session de
        // voix fermée) ; sans doublage en cours, le travail démarre aussitôt.
        let gate = self
            .0
            .hooks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .gpu_gate
            .clone();
        let gpu_wait = gate.and_then(|g| g());
        let work: BoxFut<Result<CommentaryOutcome, CommentaryError>> = match gpu_wait {
            None => runner(job.clone(), progress, signal.clone(), ctl),
            Some(wait) => {
                let (job, signal) = (job.clone(), signal.clone());
                Box::pin(async move {
                    wait.await;
                    runner(job, progress, signal, ctl).await
                })
            }
        };
        let this = self.clone();
        tokio::spawn(async move {
            let timeout = job_timeout_ms();
            // Le travail tourne à part : interrompu par le garde-fou, il finit
            // quand même proprement (sessions fermées).
            let mut handle = tokio::spawn(work);
            let res = tokio::select! {
                r = &mut handle => r.unwrap_or_else(|e| Err(CommentaryError::Other(e.to_string()))),
                _ = tokio::time::sleep(Duration::from_millis(timeout as u64)) => {
                    signal.abort();
                    Err(CommentaryError::Other(format!(
                        "délai dépassé ({} min)",
                        crate::js::max(1.0, crate::js::round(timeout / 60_000.0))
                    )))
                }
            };
            let res = res.unwrap_or_else(|e| match e {
                CommentaryError::Service(s) => CommentaryOutcome::failed(
                    FailureKind::Service,
                    format!(
                        "{} impossible : {}",
                        if s.service == Service::Transcription {
                            "Transcription"
                        } else {
                            "Traduction"
                        },
                        s.message
                    ),
                ),
                CommentaryError::Other(m) => CommentaryOutcome::failed(
                    FailureKind::Erreur,
                    format!("Traduction des commentaires impossible : {m}"),
                ),
            });
            this.finish(id, &job, ok_id, log_id, res, t0);
            {
                let mut st = this.st();
                if st.running.as_ref().is_some_and(|r| r.id == id) {
                    st.running = None;
                }
            }
            this.pump();
        });
    }

    fn log_end(&self, log_id: Option<i64>, ok: bool, detail: &str) -> Result<(), String> {
        match log_id {
            Some(l) => self
                .0
                .db
                .with(|c| crate::ingest_db::log_ingest_end(c, l, ok, detail)),
            None => Ok(()),
        }
    }

    /// Suite d'un travail terminé : remise en file, enregistrement, journaux.
    fn finish(
        &self,
        id: u64,
        job: &Job,
        ok_id: Option<String>,
        log_id: Option<i64>,
        res: CommentaryOutcome,
        t0: std::time::Instant,
    ) {
        let match_id = job.match_id;
        let preempted = self
            .st()
            .running
            .as_ref()
            .is_some_and(|r| r.id == id && r.preempted);
        if preempted {
            // Pas un échec : reprise derrière le match regardé.
            let _ = self.log_end(
                log_id,
                false,
                "interrompu : un match regardé est passé devant",
            );
            let mut st = self.st();
            if !st.queue.iter().any(|j| j.match_id == match_id) {
                let at = st.queue.len().min(1);
                st.queue.insert(at, job.copy(false));
            }
            return;
        }
        if res.paused {
            // Ni succès ni échec : un travail de fond qui a cédé la place à une
            // lecture retourne en file ; sinon reprise à la prochaine ouverture.
            let _ = self.log_end(log_id, true, &res.reason);
            if (job.explicit() || (!job.viewer && self.in_night_window()))
                && self.someone_watching(match_id)
            {
                let mut st = self.st();
                if !st.queue.iter().any(|j| j.match_id == match_id) {
                    st.queue.push(job.copy(job.viewer));
                }
                drop(st);
                println!(
                    "[commentaires] match {match_id} en pause : une vidéo est regardée, la traduction reprendra après"
                );
            } else {
                println!("[commentaires] match {match_id} {}", res.reason);
            }
            return;
        }
        let prev = self.record(match_id);
        let same_video = prev
            .as_ref()
            .and_then(|p| p.ok_id.as_deref().filter(|s| !s.is_empty()))
            .is_none_or(|p| Some(p) == ok_id.as_deref());
        let kind = if res.ok {
            None
        } else {
            Some(res.kind.unwrap_or(FailureKind::Erreur))
        };
        let failures = if res.ok {
            0.0
        } else {
            (if same_video {
                prev.as_ref().and_then(|p| p.failures).unwrap_or(0.0)
            } else {
                0.0
            }) + if quick_retry(kind) { 0.0 } else { 1.0 }
        };
        let net_failures = if quick_retry(kind) {
            (if same_video && quick_retry(prev.as_ref().and_then(|p| p.kind)) {
                prev.as_ref().and_then(|p| p.net_failures).unwrap_or(0.0)
            } else {
                0.0
            }) + 1.0
        } else {
            0.0
        };
        let rec = CommentaryRecord {
            at: iso_ms(self.now()),
            ok: res.ok,
            failures: Some(failures),
            net_failures: Some(net_failures),
            kind,
            reason: res.reason.clone(),
            ok_id,
        };
        let saved = self
            .0
            .db
            .with(|c| db::kv_set(c, &format!("commentary:{match_id}"), &rec.to_json()))
            .and_then(|_| self.log_end(log_id, res.ok, &res.reason));
        if let Err(e) = saved {
            eprintln!("[commentaires] journalisation impossible : {e}");
        }
        if !res.ok {
            eprintln!("[commentaires] match {match_id} : {}", res.reason);
        } else {
            // L'analyse vidéo n'est PAS lancée ici : elle tourne la nuit.
            println!(
                "[commentaires] match {match_id} traduit en {} min : {}",
                crate::js::max(
                    1.0,
                    crate::js::round(t0.elapsed().as_millis() as f64 / 60_000.0)
                ),
                res.reason
            );
        }
    }

    fn current_models(&self) -> (String, String) {
        let cfg = self.config();
        (cfg.transcribe_model, cfg.translate_model)
    }

    fn ready_status(&self, id: i64) -> CommentaryStatus {
        let mut s = CommentaryStatus::new("ready");
        if let Some(t) = self.track(id) {
            s.models = Some((t.transcribe_model.clone(), t.translate_model.clone()));
            if t.untranslated != 0 {
                s.reason = Some(format!(
                    "{} ligne(s) sans traduction (non affichées)",
                    t.untranslated
                ));
            }
        }
        s
    }

    /// `commentaryStatus` : statut de la traduction d'un match (contrat de l'API).
    pub fn status(&self, match_id: i64) -> CommentaryStatus {
        let (job, running_progress) = {
            let st = self.st();
            match st.running.as_ref().filter(|r| r.job.match_id == match_id) {
                Some(r) => (Some(r.job.clone()), Some(r.progress)),
                None => (
                    st.queue.iter().find(|j| j.match_id == match_id).cloned(),
                    None,
                ),
            }
        };
        // Rattrapage des lignes restées en anglais : la piste reste « prête » à l'écran.
        if job.as_ref().is_some_and(|j| self.leftovers_only(j)) {
            return self.ready_status(match_id);
        }
        if let Some(p) = running_progress {
            let mut s = CommentaryStatus::new("running");
            if let Some(p) = p {
                s.phase = Some(p.phase);
                s.progress = Some((p.done, p.total));
            }
            s.available_until = self.available_until(match_id, p.as_ref());
            s.covered = self.covered_ranges(match_id);
            s.models = Some(self.current_models());
            return s;
        }
        if let Some(position) = self.queue_position(match_id) {
            let mut s = CommentaryStatus::new("queued");
            s.position = Some(position);
            s.available_until = self.available_until(match_id, None);
            s.covered = self.covered_ranges(match_id);
            s.models = Some(self.current_models());
            return s;
        }
        if self.ready(match_id) {
            return self.ready_status(match_id);
        }
        if let Some(d) = self.disabled_reason() {
            let mut s = CommentaryStatus::new("disabled");
            s.reason = Some(d);
            return s;
        }
        if let Some(u) = self.unavailable_reason(match_id) {
            let mut s = CommentaryStatus::new("none");
            s.reason = Some(u.into());
            return s;
        }
        let rec = self.record(match_id);
        let ok_id = self.get_match(match_id).and_then(|m| m.video_ok_id);
        let until = self.available_until(match_id, None);
        let covered = self.covered_ranges(match_id);
        if let Some(rec) = rec.filter(|r| {
            !r.ok
                && r.ok_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .is_none_or(|o| Some(o) == ok_id.as_deref())
        }) {
            let mut s = CommentaryStatus::new("failed");
            s.reason = Some(rec.reason);
            s.available_until = until;
            s.covered = covered;
            return s;
        }
        let mut s = CommentaryStatus::new("none");
        s.available_until = until;
        s.covered = covered;
        s
    }

    /// `prioritizeOnView` : ouverture de la fiche : en tête de file si le
    /// match est terminé, a un replay, n'a pas de piste à jour, et que le
    /// backoff le permet.
    pub fn prioritize_on_view(&self, match_id: i64) {
        let Some(m) = self.get_match(match_id) else {
            return;
        };
        let Some(ok) = ok_id_of(&m).map(String::from) else {
            return;
        };
        if m.status != "final" || !m.video_available {
            return;
        }
        if self.running_match_id() == Some(match_id) || self.queue_position(match_id) == Some(1) {
            return;
        }
        if self.disabled_reason().is_some() || self.done(match_id) {
            return;
        }
        if !commentary_retry_allowed(self.record(match_id).as_ref(), Some(&ok), self.now()) {
            return;
        }
        self.enqueue(
            match_id,
            EnqueueOptions {
                priority: true,
                ..Default::default()
            },
        );
    }

    /// `enqueueRecentCommentaries` : job périodique (10 jours, 30 matchs par
    /// défaut) — matchs terminés récents avec replay, sans piste à jour,
    /// backoff échu ; puis pistes complètes avec des lignes restées en anglais.
    pub fn enqueue_recent(&self, days: Option<f64>, limit: Option<i64>) -> usize {
        let days = days.unwrap_or(10.0);
        let limit = limit.unwrap_or(30);
        if self.disabled_reason().is_some() {
            return 0;
        }
        let keep: Vec<std::path::PathBuf> = self
            .running_ok_id()
            .map(|o| work_dir(&o))
            .into_iter()
            .collect();
        prune_work_dirs(Some(10.0 * 24.0 * 3_600_000.0), &keep);
        let since = iso_ms(self.now() - days * 86_400_000.0);
        let model = self.config().translate_model;
        let mut n = 0;
        let list = self
            .0
            .db
            .with(|c| cdb::final_matches_needing_commentary(c, &since, limit, Some(&model)))
            .unwrap_or_default();
        for m in list {
            if self.running_match_id() == Some(m.id) || self.queue_position(m.id).is_some() {
                continue;
            }
            if !commentary_retry_allowed(
                self.record(m.id).as_ref(),
                m.video_ok_id.as_deref(),
                self.now(),
            ) {
                continue;
            }
            // Piste complète d'un autre modèle de traduction : à refaire.
            let force = self.ready(m.id);
            if self
                .enqueue(
                    m.id,
                    EnqueueOptions {
                        force,
                        ..Default::default()
                    },
                )
                .queued
            {
                n += 1;
            }
        }
        // Pistes complètes avec des lignes restées en anglais : rattrapage seul.
        let list = self
            .0
            .db
            .with(|c| cdb::final_matches_with_untranslated_cues(c, &since, limit))
            .unwrap_or_default();
        for m in list {
            if self.running_match_id() == Some(m.id)
                || self.queue_position(m.id).is_some()
                || !self.leftovers_pending(m.id)
            {
                continue;
            }
            if self.enqueue(m.id, EnqueueOptions::default()).queued {
                n += 1;
            }
        }
        n
    }
}

fn position_in(queue: &[Job], match_id: i64) -> Option<usize> {
    queue
        .iter()
        .position(|j| j.match_id == match_id)
        .map(|i| i + 1)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_ms(ms: f64) -> String {
    crate::time::iso_utc(chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default())
}
