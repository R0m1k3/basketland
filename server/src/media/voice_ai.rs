//! Voix françaises du doublage, EMBARQUÉES (équivalent de `voiceAi.ts`) :
//! Qwen3-TTS (environnement Python /opt/tts) piloté par
//! `scripts/voice_worker.py` sur stdin/stdout, une requête JSON par ligne :
//!
//!   ← {"event": "ready", "device": "cuda", "model": "…", "voices": ["A", "B4", "B1"]}
//!   → {"id": 1, "op": "synth", "text": "…", "voice": "A", "out": "/abs/x.wav", "language": "French"}
//!   ← {"id": 1, "ok": true, "duration": 2.31, "sample_rate": 24000}
//!   → {"id": 2, "op": "embed", "file": "/abs/audio.ogg", "segments": [[12, 14.5], …]}
//!   ← {"id": 2, "ok": true, "embeddings": [[…] | null, …], "f0": [hz | null, …], "female": [p | null, …]}
//!
//! Le moteur est choisi par [`voice_engine_name`] : Qwen3-TTS embarqué, ou
//! MiniMax ([`super::voice_minimax`]) avec l'analyse des voix locale
//! (`--embed-only`). [`prepare_voice_models`] télécharge les modèles hors GPU
//! (`--download-only`), une seule fois pour tous les appelants.

use super::abort::{is_aborted, wait_aborted, AbortSignal};
use super::local_ai::{models_dir, short};
use super::proc::{
    exit_text, keep_tail, last_two_lines, lower_priority, spawn_error_text, JsonWorker, Supervised,
    WorkerSpec,
};
use super::voice_minimax::{minimax_config, MinimaxVoiceSession};
use crate::js;
use crate::jsval::js_string;
use crate::settings::{env, env_trim, Settings};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

pub const DEFAULT_TTS_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
/// Voix « HD » (Paramètres) : Qwen3-TTS 1.7B, même clonage des voix figées,
/// intonation et timbre plus naturels ; ~4 Go de carte graphique (le
/// doublage ne la partage jamais avec la traduction), environ 2 fois plus lent.
pub const HD_TTS_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";

/// Modèle des voix embarquées : `TTS_MODEL`, sinon la qualité choisie dans les Paramètres.
pub fn tts_model(s: &Settings) -> String {
    env_trim("TTS_MODEL").unwrap_or_else(|| {
        if crate::settings::voice_quality(s) == "hd" {
            HD_TTS_MODEL.into()
        } else {
            DEFAULT_TTS_MODEL.into()
        }
    })
}

/// Pourquoi le choix « Voix du doublage » des Paramètres ne sert pas, ou
/// `None` s'il est appliqué (variables `TTS_ENGINE`, `TTS_MODEL`).
pub fn voice_quality_override(s: &Settings) -> Option<String> {
    if let Some(e) = env_trim("TTS_ENGINE") {
        return Some(format!(
            "La variable TTS_ENGINE = {e} est définie dans le conteneur : elle l'emporte sur ce choix. Retirez-la pour utiliser le choix fait ici."
        ));
    }
    if let (Some(m), VoiceEngineName::Local) = (env_trim("TTS_MODEL"), voice_engine_name(s)) {
        return Some(format!(
            "La variable TTS_MODEL = {m} est définie dans le conteneur : elle l'emporte sur ce choix. Retirez-la pour utiliser la qualité choisie ici."
        ));
    }
    None
}

/// Moteur de synthèse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceEngineName {
    Local,
    Minimax,
}

impl VoiceEngineName {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceEngineName::Local => "local",
            VoiceEngineName::Minimax => "minimax",
        }
    }
}

/// Configuration du moteur de voix (`VoiceConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceConfig {
    pub disabled_reason: Option<String>,
    pub engine: VoiceEngineName,
    pub model: String,
    /// Appareil du processus Python (Qwen3-TTS, ou l'analyse des voix seule avec MiniMax).
    pub device: String,
    pub voices_dir: PathBuf,
    pub python: String,
    pub models_dir: PathBuf,
}

/// Voix figée (`assets/voices/<ID>/`).
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceInfo {
    pub id: String,
    pub role: String,
    pub label: String,
    /// 'm' ou 'f'.
    pub gender: String,
}

