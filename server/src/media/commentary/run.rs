//! Exécution d'un travail de traduction (`runCommentary` de `commentary.ts`) :
//! tronçon par tronçon, en commençant à la position du spectateur, chaque
//! tronçon publié dès qu'il est traduit. Tronçons audio, transcriptions et
//! traductions déjà présents dans le dossier de travail sont réutilisés ; les
//! tronçons déjà publiés en base ne sont pas refaits.

use super::plan::{audio_sources, chunk_cues, chunk_name, covered_from, next_chunk, ChunkCue};
use super::workdir::{
    full_audio_file, full_audio_wanted, path_str, pause, read_json, work_dir, write_json,
    ExtractFullFn, FullAudioWait,
};
use super::{
    env_num_or, ok_id_of, BoxFut, ChunkPlan, Commentary, CommentaryControl, CommentaryError,
    CommentaryOutcome, CommentaryPhase, CommentaryProgress, FailureKind, Job, ProgressFn,
    StreamInfo,
};
use crate::commentary_db::{self as cdb, CommentaryTrackMeta, CueInput, PublishedChunk};
use crate::js;
use crate::js::jsre;
use crate::media::abort::AbortSignal;
use crate::media::audio::{
    cut_audio, extract_audio_chunk, extract_full_audio, ExtractOptions, SourceHeaders,
};
use crate::media::audio_energy::{audio_envelope, with_energy, Envelope};
use crate::media::commentary_ai::{
    transcribe_audio, translate_batch, whisper_prompt, CommentaryConfig, Service, ServiceMode,
    TranscribeOptions, TranslateContext, TranslateLine, TranslatedLine, CONTEXT_LINES,
};
use crate::media::commentary_cues::{parse_verbose_json, Transcript};
use crate::media::local_ai::{OllamaSession, WhisperSession};
use crate::media::roster_names::{fix_roster_names, roster_index, RosterIndex};
use futures_util::future::{FutureExt, Shared};
use serde_json::{json, Map, Value};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

// ---------------------------------------------------------------- dépendances

/// Flux ok.ru du replay (`resolveStream(okId, force)`). Sans `force`, le flux
/// déjà résolu par le lecteur est réutilisé.
pub type ResolveStreamFn =
    Arc<dyn Fn(String, bool) -> BoxFut<Result<StreamInfo, String>> + Send + Sync>;

/// Extraction d'un tronçon audio dans le flux (`extract`).
#[derive(Clone)]
pub struct ExtractRequest {
    pub source_url: String,
    pub start: f64,
    pub length: f64,
    pub out_file: String,
    pub options: ExtractOptions,
}

pub type ExtractFn = Arc<dyn Fn(ExtractRequest) -> BoxFut<Result<(), String>> + Send + Sync>;
/// Découpe locale du son complet (`cut(file, start, length, out, signal)`).
pub type CutFn = Arc<
    dyn Fn(String, f64, f64, String, Option<AbortSignal>) -> BoxFut<Result<(), String>>
        + Send
        + Sync,
>;
/// Transcription par un serveur externe (`transcribe(file, cfg, { prompt, signal })`).
pub type TranscribeFn = Arc<
    dyn Fn(
            String,
            CommentaryConfig,
            TranscribeOptions,
        ) -> BoxFut<Result<Transcript, CommentaryError>>
        + Send
        + Sync,
>;
/// Traduction d'un lot (`translate(lines, context, cfg, o)`).
pub type TranslateFn = Arc<
    dyn Fn(
            Vec<TranslateLine>,
            Vec<String>,
            CommentaryConfig,
            TranslateContext,
        ) -> BoxFut<Result<Vec<TranslatedLine>, CommentaryError>>
        + Send
        + Sync,
>;
/// Ouverture de la session de transcription (`openTranscriber`).
pub type OpenTranscriberFn = Arc<
    dyn Fn(CommentaryConfig, AbortSignal) -> BoxFut<Result<Transcriber, CommentaryError>>
        + Send
        + Sync,
>;
/// Ouverture du traducteur (`openTranslator`), avec progression (Mo).
pub type OpenTranslatorFn = Arc<
    dyn Fn(
            CommentaryConfig,
            AbortSignal,
            Arc<dyn Fn(f64, f64) + Send + Sync>,
        ) -> BoxFut<Result<TranslatorSession, CommentaryError>>
        + Send
        + Sync,
>;
/// Enveloppe d'intensité de la voix d'un tronçon (`envelope`) ; `None` : sans relief.
pub type EnvelopeFn = Arc<dyn Fn(String, AbortSignal) -> BoxFut<Option<Envelope>> + Send + Sync>;

/// Session de transcription (`Transcriber`).
#[derive(Clone)]
pub struct Transcriber {
    /// `(fichier, prompt, signal, hotwords)` ; `hotwords` : effectif du match
    /// (Whisper embarqué seulement ; ignoré par un serveur externe).
    pub transcribe: SessionTranscribeFn,
    pub close: CloseFn,
}

/// `transcribe(fichier, prompt, signal, hotwords)` d'une session.
pub type SessionTranscribeFn = Arc<
    dyn Fn(
            String,
            Option<String>,
            AbortSignal,
            Option<String>,
        ) -> BoxFut<Result<Transcript, CommentaryError>>
        + Send
        + Sync,
>;
/// Fermeture d'une session (modèle déchargé).
pub type CloseFn = Arc<dyn Fn() -> BoxFut<()> + Send + Sync>;

/// Traducteur ouvert (`{ close() }`).
#[derive(Clone)]
pub struct TranslatorSession {
    pub close: CloseFn,
}

