//! Clients de la transcription et de la traduction des commentaires
//! (équivalent de `commentaryAi.ts`).
//!
//! - Transcription : serveur compatible OpenAI (speaches) —
//!   `POST {TRANSCRIBE_URL}/audio/transcriptions` (multipart), réponse
//!   `verbose_json` ; ou Whisper embarqué ([`super::local_ai::WhisperSession`]).
//! - Traduction : Ollama (API native `/api/chat` ou `/api/generate` pour
//!   l'Ollama embarqué, `/chat/completions` pour un serveur externe), API
//!   OpenAI si une clé est configurée, ou MiniMax si demandé.
//!
//! Deux natures d'échec : [`ServiceError`] (serveur injoignable, HTTP 5xx,
//! modèle absent… — le travail s'arrête et sera repris plus tard), et
//! réponse du LLM inexploitable (nouvel essai du lot, puis moitiés, puis la
//! ligne seule en texte brut, et enfin l'anglais, marqué `untranslated`).
//!
//! Prompts et corps des requêtes : identiques à l'octet à ceux de Node
//! (vérifié par `tests/media_node.rs` sur des sorties du code TypeScript).

use super::abort::{is_aborted, sleep, wait_aborted, AbortSignal};
use super::commentary_cues::{parse_verbose_json, Transcript};
use super::local_ai::{
    ai_client, embedded_ollama_available, embedded_ollama_url, embedded_parakeet_available,
    embedded_whisper_available, PARAKEET_MODEL,
};
use super::roster_names::{name_rendered, RosterIndex};
use crate::api::js_num_value;
use crate::js::{self, jsre};
use crate::jsval::{js_parse, js_string};
use crate::settings::{self, env, env_trim, keys, Settings};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

// ---------------------------------------------------------------- configuration

/// Whisper large-v3-turbo (CTranslate2), ~1,6 Go en fp16.
pub const DEFAULT_TRANSCRIBE_MODEL: &str = "deepdml/faster-whisper-large-v3-turbo-ct2";
/// TranslateGemma 12B (Ollama `translategemma:12b`).
pub const DEFAULT_TRANSLATE_MODEL: &str = "translategemma:12b";
/// Lignes précédentes données au modèle pour le sens (non traduites).
pub const CONTEXT_LINES: usize = 5;
/// Modèle OpenAI par défaut.
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-5.4-mini";
pub const OPENAI_URL: &str = "https://api.openai.com/v1";

/// Pilotage du modèle : `Mt` (modèle de traduction pur, complétion brute,
/// une phrase à la fois) ou `Chat` (lots de lignes en JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslateEngine {
    Mt,
    Chat,
}

/// Service embarqué dans le conteneur, ou serveur externe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceMode {
    Embedded,
    Remote,
}

/// Qui traduit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslateProvider {
    Ollama,
    Openai,
    Minimax,
}

impl TranslateEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            TranslateEngine::Mt => "mt",
            TranslateEngine::Chat => "chat",
        }
    }
}

impl ServiceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceMode::Embedded => "embedded",
            ServiceMode::Remote => "remote",
        }
    }
}

impl TranslateProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            TranslateProvider::Ollama => "ollama",
            TranslateProvider::Openai => "openai",
            TranslateProvider::Minimax => "minimax",
        }
    }
}

/// Configuration de la traduction des commentaires (`CommentaryConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryConfig {
    pub transcribe_mode: ServiceMode,
    pub translate_mode: ServiceMode,
    pub transcribe_url: String,
    pub transcribe_model: String,
    pub translate_url: String,
    pub translate_model: String,
    pub translate_engine: TranslateEngine,
    pub translate_provider: TranslateProvider,
    /// Jeton `Bearer` du serveur de traduction (clé OpenAI/MiniMax, ou TRANSLATE_API_KEY).
    pub translate_api_key: String,
    /// Sous-titres par requête de traduction.
    pub batch: usize,
    /// Lots traduits en même temps.
    pub parallel: usize,
    /// Durée d'un tronçon audio (s).
    pub chunk_sec: u32,
    /// Raison de l'inactivité de la fonctionnalité, ou `None` si elle est active.
    pub disabled_reason: Option<String>,
}

impl CommentaryConfig {
    /// Forme de l'objet Node (clés en camelCase), pour les journaux et les tests.
    pub fn to_json(&self) -> Value {
        json!({
            "transcribeMode": self.transcribe_mode.as_str(),
            "translateMode": self.translate_mode.as_str(),
            "transcribeUrl": self.transcribe_url,
            "transcribeModel": self.transcribe_model,
            "translateUrl": self.translate_url,
            "translateModel": self.translate_model,
            "translateEngine": self.translate_engine.as_str(),
            "translateProvider": self.translate_provider.as_str(),
            "translateApiKey": self.translate_api_key,
            "batch": self.batch,
            "parallel": self.parallel,
            "chunkSec": self.chunk_sec,
            "disabledReason": self.disabled_reason,
        })
    }
}

/// `intEnv` : entier borné d'une variable, `def` si absente, vide ou non numérique.
pub(crate) fn int_env(name: &str, def: f64, min: f64, max: f64) -> f64 {
    match env(name) {
        Some(v) if !v.is_empty() => {
            let n = crate::api::js_number(&v);
            if n.is_finite() {
                js::min(max, js::max(min, n.trunc()))
            } else {
                def
            }
        }
        _ => def,
    }
}

fn trim_url(s: Option<String>) -> String {
    let t = s.unwrap_or_default();
    js::trim(&t).trim_end_matches('/').to_string()
}

/// Requêtes de traduction simultanées (`TRANSLATE_PARALLEL`, 2 par défaut).
pub fn translate_parallel() -> usize {
    int_env("TRANSLATE_PARALLEL", 2.0, 1.0, 8.0) as usize
}

/// `engineFor` : moteur forcé (`TRANSLATE_ENGINE`), sinon 'mt' pour MiLMMT.
pub fn engine_for(model: &str, forced: Option<&str>) -> TranslateEngine {
    match forced.map(|f| js::trim(f).to_lowercase()).as_deref() {
        Some("mt") => TranslateEngine::Mt,
        Some("chat") => TranslateEngine::Chat,
        _ if jsre!("milmmt", "i").is_match(model) => TranslateEngine::Mt,
        _ => TranslateEngine::Chat,
    }
}

/// Service de traduction en ligne : adresse, clé, modèle.
#[derive(Debug, Clone, PartialEq)]
pub struct OnlineTranslator {
    pub url: String,
    pub key: String,
    pub model: String,
}

/// `openAiConfig` : clé et modèle OpenAI (réglages de la page, prioritaires,
/// sinon OPENAI_API_KEY / OPENAI_MODEL) ; `None` sans clé.
pub fn openai_config(s: &Settings) -> Option<(String, String)> {
    let key = s
        .get(keys::OPENAI_API_KEY)
        .map(|k| js::trim(k).to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| env_trim("OPENAI_API_KEY"))?;
    let model = s
        .get(keys::OPENAI_MODEL)
        .map(|k| js::trim(k).to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| env_trim("OPENAI_MODEL"))
        .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.into());
    Some((key, model))
}

