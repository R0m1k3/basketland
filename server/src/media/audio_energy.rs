//! Intensité de la voix des commentateurs, mot par mot (équivalent de
//! `audioEnergy.ts`) : énergie sonore de chaque mot dans l'audio du tronçon,
//! relative au niveau habituel du tronçon. Les sous-titres s'en servent pour
//! couper au bon endroit et mettre en relief les moments forts.

use super::abort::{wait_aborted, AbortSignal};
use super::audio::ffmpeg_bin;
use super::commentary_cues::{AsrWord, Transcript};
use super::proc::lower_priority;
use crate::js;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Enveloppe de puissance d'un son.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// Durée d'une trame (s).
    pub frame_sec: f64,
    /// Puissance moyenne de chaque trame (carré de l'amplitude, 0 à 1),
    /// en simple précision comme le `Float32Array` de Node.
    pub power: Vec<f32>,
}

pub const SAMPLE_RATE: u32 = 8000;
pub const FRAME_SEC: f64 = 0.05;

/// `envelopeFromPcm` : enveloppe d'un PCM 16 bits signé petit-boutiste (mono).
pub fn envelope_from_pcm(pcm: &[u8], sample_rate: f64, frame_sec: f64) -> Envelope {
    let samples = pcm.len() / 2;
    let per = js::max(1.0, js::round(sample_rate * frame_sec)) as usize;
    let frames = samples.div_ceil(per);
    let mut power = vec![0f32; frames];
    for (f, p) in power.iter_mut().enumerate() {
        let a = f * per;
        let b = samples.min(a + per);
        let mut sum = 0.0;
        for i in a..b {
            let x = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]) as f64 / 32768.0;
            sum += x * x;
        }
        *p = if b > a {
            (sum / (b - a) as f64) as f32
        } else {
            0.0
        };
    }
    Envelope {
        frame_sec: per as f64 / sample_rate,
        power,
    }
}

fn to_db(p: f64) -> f64 {
    10.0 * (p + 1e-10).log10()
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() >> 1;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}

/// `addWordEnergy` : `energy` de chaque mot, en dB par rapport au niveau
/// MÉDIAN des mots du tronçon. `offset` : début du tronçon dans l'audio.
/// Les mots hors de l'audio restent sans énergie.
pub fn add_word_energy(words: &[AsrWord], env: &Envelope, offset: f64) -> Vec<AsrWord> {
    let n = env.power.len();
    if n == 0 || words.is_empty() {
        return words.to_vec();
    }
    let raw: Vec<Option<f64>> = words
        .iter()
        .map(|w| {
            let a = js::max(0.0, ((w.start - offset) / env.frame_sec).floor());
            let b = js::min(
                n as f64,
                js::max(a + 1.0, ((w.end - offset) / env.frame_sec).ceil()),
            );
            if a >= n as f64 {
                return None;
            }
            let (ai, bi) = (a as usize, b as usize);
            let sum: f64 = env.power[ai..bi].iter().map(|p| *p as f64).sum();
            Some(to_db(sum / (b - a)))
        })
        .collect();
    let known: Vec<f64> = raw.iter().flatten().copied().collect();
    let r = median(&known);
    words
        .iter()
        .zip(raw)
        .map(|(w, db)| match db {
            None => w.clone(),
            Some(db) => AsrWord {
                energy: Some(js::round((db - r) * 10.0) / 10.0),
                ..w.clone()
            },
        })
        .collect()
}

/// `withEnergy` : le transcript d'un tronçon, ses mots (au niveau supérieur
/// et imbriqués, chacun avec sa propre référence) annotés d'énergie.
pub fn with_energy(t: &Transcript, env: &Envelope) -> Transcript {
    let words = add_word_energy(&t.words, env, 0.0);
    let nested: Vec<AsrWord> = t
        .segments
        .iter()
        .flat_map(|s| s.words.clone().unwrap_or_default())
        .collect();
    let nested_e = if nested.is_empty() {
        Vec::new()
    } else {
        add_word_energy(&nested, env, 0.0)
    };
    let mut k = 0;
    let segments = t
        .segments
        .iter()
        .map(|s| match &s.words {
            Some(ws) => {
                let mut s = s.clone();
                s.words = Some(
                    ws.iter()
                        .map(|_| {
                            k += 1;
                            nested_e[k - 1].clone()
                        })
                        .collect(),
                );
                s
            }
            None => s.clone(),
        })
        .collect();
    Transcript { segments, words }
}