/// Dépendances externes d'un travail (`CommentaryDeps`), remplaçables dans
/// les tests. `extract_full`/`cut` absents : extraction tronçon par tronçon ;
/// `open_transcriber`/`open_translator` absents : `transcribe`/`translate`
/// appelés directement ; `envelope` absente : sous-titres sans relief.
#[derive(Clone)]
pub struct CommentaryDeps {
    pub resolve_stream: ResolveStreamFn,
    pub extract: ExtractFn,
    pub extract_full: Option<ExtractFullFn>,
    pub cut: Option<CutFn>,
    pub transcribe: TranscribeFn,
    pub translate: TranslateFn,
    pub open_transcriber: Option<OpenTranscriberFn>,
    pub open_translator: Option<OpenTranslatorFn>,
    pub envelope: Option<EnvelopeFn>,
}

fn noop_close() -> CloseFn {
    Arc::new(|| Box::pin(async {}))
}

/// `remoteTranscriber` : serveur externe, rien à ouvrir ni fermer.
fn remote_transcriber(cfg: CommentaryConfig, transcribe: TranscribeFn) -> Transcriber {
    Transcriber {
        transcribe: Arc::new(move |file, prompt, signal, _hotwords| {
            transcribe(
                file,
                cfg.clone(),
                TranscribeOptions {
                    prompt,
                    signal: Some(signal),
                    ..Default::default()
                },
            )
        }),
        close: noop_close(),
    }
}

fn default_transcribe() -> TranscribeFn {
    Arc::new(|file, cfg, o| {
        Box::pin(async move {
            transcribe_audio(&file, &cfg, &o)
                .await
                .map_err(CommentaryError::from)
        })
    })
}

impl CommentaryDeps {
    /// Dépendances réelles (`defaultDeps`) : flux résolus par le proxy vidéo,
    /// ffmpeg, Whisper et Ollama embarqués ou serveurs externes. Démarrage
    /// d'un service embarqué ou téléchargement d'un modèle en échec : panne
    /// de SERVICE (nouvel essai rapide), pas un défaut du match.
    pub fn defaults(video: crate::video::Video) -> CommentaryDeps {
        CommentaryDeps {
            resolve_stream: Arc::new(move |ok_id, force| {
                let v = video.clone();
                Box::pin(async move {
                    v.resolve_ok_stream(&ok_id, force)
                        .await
                        .map(|s| StreamInfo::from(&*s))
                        .map_err(|e| e.msg)
                })
            }),
            extract: Arc::new(|r| {
                Box::pin(async move {
                    // Segments HLS sur plusieurs connexions : ok.ru bride chacune.
                    if crate::media::hls_fetch::parallel_fetch_enabled() {
                        let t0 = std::time::Instant::now();
                        match crate::media::audio::extract_hls_chunk_parallel(
                            &r.source_url,
                            r.start,
                            r.length,
                            &r.out_file,
                            &r.options,
                        )
                        .await
                        {
                            Ok(how) => {
                                println!(
                                    "[commentaires] audio {}–{} s : {how} ; prêt en {:.1} s",
                                    r.start.round(),
                                    (r.start + r.length).round(),
                                    t0.elapsed().as_secs_f64()
                                );
                                return Ok(());
                            }
                            Err(e) => {
                                if crate::media::abort::is_aborted(r.options.signal.as_ref()) {
                                    return Err(e);
                                }
                                eprintln!(
                                    "[commentaires] téléchargement parallèle impossible ({}) : lecture par ffmpeg",
                                    short(&e)
                                );
                            }
                        }
                    }
                    extract_audio_chunk(&r.source_url, r.start, r.length, &r.out_file, &r.options)
                        .await
                })
            }),
            // Son complet lu d'une traite par ffmpeg (une connexion, depuis le
            // début du match) : seulement sans le téléchargement parallèle,
            // bien plus rapide et qui commence là où regarde le spectateur.
            extract_full: (!crate::media::hls_fetch::parallel_fetch_enabled()).then(|| {
                let f: ExtractFullFn = Arc::new(|url, out, o, progress| {
                    Box::pin(async move {
                        extract_full_audio(&url, &out, &o, Some(&*progress), None).await
                    })
                });
                f
            }),
            cut: Some(Arc::new(|file, start, length, out, signal| {
                Box::pin(async move { cut_audio(&file, start, length, &out, signal).await })
            })),
            envelope: Some(Arc::new(|file, signal| {
                Box::pin(async move { audio_envelope(&file, Some(&signal), None).await })
            })),
            transcribe: default_transcribe(),
            translate: Arc::new(|lines, context, cfg, o| {
                Box::pin(async move {
                    translate_batch(&lines, &context, &cfg, &o)
                        .await
                        .map_err(CommentaryError::from)
                })
            }),
            open_transcriber: Some(Arc::new(|cfg, _signal| {
                Box::pin(async move {
                    if cfg.transcribe_mode != ServiceMode::Embedded {
                        return Ok(remote_transcriber(cfg, default_transcribe()));
                    }
                    let s = WhisperSession::open(&cfg.transcribe_model, None)
                        .await
                        .map_err(|e| CommentaryError::service(e, Service::Transcription))?;
                    let s2 = s.clone();
                    Ok(Transcriber {
                        transcribe: Arc::new(move |file, prompt, signal, hotwords| {
                            let s = s.clone();
                            Box::pin(async move {
                                s.transcribe(
                                    &file,
                                    prompt.as_deref(),
                                    Some(&signal),
                                    hotwords.as_deref(),
                                )
                                .await
                                .map_err(CommentaryError::Other)
                            })
                        }),
                        close: Arc::new(move || {
                            let s = s2.clone();
                            Box::pin(async move { s.close().await })
                        }),
                    })
                })
            })),
            open_translator: Some(Arc::new(|cfg, signal, on_progress| {
                Box::pin(async move {
                    if cfg.translate_mode != ServiceMode::Embedded {
                        return Ok(TranslatorSession {
                            close: noop_close(),
                        });
                    }
                    let s = OllamaSession::open(None)
                        .await
                        .map_err(|e| CommentaryError::service(e, Service::Traduction))?;
                    if let Err(e) = s
                        .ensure_model(&cfg.translate_model, Some(&*on_progress), Some(&signal))
                        .await
                    {
                        s.close().await;
                        return Err(CommentaryError::service(e, Service::Traduction));
                    }
                    // Modèle chargé en mémoire GPU dès maintenant, pendant que Whisper travaille.
                    s.warm(&cfg.translate_model, Some(&signal)).await;
                    let s = Arc::new(s);
                    Ok(TranslatorSession {
                        close: Arc::new(move || {
                            let s = s.clone();
                            Box::pin(async move { s.close().await })
                        }),
                    })
                })
            })),
        }
    }
}

