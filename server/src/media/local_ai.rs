//! Whisper et Ollama EMBARQUÉS dans le conteneur (équivalent de `localAi.ts`).
//!
//! L'image Docker contient faster-whisper (environnement Python
//! /opt/whisper, bibliothèques CUDA comprises) et le binaire Ollama. Ils ne
//! tournent pas en permanence : un travail de traduction les démarre au
//! premier besoin, puis les arrête à la fin (ou sur erreur / abandon).
//!
//! - transcription : [`WhisperSession`], processus Python
//!   `scripts/whisper_worker.py` (une requête JSON par ligne sur stdin, une
//!   réponse par ligne sur stdout), modèle chargé une fois pour tout le match ;
//! - traduction : [`OllamaSession`], `ollama serve` lancé à la demande,
//!   modèle téléchargé au premier usage.
//!
//! Les modèles sont rangés dans [`models_dir`] (`/data/models`).

use super::abort::{is_aborted, wait_aborted, AbortSignal};
use super::commentary_cues::{parse_verbose_json, Transcript};
use super::proc::{
    exit_text, keep_tail, last_two_lines, lower_priority, spawn_error_text, JsonWorker, Supervised,
    WorkerSpec,
};
use crate::js::{self, jsre};
use crate::jsval::{js_number_string, js_string};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

// ---------------------------------------------------------------- chemins

fn env_or(name: &str, def: impl FnOnce() -> String) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(def)
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_default()
}

/// Chemins des services embarqués (`embeddedPaths`).
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedPaths {
    pub python: String,
    pub worker: String,
    pub ollama: String,
}

pub fn embedded_paths() -> EmbeddedPaths {
    EmbeddedPaths {
        python: env_or("WHISPER_PYTHON", || "/opt/whisper/bin/python".into()),
        worker: env_or("WHISPER_WORKER", || {
            cwd()
                .join("scripts")
                .join("whisper_worker.py")
                .to_string_lossy()
                .into_owned()
        }),
        ollama: env_or("OLLAMA_BIN", || "/usr/bin/ollama".into()),
    }
}

pub fn embedded_whisper_available() -> bool {
    let p = embedded_paths();
    Path::new(&p.python).exists() && Path::new(&p.worker).exists()
}

/// Modèles des moteurs retirés (doublage : Qwen3-TTS, Fish S2 Pro, empreintes
/// et genre des voix ; transcription : NVIDIA Parakeet) restés dans
/// `models` (`/data/models`) : effacés, avec le cache de téléchargement
/// Hugging Face (`hf/xet`, refait au besoin). Les modèles de Whisper
/// (`whisper/`) et d'Ollama (`ollama/`) ne sont pas touchés. Rend les
/// dossiers effacés et la place libérée (octets).
pub fn purge_retired_models(models: &Path) -> (Vec<PathBuf>, u64) {
    let hf = models.join("hf");
    let mut targets = vec![
        models.join("omni-home"),
        hf.join("speechbrain"),
        hf.join("xet"),
    ];
    if let Ok(rd) = std::fs::read_dir(hf.join("hub")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            let retired = [
                "models--fishaudio--",
                "models--qwen--qwen3-tts",
                "models--jaesunghuh--",
                "models--speechbrain--",
                "models--istupakov--",
            ]
            .iter()
            .any(|p| name.starts_with(p))
                || (name.starts_with("models--") && name.contains("parakeet"));
            if retired {
                targets.push(e.path());
            }
        }
    }
    let mut removed = Vec::new();
    let mut freed = 0;
    for t in targets {
        let Ok(meta) = std::fs::symlink_metadata(&t) else {
            continue;
        };
        let size = if meta.is_dir() {
            dir_size(&t)
        } else {
            meta.len()
        };
        let r = if meta.is_dir() {
            std::fs::remove_dir_all(&t)
        } else {
            std::fs::remove_file(&t)
        };
        match r {
            Ok(()) => {
                freed += size;
                removed.push(t);
            }
            Err(e) => eprintln!("[modèles] {} non effacé : {e}", t.display()),
        }
    }
    (removed, freed)
}

/// Taille d'un dossier (fichiers seulement, liens non suivis).
fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

pub fn embedded_ollama_available() -> bool {
    Path::new(&embedded_paths().ollama).exists()
}

/// `dataDir` de `db.ts` : `DATA_DIR`, sinon `/data` s'il existe, sinon `./data`.
pub fn data_dir() -> PathBuf {
    match std::env::var("DATA_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ if Path::new("/data").exists() => PathBuf::from("/data"),
        _ => cwd().join("data"),
    }
}

