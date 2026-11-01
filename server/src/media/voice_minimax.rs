//! Voix du doublage par l'API MiniMax (équivalent de `voiceMinimax.ts`) :
//! synthèse vocale en ligne, voix françaises du catalogue MiniMax.
//!
//!   POST {MINIMAX_API_URL}/v1/t2a_v2     une réplique → WAV mono 24 kHz
//!   POST {MINIMAX_API_URL}/v1/get_voice  à l'ouverture : clé vérifiée, voix contrôlées
//!
//! L'analyse des voix (empreintes, hauteur, genre) reste locale : une
//! [`super::voice_ai::VoiceSession`] ouverte en `--embed-only`.

use super::abort::{is_aborted, sleep, wait_aborted, AbortSignal};
use super::local_ai::{ai_client, short};
use super::voice_ai::{EmbedResult, VoiceSession};
use crate::api::js_num_value;
use crate::js::{self, jsre};
use crate::jsval::js_string;
use crate::settings::{
    env, env_trim, keys, minimax_default_voice, saved_minimax_voices, Settings,
    MINIMAX_DEFAULT_MODEL, MINIMAX_ROLES,
};
use serde_json::{json, Map, Value};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const MINIMAX_DEFAULT_URL: &str = "https://api.minimax.io";
const SAMPLE_RATE: u32 = 24_000;

/// Configuration MiniMax (`minimaxConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct MinimaxConfig {
    pub url: String,
    pub key: String,
    pub model: String,
    /// Rôle → voice_id MiniMax, dans l'ordre des rôles (rôles sans voix retirés).
    pub voices: Vec<(String, String)>,
    /// Débit de parole (0,5 à 2).
    pub speed: f64,
}

impl MinimaxConfig {
    pub fn voice(&self, role: &str) -> Option<&str> {
        self.voices
            .iter()
            .find(|(r, _)| r == role)
            .map(|(_, v)| v.as_str())
    }
}

/// `minimaxConfig` : réglages de la page (prioritaires), sinon variables
/// d'environnement, sinon valeurs par défaut.
pub fn minimax_config(s: &Settings) -> MinimaxConfig {
    let saved = saved_minimax_voices(s);
    let mut voices = Vec::new();
    for role in MINIMAX_ROLES {
        let v = saved
            .iter()
            .find(|(r, _)| *r == role)
            .map(|(_, v)| v.clone())
            .or_else(|| env(&format!("MINIMAX_VOICE_{role}")))
            .unwrap_or_else(|| minimax_default_voice(role).to_string());
        let v = js::trim(&v).to_string();
        if !v.is_empty() {
            voices.push((role.to_string(), v));
        }
    }
    let speed = env("MINIMAX_TTS_SPEED").map_or(f64::NAN, |v| crate::api::js_number(&v));
    let url = env_trim("MINIMAX_API_URL").unwrap_or_else(|| MINIMAX_DEFAULT_URL.into());
    let saved_trim = |k: &str| {
        s.get(k)
            .map(|v| js::trim(v).to_string())
            .filter(|v| !v.is_empty())
    };
    MinimaxConfig {
        url: url.trim_end_matches('/').to_string(),
        key: saved_trim(keys::MINIMAX_API_KEY)
            .or_else(|| env_trim("MINIMAX_API_KEY"))
            .unwrap_or_default(),
        model: saved_trim(keys::MINIMAX_MODEL)
            .or_else(|| env_trim("MINIMAX_TTS_MODEL"))
            .unwrap_or_else(|| MINIMAX_DEFAULT_MODEL.into()),
        voices,
        speed: if speed.is_finite() && (0.5..=2.0).contains(&speed) {
            speed
        } else {
            1.0
        },
    }
}

/// Erreur de l'API ; `retry` : passagère ; `fatal` : clé refusée ou crédit épuisé.
#[derive(Debug, Clone, PartialEq)]
struct MinimaxError {
    message: String,
    retry: bool,
    fatal: bool,
}

impl MinimaxError {
    fn new(message: impl Into<String>, retry: bool) -> Self {
        MinimaxError {
            message: message.into(),
            retry,
            fatal: false,
        }
    }
}

/// Codes passagers : erreur inconnue, délai, débit.
const RETRY_CODES: [f64; 4] = [1000.0, 1001.0, 1002.0, 1039.0];

/// Délais entre deux essais (ms) ; `MINIMAX_RETRY_MS` (liste) pour les tests.
fn retry_delays() -> Vec<u64> {
    let list: Vec<u64> = env("MINIMAX_RETRY_MS")
        .map(|raw| {
            raw.split(',')
                .map(crate::api::js_number)
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u64)
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        vec![2_000, 5_000, 15_000]
    } else {
        list
    }
}