/// Voix connues : ordre d'affichage et valeurs par défaut.
const KNOWN_VOICES: [(&str, &str, &str, &str); 4] = [
    ("A", "commentateur", "Commentateur", "m"),
    ("B4", "consultant", "Consultant", "m"),
    ("B1", "troisieme_voix", "Troisième voix", "m"),
    ("F", "voix_feminine", "Voix féminine", "f"),
];

fn env_or(name: &str, def: impl FnOnce() -> String) -> String {
    env(name).filter(|s| !s.is_empty()).unwrap_or_else(def)
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_default()
}

pub fn default_voices_dir() -> PathBuf {
    cwd().join("assets").join("voices")
}

fn voices_dir_env() -> PathBuf {
    env("VOICES_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_voices_dir)
}

fn worker_path() -> String {
    env_or("TTS_WORKER", || {
        cwd()
            .join("scripts")
            .join("voice_worker.py")
            .to_string_lossy()
            .into_owned()
    })
}

/// `voiceEngineName` : `TTS_ENGINE`, sinon le choix des Paramètres (« Voix
/// du doublage »), sinon MiniMax dès qu'une clé MiniMax est donnée.
pub fn voice_engine_name(s: &Settings) -> VoiceEngineName {
    match env("TTS_ENGINE")
        .map(|v| js::trim(&v).to_lowercase())
        .as_deref()
    {
        Some("minimax") => VoiceEngineName::Minimax,
        Some("local") => VoiceEngineName::Local,
        _ => match crate::settings::voice_engine_choice(s) {
            Some("minimax") => VoiceEngineName::Minimax,
            Some(_) => VoiceEngineName::Local,
            None if !minimax_config(s).key.is_empty() => VoiceEngineName::Minimax,
            None => VoiceEngineName::Local,
        },
    }
}

/// `voiceConfig`.
pub fn voice_config(s: &Settings) -> VoiceConfig {
    let voices_dir = voices_dir_env();
    let engine = voice_engine_name(s);
    let device = if engine == VoiceEngineName::Minimax {
        env_or("TTS_EMBED_DEVICE", || "cpu".into())
    } else {
        env_or("TTS_DEVICE", || "auto".into())
    };
    let python = env_or("TTS_PYTHON", || {
        if Path::new("/opt/tts/bin/python").exists() {
            "/opt/tts/bin/python".into()
        } else {
            "python3".into()
        }
    });
    let minimax = || minimax_config(s);
    let disabled_reason = if env("DUB_DISABLED").as_deref() == Some("1") {
        Some("doublage désactivé (DUB_DISABLED=1)".to_string())
    } else if engine == VoiceEngineName::Minimax && minimax().key.is_empty() {
        Some("clé MiniMax absente (MINIMAX_API_KEY)".into())
    } else if engine == VoiceEngineName::Minimax && minimax().voices.is_empty() {
        Some("aucune voix MiniMax configurée (MINIMAX_VOICE_A…)".into())
    } else if !Path::new(&worker_path()).exists() {
        Some(format!("moteur de voix introuvable ({})", worker_path()))
    } else if engine == VoiceEngineName::Local && list_voices(Some(&voices_dir)).is_empty() {
        Some(format!("aucune voix dans {}", voices_dir.display()))
    } else {
        None
    };
    VoiceConfig {
        disabled_reason,
        engine,
        model: tts_model(s),
        device,
        voices_dir,
        python,
        models_dir: models_dir(),
    }
}

/// Le doublage occupe-t-il la carte graphique ?
pub fn voice_uses_gpu(s: &Settings) -> bool {
    voice_config(s).device != "cpu"
}

/// `localeCompare` d'identifiants simples : casse ignorée d'abord, minuscules
/// avant majuscules à égalité (approximation de la collation ICU).
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

/// `listVoices` : sous-dossiers qui ont reference.wav et reference.txt,
/// décrits par leur voice.json ; ordre A, B4, B1, F puis les autres.
pub fn list_voices(dir: Option<&Path>) -> Vec<VoiceInfo> {
    let dir = dir.map(Path::to_path_buf).unwrap_or_else(voices_dir_env);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut out = Vec::new();
    for id in names {
        let d = dir.join(&id);
        if !d.join("reference.wav").exists() || !d.join("reference.txt").exists() {
            continue;
        }
        let meta = std::fs::read_to_string(d.join("voice.json"))
            .ok()
            .and_then(|t| crate::jsval::js_parse(&t))
            .unwrap_or(Value::Null);
        let known = KNOWN_VOICES.iter().find(|k| k.0 == id);
        let str_of = |k: &str| match js::prop(Some(&meta), k) {
            Some(Value::String(s)) if !js::trim(s).is_empty() => Some(js::trim(s).to_string()),
            _ => None,
        };
        let gender = match js::prop(Some(&meta), "gender") {
            Some(Value::String(g)) if g == "f" || g == "m" => g.clone(),
            _ => known.map(|k| k.3.to_string()).unwrap_or_else(|| {
                if id.starts_with('F') {
                    "f".into()
                } else {
                    "m".into()
                }
            }),
        };
        out.push(VoiceInfo {
            role: str_of("role")
                .or_else(|| known.map(|k| k.1.to_string()))
                .unwrap_or_default(),
            label: str_of("label_fr")
                .or_else(|| known.map(|k| k.2.to_string()))
                .unwrap_or_else(|| id.clone()),
            gender,
            id,
        });
    }
    let rank = |id: &str| {
        KNOWN_VOICES
            .iter()
            .position(|k| k.0 == id)
            .unwrap_or(KNOWN_VOICES.len())
    };
    out.sort_by(|a, b| {
        rank(&a.id)
            .cmp(&rank(&b.id))
            .then_with(|| locale_cmp(&a.id, &b.id))
    });
    out
}

// ---------------------------------------------------------------- téléchargement des modèles (hors GPU)

#[derive(Default)]
struct ModelsState {
    /// Modèle des voix embarquées déjà en cache (un autre choix est téléchargé).
    ready_local: Option<String>,
    ready_minimax: bool,
    inflight: Option<Shared<BoxFuture<'static, Result<(), String>>>>,
    progress: Option<(f64, f64)>,
}

fn models_state() -> &'static Mutex<ModelsState> {
    static S: std::sync::OnceLock<Mutex<ModelsState>> = std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

fn lock_models() -> std::sync::MutexGuard<'static, ModelsState> {
    models_state().lock().unwrap_or_else(|e| e.into_inner())
}

