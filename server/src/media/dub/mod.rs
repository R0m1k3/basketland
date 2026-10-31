//! Doublage français des commentaires (équivalent de `src/lib/dub.ts`) —
//! porté en Rust à l'étape 6b, **pas encore branché** : aucune route ni
//! aucun job ne le construit ; Node fait toujours tourner sa file tant que
//! les routes médias ne sont pas basculées ensemble.
//!
//! Les sous-titres traduits ([`super::commentary`]) sont dits par des voix
//! de synthèse ([`super::voice_ai`], [`super::voice_minimax`]), tronçon par
//! tronçon : audio d'origine du tronçon → empreinte vocale de chaque
//! réplique → locuteurs (par match, en ligne) → voix de chaque locuteur
//! (F pour une femme), stable pour tout le match → synthèse → calage
//! (`atempo` limité) → montage en AAC mono 24 kHz
//! (`<données>/dub/<match>/chunk-<idx>.m4a`, écrit en .part puis renommé) →
//! publication en base (`dub_chunks`).
//!
//! GPU PARTAGÉ : le doublage ne tourne jamais en même temps qu'une
//! traduction ou une analyse vidéo (sauf synthèse en ligne MiniMax). PAS DE
//! DOUBLAGE AUTOMATIQUE : seule la demande explicite ([`Dub::request`]) le
//! lance ; le doublage demandé d'un match regardé passe en tête de file, il
//! s'efface pendant qu'on regarde un AUTRE match. Un seul doublage à la
//! fois ; échecs dans `kv_cache` (`dub:<id>`).
//!
//! # Service
//!
//! [`Dub`] porte l'état de la file (en mémoire, comme `globalThis.__dubQueue`
//! et `__dubEngine` de Node) : un seul par processus, partagé par `Clone`,
//! dans un runtime Tokio. Il tient le service [`Commentary`] (même base,
//! même table des spectateurs, même horloge) et se branche sur lui à la
//! construction : [`Commentary::set_gpu_gate`] (`__commentaryGpuGate` →
//! [`Dub::release_gpu_for_translation`]) et
//! [`Commentary::set_dub_wants_audio`] (`__dubWantsAudio` →
//! [`Dub::wants_audio`]), par référence faible (pas de cycle d'`Arc`).
//!
//! L'activité de l'analyse vidéo (`analysisActivity`, étape 7, pas encore
//! portée) est un crochet : [`Dub::set_analysis_activity`] ; sans lui,
//! aucune analyse ne tourne.

mod assemble;
mod run;
mod speakers;
mod text;

pub use assemble::{assemble_args, assemble_chunk, AssembleClip};
pub use speakers::{
    assign_roles, assign_speakers, cosine, empty_speakers, female_f0_hz, female_prob_min,
    heard_female, max_speakers, median, min_new_speaker_sec, parse_speakers, roles_used,
    serialize_speakers, speaker_sim_threshold, voice_for, AssignOptions, Speaker, SpeakerState,
    VoiceRole, FEMALE_MIN_SEC, FEMALE_WINDOW_SEC, ROLE_ORDER,
};
pub use text::{
    cues_signature, download_text, emphasize, fit_cue, group_cues, js_json, js_num_str,
    next_dub_chunk, place_clips, speech_ranges, to_fixed, CueFit, CueGroup, CLIP_GAP_SEC,
    DUB_SAMPLE_RATE, MAX_TEMPO, SLOT_TAIL_SEC,
};

use crate::commentary_db::{self as cdb, commentary_key, CommentaryTrackRow};
use crate::db::{self, Db, MatchRow};
use crate::dub_db::{self as ddb, DubTrackRow};
use crate::js::jsre;
use crate::media::abort::AbortSignal;
use crate::media::commentary::{
    iso_ms, BoxFut, CloseFn, Commentary, CommentaryDeps, EnqueueOptions, ExtractFn, ResolveStreamFn,
};
use crate::media::voice_ai::EmbedResult;
use crate::settings::Settings;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::Notify;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `short` : message d'erreur sur une ligne, 200 unités UTF-16 au plus.
pub(crate) fn short(e: &str) -> String {
    crate::js::slice_utf16(&jsre!(r"\s+").replace_all(e, " "), 200)
}

/// `clock` : « m:ss ».
pub(crate) fn clock(s: f64) -> String {
    format!(
        "{}:{:0>2}",
        crate::jsval::js_number_string((s / 60.0).floor()),
        crate::jsval::js_number_string((s % 60.0).floor())
    )
}

// ---------------------------------------------------------------- moteur de voix

/// Synthèse d'une réplique dans un WAV mono : `(texte, voix, fichier,
/// signal, emphase)` → `(durée en s, fréquence d'échantillonnage)`.
pub type SynthFn = Arc<
    dyn Fn(String, String, String, AbortSignal, Option<f64>) -> BoxFut<Result<(f64, u32), String>>
        + Send
        + Sync,
>;
/// Empreintes, hauteur et probabilité « voix de femme » de segments `[début, fin]` d'un fichier.
pub type EmbedFn = Arc<
    dyn Fn(String, Vec<(f64, f64)>, AbortSignal) -> BoxFut<Result<EmbedResult, String>>
        + Send
        + Sync,
>;

/// Session du moteur de voix (`VoiceSessionLike`).
#[derive(Clone)]
pub struct DubVoiceSession {
    /// Voix présentes : 'A', 'B4', 'B1' et peut-être 'F'.
    pub voices: Vec<String>,
    pub synth: SynthFn,
    pub embed: EmbedFn,
    pub close: CloseFn,
}

impl DubVoiceSession {
    /// Session d'un moteur de [`crate::media::voice_ai`] (Qwen3-TTS ou MiniMax).
    pub fn from_engine(e: crate::media::voice_ai::VoiceEngine) -> DubVoiceSession {
        let e = Arc::new(e);
        let (e1, e2, e3) = (e.clone(), e.clone(), e.clone());
        DubVoiceSession {
            voices: e.voices(),
            synth: Arc::new(move |text, voice, out, signal, emphasis| {
                let e = e1.clone();
                Box::pin(async move { e.synth(&text, &voice, &out, Some(&signal), emphasis).await })
            }),
            embed: Arc::new(move |file, segments, signal| {
                let e = e2.clone();
                Box::pin(async move { e.embed(&file, &segments, Some(&signal)).await })
            }),
            close: Arc::new(move || {
                let e = e3.clone();
                Box::pin(async move { e.close().await })
            }),
        }
    }
}

/// Ouverture d'une session de voix (`open(signal)`).
pub type OpenVoiceFn =
    Arc<dyn Fn(AbortSignal) -> BoxFut<Result<DubVoiceSession, String>> + Send + Sync>;

/// Mise en cache des modèles de voix (`prepare`).
pub type PrepareFn = Arc<dyn Fn() -> BoxFut<Result<(), String>> + Send + Sync>;
/// Téléchargement des modèles en cours : (octets faits, attendus ; 0 : inconnu).
pub type DownloadFn = Arc<dyn Fn() -> Option<(f64, f64)> + Send + Sync>;