/// Dossier des modèles (`MODELS_DIR`, sinon `<données>/models`).
pub fn models_dir() -> PathBuf {
    match std::env::var("MODELS_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir().join("models"),
    }
}

/// Port local d'Ollama embarqué (127.0.0.1 uniquement : rien n'est exposé).
pub fn embedded_ollama_url() -> String {
    let n = std::env::var("OLLAMA_PORT")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v))
        .trunc();
    // `Math.trunc(Number(x)) || 11434` : NaN et 0 donnent le port par défaut.
    let port = if n.is_nan() || n == 0.0 { 11434.0 } else { n };
    format!("http://127.0.0.1:{}", js_number_string(port))
}

/// `whisperLibraryPath` : dossiers des bibliothèques CUDA installées par pip
/// (cuBLAS, cuDNN…) dans l'environnement Python, pour le LD_LIBRARY_PATH du
/// SEUL processus Whisper (Ollama embarque les siennes).
pub fn whisper_library_path(python: &str) -> String {
    let venv = Path::new(python)
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let Ok(rd) = std::fs::read_dir(venv.join("lib")) else {
        return String::new();
    };
    // `readdirSync` : entrées triées (libuv).
    let mut libs: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|d| d.starts_with("python3"))
        .collect();
    libs.sort();
    let mut out = Vec::new();
    for py in libs {
        for pkg in ["cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"] {
            let dir = venv
                .join("lib")
                .join(&py)
                .join("site-packages")
                .join("nvidia")
                .join(pkg)
                .join("lib");
            if dir.exists() {
                out.push(dir.to_string_lossy().into_owned());
            }
        }
    }
    out.join(":")
}

/// `short` : message d'erreur sur une ligne, 200 caractères au plus.
pub(crate) fn short(e: &str) -> String {
    js::slice_utf16(&jsre!(r"\s+").replace_all(e, " "), 200)
}

// ---------------------------------------------------------------- Whisper

/// `WHISPER_BEAM_SIZE` : largeur du faisceau de Whisper (1 à 10, 5 par défaut ;
/// 1 : décodage glouton, plus rapide mais moins juste sur l'audio bruité).
pub fn whisper_beam_size() -> u32 {
    std::env::var("WHISPER_BEAM_SIZE")
        .ok()
        .and_then(|v| js::trim(&v).parse::<u32>().ok())
        .filter(|n| (1..=10).contains(n))
        .unwrap_or(5)
}

/// `COMMENTARY_VOICES` : reconnaître les commentateurs (empreinte de la voix
/// de chaque prise de parole, une couleur par commentateur dans les
/// sous-titres). Actif par défaut ; `0` le coupe.
pub fn voices_enabled() -> bool {
    std::env::var("COMMENTARY_VOICES").map_or(true, |v| js::trim(&v) != "0")
}

/// Une session de transcription : un processus Python, un modèle chargé.
#[derive(Clone)]
pub struct WhisperSession {
    worker: JsonWorker,
    closed: Arc<AtomicBool>,
}

fn whisper_ready_error(e: Option<&Value>) -> String {
    match e {
        None | Some(Value::Null) => "Whisper : échec du chargement".into(),
        Some(v) => js_string(v),
    }
}

fn whisper_exit_message(why: &str, tail: &str) -> String {
    format!(
        "Whisper s'est arrêté ({why}){}",
        if tail.is_empty() {
            String::new()
        } else {
            format!(" : {tail}")
        }
    )
}

/// Fenêtre de contexte d'Ollama (`OLLAMA_CONTEXT_LENGTH`, 8192 par défaut,
/// 2048 à 131072). Une seule valeur pour le serveur, le préchargement et
/// chaque requête : Ollama recharge le modèle quand `num_ctx` change. 4096
/// ne suffisait pas : prompt système (~3 000 tokens), joueurs et lot de 14
/// lignes, plus 1 200 tokens de réponse, débordaient (prompt tronqué, lots
/// repris par moitiés puis ligne à ligne).
pub fn ollama_num_ctx() -> u32 {
    std::env::var("OLLAMA_CONTEXT_LENGTH")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|n| (2048..=131_072).contains(n))
        .unwrap_or(8192)
}