/// `prepareVoiceModels` : met en cache les modèles du doublage SANS toucher
/// à la carte graphique (`voice_worker.py --download-only`), un seul
/// téléchargement partagé par tous les appelants ; il continue même si
/// l'appelant cesse d'attendre. Échec : l'appel suivant recommence.
/// Délai : `TTS_LOAD_TIMEOUT_MS` sans nouvelle du processus.
pub async fn prepare_voice_models(s: &Settings) -> Result<(), String> {
    let cfg = voice_config(s);
    let fut = {
        let mut st = lock_models();
        let ready = match cfg.engine {
            VoiceEngineName::Local => st.ready_local.as_deref() == Some(cfg.model.as_str()),
            VoiceEngineName::Minimax => st.ready_minimax,
        };
        if ready {
            return Ok(());
        }
        if let Some(f) = st.inflight.clone() {
            f
        } else {
            if let Some(r) = &cfg.disabled_reason {
                return Err(r.clone());
            }
            let task = tokio::spawn(download_models(cfg.clone()));
            let f = async move { task.await.unwrap_or_else(|e| Err(e.to_string())) }
                .boxed()
                .shared();
            st.inflight = Some(f.clone());
            f
        }
    };
    fut.await
}

fn load_timeout() -> Duration {
    let n = env("TTS_LOAD_TIMEOUT_MS").map_or(f64::NAN, |v| crate::api::js_number(&v));
    Duration::from_millis(if n.is_finite() && n > 0.0 {
        n as u64
    } else {
        10 * 60_000
    })
}

/// Lignes d'un journal reçu par morceaux (`/\r?\n|\r/`, ligne partielle gardée).
fn split_log_lines(partial: &mut String, chunk: &str) -> Vec<String> {
    let text = format!("{partial}{chunk}");
    let mut lines: Vec<String> = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(String::from)
        .collect();
    *partial = lines.pop().unwrap_or_default();
    lines
}