/// `minimaxTranslateConfig` : traduction par MiniMax demandée ET une clé
/// MiniMax présente ; `None` sinon (et si les réglages sont illisibles).
pub fn minimax_translate_config(s: &Settings) -> Option<OnlineTranslator> {
    if !s.is_readable() || !settings::minimax_translate_wanted(s) {
        return None;
    }
    let mm = super::voice_minimax::minimax_config(s);
    (!mm.key.is_empty()).then(|| OnlineTranslator {
        url: format!("{}/v1", mm.url),
        key: mm.key,
        model: settings::minimax_translate_model(s),
    })
}

/// `commentaryConfig`.
pub fn commentary_config(s: &Settings) -> CommentaryConfig {
    let minimax = minimax_translate_config(s);
    let openai = if minimax.is_some() {
        None
    } else {
        openai_config(s)
    };
    let online = minimax.clone().or_else(|| {
        openai.as_ref().map(|(key, model)| OnlineTranslator {
            url: OPENAI_URL.into(),
            key: key.clone(),
            model: model.clone(),
        })
    });
    let translate_model = match &online {
        Some(o) => o.model.clone(),
        None => env_trim("TRANSLATE_MODEL").unwrap_or_else(|| DEFAULT_TRANSLATE_MODEL.into()),
    };
    let remote_asr = trim_url(env("TRANSCRIBE_URL"));
    let remote_mt = match &online {
        Some(o) => o.url.clone(),
        None => trim_url(env("TRANSLATE_URL")),
    };
    // Moteur embarqué choisi dans les Paramètres : Whisper (défaut) ou NVIDIA
    // Parakeet ; `TRANSCRIBE_MODEL` l'emporte, et un serveur externe
    // (`TRANSCRIBE_URL`) garde son propre modèle.
    let nvidia = remote_asr.is_empty()
        && env_trim("TRANSCRIBE_MODEL").is_none()
        && crate::settings::transcribe_engine(s) == "nvidia";
    let asr_ok = !remote_asr.is_empty()
        || if nvidia {
            embedded_parakeet_available()
        } else {
            embedded_whisper_available()
        };
    let mt_ok = !remote_mt.is_empty() || embedded_ollama_available();
    let disabled_reason = if env("COMMENTARY_DISABLED").as_deref() == Some("1") {
        Some("traduction des commentaires désactivée (COMMENTARY_DISABLED=1)")
    } else if !asr_ok && !mt_ok {
        Some("serveurs de transcription et de traduction non configurés (TRANSCRIBE_URL, TRANSLATE_URL)")
    } else if !asr_ok {
        Some("serveur de transcription non configuré (TRANSCRIBE_URL)")
    } else if !mt_ok {
        Some("serveur de traduction non configuré (TRANSLATE_URL)")
    } else {
        None
    };
    let mode = |remote: &str| {
        if remote.is_empty() {
            ServiceMode::Embedded
        } else {
            ServiceMode::Remote
        }
    };
    CommentaryConfig {
        transcribe_mode: mode(&remote_asr),
        translate_mode: mode(&remote_mt),
        transcribe_url: remote_asr.clone(),
        transcribe_model: if nvidia {
            PARAKEET_MODEL.into()
        } else {
            env_trim("TRANSCRIBE_MODEL").unwrap_or_else(|| DEFAULT_TRANSCRIBE_MODEL.into())
        },
        translate_url: if remote_mt.is_empty() {
            format!("{}/v1", embedded_ollama_url())
        } else {
            remote_mt.clone()
        },
        translate_engine: if online.is_some() {
            TranslateEngine::Chat
        } else {
            engine_for(&translate_model, env("TRANSLATE_ENGINE").as_deref())
        },
        translate_model,
        translate_provider: if minimax.is_some() {
            TranslateProvider::Minimax
        } else if openai.is_some() {
            TranslateProvider::Openai
        } else {
            TranslateProvider::Ollama
        },
        translate_api_key: match &online {
            Some(o) => o.key.clone(),
            None => env_trim("TRANSLATE_API_KEY").unwrap_or_default(),
        },
        batch: int_env("TRANSLATE_BATCH", 14.0, 1.0, 60.0) as usize,
        parallel: if online.is_some() {
            // API en ligne (MiniMax, OpenAI) : 8 lots à la fois par défaut, comme Node.
            int_env("TRANSLATE_PARALLEL", 8.0, 1.0, 16.0) as usize
        } else {
            translate_parallel()
        },
        chunk_sec: int_env("COMMENTARY_CHUNK_SEC", 120.0, 30.0, 3600.0) as u32,
        disabled_reason: disabled_reason.map(String::from),
    }
}

/// Service local ou en ligne injoignable ou en erreur.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Transcription,
    Traduction,
}

/// `ServiceError` : le travail s'arrête et sera repris plus tard.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceError {
    pub message: String,
    pub service: Service,
}