/// Carte imposée à un processus enfant (`OLLAMA_CUDA_DEVICE`,
/// `WHISPER_CUDA_DEVICE` : numéro `nvidia-smi`, ou UUID), posée dans son
/// `CUDA_VISIBLE_DEVICES`. `None` : il hérite de celle du conteneur.
pub fn cuda_device(var: &str) -> Option<String> {
    std::env::var(var)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Environnement du processus Whisper : cache Hugging Face
/// (`/data/models/hf`) et cuBLAS/cuDNN des paquets pip de son environnement.
fn worker_env(models: &Path) -> Vec<(String, String)> {
    let lib = whisper_library_path(&embedded_paths().python);
    let mut env = vec![
        (
            "HF_HOME".to_string(),
            models.join("hf").to_string_lossy().into_owned(),
        ),
        ("PYTHONUNBUFFERED".to_string(), "1".to_string()),
    ];
    if !lib.is_empty() {
        let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let v = [lib.as_str(), prev.as_str()]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(":");
        env.push(("LD_LIBRARY_PATH".into(), v));
    }
    if let Some(d) = cuda_device("WHISPER_CUDA_DEVICE") {
        env.push(("CUDA_VISIBLE_DEVICES".into(), d));
    }
    env
}

impl WhisperSession {
    /// `WhisperSession.open` : lance le processus et attend que le modèle soit
    /// prêt (`WHISPER_LOAD_TIMEOUT_MS`, 30 min par défaut ; le premier
    /// lancement le télécharge).
    pub async fn open(model: &str, timeout: Option<Duration>) -> Result<WhisperSession, String> {
        let p = embedded_paths();
        let (python, worker, name) = (p.python.clone(), p.worker.clone(), "Whisper");
        let models = models_dir();
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        let env = worker_env(&models);
        let args = vec![
            worker,
            "--model".into(),
            model.into(),
            "--device".into(),
            env_or("WHISPER_DEVICE", || "auto".into()),
            "--compute-type".into(),
            env_or("WHISPER_COMPUTE_TYPE", || "auto".into()),
            "--download-root".into(),
            models.join("whisper").to_string_lossy().into_owned(),
            // Recherche en faisceau (`WHISPER_BEAM_SIZE`, 5) : plus juste que le
            // décodage glouton (1) quand le public couvre les commentateurs,
            // 1,5 à 2 fois plus lent (la carte a la marge).
            "--beam-size".into(),
            whisper_beam_size().to_string(),
        ];
        let tag = "[whisper]";
        let spec = WorkerSpec {
            program: python.clone(),
            args,
            env,
            on_stderr: Box::new(move |s: &str| {
                for line in s.split('\n') {
                    let l = js::trim(line);
                    if !l.is_empty() {
                        if l.starts_with(tag) {
                            println!("{l}");
                        } else {
                            println!("{tag} {l}");
                        }
                    }
                }
            }),
            on_stderr_end: Box::new(|| {}),
            ready_error: whisper_ready_error,
            exit_message: whisper_exit_message,
        };
        let (worker, ready) = JsonWorker::spawn(spec).map_err(|e| {
            format!(
                "{name} ne démarre pas : {}",
                short(&spawn_error_text(&python, &e))
            )
        })?;
        let s = WhisperSession {
            worker,
            closed: Arc::new(AtomicBool::new(false)),
        };
        let timeout = timeout.unwrap_or_else(|| {
            let n = std::env::var("WHISPER_LOAD_TIMEOUT_MS")
                .ok()
                .map_or(f64::NAN, |v| crate::api::js_number(&v));
            Duration::from_millis(if n.is_finite() && n != 0.0 && n > 0.0 {
                n as u64
            } else {
                30 * 60_000
            })
        });
        let r = match tokio::time::timeout(timeout, ready).await {
            Ok(Ok(Ok(msg))) => Ok(msg),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => Err(s
                .worker
                .exit_error()
                .unwrap_or_else(|| format!("{name} s'est arrêté"))),
            Err(_) => Err(format!(
                "{name} : modèle {model} pas prêt après {} min",
                js_number_string(js::round(timeout.as_millis() as f64 / 60_000.0))
            )),
        };
        match r {
            Ok(msg) => {
                let device = match msg.get("device") {
                    None | Some(Value::Null) => "?".to_string(),
                    Some(v) => js_string(v),
                };
                let card = cuda_device("WHISPER_CUDA_DEVICE")
                    .map(|d| format!(", carte {d}"))
                    .unwrap_or_default();
                println!("[commentaires] Whisper embarqué prêt ({model}, {device}{card})");
                Ok(s)
            }
            Err(e) => {
                s.close().await;
                Err(e)
            }
        }
    }

    /// Transcrit un fichier (`prompt` : prompt initial ; `hotwords` : noms à
    /// privilégier, séparés par des virgules). Interruption : la requête est
    /// abandonnée et la session fermée.
    pub async fn transcribe(
        &self,
        file: &str,
        prompt: Option<&str>,
        signal: Option<&AbortSignal>,
        hotwords: Option<&str>,
    ) -> Result<Transcript, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("session Whisper fermée".into());
        }
        if is_aborted(signal) {
            self.spawn_close();
            return Err("transcription interrompue".into());
        }
        let mut req = Map::new();
        req.insert("file".into(), Value::from(file));
        req.insert("language".into(), Value::from("en"));
        if let Some(p) = prompt {
            req.insert("prompt".into(), Value::from(p));
        }
        if let Some(h) = hotwords.filter(|h| !h.is_empty()) {
            req.insert("hotwords".into(), Value::from(h));
        }
        if voices_enabled() {
            req.insert("voices".into(), Value::from(true));
        }
        let (id, rx) = self.worker.request(req).await;
        let reply = tokio::select! {
            r = rx => r.unwrap_or_else(|_| Err("session Whisper fermée".into())),
            _ = wait_aborted(signal) => {
                self.worker.forget(id);
                self.spawn_close();
                return Err("transcription interrompue".into());
            }
        };
        match reply {
            Ok(msg) if msg.get("ok").is_some_and(|v| crate::js::truthy(Some(v))) => Ok(
                parse_verbose_json(msg.get("result").unwrap_or(&Value::Null)),
            ),
            Ok(msg) => Err(format!(
                "Whisper : {}",
                match msg.get("error") {
                    None | Some(Value::Null) => "transcription impossible".into(),
                    Some(v) => js_string(v),
                }
            )),
            Err(e) => Err(e),
        }
    }

    fn spawn_close(&self) {
        let s = self.clone();
        tokio::spawn(async move { s.close().await });
    }

    /// Ferme la session : stdin fermé, processus arrêté (5 s de grâce).
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.worker.close(Duration::from_secs(5)).await;
    }

    /// Identifiant du processus (tests, journaux).
    pub fn pid(&self) -> Option<u32> {
        self.worker.pid()
    }
}