async fn download_models(cfg: VoiceConfig) -> Result<(), String> {
    let finish = |why: Option<String>| {
        let mut st = lock_models();
        st.progress = None;
        st.inflight = None;
        match why {
            None => {
                if cfg.engine == VoiceEngineName::Local {
                    st.ready_local = Some(cfg.model.clone());
                }
                st.ready_minimax = true;
                Ok(())
            }
            Some(w) => Err(w),
        }
    };
    let hf = cfg.models_dir.join("hf");
    if let Err(e) = std::fs::create_dir_all(&hf) {
        return finish(Some(e.to_string()));
    }
    let mut args = vec![
        worker_path(),
        "--model".into(),
        cfg.model.clone(),
        "--download-only".into(),
    ];
    if cfg.engine == VoiceEngineName::Minimax {
        args.push("--embed-only".into());
    }
    args.extend(["--download-root".into(), hf.to_string_lossy().into_owned()]);
    let mut child = match Command::new(&cfg.python)
        .args(&args)
        .env("HF_HOME", &hf)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return finish(Some(format!(
                "téléchargement des modèles de voix impossible ({})",
                short(&spawn_error_text(&cfg.python, &e))
            )))
        }
    };
    lower_priority(child.id());
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut err_pipe = child.stderr.take().expect("stderr");
    let sup = Supervised::new(child);
    let timeout = load_timeout();
    let mut last = Instant::now();
    let (mut tail, mut partial, mut error, mut downloaded) =
        (String::new(), String::new(), String::new(), false);
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.tick().await;
    let mut buf = vec![0u8; 4096];
    let (mut out_open, mut err_open) = (true, true);
    while out_open || err_open {
        tokio::select! {
            l = lines.next_line(), if out_open => match l {
                Ok(Some(line)) => {
                    last = Instant::now();
                    let Some(Value::Object(msg)) = crate::jsval::js_parse(&line) else { continue };
                    match msg.get("event").and_then(Value::as_str) {
                        Some("progress") => {
                            let num = |k: &str| { let n = js::to_number(msg.get(k)); if n.is_nan() || n == 0.0 { 0.0 } else { n } };
                            lock_models().progress = Some((num("done"), num("total")));
                        }
                        Some("downloaded") => downloaded = true,
                        Some("error") => error = match msg.get("error") {
                            None | Some(Value::Null) => "échec du téléchargement".into(),
                            Some(v) => js_string(v),
                        },
                        _ => {}
                    }
                }
                _ => out_open = false,
            },
            r = err_pipe.read(&mut buf), if err_open => match r {
                Ok(n) if n > 0 => {
                    last = Instant::now();
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    keep_tail(&mut tail, &text, 2000);
                    for l in split_log_lines(&mut partial, &text) {
                        if js::trim(&l).starts_with("[voix]") {
                            println!("{}", js::trim(&l));
                        }
                    }
                }
                _ => err_open = false,
            },
            _ = tick.tick() => {
                if last.elapsed() >= timeout {
                    error = format!(
                        "téléchargement des modèles de voix bloqué (aucune nouvelle depuis {} min)",
                        crate::jsval::js_number_string(js::round(timeout.as_millis() as f64 / 60_000.0))
                    );
                    sup.signal(libc::SIGKILL);
                    last = Instant::now() + Duration::from_secs(3600);
                }
            }
        }
    }
    let st = sup.wait().await;
    if st.as_ref().and_then(|s| s.code()) == Some(0) && downloaded {
        return finish(None);
    }
    let last2 = last_two_lines(&tail);
    finish(Some(if !error.is_empty() {
        error
    } else {
        format!(
            "téléchargement des modèles de voix arrêté ({}){}",
            exit_text(st.as_ref()),
            if last2.is_empty() {
                String::new()
            } else {
                format!(" : {last2}")
            }
        )
    }))
}

/// Tests : modèles pas encore vérifiés.
pub fn reset_voice_models_for_tests() {
    *lock_models() = ModelsState::default();
}

/// `voiceModelsDownload` : octets faits / attendus (total 0 : inconnu), seulement pendant un téléchargement.
pub fn voice_models_download() -> Option<(f64, f64)> {
    lock_models().progress
}

// ---------------------------------------------------------------- session

/// Résultat de l'analyse des voix de segments.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedResult {
    /// Empreinte (192 valeurs, norme 1) ; `None` : segment trop court.
    pub embeddings: Vec<Option<Vec<f64>>>,
    /// F0 médiane (Hz) ; `None` : sans voix.
    pub f0: Vec<Option<f64>>,
    /// Probabilité « voix de femme » ; absent si le moteur ne la fournit pas.
    pub female: Option<Vec<Option<f64>>>,
}