impl ServiceError {
    fn new(message: impl Into<String>, service: Service) -> Self {
        ServiceError {
            message: message.into(),
            service,
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Erreur de [`transcribe_audio`] : service en cause, ou autre (fichier illisible…).
#[derive(Debug, Clone, PartialEq)]
pub enum AiError {
    Service(ServiceError),
    Other(String),
}

impl AiError {
    pub fn message(&self) -> &str {
        match self {
            AiError::Service(e) => &e.message,
            AiError::Other(m) => m,
        }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// `fetchErrorText` : cause lisible d'un échec réseau (`ECONNREFUSED`, délai…).
fn fetch_error_text(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "délai dépassé".into();
    }
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return "ECONNREFUSED".into(),
                std::io::ErrorKind::ConnectionReset => return "ECONNRESET".into(),
                std::io::ErrorKind::TimedOut => return "ETIMEDOUT".into(),
                std::io::ErrorKind::ConnectionAborted => return "ECONNABORTED".into(),
                _ => {}
            }
        }
        if s.to_string().contains("dns error") {
            return "ENOTFOUND".into();
        }
        src = s.source();
    }
    "fetch failed".into()
}

enum Sent {
    Ok(reqwest::Response),
    /// Échec réseau : texte de `fetchErrorText`.
    Failed(String),
}

/// Envoie une requête sous délai et interruption.
async fn send(
    req: reqwest::RequestBuilder,
    timeout: Duration,
    signal: Option<&AbortSignal>,
) -> Sent {
    tokio::select! {
        r = req.timeout(timeout).send() => match r {
            Ok(r) => Sent::Ok(r),
            Err(e) => Sent::Failed(fetch_error_text(&e)),
        },
        _ = wait_aborted(signal) => Sent::Failed("interrompu".into()),
    }
}

/// Corps de la réponse (`res.text()`), `None` si sa lecture échoue.
async fn body_text(res: reqwest::Response, signal: Option<&AbortSignal>) -> Option<String> {
    tokio::select! {
        t = res.text() => t.ok(),
        _ = wait_aborted(signal) => None,
    }
}

/// `(await res.text()).replace(/\s+/g, ' ').slice(0, 200)`.
fn detail_of(text: Option<String>) -> String {
    let t = text.unwrap_or_default();
    js::slice_utf16(&jsre!(r"\s+").replace_all(&t, " "), 200)
}

fn with_detail(head: String, detail: &str) -> String {
    if detail.is_empty() {
        head
    } else {
        format!("{head} — {detail}")
    }
}

fn ms(d: Option<Duration>, def: u64) -> u64 {
    d.map_or(def, |d| d.as_millis() as u64)
}

// ---------------------------------------------------------------- transcription

/// Options de [`transcribe_audio`].
#[derive(Clone, Default)]
pub struct TranscribeOptions {
    /// Prompt initial de Whisper (noms des équipes et des joueurs).
    pub prompt: Option<String>,
    pub signal: Option<AbortSignal>,
    /// Délai max d'un tronçon (`TRANSCRIBE_TIMEOUT_MS`, 20 min par défaut).
    pub timeout: Option<Duration>,
    /// Attente avant le nouvel essai après une erreur réseau ou 5xx (3 s).
    pub retry_delay: Option<Duration>,
}

/// `transcribeAudio` : transcrit un tronçon par le serveur externe. Une
/// erreur réseau ou 5xx est retentée une fois ; au-delà, [`ServiceError`].
pub async fn transcribe_audio(
    file: &str,
    cfg: &CommentaryConfig,
    o: &TranscribeOptions,
) -> Result<Transcript, AiError> {
    let audio = tokio::fs::read(file).await.map_err(|e| {
        AiError::Other(match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("ENOENT: no such file or directory, open '{file}'")
            }
            _ => e.to_string(),
        })
    })?;
    let url = format!("{}/audio/transcriptions", cfg.transcribe_url);
    let timeout = o.timeout.unwrap_or_else(|| {
        Duration::from_millis(
            int_env("TRANSCRIBE_TIMEOUT_MS", 1_200_000.0, 10_000.0, 21_600_000.0) as u64,
        )
    });
    let signal = o.signal.as_ref();
    let svc = |m: String| AiError::Service(ServiceError::new(m, Service::Transcription));
    let name = file
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("audio.ogg")
        .to_string();
    let mime = if file.ends_with(".mp3") {
        "audio/mpeg"
    } else {
        "audio/ogg"
    };
    let mut last = String::new();
    for _attempt in 0..2 {
        if is_aborted(signal) {
            return Err(svc("transcription interrompue".into()));
        }
        let part = reqwest::multipart::Part::bytes(audio.clone())
            .file_name(name.clone())
            .mime_str(mime)
            .map_err(|e| AiError::Other(e.to_string()))?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", cfg.transcribe_model.clone())
            .text("language", "en")
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "segment")
            .text("timestamp_granularities[]", "word")
            .text("temperature", "0");
        if let Some(p) = o.prompt.as_deref().filter(|p| !p.is_empty()) {
            form = form.text("prompt", p.to_string());
        }
        let mut req = ai_client().post(&url).multipart(form);
        if let Some(k) = env("TRANSCRIBE_API_KEY").filter(|k| !k.is_empty()) {
            req = req.header("Authorization", format!("Bearer {k}"));
        }
        let res = match send(req, timeout, signal).await {
            Sent::Ok(r) => r,
            Sent::Failed(why) => {
                last = format!(
                    "serveur de transcription injoignable ({}) : {why}",
                    cfg.transcribe_url
                );
                if is_aborted(signal) {
                    break;
                }
                sleep(ms(o.retry_delay, 3000), signal).await;
                continue;
            }
        };
        let status = res.status().as_u16();
        if res.status().is_success() {
            let body = body_text(res, signal).await.and_then(|t| js_parse(&t));
            let Some(body) = body else {
                return Err(svc("réponse de transcription illisible (JSON attendu, response_format=verbose_json)".into()));
            };
            let has = |k: &str| body.as_object().is_some_and(|o| o.contains_key(k));
            if !body.is_object() || (!has("segments") && !has("words") && !has("text")) {
                return Err(svc(
                    "réponse de transcription inattendue (ni segments ni texte)".into(),
                ));
            }
            return Ok(parse_verbose_json(&body));
        }
        let detail = detail_of(body_text(res, signal).await);
        last = with_detail(format!("serveur de transcription : HTTP {status}"), &detail);
        if status < 500 {
            break;
        }
        sleep(ms(o.retry_delay, 3000), signal).await;
    }
    Err(svc(if last.is_empty() {
        "transcription impossible".into()
    } else {
        last
    }))
}

/// `whisperPrompt` : contexte et orthographe des noms propres (tronqué à 600 caractères).
pub fn whisper_prompt<S: AsRef<str>>(home: &str, away: &str, players: &[S]) -> String {
    let base = format!("NBA basketball game commentary: {away} at {home}.");
    let mut out = base.clone();
    for p in players {
        let next = format!(
            "{out}{}{}",
            if out == base { " " } else { ", " },
            p.as_ref()
        );
        if js::utf16_len(&next) > 600 {
            break;
        }
        out = next;
    }
    if out == base {
        out
    } else {
        format!("{out}.")
    }
}

// ---------------------------------------------------------------- traduction

/// Prompt système par défaut de la traduction (texte exact de Node).
pub const TRANSLATE_SYSTEM_PROMPT: &str = include_str!("translate_prompt.txt");

/// Prompt effectif : fichier `TRANSLATE_PROMPT_FILE` s'il est lisible, sinon le prompt par défaut.
pub fn translate_system_prompt() -> String {
    if let Some(file) = env_trim("TRANSLATE_PROMPT_FILE") {
        match std::fs::read_to_string(&file) {
            Ok(t) => {
                let t = js::trim(&t);
                if !t.is_empty() {
                    return t.to_string();
                }
            }
            Err(e) => eprintln!(
                "[commentaires] prompt {file} illisible, prompt par défaut utilisé : {}",
                if e.kind() == std::io::ErrorKind::NotFound {
                    format!("ENOENT: no such file or directory, open '{file}'")
                } else {
                    e.to_string()
                }
            ),
        }
    }
    TRANSLATE_SYSTEM_PROMPT.to_string()
}

/// Dernier recours pour une ligne : mêmes consignes basket, réponse en texte brut.
pub fn plain_translate_prompt() -> &'static str {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
        let p = TRANSLATE_SYSTEM_PROMPT;
        let cut = p.rfind("\n\nRéponds uniquement").unwrap_or(p.len());
        format!("{}\n\nRéponds uniquement avec la traduction française de la ligne demandée, sur une seule ligne : ni guillemets, ni étiquette, ni explication.", &p[..cut])
    })
}

/// Qwen3 « réfléchit » à voix haute par défaut : `/no_think` le coupe.
pub fn needs_no_think(model: &str) -> bool {
    jsre!("qwen3", "i").is_match(model)
}

/// Ligne à traduire.
#[derive(Debug, Clone, PartialEq)]
pub struct TranslateLine {
    pub i: i64,
    pub en: String,
}

/// Contexte d'une traduction.
#[derive(Clone, Default)]
pub struct TranslateContext {
    /// Match en cours (« Memphis Grizzlies @ Portland Trail Blazers »).
    pub match_label: Option<String>,
    /// Effectif du match (donné au LLM, toléré par le contrôle des noms).
    pub roster: Option<RosterIndex>,
    pub signal: Option<AbortSignal>,
    pub timeout: Option<Duration>,
    /// Attente avant le nouvel essai après une erreur réseau ou 5xx (3 s).
    pub retry_delay: Option<Duration>,
}

