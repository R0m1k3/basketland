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
    keep_tail, last_two_lines, lower_priority, spawn_error_text, JsonWorker, Supervised, WorkerSpec,
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

/// Modèle du moteur « NVIDIA » (Parakeet TDT 0.6B v2, anglais, par onnx-asr).
pub const PARAKEET_MODEL: &str = "nemo-parakeet-tdt-0.6b-v2";

/// Modèle de transcription NVIDIA Parakeet (sinon : Whisper).
pub fn is_parakeet_model(model: &str) -> bool {
    model.contains("parakeet")
}

/// Python et script du moteur Parakeet (`PARAKEET_PYTHON`, `PARAKEET_WORKER`).
pub fn parakeet_paths() -> (String, String) {
    (
        env_or("PARAKEET_PYTHON", || "/opt/parakeet/bin/python".into()),
        env_or("PARAKEET_WORKER", || {
            cwd()
                .join("scripts")
                .join("parakeet_worker.py")
                .to_string_lossy()
                .into_owned()
        }),
    )
}

pub fn embedded_parakeet_available() -> bool {
    let (python, worker) = parakeet_paths();
    Path::new(&python).exists() && Path::new(&worker).exists()
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

/// `WHISPER_BEAM_SIZE` : largeur du faisceau de Whisper (1 à 10, 1 par défaut : glouton).
pub fn whisper_beam_size() -> u32 {
    std::env::var("WHISPER_BEAM_SIZE")
        .ok()
        .and_then(|v| js::trim(&v).parse::<u32>().ok())
        .filter(|n| (1..=10).contains(n))
        .unwrap_or(1)
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

fn parakeet_ready_error(e: Option<&Value>) -> String {
    match e {
        None | Some(Value::Null) => "Parakeet : échec du chargement".into(),
        Some(v) => js_string(v),
    }
}

fn parakeet_exit_message(why: &str, tail: &str) -> String {
    format!(
        "Parakeet s'est arrêté ({why}){}",
        if tail.is_empty() {
            String::new()
        } else {
            format!(" : {tail}")
        }
    )
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

impl WhisperSession {
    /// `WhisperSession.open` : lance le processus et attend que le modèle soit
    /// prêt (`WHISPER_LOAD_TIMEOUT_MS`, 30 min par défaut ; le premier
    /// lancement le télécharge).
    ///
    /// Modèle Parakeet ([`is_parakeet_model`]) : même protocole, processus
    /// `scripts/parakeet_worker.py` (moteur « NVIDIA » de la page Paramètres).
    pub async fn open(model: &str, timeout: Option<Duration>) -> Result<WhisperSession, String> {
        let p = embedded_paths();
        let parakeet = is_parakeet_model(model);
        let (python, worker, name) = if parakeet {
            let (py, w) = parakeet_paths();
            (py, w, "Parakeet")
        } else {
            (p.python.clone(), p.worker.clone(), "Whisper")
        };
        let models = models_dir();
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        // cuBLAS et cuDNN des paquets pip de l'environnement Whisper (Parakeet les partage).
        let lib = whisper_library_path(&p.python);
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
        let mut args = vec![
            worker,
            "--model".into(),
            model.into(),
            "--device".into(),
            env_or("WHISPER_DEVICE", || "auto".into()),
            "--compute-type".into(),
            env_or("WHISPER_COMPUTE_TYPE", || "auto".into()),
            "--download-root".into(),
            models.join("whisper").to_string_lossy().into_owned(),
        ];
        if !parakeet {
            // Décodage glouton par défaut (`WHISPER_BEAM_SIZE`, 1) : 1,5 à 2 fois
            // plus rapide que la recherche en faisceau (5), presque aussi juste.
            args.push("--beam-size".into());
            args.push(whisper_beam_size().to_string());
        }
        let tag = if parakeet { "[parakeet]" } else { "[whisper]" };
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
            ready_error: if parakeet {
                parakeet_ready_error
            } else {
                whisper_ready_error
            },
            exit_message: if parakeet {
                parakeet_exit_message
            } else {
                whisper_exit_message
            },
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
                if parakeet {
                    println!("[commentaires] Parakeet (NVIDIA) embarqué prêt ({model}, {device})");
                } else {
                    println!("[commentaires] Whisper embarqué prêt ({model}, {device})");
                }
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

async fn ollama_up(base: &str) -> bool {
    ai_client()
        .get(format!("{base}/api/version"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
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
            return Ok(s);
        }
        let models = models_dir().join("ollama");
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        // Clé d'identification d'Ollama (~/.ollama) dans le volume, à côté des modèles.
        let home = models_dir().join("ollama-home");
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let parallel = {
            let n = std::env::var("TRANSLATE_PARALLEL")
                .ok()
                .map_or(f64::NAN, |v| crate::api::js_number(&v));
            let n = if n.is_nan() || n == 0.0 { 2.0 } else { n };
            js::max(1.0, js::min(8.0, n.trunc()))
        };
        let bin = embedded_paths().ollama;
        let mut child = Command::new(&bin)
            .arg("serve")
            .env("OLLAMA_HOST", s.base.trim_start_matches("http://"))
            .env("OLLAMA_MODELS", &models)
            .env("HOME", &home)
            .env("OLLAMA_NUM_PARALLEL", js_number_string(parallel))
            .env(
                "OLLAMA_CONTEXT_LENGTH",
                env_or("OLLAMA_CONTEXT_LENGTH", || "4096".into()),
            )
            .env("OLLAMA_KEEP_ALIVE", "10m")
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
                    keep_tail(
                        &mut tail.lock().unwrap_or_else(|e| e.into_inner()),
                        &String::from_utf8_lossy(&buf[..n]),
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
                println!("[commentaires] Ollama embarqué prêt ({gpu})");
                return Ok(s);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        s.close().await;
        let t = last_two_lines(&tail.lock().unwrap_or_else(|e| e.into_inner()));
        Err(format!(
            "Ollama ne démarre pas{}",
            if t.is_empty() {
                String::new()
            } else {
                format!(" : {t}")
            }
        ))
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
            .body(json!({ "model": name, "prompt": "", "stream": false }).to_string())
            .timeout(Duration::from_secs(180))
            .send();
        tokio::select! {
            _ = req => {}
            _ = wait_aborted(signal) => {}
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

#[cfg(test)]
mod tests {
    use super::*;

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
