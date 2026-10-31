//! File d'attente des analyses vidéo (synchro automatique de la VF),
//! équivalent de `src/lib/analysis.ts` — portée à l'étape 7, **pas encore
//! branchée** : ni route, ni cron, ni `AppState` ne la construisent ; Node
//! fait toujours tourner sa file.
//!
//! Une analyse = balayage OCR du chrono du bandeau
//! ([`crate::media::video_scan`] avec [`OcrScan`]), puis, si l'OCR n'a pas
//! donné assez d'ancres, analyse de l'énergie audio (coupures). C'est
//! coûteux : les analyses passent par une FILE, traitée une à une
//! (`ANALYSIS_MAX_PARALLEL`, 1 par défaut).
//!
//! Garde-fous : cooldown après un SUCCÈS (`ANALYSIS_MIN_INTERVAL_MS`,
//! 15 min) pour une relance manuelle ; backoff exponentiel après un échec
//! pour la mise en file automatique (1 h, 4 h, 16 h, 24 h ; abandon après 4
//! échecs tant que la vidéo ne change pas ; flux inaccessible : 15 min → 6 h
//! sans abandon), état dans `kv_cache` (`analysis:<id>`) ; durée maximale
//! `ANALYSIS_TIMEOUT_MS` (90 min, temps de pause exclu). Les analyses de fond
//! (cron) attendent pendant qu'une vidéo est regardée et sont abandonnées
//! hors de la fenêtre de nuit.
//!
//! # Service
//!
//! [`Analysis`] porte l'état de la file (un par processus, partagé par
//! `Clone`, dans un runtime Tokio). Il partage la table des spectateurs et
//! l'horloge du service de traduction ([`AnalysisOptions::shared_with`]).
//! Les routes appelleront [`Analysis::status`] et [`Analysis::enqueue`]
//! (voir [`crate::sync_route`]) ; le cron [`Analysis::enqueue_recent`] ; le
//! panneau d'activité et le doublage [`Analysis::activity`].

use crate::analysis_db::{self as adb};
use crate::db::{self, Db, MatchRow};
use crate::ingest_db::{self, NewAnchor};
use crate::js::jsre;
use crate::media::audio::{detect_cuts, CutOptions};
use crate::media::commentary::{
    analysis_sources, backoff_ms, network_backoff_ms, pick_audio_source, BoxFut, Clock, Commentary,
    SourceKind, StreamInfo, MAX_AUTO_FAILURES,
};
use crate::media::ocr::{
    score_timeline, select_consistent_observations, ConsistencyOptions, OcrEngine, ScorePlay,
    ScorePoint,
};
use crate::media::scoreboard::{
    locate_scoreboard, read_scoreboard, LocateOptions, ScoreboardLocation,
};
use crate::media::video_scan::{
    scan_video, FrameObservation, LocateResult, ScanDeps, ScanOptions, ScanPhase, ScoreboardReading,
};
use crate::media::viewers::{viewers, Viewers};
use crate::vf_sync::{find_breaks, to_timed_plays, BreakInfo, ResolvedAnchor, TimedPlay};
use serde_json::{Map, Value};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

// ---------------------------------------------------------------- balayage OCR

/// Dépendances OCR du balayage ([`ScanDeps`]) : moteur, extraction d'image,
/// choix des observations cohérentes (scores du play-by-play compris).
pub struct OcrScan<'a, G> {
    pub engine: &'a dyn OcrEngine,
    /// Image à l'instant `t` (ffmpeg sur la source choisie, pause éventuelle comprise).
    pub grab: G,
    pub tp: &'a [TimedPlay],
    pub breaks: &'a [BreakInfo],
    pub scores: Option<Vec<ScorePoint>>,
}

impl<G, F> ScanDeps for OcrScan<'_, G>
where
    G: Fn(f64) -> F + Send + Sync,
    F: Future<Output = Result<Vec<u8>, String>> + Send,
{
    type Location = ScoreboardLocation;

    fn grab(&self, t: f64) -> impl Future<Output = Result<Vec<u8>, String>> {
        (self.grab)(t)
    }

    async fn read(
        &self,
        image: &[u8],
        location: Option<&ScoreboardLocation>,
    ) -> Result<Option<ScoreboardReading>, String> {
        Ok(read_scoreboard(self.engine, image, location).await)
    }

    async fn locate(
        &self,
        frames: &[Vec<u8>],
        progress: &(dyn Fn(usize, usize) + Send + Sync),
    ) -> Result<LocateResult<ScoreboardLocation>, String> {
        let r = locate_scoreboard(
            self.engine,
            frames,
            &LocateOptions {
                on_progress: Some(progress),
                ..Default::default()
            },
        )
        .await;
        Ok(LocateResult {
            location: r.location,
            readings: r.readings,
        })
    }

    fn consistent(&self, observations: &[FrameObservation]) -> Vec<ResolvedAnchor> {
        select_consistent_observations(
            observations,
            self.tp,
            self.breaks,
            &ConsistencyOptions {
                scores: self.scores.clone(),
                ..Default::default()
            },
        )
    }
}

// ---------------------------------------------------------------- état persistant (kv_cache)

/// Nature d'un échec (`AnalysisFailureKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisFailureKind {
    /// Flux vidéo inaccessible : réessayé vite, sans compter dans l'abandon.
    Reseau,
    /// Chrono illisible.
    Contenu,
    Erreur,
}

impl AnalysisFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AnalysisFailureKind::Reseau => "reseau",
            AnalysisFailureKind::Contenu => "contenu",
            AnalysisFailureKind::Erreur => "erreur",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "reseau" => AnalysisFailureKind::Reseau,
            "contenu" => AnalysisFailureKind::Contenu,
            "erreur" => AnalysisFailureKind::Erreur,
            _ => return None,
        })
    }
}

/// Dernier résultat d'un match (`AnalysisRecord`, `kv_cache` `analysis:<id>`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisRecord {
    pub at: String,
    pub ok: bool,
    /// Échecs consécutifs ; absent du JSON : `None` (`undefined` côté Node).
    pub failures: Option<f64>,
    pub reason: String,
    pub anchors: f64,
    pub ok_id: Option<String>,
    pub kind: Option<AnalysisFailureKind>,
    pub net_failures: Option<f64>,
}