/// `buildUserMessage` : contexte à ne pas traduire, puis lignes, en JSON.
pub fn build_user_message(
    lines: &[TranslateLine],
    context: &[String],
    model: &str,
    roster: Option<&RosterIndex>,
    match_label: Option<&str>,
) -> String {
    let mut payload = Map::new();
    if let Some(m) = match_label.filter(|m| !m.is_empty()) {
        payload.insert("match".into(), Value::from(m));
    }
    if let Some(r) = roster.filter(|r| !r.full.is_empty()) {
        payload.insert("joueurs".into(), json!(r.full));
    }
    payload.insert("context".into(), json!(context));
    payload.insert(
        "lines".into(),
        Value::Array(
            lines
                .iter()
                .map(|l| json!({ "i": l.i, "en": l.en }))
                .collect(),
        ),
    );
    format!(
        "Traduis ces lignes. Réponds uniquement avec le JSON demandé.\n{}{}",
        Value::Object(payload),
        if needs_no_think(model) {
            "\n/no_think"
        } else {
            ""
        }
    )
}

/// `buildPlainMessage` : une seule ligne, en texte brut.
pub fn build_plain_message(
    en: &str,
    context: &[String],
    model: &str,
    roster: Option<&RosterIndex>,
    match_label: Option<&str>,
) -> String {
    let mut parts =
        vec!["Traduis cette ligne en français. Réponds uniquement avec la traduction.".to_string()];
    if let Some(m) = match_label.filter(|m| !m.is_empty()) {
        parts.push(format!("match : {m}"));
    }
    if let Some(r) = roster.filter(|r| !r.full.is_empty()) {
        parts.push(format!("joueurs : {}", r.full.join(", ")));
    }
    if !context.is_empty() {
        parts.push(format!(
            "context (à ne pas traduire) :\n{}",
            context.join("\n")
        ));
    }
    parts.push(format!("ligne :\n{en}"));
    format!(
        "{}{}",
        parts.join("\n\n"),
        if needs_no_think(model) {
            "\n/no_think"
        } else {
            ""
        }
    )
}

fn strip_think(content: &str) -> String {
    let re = jsre!(r"<think>[\s\S]*?</think>", "i");
    js::trim(&re.replace_all(content, "")).to_string()
}

/// Préfixes de refus (`REFUSAL`), suivis d'autre chose qu'une lettre.
const REFUSALS: [&str; 13] = [
    "je suis désolée",
    "je suis désolé",
    "désolée",
    "désolé",
    "je ne peux pas",
    "je ne suis pas",
    "i'm sorry",
    "im sorry",
    "i am sorry",
    "sorry",
    "i cannot",
    "i can't",
    "as an ai",
];

/// `REFUSAL.test(s)` : refus ou excuse du modèle à la place d'une traduction.
fn is_refusal(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    REFUSALS.iter().any(|p| {
        let pc: Vec<char> = p.chars().collect();
        if chars.len() < pc.len() {
            return false;
        }
        let same = chars
            .iter()
            .zip(&pc)
            .all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()));
        same && chars
            .get(pc.len())
            .is_none_or(|c| !jsre!(r"^\p{L}$").is_match(&c.to_string()))
    })
}

/// `parsePlainTranslation` : bloc <think>, balises ```, étiquette et
/// guillemets retirés ; un JSON n'est lu que s'il ne contient qu'une
/// traduction. Rend '' pour un refus ou une réponse inexploitable.
pub fn parse_plain_translation(content: &str) -> String {
    let mut s = strip_think(content);
    if let Some(c) = jsre!(r"```(?:\w+)?\s*([\s\S]*?)```").captures(&s) {
        s = js::trim(&c[1]).to_string();
    }
    if s.starts_with('[') || s.starts_with('{') {
        let found = parse_translation(&s);
        if found.len() == 1 {
            return found.values().next().cloned().unwrap_or_default();
        }
        let Some(Value::Object(o)) = js_parse(&s) else {
            return String::new();
        };
        let v = [o.get("fr"), o.get("traduction"), o.get("translation")]
            .into_iter()
            .find(|v| !matches!(v, None | Some(Value::Null)))
            .flatten();
        return match v {
            Some(Value::String(t)) => squash(t),
            _ => String::new(),
        };
    }
    let s1 = jsre!(
        r"^(?:traduction(?: française)?|français|french|fr)\s*:\s*",
        "i"
    )
    .replace(&s, "");
    let mut s = squash(&s1);
    if let Some(c) = jsre!(r#"^(?:«\s*(.*?)\s*»|"(.*)"|“(.*)”)$"#).captures(&s) {
        let inner = c
            .get(1)
            .or_else(|| c.get(2))
            .or_else(|| c.get(3))
            .map_or("", |m| m.as_str());
        s = js::trim(inner).to_string();
    }
    if is_refusal(&s) {
        String::new()
    } else {
        s
    }
}

/// `s.replace(/\s+/g, ' ').trim()`.
fn squash(s: &str) -> String {
    js::trim(&jsre!(r"\s+").replace_all(s, " ")).to_string()
}

/// `parseTranslation` : extrait les traductions (id → texte) d'une réponse de
/// LLM même mal emballée : bloc <think>, balises ```, texte autour du JSON,
/// tableau nu, clés approchantes. Vide si rien d'exploitable.
pub fn parse_translation(content: &str) -> IndexMap<i64, String> {
    let mut out = IndexMap::new();
    let mut s = strip_think(content);
    if let Some(c) = jsre!(r"```(?:json)?\s*([\s\S]*?)```", "i").captures(&s) {
        s = js::trim(&c[1]).to_string();
    }
    let mut data = js_parse(&s);
    if data.is_none() {
        if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
            if b > a {
                data = js_parse(&s[a..=b]);
            }
        }
    }
    if data.is_none() {
        if let (Some(a), Some(b)) = (s.find('['), s.rfind(']')) {
            if b > a {
                data = js_parse(&s[a..=b]);
            }
        }
    }
    let list = match &data {
        Some(Value::Object(o)) => ["t", "translations", "lignes", "lines"]
            .iter()
            .map(|k| o.get(*k))
            .find(|v| !matches!(v, None | Some(Value::Null)))
            .flatten()
            .or_else(|| o.values().find(|v| v.is_array())),
        other => other.as_ref(),
    };
    let Some(Value::Array(list)) = list else {
        return out;
    };
    for item in list {
        let r = match item {
            Value::Object(r) => r,
            Value::Array(_) => continue,
            _ => continue,
        };
        let id_v = crate::jsval::or_else(r.get("i"), r.get("id"));
        let id = js::to_number(id_v);
        let fr = [r.get("fr"), r.get("text"), r.get("translation")]
            .into_iter()
            .find(|v| !matches!(v, None | Some(Value::Null)))
            .flatten();
        if let (true, Some(Value::String(fr))) = (id.is_finite() && id.fract() == 0.0, fr) {
            out.insert(id as i64, squash(fr));
        }
    }
    out
}

/// Minuscules sans accents ni ponctuation (comparaisons tolérantes).
fn fold(s: &str) -> String {
    let no_marks: String = s
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    let lower = no_marks.to_lowercase();
    let spaced = jsre!(r"[^\p{L}\p{N}\s]").replace_all(&lower, " ");
    squash(&spaced)
}