/// Moteur de voix (`VoiceEngine` de `dub.ts`).
#[derive(Clone)]
pub struct DubEngine {
    /// `config().disabledReason` ; `Err` : configuration illisible (« mal configuré »).
    pub config: Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync>,
    pub open: OpenVoiceFn,
    /// Modèles mis en cache sans le GPU ; partagé, jamais interrompu par un travail.
    pub prepare: Option<PrepareFn>,
    /// Téléchargement des modèles en cours (octets faits, attendus), sinon `None`.
    pub download: Option<DownloadFn>,
    /// Le doublage occupe-t-il la carte graphique ? Absent : oui.
    pub uses_gpu: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl DubEngine {
    /// Moteur réel ([`crate::media::voice_ai`]), réglages relus en base à chaque appel.
    pub fn real(db: Db) -> DubEngine {
        let settings = move || {
            db.with(Settings::load)
                .unwrap_or_else(|_| Settings::unreadable())
        };
        let (s1, s2, s3, s4) = (
            settings.clone(),
            settings.clone(),
            settings.clone(),
            settings,
        );
        DubEngine {
            config: Arc::new(move || {
                Ok(crate::media::voice_ai::voice_config(&s1()).disabled_reason)
            }),
            open: Arc::new(move |signal| {
                let s = s2();
                Box::pin(async move {
                    crate::media::voice_ai::open_voice_session(&s, Some(&signal))
                        .await
                        .map(DubVoiceSession::from_engine)
                })
            }),
            prepare: Some(Arc::new(move || {
                let s = s3();
                Box::pin(async move { crate::media::voice_ai::prepare_voice_models(&s).await })
            })),
            download: Some(Arc::new(crate::media::voice_ai::voice_models_download)),
            uses_gpu: Some(Arc::new(move || {
                crate::media::voice_ai::voice_uses_gpu(&s4())
            })),
        }
    }
}

/// `__dubEngine` : moteur chargé au premier besoin, ou remplacé (tests).
struct EngineState {
    engine: Option<Arc<DubEngine>>,
    load_error: Option<String>,
    override_: Option<Arc<DubEngine>>,
}

pub(crate) struct Engines {
    db: Db,
    state: Mutex<EngineState>,
}

impl Engines {
    fn new(db: Db) -> Engines {
        Engines {
            db,
            state: Mutex::new(EngineState {
                engine: None,
                load_error: None,
                override_: None,
            }),
        }
    }

    /// `loadEngine` : rien n'est lancé tant qu'aucun doublage n'est demandé
    /// (en Rust, le moteur réel se « charge » toujours).
    fn load(&self) -> Arc<DubEngine> {
        let mut st = lock(&self.state);
        if let Some(e) = st.override_.clone().or_else(|| st.engine.clone()) {
            return e;
        }
        let e = Arc::new(DubEngine::real(self.db.clone()));
        st.engine = Some(e.clone());
        st.load_error = None;
        e
    }

    /// Moteur déjà chargé (`eng.override ?? eng.engine`).
    fn current(&self) -> Option<Arc<DubEngine>> {
        let st = lock(&self.state);
        st.override_.clone().or_else(|| st.engine.clone())
    }

    fn load_error(&self) -> Option<String> {
        lock(&self.state).load_error.clone()
    }
}

/// `untilAborted` : attend `f`, ou échoue dès l'interruption (sans arrêter ce que `f` représente).
async fn until_aborted<T>(
    f: BoxFut<Result<T, String>>,
    signal: &AbortSignal,
    what: &str,
) -> Result<T, String> {
    if signal.is_aborted() {
        return Err(format!("{what} : attente interrompue"));
    }
    tokio::select! {
        r = f => r,
        _ = signal.aborted() => Err(format!("{what} : attente interrompue")),
    }
}

// ---------------------------------------------------------------- dépendances d'un travail

/// Montage d'un tronçon (`assemble(clips, duration, outFile, signal)`).
pub type AssembleFn = Arc<
    dyn Fn(Vec<AssembleClip>, f64, String, AbortSignal) -> BoxFut<Result<(), String>> + Send + Sync,
>;
/// Découpe dans le son complet du match extrait par la traduction
/// (`localAudio(okId, start, length, outFile, signal)`) ; `false` : pas là
/// ou ne couvre pas la plage (l'audio est alors lu dans le flux).
pub type LocalAudioFn =
    Arc<dyn Fn(String, f64, f64, String, AbortSignal) -> BoxFut<bool> + Send + Sync>;

/// Dépendances externes d'un travail (`DubDeps`), remplaçables dans les tests.
#[derive(Clone)]
pub struct DubDeps {
    pub resolve_stream: ResolveStreamFn,
    pub extract: ExtractFn,
    pub open_voice: OpenVoiceFn,
    pub assemble: AssembleFn,
    pub local_audio: Option<LocalAudioFn>,
}

impl DubDeps {
    /// `defaultDeps` : flux et extraction comme la traduction (proxy vidéo,
    /// ffmpeg), moteur de voix chargé au premier besoin (modèles d'abord en
    /// cache, sans le GPU), montage ffmpeg, son complet de la traduction.
    fn defaults(
        video: crate::video::Video,
        commentary: &Commentary,
        engines: Arc<Engines>,
    ) -> Self {
        let c = CommentaryDeps::defaults(video);
        let cm = commentary.clone();
        DubDeps {
            resolve_stream: c.resolve_stream,
            extract: c.extract,
            open_voice: Arc::new(move |signal| {
                let e = engines.load();
                Box::pin(async move {
                    // Si le travail cède la place pendant le téléchargement, seule l'attente s'arrête.
                    if let Some(p) = &e.prepare {
                        until_aborted(p(), &signal, "téléchargement des voix").await?;
                    }
                    (e.open)(signal).await
                })
            }),
            assemble: Arc::new(|clips, duration, out, signal| {
                Box::pin(async move { assemble_chunk(&clips, duration, &out, Some(&signal)).await })
            }),
            local_audio: Some(Arc::new(move |ok_id, start, length, out, signal| {
                let cm = cm.clone();
                Box::pin(async move {
                    cm.slice_full_audio(&ok_id, start, length, &out, Some(signal))
                        .await
                })
            })),
        }
    }
}

// ---------------------------------------------------------------- contrat de l'API

/// Pourquoi un doublage cède la place (`DubYield`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DubYield {
    /// GPU pris par une traduction ou une analyse vidéo.
    Gpu,
    /// Lecture d'un autre match.
    Viewer,
    /// Hors de la fenêtre de fond (pas de doublage de fond).
    Window,
}

impl DubYield {
    pub fn as_str(self) -> &'static str {
        match self {
            DubYield::Gpu => "gpu",
            DubYield::Viewer => "viewer",
            DubYield::Window => "window",
        }
    }

    /// `YIELD_TEXT`.
    fn text(self) -> &'static str {
        match self {
            DubYield::Gpu => "le GPU passe à la traduction ou à l’analyse vidéo",
            DubYield::Viewer => "un autre match est regardé",
            DubYield::Window => "hors de la fenêtre des tâches de fond",
        }
    }
}

/// Nature d'un échec (`DubFailureKind`) : `Reseau` (flux vidéo) et `Service`
/// (moteur de voix) sont réessayés vite, sans compter dans l'abandon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DubFailureKind {
    Reseau,
    Service,
    Erreur,
}

impl DubFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DubFailureKind::Reseau => "reseau",
            DubFailureKind::Service => "service",
            DubFailureKind::Erreur => "erreur",
        }
    }
}

fn quick_retry(k: Option<&str>) -> bool {
    matches!(k, Some("reseau" | "service"))
}

/// Avancement d'un travail (`DubProgress`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DubProgress {
    /// Tronçons doublés (à jour) sur `total` tronçons traduits publiés.
    pub done: f64,
    pub total: f64,
    /// Tronçon en cours (idx).
    pub chunk: Option<i64>,
    /// Étape en cours, en clair, affichée sur la fiche.
    pub step: Option<String>,
}

/// Rappel d'avancement d'un travail.
pub type DubProgressFn = Arc<dyn Fn(DubProgress) + Send + Sync>;

/// Résultat d'un travail (`DubOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubOutcome {
    pub ok: bool,
    pub reason: String,
    pub kind: Option<DubFailureKind>,
    /// A cédé la place (ni succès ni échec).
    pub yielded: Option<DubYield>,
}

impl DubOutcome {
    pub fn ok(reason: impl Into<String>) -> Self {
        DubOutcome {
            ok: true,
            reason: reason.into(),
            kind: None,
            yielded: None,
        }
    }

    pub fn failed(kind: DubFailureKind, reason: impl Into<String>) -> Self {
        DubOutcome {
            ok: false,
            reason: reason.into(),
            kind: Some(kind),
            yielded: None,
        }
    }

    pub fn yielded(why: DubYield, reason: impl Into<String>) -> Self {
        DubOutcome {
            ok: false,
            reason: reason.into(),
            kind: None,
            yielded: Some(why),
        }
    }

    /// Objet de Node (`{ ok, kind?, yielded?, reason }` dans l'ordre où `runDub` l'écrit).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::from(self.ok));
        if let Some(y) = self.yielded {
            m.insert("yielded".into(), Value::from(y.as_str()));
        }
        if let Some(k) = self.kind {
            m.insert("kind".into(), Value::from(k.as_str()));
        }
        m.insert("reason".into(), Value::from(self.reason.clone()));
        Value::Object(m)
    }
}