// ---------------------------------------------------------------- Ollama

/// Client HTTP des services locaux et en ligne de l'IA : sans proxy (comme
/// `fetch` de Node), délais posés requête par requête.
pub fn ai_client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client HTTP")
    })
}

/// Corps d'un `fetch(url, { body: chaîne })` sans en-tête : Node l'envoie en `text/plain`.
const TEXT_PLAIN: &str = "text/plain;charset=UTF-8";

/// Lignes d'Ollama qui disent où va le modèle (« offloaded 35/35 layers to
/// GPU ») : un modèle qui ne tient pas sur la carte déborde dans la RAM du
/// NAS, et c'est la première chose à vérifier quand la mémoire sature.
fn log_ollama_memory(text: &str) {
    for line in text.lines() {
        let l = line.to_ascii_lowercase();
        if l.contains("offloaded")
            || l.contains("insufficient")
            || l.contains("out of memory")
            || l.contains("truncating input prompt")
            || l.contains("context shift")
        {
            let line = line.trim();
            let short: String = line.chars().take(300).collect();
            println!("[ollama] {short}");
        }
    }
}

async fn ollama_up(base: &str) -> bool {
    ai_client()
        .get(format!("{base}/api/version"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// Raison d'un démarrage raté d'Ollama : arrêt (avec son code) ou délai
/// dépassé, puis les dernières lignes d'erreur ou d'avertissement du journal
/// (les dernières lignes tout court sont souvent de simples `level=INFO`), et
/// si Ollama n'a vu aucune carte NVIDIA, laquelle lui était demandée.
fn ollama_start_failure(tail: &str, exited: Option<&str>, waited_s: u64) -> String {
    let why = match exited {
        Some(code) => format!("arrêté au démarrage ({code})"),
        None => format!("pas prêt après {waited_s} s"),
    };
    let errors: Vec<&str> = tail
        .split('\n')
        .map(str::trim)
        .filter(|l| jsre!(r"level=(ERROR|WARN)|^error\b|\berror:|panic|fatal", "i").is_match(l))
        .collect();
    let lines = if errors.is_empty() {
        last_two_lines(tail)
    } else {
        errors[errors.len().saturating_sub(2)..].join(" | ")
    };
    let cpu_only =
        jsre!(r"library=cpu").is_match(tail) && !jsre!(r"library=(cuda|rocm)", "i").is_match(tail);
    let gpu = if cpu_only {
        format!(
            " ; aucune carte NVIDIA vue par Ollama (CUDA_VISIBLE_DEVICES={})",
            std::env::var("CUDA_VISIBLE_DEVICES")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "toutes".into())
        )
    } else {
        String::new()
    };
    if lines.is_empty() {
        format!("Ollama ne démarre pas : {why}{gpu}")
    } else {
        format!("Ollama ne démarre pas : {why}{gpu} — {lines}")
    }
}

/// Ligne « gemma4:12b : 9.1 Go sur la carte / 9.1 Go (100 %), contexte
/// 8192 » d'après la réponse de `/api/ps` ; `None` si le modèle n'y est pas.
pub fn gpu_usage_line(ps: &Value, name: &str) -> Option<String> {
    let m = ps
        .get("models")?
        .as_array()?
        .iter()
        .find(|m| m.get("name").and_then(Value::as_str) == Some(name))?;
    let size = m.get("size").and_then(Value::as_f64)?;
    let vram = m.get("size_vram").and_then(Value::as_f64).unwrap_or(0.0);
    if size <= 0.0 {
        return None;
    }
    let pct = (vram / size * 100.0).round();
    let ctx = m
        .get("context_length")
        .and_then(Value::as_u64)
        .map(|c| format!(", contexte {c}"))
        .unwrap_or_default();
    let warn = if pct < 100.0 {
        " — le modèle déborde dans la RAM : traduction ralentie"
    } else {
        ""
    };
    Some(format!(
        "{name} : {:.1} Go sur la carte / {:.1} Go ({pct} %){ctx}{warn}",
        vram / 1e9,
        size / 1e9
    ))
}

/// Ollama embarqué pour la durée de la traduction. Si un Ollama répond déjà
/// sur le port (lancé ailleurs), il est utilisé tel quel et n'est pas arrêté.
pub struct OllamaSession {
    child: Mutex<Option<Supervised>>,
    pub base: String,
}

impl OllamaSession {
    /// Démarre `ollama serve` si besoin et attend qu'il réponde (90 s par défaut).
    pub async fn open(timeout: Option<Duration>) -> Result<OllamaSession, String> {
        let s = OllamaSession {
            child: Mutex::new(None),
            base: embedded_ollama_url(),
        };
        if ollama_up(&s.base).await {
            if let Some(d) = cuda_device("OLLAMA_CUDA_DEVICE") {
                println!(
                    "[commentaires] un Ollama répond déjà sur {} : OLLAMA_CUDA_DEVICE={d} et OLLAMA_CONTEXT_LENGTH sont sans effet sur lui",
                    s.base
                );
            }
            return Ok(s);
        }
        let models = models_dir().join("ollama");
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        // Clé d'identification d'Ollama (~/.ollama) dans le volume, à côté des modèles.
        let home = models_dir().join("ollama-home");
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        // Même valeur que les lots envoyés en même temps (une seule lecture).
        let parallel = super::commentary_ai::translate_parallel() as f64;
        let bin = embedded_paths().ollama;
        let mut cmd = Command::new(&bin);
        if let Some(d) = cuda_device("OLLAMA_CUDA_DEVICE") {
            cmd.env("CUDA_VISIBLE_DEVICES", d);
        }
        let mut child = cmd
            .arg("serve")
            .env("OLLAMA_HOST", s.base.trim_start_matches("http://"))
            .env("OLLAMA_MODELS", &models)
            .env("HOME", &home)
            .env("OLLAMA_NUM_PARALLEL", js_number_string(parallel))
            .env("OLLAMA_CONTEXT_LENGTH", ollama_num_ctx().to_string())
            .env("OLLAMA_KEEP_ALIVE", "10m")
            // Mémoire : un seul modèle chargé, attention « flash » et cache
            // des clés/valeurs en 8 bits (moitié moins de mémoire du contexte,
            // donc moins de risque que le modèle déborde de la carte vers la
            // RAM du NAS). Chaque réglage reste modifiable par l'environnement.
            .env(
                "OLLAMA_MAX_LOADED_MODELS",
                env_or("OLLAMA_MAX_LOADED_MODELS", || "1".into()),
            )
            .env(
                "OLLAMA_FLASH_ATTENTION",
                env_or("OLLAMA_FLASH_ATTENTION", || "1".into()),
            )
            .env(
                "OLLAMA_KV_CACHE_TYPE",
                env_or("OLLAMA_KV_CACHE_TYPE", || "q8_0".into()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Ollama ne démarre pas : {}", spawn_error_text(&bin, &e)))?;
        lower_priority(child.id());
        let tail = Arc::new(Mutex::new(String::new()));
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        ]
        .into_iter()
        .flatten()
        {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut pipe = pipe;
                let mut buf = vec![0u8; 4096];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]);
                    log_ollama_memory(&text);
                    keep_tail(
                        &mut tail.lock().unwrap_or_else(|e| e.into_inner()),
                        &text,
                        2000,
                    );
                }
            });
        }
        let sup = Supervised::new(child);
        *s.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(sup.clone());
        let t0 = Instant::now();
        let limit = timeout.unwrap_or(Duration::from_secs(90));
        while t0.elapsed() < limit {
            if sup.has_exited() {
                break;
            }
            if ollama_up(&s.base).await {
                let t = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let gpu = if jsre!(r"library=(cuda|rocm)|CUDA|compute=\d", "i").is_match(&t) {
                    "GPU"
                } else {
                    "processeur (aucun GPU détecté)"
                };
                let card = cuda_device("OLLAMA_CUDA_DEVICE")
                    .map(|d| format!(", carte {d}"))
                    .unwrap_or_default();
                println!(
                    "[commentaires] Ollama embarqué prêt ({gpu}{card}, contexte {})",
                    ollama_num_ctx()
                );
                return Ok(s);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let exited = if sup.has_exited() {
            Some(exit_text(sup.wait().await.as_ref()))
        } else {
            None
        };
        s.close().await;
        let t = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Err(ollama_start_failure(&t, exited.as_deref(), limit.as_secs()))
    }

    /// `ensureModel` : télécharge le modèle s'il manque (premier usage), avec
    /// progression `(fait, total)` en Mo.
    pub async fn ensure_model(
        &self,
        name: &str,
        on_progress: Option<&(dyn Fn(f64, f64) + Send + Sync)>,
        signal: Option<&AbortSignal>,
    ) -> Result<(), String> {
        let show = ai_client()
            .post(format!("{}/api/show", self.base))
            .header("Content-Type", TEXT_PLAIN)
            .body(json!({ "model": name }).to_string())
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        if show.is_ok_and(|r| r.status().is_success()) {
            return Ok(());
        }
        println!("[commentaires] téléchargement du modèle {name} (premier usage)…");
        let req = ai_client()
            .post(format!("{}/api/pull", self.base))
            .header("Content-Type", TEXT_PLAIN)
            .body(json!({ "model": name, "stream": true }).to_string())
            .send();
        let res = tokio::select! {
            r = req => r.map_err(|_| "fetch failed".to_string())?,
            _ = wait_aborted(signal) => return Err("This operation was aborted".into()),
        };
        if !res.status().is_success() {
            return Err(format!(
                "Ollama : téléchargement de {name} impossible (HTTP {})",
                res.status().as_u16()
            ));
        }
        let mut stream = res;
        let mut buf: Vec<u8> = Vec::new();
        let mut last = Value::Object(Map::new());
        let mut logged_tenth = -1.0;
        loop {
            let chunk = tokio::select! {
                c = stream.chunk() => c.map_err(|_| "terminated".to_string())?,
                _ = wait_aborted(signal) => return Err("This operation was aborted".into()),
            };
            let Some(chunk) = chunk else { break };
            buf.extend_from_slice(&chunk);
            while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                let line = js::trim(&line);
                if line.is_empty() {
                    continue;
                }
                let Some(v) = crate::jsval::js_parse(line) else {
                    continue;
                };
                last = v;
                let num = |k: &str| last.get(k).and_then(Value::as_f64);
                if let (Some(total), Some(done)) = (num("total"), num("completed")) {
                    if total != 0.0 {
                        if let Some(f) = on_progress {
                            f(js::round(done / 1e6), js::round(total / 1e6));
                        }
                        let tenth = ((done / total) * 10.0).floor();
                        if total > 100e6 && tenth > logged_tenth {
                            logged_tenth = tenth;
                            println!(
                                "[commentaires] téléchargement de {name} : {} % ({} / {} Mo)",
                                js_number_string(tenth * 10.0),
                                js_number_string(js::round(done / 1e6)),
                                js_number_string(js::round(total / 1e6))
                            );
                        }
                    }
                }
            }
        }
        if let Some(e) = last.get("error").filter(|e| js::truthy(Some(e))) {
            return Err(format!("Ollama : {}", js_string(e)));
        }
        match last.get("status") {
            Some(Value::String(s)) if s == "success" => {}
            st => {
                return Err(format!(
                    "Ollama : téléchargement de {name} incomplet ({})",
                    match st {
                        None | Some(Value::Null) => "sans statut".into(),
                        Some(v) => js_string(v),
                    }
                ))
            }
        }
        println!("[commentaires] modèle {name} téléchargé");
        Ok(())
    }

    /// `warm` : charge le modèle en mémoire GPU tout de suite (requête vide) ;
    /// sans gravité en cas d'échec.
    pub async fn warm(&self, name: &str, signal: Option<&AbortSignal>) {
        let req = ai_client()
            .post(format!("{}/api/generate", self.base))
            .header("Content-Type", TEXT_PLAIN)
            .body(
                json!({
                    "model": name,
                    "prompt": "",
                    "stream": false,
                    "options": { "num_ctx": ollama_num_ctx() },
                })
                .to_string(),
            )
            .timeout(Duration::from_secs(180))
            .send();
        tokio::select! {
            _ = req => {}
            _ = wait_aborted(signal) => {}
        }
    }

    /// Journalise la place du modèle chargé (`/api/ps`) : tout sur la carte,
    /// ou une part débordée dans la RAM (traduction alors bien plus lente).
    pub async fn log_gpu_usage(&self, name: &str) {
        let res = ai_client()
            .get(format!("{}/api/ps", self.base))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        let Ok(res) = res else { return };
        let Some(v) = res
            .text()
            .await
            .ok()
            .and_then(|t| crate::jsval::js_parse(&t))
        else {
            return;
        };
        if let Some(line) = gpu_usage_line(&v, name) {
            println!("[ollama] {line}");
        }
    }

    /// Arrête `ollama serve` s'il a été lancé par cette session (10 s de grâce).
    pub async fn close(&self) {
        let c = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(c) = c {
            c.stop(Duration::from_secs(10)).await;
        }
    }
}