impl AnalysisRecord {
    pub fn from_json(v: &Value) -> Option<AnalysisRecord> {
        let o = v.as_object()?;
        Some(AnalysisRecord {
            at: crate::js::str_or_empty(o.get("at")),
            ok: crate::js::truthy(o.get("ok")),
            failures: o.get("failures").and_then(Value::as_f64),
            reason: crate::js::str_or_empty(o.get("reason")),
            anchors: o.get("anchors").and_then(Value::as_f64).unwrap_or(0.0),
            ok_id: o.get("okId").and_then(Value::as_str).map(String::from),
            kind: o
                .get("kind")
                .and_then(Value::as_str)
                .and_then(AnalysisFailureKind::parse),
            net_failures: o.get("netFailures").and_then(Value::as_f64),
        })
    }

    /// Objet écrit par Node : `{ at, ok, failures, reason, anchors, okId, kind?, netFailures? }`.
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let mut m = Map::new();
        m.insert("at".into(), Value::from(self.at.clone()));
        m.insert("ok".into(), Value::from(self.ok));
        m.insert("failures".into(), n(self.failures.unwrap_or(0.0)));
        m.insert("reason".into(), Value::from(self.reason.clone()));
        m.insert("anchors".into(), n(self.anchors));
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

/// `backoffMs` / `networkBackoffMs` d'un compteur lu en JSON (absent ou non entier : NaN).
fn backoff_of(f: f64, net: bool) -> f64 {
    if f.is_nan() {
        return f64::NAN;
    }
    let n = f.trunc() as i64;
    if net {
        network_backoff_ms(n)
    } else {
        backoff_ms(n)
    }
}

/// `autoRetryAllowed` : une mise en file AUTOMATIQUE est-elle permise maintenant (`now` en ms) ?
pub fn auto_retry_allowed(rec: Option<&AnalysisRecord>, ok_id: Option<&str>, now: f64) -> bool {
    let Some(rec) = rec else { return true };
    if rec.ok {
        return false; // déjà réussie : seule une demande explicite relance
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
    // Flux inaccessible : problème réseau passager, on réessaie vite.
    if rec.kind == Some(AnalysisFailureKind::Reseau) {
        return now - at >= backoff_of(rec.net_failures.unwrap_or(1.0), true);
    }
    let failures = rec.failures.unwrap_or(f64::NAN);
    if failures >= MAX_AUTO_FAILURES as f64 {
        return false;
    }
    now - at >= backoff_of(failures, false)
}

// ---------------------------------------------------------------- contrat de l'API

/// Avancement d'une analyse (`AnalysisProgress`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisProgress {
    pub phase: String,
    pub done: f64,
    pub total: f64,
}

impl AnalysisProgress {
    pub fn new(phase: &str, done: f64, total: f64) -> Self {
        AnalysisProgress {
            phase: phase.into(),
            done,
            total,
        }
    }

    fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let mut m = Map::new();
        m.insert("phase".into(), Value::from(self.phase.clone()));
        m.insert("done".into(), n(self.done));
        m.insert("total".into(), n(self.total));
        Value::Object(m)
    }
}

/// Statut d'analyse d'un match (`AnalysisStatus`, contrat de `GET /api/matches/[id]/sync`).
#[derive(Debug, Clone, PartialEq)]
pub enum AnalysisStatus {
    Running(AnalysisProgress),
    /// Rang dans la file (1 = prochaine analyse).
    Queued(usize),
    Done {
        anchors_auto: usize,
        reason: Option<String>,
    },
    Unavailable(String),
    Failed(String),
    Estimated,
    None,
}

impl AnalysisStatus {
    pub fn name(&self) -> &'static str {
        match self {
            AnalysisStatus::Running(_) => "running",
            AnalysisStatus::Queued(_) => "queued",
            AnalysisStatus::Done { .. } => "done",
            AnalysisStatus::Unavailable(_) => "unavailable",
            AnalysisStatus::Failed(_) => "failed",
            AnalysisStatus::Estimated => "estimated",
            AnalysisStatus::None => "none",
        }
    }

    /// Objet de Node (ordre des clés compris).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("status".into(), Value::from(self.name()));
        match self {
            AnalysisStatus::Running(p) => {
                m.insert("progress".into(), p.to_json());
            }
            AnalysisStatus::Queued(p) => {
                m.insert("position".into(), Value::from(*p));
            }
            AnalysisStatus::Done {
                anchors_auto,
                reason,
            } => {
                m.insert("anchors_auto".into(), Value::from(*anchors_auto));
                if let Some(r) = reason {
                    m.insert("reason".into(), Value::from(r.clone()));
                }
            }
            AnalysisStatus::Unavailable(r) | AnalysisStatus::Failed(r) => {
                m.insert("reason".into(), Value::from(r.clone()));
                m.insert("anchors_auto".into(), Value::from(0));
            }
            AnalysisStatus::Estimated => {
                m.insert(
                    "reason".into(),
                    Value::from("calage approximatif (coupures audio), chrono non lu"),
                );
                m.insert("anchors_auto".into(), Value::from(0));
            }
            AnalysisStatus::None => {
                m.insert("anchors_auto".into(), Value::from(0));
            }
        }
        Value::Object(m)
    }
}

/// Analyse en file (`Job`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnalysisJob {
    pub match_id: i64,
    pub with_audio: bool,
    pub manual: bool,
    /// Mise en file par le job de nuit : abandonnée hors de la fenêtre, en pause pendant une lecture.
    pub background: bool,
}

/// Résultat d'une analyse (`AnalysisOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisOutcome {
    pub ok: bool,
    pub anchors: f64,
    pub reason: String,
    pub kind: Option<AnalysisFailureKind>,
}

impl AnalysisOutcome {
    pub fn ok(anchors: f64, reason: impl Into<String>) -> Self {
        AnalysisOutcome {
            ok: true,
            anchors,
            reason: reason.into(),
            kind: None,
        }
    }

    pub fn failed(
        kind: Option<AnalysisFailureKind>,
        anchors: f64,
        reason: impl Into<String>,
    ) -> Self {
        AnalysisOutcome {
            ok: false,
            anchors,
            reason: reason.into(),
            kind,
        }
    }
}

/// Rappel d'avancement.
pub type ProgressFn = Arc<dyn Fn(AnalysisProgress) + Send + Sync>;

/// Crochets d'exécution (`AnalysisHooks`) : `gate` est attendu avant chaque
/// image (pause d'une analyse de fond pendant une lecture).
#[derive(Clone)]
pub struct AnalysisHooks {
    pub gate: Arc<dyn Fn() -> BoxFut<()> + Send + Sync>,
}