/// `path.resolve` : chemin absolu normalisé (lexicalement).
pub fn resolve_path(p: &str) -> String {
    let joined = if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else {
        cwd().join(p)
    };
    let mut out = PathBuf::from("/");
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out.to_string_lossy().into_owned()
}

fn voice_ready_error(e: Option<&Value>) -> String {
    format!(
        "voix : {}",
        match e {
            None | Some(Value::Null) => "échec du chargement".into(),
            Some(v) => js_string(v),
        }
    )
}

fn voice_exit_message(why: &str, tail: &str) -> String {
    format!(
        "moteur de voix arrêté ({why}){}",
        if tail.is_empty() {
            String::new()
        } else {
            format!(" : {tail}")
        }
    )
}

/// Une session de voix : un processus Python, le modèle chargé, une
/// empreinte de clonage par voix. Requêtes traitées une à une, dans l'ordre.
#[derive(Clone)]
pub struct VoiceSession {
    worker: JsonWorker,
    closed: Arc<AtomicBool>,
    voices: Vec<String>,
    device: String,
}

impl VoiceSession {
    /// Voix chargées par le moteur (ex. ["A", "B4", "B1"]).
    pub fn voices(&self) -> Vec<String> {
        self.voices.clone()
    }

    /// `cuda` ou `cpu`.
    pub fn device(&self) -> &str {
        &self.device
    }

    pub fn pid(&self) -> Option<u32> {
        self.worker.pid()
    }

    /// Démarre le moteur et attend qu'il soit prêt. Délai : `TTS_LOAD_TIMEOUT_MS`
    /// (10 min) SANS nouvelle du processus ; chaque ligne de journal relance le délai.
    pub async fn open(
        settings: &Settings,
        signal: Option<&AbortSignal>,
        embed_only: bool,
    ) -> Result<VoiceSession, String> {
        let cfg = voice_config(settings);
        if let Some(r) = cfg.disabled_reason {
            return Err(r);
        }
        if is_aborted(signal) {
            return Err("chargement des voix interrompu".into());
        }
        let timeout = load_timeout();
        std::fs::create_dir_all(&cfg.models_dir).map_err(|e| e.to_string())?;
        let hf = cfg.models_dir.join("hf").to_string_lossy().into_owned();
        let mut args = vec![
            worker_path(),
            "--model".into(),
            cfg.model.clone(),
            "--device".into(),
            cfg.device.clone(),
            "--download-root".into(),
            hf.clone(),
            "--voices-dir".into(),
            cfg.voices_dir.to_string_lossy().into_owned(),
        ];
        if embed_only {
            args.push("--embed-only".into());
        }
        let mut env_v = vec![
            ("HF_HOME".to_string(), hf),
            ("PYTHONUNBUFFERED".into(), "1".into()),
        ];
        if embed_only && cfg.device == "cpu" {
            let threads = env_or("TTS_EMBED_THREADS", || "2".into());
            env_v.push(("OMP_NUM_THREADS".into(), threads.clone()));
            env_v.push(("MKL_NUM_THREADS".into(), threads));
        }
        let partial = Arc::new(Mutex::new(String::new()));
        let log_line = |raw: &str| {
            let line = js::trim(raw);
            if !line.is_empty() {
                if line.starts_with("[voix]") {
                    println!("{line}");
                } else {
                    println!("[voix] {line}");
                }
            }
        };
        let p1 = partial.clone();
        let p2 = partial.clone();
        let spec = WorkerSpec {
            program: cfg.python.clone(),
            args,
            env: env_v,
            on_stderr: Box::new(move |s: &str| {
                let lines = split_log_lines(&mut p1.lock().unwrap_or_else(|e| e.into_inner()), s);
                lines.iter().for_each(|l| log_line(l));
            }),
            on_stderr_end: Box::new(move || {
                log_line(&p2.lock().unwrap_or_else(|e| e.into_inner()))
            }),
            ready_error: voice_ready_error,
            exit_message: voice_exit_message,
        };
        let (worker, ready) = JsonWorker::spawn(spec).map_err(|e| {
            format!(
                "moteur de voix : démarrage impossible ({})",
                short(&spawn_error_text(&cfg.python, &e))
            )
        })?;
        let closed = Arc::new(AtomicBool::new(false));
        tokio::pin!(ready);
        let r = loop {
            let idle = worker.last_activity().elapsed();
            if idle >= timeout {
                break Err(format!(
                    "voix : modèle {} pas prêt (aucune nouvelle depuis {} min)",
                    cfg.model,
                    crate::jsval::js_number_string(js::round(
                        timeout.as_millis() as f64 / 60_000.0
                    ))
                ));
            }
            let wait = (timeout - idle).min(Duration::from_secs(5));
            tokio::select! {
                r = &mut ready => break match r {
                    Ok(r) => r,
                    Err(_) => Err(worker.exit_error().unwrap_or_else(|| "moteur de voix arrêté".into())),
                },
                _ = tokio::time::sleep(wait) => {}
                _ = wait_aborted(signal) => break Err("chargement des voix interrompu".into()),
            }
        };
        let s = |voices: Vec<String>, device: String| VoiceSession {
            worker: worker.clone(),
            closed: closed.clone(),
            voices,
            device,
        };
        match r {
            Ok(msg) => {
                let voices: Vec<String> = match msg.get("voices") {
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect(),
                    _ => Vec::new(),
                };
                let device = match msg.get("device") {
                    None | Some(Value::Null) => "?".to_string(),
                    Some(v) => js_string(v),
                };
                if embed_only {
                    println!("[voix] analyse des voix prête ({device})");
                } else {
                    println!(
                        "[voix] Qwen3-TTS embarqué prêt ({}, {device}, voix {})",
                        cfg.model,
                        if voices.is_empty() {
                            "aucune".to_string()
                        } else {
                            voices.join(", ")
                        }
                    );
                }
                Ok(s(voices, device))
            }
            Err(e) => {
                s(Vec::new(), "?".into()).close().await;
                Err(e)
            }
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst) || self.worker.has_exited()
    }

