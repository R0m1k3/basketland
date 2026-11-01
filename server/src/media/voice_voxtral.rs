//! Voix du doublage par Voxtral TTS (Mistral, `mistralai/Voxtral-4B-TTS-2603`),
//! servi par vLLM-Omni :
//!
//! - **embarqué** (par défaut) : `vllm serve … --omni` de l'environnement
//!   `/opt/voxtral` est démarré par le doublage sur la carte graphique, sur
//!   127.0.0.1, et arrêté à la fin (mémoire rendue) ; poids (~8 Go)
//!   téléchargés au premier usage dans `/data/models/hf` ;
//! - **serveur externe** si une adresse est donnée (Paramètres ou `VOXTRAL_URL`).
//!
//!   POST {url}/audio/speech   { model, input, voice, response_format: "wav" } → WAV
//!
//! Les poids ouverts ne clonent pas de voix : chaque rôle (A, B4, B1, F)
//! reçoit une des 20 voix prédéfinies du modèle (`fr_male`, `fr_female`…).
//! L'analyse des voix (empreintes, genre) reste locale, comme avec MiniMax :
//! une [`super::voice_ai::VoiceSession`] ouverte en `--embed-only`.
//!
//! Licence des poids : CC BY-NC 4.0 (usage non commercial).

use super::abort::{wait_aborted, AbortSignal};
use super::local_ai::{ai_client, short};
use super::voice_ai::{EmbedResult, VoiceSession};
use super::voice_minimax::to_wav;
use crate::js::{self, jsre};
use crate::settings::{env_trim, keys, Settings, MINIMAX_ROLES};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};

/// `vllm` de l'environnement embarqué (`VOXTRAL_VLLM`, `/opt/voxtral/bin/vllm`).
pub fn embedded_voxtral_bin() -> String {
    env_trim("VOXTRAL_VLLM").unwrap_or_else(|| "/opt/voxtral/bin/vllm".into())
}

/// Voxtral embarqué présent dans l'image ?
pub fn embedded_voxtral_available() -> bool {
    Path::new(&embedded_voxtral_bin()).exists()
}

