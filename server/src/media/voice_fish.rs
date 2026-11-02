//! Voix du doublage par Fish Audio S2 Pro (`fishaudio/s2-pro`, 5 milliards
//! de paramètres), servi par vLLM-Omni :
//!
//! - **embarqué** (par défaut) : `vllm serve fishaudio/s2-pro --omni` de
//!   l'environnement `/opt/omni` est démarré par le doublage sur la carte
//!   graphique, sur 127.0.0.1, et arrêté à la fin (mémoire rendue) ; poids
//!   (~11 Go) téléchargés au premier usage dans `/data/models/hf` ;
//! - **serveur externe** si `FISH_URL` est donnée.
//!
//! Les voix sont CLONÉES depuis les voix figées de `assets/voices/<rôle>/`
//! (`reference.wav` + `reference.txt`), les mêmes que celles de Qwen3-TTS :
//!
//!   POST {url}/audio/speech  { model, input, ref_audio: "data:audio/wav;base64,…",
//!                              ref_text, response_format: "wav" } → WAV
//!
//! Moments forts : une balise d'émotion de Fish (`[excited]`…) en tête du
//! texte dit. L'analyse des voix (empreintes, genre) reste locale, comme avec
//! MiniMax : une [`super::voice_ai::VoiceSession`] ouverte en `--embed-only`.
//!
//! Licence des poids : Fish Audio Research License (usage non commercial).

use super::abort::{wait_aborted, AbortSignal};
use super::local_ai::{ai_client, short};
use super::voice_ai::{EmbedResult, VoiceSession};
use super::voice_minimax::to_wav;
use crate::js::{self, jsre};
use crate::settings::{env_trim, Settings};
use base64::Engine as _;
use serde_json::{json, Value};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};

/// Modèle servi par défaut (`FISH_MODEL`).
pub const FISH_DEFAULT_MODEL: &str = "fishaudio/s2-pro";

/// `vllm` de l'environnement embarqué (`FISH_VLLM`, `/opt/omni/bin/vllm`).
pub fn embedded_fish_bin() -> String {
    env_trim("FISH_VLLM").unwrap_or_else(|| "/opt/omni/bin/vllm".into())
}

/// Fish S2 Pro embarqué présent dans l'image ?
pub fn embedded_fish_available() -> bool {
    Path::new(&embedded_fish_bin()).exists()
}

/// Serveur externe (`FISH_URL`), sinon `None` (embarqué).
pub fn fish_url() -> Option<String> {
    env_trim("FISH_URL").map(|u| u.trim_end_matches('/').to_string())
}

/// Modèle (`FISH_MODEL`).
pub fn fish_model() -> String {
    env_trim("FISH_MODEL").unwrap_or_else(|| FISH_DEFAULT_MODEL.into())
}

/// Balise d'émotion ajoutée en tête d'une réplique selon le moment :
/// 2 (moment fort) `FISH_TAG_STRONG` (`[excited]`), 1 (voix qui monte)
/// `FISH_TAG_RISE` (`[enthusiastic]`), sinon `FISH_TAG_CALM` (aucune).
/// Une variable vide retire la balise.
pub fn emotion_tag(emphasis: Option<f64>) -> Option<String> {
    let e = emphasis.unwrap_or(0.0);
    let (var, def) = if e >= 2.0 {
        ("FISH_TAG_STRONG", "[excited]")
    } else if e >= 1.0 {
        ("FISH_TAG_RISE", "[enthusiastic]")
    } else {
        ("FISH_TAG_CALM", "")
    };
    let tag = match std::env::var(var) {
        Ok(v) => js::trim(&v).to_string(),
        Err(_) => def.to_string(),
    };
    (!tag.is_empty()).then_some(tag)
}

/// Texte dit : balise d'émotion éventuelle, puis la réplique.
pub fn spoken_text(text: &str, emphasis: Option<f64>) -> String {
    let clean = js::trim(&jsre!(r"\s+").replace_all(text, " ")).to_string();
    match emotion_tag(emphasis) {
        Some(tag) if !clean.is_empty() => format!("{tag} {clean}"),
        _ => clean,
    }
}

/// Voix clonée d'un rôle : WAV de référence (URI de données) et sa transcription.
#[derive(Debug, Clone, PartialEq)]
pub struct FishVoice {
    pub role: String,
    pub ref_audio: String,
    pub ref_text: String,
}