// ---------------------------------------------------------------- outils

/// `short` : message d'erreur sur une ligne, 160 caractères au plus.
pub(crate) fn short(e: &str) -> String {
    js::slice_utf16(&jsre!(r"\s+").replace_all(e, " "), 160)
}

/// Fin d'une traduction lancée en tâche (une panique devient une erreur).
async fn join_translation(
    h: tokio::task::JoinHandle<Result<(), CommentaryError>>,
) -> Result<(), CommentaryError> {
    match h.await {
        Ok(r) => r,
        Err(e) => Err(CommentaryError::Other(format!(
            "traduction interrompue : {e}"
        ))),
    }
}

/// `COMMENTARY_OVERLAP` (activé par défaut ; `0` le coupe) : le tronçon suivant
/// est transcrit pendant que le courant se traduit, au lieu d'attendre la fin
/// de sa traduction (le GPU de la transcription restait sinon inoccupé
/// pendant chaque lot envoyé au traducteur).
fn overlap_enabled() -> bool {
    std::env::var("COMMENTARY_OVERLAP").ok().as_deref() != Some("0")
}

/// `maxLeadSec` : `COMMENTARY_MAX_LEAD_SEC`, avance maximale sur la lecture
/// (0 par défaut : aucune, la traduction va au bout du match d'une traite,
/// pour qu'un doublage puisse partir de sous-titres complets).
fn max_lead_sec() -> f64 {
    match std::env::var("COMMENTARY_MAX_LEAD_SEC") {
        Ok(raw) if !raw.is_empty() => {
            let n = crate::api::js_number(&raw);
            if n.is_finite() && n >= 0.0 {
                n
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

fn chunk_audio(dir: &Path, p: &ChunkPlan) -> PathBuf {
    dir.join(format!("{}.ogg", chunk_name(p)))
}

fn chunk_json(dir: &Path, p: &ChunkPlan) -> PathBuf {
    dir.join(format!("{}.json", chunk_name(p)))
}

const ABORTED: &str = "travail interrompu";

/// Échec d'une étape : flux vidéo inaccessible (échec « reseau ») ou autre.
enum RunFail {
    Stream(String),
    Err(CommentaryError),
}

impl From<CommentaryError> for RunFail {
    fn from(e: CommentaryError) -> Self {
        RunFail::Err(e)
    }
}

fn io_err(e: std::io::Error) -> RunFail {
    RunFail::Err(CommentaryError::Other(e.to_string()))
}

fn db_err(e: String) -> CommentaryError {
    CommentaryError::Other(e)
}

/// Ligne en cache d'une traduction déjà faite (valable si l'anglais n'a pas changé).
#[derive(Debug, Clone, PartialEq)]
struct CacheLine {
    en: String,
    fr: String,
    untranslated: bool,
}

/// `translation.json` du dossier de travail.
#[derive(Debug, Clone, PartialEq)]
struct TranslationCache {
    model: String,
    /// seq → traduction (ordre des clés numériques de JavaScript).
    lines: BTreeMap<i64, CacheLine>,
}

impl TranslationCache {
    fn read(file: &Path, model: &str) -> TranslationCache {
        let empty = || TranslationCache {
            model: model.to_string(),
            lines: BTreeMap::new(),
        };
        let Some(v) = read_json(file).filter(|v| !v.is_null()) else {
            return empty();
        };
        let mut c = TranslationCache {
            model: js::str_or_empty(v.get("model")),
            lines: BTreeMap::new(),
        };
        if let Some(Value::Object(lines)) = v.get("lines") {
            for (k, l) in lines {
                let Ok(seq) = k.parse::<i64>() else { continue };
                c.lines.insert(
                    seq,
                    CacheLine {
                        en: js::str_or_empty(l.get("en")),
                        fr: js::str_or_empty(l.get("fr")),
                        untranslated: js::truthy(l.get("untranslated")),
                    },
                );
            }
        }
        if c.model != model {
            return empty();
        }
        c
    }

    fn to_json(&self) -> Value {
        let mut lines = Map::new();
        for (k, l) in &self.lines {
            lines.insert(
                k.to_string(),
                json!({ "en": l.en, "fr": l.fr, "untranslated": l.untranslated }),
            );
        }
        json!({ "model": self.model, "lines": lines })
    }
}

type MtShared = Shared<BoxFut<Result<Option<TranslatorSession>, CommentaryError>>>;

/// Rappel d'avancement d'un travail : (phase, fait, total).
type Report = Arc<dyn Fn(CommentaryPhase, f64, f64) + Send + Sync>;

/// État d'un travail, partagé avec les extractions anticipées.
struct RunCtx {
    svc: Commentary,
    deps: CommentaryDeps,
    cfg: CommentaryConfig,
    match_id: i64,
    ok_id: String,
    dir: PathBuf,
    signal: AbortSignal,
    duration: f64,
    total: usize,
    headers: SourceHeaders,
    stream: Mutex<StreamInfo>,
    done: Arc<Mutex<HashSet<usize>>>,
    report: Report,
    prompt: Option<String>,
    hotwords: Option<String>,
    track: CommentaryTrackMeta,
    cache: Mutex<TranslationCache>,
    cache_file: PathBuf,
    batches: AtomicUsize,
    attempted: Mutex<HashSet<i64>>,
    leftover_ctx: TranslateContext,
    roster: RosterIndex,
    asr: Mutex<Option<Transcriber>>,
    mt: Mutex<Option<MtShared>>,
}

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl RunCtx {
    fn check_aborted(&self) -> Result<(), CommentaryError> {
        if self.signal.is_aborted() {
            Err(CommentaryError::Other(ABORTED.into()))
        } else {
            Ok(())
        }
    }

    fn done_len(&self) -> f64 {
        locked(&self.done).len() as f64
    }

    /// `openMt` : traducteur démarré EN PARALLÈLE (Ollama et chargement du
    /// modèle), attendu au moment de traduire.
    fn open_mt(&self) -> MtShared {
        let mut g = locked(&self.mt);
        if let Some(m) = g.as_ref() {
            return m.clone();
        }
        let fut: BoxFut<Result<Option<TranslatorSession>, CommentaryError>> =
            match &self.deps.open_translator {
                Some(open) => {
                    let report = self.report.clone();
                    let f = open(
                        self.cfg.clone(),
                        self.signal.clone(),
                        Arc::new(move |d, t| report(CommentaryPhase::Preparation, d, t)),
                    );
                    let h = tokio::spawn(f);
                    Box::pin(async move {
                        match h.await {
                            Ok(r) => r.map(Some),
                            Err(e) => Err(CommentaryError::Other(e.to_string())),
                        }
                    })
                }
                None => Box::pin(async { Ok(None) }),
            };
        let shared = fut.shared();
        *g = Some(shared.clone());
        shared
    }

    async fn close_mt(&self) {
        let p = locked(&self.mt).take();
        if let Some(p) = p {
            if let Ok(Some(s)) = p.await {
                (s.close)().await;
            }
        }
    }

    async fn close_asr(&self) {
        let s = locked(&self.asr).take();
        if let Some(s) = s {
            (s.close)().await;
        }
    }

    /// Extrait l'audio d'un tronçon : son complet découpé sur place si
    /// possible, sinon toutes les sources du flux, puis une re-résolution.
    async fn extract(self: Arc<Self>, plan: ChunkPlan, out: PathBuf) -> Result<(), RunFail> {
        let mut last_err = String::new();
        let out_s = path_str(&out);
        // Son complet du match (une seule lecture du flux), découpé sur place.
        if let (Some(ef), Some(cut), true) =
            (&self.deps.extract_full, &self.deps.cut, full_audio_wanted())
        {
            let src = audio_sources(&locked(&self.stream)).into_iter().next();
            if let Some(url) = src.map(|s| s.url) {
                let fa =
                    self.svc
                        .start_full_audio(&self.ok_id, &url, self.headers.clone(), ef.clone());
                let r = self
                    .svc
                    .wait_full_audio(
                        &fa,
                        js::min(plan.start + plan.length, self.duration),
                        &self.signal,
                    )
                    .await;
                self.check_aborted()?;
                if r == FullAudioWait::Ready {
                    let mut path = locked(&fa).path.clone();
                    // Fichier renommé (extraction terminée) juste avant la découpe :
                    // un nouvel essai sur le fichier final (avec plusieurs fils, la
                    // fenêtre est plus large que sous Node).
                    for attempt in 0..2 {
                        match cut(
                            path.clone(),
                            plan.start,
                            plan.length,
                            out_s.clone(),
                            Some(self.signal.clone()),
                        )
                        .await
                        {
                            Ok(()) => return Ok(()),
                            // Disque… : lecture du flux.
                            Err(e) => last_err = short(&e),
                        }
                        let now = locked(&fa).path.clone();
                        if attempt > 0 || now == path {
                            break;
                        }
                        path = now;
                    }
                }
            }
        }
        // URL signée expirée pendant un long travail : on re-résout une fois.
        for round in 0..2 {
            if round == 1 {
                match (self.deps.resolve_stream)(self.ok_id.clone(), true).await {
                    Ok(s) => *locked(&self.stream) = s,
                    Err(e) => {
                        last_err = format!("résolution du flux : {}", short(&e));
                        break;
                    }
                }
            }
            let sources = audio_sources(&locked(&self.stream));
            if sources.is_empty() {
                last_err = "aucune source audio (ni HLS ni MP4)".into();
                continue;
            }
            for url in sources.into_iter().take(3).map(|s| s.url) {
                self.check_aborted()?;
                let req = ExtractRequest {
                    source_url: url,
                    start: plan.start,
                    length: plan.length,
                    out_file: out_s.clone(),
                    options: ExtractOptions {
                        headers: self.headers.clone(),
                        signal: Some(self.signal.clone()),
                        timeout: None,
                    },
                };
                match (self.deps.extract)(req).await {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = short(&e),
                }
            }
        }
        Err(RunFail::Stream(format!(
            "tronçon {}/{} : {last_err}",
            plan.index + 1,
            self.total
        )))
    }

    /// Transcription d'un tronçon : cache, sinon extraction (si besoin) puis Whisper.
    async fn transcribe_chunk(
        self: &Arc<Self>,
        plan: &ChunkPlan,
        prefetched: &mut HashMap<usize, tokio::task::JoinHandle<Result<(), RunFail>>>,
    ) -> Result<Transcript, RunFail> {
        let cache_json = chunk_json(&self.dir, plan);
        if let Some(v) = read_json(&cache_json) {
            if v.get("model").and_then(Value::as_str) == Some(self.cfg.transcribe_model.as_str())
                && js::truthy(v.get("transcript"))
            {
                return Ok(parse_verbose_json(&v["transcript"]));
            }
        }
        let audio = chunk_audio(&self.dir, plan);
        if let Some(pending) = prefetched.remove(&plan.index) {
            let _ = pending.await; // un échec est retenté ci-dessous
        }
        if !audio.exists() {
            (self.report)(
                CommentaryPhase::Extraction,
                self.done_len(),
                self.total as f64,
            );
            self.clone().extract(*plan, audio.clone()).await?;
        }
        self.check_aborted()?;
        let asr = locked(&self.asr).clone();
        let asr = match asr {
            Some(a) => a,
            None => {
                (self.report)(CommentaryPhase::Preparation, 0.0, 0.0);
                let a = match &self.deps.open_transcriber {
                    Some(open) => open(self.cfg.clone(), self.signal.clone()).await?,
                    None => remote_transcriber(self.cfg.clone(), self.deps.transcribe.clone()),
                };
                *locked(&self.asr) = Some(a.clone());
                a
            }
        };
        (self.report)(
            CommentaryPhase::Transcription,
            self.done_len(),
            self.total as f64,
        );
        let audio_s = path_str(&audio);
        let t0 = std::time::Instant::now();
        let mut transcript = (asr.transcribe)(
            audio_s.clone(),
            self.prompt.clone(),
            self.signal.clone(),
            self.hotwords.clone(),
        )
        .await?;
        println!(
            "[commentaires] match {} tronçon {}/{} : transcrit en {:.1} s",
            self.match_id,
            plan.index + 1,
            self.total,
            t0.elapsed().as_secs_f64()
        );
        // Intensité de la voix mot par mot, tant que l'audio est là.
        let env = match &self.deps.envelope {
            Some(f) => f(audio_s, self.signal.clone()).await,
            None => None,
        };
        self.check_aborted()?;
        if let Some(env) = env {
            transcript = with_energy(&transcript, &env);
        }
        write_json(
            &cache_json,
            &json!({ "model": self.cfg.transcribe_model, "transcript": transcript.to_json() }),
        )
        .map_err(io_err)?;
        let _ = std::fs::remove_file(&audio); // transcrit : l'audio du tronçon ne sert plus
        Ok(transcript)
    }

    /// `needsTranslation` : ligne pas en cache, changée, ou restée en anglais.
    fn needs_translation(&self, c: &ChunkCue) -> bool {
        match locked(&self.cache).lines.get(&c.seq) {
            None => true,
            Some(t) => t.en != c.text || t.untranslated,
        }
    }

    /// Traduit et publie les sous-titres d'un tronçon.
    async fn translate_and_publish(
        &self,
        plan: &ChunkPlan,
        cues: Vec<ChunkCue>,
    ) -> Result<(), CommentaryError> {
        let t0 = std::time::Instant::now();
        let n = cues.len();
        let r = self.translate_and_publish_inner(plan, cues).await;
        if r.is_ok() {
            println!(
                "[commentaires] match {} tronçon {}/{} : {n} ligne(s) traduite(s) en {:.1} s",
                self.match_id,
                plan.index + 1,
                self.total,
                t0.elapsed().as_secs_f64()
            );
        }
        r
    }

    async fn translate_and_publish_inner(
        &self,
        plan: &ChunkPlan,
        cues: Vec<ChunkCue>,
    ) -> Result<(), CommentaryError> {
        let todo_all = cues.iter().filter(|c| self.needs_translation(c)).count();
        if todo_all > 0 {
            self.open_mt().await?;
        }
        if !cues.is_empty() {
            (self.report)(
                CommentaryPhase::Traduction,
                self.done_len(),
                self.total as f64,
            );
        }
        // Contexte du premier lot : les sous-titres déjà publiés juste avant ce tronçon.
        let before = self
            .svc
            .db()
            .with(|c| {
                cdb::commentary_cues_before(c, self.match_id, plan.keep_from, CONTEXT_LINES, None)
            })
            .map_err(db_err)?;
        let batch = self.cfg.batch.max(1);
        let starts: Vec<usize> = (0..cues.len()).step_by(batch).collect();
        let next_batch = Mutex::new(0usize);
        // Lots indépendants : `cfg.parallel` lots partent en même temps.
        let worker = || async {
            loop {
                let k = {
                    let mut n = locked(&next_batch);
                    if *n >= starts.len() {
                        break;
                    }
                    let k = starts[*n];
                    *n += 1;
                    k
                };
                self.check_aborted()?;
                let lot = &cues[k..(k + batch).min(cues.len())];
                self.batches.fetch_add(1, Ordering::SeqCst);
                let todo: Vec<&ChunkCue> =
                    lot.iter().filter(|c| self.needs_translation(c)).collect();
                if todo.is_empty() {
                    continue;
                }
                {
                    let mut a = locked(&self.attempted);
                    for c in &todo {
                        a.insert(c.seq);
                    }
                }
                let mut context: Vec<String> = before.clone();
                context.extend(cues[..k].iter().map(|c| c.text.clone()));
                let context = context[context.len().saturating_sub(CONTEXT_LINES)..].to_vec();
                let lines = todo
                    .iter()
                    .map(|c| TranslateLine {
                        i: c.seq,
                        en: c.text.clone(),
                    })
                    .collect();
                let res = (self.deps.translate)(
                    lines,
                    context,
                    self.cfg.clone(),
                    self.leftover_ctx.clone(),
                )
                .await?;
                let snapshot = {
                    let mut cache = locked(&self.cache);
                    for r in res {
                        if let Some(c) = todo.iter().find(|x| x.seq == r.i) {
                            cache.lines.insert(
                                c.seq,
                                CacheLine {
                                    en: c.text.clone(),
                                    fr: r.fr,
                                    untranslated: r.untranslated,
                                },
                            );
                        }
                    }
                    cache.to_json()
                };
                write_json(&self.cache_file, &snapshot)
                    .map_err(|e| CommentaryError::Other(e.to_string()))?;
            }
            Ok::<(), CommentaryError>(())
        };
        let n = self.cfg.parallel.min(starts.len());
        futures_util::future::try_join_all((0..n).map(|_| worker())).await?;
        let rows: Vec<CueInput> = {
            let cache = locked(&self.cache);
            cues.iter()
                .map(|c| {
                    let t = cache.lines.get(&c.seq);
                    let translated = t.filter(|t| t.en == c.text && !t.untranslated);
                    CueInput {
                        seq: c.seq,
                        start_ts: c.start,
                        end_ts: c.end,
                        text_en: c.text.clone(),
                        text_fr: translated.map_or_else(|| c.text.clone(), |t| t.fr.clone()),
                        untranslated: translated.is_none(),
                        emphasis: c.emphasis.map_or(0.0, f64::from),
                    }
                })
                .collect()
        };
        let chunk = PublishedChunk {
            idx: plan.index,
            keep_from: plan.keep_from,
            keep_to: plan.keep_to,
        };
        self.svc
            .db()
            .with(|c| cdb::publish_commentary_chunk(c, self.match_id, &self.track, chunk, &rows))
            .map_err(db_err)?;
        locked(&self.done).insert(plan.index);
        (self.report)(
            CommentaryPhase::Traduction,
            self.done_len(),
            self.total as f64,
        );
        Ok(())
    }
}

impl Commentary {
    /// Effectif du match (feuille de stats), sans doublon ni nom vide.
    fn roster_names(&self, match_id: i64) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in self
            .db()
            .with(|c| crate::db::player_stats(c, match_id))
            .unwrap_or_default()
        {
            if let Value::String(n) = &p.player_name {
                if !n.is_empty() && !out.contains(n) {
                    out.push(n.clone());
                }
            }
        }
        out
    }

    /// `networkOutcome` : flux vidéo inaccessible (aucun son extrait).
    fn network_outcome(&self, detail: &str, match_id: i64) -> CommentaryOutcome {
        let rec = self.record(match_id);
        let prev = match &rec {
            Some(r) if super::quick_retry(r.kind) => r.net_failures.unwrap_or(0.0),
            _ => 0.0,
        };
        let wait = js::round(super::network_backoff_ms_f(prev + 1.0) / 60_000.0);
        CommentaryOutcome::failed(
            FailureKind::Reseau,
            format!(
                "Flux vidéo inaccessible : l'audio n'a pas pu être extrait ({detail}). Problème réseau, pas de contenu : nouvel essai automatique dans ~{} min.",
                crate::jsval::js_number_string(wait)
            ),
        )
    }

    /// `translateLeftovers` : rattrapage des sous-titres publiés restés en
    /// anglais, ligne par ligne (avec les lignes qui précèdent pour le sens).
    /// `skip` : lignes déjà tentées pendant ce travail. Une fois au bout, le
    /// rattrapage est noté pour la piste. Rend le nombre de lignes traduites.
    async fn translate_leftovers(
        &self,
        match_id: i64,
        cfg: &CommentaryConfig,
        deps: &CommentaryDeps,
        o: &TranslateContext,
        on_progress: &(dyn Fn(f64) + Send + Sync),
        skip: &HashSet<i64>,
    ) -> Result<usize, CommentaryError> {
        let rows: Vec<_> = self
            .db()
            .with(|c| cdb::untranslated_commentary_cues(c, match_id))
            .map_err(db_err)?
            .into_iter()
            .filter(|c| !skip.contains(&c.seq))
            .collect();
        let mut fixed = 0;
        for (k, c) in rows.iter().enumerate() {
            if crate::media::abort::is_aborted(o.signal.as_ref()) {
                return Err(CommentaryError::Other(ABORTED.into()));
            }
            on_progress(k as f64);
            let context = self
                .db()
                .with(|db| {
                    cdb::commentary_cues_before(db, match_id, c.start_ts, CONTEXT_LINES, None)
                })
                .map_err(db_err)?;
            let res = (deps.translate)(
                vec![TranslateLine {
                    i: c.seq,
                    en: c.text_en.clone(),
                }],
                context,
                cfg.clone(),
                o.clone(),
            )
            .await?;
            if let Some(r) = res.first() {
                if r.i == c.seq && !r.untranslated && !js::trim(&r.fr).is_empty() {
                    self.db()
                        .with(|db| cdb::set_commentary_cue_translation(db, match_id, c.seq, &r.fr))
                        .map_err(db_err)?;
                    fixed += 1;
                }
            }
        }
        if let Some(t) = self.track(match_id).filter(|t| t.complete != 0) {
            let v = json!({ "okId": t.ok_id, "model": t.translate_model });
            if let Err(e) = self
                .db()
                .with(|db| crate::db::kv_set(db, &format!("commentary-leftovers:{match_id}"), &v))
            {
                eprintln!("[commentaires] rattrapage non noté : {e}");
            }
        }
        if !rows.is_empty() {
            println!(
                "[commentaires] match {match_id} : {fixed}/{} ligne(s) restée(s) en anglais traduite(s)",
                rows.len()
            );
        }
        Ok(fixed)
    }

    /// `runCommentary` : un travail complet (voir le module). `ctl` : pilotage
    /// par la file ([`CommentaryControl::run_to_end`] : jusqu'au bout).
    pub async fn run_commentary(
        &self,
        job: &Job,
        progress: ProgressFn,
        signal: AbortSignal,
        deps: &CommentaryDeps,
        ctl: &CommentaryControl,
    ) -> Result<CommentaryOutcome, CommentaryError> {
        let t0 = Instant::now();
        let cfg = self.config();
        if let Some(r) = &cfg.disabled_reason {
            return Ok(CommentaryOutcome::failed(
                FailureKind::Erreur,
                format!("Traduction des commentaires inactive : {r}"),
            ));
        }
        let Some(m) = self
            .get_match(job.match_id)
            .filter(|m| ok_id_of(m).is_some())
        else {
            return Err(CommentaryError::Other("pas de replay".into()));
        };
        let ok_id = ok_id_of(&m).unwrap_or_default().to_string();
        // Effectif du match (feuille de stats) : corrige les noms écorchés par Whisper.
        let roster_list = self.roster_names(job.match_id);
        let roster = roster_index(&roster_list);
        let leftover_ctx = TranslateContext {
            match_label: Some(format!("{} @ {}", m.away_name, m.home_name)),
            roster: Some(roster.clone()),
            signal: Some(signal.clone()),
            ..Default::default()
        };

        // Piste déjà complète pour ce replay, sans relance forcée : seulement le
        // rattrapage des lignes restées en anglais (ni flux vidéo, ni Whisper).
        let prev_track = self.track(job.match_id);
        if !job.force
            && prev_track
                .as_ref()
                .is_some_and(|t| t.complete == 1 && t.ok_id == ok_id && t.cues > 0)
        {
            let total = self
                .db()
                .with(|c| cdb::untranslated_commentary_cues(c, job.match_id))
                .map_err(db_err)?
                .len() as f64;
            let mut mt: Option<TranslatorSession> = None;
            let res = async {
                if total > 0.0 {
                    if let Some(open) = &deps.open_translator {
                        let p = progress.clone();
                        mt = Some(
                            open(
                                cfg.clone(),
                                signal.clone(),
                                Arc::new(move |d, t| {
                                    p(CommentaryProgress {
                                        phase: CommentaryPhase::Preparation,
                                        done: d,
                                        total: t,
                                        available_until: None,
                                    })
                                }),
                            )
                            .await?,
                        );
                    }
                }
                let p = progress.clone();
                let fixed = self
                    .translate_leftovers(
                        job.match_id,
                        &cfg,
                        deps,
                        &leftover_ctx,
                        &move |d| {
                            p(CommentaryProgress {
                                phase: CommentaryPhase::Traduction,
                                done: d,
                                total,
                                available_until: None,
                            })
                        },
                        &HashSet::new(),
                    )
                    .await?;
                Ok(CommentaryOutcome::ok(format!(
                    "rattrapage : {fixed}/{} ligne(s) restée(s) en anglais traduite(s)",
                    crate::jsval::js_number_string(total)
                )))
            }
            .await;
            if let Some(mt) = mt {
                (mt.close)().await;
            }
            return res;
        }

        let dir = work_dir(&ok_id);
        std::fs::create_dir_all(&dir).map_err(|e| CommentaryError::Other(e.to_string()))?;

        let stream = match (deps.resolve_stream)(ok_id.clone(), false).await {
            Ok(s) => s,
            Err(e) => {
                return Ok(self
                    .network_outcome(&format!("résolution du flux : {}", short(&e)), job.match_id))
            }
        };
        let duration = crate::ingest_db::video_duration(&m)
            .or(stream.duration)
            .unwrap_or(0.0);
        if duration == 0.0 || duration.is_nan() {
            return Err(CommentaryError::Other("durée de la vidéo inconnue".into()));
        }
        // Une piste commencée garde son découpage ; une nouvelle prend le réglage actuel.
        let chunk_sec = match &prev_track {
            Some(p)
                if p.complete == 0
                    && p.ok_id == ok_id
                    && p.transcribe_model == cfg.transcribe_model
                    && p.translate_model == cfg.translate_model
                    && p.chunk_sec.is_some_and(|c| c != 0.0 && !c.is_nan()) =>
            {
                p.chunk_sec.unwrap_or_default()
            }
            _ => f64::from(cfg.chunk_sec),
        };
        let plans = Arc::new(super::plan_chunks(duration, chunk_sec, None));
        let total = plans.len();
        // Prompt Whisper (équipes + effectifs) seulement sur demande.
        let prompt = (std::env::var("WHISPER_PROMPT").ok().as_deref() == Some("1"))
            .then(|| whisper_prompt(&m.home_name, &m.away_name, &roster_list));
        // L'effectif est aussi donné à Whisper (« hotwords »).
        let hotwords = (std::env::var("WHISPER_HOTWORDS").ok().as_deref() != Some("0")
            && !roster_list.is_empty())
        .then(|| roster_list.join(", "));
        let track = CommentaryTrackMeta {
            ok_id: ok_id.clone(),
            transcribe_model: cfg.transcribe_model.clone(),
            translate_model: cfg.translate_model.clone(),
            chunk_sec: Some(chunk_sec),
            chunks_total: Some(total as f64),
        };
        // Relance explicite d'une piste complète : on repart de zéro ; sinon reprise.
        let fresh = job.force && self.track(job.match_id).is_some_and(|t| t.complete == 1);
        let done = self
            .db()
            .with(|c| cdb::open_commentary_track(c, job.match_id, &track, fresh))
            .map_err(db_err)?;
        let done = Arc::new(Mutex::new(done));

        let cache_file = dir.join("translation.json");
        let cache = TranslationCache::read(&cache_file, &cfg.translate_model);

        let report: Report = {
            let (plans, done, target, progress) = (
                plans.clone(),
                done.clone(),
                ctl.target.clone(),
                progress.clone(),
            );
            Arc::new(move |phase, d, tot| {
                let snapshot = locked(&done).clone();
                let until = covered_from(&plans, &snapshot, target(), duration);
                progress(CommentaryProgress {
                    phase,
                    done: d,
                    total: tot,
                    available_until: (until > 0.0).then_some(until),
                })
            })
        };

        let ctx = Arc::new(RunCtx {
            svc: self.clone(),
            deps: deps.clone(),
            cfg: cfg.clone(),
            match_id: job.match_id,
            ok_id: ok_id.clone(),
            dir: dir.clone(),
            signal: signal.clone(),
            duration,
            total,
            headers: SourceHeaders {
                user_agent: Some(crate::http::BROWSER_UA.into()),
                referer: Some(crate::okru::OK_REFERER.into()),
            },
            stream: Mutex::new(stream),
            done: done.clone(),
            report: report.clone(),
            prompt,
            hotwords,
            track,
            cache: Mutex::new(cache),
            cache_file,
            batches: AtomicUsize::new(0),
            attempted: Mutex::new(HashSet::new()),
            leftover_ctx: leftover_ctx.clone(),
            roster,
            asr: Mutex::new(None),
            mt: Mutex::new(None),
        });
        // Extraction anticipée du tronçon suivant pendant que le GPU traite le courant.
        let mut prefetched: HashMap<usize, tokio::task::JoinHandle<Result<(), RunFail>>> =
            HashMap::new();

        // Traduction du tronçon précédent, en cours pendant la transcription du suivant.
        type Inflight = (usize, tokio::task::JoinHandle<Result<(), CommentaryError>>);
        let mut inflight: Option<Inflight> = None;
        // Tronçons faits, plus celui en cours de traduction (jamais choisi deux fois).
        let taken = |inflight: &Option<Inflight>| {
            let mut d = locked(&done).clone();
            if let Some((i, _)) = inflight {
                d.insert(*i);
            }
            d
        };
        let outcome: Result<bool, RunFail> = async {
            let mut paused = false;
            loop {
                ctx.check_aborted()?;
                let plan = next_chunk(&plans, &taken(&inflight), (ctl.target)()).copied();
                let Some(plan) = plan else { break };
                if !(ctl.keep_going)() {
                    paused = true;
                    break;
                }
                // Assez d'avance sur la lecture : on attend que le spectateur avance.
                let target = (ctl.target)();
                let lead = max_lead_sec();
                if lead > 0.0
                    && ctl.playing.as_ref().is_some_and(|p| p())
                    && covered_from(&plans, &taken(&inflight), target, duration) - target >= lead
                {
                    pause(env_num_or("COMMENTARY_LEAD_POLL_MS", 5_000.0), &signal).await;
                    continue;
                }
                drop(ctx.open_mt());
                // Pendant ce tronçon, l'audio du suivant probable se télécharge.
                let mut with_current = taken(&inflight);
                with_current.insert(plan.index);
                if let Some(next) = next_chunk(&plans, &with_current, (ctl.target)()).copied() {
                    if let Entry::Vacant(slot) = prefetched.entry(next.index) {
                        let file = chunk_audio(&dir, &next);
                        if !file.exists() && !chunk_json(&dir, &next).exists() {
                            slot.insert(tokio::spawn(ctx.clone().extract(next, file)));
                        }
                    }
                }
                let transcript = ctx.transcribe_chunk(&plan, &mut prefetched).await?;
                let cues: Vec<ChunkCue> = chunk_cues(&plan, &transcript, ctx.prompt.as_deref())
                    .into_iter()
                    .map(|c| ChunkCue {
                        text: fix_roster_names(&c.text, &ctx.roster),
                        ..c
                    })
                    .collect();
                // Traductions publiées dans l'ordre : la précédente se termine d'abord.
                if let Some((_, h)) = inflight.take() {
                    join_translation(h).await?;
                }
                if overlap_enabled() {
                    let c = ctx.clone();
                    inflight = Some((
                        plan.index,
                        tokio::spawn(async move { c.translate_and_publish(&plan, cues).await }),
                    ));
                } else {
                    ctx.translate_and_publish(&plan, cues).await?;
                }
            }
            if let Some((_, h)) = inflight.take() {
                join_translation(h).await?;
            }
            // Piste complète : les lignes restées en anglais lors d'un travail
            // précédent sont retentées pendant que le traducteur est chargé.
            if !paused {
                let attempted = locked(&ctx.attempted).clone();
                let left = self
                    .db()
                    .with(|c| cdb::untranslated_commentary_cues(c, job.match_id))
                    .map_err(db_err)?
                    .into_iter()
                    .filter(|c| !attempted.contains(&c.seq))
                    .count();
                if left > 0 {
                    ctx.open_mt().await?;
                }
                let r = report.clone();
                self.translate_leftovers(
                    job.match_id,
                    &cfg,
                    deps,
                    &leftover_ctx,
                    &move |d| r(CommentaryPhase::Traduction, d, left as f64),
                    &attempted,
                )
                .await?;
            }
            Ok(paused)
        }
        .await;
        // Arrêt sur erreur ou interruption : la traduction en cours ne survit pas au travail.
        if let Some((_, h)) = inflight.take() {
            h.abort();
            let _ = h.await;
        }
        for (_, h) in prefetched.drain() {
            let _ = h.await;
        }
        ctx.close_asr().await;
        ctx.close_mt().await;
        let paused = match outcome {
            Ok(p) => p,
            Err(RunFail::Stream(msg)) => return Ok(self.network_outcome(&msg, job.match_id)),
            Err(RunFail::Err(e)) => return Err(e),
        };

        let minutes = js::max(1.0, js::round(t0.elapsed().as_millis() as f64 / 60_000.0));
        if paused {
            return Ok(CommentaryOutcome::paused(format!(
                "en pause ({}/{total} tronçons traduits) : plus personne ne regarde, ou hors de la fenêtre de pré-traduction",
                locked(&done).len()
            )));
        }
        let t = self.track(job.match_id);
        let Some(t) = t.filter(|t| t.cues != 0) else {
            return Ok(CommentaryOutcome::failed(
                FailureKind::Contenu,
                "Aucune parole détectée dans le replay (transcription vide après filtrage)",
            ));
        };
        // Dossier de travail effacé ; le son complet reste si ce match va être doublé.
        if self.dub_wants_audio(job.match_id) && full_audio_file(&ok_id).exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    if e.file_name() != "full.ogg" {
                        let p = e.path();
                        let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
                    }
                }
            }
        } else {
            self.forget_full_audio(&ok_id);
            let _ = std::fs::remove_dir_all(&dir);
        }
        Ok(CommentaryOutcome::ok(format!(
            "{} sous-titres traduits{} ; {total} tronçon(s), {} lot(s) ; {} + {} ; {} min",
            t.cues,
            if t.untranslated != 0 {
                format!(" ({} sans traduction, non affichés)", t.untranslated)
            } else {
                String::new()
            },
            ctx.batches.load(Ordering::SeqCst),
            cfg.transcribe_model,
            cfg.translate_model,
            crate::jsval::js_number_string(minutes)
        )))
    }
}