    async fn request(
        &self,
        op: Map<String, Value>,
        what: &str,
        signal: Option<&AbortSignal>,
    ) -> Result<Map<String, Value>, String> {
        if self.is_closed() {
            return Err("session de voix fermée".into());
        }
        let interrupted = || {
            let s = self.clone();
            tokio::spawn(async move { s.close().await });
            Err(format!("{what} interrompue"))
        };
        if is_aborted(signal) {
            return interrupted();
        }
        let (id, rx) = self.worker.request(op).await;
        let reply = tokio::select! {
            r = rx => r.unwrap_or_else(|_| Err("moteur de voix arrêté".into())),
            _ = wait_aborted(signal) => {
                self.worker.forget(id);
                return interrupted();
            }
        }?;
        if js::truthy(reply.get("ok")) {
            Ok(reply)
        } else {
            Err(format!(
                "voix : {}",
                match reply.get("error") {
                    None | Some(Value::Null) => "échec".into(),
                    Some(v) => js_string(v),
                }
            ))
        }
    }

    /// Synthétise `text` dans la voix `voice` vers `out_file` (WAV mono PCM 16 bits) ;
    /// rend (durée en s, fréquence d'échantillonnage).
    pub async fn synth(
        &self,
        text: &str,
        voice: &str,
        out_file: &str,
        signal: Option<&AbortSignal>,
    ) -> Result<(f64, u32), String> {
        let mut op = Map::new();
        op.insert("op".into(), Value::from("synth"));
        op.insert("text".into(), Value::from(text));
        op.insert("voice".into(), Value::from(voice));
        op.insert("out".into(), Value::from(resolve_path(out_file)));
        op.insert("language".into(), Value::from("French"));
        let r = self.request(op, "synthèse vocale", signal).await?;
        let num = |k: &str| {
            let n = js::to_number(r.get(k));
            if n.is_nan() {
                0.0
            } else {
                n
            }
        };
        Ok((num("duration"), num("sample_rate") as u32))
    }