/// Pilotage d'un travail par la file (`DubControl`), vérifié avant chaque
/// tronçon et chaque réplique.
#[derive(Clone)]
pub struct DubControl {
    /// Céder la place ?
    pub yield_reason: Arc<dyn Fn() -> Option<DubYield> + Send + Sync>,
    /// Position à doubler en priorité (celle du spectateur).
    pub target: Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl DubControl {
    /// `RUN_TO_END`.
    pub fn run_to_end() -> Self {
        DubControl {
            yield_reason: Arc::new(|| None),
            target: Arc::new(|| 0.0),
        }
    }
}

/// Un travail de la file (`Job`).
#[derive(Debug, Clone)]
pub struct DubJob {
    pub match_id: i64,
    /// Demandé par quelqu'un qui regarde le match : passe devant un doublage de fond.
    pub viewer: bool,
    /// Demande EXPLICITE : doublé jusqu'au bout ; partagé (une demande
    /// explicite pendant le travail le rend explicite).
    explicit: Arc<AtomicBool>,
}

impl DubJob {
    pub fn new(match_id: i64) -> DubJob {
        DubJob::with(match_id, false, false)
    }

    pub fn with(match_id: i64, viewer: bool, explicit: bool) -> DubJob {
        DubJob {
            match_id,
            viewer,
            explicit: Arc::new(AtomicBool::new(explicit)),
        }
    }

    pub fn explicit(&self) -> bool {
        self.explicit.load(Ordering::SeqCst)
    }

    /// Copie détachée (`{ ...job }`).
    fn copy(&self, viewer: bool) -> DubJob {
        DubJob::with(self.match_id, viewer, self.explicit())
    }
}

/// Exécuteur d'un travail (`DubRunner`) ; par défaut [`Dub::run_dub`] avec
/// les dépendances du service. `Err` : le travail a échoué (exception de Node).
pub type DubRunner = Arc<
    dyn Fn(DubJob, DubProgressFn, AbortSignal, DubControl) -> BoxFut<Result<DubOutcome, String>>
        + Send
        + Sync,
>;

/// Options d'une mise en file (`enqueueDub`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DubEnqueueOptions {
    /// En tête (match regardé), quitte à interrompre un doublage de fond.
    pub priority: bool,
    /// Demande explicite.
    pub explicit: bool,
}

/// Résultat d'une mise en file ou d'une demande (`DubEnqueueResult`,
/// `DubRequestResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DubRequestResult {
    pub queued: bool,
    pub started: bool,
    pub position: Option<usize>,
    pub message: String,
    /// Message de la mise en file de la traduction, quand les sous-titres n'étaient pas complets.
    pub translation: Option<String>,
}

impl DubRequestResult {
    fn new(queued: bool, started: bool, message: impl Into<String>) -> Self {
        DubRequestResult {
            queued,
            started,
            position: None,
            message: message.into(),
            translation: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("queued".into(), Value::from(self.queued));
        m.insert("started".into(), Value::from(self.started));
        if let Some(p) = self.position {
            m.insert("position".into(), Value::from(p));
        }
        m.insert("message".into(), Value::from(self.message.clone()));
        if let Some(t) = &self.translation {
            m.insert("translation".into(), Value::from(t.clone()));
        }
        Value::Object(m)
    }
}

/// Résultat de « Arrêter le doublage » (`DubStopResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DubStopResult {
    pub stopped: bool,
    pub message: String,
}

impl DubStopResult {
    pub fn to_json(&self) -> Value {
        json!({ "stopped": self.stopped, "message": self.message })
    }
}

/// Doublage en cours vu par le panneau d'activité.
#[derive(Debug, Clone, PartialEq)]
pub struct DubRunningActivity {
    pub match_id: i64,
    pub done: f64,
    pub total: f64,
    pub watched: bool,
}

/// Activité de la file (`DubActivity`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubActivity {
    pub running: Option<DubRunningActivity>,
    /// Matchs en attente, dans l'ordre.
    pub queued: Vec<i64>,
    /// Des doublages attendent que le GPU se libère.
    pub waiting_for_gpu: bool,
}

impl DubActivity {
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        json!({
            "running": self.running.as_ref().map(|r| json!({
                "matchId": r.match_id, "done": n(r.done), "total": n(r.total), "watched": r.watched,
            })),
            "queued": self.queued,
            "waitingForGpu": self.waiting_for_gpu,
        })
    }
}

/// Tronçon prêt du manifeste (`DubManifestChunk`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubManifestChunk {
    pub idx: i64,
    /// Début du tronçon dans la vidéo (s) : t = 0 de l'audio.
    pub start: f64,
    pub end: f64,
    pub url: String,
    /// Plages de parole française (s, temps absolu), JSON relu en base.
    pub speech: Value,
}

/// Contrat de GET /api/matches/[id]/dub (`DubManifest`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubManifest {
    /// 'none' | 'waiting' | 'running' | 'partial' | 'ready' | 'disabled' | 'failed'.
    pub status: &'static str,
    pub reason: Option<String>,
    /// (`running`) tronçons doublés, tronçons traduits publiés.
    pub progress: Option<(f64, f64)>,
    pub step: Option<String>,
    /// Arrêté à la demande : « Reprendre le doublage » le relance.
    pub stopped: bool,
    pub chunks: Vec<DubManifestChunk>,
    pub voices: Vec<(VoiceRole, &'static str)>,
}

impl DubManifest {
    fn new(
        status: &'static str,
        chunks: Vec<DubManifestChunk>,
        voices: Vec<(VoiceRole, &'static str)>,
    ) -> Self {
        DubManifest {
            status,
            reason: None,
            progress: None,
            step: None,
            stopped: false,
            chunks,
            voices,
        }
    }

    /// Objet JSON de Node, clés dans l'ordre où chaque branche de `dubManifest` les écrit.
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let mut m = Map::new();
        m.insert("status".into(), Value::from(self.status));
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::from(r.clone()));
        }
        if let Some((d, t)) = self.progress {
            m.insert("progress".into(), json!({ "done": n(d), "total": n(t) }));
        }
        if let Some(s) = &self.step {
            m.insert("step".into(), Value::from(s.clone()));
        }
        if self.stopped {
            m.insert("stopped".into(), Value::Bool(true));
        }
        m.insert(
            "chunks".into(),
            Value::Array(
                self.chunks
                    .iter()
                    .map(|c| {
                        json!({ "idx": c.idx, "start": n(c.start), "end": n(c.end), "url": c.url, "speech": c.speech })
                    })
                    .collect(),
            ),
        );
        let mut v = Map::new();
        for (r, label) in &self.voices {
            v.insert(r.as_str().into(), Value::from(*label));
        }
        m.insert("voices".into(), Value::Object(v));
        Value::Object(m)
    }
}

/// Dernier résultat d'un match (`DubRecord`, `kv_cache` `dub:<id>`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubRecord {
    pub at: String,
    pub ok: bool,
    pub failures: Option<f64>,
    pub net_failures: Option<f64>,
    /// 'reseau' | 'service' | 'erreur'.
    pub kind: Option<String>,
    pub reason: String,
    /// Piste traduite doublée (`commentaryKey`) ; vide ou absente : `None`.
    pub key: Option<String>,
    /// Arrêté à la demande (« Arrêter le doublage »).
    pub stopped: bool,
}

impl DubRecord {
    pub fn from_json(v: &Value) -> Option<DubRecord> {
        let o = v.as_object()?;
        Some(DubRecord {
            at: crate::js::str_or_empty(o.get("at")),
            ok: crate::js::truthy(o.get("ok")),
            failures: o.get("failures").and_then(Value::as_f64),
            net_failures: o.get("netFailures").and_then(Value::as_f64),
            kind: o.get("kind").and_then(Value::as_str).map(String::from),
            reason: crate::js::str_or_empty(o.get("reason")),
            key: o
                .get("key")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(String::from),
            stopped: crate::js::truthy(o.get("stopped")),
        })
    }
}