/// Session lâchée sans `close()` (travail annulé, panique) : `ollama serve`
/// et son modèle (plusieurs Go) ne restent pas en mémoire, et le travail
/// suivant n'adopte pas un serveur orphelin.
impl Drop for OllamaSession {
    fn drop(&mut self) {
        if let Some(c) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            c.signal(libc::SIGTERM);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenetre_de_contexte_unique() {
        let _g = crate::media::ENV_LOCK.blocking_lock();
        let saved = crate::media::set_env(&[("OLLAMA_CONTEXT_LENGTH", None)]);
        assert_eq!(ollama_num_ctx(), 8192);
        std::env::set_var("OLLAMA_CONTEXT_LENGTH", "12288");
        assert_eq!(ollama_num_ctx(), 12288);
        for bad in ["512", "abc", "999999", ""] {
            std::env::set_var("OLLAMA_CONTEXT_LENGTH", bad);
            assert_eq!(ollama_num_ctx(), 8192, "{bad}");
        }
        crate::media::restore_env(saved);
    }

    #[test]
    fn carte_de_whisper() {
        let _g = crate::media::ENV_LOCK.blocking_lock();
        let saved = crate::media::set_env(&[("WHISPER_CUDA_DEVICE", None)]);
        let tmp = tempfile::tempdir().unwrap();
        let cuda = |env: Vec<(String, String)>| {
            env.into_iter()
                .find(|(k, _)| k == "CUDA_VISIBLE_DEVICES")
                .map(|(_, v)| v)
        };
        assert_eq!(cuda(worker_env(tmp.path())), None); // hérite du conteneur
        std::env::set_var("WHISPER_CUDA_DEVICE", " 1 ");
        assert_eq!(cuda(worker_env(tmp.path())).as_deref(), Some("1"));
        crate::media::restore_env(saved);
    }

    #[test]
    fn place_du_modele_sur_la_carte() {
        let ps = json!({ "models": [
            { "name": "gemma4:12b", "size": 9.1e9, "size_vram": 9.1e9, "context_length": 8192 },
            { "name": "autre", "size": 4e9, "size_vram": 1e9 },
        ] });
        assert_eq!(
            gpu_usage_line(&ps, "gemma4:12b").as_deref(),
            Some("gemma4:12b : 9.1 Go sur la carte / 9.1 Go (100 %), contexte 8192")
        );
        let l = gpu_usage_line(&ps, "autre").unwrap();
        assert!(l.contains("(25 %)") && l.contains("déborde"), "{l}");
        assert_eq!(gpu_usage_line(&ps, "absent"), None);
        assert_eq!(gpu_usage_line(&json!({}), "gemma4:12b"), None);
    }

    #[test]
    fn modeles_retires_effaces() {
        let tmp = tempfile::tempdir().unwrap();
        let m = tmp.path();
        let mk = |rel: &str| {
            let d = m.join(rel);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("poids.bin"), vec![0u8; 1000]).unwrap();
        };
        for rel in [
            "hf/hub/models--fishaudio--s2-pro",
            "hf/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base",
            "hf/hub/models--Qwen--Qwen3-TTS-Tokenizer-12Hz",
            "hf/hub/models--istupakov--parakeet-tdt-0.6b-v2-onnx",
            "hf/hub/models--JaesungHuh--voice-gender-classifier",
            "hf/speechbrain/spkrec-ecapa-voxceleb",
            "hf/xet/chunk-cache",
            "omni-home/cache",
            // Gardés : Whisper, Ollama, et tout autre modèle Hugging Face.
            "whisper/models--deepdml--faster-whisper-large-v3-turbo-ct2",
            "ollama/blobs",
            "hf/hub/models--Systran--faster-whisper-large-v3",
        ] {
            mk(rel);
        }
        let (removed, freed) = purge_retired_models(m);
        assert_eq!(removed.len(), 8, "{removed:?}");
        assert_eq!(freed, 8000);
        for kept in [
            "whisper/models--deepdml--faster-whisper-large-v3-turbo-ct2",
            "ollama/blobs",
            "hf/hub/models--Systran--faster-whisper-large-v3",
        ] {
            assert!(m.join(kept).join("poids.bin").exists(), "{kept}");
        }
        assert!(!m.join("omni-home").exists() && !m.join("hf/xet").exists());
        // Rien de plus à effacer ensuite.
        assert_eq!(purge_retired_models(m), (vec![], 0));
        assert_eq!(purge_retired_models(&m.join("absent")), (vec![], 0));
    }

