//! Audio et ffmpeg (équivalent de `audio.ts`, plus les extractions ffmpeg de
//! `commentary.ts` : `extractAudioChunk`, `extractFullAudio`, `cutAudio`).
//!
//! - [`RmsAccumulator`] / [`compute_rms_db`] : profil RMS (dBFS) par fenêtre d'1 s, en flux ;
//! - [`detect_cuts`] : intervalles de très faible énergie = coupures (pubs, transitions) ;
//! - [`analyze_hls_audio`] : décode l'audio d'un flux HLS via ffmpeg et calcule le profil ;
//! - [`extract_audio_chunk`], [`extract_full_audio`], [`cut_audio`] : son
//!   mono 16 kHz Opus 24 kb/s en Ogg, pour Whisper et le doublage.

use super::abort::{wait_aborted, AbortSignal};
use super::proc::{exit_code_text, keep_tail, lower_priority, spawn_error_text};
use crate::js::{self, jsre};
use crate::jsval::js_number_string;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

pub const SILENCE_FLOOR_DB: f64 = -90.0;

/// Binaire ffmpeg (`FFMPEG_PATH`, sinon `ffmpeg`).
pub fn ffmpeg_bin() -> String {
    std::env::var("FFMPEG_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "ffmpeg".into())
}

/// `ffmpegAvailable` (vérifié une fois).
pub fn ffmpeg_available() -> bool {
    crate::state::ffmpeg_available()
}

pub fn rms_to_db(rms: f64) -> f64 {
    if rms <= 0.0 {
        return SILENCE_FLOOR_DB;
    }
    js::max(SILENCE_FLOOR_DB, 20.0 * rms.log10())
}

/// Accumule des échantillons PCM s16le mono et produit un niveau dBFS par fenêtre.
#[derive(Debug, Clone)]
pub struct RmsAccumulator {
    sum_sq: f64,
    count: usize,
    carry: Option<u8>,
    pub profile: Vec<f64>,
    samples_per_window: usize,
}

impl RmsAccumulator {
    pub fn new(sample_rate: f64, window_sec: f64) -> Self {
        RmsAccumulator {
            sum_sq: 0.0,
            count: 0,
            carry: None,
            profile: Vec::new(),
            samples_per_window: js::max(1.0, js::round(sample_rate * window_sec)) as usize,
        }
    }

    pub fn push_sample(&mut self, v: f64) {
        let x = v / 32768.0;
        self.sum_sq += x * x;
        self.count += 1;
        if self.count >= self.samples_per_window {
            self.flush_window();
        }
    }

    /// Accepte des blocs arbitraires (gère l'octet orphelin entre deux blocs).
    pub fn push_buffer(&mut self, buf: &[u8]) {
        let mut i = 0;
        if let (Some(c), Some(first)) = (self.carry, buf.first()) {
            self.push_sample(i16::from_le_bytes([c, *first]) as f64);
            self.carry = None;
            i = 1;
        }
        while i + 1 < buf.len() {
            self.push_sample(i16::from_le_bytes([buf[i], buf[i + 1]]) as f64);
            i += 2;
        }
        if i < buf.len() {
            self.carry = Some(buf[i]);
        }
    }

    fn flush_window(&mut self) {
        let rms = (self.sum_sq / self.count as f64).sqrt();
        self.profile.push(js::round(rms_to_db(rms) * 10.0) / 10.0);
        self.sum_sq = 0.0;
        self.count = 0;
    }

    pub fn finish(mut self) -> Vec<f64> {
        if self.count > 0 {
            self.flush_window();
        }
        self.profile
    }
}

pub fn compute_rms_db(samples: &[f64], sample_rate: f64, window_sec: f64) -> Vec<f64> {
    let mut acc = RmsAccumulator::new(sample_rate, window_sec);
    for s in samples {
        acc.push_sample(*s);
    }
    acc.finish()
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return SILENCE_FLOOR_DB;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s[s.len() / 2]
}

/// Réglages de [`detect_cuts`] (`None` : défaut de Node).
#[derive(Debug, Clone, Copy, Default)]
pub struct CutOptions {
    /// Seuil relatif sous la médiane (dB, 20).
    pub drop_db: Option<f64>,
    /// Seuil absolu (dBFS, -60).
    pub absolute_db: Option<f64>,
    /// Durée minimale d'une coupure (fenêtres, 2).
    pub min_len: Option<usize>,
    /// Fusionne deux coupures séparées de moins de N fenêtres (2).
    pub merge_gap: Option<usize>,
    pub window_sec: Option<f64>,
}

/// Coupure audio (`CutInterval`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutInterval {
    pub start: f64,
    pub end: f64,
    pub mean_db: f64,
}