/// `validTranslation` : une traduction est-elle acceptable pour cette ligne ?
pub fn valid_translation(en: &str, fr: Option<&str>) -> bool {
    let Some(fr) = fr.filter(|f| !f.is_empty()) else {
        return false;
    };
    if !jsre!(r"[\p{L}\p{N}]").is_match(fr) {
        return false;
    }
    if js::utf16_len(fr) as f64 > js::utf16_len(en) as f64 * 2.2 + 30.0 {
        return false;
    }
    if jsre!(r#""(i|fr|en)"\s*:"#).is_match(fr) {
        return false;
    }
    let words = jsre!(r"\s+").split(js::trim(en)).count();
    if words >= 4 && fold(fr) == fold(en) {
        return false;
    }
    true
}

/// Mots qu'un commentateur écrit avec une majuscule sans que ce soit un nom propre.
const NOT_NAMES: [&str; 14] = [
    "i", "i'm", "i've", "i'll", "i'd", "ok", "okay", "oh", "mr", "mrs", "god", "lord", "game",
    "coach",
];

/// Noms propres et chiffres d'une ligne anglaise.
#[derive(Debug, Clone, PartialEq)]
pub struct Anchors {
    pub numbers: Vec<String>,
    /// 5 premières lettres pliées de chaque nom.
    pub names: Vec<String>,
}

/// `anchors` : chaque nombre, et chaque mot à majuscule qui n'ouvre pas une phrase.
pub fn anchors(en: &str) -> Anchors {
    let numbers = jsre!(r"\d+")
        .find_iter(en)
        .map(|m| m.as_str().to_string())
        .collect();
    let tokens: Vec<&str> = jsre!(r"\s+").split(en).filter(|t| !t.is_empty()).collect();
    let mut names = Vec::new();
    for (k, tok) in tokens.iter().enumerate() {
        let w1 = jsre!(r"^[^\p{L}]+|[^\p{L}']+$").replace_all(tok, "");
        let word = jsre!(r"'s$", "i").replace(&w1, "").into_owned();
        if !jsre!(r"^\p{Lu}").is_match(&word) || js::utf16_len(&word) < 2 {
            continue;
        }
        let Some(prev) = k.checked_sub(1).map(|p| tokens[p]) else {
            continue;
        };
        if jsre!(r#"[.!?…:"“]$"#).is_match(prev) {
            continue;
        }
        if NOT_NAMES.contains(&word.to_lowercase().as_str()) {
            continue;
        }
        names.push(js::slice_utf16(&fold(&word), 5));
    }
    Anchors { numbers, names }
}

/// `consistentTranslation` : la traduction garde-t-elle les chiffres et les
/// noms de la ligne (un nom corrigé vers un joueur proche compte comme rendu) ?
pub fn consistent_translation(en: &str, fr: &str, roster: Option<&RosterIndex>) -> bool {
    let a = anchors(en);
    let fr_digits: Vec<&str> = jsre!(r"\d+").find_iter(fr).map(|m| m.as_str()).collect();
    if a.numbers.iter().any(|n| !fr_digits.contains(&n.as_str())) {
        return false;
    }
    let f = format!(" {}", fold(fr));
    a.names.iter().all(|n| name_rendered(n, &f, roster))
}

/// `schemaSafe` : schéma JSON imposé sans décaler les lignes (Gemma 4 E2B/E4B ;
/// `TRANSLATE_JSON_SCHEMA` = 1 / 0 pour forcer).
pub fn schema_safe(model: &str) -> bool {
    match env_trim("TRANSLATE_JSON_SCHEMA").as_deref() {
        Some("1") => true,
        Some("0") => false,
        _ => jsre!(r"gemma4:e[24]b", "i").is_match(model),
    }
}

fn translation_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "t": {
                "type": "array",
                "items": { "type": "object", "properties": { "i": { "type": "integer" }, "fr": { "type": "string" } }, "required": ["i", "fr"] },
            },
        },
        "required": ["t"],
    })
}

/// TranslateGemma n'accepte qu'un message utilisateur : gabarit Gemma brut.
pub fn needs_raw_gemma(model: &str) -> bool {
    jsre!("translategemma", "i").is_match(model)
}

pub fn gemma_raw_prompt(system: &str, user: &str) -> String {
    format!("<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n<start_of_turn>model\n")
}

/// Adresse de la requête de [`chat_completion`].
pub fn chat_url(cfg: &CommentaryConfig) -> String {
    let native = cfg.translate_mode == ServiceMode::Embedded;
    if native && needs_raw_gemma(&cfg.translate_model) {
        format!("{}/api/generate", ollama_base(&cfg.translate_url))
    } else if native {
        format!("{}/api/chat", ollama_base(&cfg.translate_url))
    } else {
        format!("{}/chat/completions", cfg.translate_url)
    }
}

/// Corps exact (JSON) de la requête de [`chat_completion`].
pub fn chat_body(
    system: &str,
    user: &str,
    cfg: &CommentaryConfig,
    temperature: f64,
    json_mode: bool,
) -> String {
    let native = cfg.translate_mode == ServiceMode::Embedded;
    let raw = native && needs_raw_gemma(&cfg.translate_model);
    let t = js_num_value(temperature);
    let messages = json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user },
    ]);
    let mut b = Map::new();
    b.insert("model".into(), Value::from(cfg.translate_model.clone()));
    if raw {
        b.insert("prompt".into(), Value::from(gemma_raw_prompt(system, user)));
        b.insert("raw".into(), Value::Bool(true));
        b.insert("stream".into(), Value::Bool(false));
        b.insert("keep_alive".into(), Value::from("10m"));
        b.insert(
            "options".into(),
            json!({ "temperature": t, "top_p": 0.9, "num_ctx": 4096, "num_predict": 1200, "stop": ["<end_of_turn>"] }),
        );
    } else if native {
        b.insert("messages".into(), messages);
        b.insert("stream".into(), Value::Bool(false));
        b.insert("keep_alive".into(), Value::from("10m"));
        if json_mode && schema_safe(&cfg.translate_model) {
            b.insert("format".into(), translation_schema());
        }
        b.insert(
            "options".into(),
            json!({ "temperature": t, "top_p": 0.9, "num_ctx": 4096, "num_predict": 1200 }),
        );
    } else if cfg.translate_provider == TranslateProvider::Openai {
        b.insert("messages".into(), messages);
        b.insert("stream".into(), Value::Bool(false));
        if json_mode {
            b.insert("response_format".into(), json!({ "type": "json_object" }));
        }
        if jsre!(r"^(gpt-5|o\d)", "i").is_match(&cfg.translate_model) {
            b.insert("reasoning_effort".into(), Value::from("low"));
        } else {
            b.insert("temperature".into(), t);
        }
    } else if cfg.translate_provider == TranslateProvider::Minimax {
        b.insert("messages".into(), messages);
        b.insert("stream".into(), Value::Bool(false));
        b.insert("temperature".into(), t);
        b.insert("reasoning_effort".into(), Value::from("low"));
    } else {
        b.insert("messages".into(), messages);
        b.insert("temperature".into(), t);
        b.insert("top_p".into(), json!(0.9));
        b.insert("stream".into(), Value::Bool(false));
        if json_mode {
            b.insert("response_format".into(), json!({ "type": "json_object" }));
        }
    }
    Value::Object(b).to_string()
}