/// Exécuteur d'une analyse (`AnalysisRunner`) ; `Err` : exception (message).
pub type Runner = Arc<
    dyn Fn(AnalysisJob, ProgressFn, AnalysisHooks) -> BoxFut<Result<AnalysisOutcome, String>>
        + Send
        + Sync,
>;

/// Options d'une mise en file (`enqueueAnalysis`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnqueueOptions {
    /// En tête de file (demande explicite) ; un match déjà en file est remonté.
    pub priority: bool,
    pub with_audio: bool,
    /// Demande manuelle : soumise au cooldown après un succès.
    pub manual: bool,
    pub background: bool,
}

/// Résultat d'une mise en file (`EnqueueResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueResult {
    pub queued: bool,
    pub started: bool,
    pub position: Option<usize>,
    pub reason: Option<String>,
    pub message: String,
}

impl EnqueueResult {
    fn refused(reason: &str, message: String) -> Self {
        EnqueueResult {
            queued: false,
            started: false,
            position: None,
            reason: Some(reason.into()),
            message,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("queued".into(), Value::from(self.queued));
        m.insert("started".into(), Value::from(self.started));
        if let Some(p) = self.position {
            m.insert("position".into(), Value::from(p));
        }
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::from(r.clone()));
        }
        m.insert("message".into(), Value::from(self.message.clone()));
        Value::Object(m)
    }
}

/// Analyse en cours vue par le panneau d'activité.
#[derive(Debug, Clone, PartialEq)]
pub struct RunningAnalysis {
    pub match_id: i64,
    pub phase: String,
    pub done: f64,
    pub total: f64,
}

/// Activité de la file (`analysisActivity`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AnalysisActivity {
    pub running: Vec<RunningAnalysis>,
    pub queued: Vec<i64>,
}

/// Phase d'une analyse de fond qui attend la fin d'une lecture (le doublage
/// ne la compte pas comme une occupation du GPU).
pub const PAUSED_PHASE: &str = "en pause pendant la lecture";

impl AnalysisActivity {
    /// Objet de Node (`{ running: [{ matchId, phase, done, total }], queued }`).
    pub fn to_json(&self) -> Value {
        use crate::api::js_num_value as n;
        let running = self
            .running
            .iter()
            .map(|r| {
                let mut m = Map::new();
                m.insert("matchId".into(), Value::from(r.match_id));
                m.insert("phase".into(), Value::from(r.phase.clone()));
                m.insert("done".into(), n(r.done));
                m.insert("total".into(), n(r.total));
                Value::Object(m)
            })
            .collect();
        let mut m = Map::new();
        m.insert("running".into(), Value::Array(running));
        m.insert("queued".into(), Value::from(self.queued.clone()));
        Value::Object(m)
    }
}

// ---------------------------------------------------------------- dépendances

/// `resolveOkStream(okId, { force })`.
pub type ResolveStreamFn =
    Arc<dyn Fn(String, bool) -> BoxFut<Result<StreamInfo, String>> + Send + Sync>;
/// `grabFrame(url, t, headers, timeoutMs)` (en-têtes ok.ru) : image PNG.
pub type GrabFn =
    Arc<dyn Fn(String, f64, Option<Duration>) -> BoxFut<Result<Vec<u8>, String>> + Send + Sync>;
/// `createOcrWorker` : un moteur par balayage.
pub type OcrFactory = Arc<dyn Fn() -> Result<Arc<dyn OcrEngine>, String> + Send + Sync>;
/// `analyzeHlsAudio(url, headers)` : profil dBFS (1 valeur / s).
pub type AudioFn = Arc<dyn Fn(String) -> BoxFut<Result<Vec<f64>, String>> + Send + Sync>;
/// `ingestMatchDetails` (stats et play-by-play, puis VF).
pub type IngestFn = Arc<dyn Fn(MatchRow) -> BoxFut<Result<(), String>> + Send + Sync>;

/// Dépendances d'une analyse (réseau, ffmpeg, OCR), injectables pour les tests.
#[derive(Clone)]
pub struct AnalysisDeps {
    pub resolve_stream: ResolveStreamFn,
    pub grab: GrabFn,
    pub ocr: OcrFactory,
    pub analyze_audio: AudioFn,
    pub ingest_details: IngestFn,
}

impl AnalysisDeps {
    /// Dépendances de production : flux résolus par le proxy vidéo, ffmpeg,
    /// Tesseract natif (fonction `ocr`), ESPN.
    pub fn defaults(db: Db, video: crate::video::Video) -> AnalysisDeps {
        use crate::http::BROWSER_UA;
        use crate::okru::OK_REFERER;
        AnalysisDeps {
            resolve_stream: Arc::new(move |ok_id, force| {
                let v = video.clone();
                Box::pin(async move {
                    v.resolve_ok_stream(&ok_id, force)
                        .await
                        .map(|s| StreamInfo::from(&*s))
                        .map_err(|e| e.msg)
                })
            }),
            grab: Arc::new(|url, t, timeout| {
                Box::pin(async move {
                    crate::media::ocr::grab_frame(&url, t, BROWSER_UA, OK_REFERER, timeout).await
                })
            }),
            ocr: Arc::new(crate::media::ocr::create_ocr_engine),
            analyze_audio: Arc::new(|url| {
                Box::pin(async move {
                    crate::media::audio::analyze_hls_audio(&url, BROWSER_UA, OK_REFERER, None, None)
                        .await
                })
            }),
            ingest_details: Arc::new(move |m| {
                let db = db.clone();
                Box::pin(async move {
                    crate::ingest::ingest_match_details(&db, &m)
                        .await
                        .map(|_| ())
                })
            }),
        }
    }
}

/// Réglages du service (injectables pour les tests).
#[derive(Clone)]
pub struct AnalysisOptions {
    /// Table des spectateurs (celle du service de traduction).
    pub viewers: &'static Viewers,
    /// Horloge (ms) des enregistrements, du cooldown et de la fenêtre de nuit.
    pub clock: Clock,
    /// `ffmpegAvailable`.
    pub ffmpeg_available: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        AnalysisOptions {
            viewers: viewers(),
            clock: Arc::new(crate::media::viewers::now_ms),
            ffmpeg_available: Arc::new(crate::media::audio::ffmpeg_available),
        }
    }
}