/// `detectCuts` : fenêtres dont l'énergie est très en dessous du niveau typique de jeu.
pub fn detect_cuts(profile_db: &[f64], o: &CutOptions) -> Vec<CutInterval> {
    let w = o.window_sec.unwrap_or(1.0);
    let loud: Vec<f64> = profile_db
        .iter()
        .copied()
        .filter(|v| *v > SILENCE_FLOOR_DB)
        .collect();
    let med = median(&loud);
    let threshold = js::max(
        o.absolute_db.unwrap_or(-60.0),
        med - o.drop_db.unwrap_or(20.0),
    );
    let min_len = o.min_len.unwrap_or(2);
    let merge_gap = o.merge_gap.unwrap_or(2);
    let mut raw: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for i in 0..=profile_db.len() {
        let low = i < profile_db.len() && profile_db[i] <= threshold;
        match (low, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                raw.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in raw {
        match merged.last_mut() {
            Some(last) if r.0 - last.1 <= merge_gap => last.1 = r.1,
            _ => merged.push(r),
        }
    }
    merged
        .into_iter()
        .filter(|(s, e)| e - s >= min_len)
        .map(|(s, e)| {
            let slice = &profile_db[s..e];
            let mean = slice.iter().sum::<f64>() / js::max(1.0, slice.len() as f64);
            CutInterval {
                start: s as f64 * w,
                end: e as f64 * w,
                mean_db: js::round(mean * 10.0) / 10.0,
            }
        })
        .collect()
}

/// En-têtes HTTP de la source (flux ok.ru).
#[derive(Debug, Clone, Default)]
pub struct SourceHeaders {
    pub user_agent: Option<String>,
    pub referer: Option<String>,
}

/// `analyzeHlsAudio` : décode l'audio d'une playlist HLS et rend le profil
/// dBFS (1 valeur / s). `sample_rate` : 4000 par défaut ; délai : 45 min.
pub async fn analyze_hls_audio(
    playlist_url: &str,
    user_agent: &str,
    referer: &str,
    sample_rate: Option<u32>,
    timeout: Option<Duration>,
) -> Result<Vec<f64>, String> {
    let sr = sample_rate.unwrap_or(4000);
    let bin = ffmpeg_bin();
    let mut child = Command::new(&bin)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-user_agent",
            user_agent,
            "-headers",
            &format!("Referer: {referer}\r\n"),
            "-i",
            playlist_url,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &sr.to_string(),
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error_text(&bin, &e))?;
    lower_priority(child.id());
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let mut acc = RmsAccumulator::new(sr as f64, 1.0);
    let read = async {
        let mut buf = vec![0u8; 65536];
        while let Ok(n) = out.read(&mut buf).await {
            if n == 0 {
                break;
            }
            acc.push_buffer(&buf[..n]);
        }
    };
    let mut tail = String::new();
    let stderr = async {
        let mut buf = vec![0u8; 4096];
        while let Ok(n) = err.read(&mut buf).await {
            if n == 0 {
                break;
            }
            keep_tail(&mut tail, &String::from_utf8_lossy(&buf[..n]), 2000);
        }
    };
    let work = async {
        tokio::join!(read, stderr);
        child.wait().await.ok()
    };
    let limit = timeout.unwrap_or(Duration::from_secs(45 * 60));
    // Délai dépassé : ffmpeg est tué (`kill_on_drop`), le profil lu est gardé.
    let status = tokio::time::timeout(limit, work).await.ok().flatten();
    let profile = acc.finish();
    let code_ok = status.as_ref().and_then(|s| s.code()) == Some(0);
    if code_ok || profile.len() > 600 {
        Ok(profile)
    } else {
        Err(format!(
            "ffmpeg code {}: {tail}",
            exit_code_text(status.as_ref())
        ))
    }
}

// ---------------------------------------------------------------- extraction (commentary.ts)

/// Options des extractions : en-têtes de la source, interruption, délai.
#[derive(Clone, Default)]
pub struct ExtractOptions {
    pub headers: SourceHeaders,
    pub signal: Option<AbortSignal>,
    pub timeout: Option<Duration>,
}

fn is_http(url: &str) -> bool {
    jsre!(r"^https?://", "i").is_match(url)
}

fn header_args(url: &str, h: &SourceHeaders) -> Vec<String> {
    let mut a = Vec::new();
    if is_http(url) {
        if let Some(ua) = h.user_agent.as_deref().filter(|s| !s.is_empty()) {
            a.extend(["-user_agent".to_string(), ua.to_string()]);
        }
        if let Some(r) = h.referer.as_deref().filter(|s| !s.is_empty()) {
            a.extend(["-headers".to_string(), format!("Referer: {r}\r\n")]);
        }
    }
    a
}

const OPUS_ARGS: [&str; 12] = [
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    "-application",
    "voip",
    "-f",
];

fn file_size(p: &str) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// `err.replace(/\s+/g, ' ').trim()`.
fn squash(s: &str) -> String {
    js::trim(&jsre!(r"\s+").replace_all(s, " ")).to_string()
}

/// `extractAudioChunk` : extrait `length` s à partir de `start` (mono 16 kHz,
/// Opus 24 kb/s en Ogg) ; écrit `<out>.part` puis renomme : un fichier
/// présent est toujours complet. Délai : 20 min par défaut.
pub async fn extract_audio_chunk(
    source_url: &str,
    start: f64,
    length: f64,
    out_file: &str,
    o: &ExtractOptions,
) -> Result<(), String> {
    let part = format!("{out_file}.part");
    let bin = ffmpeg_bin();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"]
        .map(String::from)
        .to_vec();
    args.extend(header_args(source_url, &o.headers));
    args.extend([
        "-ss".into(),
        js_number_string(start),
        "-i".into(),
        source_url.into(),
        "-t".into(),
        js_number_string(length),
    ]);
    args.extend(OPUS_ARGS.map(String::from));
    args.extend(["ogg".into(), "-y".into(), part.clone()]);
    let mut child = Command::new(&bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error_text(&bin, &e))?;
    lower_priority(child.id());
    let mut err_pipe = child.stderr.take().expect("stderr");
    let mut err = String::new();
    let limit = o.timeout.unwrap_or(Duration::from_secs(20 * 60));
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let mut buf = vec![0u8; 4096];
    let mut stderr_open = true;
    let mut killed = false;
    let status = loop {
        tokio::select! {
            r = err_pipe.read(&mut buf), if stderr_open => match r {
                Ok(n) if n > 0 => keep_tail(&mut err, &String::from_utf8_lossy(&buf[..n]), 600),
                _ => stderr_open = false,
            },
            st = child.wait() => break st.ok(),
            _ = &mut deadline, if !killed => { killed = true; let _ = child.start_kill(); }
            _ = wait_aborted(o.signal.as_ref()), if !killed => { killed = true; let _ = child.start_kill(); }
        }
    };
    // Fin de stderr encore en tampon.
    if let Ok(Ok(n)) =
        tokio::time::timeout(Duration::from_millis(200), err_pipe.read(&mut buf)).await
    {
        keep_tail(&mut err, &String::from_utf8_lossy(&buf[..n]), 600);
    }
    let size = file_size(&part);
    let ok = status.as_ref().and_then(|s| s.code()) == Some(0);
    if ok && size > 1024 {
        std::fs::rename(&part, out_file).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        let _ = std::fs::remove_file(&part);
        Err(format!(
            "ffmpeg audio @{}s code {}{}: {}",
            js_number_string(start),
            exit_code_text(status.as_ref()),
            if size <= 1024 { ", aucun son lu" } else { "" },
            squash(&err)
        ))
    }
}

/// `cutAudio` : découpe sur place `length` s du son local `file` (coupe exacte, délai 2 min).
pub async fn cut_audio(
    file: &str,
    start: f64,
    length: f64,
    out_file: &str,
    signal: Option<AbortSignal>,
) -> Result<(), String> {
    let o = ExtractOptions {
        signal,
        timeout: Some(Duration::from_secs(120)),
        ..Default::default()
    };
    extract_audio_chunk(file, start, length, out_file, &o).await
}

/// `extractFullAudio` : son de TOUT le match en une passe, écrit au fil de
/// l'eau dans `out_file` ; `on_progress(s)` : secondes déjà extraites.
/// `COMMENTARY_AUDIO_READRATE` : vitesse de lecture maximale (`-readrate`).
/// Arrêtée sans progression pendant `idle` (2 min par défaut).
pub async fn extract_full_audio(
    source_url: &str,
    out_file: &str,
    o: &ExtractOptions,
    on_progress: Option<&(dyn Fn(f64) + Send + Sync)>,
    idle: Option<Duration>,
) -> Result<(), String> {
    let readrate = std::env::var("COMMENTARY_AUDIO_READRATE")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    let bin = ffmpeg_bin();
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
    ]
    .map(String::from)
    .to_vec();
    args.extend(header_args(source_url, &o.headers));
    if readrate.is_finite() && readrate > 0.0 {
        args.extend(["-readrate".into(), js_number_string(readrate)]);
    }
    args.extend(["-i".into(), source_url.into()]);
    // Chaque paquet écrit tout de suite sur le disque : le fichier est découpé
    // PENDANT l'extraction dès que `out_time` couvre le tronçon ; sans ça,
    // ffmpeg n'écrit que par blocs de 512 Ko (2 à 3 min) et la découpe sortait
    // tronquée, sans erreur (même réglage que Node).
    args.extend(["-flush_packets".into(), "1".into()]);
    args.extend(OPUS_ARGS.map(String::from));
    args.extend(["ogg".into(), "-y".into(), out_file.into()]);
    let mut child = Command::new(&bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error_text(&bin, &e))?;
    lower_priority(child.id());
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut err_pipe = child.stderr.take().expect("stderr");
    let idle = idle.unwrap_or(Duration::from_secs(120));
    let mut tick = tokio::time::interval(idle.min(Duration::from_secs(5)));
    tick.tick().await;
    let mut last = tokio::time::Instant::now();
    let mut err = String::new();
    let mut buf = vec![0u8; 4096];
    let (mut out_open, mut err_open, mut killed) = (true, true, false);
    let status = loop {
        tokio::select! {
            l = lines.next_line(), if out_open => match l {
                Ok(Some(l)) => {
                    if let Some(m) = jsre!(r"^out_time_(?:us|ms)=(\d+)").captures(js::trim(&l)) {
                        last = tokio::time::Instant::now();
                        if let Some(f) = on_progress {
                            f(crate::api::js_number(&m[1]) / 1e6);
                        }
                    }
                }
                _ => out_open = false,
            },
            r = err_pipe.read(&mut buf), if err_open => match r {
                Ok(n) if n > 0 => keep_tail(&mut err, &String::from_utf8_lossy(&buf[..n]), 600),
                _ => err_open = false,
            },
            _ = tick.tick() => {
                if !killed && last.elapsed() > idle {
                    err = format!("aucune progression depuis {} s {err}", js::round(idle.as_millis() as f64 / 1000.0));
                    killed = true;
                    let _ = child.start_kill();
                }
            }
            st = child.wait() => break st.ok(),
            _ = wait_aborted(o.signal.as_ref()), if !killed => { killed = true; let _ = child.start_kill(); }
        }
    };
    let size = file_size(out_file);
    let ok = status.as_ref().and_then(|s| s.code()) == Some(0);
    if ok && size > 1024 {
        Ok(())
    } else {
        Err(format!(
            "ffmpeg son complet code {}{}: {}",
            exit_code_text(status.as_ref()),
            if size <= 1024 { ", aucun son lu" } else { "" },
            squash(&err)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profil_et_coupures() {
        let mut acc = RmsAccumulator::new(4.0, 1.0);
        // Échantillon coupé entre deux blocs.
        acc.push_buffer(&[0x00, 0x40, 0x00]);
        acc.push_buffer(&[0x40, 0x00, 0x40, 0x00, 0x40]);
        let p = acc.finish();
        assert_eq!(p, vec![-6.0]);
        let mut prof = vec![-20.0; 30];
        for v in prof.iter_mut().skip(10).take(4) {
            *v = -80.0;
        }
        prof[16] = -85.0;
        let cuts = detect_cuts(&prof, &CutOptions::default());
        assert_eq!(
            cuts,
            vec![CutInterval {
                start: 10.0,
                end: 17.0,
                mean_db: -63.6
            }]
        );
        assert!(detect_cuts(&[], &CutOptions::default()).is_empty());
    }
}