fn post_json(url: &str, body: &str, key: &str) -> reqwest::RequestBuilder {
    let mut req = ai_client()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    req
}

fn translate_timeout(o: &TranslateContext) -> Duration {
    o.timeout.unwrap_or_else(|| {
        Duration::from_millis(
            int_env("TRANSLATE_TIMEOUT_MS", 300_000.0, 5_000.0, 3_600_000.0) as u64,
        )
    })
}

fn missing_model(cfg: &CommentaryConfig) -> String {
    format!(
        "modèle de traduction « {m} » absent d'Ollama (ollama pull {m})",
        m = cfg.translate_model
    )
}

/// `chatCompletion` : appel brut au LLM ; [`ServiceError`] si le serveur ne
/// répond pas correctement. Réponse vide ou mal formée : `''` (le lot sera retenté).
pub async fn chat_completion(
    system: &str,
    user: &str,
    cfg: &CommentaryConfig,
    o: &TranslateContext,
    temperature: f64,
    json_mode: bool,
) -> Result<String, ServiceError> {
    let native = cfg.translate_mode == ServiceMode::Embedded;
    let raw = native && needs_raw_gemma(&cfg.translate_model);
    let url = chat_url(cfg);
    let timeout = translate_timeout(o);
    let body = chat_body(system, user, cfg, temperature, json_mode);
    let signal = o.signal.as_ref();
    let minimax = cfg.translate_provider == TranslateProvider::Minimax;
    let online = minimax || cfg.translate_provider == TranslateProvider::Openai;
    let mut last = String::new();
    for _attempt in 0..2 {
        if is_aborted(signal) {
            return Err(ServiceError::new(
                "traduction interrompue",
                Service::Traduction,
            ));
        }
        let res = match send(
            post_json(&url, &body, &cfg.translate_api_key),
            timeout,
            signal,
        )
        .await
        {
            Sent::Ok(r) => r,
            Sent::Failed(why) => {
                last = format!(
                    "serveur de traduction injoignable ({}) : {why}",
                    cfg.translate_url
                );
                if is_aborted(signal) {
                    break;
                }
                sleep(ms(o.retry_delay, 3000), signal).await;
                continue;
            }
        };
        let status = res.status().as_u16();
        if res.status().is_success() {
            let data = body_text(res, signal).await.and_then(|t| js_parse(&t));
            let d = data.as_ref();
            if minimax {
                let code = js::prop(js::prop(d, "base_resp"), "status_code");
                if js::truthy(code) {
                    let code = code.cloned().unwrap_or(Value::Null);
                    let msg_v = js::prop(js::prop(d, "base_resp"), "status_msg");
                    let msg = if js::truthy(msg_v) {
                        js::string_of(msg_v)
                    } else {
                        "erreur".into()
                    };
                    let n = code.as_f64();
                    last = if n == Some(1004.0) {
                        "API MiniMax : clé refusée (vérifier la clé dans les paramètres)".into()
                    } else if n == Some(1008.0) {
                        "API MiniMax : crédit épuisé".into()
                    } else {
                        format!("API MiniMax : {msg} (code {})", js_string(&code))
                    };
                    if n == Some(1002.0) || n == Some(1039.0) {
                        sleep(ms(o.retry_delay, 10_000), signal).await;
                        continue;
                    }
                    break;
                }
            }
            let content = if raw {
                js::prop(d, "response")
            } else if native {
                js::prop(js::prop(d, "message"), "content")
            } else {
                js::prop(
                    js::prop(js::prop(js::prop(d, "choices"), "0"), "message"),
                    "content",
                )
            };
            return Ok(match content {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            });
        }
        let detail = detail_of(body_text(res, signal).await);
        let api = if minimax { "API MiniMax" } else { "API OpenAI" };
        last = if online {
            match status {
                401 => format!("{api} : clé refusée (vérifier la clé dans les paramètres)"),
                429 => format!("{api} : quota ou crédit épuisé (HTTP 429)"),
                _ => with_detail(format!("{api} : HTTP {status}"), &detail),
            }
        } else if status == 404 && jsre!("model", "i").is_match(&detail) {
            missing_model(cfg)
        } else {
            with_detail(format!("serveur de traduction : HTTP {status}"), &detail)
        };
        if status < 500 && status != 429 {
            break;
        }
        sleep(
            ms(o.retry_delay, if status == 429 { 10_000 } else { 3000 }),
            signal,
        )
        .await;
    }
    Err(ServiceError::new(
        if last.is_empty() {
            "traduction impossible".to_string()
        } else {
            last
        },
        Service::Traduction,
    ))
}

/// Ligne traduite ; `untranslated` : traduction impossible, `fr` est l'anglais (jamais affiché).
#[derive(Debug, Clone, PartialEq)]
pub struct TranslatedLine {
    pub i: i64,
    pub fr: String,
    pub untranslated: bool,
}

struct Attempt {
    got: IndexMap<i64, String>,
    missing: usize,
    suspect: usize,
}

async fn chat_attempt(
    system: &str,
    lines: &[TranslateLine],
    context: &[String],
    cfg: &CommentaryConfig,
    o: &TranslateContext,
    temperature: f64,
) -> Result<Attempt, ServiceError> {
    let user = build_user_message(
        lines,
        context,
        &cfg.translate_model,
        o.roster.as_ref(),
        o.match_label.as_deref(),
    );
    let mut raw =
        parse_translation(&chat_completion(system, &user, cfg, o, temperature, true).await?);
    // Ligne seule renvoyée sous un autre id : c'est bien elle.
    if lines.len() == 1 && raw.len() == 1 && !raw.contains_key(&lines[0].i) {
        let fr = raw.pop().map(|(_, v)| v).unwrap_or_default();
        raw.insert(lines[0].i, fr);
    }
    let mut got = IndexMap::new();
    let mut suspect = 0;
    for l in lines {
        let fr = raw.get(&l.i).map(String::as_str);
        if !valid_translation(&l.en, fr) {
            continue;
        }
        let fr = fr.unwrap_or_default();
        got.insert(l.i, fr.to_string());
        if !consistent_translation(&l.en, fr, o.roster.as_ref()) {
            suspect += 1;
        }
    }
    let extra = raw
        .keys()
        .filter(|i| !lines.iter().any(|l| l.i == **i))
        .count();
    Ok(Attempt {
        missing: lines.len() - got.len() + extra,
        got,
        suspect,
    })
}

async fn plain_attempt(
    line: &TranslateLine,
    context: &[String],
    cfg: &CommentaryConfig,
    o: &TranslateContext,
    temperature: f64,
) -> Result<Option<String>, ServiceError> {
    let user = build_plain_message(
        &line.en,
        context,
        &cfg.translate_model,
        o.roster.as_ref(),
        o.match_label.as_deref(),
    );
    let fr = parse_plain_translation(
        &chat_completion(plain_translate_prompt(), &user, cfg, o, temperature, false).await?,
    );
    Ok(valid_translation(&line.en, Some(&fr)).then_some(fr))
}

fn doubtful(r: &Attempt, n: usize) -> bool {
    r.missing > 0 || r.suspect >= 2usize.max(n.div_ceil(4))
}

fn badness(r: &Attempt) -> usize {
    r.missing * 2 + r.suspect
}