impl AnalysisOptions {
    /// Spectateurs et horloge du service de traduction (Node : un seul
    /// `viewers.ts` et un seul `Date.now()` pour les deux files).
    pub fn shared_with(commentary: &Commentary) -> Self {
        let c = commentary.clone();
        AnalysisOptions {
            viewers: commentary.viewers(),
            clock: Arc::new(move || c.now()),
            ffmpeg_available: Arc::new(crate::media::audio::ffmpeg_available),
        }
    }
}

// ---------------------------------------------------------------- file

struct RunState {
    id: u64,
    progress: AnalysisProgress,
    #[allow(dead_code)]
    started_at: String,
}

#[derive(Default)]
struct QueueState {
    queue: Vec<AnalysisJob>,
    /// Analyses en cours, dans l'ordre de démarrage (`Map` de Node).
    running: Vec<(i64, RunState)>,
    /// Fin du dernier SUCCÈS, par match (cooldown des relances manuelles).
    last_success: Vec<(i64, f64)>,
    next_id: u64,
}

impl QueueState {
    fn run(&self, id: i64) -> Option<&RunState> {
        self.running.iter().find(|(m, _)| *m == id).map(|(_, r)| r)
    }
}

pub(crate) struct Inner {
    db: Db,
    opts: AnalysisOptions,
    deps: AnalysisDeps,
    state: Mutex<QueueState>,
    runner: Mutex<Option<Runner>>,
    repump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    idle: Notify,
}

/// Service d'analyse vidéo (file, statuts, analyses).
#[derive(Clone)]
pub struct Analysis(Arc<Inner>);

/// `ANALYSIS_MAX_PARALLEL` (1 par défaut, au moins 1 ; non numérique : 1).
fn max_parallel() -> usize {
    let n = std::env::var("ANALYSIS_MAX_PARALLEL")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    let v = if n.is_nan() || n == 0.0 { 1.0 } else { n };
    crate::js::max(1.0, v.trunc()) as usize
}

/// `ANALYSIS_MIN_INTERVAL_MS` (15 min ; `0` désactive le cooldown).
fn min_interval_ms() -> f64 {
    match std::env::var("ANALYSIS_MIN_INTERVAL_MS") {
        Ok(raw) if !raw.is_empty() && crate::api::js_number(&raw).is_finite() => {
            crate::js::max(0.0, crate::api::js_number(&raw).trunc())
        }
        _ => 15.0 * 60_000.0,
    }
}

/// `ANALYSIS_TIMEOUT_MS` (90 min : l'audio seul peut prendre 45 min).
fn analysis_timeout_ms() -> f64 {
    let n = std::env::var("ANALYSIS_TIMEOUT_MS")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    if n.is_finite() && n > 0.0 {
        n
    } else {
        90.0 * 60_000.0
    }
}

fn ok_id_of(m: &MatchRow) -> Option<&str> {
    m.video_ok_id.as_deref().filter(|s| !s.is_empty())
}

/// Libellés des phases du balayage (`PHASE_LABEL`).
fn phase_label(p: ScanPhase) -> &'static str {
    match p {
        ScanPhase::Localisation => "localisation du bandeau",
        ScanPhase::Balayage => "lecture du chrono",
        ScanPhase::Affinage => "affinage",
    }
}

/// `err.message.replace(/\s+/g, ' ').slice(0, 160)`.
fn short_error(e: &str) -> String {
    let s = jsre!(r"\s+").replace_all(e, " ");
    crate::js::slice_utf16(&s, 160)
}

/// `networkOutcome` : flux vidéo inaccessible (aucune image extraite par ffmpeg).
fn network_outcome(detail: &str, net_failures: f64) -> AnalysisOutcome {
    let wait = crate::js::round(backoff_of(net_failures + 1.0, true) / 60_000.0);
    AnalysisOutcome::failed(
        Some(AnalysisFailureKind::Reseau),
        0.0,
        format!(
            "Flux vidéo inaccessible : aucune image n'a pu être extraite ({detail}). Problème réseau, pas de contenu : nouvel essai automatique dans ~{} min.",
            crate::jsval::js_number_string(wait)
        ),
    )
}

/// `new Date(wall * 1000).toISOString()` (instant invalide : l'exception de Node).
fn wall_iso(wall: f64) -> Result<String, String> {
    let ms = (wall * 1000.0).trunc();
    if !ms.is_finite() {
        return Err("Invalid time value".into());
    }
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(crate::time::iso_utc)
        .ok_or_else(|| "Invalid time value".into())
}

impl Analysis {
    /// Service de production : dépendances par défaut (proxy vidéo `video`,
    /// ffmpeg, Tesseract), spectateurs et horloge donnés — ceux du service
    /// de traduction (`AnalysisOptions::shared_with`).
    pub fn new(
        db: Db,
        video: crate::video::Video,
        viewers: &'static Viewers,
        clock: Clock,
    ) -> Analysis {
        let deps = AnalysisDeps::defaults(db.clone(), video);
        Analysis::with_options(
            db,
            deps,
            AnalysisOptions {
                viewers,
                clock,
                ffmpeg_available: Arc::new(crate::media::audio::ffmpeg_available),
            },
        )
    }