/// Arguments de `vllm serve` pour le Voxtral embarqué. Mémoire de la carte
/// réservée (`VOXTRAL_GPU_UTIL`, 0,75 : le doublage a la carte pour lui),
/// longueur maximale (`VOXTRAL_MAX_MODEL_LEN`, 8192 : une réplique est
/// courte), et `VOXTRAL_EXTRA_ARGS` en plus.
pub fn embedded_args(model: &str, port: u16) -> Vec<String> {
    let util = env_trim("VOXTRAL_GPU_UTIL").unwrap_or_else(|| "0.75".into());
    let len = env_trim("VOXTRAL_MAX_MODEL_LEN").unwrap_or_else(|| "8192".into());
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
    if let Some(extra) = env_trim("VOXTRAL_EXTRA_ARGS") {
        a.extend(extra.split_whitespace().map(String::from));
    }
    a
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

/// Démarre le Voxtral embarqué et attend qu'il réponde (premier usage :
/// téléchargement des poids, `VOXTRAL_LOAD_TIMEOUT_MS`, 45 min au plus).
/// Un serveur qui répond déjà sur le port est réutilisé (et pas arrêté).
async fn start_embedded(
    model: &str,
    signal: Option<&AbortSignal>,
) -> Result<(String, Option<Child>), String> {
    let port = crate::media::commentary_ai::int_env("VOXTRAL_PORT", 8091.0, 1024.0, 65535.0) as u16;
    let url = format!("http://127.0.0.1:{port}/v1");
    if server_up(&url).await {
        return Ok((url, None));
    }
    let bin = embedded_voxtral_bin();
    if !Path::new(&bin).exists() {
        return Err(format!(
            "Voxtral absent de cette image ({bin} introuvable) : mettez l'image à jour"
        ));
    }
    let models = super::local_ai::models_dir();
    let hf = models.join("hf");
    // HOME de l'utilisateur non inscriptible dans le conteneur : caches de
    // vLLM, Triton et torch dans le volume.
    let home = models.join("voxtral-home");
    for d in [&hf, &home] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut child = Command::new(&bin)
        .args(embedded_args(model, port))
        .env("HF_HOME", &hf)
        .env("HOME", &home)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("VLLM_NO_USAGE_STATS", "1")
        .env("DO_NOT_TRACK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Voxtral : lancement impossible ({bin}) : {e}"))?;
    println!(
        "[voix] démarrage de Voxtral embarqué ({model}, port {port}) : au premier usage, téléchargement des poids (~8 Go)…"
    );
    let ms = crate::media::commentary_ai::int_env(
        "VOXTRAL_LOAD_TIMEOUT_MS",
        45.0 * 60_000.0,
        10_000.0,
        6.0 * 3_600_000.0,
    );
    let deadline = Instant::now() + Duration::from_millis(ms as u64);
    let t0 = Instant::now();
    loop {
        if server_up(&url).await {
            println!(
                "[voix] Voxtral embarqué prêt en {} s",
                t0.elapsed().as_secs()
            );
            return Ok((url, Some(child)));
        }
        if let Ok(Some(st)) = child.try_wait() {
            return Err(format!(
                "Voxtral embarqué arrêté au démarrage ({st}) : voir les lignes précédentes du journal"
            ));
        }
        if Instant::now() > deadline {
            let _ = child.start_kill();
            return Err(format!(
                "Voxtral embarqué : pas prêt après {} min",
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

/// Modèle servi par défaut (`VOXTRAL_MODEL`).
pub const VOXTRAL_DEFAULT_MODEL: &str = "mistralai/Voxtral-4B-TTS-2603";

/// Les 20 voix prédéfinies du modèle (dossier `voice_embedding` des poids).
pub const VOXTRAL_VOICES: [&str; 20] = [
    "fr_male",
    "fr_female",
    "neutral_male",
    "neutral_female",
    "casual_male",
    "casual_female",
    "cheerful_female",
    "ar_male",
    "de_female",
    "de_male",
    "es_female",
    "es_male",
    "hi_female",
    "hi_male",
    "it_female",
    "it_male",
    "nl_female",
    "nl_male",
    "pt_female",
    "pt_male",
];

/// Voix par défaut d'un rôle : la voix française d'homme pour le
/// commentateur, d'autres voix d'homme pour les suivants (une seule voix
/// d'homme française existe), la voix française de femme pour F.
pub fn voxtral_default_voice(role: &str) -> &'static str {
    match role {
        "A" => "fr_male",
        "B4" => "neutral_male",
        "B1" => "casual_male",
        _ => "fr_female",
    }
}

/// Configuration Voxtral.
#[derive(Debug, Clone, PartialEq)]
pub struct VoxtralConfig {
    /// Adresse de l'API compatible OpenAI (`…/v1`), sans `/` final ; vide : non configuré.
    pub url: String,
    pub model: String,
    /// Rôle → voix prédéfinie, dans l'ordre des rôles.
    pub voices: Vec<(String, String)>,
}

impl VoxtralConfig {
    pub fn voice(&self, role: &str) -> Option<&str> {
        self.voices
            .iter()
            .find(|(r, _)| r == role)
            .map(|(_, v)| v.as_str())
    }
}

/// Voix enregistrées dans les Paramètres (`voxtral_voices`, JSON `{ rôle: voix }`).
pub fn saved_voxtral_voices(s: &Settings) -> Vec<(String, String)> {
    let Some(Value::Object(m)) = s
        .get(keys::VOXTRAL_VOICES)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    else {
        return Vec::new();
    };
    MINIMAX_ROLES
        .iter()
        .filter_map(|r| {
            m.get(*r)
                .and_then(Value::as_str)
                .filter(|v| VOXTRAL_VOICES.contains(v))
                .map(|v| (r.to_string(), v.to_string()))
        })
        .collect()
}

/// `voxtralConfig` : réglages de la page, sinon `VOXTRAL_URL`,
/// `VOXTRAL_MODEL`, `VOXTRAL_VOICE_<rôle>`, sinon valeurs par défaut.
pub fn voxtral_config(s: &Settings) -> VoxtralConfig {
    let saved = saved_voxtral_voices(s);
    let voices = MINIMAX_ROLES
        .iter()
        .map(|role| {
            let v = saved
                .iter()
                .find(|(r, _)| r == role)
                .map(|(_, v)| v.clone())
                .or_else(|| env_trim(&format!("VOXTRAL_VOICE_{role}")))
                .unwrap_or_else(|| voxtral_default_voice(role).to_string());
            (role.to_string(), v)
        })
        .collect();
    let url = s
        .get(keys::VOXTRAL_URL)
        .map(|u| js::trim(u).to_string())
        .filter(|u| !u.is_empty())
        .or_else(|| env_trim("VOXTRAL_URL"))
        .unwrap_or_default();
    VoxtralConfig {
        url: url.trim_end_matches('/').to_string(),
        model: env_trim("VOXTRAL_MODEL").unwrap_or_else(|| VOXTRAL_DEFAULT_MODEL.into()),
        voices,
    }
}

/// Adresse acceptée dans les Paramètres : `http(s)://hôte[:port][/chemin]`.
pub fn voxtral_url_error(url: &str) -> Option<&'static str> {
    let u = js::trim(url);
    if u.is_empty() {
        return None;
    }
    if u.len() > 500 || !jsre!(r"^https?://[^\s/]+(/\S*)?$").is_match(u) {
        return Some("adresse Voxtral invalide (attendu : http://hôte:port/v1)");
    }
    None
}

/// Corps exact d'une synthèse.
pub fn speech_body(cfg: &VoxtralConfig, voice: &str, text: &str) -> Value {
    json!({
        "model": cfg.model,
        "input": text,
        "voice": voice,
        "response_format": "wav",
    })
}

/// Délai d'une synthèse (`VOXTRAL_TIMEOUT_MS`, 120 s).
fn timeout() -> Duration {
    let ms =
        crate::media::commentary_ai::int_env("VOXTRAL_TIMEOUT_MS", 120_000.0, 1_000.0, 900_000.0);
    Duration::from_millis(ms as u64)
}

/// Session de voix Voxtral : même contrat que [`VoiceSession`].
pub struct VoxtralVoiceSession {
    cfg: VoxtralConfig,
    embedder: tokio::sync::Mutex<Option<VoiceSession>>,
    /// Voxtral embarqué lancé par cette session (arrêté à la fermeture).
    server: tokio::sync::Mutex<Option<Child>>,
    closed: AtomicBool,
}

impl VoxtralVoiceSession {
    /// Rôles disponibles ('A', 'B4', 'B1', 'F').
    pub fn voices(&self) -> Vec<String> {
        self.cfg.voices.iter().map(|(r, _)| r.clone()).collect()
    }

    /// Serveur joint (`GET {url}/models`), puis analyse des voix locale
    /// ouverte. Un serveur injoignable fait échouer l'ouverture (nouvel essai
    /// automatique du doublage) ; une analyse des voix indisponible non.
    pub async fn open<F, Fut>(
        settings: &Settings,
        signal: Option<&AbortSignal>,
        open_embedder: F,
    ) -> Result<VoxtralVoiceSession, String>
    where
        F: FnOnce(Option<AbortSignal>) -> Fut,
        Fut: Future<Output = Result<VoiceSession, String>>,
    {
        let mut cfg = voxtral_config(settings);
        let mut server = None;
        if cfg.url.is_empty() {
            let (url, child) = start_embedded(&cfg.model, signal).await?;
            cfg.url = url;
            server = child;
        }
        let probe = ai_client()
            .get(format!("{}/models", cfg.url))
            .timeout(Duration::from_secs(10))
            .send();
        let res = tokio::select! {
            r = probe => r,
            _ = wait_aborted(signal) => return Err("ouverture des voix interrompue".into()),
        };
        match res {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                return Err(format!(
                    "serveur Voxtral ({}) : HTTP {}",
                    cfg.url,
                    r.status().as_u16()
                ))
            }
            Err(e) => {
                return Err(format!(
                    "serveur Voxtral injoignable ({}) : {}",
                    cfg.url,
                    short(&e.to_string())
                ))
            }
        }
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
            "[voix] Voxtral prêt ({}, {}, voix {})",
            cfg.url,
            cfg.model,
            cfg.voices
                .iter()
                .map(|(r, v)| format!("{r}={v}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok(VoxtralVoiceSession {
            cfg,
            embedder: tokio::sync::Mutex::new(embedder),
            server: tokio::sync::Mutex::new(server),
            closed: AtomicBool::new(false),
        })
    }

    /// Synthétise `text` dans la voix du rôle `voice` vers `out_file` (WAV).
    pub async fn synth(
        &self,
        text: &str,
        voice: &str,
        out_file: &str,
        signal: Option<&AbortSignal>,
    ) -> Result<(f64, u32), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("session de voix fermée".into());
        }
        let Some(voice_id) = self.cfg.voice(voice) else {
            return Err(format!("voix inconnue : {voice}"));
        };
        let clean = js::trim(&jsre!(r"\s+").replace_all(text, " ")).to_string();
        if clean.is_empty() {
            return Err("texte vide".into());
        }
        let body = speech_body(&self.cfg, voice_id, &clean).to_string();
        let mut last = String::new();
        // Un nouvel essai après une erreur passagère (réseau, 5xx, 429).
        for attempt in 0..2 {
            let req = ai_client()
                .post(format!("{}/audio/speech", self.cfg.url))
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
                    let w = to_wav(bytes.to_vec(), 24_000);
                    if w.duration.is_nan() || w.duration <= 0.0 {
                        return Err("Voxtral : audio vide".into());
                    }
                    std::fs::write(out_file, &w.wav).map_err(|e| e.to_string())?;
                    return Ok((js::round(w.duration * 1000.0) / 1000.0, w.sample_rate));
                }
                Ok(r) => {
                    let status = r.status().as_u16();
                    let detail = r.text().await.unwrap_or_default();
                    last = format!(
                        "Voxtral : HTTP {status} {}",
                        js::slice_utf16(js::trim(&detail), 160)
                    );
                    status == 429 || status >= 500
                }
                Err(e) => {
                    last = format!("serveur Voxtral injoignable : {}", short(&e.to_string()));
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
        // Voxtral embarqué arrêté : la mémoire de la carte graphique est rendue.
        let s = self.server.lock().await.take();
        if let Some(mut s) = s {
            let _ = s.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(20), s.wait()).await;
            println!("[voix] Voxtral embarqué arrêté");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration() {
        let s = Settings::from_pairs([
            ("voxtral_url", " http://192.168.1.10:8000/v1/ "),
            (
                "voxtral_voices",
                r#"{"A":"fr_male","B4":"fr_male","F":"inconnue"}"#,
            ),
        ]);
        let c = voxtral_config(&s);
        assert_eq!(c.url, "http://192.168.1.10:8000/v1");
        assert_eq!(c.voice("A"), Some("fr_male"));
        assert_eq!(c.voice("B4"), Some("fr_male"));
        assert_eq!(c.voice("B1"), Some("casual_male"));
        assert_eq!(c.voice("F"), Some("fr_female")); // voix inconnue ignorée
        assert_eq!(
            speech_body(&c, "fr_male", "Quel panier !"),
            json!({
                "model": VOXTRAL_DEFAULT_MODEL,
                "input": "Quel panier !",
                "voice": "fr_male",
                "response_format": "wav",
            })
        );
        assert!(voxtral_url_error("http://nas:8000/v1").is_none());
        assert!(voxtral_url_error("").is_none());
        assert!(voxtral_url_error("nas:8000").is_some());
        assert!(voxtral_url_error("http://a b").is_some());
        let a = embedded_args(VOXTRAL_DEFAULT_MODEL, 8091);
        assert_eq!(
            &a[..4],
            ["serve", VOXTRAL_DEFAULT_MODEL, "--omni", "--host"]
        );
        assert!(a.windows(2).any(|w| w[0] == "--port" && w[1] == "8091"));
    }
}