/// `translateBatch` : traduit un lot (moteur `Chat` : lot contrôlé, nouvel
/// essai, moitiés, ligne seule en texte brut, puis l'anglais marqué ; moteur
/// `Mt` : [`translate_batch_mt`]). `context` : lignes précédentes, pour le sens.
pub async fn translate_batch(
    lines: &[TranslateLine],
    context: &[String],
    cfg: &CommentaryConfig,
    o: &TranslateContext,
) -> Result<Vec<TranslatedLine>, ServiceError> {
    if cfg.translate_engine == TranslateEngine::Mt {
        return translate_batch_mt(lines, cfg, o).await;
    }
    let system = translate_system_prompt();
    translate_chat(&system, lines, context, cfg, o).await
}

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

fn translate_chat<'a>(
    system: &'a str,
    lines: &'a [TranslateLine],
    context: &'a [String],
    cfg: &'a CommentaryConfig,
    o: &'a TranslateContext,
) -> BoxFut<'a, Result<Vec<TranslatedLine>, ServiceError>> {
    Box::pin(async move {
        if lines.is_empty() {
            return Ok(Vec::new());
        }
        let mut best = chat_attempt(system, lines, context, cfg, o, 0.2).await?;
        if doubtful(&best, lines.len()) {
            let again = chat_attempt(system, lines, context, cfg, o, 0.0).await?;
            if badness(&again) < badness(&best) {
                best = again;
            }
        }
        if doubtful(&best, lines.len()) && lines.len() > 1 {
            let mid = lines.len().div_ceil(2);
            let (head, tail) = lines.split_at(mid);
            let mut a = translate_chat(system, head, context, cfg, o).await?;
            let mut ctx: Vec<String> = context.to_vec();
            ctx.extend(head.iter().map(|l| l.en.clone()));
            let ctx = ctx[ctx.len().saturating_sub(CONTEXT_LINES)..].to_vec();
            let b = translate_chat(system, tail, &ctx, cfg, o).await?;
            a.extend(b);
            return Ok(a);
        }
        if lines.len() == 1 && !best.got.contains_key(&lines[0].i) {
            let l = &lines[0];
            let fr = match plain_attempt(l, context, cfg, o, 0.2).await? {
                Some(f) => Some(f),
                None => plain_attempt(l, context, cfg, o, 0.0).await?,
            };
            if let Some(fr) = fr.filter(|f| !f.is_empty()) {
                return Ok(vec![TranslatedLine {
                    i: l.i,
                    fr,
                    untranslated: false,
                }]);
            }
        }
        Ok(lines
            .iter()
            .map(|l| match best.got.get(&l.i).filter(|f| !f.is_empty()) {
                Some(fr) => TranslatedLine {
                    i: l.i,
                    fr: fr.clone(),
                    untranslated: false,
                },
                None => TranslatedLine {
                    i: l.i,
                    fr: l.en.clone(),
                    untranslated: true,
                },
            })
            .collect())
    })
}

// ---------------------------------------------------------------- modèle de traduction pur (MiLMMT)

/// Gabarit officiel de MiLMMT-46 : complétion brute, sans chat.
pub fn mt_prompt(en: &str) -> String {
    format!("Translate this from English to French:\nEnglish: {en}\nFrench:")
}

/// Racine Ollama (`…/v1` retiré).
pub fn ollama_base(url: &str) -> String {
    url.strip_suffix("/v1").unwrap_or(url).to_string()
}

/// Corps exact (JSON) de la requête de [`mt_complete`].
pub fn mt_body(en: &str, cfg: &CommentaryConfig) -> String {
    let predict = (40 + js::utf16_len(en) * 2).min(512);
    json!({
        "model": cfg.translate_model,
        "prompt": mt_prompt(en),
        "raw": true,
        "stream": false,
        "keep_alive": "10m",
        "options": { "temperature": 0, "top_k": 1, "num_predict": predict, "stop": ["\n"] },
    })
    .to_string()
}

/// `mtComplete` : une traduction en complétion brute (`/api/generate`, `raw`), arrêt au saut de ligne.
pub async fn mt_complete(
    en: &str,
    cfg: &CommentaryConfig,
    o: &TranslateContext,
) -> Result<String, ServiceError> {
    let url = format!("{}/api/generate", ollama_base(&cfg.translate_url));
    let timeout = translate_timeout(o);
    let body = mt_body(en, cfg);
    let signal = o.signal.as_ref();
    let mut last = String::new();
    for _attempt in 0..2 {
        if is_aborted(signal) {
            return Err(ServiceError::new(
                "traduction interrompue",
                Service::Traduction,
            ));
        }
        let res = match send(
            post_json(&url, &body, &cfg.translate_api_key),
            timeout,
            signal,
        )
        .await
        {
            Sent::Ok(r) => r,
            Sent::Failed(why) => {
                last = format!(
                    "serveur de traduction injoignable ({}) : {why}",
                    cfg.translate_url
                );
                if is_aborted(signal) {
                    break;
                }
                sleep(ms(o.retry_delay, 3000), signal).await;
                continue;
            }
        };
        let status = res.status().as_u16();
        if res.status().is_success() {
            let data = body_text(res, signal).await.and_then(|t| js_parse(&t));
            return Ok(match js::prop(data.as_ref(), "response") {
                Some(Value::String(s)) => squash(s),
                _ => String::new(),
            });
        }
        let detail = detail_of(body_text(res, signal).await);
        last = if status == 404 && jsre!("model", "i").is_match(&detail) {
            missing_model(cfg)
        } else {
            with_detail(format!("serveur de traduction : HTTP {status}"), &detail)
        };
        if status < 500 {
            break;
        }
        sleep(ms(o.retry_delay, 3000), signal).await;
    }
    Err(ServiceError::new(
        if last.is_empty() {
            "traduction impossible".to_string()
        } else {
            last
        },
        Service::Traduction,
    ))
}