/// Activité de l'analyse vidéo (`analysisActivity` d'`analysis.ts`, étape 7).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalysisActivity {
    pub running: Vec<AnalysisRun>,
    pub queued: Vec<i64>,
}

/// Analyse en cours (`{ matchId, phase, done, total }`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisRun {
    pub match_id: i64,
    /// Phase en clair ; « en pause pendant la lecture » n'occupe pas le GPU.
    pub phase: String,
    pub done: f64,
    pub total: f64,
}

/// Crochet de l'activité de l'analyse vidéo.
pub type AnalysisActivityFn = Arc<dyn Fn() -> AnalysisActivity + Send + Sync>;

/// Journal du doublage : `(erreur ?, ligne)` (`console.error` / `console.log`).
pub type DubLog = Arc<dyn Fn(bool, &str) + Send + Sync>;

/// Réglages du service (injectables pour les tests).
#[derive(Clone)]
pub struct DubOptions {
    /// `ffmpegAvailable`.
    pub ffmpeg_available: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Journal (par défaut la sortie standard et la sortie d'erreur).
    pub log: DubLog,
}

impl Default for DubOptions {
    fn default() -> Self {
        DubOptions {
            ffmpeg_available: Arc::new(crate::media::audio::ffmpeg_available),
            log: Arc::new(|err, line| {
                if err {
                    eprintln!("{line}");
                } else {
                    println!("{line}");
                }
            }),
        }
    }
}

// ---------------------------------------------------------------- état de la file

struct Running {
    id: u64,
    job: DubJob,
    progress: Option<DubProgress>,
    signal: AbortSignal,
    /// Interrompu pour laisser passer un match regardé : remis en file, sans compter d'échec.
    preempted: bool,
    /// Interrompu pour rendre la carte graphique à une traduction : remis en tête de file.
    gpu_yield: bool,
    /// Arrêté à la demande : ni remis en file, ni compté comme échec.
    stopped: bool,
}

#[derive(Default)]
struct QueueState {
    queue: Vec<DubJob>,
    running: Option<Running>,
    next_id: u64,
}

pub(crate) struct Inner {
    commentary: Commentary,
    deps: DubDeps,
    opts: DubOptions,
    engines: Arc<Engines>,
    state: Mutex<QueueState>,
    runner: Mutex<Option<DubRunner>>,
    analysis: Mutex<Option<AnalysisActivityFn>>,
    repump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    idle: Notify,
}

/// Service de doublage (file, manifestes, travaux).
#[derive(Clone)]
pub struct Dub(pub(crate) Arc<Inner>);

/// `dubDir` : `<données>/dub/<match>`.
pub fn dub_dir(match_id: i64) -> PathBuf {
    crate::media::local_ai::data_dir()
        .join("dub")
        .join(match_id.to_string())
}

/// `jobTimeoutMs` : `DUB_TIMEOUT_MS`, 6 h par défaut (ce qui est publié reste).
fn job_timeout_ms() -> f64 {
    let n = std::env::var("DUB_TIMEOUT_MS")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    if n.is_finite() && n > 0.0 {
        n
    } else {
        6.0 * 3_600_000.0
    }
}

fn position_in(queue: &[DubJob], match_id: i64) -> Option<usize> {
    queue
        .iter()
        .position(|j| j.match_id == match_id)
        .map(|i| i + 1)
}

impl Dub {
    /// Service de production, branché sur `commentary` (même base, mêmes
    /// spectateurs et horloge) ; flux résolus par le proxy vidéo `video`.
    pub fn new(commentary: Commentary, video: crate::video::Video) -> Dub {
        let engines = Arc::new(Engines::new(commentary.db().clone()));
        let deps = DubDeps::defaults(video, &commentary, engines.clone());
        Dub::build(commentary, deps, DubOptions::default(), engines)
    }

    /// Service aux dépendances et réglages choisis (tests).
    pub fn with_options(commentary: Commentary, deps: DubDeps, opts: DubOptions) -> Dub {
        let engines = Arc::new(Engines::new(commentary.db().clone()));
        Dub::build(commentary, deps, opts, engines)
    }

    fn build(
        commentary: Commentary,
        deps: DubDeps,
        opts: DubOptions,
        engines: Arc<Engines>,
    ) -> Dub {
        let dub = Dub(Arc::new(Inner {
            commentary,
            deps,
            opts,
            engines,
            state: Mutex::new(QueueState::default()),
            runner: Mutex::new(None),
            analysis: Mutex::new(None),
            repump: Mutex::new(None),
            idle: Notify::new(),
        }));
        dub.attach();
        dub
    }

    /// Branche les crochets de la traduction (`__commentaryGpuGate`,
    /// `__dubWantsAudio`), le doublage tenu par référence faible.
    fn attach(&self) {
        let w = self.weak();
        self.0.commentary.set_gpu_gate(Some(Arc::new(move || {
            w.upgrade()
                .and_then(|inner| Dub(inner).release_gpu_for_translation(None))
        })));
        let w = self.weak();
        self.0
            .commentary
            .set_dub_wants_audio(Some(Arc::new(move |id| {
                w.upgrade().is_some_and(|inner| Dub(inner).wants_audio(id))
            })));
    }

    fn weak(&self) -> Weak<Inner> {
        Arc::downgrade(&self.0)
    }

    fn st(&self) -> MutexGuard<'_, QueueState> {
        lock(&self.0.state)
    }

    /// Service de traduction auquel le doublage est branché.
    pub fn commentary(&self) -> &Commentary {
        &self.0.commentary
    }

    fn db(&self) -> &Db {
        self.0.commentary.db()
    }

    pub(crate) fn log(&self, line: &str) {
        (self.0.opts.log)(false, line);
    }

    pub(crate) fn log_error(&self, line: &str) {
        (self.0.opts.log)(true, line);
    }

    fn now_iso(&self) -> String {
        iso_ms(self.0.commentary.now())
    }

    // ------------------------------------------------------------ crochets et outils de test

    /// Pose le crochet de l'activité de l'analyse vidéo (`analysisActivity`) ;
    /// `None` : aucune analyse ne tourne.
    pub fn set_analysis_activity(&self, f: Option<AnalysisActivityFn>) {
        *lock(&self.0.analysis) = f;
    }