/// Voix figées de `dir` (`<rôle>/reference.wav` + `reference.txt`), dans
/// l'ordre des voix connues (A, B4, B1, F, puis les autres).
pub fn load_voices(dir: &Path) -> Vec<FishVoice> {
    super::voice_ai::list_voices(Some(dir))
        .into_iter()
        .filter_map(|v| {
            let d = dir.join(&v.id);
            let wav = std::fs::read(d.join("reference.wav")).ok()?;
            let txt = std::fs::read_to_string(d.join("reference.txt")).ok()?;
            let txt = js::trim(&txt).to_string();
            if wav.is_empty() || txt.is_empty() {
                return None;
            }
            Some(FishVoice {
                role: v.id,
                ref_audio: format!(
                    "data:audio/wav;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(wav)
                ),
                ref_text: txt,
            })
        })
        .collect()
}

/// Corps exact d'une synthèse.
pub fn speech_body(model: &str, voice: &FishVoice, text: &str) -> Value {
    json!({
        "model": model,
        "input": text,
        "ref_audio": voice.ref_audio,
        "ref_text": voice.ref_text,
        "response_format": "wav",
    })
}

/// Arguments de `vllm serve` pour Fish embarqué. Mémoire de la carte
/// réservée (`FISH_GPU_UTIL`, 0,9 : ~11 Go de poids, le doublage a la carte
/// pour lui), longueur maximale (`FISH_MAX_MODEL_LEN`, 8192 : voix de
/// référence + une réplique), et `FISH_EXTRA_ARGS` en plus.
pub fn embedded_args(model: &str, port: u16) -> Vec<String> {
    let util = env_trim("FISH_GPU_UTIL").unwrap_or_else(|| "0.9".into());
    let len = env_trim("FISH_MAX_MODEL_LEN").unwrap_or_else(|| "8192".into());
    let mut a: Vec<String> = [
        "serve",
        model,
        "--omni",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--gpu-memory-utilization",
        &util,
        "--max-model-len",
        &len,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(extra) = env_trim("FISH_EXTRA_ARGS") {
        a.extend(extra.split_whitespace().map(String::from));
    }
    a
}

/// Dossier contenant un `libcuda.so` pour Triton : celui du pilote s'il a déjà
/// ce nom, sinon un lien `libcuda.so` → `libcuda.so.1` créé dans `home`.
/// `None` : pilote introuvable (Triton cherchera lui-même).
fn triton_libcuda_dir(home: &Path) -> Option<PathBuf> {
    if let Some(d) = env_trim("TRITON_LIBCUDA_PATH") {
        return Some(d.into());
    }
    const DIRS: [&str; 5] = [
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/usr/local/nvidia/lib64",
        "/usr/lib/aarch64-linux-gnu",
        "/usr/lib/wsl/lib",
    ];
    for d in DIRS {
        let dir = Path::new(d);
        if dir.join("libcuda.so").exists() {
            return Some(dir.to_path_buf());
        }
        let so1 = dir.join("libcuda.so.1");
        if so1.exists() {
            let link_dir = home.join("libcuda");
            let link = link_dir.join("libcuda.so");
            let _ = std::fs::create_dir_all(&link_dir);
            let _ = std::fs::remove_file(&link);
            #[cfg(unix)]
            if std::os::unix::fs::symlink(&so1, &link).is_ok() {
                return Some(link_dir);
            }
        }
    }
    None
}

/// Le serveur répond-il (`GET {url}/models`) ?
async fn server_up(url: &str) -> bool {
    ai_client()
        .get(format!("{url}/models"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// Démarre Fish embarqué et attend qu'il réponde (premier usage :
/// téléchargement des poids, `FISH_LOAD_TIMEOUT_MS`, 45 min au plus).
/// Un serveur qui répond déjà sur le port est réutilisé (et pas arrêté).
async fn start_embedded(
    model: &str,
    signal: Option<&AbortSignal>,
) -> Result<(String, Option<Child>), String> {
    let port = crate::media::commentary_ai::int_env("FISH_PORT", 8091.0, 1024.0, 65535.0) as u16;
    let url = format!("http://127.0.0.1:{port}/v1");
    if server_up(&url).await {
        return Ok((url, None));
    }
    let bin = embedded_fish_bin();
    if !Path::new(&bin).exists() {
        return Err(format!(
            "Fish S2 Pro absent de cette image ({bin} introuvable) : mettez l'image à jour"
        ));
    }
    let models = super::local_ai::models_dir();
    let hf = models.join("hf");
    // HOME de l'utilisateur non inscriptible dans le conteneur : caches de
    // vLLM, Triton et torch dans le volume.
    let home = models.join("omni-home");
    for d in [&hf, &home] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut cmd = Command::new(&bin);
    cmd.args(embedded_args(model, port))
        .env("HF_HOME", &hf)
        .env("HOME", &home)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("VLLM_NO_USAGE_STATS", "1")
        .env("DO_NOT_TRACK", "1")
        // Triton (noyaux compilés au démarrage) : compilateur C de l'image…
        .env("CC", env_trim("CC").unwrap_or_else(|| "gcc".into()));
    // … et `libcuda.so` du pilote : le runtime NVIDIA ne monte souvent que
    // `libcuda.so.1`, que l'éditeur de liens (`-lcuda`) ne trouve pas.
    if let Some(dir) = triton_libcuda_dir(&home) {
        cmd.env("TRITON_LIBCUDA_PATH", dir);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Fish S2 Pro : lancement impossible ({bin}) : {e}"))?;
    println!(
        "[voix] démarrage de Fish S2 Pro embarqué ({model}, port {port}) : au premier usage, téléchargement des poids (~11 Go)…"
    );
    let ms = crate::media::commentary_ai::int_env(
        "FISH_LOAD_TIMEOUT_MS",
        45.0 * 60_000.0,
        10_000.0,
        6.0 * 3_600_000.0,
    );
    let deadline = Instant::now() + Duration::from_millis(ms as u64);
    let t0 = Instant::now();
    loop {
        if server_up(&url).await {
            println!(
                "[voix] Fish S2 Pro embarqué prêt en {} s",
                t0.elapsed().as_secs()
            );
            return Ok((url, Some(child)));
        }
        if let Ok(Some(st)) = child.try_wait() {
            return Err(format!(
                "Fish S2 Pro embarqué arrêté au démarrage ({st}) : voir les lignes précédentes du journal"
            ));
        }
        if Instant::now() > deadline {
            let _ = child.start_kill();
            return Err(format!(
                "Fish S2 Pro embarqué : pas prêt après {} min",
                (ms / 60_000.0).round()
            ));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = wait_aborted(signal) => {
                let _ = child.start_kill();
                return Err("ouverture des voix interrompue".into());
            }
        }
    }
}

/// Délai d'une synthèse (`FISH_TIMEOUT_MS`, 180 s).
fn timeout() -> Duration {
    let ms = crate::media::commentary_ai::int_env("FISH_TIMEOUT_MS", 180_000.0, 1_000.0, 900_000.0);
    Duration::from_millis(ms as u64)
}

/// Session de voix Fish S2 Pro : même contrat que [`VoiceSession`].
pub struct FishVoiceSession {
    url: String,
    model: String,
    voices: Vec<FishVoice>,
    embedder: tokio::sync::Mutex<Option<VoiceSession>>,
    /// Fish embarqué lancé par cette session (arrêté à la fermeture).
    server: tokio::sync::Mutex<Option<Child>>,
    closed: AtomicBool,
}

impl FishVoiceSession {
    /// Rôles disponibles ('A', 'B4', 'B1', 'F').
    pub fn voices(&self) -> Vec<String> {
        self.voices.iter().map(|v| v.role.clone()).collect()
    }

    /// Voix de référence lues, serveur démarré (ou joint), puis analyse des
    /// voix locale ouverte. Un serveur injoignable fait échouer l'ouverture
    /// (nouvel essai automatique du doublage) ; une analyse des voix
    /// indisponible non.
    pub async fn open<F, Fut>(
        settings: &Settings,
        signal: Option<&AbortSignal>,
        open_embedder: F,
    ) -> Result<FishVoiceSession, String>
    where
        F: FnOnce(Option<AbortSignal>) -> Fut,
        Fut: Future<Output = Result<VoiceSession, String>>,
    {
        let dir = super::voice_ai::voice_config(settings).voices_dir;
        let voices = load_voices(&dir);
        if voices.is_empty() {
            return Err(format!(
                "aucune voix de référence dans {} (reference.wav + reference.txt)",
                dir.display()
            ));
        }
        let model = fish_model();
        let (url, server) = match fish_url() {
            Some(u) => {
                if !server_up(&u).await {
                    return Err(format!("serveur Fish S2 Pro injoignable ({u})"));
                }
                (u, None)
            }
            None => start_embedded(&model, signal).await?,
        };
        let embedder = match open_embedder(signal.cloned()).await {
            Ok(e) => Some(e),
            Err(e) => {
                if crate::media::abort::is_aborted(signal) {
                    return Err("ouverture des voix interrompue".into());
                }
                eprintln!(
                    "[voix] analyse des voix indisponible ({}) : une seule voix pour tout le match",
                    short(&e)
                );
                None
            }
        };
        println!(
            "[voix] Fish S2 Pro prêt ({url}, {model}, voix clonées {})",
            voices
                .iter()
                .map(|v| v.role.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok(FishVoiceSession {
            url,
            model,
            voices,
            embedder: tokio::sync::Mutex::new(embedder),
            server: tokio::sync::Mutex::new(server),
            closed: AtomicBool::new(false),
        })
    }

    /// Synthétise `text` dans la voix clonée du rôle `voice` vers `out_file`
    /// (WAV). Moment fort (`emphasis`) : balise d'émotion en tête.
    pub async fn synth(
        &self,
        text: &str,
        voice: &str,
        out_file: &str,
        signal: Option<&AbortSignal>,
        emphasis: Option<f64>,
    ) -> Result<(f64, u32), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("session de voix fermée".into());
        }
        let Some(v) = self.voices.iter().find(|v| v.role == voice) else {
            return Err(format!("voix inconnue : {voice}"));
        };
        let said = spoken_text(text, emphasis);
        if said.is_empty() {
            return Err("texte vide".into());
        }
        let body = speech_body(&self.model, v, &said).to_string();
        let mut last = String::new();
        // Un nouvel essai après une erreur passagère (réseau, 5xx, 429).
        for attempt in 0..2 {
            let req = ai_client()
                .post(format!("{}/audio/speech", self.url))
                .header("Content-Type", "application/json")
                .body(body.clone())
                .timeout(timeout())
                .send();
            let res = tokio::select! {
                r = req => r,
                _ = wait_aborted(signal) => return Err("synthèse interrompue".into()),
            };
            let retry = match res {
                Ok(r) if r.status().is_success() => {
                    let bytes = r.bytes().await.map_err(|e| short(&e.to_string()))?;
                    let w = to_wav(bytes.to_vec(), 44_100);
                    if w.duration.is_nan() || w.duration <= 0.0 {
                        return Err("Fish S2 Pro : audio vide".into());
                    }
                    std::fs::write(out_file, &w.wav).map_err(|e| e.to_string())?;
                    return Ok((js::round(w.duration * 1000.0) / 1000.0, w.sample_rate));
                }
                Ok(r) => {
                    let status = r.status().as_u16();
                    let detail = r.text().await.unwrap_or_default();
                    last = format!(
                        "Fish S2 Pro : HTTP {status} {}",
                        js::slice_utf16(js::trim(&detail), 160)
                    );
                    status == 429 || status >= 500
                }
                Err(e) => {
                    last = format!(
                        "serveur Fish S2 Pro injoignable : {}",
                        short(&e.to_string())
                    );
                    true
                }
            };
            if !retry || attempt == 1 {
                break;
            }
            crate::media::abort::sleep(2_000, signal).await;
        }
        Err(last)
    }

    /// Analyse des voix (session locale `--embed-only`).
    pub async fn embed(
        &self,
        file: &str,
        segments: &[(f64, f64)],
        signal: Option<&AbortSignal>,
    ) -> Result<EmbedResult, String> {
        let e = self.embedder.lock().await.clone();
        match e {
            Some(e) => e.embed(file, segments, signal).await,
            None => Err("analyse des voix indisponible".into()),
        }
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let e = self.embedder.lock().await.take();
        if let Some(e) = e {
            e.close().await;
        }
        // Fish embarqué arrêté : la mémoire de la carte graphique est rendue.
        let s = self.server.lock().await.take();
        if let Some(mut s) = s {
            let _ = s.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(20), s.wait()).await;
            println!("[voix] Fish S2 Pro embarqué arrêté");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voix_clonees_depuis_les_voix_figees() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("voices");
        let voices = load_voices(&dir);
        let roles: Vec<&str> = voices.iter().map(|v| v.role.as_str()).collect();
        assert_eq!(roles, ["A", "B4", "B1", "F"]);
        assert!(voices[0]
            .ref_audio
            .starts_with("data:audio/wav;base64,UklGR"));
        assert!(voices[0].ref_text.starts_with("Bonsoir à tous"));
        let b = speech_body(FISH_DEFAULT_MODEL, &voices[0], "Quel panier !");
        assert_eq!(b["model"], FISH_DEFAULT_MODEL);
        assert_eq!(b["input"], "Quel panier !");
        assert_eq!(b["response_format"], "wav");
        assert_eq!(b["ref_text"], voices[0].ref_text.as_str());
        assert!(b.get("voice").is_none());
    }

    #[test]
    fn balises_d_emotion_et_arguments() {
        assert_eq!(
            spoken_text("  Quel   dunk ! ", Some(2.0)),
            "[excited] Quel dunk !"
        );
        assert_eq!(
            spoken_text("Il monte", Some(1.0)),
            "[enthusiastic] Il monte"
        );
        assert_eq!(spoken_text("Temps mort.", Some(0.0)), "Temps mort.");
        assert_eq!(spoken_text("Temps mort.", None), "Temps mort.");
        let a = embedded_args(FISH_DEFAULT_MODEL, 8091);
        assert_eq!(&a[..4], ["serve", FISH_DEFAULT_MODEL, "--omni", "--host"]);
        assert!(a.windows(2).any(|w| w[0] == "--port" && w[1] == "8091"));
        assert!(a
            .windows(2)
            .any(|w| w[0] == "--gpu-memory-utilization" && w[1] == "0.9"));
    }
}