    #[test]
    fn echec_d_ollama_explique() {
        let tail = "time=… level=INFO msg=\"Listening on 127.0.0.1:11434\"\nERROR: driverInitFileInfo 599 result=11\ntime=… level=INFO source=types.go:50 msg=\"inference compute\" id=cpu library=cpu compute=\"\"\n";
        let m = ollama_start_failure(tail, None, 90);
        assert!(
            m.starts_with(
                "Ollama ne démarre pas : pas prêt après 90 s ; aucune carte NVIDIA vue par Ollama"
            ),
            "{m}"
        );
        assert!(
            m.ends_with("— ERROR: driverInitFileInfo 599 result=11"),
            "{m}"
        );
        let m = ollama_start_failure("a\nb\nc\n", Some("code 1"), 90);
        assert_eq!(
            m,
            "Ollama ne démarre pas : arrêté au démarrage (code 1) — b | c"
        );
        let gpu = "msg=\"inference compute\" id=GPU-1 library=CUDA compute=12.0\n";
        assert!(!ollama_start_failure(gpu, None, 90).contains("aucune carte"));
    }

    #[test]
    fn bibliotheques_cuda_du_seul_whisper() {
        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("venv");
        for pkg in ["cublas", "cudnn"] {
            std::fs::create_dir_all(
                venv.join("lib/python3.11/site-packages/nvidia")
                    .join(pkg)
                    .join("lib"),
            )
            .unwrap();
        }
        std::fs::create_dir_all(venv.join("bin")).unwrap();
        let lib = whisper_library_path(&venv.join("bin/python").to_string_lossy());
        assert_eq!(
            lib.split(':').collect::<Vec<_>>(),
            [
                venv.join("lib/python3.11/site-packages/nvidia/cublas/lib")
                    .to_string_lossy(),
                venv.join("lib/python3.11/site-packages/nvidia/cudnn/lib")
                    .to_string_lossy(),
            ]
        );
        assert_eq!(whisper_library_path("/nexiste/pas/bin/python"), "");
    }

    #[test]
    fn port_d_ollama() {
        let _g = crate::media::ENV_LOCK.blocking_lock();
        let saved = crate::media::set_env(&[("OLLAMA_PORT", None)]);
        assert_eq!(embedded_ollama_url(), "http://127.0.0.1:11434");
        std::env::set_var("OLLAMA_PORT", "12000.7");
        assert_eq!(embedded_ollama_url(), "http://127.0.0.1:12000");
        std::env::set_var("OLLAMA_PORT", "abc");
        assert_eq!(embedded_ollama_url(), "http://127.0.0.1:11434");
        crate::media::restore_env(saved);
    }
}