    /// Service aux dépendances et réglages choisis (tests).
    pub fn with_options(db: Db, deps: AnalysisDeps, opts: AnalysisOptions) -> Analysis {
        Analysis(Arc::new(Inner {
            db,
            opts,
            deps,
            state: Mutex::new(QueueState::default()),
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

    pub fn db(&self) -> &Db {
        &self.0.db
    }

    /// Instant courant (horloge du service, ms).
    pub fn now(&self) -> f64 {
        (self.0.opts.clock)()
    }

    fn now_iso(&self) -> String {
        chrono::DateTime::from_timestamp_millis(self.now() as i64)
            .map(crate::time::iso_utc)
            .unwrap_or_default()
    }

    /// `someoneWatching()` : une vidéo est-elle regardée (n'importe quel match) ?
    pub fn someone_watching(&self) -> bool {
        self.0.opts.viewers.someone_watching_at(None, self.now())
    }

    /// `inNightWindow` (réglage « Traduction automatique » compris), à l'heure du service.
    pub fn in_night_window(&self) -> bool {
        let settings = self
            .0
            .db
            .with(crate::settings::Settings::load)
            .unwrap_or_else(|_| crate::settings::Settings::unreadable());
        let now = chrono::DateTime::from_timestamp_millis(self.now() as i64).unwrap_or_default();
        crate::media::night_window::in_night_window(&settings, now)
    }

    fn get_match(&self, id: i64) -> Option<MatchRow> {
        self.0.db.with(|c| db::get_match(c, id)).ok().flatten()
    }

    /// `getAnalysisRecord` (base illisible : aucun).
    pub fn record(&self, match_id: i64) -> Option<AnalysisRecord> {
        self.0
            .db
            .with(|c| db::kv_get(c, &format!("analysis:{match_id}"), None))
            .ok()
            .flatten()
            .and_then(|v| AnalysisRecord::from_json(&v))
    }

    /// `unavailableReason` : le match peut-il être analysé (replay + ffmpeg) ?
    fn unavailable_reason(&self, id: i64) -> Option<&'static str> {
        let Some(m) = self.get_match(id) else {
            return Some("match introuvable");
        };
        if ok_id_of(&m).is_none() || !m.video_available {
            return Some("pas de replay disponible");
        }
        if !(self.0.opts.ffmpeg_available)() {
            return Some("ffmpeg absent du serveur");
        }
        None
    }

    /// `queuePosition` : rang dans la file (1 = prochaine analyse).
    pub fn queue_position(&self, match_id: i64) -> Option<usize> {
        self.st()
            .queue
            .iter()
            .position(|j| j.match_id == match_id)
            .map(|i| i + 1)
    }

    fn is_running(&self, match_id: i64) -> bool {
        self.st().run(match_id).is_some()
    }

    /// Remplace l'exécuteur (`__setAnalysisRunnerForTests`) et vide la file ;
    /// `None` : l'analyse réelle avec les dépendances du service.
    pub fn set_runner(&self, runner: Option<Runner>) {
        *self.0.runner.lock().unwrap_or_else(|e| e.into_inner()) = runner;
        {
            let mut st = self.st();
            st.queue.clear();
            st.running.clear();
            st.last_success.clear();
        }
        self.0.idle.notify_waiters();
    }

    /// `__analysisIdle` : attend que la file soit vide.
    pub async fn idle(&self) {
        loop {
            let n = self.0.idle.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            {
                let st = self.st();
                if st.running.is_empty() && st.queue.is_empty() {
                    return;
                }
            }
            n.await;
        }
    }

    /// `enqueueAnalysis` : met un match en file ; `priority` le place en tête
    /// (demande explicite), un match déjà en file est alors remonté.
    pub fn enqueue(&self, match_id: i64, opts: EnqueueOptions) -> EnqueueResult {
        if let Some(r) = self.unavailable_reason(match_id) {
            return EnqueueResult::refused(r, format!("Analyse impossible : {r}"));
        }
        if self.is_running(match_id) {
            return EnqueueResult::refused("déjà en cours", "Analyse déjà en cours".into());
        }
        if opts.manual {
            let last = self
                .st()
                .last_success
                .iter()
                .find(|(m, _)| *m == match_id)
                .map_or(0.0, |(_, t)| *t);
            let since = self.now() - last;
            let min = min_interval_ms();
            if last != 0.0 && since < min {
                let wait = ((min - since) / 60_000.0).ceil();
                return EnqueueResult::refused(
                    "analyse récente",
                    format!(
                        "Analyse récente, réessayez dans ~{} min",
                        crate::jsval::js_number_string(wait)
                    ),
                );
            }
        }
        let existed = {
            let mut st = self.st();
            // Revérifié sous le verrou (Node n'a qu'un fil : contrôle et insertion d'un seul tenant).
            if st.run(match_id).is_some() {
                return EnqueueResult::refused("déjà en cours", "Analyse déjà en cours".into());
            }
            let existing = st.queue.iter().position(|j| j.match_id == match_id);
            let mut job = AnalysisJob {
                match_id,
                with_audio: opts.with_audio,
                manual: opts.manual,
                background: opts.background && !opts.priority,
            };
            match existing {
                Some(i) => {
                    let prev = st.queue[i];
                    job.with_audio |= prev.with_audio;
                    job.manual |= prev.manual;
                    job.background = job.background && prev.background;
                    if opts.priority {
                        st.queue.remove(i);
                        st.queue.insert(0, job);
                    } else {
                        st.queue[i] = job;
                    }
                }
                None if opts.priority => st.queue.insert(0, job),
                None => st.queue.push(job),
            }
            existing.is_some()
        };
        self.pump();
        if self.is_running(match_id) {
            return EnqueueResult {
                queued: true,
                started: true,
                position: None,
                reason: None,
                message: "Analyse lancée".into(),
            };
        }
        let position = self.queue_position(match_id);
        let pos_text = position.map_or("undefined".to_string(), |p| p.to_string());
        EnqueueResult {
            queued: true,
            started: false,
            position,
            reason: None,
            message: if existed && !opts.priority {
                format!("Analyse déjà en file (position {pos_text})")
            } else {
                format!("Analyse en file (position {pos_text})")
            },
        }
    }

    fn schedule_repump(&self) {
        let weak = self.weak();
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let h = rt.spawn(async move {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if let Some(inner) = weak.upgrade() {
                Analysis(inner).pump();
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

    /// `pump` : démarre les analyses en attente tant que la limite de parallélisme le permet.
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
        let to_start = {
            let mut st = self.st();
            let mut to_start = Vec::new();
            while st.running.len() < max_parallel() && !st.queue.is_empty() {
                // Analyse de fond hors de la fenêtre autorisée : abandonnée.
                if st.queue.iter().any(|j| j.background) && !self.in_night_window() {
                    st.queue.retain(|j| !j.background);
                }
                // Pendant une lecture, les analyses de fond attendent en file.
                let watching = st.queue.iter().any(|j| j.background) && self.someone_watching();
                let Some(i) = st.queue.iter().position(|j| !(j.background && watching)) else {
                    if !st.queue.is_empty() {
                        self.schedule_repump();
                    }
                    break;
                };
                let job = st.queue.remove(i);
                if st.run(job.match_id).is_some() || self.unavailable_reason(job.match_id).is_some()
                {
                    continue;
                }
                st.next_id += 1;
                let id = st.next_id;
                st.running.push((
                    job.match_id,
                    RunState {
                        id,
                        progress: AnalysisProgress::new("préparation", 0.0, 0.0),
                        started_at: self.now_iso(),
                    },
                ));
                to_start.push((id, job));
            }
            to_start
        };
        for (id, job) in to_start {
            self.start(id, job);
        }
        let idle = {
            let st = self.st();
            st.running.is_empty() && st.queue.is_empty()
        };
        if idle {
            self.0.idle.notify_waiters();
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
        let w = self.weak();
        Arc::new(move |job, progress, hooks| {
            let w = w.clone();
            Box::pin(async move {
                let Some(inner) = w.upgrade() else {
                    return Err("service arrêté".into());
                };
                let a = Analysis(inner);
                let deps = a.0.deps.clone();
                a.run_analysis(job, progress, hooks, &deps).await
            })
        })
    }

    /// `start` : lance une analyse (déjà inscrite comme en cours).
    fn start(&self, id: u64, job: AnalysisJob) {
        let match_id = job.match_id;
        let runner = self.runner();
        let ok_id = self.get_match(match_id).and_then(|m| m.video_ok_id);
        let log_id = self
            .0
            .db
            .with(|c| ingest_db::log_ingest_start(c, &format!("analyse-{match_id}")))
            .ok();
        let paused_ms = Arc::new(AtomicU64::new(0));
        let w = self.weak();
        let progress: ProgressFn = Arc::new(move |p: AnalysisProgress| {
            if let Some(inner) = w.upgrade() {
                let a = Analysis(inner);
                let mut st = a.st();
                if let Some((_, r)) = st.running.iter_mut().find(|(_, r)| r.id == id) {
                    r.progress = p;
                }
            }
        });
        let w = self.weak();
        let paused = paused_ms.clone();
        let gate: Arc<dyn Fn() -> BoxFut<()> + Send + Sync> = Arc::new(move || {
            let (w, paused) = (w.clone(), paused.clone());
            Box::pin(async move {
                let Some(a) = w.upgrade().map(Analysis) else {
                    return;
                };
                if !job.background || !a.someone_watching() {
                    return;
                }
                let saved = a.set_phase(id, None);
                let p0 = Instant::now();
                while a.someone_watching() {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                paused.fetch_add(p0.elapsed().as_millis() as u64, Ordering::SeqCst);
                a.set_phase(id, saved);
            })
        });
        // Le travail tourne à part : comme sous Node, le garde-fou fait
        // échouer l'analyse et libère la file, sans arrêter le travail.
        let work = runner(job, progress, AnalysisHooks { gate });
        let this = self.clone();
        tokio::spawn(async move {
            let mut handle = tokio::spawn(work);
            let timeout = analysis_timeout_ms();
            let t0 = Instant::now();
            let period = Duration::from_millis(crate::js::min(30_000.0, timeout) as u64);
            let watchdog = async {
                let mut tick =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                loop {
                    tick.tick().await;
                    let elapsed =
                        t0.elapsed().as_millis() as f64 - paused_ms.load(Ordering::SeqCst) as f64;
                    if elapsed > analysis_timeout_ms() {
                        return format!(
                            "délai dépassé ({} min)",
                            crate::jsval::js_number_string(crate::js::max(
                                1.0,
                                crate::js::round(analysis_timeout_ms() / 60_000.0)
                            ))
                        );
                    }
                }
            };
            let res = tokio::select! {
                r = &mut handle => r.unwrap_or_else(|e| Err(e.to_string())),
                e = watchdog => Err(e),
            };
            let res = res.unwrap_or_else(|e| {
                AnalysisOutcome::failed(
                    Some(AnalysisFailureKind::Erreur),
                    0.0,
                    format!(
                        "Analyse impossible : {}",
                        if e.is_empty() { "Error" } else { &e }
                    ),
                )
            });
            this.finish(match_id, ok_id, log_id, &res);
            {
                let mut st = this.st();
                st.running.retain(|(_, r)| r.id != id);
            }
            this.pump();
        });
    }

    /// Pause d'une analyse de fond : phase « en pause » (rend l'avancement
    /// sauvé) ; `Some(saved)` le remet.
    fn set_phase(&self, id: u64, saved: Option<AnalysisProgress>) -> Option<AnalysisProgress> {
        let mut st = self.st();
        let (_, r) = st.running.iter_mut().find(|(_, r)| r.id == id)?;
        let before = r.progress.clone();
        match saved {
            Some(s) => r.progress = s,
            None => r.progress.phase = PAUSED_PHASE.into(),
        }
        Some(before)
    }

    /// Fin d'une analyse : enregistrement (backoff), journal, cooldown.
    fn finish(
        &self,
        match_id: i64,
        ok_id: Option<String>,
        log_id: Option<i64>,
        res: &AnalysisOutcome,
    ) {
        let prev = self.record(match_id);
        let same_video = prev
            .as_ref()
            .and_then(|p| p.ok_id.as_deref())
            .filter(|s| !s.is_empty())
            .is_none_or(|p| Some(p) == ok_id.as_deref());
        let kind = if res.ok {
            None
        } else {
            Some(res.kind.unwrap_or(AnalysisFailureKind::Contenu))
        };
        let reseau = kind == Some(AnalysisFailureKind::Reseau);
        // Un échec réseau ne compte pas dans l'abandon.
        let failures = if res.ok {
            0.0
        } else {
            (if same_video {
                prev.as_ref().and_then(|p| p.failures).unwrap_or(0.0)
            } else {
                0.0
            }) + if reseau { 0.0 } else { 1.0 }
        };
        let net_failures = if reseau {
            (if same_video
                && prev.as_ref().and_then(|p| p.kind) == Some(AnalysisFailureKind::Reseau)
            {
                prev.as_ref().and_then(|p| p.net_failures).unwrap_or(0.0)
            } else {
                0.0
            }) + 1.0
        } else {
            0.0
        };
        let rec = AnalysisRecord {
            at: self.now_iso(),
            ok: res.ok,
            failures: Some(failures),
            reason: res.reason.clone(),
            anchors: res.anchors,
            ok_id,
            kind,
            net_failures: (net_failures != 0.0).then_some(net_failures),
        };
        let logged = self.0.db.with(|c| {
            db::kv_set(c, &format!("analysis:{match_id}"), &rec.to_json())?;
            match log_id {
                Some(l) => ingest_db::log_ingest_end(c, l, res.ok, &res.reason),
                None => Ok(()),
            }
        });
        if let Err(e) = logged {
            eprintln!("[analyse] journalisation impossible : {e}");
        }
        // Le cooldown n'est consommé qu'en cas de SUCCÈS, et compté depuis la FIN.
        if res.ok {
            let now = self.now();
            let mut st = self.st();
            st.last_success.retain(|(m, _)| *m != match_id);
            st.last_success.push((match_id, now));
        } else {
            eprintln!("[analyse] match {match_id} : {}", res.reason);
        }
    }

    /// `analysisActivity` : panneau « En cours de traitement » (et occupation
    /// du GPU vue par le doublage, qui ignore les analyses [`PAUSED_PHASE`]).
    pub fn activity(&self) -> AnalysisActivity {
        let st = self.st();
        AnalysisActivity {
            running: st
                .running
                .iter()
                .map(|(m, r)| RunningAnalysis {
                    match_id: *m,
                    phase: r.progress.phase.clone(),
                    done: r.progress.done,
                    total: r.progress.total,
                })
                .collect(),
            queued: st.queue.iter().map(|j| j.match_id).collect(),
        }
    }

    /// `analysisStatus` : statut d'analyse d'un match.
    pub fn status(&self, match_id: i64) -> AnalysisStatus {
        if let Some(r) = self.st().run(match_id) {
            return AnalysisStatus::Running(r.progress.clone());
        }
        if let Some(p) = self.queue_position(match_id) {
            return AnalysisStatus::Queued(p);
        }
        let anchors = self
            .0
            .db
            .with(|c| ingest_db::get_anchors(c, match_id))
            .unwrap_or_default();
        let auto = anchors.iter().filter(|a| a.method == "auto").count();
        let rec = self.record(match_id);
        if auto > 0 {
            return AnalysisStatus::Done {
                anchors_auto: auto,
                reason: rec.map(|r| r.reason).filter(|r| !r.is_empty()),
            };
        }
        if let Some(u) = self.unavailable_reason(match_id) {
            return AnalysisStatus::Unavailable(u.into());
        }
        if let Some(r) = rec.filter(|r| !r.ok) {
            return AnalysisStatus::Failed(r.reason);
        }
        // Calage sur les coupures audio seulement : approximatif, on le dit.
        if anchors
            .iter()
            .any(|a| a.method == "audio" || a.method == "est")
        {
            return AnalysisStatus::Estimated;
        }
        AnalysisStatus::None
    }

    /// `startVideoAnalysis` : met une analyse en tête de file ; `Err` : la raison du refus.
    pub fn start_video_analysis(&self, match_id: i64, with_audio: bool) -> Result<(), String> {
        let r = self.enqueue(
            match_id,
            EnqueueOptions {
                priority: true,
                with_audio,
                manual: true,
                background: false,
            },
        );
        if r.started {
            Ok(())
        } else {
            Err(r.reason.unwrap_or(r.message))
        }
    }

    /// `enqueueRecentAnalyses` : job périodique — met en file les matchs
    /// terminés récents (≤ `days` jours, 10) avec replay, sans ancre OCR, non
    /// calibrés à la main, dont le backoff est échu ; rend le nombre mis en file.
    pub fn enqueue_recent(&self, days: Option<f64>, limit: Option<i64>) -> usize {
        if !(self.0.opts.ffmpeg_available)() {
            return 0;
        }
        let days = days.unwrap_or(10.0);
        let since_ms = self.now() + -days * 86_400_000.0;
        let since = chrono::DateTime::from_timestamp_millis(since_ms as i64)
            .map(crate::time::iso_utc)
            .unwrap_or_default();
        let list = self
            .0
            .db
            .with(|c| adb::final_matches_needing_analysis(c, &since, limit.unwrap_or(30)))
            .unwrap_or_default();
        let mut n = 0;
        for m in list {
            if self.is_running(m.id) || self.queue_position(m.id).is_some() {
                continue;
            }
            let manual = self
                .0
                .db
                .with(|c| ingest_db::get_anchors(c, m.id))
                .unwrap_or_default()
                .iter()
                .filter(|a| a.method == "manual")
                .count();
            if manual >= 2 {
                continue;
            }
            if !auto_retry_allowed(
                self.record(m.id).as_ref(),
                m.video_ok_id.as_deref(),
                self.now(),
            ) {
                continue;
            }
            let r = self.enqueue(
                m.id,
                EnqueueOptions {
                    background: true,
                    ..Default::default()
                },
            );
            if r.queued {
                n += 1;
            }
        }
        n
    }

    // ------------------------------------------------------------ exécution

    /// `runAnalysis` : Phase A — OCR du chrono (localisation, balayage,
    /// affinage) ; Phase B — énergie audio si l'OCR n'a pas donné assez
    /// d'ancres (ou sur demande) ; puis VF recalée.
    pub async fn run_analysis(
        &self,
        job: AnalysisJob,
        progress: ProgressFn,
        hooks: AnalysisHooks,
        deps: &AnalysisDeps,
    ) -> Result<AnalysisOutcome, String> {
        let match_id = job.match_id;
        let m = self.get_match(match_id).ok_or("pas de replay")?;
        let ok_id = ok_id_of(&m).ok_or("pas de replay")?.to_string();
        let db = self.0.db.clone();
        let mut plays = db.with(|c| ingest_db::get_plays(c, match_id))?;
        if plays.is_empty() {
            (deps.ingest_details)(m.clone()).await?;
            plays = db.with(|c| ingest_db::get_plays(c, match_id))?;
        }
        if plays.is_empty() {
            return Err("play-by-play ESPN indisponible".into());
        }
        let tp = to_timed_plays(
            plays
                .iter()
                .map(|p| (p.seq, p.period, p.clock_sec, p.wallclock.as_str())),
        );
        let breaks = find_breaks(&tp);
        let stream = (deps.resolve_stream)(ok_id.clone(), true).await?;
        let duration = ingest_db::video_duration(&m)
            .or(stream.duration)
            .unwrap_or(0.0);
        if duration == 0.0 || duration.is_nan() {
            return Err("durée de la vidéo inconnue".into());
        }
        let mut report: Vec<String> = Vec::new();
        let ocr_disabled = std::env::var("OCR_DISABLED").is_ok_and(|v| v == "1");

        let mut ocr_anchors = 0usize;
        if !ocr_disabled {
            let sources = analysis_sources(&stream);
            if sources.is_empty() {
                return Err("aucune source vidéo exploitable (ni HLS ni MP4)".into());
            }
            // Sonde : une image au milieu de la vidéo, source après source.
            let probes = sources.len().min(4) as f64;
            progress(AnalysisProgress::new("accès au flux vidéo", 0.0, probes));
            let mut src = None;
            let mut last_err = String::new();
            for (i, s) in sources.iter().take(4).enumerate() {
                match (deps.grab)(
                    s.url.clone(),
                    crate::js::round(duration / 2.0),
                    Some(Duration::from_millis(45_000)),
                )
                .await
                {
                    Ok(_) => {
                        src = Some(s.clone());
                        break;
                    }
                    Err(e) => last_err = short_error(&e),
                }
                progress(AnalysisProgress::new(
                    "accès au flux vidéo",
                    (i + 1) as f64,
                    probes,
                ));
            }
            let net_failures = || {
                self.record(match_id)
                    .and_then(|r| r.net_failures)
                    .unwrap_or(0.0)
            };
            let Some(source) = src else {
                let detail = if last_err.is_empty() {
                    "ffmpeg"
                } else {
                    &last_err
                };
                return Ok(network_outcome(detail, net_failures()));
            };
            let loc_key = format!("scoreboard:{ok_id}");
            let cached = db
                .with(|c| db::kv_get(c, &loc_key, Some(30 * 24 * 3_600_000)))
                .ok()
                .flatten()
                .and_then(|v| ScoreboardLocation::from_json(&v));
            let engine = (deps.ocr)()?;
            let score_plays: Vec<ScorePlay> = plays
                .iter()
                .map(|p| ScorePlay {
                    seq: p.seq,
                    period: p.period,
                    clock_sec: p.clock_sec,
                    home_score: p.home_score,
                    away_score: p.away_score,
                })
                .collect();
            let url = source.url.clone();
            let grab = deps.grab.clone();
            let gate = hooks.gate.clone();
            let scan_deps = OcrScan {
                engine: &*engine,
                grab: move |t: f64| {
                    let (url, grab, gate) = (url.clone(), grab.clone(), gate.clone());
                    async move {
                        gate().await; // analyse de fond : en pause tant qu'une vidéo est regardée
                        grab(url, t, None).await
                    }
                },
                tp: &tp,
                breaks: &breaks,
                scores: Some(score_timeline(&score_plays)),
            };
            let step = std::env::var("OCR_STEP_SEC")
                .ok()
                .map_or(105.0, |v| crate::api::js_number(&v));
            let p2 = progress.clone();
            let on_progress = move |phase: ScanPhase, done: usize, total: usize| {
                p2(AnalysisProgress::new(
                    phase_label(phase),
                    done as f64,
                    total as f64,
                ));
            };
            let scan = scan_video(
                &scan_deps,
                ScanOptions {
                    duration,
                    tp: &tp,
                    breaks: &breaks,
                    location: cached,
                    step_sec: Some(step),
                    sample_frames: None,
                    refine_rounds: None,
                    on_progress: Some(&on_progress),
                },
            )
            .await?;
            if scan.frames_read == 0 {
                return Ok(network_outcome(
                    "flux coupé pendant le balayage",
                    net_failures(),
                ));
            }
            if let Some(l) = &scan.location {
                let v = l.to_json();
                db.with(|c| db::kv_set(c, &loc_key, &v))?;
            }
            let rows = scan
                .anchors
                .iter()
                .map(|a| {
                    Ok(NewAnchor {
                        period: a.period,
                        clock_sec: a.clock_sec,
                        video_ts: crate::js::round(a.video * 100.0) / 100.0,
                        wallclock: wall_iso(a.wall)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            db.with(|c| ingest_db::replace_anchors_by_method(c, match_id, "auto", &rows))?;
            ocr_anchors = scan.anchors.len();
            report.push(format!(
                "OCR ({} {}) : bandeau {}, {} images, {} lectures, {} ancres sur {} période(s), {} s",
                match source.kind {
                    SourceKind::Hls => "hls",
                    SourceKind::Mp4 => "mp4",
                },
                source.label,
                match (&scan.location, scan.cached_location) {
                    (Some(_), true) => "connu",
                    (Some(_), false) => "localisé",
                    (None, _) => "non localisé",
                },
                scan.frames_read,
                scan.observations.len(),
                ocr_anchors,
                scan.per_period.len(),
                crate::jsval::js_number_string(crate::js::round(scan.elapsed_ms as f64 / 1000.0)),
            ));
        }

        if job.with_audio || ocr_anchors < 3 {
            progress(AnalysisProgress::new("analyse audio", 0.0, 1.0));
            let fresh = (deps.resolve_stream)(ok_id.clone(), true).await?;
            let src = pick_audio_source(&fresh).ok_or("aucune source audio exploitable")?;
            let profile = (deps.analyze_audio)(src.url.clone()).await?;
            let cuts = detect_cuts(&profile, &CutOptions::default());
            let (p, c2) = (profile.clone(), cuts.clone());
            let ok = ok_id.clone();
            db.with(move |c| adb::save_audio_profile(c, match_id, &ok, 1.0, &p, &c2))?;
            report.push(format!(
                "audio : {} s, {} coupures",
                profile.len(),
                cuts.len()
            ));
            progress(AnalysisProgress::new("analyse audio", 1.0, 1.0));
        }
        let n = db.with(|c| crate::ingest::regenerate_subtitles(c, match_id, None))??;
        report.push(format!("{n} sous-titres recalés"));
        // OCR désactivé volontairement : l'analyse audio seule est le résultat attendu.
        if ocr_disabled {
            return Ok(AnalysisOutcome::ok(0.0, report.join(" ; ")));
        }
        if ocr_anchors < 2 {
            return Ok(AnalysisOutcome::failed(
                Some(AnalysisFailureKind::Contenu),
                ocr_anchors as f64,
                format!(
                    "Chrono du bandeau illisible : synchro approximative ({})",
                    report.join(" ; ")
                ),
            ));
        }
        Ok(AnalysisOutcome::ok(ocr_anchors as f64, report.join(" ; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enregistrement_comme_node() {
        let r = AnalysisRecord {
            at: "2026-10-31T10:00:00.000Z".into(),
            ok: false,
            failures: Some(0.0),
            reason: "x".into(),
            anchors: 0.0,
            ok_id: Some("A".into()),
            kind: Some(AnalysisFailureKind::Reseau),
            net_failures: Some(1.0),
        };
        assert_eq!(
            r.to_json().to_string(),
            r#"{"at":"2026-10-31T10:00:00.000Z","ok":false,"failures":0,"reason":"x","anchors":0,"okId":"A","kind":"reseau","netFailures":1}"#
        );
        assert_eq!(AnalysisRecord::from_json(&r.to_json()), Some(r));
        assert_eq!(network_outcome("x", 0.0).reason, "Flux vidéo inaccessible : aucune image n'a pu être extraite (x). Problème réseau, pas de contenu : nouvel essai automatique dans ~15 min.");
    }
}