    /// Empreintes vocales, F0 médiane et probabilité « voix de femme » de
    /// chaque segment `(début, fin)` (secondes) de `file`.
    pub async fn embed(
        &self,
        file: &str,
        segments: &[(f64, f64)],
        signal: Option<&AbortSignal>,
    ) -> Result<EmbedResult, String> {
        let mut op = Map::new();
        op.insert("op".into(), Value::from("embed"));
        op.insert("file".into(), Value::from(resolve_path(file)));
        op.insert(
            "segments".into(),
            Value::Array(
                segments
                    .iter()
                    .map(|(a, b)| {
                        Value::Array(vec![
                            crate::api::js_num_value(*a),
                            crate::api::js_num_value(*b),
                        ])
                    })
                    .collect(),
            ),
        );
        let r = self.request(op, "analyse des voix", signal).await?;
        let embeddings: Vec<Option<Vec<f64>>> = match r.get("embeddings") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|e| match e {
                    Value::Array(v) => Some(v.iter().map(|x| js::to_number(Some(x))).collect()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let f0: Vec<Option<f64>> = match r.get("f0") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|v| v.as_f64().filter(|f| f.is_finite()))
                .collect(),
            _ => Vec::new(),
        };
        if embeddings.len() != segments.len() || f0.len() != segments.len() {
            return Err(format!(
                "voix : réponse incomplète ({} empreintes pour {} segments)",
                embeddings.len(),
                segments.len()
            ));
        }
        let female = match r.get("female") {
            Some(Value::Array(a)) if a.len() == segments.len() => Some(
                a.iter()
                    .map(|v| v.as_f64().filter(|p| (0.0..=1.0).contains(p)))
                    .collect(),
            ),
            _ => None,
        };
        Ok(EmbedResult {
            embeddings,
            f0,
            female,
        })
    }

    /// Arrête le moteur : la mémoire du GPU est rendue.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if self.worker.has_exited() {
            return;
        }
        self.worker.close(Duration::from_secs(5)).await;
    }
}

// ---------------------------------------------------------------- moteur choisi

/// Session de voix du moteur choisi (`VoiceSession | MinimaxVoiceSession`).
pub enum VoiceEngine {
    Local(VoiceSession),
    Minimax(MinimaxVoiceSession),
}

impl VoiceEngine {
    pub fn voices(&self) -> Vec<String> {
        match self {
            VoiceEngine::Local(s) => s.voices(),
            VoiceEngine::Minimax(s) => s.voices(),
        }
    }

    /// Synthèse ; `emphasis` (moment fort) n'est suivi que par MiniMax, comme côté Node.
    pub async fn synth(
        &self,
        text: &str,
        voice: &str,
        out_file: &str,
        signal: Option<&AbortSignal>,
        emphasis: Option<f64>,
    ) -> Result<(f64, u32), String> {
        match self {
            VoiceEngine::Local(s) => s.synth(text, voice, out_file, signal).await,
            VoiceEngine::Minimax(s) => s.synth(text, voice, out_file, signal, emphasis).await,
        }
    }

    pub async fn embed(
        &self,
        file: &str,
        segments: &[(f64, f64)],
        signal: Option<&AbortSignal>,
    ) -> Result<EmbedResult, String> {
        match self {
            VoiceEngine::Local(s) => s.embed(file, segments, signal).await,
            VoiceEngine::Minimax(s) => s.embed(file, segments, signal).await,
        }
    }

    pub async fn close(&self) {
        match self {
            VoiceEngine::Local(s) => s.close().await,
            VoiceEngine::Minimax(s) => s.close().await,
        }
    }
}

/// `openVoiceSession` : Qwen3-TTS embarqué, ou MiniMax avec l'analyse des
/// voix locale (`--embed-only`).
pub async fn open_voice_session(
    settings: &Settings,
    signal: Option<&AbortSignal>,
) -> Result<VoiceEngine, String> {
    if voice_engine_name(settings) != VoiceEngineName::Minimax {
        return VoiceSession::open(settings, signal, false)
            .await
            .map(VoiceEngine::Local);
    }
    let cfg = voice_config(settings);
    if let Some(r) = cfg.disabled_reason {
        return Err(r);
    }
    let st = settings.clone();
    MinimaxVoiceSession::open(settings, signal, move |sig| async move {
        VoiceSession::open(&st, sig.as_ref(), true).await
    })
    .await
    .map(VoiceEngine::Minimax)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chemins_et_ordre() {
        assert_eq!(resolve_path("/a/b/../c/./d/"), "/a/c/d");
        assert_eq!(locale_cmp("b", "A"), std::cmp::Ordering::Greater);
        assert_eq!(locale_cmp("a", "A"), std::cmp::Ordering::Less);
        let mut p = String::new();
        assert_eq!(split_log_lines(&mut p, "a\r\nb\rc"), ["a", "b"]);
        assert_eq!(p, "c");
    }
}