/// `groupSentences` : sous-titres consécutifs regroupés en phrases
/// (ponctuation finale, 4 lignes ou 300 caractères au plus).
pub fn group_sentences(lines: &[TranslateLine]) -> Vec<Vec<TranslateLine>> {
    let mut groups = Vec::new();
    let mut cur: Vec<TranslateLine> = Vec::new();
    let mut len = 0;
    for l in lines {
        cur.push(l.clone());
        len += js::utf16_len(&l.en) + 1;
        if jsre!(r#"[.!?…]["»”')\]]*$"#).is_match(js::trim(&l.en)) || cur.len() >= 4 || len >= 300
        {
            groups.push(std::mem::take(&mut cur));
            len = 0;
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    groups
}

/// `splitProportional` : répartit une traduction sur `weights.len()`
/// sous-titres au prorata des longueurs anglaises, entre deux mots (de
/// préférence après une ponctuation) ; `None` si trop peu de mots.
pub fn split_proportional(fr: &str, weights: &[f64]) -> Option<Vec<String>> {
    let n = weights.len();
    if n == 1 {
        return Some(vec![fr.to_string()]);
    }
    let words: Vec<&str> = jsre!(r"\s+").split(fr).filter(|w| !w.is_empty()).collect();
    if words.len() < n * 2 {
        return None;
    }
    let total: f64 = weights.iter().map(|w| js::max(1.0, *w)).sum();
    let mut ends = Vec::with_capacity(words.len());
    let mut pos = 0.0;
    for w in &words {
        pos += js::utf16_len(w) as f64 + 1.0;
        ends.push(pos);
    }
    let mut out = Vec::new();
    let mut from = 0usize;
    let mut acc = 0.0;
    for (k, w) in weights.iter().enumerate().take(n - 1) {
        acc += js::max(1.0, *w);
        let ideal = (acc / total) * pos;
        let min_j = from;
        let max_j = words.len() as i64 - (n - k - 1) as i64 - 1;
        let mut best = min_j;
        let mut best_score = f64::INFINITY;
        let mut j = min_j as i64;
        while j <= max_j {
            let ju = j as usize;
            let dist = (ends[ju] - ideal).abs();
            let bonus = if jsre!(r"[,;:.!?…]$").is_match(words[ju]) {
                12.0
            } else {
                0.0
            };
            let score = dist - bonus;
            if score < best_score {
                best_score = score;
                best = ju;
            }
            j += 1;
        }
        out.push(words[from..=best].join(" "));
        from = best + 1;
    }
    out.push(words[from.min(words.len())..].join(" "));
    Some(out)
}

async fn mt_translate_one(
    en: &str,
    cfg: &CommentaryConfig,
    o: &TranslateContext,
) -> Result<Option<String>, ServiceError> {
    for _ in 0..2 {
        let fr = mt_complete(en, cfg, o).await?;
        if valid_translation(en, Some(&fr)) {
            return Ok(Some(fr));
        }
    }
    Ok(None)
}

/// `translateBatchMt` : phrase par phrase (`cfg.parallel` à la fois), puis
/// répartition sur les sous-titres ; sinon chaque sous-titre seul ; en
/// dernier recours l'anglais, marqué.
pub async fn translate_batch_mt(
    lines: &[TranslateLine],
    cfg: &CommentaryConfig,
    o: &TranslateContext,
) -> Result<Vec<TranslatedLine>, ServiceError> {
    let groups = group_sentences(lines);
    let next = AtomicUsize::new(0);
    let done: Mutex<std::collections::HashMap<i64, String>> = Mutex::new(Default::default());
    let (next_r, done_r, groups_r) = (&next, &done, &groups);
    let worker = move || async move {
        let (next, done, groups) = (next_r, done_r, groups_r);
        loop {
            let k = next.fetch_add(1, Ordering::SeqCst);
            let Some(g) = groups.get(k) else { break };
            let en = g
                .iter()
                .map(|l| js::trim(&l.en).to_string())
                .collect::<Vec<_>>()
                .join(" ");
            let fr = mt_translate_one(&en, cfg, o).await?;
            let weights: Vec<f64> = g.iter().map(|l| js::utf16_len(&l.en) as f64).collect();
            let parts = fr.as_deref().and_then(|f| split_proportional(f, &weights));
            if let Some(parts) = parts {
                let mut d = done.lock().unwrap_or_else(|e| e.into_inner());
                for (l, p) in g.iter().zip(parts) {
                    d.insert(l.i, p);
                }
                continue;
            }
            for l in g {
                if let Some(one) = mt_translate_one(&l.en, cfg, o).await? {
                    done.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(l.i, one);
                }
            }
        }
        Ok::<(), ServiceError>(())
    };
    let n = cfg.parallel.min(groups.len());
    futures_util::future::try_join_all((0..n).map(|_| worker())).await?;
    let done = done.into_inner().unwrap_or_else(|e| e.into_inner());
    Ok(lines
        .iter()
        .map(|l| match done.get(&l.i) {
            Some(fr) => TranslatedLine {
                i: l.i,
                fr: fr.clone(),
                untranslated: false,
            },
            None => TranslatedLine {
                i: l.i,
                fr: l.en.clone(),
                untranslated: true,
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reponses_du_llm() {
        let want: IndexMap<i64, String> = [
            (1, "Il tire à trois points.".to_string()),
            (2, "Dedans !".to_string()),
        ]
        .into_iter()
        .collect();
        let j = r#"{"t":[{"i":1,"fr":"Il tire à trois points."},{"i":2,"fr":"Dedans !"}]}"#;
        assert_eq!(parse_translation(j), want);
        assert_eq!(
            parse_translation(&format!("Voici la traduction :\n{j}\nBonne lecture.")),
            want
        );
        assert_eq!(parse_translation(&format!("```json\n{j}\n```")), want);
        assert_eq!(
            parse_translation(&format!("<think>hmm {{\"t\":[]}}</think>\n{j}")),
            want
        );
        assert_eq!(
            parse_translation(
                r#"[{"id":1,"fr":"Il tire à trois points."},{"id":2,"text":"Dedans !"}]"#
            ),
            want
        );
        assert!(parse_translation("pas de JSON ici").is_empty());
        assert_eq!(
            parse_plain_translation("<think>…</think>\nFrançais : \"Il déclenche de loin.\""),
            "Il déclenche de loin."
        );
        assert_eq!(
            parse_plain_translation("```\n« Dedans ! »\n```"),
            "Dedans !"
        );
        assert_eq!(
            parse_plain_translation(r#"{"fr":"Temps mort Portland."}"#),
            "Temps mort Portland."
        );
        assert_eq!(parse_plain_translation("Désolé, je ne peux pas."), "");
        assert_eq!(
            parse_plain_translation("I'm sorry, I can't help with that."),
            ""
        );
        assert_eq!(
            parse_plain_translation("Désolés pour lui, il rate."),
            "Désolés pour lui, il rate."
        );
    }

    #[test]
    fn controles() {
        assert!(valid_translation("Bang!", Some("Dedans !")));
        assert!(!valid_translation("Bang!", Some("...")));
        assert!(!valid_translation("Bang!", Some(&"Dedans ! ".repeat(10))));
        assert!(!valid_translation(
            "He pulls up from deep.",
            Some("He pulls up from deep.")
        ));
        assert!(valid_translation("Santos.", Some("Santos.")));
        assert_eq!(
            anchors("Brunson got a three, Knicks up 19-16."),
            Anchors {
                numbers: vec!["19".into(), "16".into()],
                names: vec!["knick".into()]
            }
        );
        assert_eq!(
            anchors("The Celtics. He passes to Tatum").names,
            ["celti", "tatum"]
        );
        assert!(consistent_translation(
            "Heading to the NBA Finals.",
            "En route vers les finales NBA.",
            None
        ));
        assert!(!consistent_translation(
            "Knicks up 19-16.",
            "Les Knicks mènent 19 à 6.",
            None
        ));
        assert_eq!(
            whisper_prompt("Los Angeles Lakers", "Portland Trail Blazers", &["LeBron James", "Deni Avdija"]),
            "NBA basketball game commentary: Portland Trail Blazers at Los Angeles Lakers. LeBron James, Deni Avdija."
        );
        let parts = split_proportional(
            "Curry remonte le ballon, cherche l’écran et déclenche.",
            &[20.0, 21.0],
        )
        .unwrap();
        assert!(parts[0].ends_with(','));
        assert_eq!(split_proportional("Oui !", &[10.0, 10.0]), None);
        assert!(plain_translate_prompt().contains("« board » = rebond"));
        assert!(!plain_translate_prompt().contains("{\"t\""));
    }
}