async fn call(
    cfg: &MinimaxConfig,
    route: &str,
    body: &str,
    signal: Option<&AbortSignal>,
) -> Result<Value, MinimaxError> {
    let req = ai_client()
        .post(format!("{}{route}", cfg.url))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", cfg.key))
        .body(body.to_string())
        .timeout(Duration::from_secs(60))
        .send();
    let res = tokio::select! {
        r = req => r,
        _ = wait_aborted(signal) => return Err(MinimaxError::new("requête interrompue", false)),
    };
    let res = res.map_err(|e| {
        let why = if e.is_timeout() {
            "This operation was aborted"
        } else {
            "fetch failed"
        };
        MinimaxError::new(format!("MiniMax injoignable ({})", short(why)), true)
    })?;
    let status = res.status().as_u16();
    let text = tokio::select! {
        t = res.text() => t.unwrap_or_default(),
        _ = wait_aborted(signal) => String::new(),
    };
    if status == 401 || status == 403 {
        return Err(MinimaxError {
            message: format!("MiniMax : clé refusée (HTTP {status})"),
            retry: false,
            fatal: true,
        });
    }
    if !(200..300).contains(&status) {
        return Err(MinimaxError::new(
            format!("MiniMax : HTTP {status} {}", js::slice_utf16(&text, 120)),
            status == 429 || status >= 500,
        ));
    }
    let Some(reply) = crate::jsval::js_parse(&text) else {
        return Err(MinimaxError::new("MiniMax : réponse illisible", true));
    };
    let code = crate::jsval::or_else(
        js::prop(js::prop(Some(&reply), "base_resp"), "status_code"),
        None,
    );
    let is_zero = match code {
        None | Some(Value::Null) => true,
        Some(v) => v.as_f64() == Some(0.0),
    };
    if !is_zero {
        let code_v = code.cloned().unwrap_or(Value::Null);
        let msg_v = js::prop(js::prop(Some(&reply), "base_resp"), "status_msg");
        let msg = if js::truthy(msg_v) {
            js::string_of(msg_v)
        } else {
            "erreur".into()
        };
        let n = code_v.as_f64();
        let what = match n {
            Some(1004.0) => "clé refusée".to_string(),
            Some(1008.0) => "crédit épuisé".to_string(),
            _ => msg.clone(),
        };
        return Err(MinimaxError {
            message: format!(
                "MiniMax : {what} (code {}{})",
                js_string(&code_v),
                if what == msg {
                    String::new()
                } else {
                    format!(" : {msg}")
                }
            ),
            retry: n.is_some_and(|c| RETRY_CODES.contains(&c)),
            fatal: n == Some(1004.0) || n == Some(1008.0),
        });
    }
    Ok(reply)
}

/// Appel retenté sur les erreurs passagères (débit dépassé, délai, serveur).
async fn call_with_retry(
    cfg: &MinimaxConfig,
    route: &str,
    body: &Value,
    signal: Option<&AbortSignal>,
) -> Result<Value, MinimaxError> {
    let delays = retry_delays();
    let body = body.to_string();
    let mut attempt = 0;
    loop {
        match call(cfg, route, &body, signal).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                if !e.retry || attempt >= delays.len() || is_aborted(signal) {
                    return Err(e);
                }
                sleep(delays[attempt], signal).await;
                attempt += 1;
            }
        }
    }
}

/// WAV produit par [`to_wav`].
#[derive(Debug, Clone, PartialEq)]
pub struct Wav {
    pub wav: Vec<u8>,
    /// Durée (s).
    pub duration: f64,
    pub sample_rate: u32,
}

fn u16le(b: &[u8], o: usize) -> u32 {
    u16::from_le_bytes([b[o], b[o + 1]]) as u32
}

fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// `toWav` : WAV PCM 16 bits mono ; `audio` tel quel s'il a déjà un en-tête
/// RIFF (durée lue dans ses blocs, taille des données bornée au fichier),
/// sinon (PCM brut) un en-tête est ajouté.
pub fn to_wav(audio: Vec<u8>, sample_rate: u32) -> Wav {
    if audio.len() >= 44 && &audio[0..4] == b"RIFF" && &audio[8..12] == b"WAVE" {
        let (mut channels, mut sr, mut bits, mut data_bytes) = (1u32, sample_rate, 16u32, 0u64);
        let mut off = 12usize;
        while off + 8 <= audio.len() {
            let id = &audio[off..off + 4];
            let size = u32le(&audio, off + 4) as u64;
            if id == b"fmt " && off + 24 <= audio.len() {
                channels = Some(u16le(&audio, off + 10))
                    .filter(|v| *v != 0)
                    .unwrap_or(1);
                sr = Some(u32le(&audio, off + 12))
                    .filter(|v| *v != 0)
                    .unwrap_or(sample_rate);
                bits = Some(u16le(&audio, off + 22))
                    .filter(|v| *v != 0)
                    .unwrap_or(16);
            } else if id == b"data" {
                data_bytes = size.min((audio.len() - off - 8) as u64);
                break;
            }
            let step = 8u64 + size + (size % 2);
            match off.checked_add(step as usize) {
                Some(n) if (step as usize) as u64 == step => off = n,
                _ => break,
            }
        }
        let duration = data_bytes as f64 / (sr as f64 * channels as f64 * (bits as f64 / 8.0));
        return Wav {
            wav: audio,
            duration,
            sample_rate: sr,
        };
    }
    let n = audio.len() as u32;
    let mut h = Vec::with_capacity(44 + audio.len());
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36u32.wrapping_add(n)).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&1u16.to_le_bytes()); // mono
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&n.to_le_bytes());
    let duration = audio.len() as f64 / (sample_rate as f64 * 2.0);
    h.extend_from_slice(&audio);
    Wav {
        wav: h,
        duration,
        sample_rate,
    }
}

/// `Buffer.from(hex, 'hex')` : décodage arrêté au premier couple invalide.
fn from_hex(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    for pair in b.chunks_exact(2) {
        let d = |c: u8| (c as char).to_digit(16);
        match (d(pair[0]), d(pair[1])) {
            (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
            _ => break,
        }
    }
    out
}

/// `minimaxEmotion` : 2 → « surprised », 1 → « happy », sinon rien ;
/// `MINIMAX_EMOTIONS=0` désactive.
pub fn minimax_emotion(emphasis: Option<f64>) -> Option<&'static str> {
    if env("MINIMAX_EMOTIONS").as_deref() == Some("0") {
        return None;
    }
    let e = emphasis.unwrap_or(0.0);
    if e >= 2.0 {
        Some("surprised")
    } else if e >= 1.0 {
        Some("happy")
    } else {
        None
    }
}

/// `minimaxDelivery` : débit, volume et hauteur d'une réplique selon le
/// moment, comme un commentateur dont la voix monte : 2 (moment fort) plus
/// vite, plus fort et un peu plus haut ; 1 (voix qui monte) un peu plus vite
/// et plus fort ; sinon le débit réglé. `MINIMAX_EMOTIONS=0` désactive aussi.
pub fn minimax_delivery(speed: f64, emphasis: Option<f64>) -> (f64, f64, i64) {
    if env("MINIMAX_EMOTIONS").as_deref() == Some("0") {
        return (speed, 1.0, 0);
    }
    let e = emphasis.unwrap_or(0.0);
    let (k, vol, pitch) = if e >= 2.0 {
        (1.12, 1.5, 1)
    } else if e >= 1.0 {
        (1.06, 1.2, 0)
    } else {
        (1.0, 1.0, 0)
    };
    let s = js::round(js::min(2.0, speed * k) * 100.0) / 100.0;
    (s, vol, pitch)
}

/// Corps exact (JSON) d'une synthèse `/v1/t2a_v2`.
pub fn synth_body(cfg: &MinimaxConfig, voice_id: &str, text: &str, emphasis: Option<f64>) -> Value {
    let (speed, vol, pitch) = minimax_delivery(cfg.speed, emphasis);
    let mut vs = Map::new();
    vs.insert("voice_id".into(), Value::from(voice_id));
    vs.insert("speed".into(), js_num_value(speed));
    vs.insert("vol".into(), js_num_value(vol));
    vs.insert("pitch".into(), Value::from(pitch));
    if let Some(e) = minimax_emotion(emphasis) {
        vs.insert("emotion".into(), Value::from(e));
    }
    json!({
        "model": cfg.model,
        "text": text,
        "stream": false,
        "language_boost": "French",
        "output_format": "hex",
        "voice_setting": vs,
        "audio_setting": { "sample_rate": SAMPLE_RATE, "format": "wav", "channel": 1 },
    })
}

/// Session de voix MiniMax : même contrat que [`VoiceSession`].
pub struct MinimaxVoiceSession {
    cfg: MinimaxConfig,
    embedder: tokio::sync::Mutex<Option<VoiceSession>>,
    closed: AtomicBool,
}

impl MinimaxVoiceSession {
    /// Rôles disponibles ('A', 'B4', 'B1', 'F').
    pub fn voices(&self) -> Vec<String> {
        self.cfg.voices.iter().map(|(r, _)| r.clone()).collect()
    }