    fn analysis_activity(&self) -> AnalysisActivity {
        let f = lock(&self.0.analysis).clone();
        f.and_then(|f| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f())).ok())
            .unwrap_or_default()
    }

    /// Remplace l'exécuteur (`__setDubRunnerForTests`) ; vide la file.
    pub fn set_runner(&self, runner: Option<DubRunner>) {
        *lock(&self.0.runner) = runner;
        if let Some(t) = lock(&self.0.repump).take() {
            t.abort();
        }
        {
            let mut st = self.st();
            st.queue.clear();
            st.running = None;
        }
        self.0.idle.notify_waiters();
    }

    /// Moteur de voix simulé (`__setDubEngineForTests`) ; `None` : le vrai, chargé au premier besoin.
    pub fn set_engine(&self, engine: Option<DubEngine>) {
        let mut st = lock(&self.0.engines.state);
        st.override_ = engine.map(Arc::new);
        st.load_error = None;
    }

    /// `__dubIdle` : attend que la file soit vide.
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

    // ------------------------------------------------------------ moteur

    /// `dubDisabledReasonSync` : tant que le moteur n'est pas chargé, seuls
    /// `DUB_DISABLED` et ffmpeg sont vérifiés.
    pub fn disabled_reason_sync(&self) -> Option<String> {
        if std::env::var("DUB_DISABLED").ok().as_deref() == Some("1") {
            return Some("doublage désactivé (DUB_DISABLED=1)".into());
        }
        if let Some(e) = self.0.engines.current() {
            match (e.config)() {
                Ok(Some(r)) if !r.is_empty() => return Some(r),
                Err(err) => return Some(format!("moteur de voix mal configuré : {}", short(&err))),
                _ => {}
            }
        } else if let Some(err) = self.0.engines.load_error() {
            return Some(format!("moteur de voix indisponible : {err}"));
        }
        if !(self.0.opts.ffmpeg_available)() {
            return Some("ffmpeg absent du serveur".into());
        }
        None
    }

    /// `dubDisabledReason` : configuration du moteur comprise (moteur chargé).
    pub fn disabled_reason(&self) -> Option<String> {
        if std::env::var("DUB_DISABLED").ok().as_deref() != Some("1") {
            self.0.engines.load();
        }
        self.disabled_reason_sync()
    }

    /// `dubUsesGpu` : moteur pas encore chargé : oui, par prudence.
    fn uses_gpu(&self) -> bool {
        let Some(e) = self.0.engines.current() else {
            return true;
        };
        let Some(f) = e.uses_gpu.clone() else {
            return true;
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f())).unwrap_or(true)
    }

    /// `gpuHolder` : ce qui occupe le GPU, vu depuis le match `match_id`.
    fn gpu_holder(&self, match_id: i64) -> Option<&'static str> {
        if let Some(c) = self.0.commentary.activity().running {
            return Some(if c.match_id == match_id {
                "la traduction de ce match"
            } else {
                "la traduction d’un autre match"
            });
        }
        let a: Vec<AnalysisRun> = self
            .analysis_activity()
            .running
            .into_iter()
            .filter(|r| r.phase != "en pause pendant la lecture")
            .collect();
        if a.is_empty() {
            return None;
        }
        Some(if a.iter().any(|r| r.match_id == match_id) {
            "l’analyse vidéo de ce match"
        } else {
            "l’analyse vidéo d’un autre match"
        })
    }

    /// `gpuBusy` : GPU pris par une traduction ou une analyse vidéo (une
    /// analyse en pause pendant la lecture ne compte pas).
    pub fn gpu_busy(&self) -> bool {
        self.gpu_holder(0).is_some()
    }

    /// `gpuBlocksDub`.
    fn gpu_blocks(&self) -> bool {
        self.uses_gpu() && self.gpu_busy()
    }

    /// `prefetchVoiceModels` : téléchargement des modèles lancé tout de suite, sans attendre le GPU.
    fn prefetch_voice_models(&self) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let engines = self.0.engines.clone();
        let log = self.0.opts.log.clone();
        rt.spawn(async move {
            let e = engines.load();
            if let Some(p) = e.prepare.clone() {
                if let Err(err) = p().await {
                    log(
                        true,
                        &format!(
                            "[doublage] modèles de voix : {} (nouvel essai au prochain doublage)",
                            short(&err)
                        ),
                    );
                }
            }
        });
    }

    /// `downloadStep` : téléchargement des modèles en cours, en clair.
    fn download_step(&self) -> Option<String> {
        let e = self.0.engines.current()?;
        let (d, t) = (e.download.as_ref()?)()?;
        Some(download_text(d, t))
    }

    // ------------------------------------------------------------ lectures

    pub(crate) fn get_match(&self, id: i64) -> Option<MatchRow> {
        self.db().with(|c| db::get_match(c, id)).ok().flatten()
    }

    pub(crate) fn dub_track(&self, id: i64) -> Option<DubTrackRow> {
        self.db().with(|c| ddb::get_dub_track(c, id)).ok().flatten()
    }

    /// `currentCommentaryTrack` : piste traduite (complète ou partielle) du replay ACTUEL.
    pub(crate) fn current_track(&self, id: i64) -> Option<CommentaryTrackRow> {
        let m = self.get_match(id)?;
        let ok = m.video_ok_id.filter(|s| !s.is_empty())?;
        self.db()
            .with(|c| cdb::get_commentary_track(c, id))
            .ok()
            .flatten()
            .filter(|t| t.ok_id == ok && t.cues > 0)
    }

    /// `hasDubWork` : reste-t-il des tronçons traduits à doubler ?
    pub fn has_work(&self, id: i64) -> bool {
        self.current_track(id).is_some_and(|t| {
            let key = commentary_key(&t);
            self.db()
                .with(|c| ddb::dub_pending_chunks(c, id, &key))
                .unwrap_or(0)
                > 0
        })
    }

    /// `dubChunkPath` : fichier audio d'un tronçon doublé publié.
    pub fn chunk_path(&self, match_id: i64, idx: i64) -> Option<PathBuf> {
        let row = self
            .db()
            .with(|c| ddb::get_dub_chunk(c, match_id, idx))
            .ok()
            .flatten()?;
        let base = std::path::Path::new(&row.file).file_name()?.to_owned();
        Some(dub_dir(match_id).join(base))
    }

    fn record_raw(&self, match_id: i64) -> Option<Value> {
        self.db()
            .with(|c| db::kv_get(c, &format!("dub:{match_id}"), None))
            .ok()
            .flatten()
    }

    /// `getDubRecord`.
    pub fn record(&self, match_id: i64) -> Option<DubRecord> {
        self.record_raw(match_id)
            .and_then(|v| DubRecord::from_json(&v))
    }

    fn set_record(&self, match_id: i64, v: &Value) -> Result<(), String> {
        self.db()
            .with(|c| db::kv_set(c, &format!("dub:{match_id}"), v))
    }

    /// `translationPending` : la traduction de ce match tourne ou est en file.
    fn translation_pending(&self, id: i64) -> bool {
        self.0.commentary.running_match_id() == Some(id)
            || self.0.commentary.queue_position(id).is_some()
    }

    /// `unwanted` : un travail ni demandé ni regardé est abandonné.
    fn unwanted(&self, job: &DubJob) -> bool {
        !job.viewer && !job.explicit() && !self.0.commentary.viewer_active(job.match_id)
    }

    /// `mustWait` : quelqu'un regarde un autre match.
    fn must_wait(&self, job: &DubJob) -> bool {
        (!job.viewer || job.explicit())
            && !self.0.commentary.viewer_active(job.match_id)
            && self.0.commentary.someone_watching(job.match_id)
    }

    /// `waitsForSubtitles` : travail explicite qui attend ses sous-titres.
    fn waits_for_subtitles(&self, job: &DubJob) -> bool {
        job.explicit() && !self.has_work(job.match_id) && self.translation_pending(job.match_id)
    }

    /// `dubQueuePosition`.
    pub fn queue_position(&self, match_id: i64) -> Option<usize> {
        position_in(&self.st().queue, match_id)
    }

    /// `__dubWantsAudio` : doublage en cours ou en file pour ce match.
    pub fn wants_audio(&self, match_id: i64) -> bool {
        let st = self.st();
        st.running
            .as_ref()
            .is_some_and(|r| r.job.match_id == match_id)
            || position_in(&st.queue, match_id).is_some()
    }

    /// Match en cours de doublage (arrêt demandé compris).
    pub fn running_match_id(&self) -> Option<i64> {
        self.st().running.as_ref().map(|r| r.job.match_id)
    }

    fn control_for(&self, job: &DubJob) -> DubControl {
        let id = job.match_id;
        let explicit = job.explicit.clone();
        let w = self.weak();
        let w2 = self.weak();
        DubControl {
            yield_reason: Arc::new(move || {
                let d = Dub(w.upgrade()?);
                if d.gpu_blocks() {
                    return Some(DubYield::Gpu);
                }
                let c = d.commentary();
                if c.viewer_active(id) {
                    return None;
                }
                // Le spectateur est parti : un autre match est regardé, ou plus personne.
                if c.someone_watching(id) {
                    return Some(DubYield::Viewer);
                }
                if explicit.load(Ordering::SeqCst) {
                    return None; // demande explicite : jusqu'au bout
                }
                Some(DubYield::Window) // pas de doublage de fond
            }),
            target: Arc::new(move || {
                w2.upgrade()
                    .and_then(|i| Dub(i).commentary().viewer_position(id))
                    .unwrap_or(0.0)
            }),
        }
    }

    // ------------------------------------------------------------ file

    /// `enqueueDub` : met un match en file de doublage.
    pub fn enqueue(&self, match_id: i64, opts: DubEnqueueOptions) -> DubRequestResult {
        if let Some(d) = self.disabled_reason_sync() {
            return DubRequestResult::new(false, false, format!("Doublage inactif : {d}"));
        }
        {
            let st = self.st();
            // Un doublage qui s'arrête ne compte plus.
            if let Some(r) = st
                .running
                .as_ref()
                .filter(|r| !r.stopped && r.job.match_id == match_id)
            {
                if opts.explicit {
                    r.job.explicit.store(true, Ordering::SeqCst);
                }
                return DubRequestResult::new(false, true, "Doublage déjà en cours");
            }
        }
        if !self.has_work(match_id) && !(opts.explicit && self.translation_pending(match_id)) {
            return DubRequestResult::new(
                false,
                false,
                "Rien à doubler (sous-titres absents ou déjà doublés)",
            );
        }
        let job = {
            let mut st = self.st();
            let existing = st.queue.iter().position(|j| j.match_id == match_id);
            let prev = existing.map(|i| st.queue[i].clone());
            let job = DubJob::with(
                match_id,
                opts.priority || prev.as_ref().is_some_and(|p| p.viewer),
                opts.explicit || prev.as_ref().is_some_and(|p| p.explicit()),
            );
            match existing {
                Some(i) if opts.priority => {
                    st.queue.remove(i);
                    st.queue.insert(0, job.clone());
                }
                Some(i) => st.queue[i] = job.clone(),
                None if opts.priority => st.queue.insert(0, job.clone()),
                None => st.queue.push(job.clone()),
            }
            job
        };
        if opts.priority {
            self.preempt_background();
        }
        self.prefetch_voice_models();
        self.pump();
        if self.running_match_id() == Some(match_id) {
            return DubRequestResult::new(true, true, "Doublage lancé");
        }
        let Some(position) = self.queue_position(match_id) else {
            return DubRequestResult::new(
                false,
                false,
                "Doublage abandonné : ni demandé ni regardé",
            );
        };
        let message = if self.waits_for_subtitles(&job) {
            "Doublage en file : il commencera dès les premiers sous-titres français".to_string()
        } else {
            format!("Doublage en file (position {position})")
        };
        DubRequestResult {
            position: Some(position),
            ..DubRequestResult::new(true, false, message)
        }
    }

    /// `preemptBackground` : un match regardé passe devant un doublage de
    /// FOND en cours (ou explicite dont la fiche n'est plus regardée).
    fn preempt_background(&self) {
        let mut st = self.st();
        let head = st.queue.first().map(|j| j.match_id);
        let Some(r) = st.running.as_mut() else { return };
        if r.preempted || Some(r.job.match_id) == head {
            return;
        }
        if r.job.viewer && !(r.job.explicit() && !self.0.commentary.viewer_active(r.job.match_id)) {
            return;
        }
        r.preempted = true;
        let line = format!(
            "[doublage] match {} mis en pause : le match {} est regardé, il passe en premier",
            r.job.match_id,
            head.map_or("undefined".into(), |h| h.to_string())
        );
        r.signal.abort();
        drop(st);
        self.log(&line);
    }

    /// `releaseGpuForTranslation` : une traduction va démarrer : le doublage
    /// en cours rend la carte graphique TOUT DE SUITE (travail interrompu,
    /// session de voix fermée), remis en tête de file. `None` : rien à
    /// libérer (ou synthèse en ligne) ; sinon le futur se termine quand le
    /// travail est fini, au plus `max_wait_ms` (20 s) plus tard.
    pub fn release_gpu_for_translation(&self, max_wait_ms: Option<u64>) -> Option<BoxFut<()>> {
        let id = {
            let st = self.st();
            st.running.as_ref()?.id
        };
        if !self.uses_gpu() {
            return None; // synthèse en ligne (MiniMax) : les deux tournent ensemble
        }
        {
            let mut st = self.st();
            let r = st.running.as_mut().filter(|r| r.id == id)?;
            r.gpu_yield = true;
            r.signal.abort();
        }
        let max = Duration::from_millis(max_wait_ms.unwrap_or(20_000));
        let w = self.weak();
        Some(Box::pin(async move {
            let t0 = std::time::Instant::now();
            while t0.elapsed() < max {
                let still = w
                    .upgrade()
                    .is_some_and(|i| Dub(i).st().running.as_ref().is_some_and(|r| r.id == id));
                if !still {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }))
    }

    fn schedule_repump(&self) {
        let ms = crate::media::commentary::env_num_or("DUB_REPUMP_MS", 20_000.0);
        let weak = self.weak();
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let h = rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(crate::js::max(0.0, ms) as u64)).await;
            if let Some(inner) = weak.upgrade() {
                Dub(inner).pump();
            }
        });
        if let Some(old) = lock(&self.0.repump).replace(h) {
            old.abort();
        }
    }

    /// `pump` : lance le premier travail qui peut partir.
    fn pump(&self) {
        if let Some(t) = lock(&self.0.repump).take() {
            t.abort();
        }
        let start = {
            let mut st = self.st();
            let mut start = None;
            if st.running.is_none() && !st.queue.is_empty() {
                if self.disabled_reason_sync().is_some() {
                    st.queue.clear();
                }
                let queue = std::mem::take(&mut st.queue);
                st.queue = queue.into_iter().filter(|j| !self.unwanted(j)).collect();
                if !st.queue.is_empty() && self.gpu_blocks() {
                    self.schedule_repump(); // GPU pris : on attend sa libération
                } else {
                    while st.running.is_none() && !st.queue.is_empty() {
                        // Ceux des spectateurs toujours, ceux de fond quand personne ne
                        // regarde ; un travail explicite qui attend ses sous-titres reste en file.
                        let Some(i) = st
                            .queue
                            .iter()
                            .position(|j| !self.must_wait(j) && !self.waits_for_subtitles(j))
                        else {
                            self.schedule_repump();
                            break;
                        };
                        let job = st.queue.remove(i);
                        if !self.has_work(job.match_id) {
                            continue;
                        }
                        st.next_id += 1;
                        let id = st.next_id;
                        let signal = AbortSignal::new();
                        st.running = Some(Running {
                            id,
                            job: job.clone(),
                            progress: None,
                            signal: signal.clone(),
                            preempted: false,
                            gpu_yield: false,
                            stopped: false,
                        });
                        start = Some((id, job, signal));
                    }
                }
            }
            start
        };
        if let Some((id, job, signal)) = start {
            self.start(id, job, signal);
        }
        let idle = {
            let st = self.st();
            st.running.is_none() && st.queue.is_empty()
        };
        if idle {
            self.0.idle.notify_waiters();
        }
    }

    fn runner(&self) -> DubRunner {
        if let Some(r) = lock(&self.0.runner).clone() {
            return r;
        }
        self.runner_with(self.0.deps.clone())
    }

    /// Exécuteur [`Dub::run_dub`] avec d'autres dépendances (`viaQueue(deps)`
    /// des tests de Node), à passer à [`Dub::set_runner`].
    pub fn runner_with(&self, deps: DubDeps) -> DubRunner {
        let w = self.weak();
        Arc::new(move |job, progress, signal, ctl| {
            let (w, deps) = (w.clone(), deps.clone());
            Box::pin(async move {
                let Some(inner) = w.upgrade() else {
                    return Err("service arrêté".into());
                };
                Dub(inner)
                    .run_dub(&job, progress, signal, &deps, &ctl)
                    .await
            })
        })
    }

    /// `start` : lance un travail (déjà inscrit comme en cours).
    fn start(&self, id: u64, job: DubJob, signal: AbortSignal) {
        let match_id = job.match_id;
        let key = self.current_track(match_id).map(|t| commentary_key(&t));
        let runner = self.runner();
        let log_id = self
            .db()
            .with(|c| crate::ingest_db::log_ingest_start(c, &format!("doublage-{match_id}")))
            .ok();
        let w = self.weak();
        let progress: DubProgressFn = Arc::new(move |p: DubProgress| {
            if let Some(inner) = w.upgrade() {
                let d = Dub(inner);
                let mut st = d.st();
                if let Some(r) = st.running.as_mut().filter(|r| r.id == id) {
                    r.progress = Some(p);
                }
            }
        });
        let work = runner(
            job.clone(),
            progress,
            signal.clone(),
            self.control_for(&job),
        );
        let this = self.clone();
        tokio::spawn(async move {
            let timeout = job_timeout_ms();
            // Le travail tourne à part : interrompu par le garde-fou, il finit
            // quand même proprement (session fermée).
            let mut handle = tokio::spawn(work);
            let res = tokio::select! {
                r = &mut handle => r.unwrap_or_else(|e| Err(e.to_string())),
                _ = tokio::time::sleep(Duration::from_millis(timeout as u64)) => {
                    signal.abort();
                    Err(format!(
                        "délai dépassé ({} min)",
                        crate::jsval::js_number_string(crate::js::max(1.0, crate::js::round(timeout / 60_000.0)))
                    ))
                }
            };
            let res = res.unwrap_or_else(|e| {
                DubOutcome::failed(
                    DubFailureKind::Erreur,
                    format!("Doublage impossible : {}", short(&e)),
                )
            });
            this.finish(id, &job, key, log_id, res);
            {
                let mut st = this.st();
                if st.running.as_ref().is_some_and(|r| r.id == id) {
                    st.running = None;
                }
            }
            this.pump();
        });
    }

    fn end_log(&self, log_id: Option<i64>, ok: bool, detail: &str) {
        if let Some(l) = log_id {
            // Journal facultatif.
            let _ = self
                .db()
                .with(|c| crate::ingest_db::log_ingest_end(c, l, ok, detail));
        }
    }

    /// Suite d'un travail terminé : remise en file, enregistrement, journaux.
    fn finish(
        &self,
        id: u64,
        job: &DubJob,
        key: Option<String>,
        log_id: Option<i64>,
        res: DubOutcome,
    ) {
        let match_id = job.match_id;
        let (stopped, gpu_yield, preempted) = {
            let st = self.st();
            st.running
                .as_ref()
                .filter(|r| r.id == id)
                .map_or((false, false, false), |r| {
                    (r.stopped, r.gpu_yield, r.preempted)
                })
        };
        if stopped {
            self.end_log(log_id, true, "arrêté à la demande");
            self.log(&format!(
                "[doublage] match {match_id} arrêté à la demande ; ce qui est doublé reste disponible"
            ));
            return;
        }
        if gpu_yield {
            self.end_log(
                log_id,
                true,
                "interrompu : une traduction a besoin de la carte graphique",
            );
            {
                let mut st = self.st();
                if !st.queue.iter().any(|j| j.match_id == match_id) {
                    st.queue.insert(0, job.copy(job.viewer));
                }
            }
            self.log(&format!(
                "[doublage] match {match_id} en pause : une traduction a besoin de la carte graphique ; reprise ensuite"
            ));
            return;
        }
        if preempted {
            self.end_log(
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
        if let Some(why) = res.yielded {
            // Ni succès ni échec : reprise quand le GPU sera libre, ou après la lecture.
            self.end_log(log_id, true, &res.reason);
            {
                let mut st = self.st();
                if !st.queue.iter().any(|j| j.match_id == match_id) {
                    match why {
                        DubYield::Gpu => st.queue.insert(0, job.copy(job.viewer)),
                        DubYield::Viewer => st.queue.push(job.copy(false)),
                        DubYield::Window => {}
                    }
                }
            }
            self.log(&format!(
                "[doublage] match {match_id} {}{}",
                res.reason,
                if why == DubYield::Window {
                    ""
                } else {
                    " ; reprise ensuite"
                }
            ));
            return;
        }
        let prev = self.record(match_id);
        let same_key = prev
            .as_ref()
            .and_then(|p| p.key.as_deref())
            .is_none_or(|k| Some(k) == key.as_deref());
        let kind = if res.ok {
            None
        } else {
            Some(res.kind.unwrap_or(DubFailureKind::Erreur))
        };
        let kind_s = kind.map(DubFailureKind::as_str);
        let failures = if res.ok {
            0.0
        } else {
            (if same_key {
                prev.as_ref().and_then(|p| p.failures).unwrap_or(0.0)
            } else {
                0.0
            }) + if quick_retry(kind_s) { 0.0 } else { 1.0 }
        };
        let net_failures = if quick_retry(kind_s) {
            (if same_key && quick_retry(prev.as_ref().and_then(|p| p.kind.as_deref())) {
                prev.as_ref().and_then(|p| p.net_failures).unwrap_or(0.0)
            } else {
                0.0
            }) + 1.0
        } else {
            0.0
        };
        let mut rec = Map::new();
        rec.insert("at".into(), Value::from(self.now_iso()));
        rec.insert("ok".into(), Value::from(res.ok));
        rec.insert("failures".into(), crate::api::js_num_value(failures));
        rec.insert("reason".into(), Value::from(res.reason.clone()));
        rec.insert("key".into(), key.map_or(Value::Null, Value::from));
        if let Some(k) = kind_s {
            rec.insert("kind".into(), Value::from(k));
        }
        if net_failures != 0.0 {
            rec.insert("netFailures".into(), crate::api::js_num_value(net_failures));
        }
        if let Err(e) = self.set_record(match_id, &Value::Object(rec)) {
            self.log_error(&format!("[doublage] journalisation impossible : {e}"));
        }
        self.end_log(log_id, res.ok, &res.reason);
        if res.ok {
            self.log(&format!(
                "[doublage] match {match_id} terminé : {}",
                res.reason
            ));
        } else {
            self.log_error(&format!("[doublage] match {match_id} : {}", res.reason));
        }
        // Demande explicite : tant que la traduction peut publier d'autres tronçons, le doublage revient en file.
        if res.ok && job.explicit() && self.translation_pending(match_id) {
            let requeued = {
                let mut st = self.st();
                if st.queue.iter().any(|j| j.match_id == match_id) {
                    false
                } else {
                    st.queue.push(job.copy(false));
                    true
                }
            };
            if requeued {
                self.log(&format!(
                    "[doublage] match {match_id} : la traduction continue, la suite sera doublée ensuite"
                ));
            }
        }
    }

    /// `prioritizeDubOnView` : le match est regardé : son doublage, s'il a
    /// été demandé et attend en file, passe en tête. Regarder un match ne
    /// lance jamais son doublage.
    pub fn prioritize_on_view(&self, match_id: i64) {
        let pos = self.queue_position(match_id);
        if pos.is_none_or(|p| p == 1) || self.running_match_id() == Some(match_id) {
            return;
        }
        if self.disabled_reason_sync().is_some() || !self.has_work(match_id) {
            return;
        }
        self.enqueue(
            match_id,
            DubEnqueueOptions {
                priority: true,
                explicit: false,
            },
        );
    }

    /// `stopDub` : « Arrêter le doublage » : retiré de la file, ou
    /// interrompu s'il tourne ; ce qui est doublé reste jouable.
    pub fn stop(&self, match_id: i64) -> DubStopResult {
        let (running, queued) = {
            let st = self.st();
            (
                st.running
                    .as_ref()
                    .is_some_and(|r| r.job.match_id == match_id && !r.stopped),
                position_in(&st.queue, match_id).is_some(),
            )
        };
        if !running && !queued {
            return DubStopResult {
                stopped: false,
                message: "Aucun doublage en cours pour ce match".into(),
            };
        }
        self.st().queue.retain(|j| j.match_id != match_id);
        let key = self.current_track(match_id).map(|t| commentary_key(&t));
        let mut rec = Map::new();
        rec.insert("at".into(), Value::from(self.now_iso()));
        rec.insert("ok".into(), Value::Bool(true));
        rec.insert("failures".into(), Value::from(0));
        rec.insert("reason".into(), Value::from("doublage arrêté"));
        rec.insert("key".into(), key.map_or(Value::Null, Value::from));
        rec.insert("stopped".into(), Value::Bool(true));
        if let Err(e) = self.set_record(match_id, &Value::Object(rec)) {
            self.log_error(&format!("[doublage] journalisation impossible : {e}"));
        }
        self.log(&format!("[doublage] match {match_id} : arrêt demandé"));
        if running {
            let mut st = self.st();
            if let Some(r) = st
                .running
                .as_mut()
                .filter(|r| r.job.match_id == match_id && !r.stopped)
            {
                r.stopped = true;
                r.signal.abort();
            }
        }
        self.pump();
        DubStopResult {
            stopped: true,
            message: "Doublage arrêté. Les passages déjà doublés restent disponibles.".into(),
        }
    }

    /// `dubComplete` : doublage complet et à jour.
    fn complete(&self, match_id: i64) -> bool {
        let (Some(t), Some(d)) = (self.current_track(match_id), self.dub_track(match_id)) else {
            return false;
        };
        d.commentary_key == commentary_key(&t) && d.complete == 1
    }

    /// `requestDub` : demande EXPLICITE depuis la fiche (« Doubler ce
    /// match » ; avec `reset`, « Relancer le doublage » : le doublage
    /// existant est effacé puis refait). Sous-titres incomplets : la
    /// traduction est d'abord mise en file, explicite elle aussi.
    pub fn request(&self, match_id: i64, reset: bool) -> DubRequestResult {
        if let Some(d) = self.disabled_reason_sync() {
            return DubRequestResult::new(false, false, format!("Doublage inactif : {d}"));
        }
        if let Some(Value::Object(mut raw)) = self.record_raw(match_id) {
            if crate::js::truthy(raw.get("stopped")) {
                // Repris après un arrêt : les mises en file automatiques redeviennent permises.
                raw.shift_remove("stopped");
                raw.insert("at".into(), Value::from(self.now_iso()));
                raw.insert("reason".into(), Value::from("doublage repris"));
                if let Err(e) = self.set_record(match_id, &Value::Object(raw)) {
                    self.log_error(&format!("[doublage] journalisation impossible : {e}"));
                }
            }
        }
        if reset {
            if self.running_match_id() == Some(match_id) {
                return DubRequestResult::new(
                    false,
                    true,
                    "Doublage en cours : relance possible une fois terminé",
                );
            }
            let _ = self.db().with(|c| ddb::delete_dub(c, match_id));
            let _ = std::fs::remove_dir_all(dub_dir(match_id));
            // Échecs passés oubliés : la relance repart de zéro.
            if self.record_raw(match_id).is_some() {
                let v = json!({ "at": self.now_iso(), "ok": true, "failures": 0, "reason": "doublage relancé", "key": null });
                if let Err(e) = self.set_record(match_id, &v) {
                    self.log_error(&format!("[doublage] journalisation impossible : {e}"));
                }
            }
            self.log(&format!(
                "[doublage] match {match_id} : doublage effacé, relancé par un administrateur"
            ));
        } else if self.complete(match_id) {
            return DubRequestResult::new(false, false, "Ce match est déjà doublé");
        }
        let mut translation = None;
        if !self.0.commentary.ready(match_id) {
            let c = self.0.commentary.enqueue(
                match_id,
                EnqueueOptions {
                    priority: true,
                    explicit: true,
                    force: false,
                },
            );
            translation = Some(c.message.clone());
            if !c.queued && !c.started && !self.has_work(match_id) {
                return DubRequestResult {
                    translation,
                    ..DubRequestResult::new(false, false, c.message)
                };
            }
        }
        let r = self.enqueue(
            match_id,
            DubEnqueueOptions {
                priority: true,
                explicit: true,
            },
        );
        let message = if r.queued && !r.started && translation.is_some() {
            "Doublage demandé : la traduction des commentaires passe d’abord".to_string()
        } else {
            r.message.clone()
        };
        DubRequestResult {
            message,
            translation,
            ..r
        }
    }

    // ------------------------------------------------------------ activité et manifeste

    /// `dubActivity` (panneau « En cours de traitement »).
    pub fn activity(&self) -> DubActivity {
        let (running, queued) = {
            let st = self.st();
            (
                st.running.as_ref().filter(|r| !r.stopped).map(|r| {
                    (
                        r.job.match_id,
                        r.progress.as_ref().map_or(0.0, |p| p.done),
                        r.progress.as_ref().map_or(0.0, |p| p.total),
                    )
                }),
                st.queue.iter().map(|j| j.match_id).collect::<Vec<_>>(),
            )
        };
        let waiting_for_gpu = running.is_none() && !queued.is_empty() && self.gpu_blocks();
        DubActivity {
            running: running.map(|(match_id, done, total)| DubRunningActivity {
                match_id,
                done,
                total,
                watched: self.0.commentary.viewer_active(match_id),
            }),
            queued,
            waiting_for_gpu,
        }
    }

    /// `dubManifest` : statut, tronçons prêts (URL de l'audio), voix utilisées.
    pub fn manifest(&self, match_id: i64) -> DubManifest {
        if let Some(d) = self.disabled_reason_sync() {
            let mut m = DubManifest::new("disabled", Vec::new(), Vec::new());
            m.reason = Some(d);
            return m;
        }
        let track = self.current_track(match_id);
        let dub = self.dub_track(match_id);
        let valid = match (&track, &dub) {
            (Some(t), Some(d)) => d.commentary_key == commentary_key(t),
            _ => false,
        };
        let chunks: Vec<DubManifestChunk> = if valid {
            self.db()
                .with(|c| ddb::get_dub_chunks(c, match_id))
                .unwrap_or_default()
                .into_iter()
                .map(|c| {
                    let v = crate::time::parse_instant(&c.created_at)
                        .map_or(0, |d| d.timestamp_millis());
                    DubManifestChunk {
                        idx: c.idx,
                        start: c.start_ts,
                        end: c.end_ts,
                        url: format!("/api/matches/{match_id}/dub/{}?v={v}", c.idx),
                        speech: crate::jsval::js_parse(&c.speech).unwrap_or_else(|| json!([])),
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut voices: Vec<(VoiceRole, &'static str)> = Vec::new();
        if let (true, Some(d)) = (valid, &dub) {
            if let Some(Value::Array(list)) = crate::jsval::js_parse(&d.voices) {
                for r in list
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(VoiceRole::parse)
                {
                    if !voices.iter().any(|(x, _)| *x == r) {
                        voices.push((r, r.label()));
                    }
                }
            }
        }
        let download = self.download_step();
        let (running_here, any_running, progress, waiting_job) = {
            let st = self.st();
            let here = st
                .running
                .as_ref()
                .filter(|r| r.job.match_id == match_id && !r.stopped);
            (
                here.is_some(),
                st.running.is_some(),
                here.and_then(|r| r.progress.clone()),
                position_in(&st.queue, match_id).map(|p| (p, st.queue[p - 1].clone())),
            )
        };
        if running_here {
            let mut m = DubManifest::new("running", chunks, voices);
            if let Some(p) = progress
                .as_ref()
                .filter(|p| p.total != 0.0 && !p.total.is_nan())
            {
                m.progress = Some((p.done, p.total));
            }
            m.step = download
                .or_else(|| progress.and_then(|p| p.step))
                .filter(|s| !s.is_empty());
            return m;
        }
        if let Some((position, job)) = waiting_job {
            let holder = if self.uses_gpu() {
                self.gpu_holder(match_id)
            } else {
                None
            };
            let reason = if self.waits_for_subtitles(&job) {
                "traduction des commentaires en cours : le doublage suivra".to_string()
            } else if let Some(h) = holder {
                format!("en attente du GPU : {h} passe d’abord, le doublage reprend ensuite")
            } else if any_running {
                format!("en file (position {position}) : un autre match est en cours de doublage")
            } else {
                format!("en file (position {position})")
            };
            let mut m = DubManifest::new("waiting", chunks, voices);
            m.reason = Some(reason);
            m.step = download;
            return m;
        }
        if valid && dub.as_ref().is_some_and(|d| d.complete == 1) {
            return DubManifest::new("ready", chunks, voices);
        }
        let rec = self.record(match_id);
        if rec.as_ref().is_some_and(|r| r.stopped) {
            let status = if chunks.is_empty() { "none" } else { "partial" };
            let mut m = DubManifest::new(status, chunks, voices);
            m.reason = Some("doublage arrêté".into());
            m.stopped = true;
            return m;
        }
        let Some(track) = track else {
            let mut m = DubManifest::new("none", chunks, voices);
            m.reason = Some("pas encore de sous-titres français".into());
            return m;
        };
        let key = commentary_key(&track);
        let failed = rec
            .filter(|r| !r.ok && r.key.as_deref().is_none_or(|k| k == key))
            .map(|r| r.reason)
            .filter(|r| !r.is_empty());
        if !chunks.is_empty() {
            let mut m = DubManifest::new("partial", chunks, voices);
            m.reason = failed;
            return m;
        }
        if let Some(f) = failed {
            let mut m = DubManifest::new("failed", chunks, voices);
            m.reason = Some(f);
            return m;
        }
        DubManifest::new("none", chunks, voices)
    }
}