/// `audioEnvelope` : enveloppe d'un fichier audio (décodé par ffmpeg, PCM
/// 8 kHz mono). `None` si le décodage échoue : la mise en relief est un
/// bonus, jamais une raison d'échouer. Délai : 60 s par défaut.
pub async fn audio_envelope(
    file: &str,
    signal: Option<&AbortSignal>,
    timeout: Option<Duration>,
) -> Option<Envelope> {
    let mut child = Command::new(ffmpeg_bin())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            file,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    lower_priority(child.id());
    let mut out = child.stdout.take()?;
    let work = async {
        let mut pcm = Vec::new();
        let _ = out.read_to_end(&mut pcm).await;
        let st = child.wait().await.ok();
        (st, pcm)
    };
    let limit = timeout.unwrap_or(Duration::from_secs(60));
    let (st, pcm) = tokio::select! {
        r = tokio::time::timeout(limit, work) => r.ok()?,
        _ = wait_aborted(signal) => return None,
    };
    (st.and_then(|s| s.code()) == Some(0) && pcm.len() >= 2)
        .then(|| envelope_from_pcm(&pcm, SAMPLE_RATE as f64, FRAME_SEC))
}

#[cfg(test)]
mod tests {
    //! Cas de tests/audio-energy.test.ts.
    use super::*;
    use crate::media::commentary_cues::{parse_verbose_json, shift_transcript, AsrSegment};
    use serde_json::json;

    /// PCM 16 bits mono : une suite de [durée (s), amplitude 0-1] en sinus 440 Hz.
    pub(crate) fn pcm(parts: &[(f64, f64)], sr: f64) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0usize;
        for (d, amp) in parts {
            for _ in 0..(js::round(d * sr) as usize) {
                let v = js::round(
                    amp * 32767.0 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / sr).sin(),
                ) as i16;
                out.extend_from_slice(&v.to_le_bytes());
                i += 1;
            }
        }
        out
    }

    #[test]
    fn enveloppe_et_energie_des_mots() {
        let env = envelope_from_pcm(&pcm(&[(1.0, 0.05), (1.0, 0.4)], 8000.0), 8000.0, FRAME_SEC);
        assert!((env.frame_sec - 0.05).abs() < 1e-9);
        assert_eq!(env.power.len(), 40);
        assert!(env.power[30] > env.power[5] * 50.0);

        let env = envelope_from_pcm(&pcm(&[(2.0, 0.05), (1.0, 0.4)], 8000.0), 8000.0, FRAME_SEC);
        let w = add_word_energy(
            &[
                AsrWord::new(" calm", 0.2, 0.6),
                AsrWord::new(" still", 1.2, 1.6),
                AsrWord::new(" BANG!", 2.2, 2.7),
            ],
            &env,
            0.0,
        );
        assert!(w[0].energy.unwrap().abs() < 0.5);
        let e = w[2].energy.unwrap();
        assert!(e > 16.0 && e < 20.0, "{e}");
    }

    #[test]
    fn hors_audio_et_mots_imbriques() {
        let env = envelope_from_pcm(&pcm(&[(1.0, 0.1)], 8000.0), 8000.0, FRAME_SEC);
        let t = Transcript {
            segments: vec![AsrSegment {
                words: Some(vec![AsrWord::new(" a", 0.1, 0.3)]),
                ..AsrSegment::new(0.0, 1.0, " a b")
            }],
            words: vec![AsrWord::new(" far", 5.0, 5.2), AsrWord::new(" a", 0.1, 0.3)],
        };
        let t = with_energy(&t, &env);
        assert_eq!(t.words[0].energy, None);
        assert_eq!(t.words[1].energy, Some(0.0));
        assert_eq!(t.segments[0].words.as_ref().unwrap()[0].energy, Some(0.0));
        let t = parse_verbose_json(
            &json!({"segments": [{"start": 0, "end": 1, "text": " Wow"}], "words": [{"word": " Wow", "start": 0.1, "end": 0.4, "energy": 7.5}]}),
        );
        assert_eq!(t.words[0].energy, Some(7.5));
        assert_eq!(
            shift_transcript(&t, 600.0, f64::NEG_INFINITY, f64::INFINITY).words[0],
            AsrWord {
                energy: Some(7.5),
                ..AsrWord::new(" Wow", 600.1, 600.4)
            }
        );
    }

    #[tokio::test]
    async fn decodage_impossible_rend_none() {
        assert_eq!(
            audio_envelope("/nonexistent/chunk.ogg", None, None).await,
            None
        );
    }
}