    /// Clé vérifiée et voix contrôlées dans le catalogue (`get_voice`), puis
    /// analyse des voix locale ouverte (`open_embedder`). Une clé refusée fait
    /// échouer l'ouverture ; une analyse des voix indisponible non.
    pub async fn open<F, Fut>(
        settings: &Settings,
        signal: Option<&AbortSignal>,
        open_embedder: F,
    ) -> Result<MinimaxVoiceSession, String>
    where
        F: FnOnce(Option<AbortSignal>) -> Fut,
        Fut: Future<Output = Result<VoiceSession, String>>,
    {
        let cfg = minimax_config(settings);
        if cfg.key.is_empty() {
            return Err("clé MiniMax absente (MINIMAX_API_KEY)".into());
        }
        if cfg.voices.is_empty() {
            return Err("aucune voix MiniMax configurée (MINIMAX_VOICE_A…)".into());
        }
        match call_with_retry(
            &cfg,
            "/v1/get_voice",
            &json!({ "voice_type": "system" }),
            signal,
        )
        .await
        {
            Ok(r) => {
                let list = match js::prop(Some(&r), "system_voice") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(a)) => a.clone(),
                    Some(_) => {
                        eprintln!("[voix] MiniMax : catalogue des voix illisible ((intermediate value).map is not a function), on continue");
                        Vec::new()
                    }
                };
                let known: Vec<Option<&Value>> =
                    list.iter().map(|v| js::prop(Some(v), "voice_id")).collect();
                for (role, id) in &cfg.voices {
                    if !known.is_empty()
                        && !known.iter().any(|k| *k == Some(&Value::from(id.clone())))
                    {
                        eprintln!("[voix] MiniMax : voix {id} ({role}) absente du catalogue, la synthèse risque d'échouer");
                    }
                }
            }
            Err(e) => {
                if e.fatal {
                    return Err(e.message);
                }
                if is_aborted(signal) {
                    return Err("ouverture des voix interrompue".into());
                }
                eprintln!(
                    "[voix] MiniMax : catalogue des voix illisible ({}), on continue",
                    short(&e.message)
                );
            }
        }
        let embedder = match open_embedder(signal.cloned()).await {
            Ok(e) => Some(e),
            Err(e) => {
                if is_aborted(signal) {
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
            "[voix] MiniMax prêt ({}, voix {})",
            cfg.model,
            cfg.voices
                .iter()
                .map(|(r, id)| format!("{r}={id}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok(MinimaxVoiceSession {
            cfg,
            embedder: tokio::sync::Mutex::new(embedder),
            closed: AtomicBool::new(false),
        })
    }

    /// Synthétise `text` dans la voix du rôle `voice` vers `out_file` (WAV mono
    /// PCM 16 bits, 24 kHz). Moment fort (`emphasis`) : ton imposé.
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
        let Some(voice_id) = self.cfg.voice(voice) else {
            return Err(format!("voix inconnue : {voice}"));
        };
        let clean = js::trim(&jsre!(r"\s+").replace_all(text, " ")).to_string();
        if clean.is_empty() {
            return Err("texte vide".into());
        }
        let r = call_with_retry(
            &self.cfg,
            "/v1/t2a_v2",
            &synth_body(&self.cfg, voice_id, &clean, emphasis),
            signal,
        )
        .await
        .map_err(|e| e.message)?;
        let hex = match js::prop(js::prop(Some(&r), "data"), "audio") {
            Some(Value::String(h)) if !h.is_empty() => h.clone(),
            _ => return Err("MiniMax : réponse sans audio".into()),
        };
        let sr_v = js::prop(js::prop(Some(&r), "extra_info"), "audio_sample_rate");
        let sr = if js::truthy(sr_v) {
            js::to_number(sr_v) as u32
        } else {
            SAMPLE_RATE
        };
        let w = to_wav(from_hex(&hex), sr);
        if w.duration.is_nan() || w.duration <= 0.0 {
            return Err("MiniMax : audio vide".into());
        }
        std::fs::write(out_file, &w.wav).map_err(|e| e.to_string())?;
        Ok((js::round(w.duration * 1000.0) / 1000.0, w.sample_rate))
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_et_hex() {
        let pcm = vec![0u8; 48_000];
        let w = to_wav(pcm, 24_000);
        assert_eq!(w.wav.len(), 48_044);
        assert_eq!(w.duration, 1.0);
        let mut again = to_wav(vec![0u8; 12_000], 24_000).wav;
        assert!((to_wav(again.clone(), 24_000).duration - 0.25).abs() < 1e-9);
        again[40..44].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        assert!((to_wav(again, 24_000).duration - 0.25).abs() < 1e-9);
        assert_eq!(from_hex("0aFfzz11"), vec![0x0a, 0xff]);
        assert_eq!(from_hex("abc"), vec![0xab]);
    }
}
