//! Lecture du chrono de jeu affiché à l'écran (équivalent de `ocr.ts`),
//! portée à l'étape 7, **pas encore branchée**.
//!
//! Briques bas niveau : parseur du texte du bandeau, extraction d'images
//! (ffmpeg, flux HLS ou MP4), filtres d'image, moteur OCR (trait
//! [`OcrEngine`] ; Tesseract natif derrière la fonction cargo `ocr`, voir
//! [`crate::media::tesseract`]) et sélection des observations cohérentes. La
//! localisation du bandeau est dans [`crate::media::scoreboard`], le balayage
//! de la vidéo dans [`crate::media::video_scan`].
//!
//! Les lectures OCR sont bruitées : [`select_consistent_observations`] ne
//! garde que la plus longue chaîne d'observations compatible avec le modèle
//! physique (le jeu vivant n'est jamais coupé, seuls les temps morts peuvent
//! l'être).

use crate::js::{self, jsre};
use crate::media::audio::ffmpeg_bin;
use crate::media::proc::{exit_code_text, keep_tail, lower_priority, spawn_error_text};
use crate::media::video_scan::FrameObservation;
use crate::vf_sync::{
    game_elapsed, resolve_anchor_wall, BreakInfo, ResolvedAnchor, TimedPlay, Timeline,
};
use std::future::Future;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

// ---------------------------------------------------------------- expressions régulières

/// Frontière de mot de JavaScript (`\b`, caractères de mot ASCII).
const B: &str = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

/// Motif JavaScript → `fancy_regex` (assertions avant/arrière) : `\d` ASCII,
/// `\b` ASCII. Les motifs portés n'emploient pas `.` hors d'une classe.
pub(crate) fn js_fancy(src: &str) -> fancy_regex::Regex {
    let mut out = String::new();
    let mut in_class = false;
    let mut chars = src.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('d') if in_class => out.push_str("0-9"),
                Some('d') => out.push_str("[0-9]"),
                Some('b') if !in_class => out.push_str(B),
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                }
                None => out.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                out.push('[');
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            c => out.push(c),
        }
    }
    fancy_regex::Regex::new(&out).unwrap_or_else(|e| panic!("motif invalide {src:?} : {e}"))
}

/// Motif JavaScript compilé une fois (assertions avant/arrière admises).
macro_rules! fre {
    ($p:expr) => {{
        static R: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
        R.get_or_init(|| $crate::media::ocr::js_fancy($p))
    }};
}
pub(crate) use fre;

/// Première correspondance (`re.exec(t)`) : groupes capturés (`None` si absent).
pub(crate) fn exec(re: &fancy_regex::Regex, t: &str) -> Option<Vec<Option<(usize, String)>>> {
    let c = re.captures(t).ok().flatten()?;
    Some(
        (0..c.len())
            .map(|i| c.get(i).map(|m| (m.start(), m.as_str().to_string())))
            .collect(),
    )
}

/// Toutes les correspondances (`t.matchAll(re)`) : (début en octets, texte, groupes).
pub(crate) fn match_all(
    re: &fancy_regex::Regex,
    t: &str,
) -> Vec<(usize, String, Vec<Option<String>>)> {
    re.captures_iter(t)
        .filter_map(Result::ok)
        .map(|c| {
            let m = c.get(0).expect("correspondance");
            (
                m.start(),
                m.as_str().to_string(),
                (1..c.len())
                    .map(|i| c.get(i).map(|g| g.as_str().to_string()))
                    .collect(),
            )
        })
        .collect()
}

/// `re.test(t)`.
pub(crate) fn test(re: &fancy_regex::Regex, t: &str) -> bool {
    re.is_match(t).unwrap_or(false)
}

/// `t.replace(re_global, rep)`.
pub(crate) fn replace_all(re: &fancy_regex::Regex, t: &str, rep: &str) -> String {
    re.replace_all(t, fancy_regex::NoExpand(rep)).into_owned()
}

/// `Number(chaîne de chiffres)`.
pub(crate) fn num(s: &str) -> f64 {
    crate::api::js_number(s)
}

/// Indice UTF-16 (indices de JavaScript) d'une position en octets.
pub(crate) fn u16_index(s: &str, byte: usize) -> usize {
    s[..byte].encode_utf16().count()
}

// ---------------------------------------------------------------- parseur du bandeau

/// Lecture (période, chrono) d'un texte de bandeau (`ClockReading`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockReading {
    pub period: Option<f64>,
    pub clock_sec: f64,
}

/// Confusions observées avec tesseract.js sur le bandeau NBC (listes explicites).
const PERIOD_VARIANTS: [(&str, f64); 10] = [
    ("1ST", 1.0),
    ("2ND", 2.0),
    ("3RD", 3.0),
    ("4TH", 4.0),
    ("1S7", 1.0),
    ("2NO", 2.0),
    ("2N0", 2.0),
    ("3RO", 3.0),
    ("3R0", 3.0),
    ("4T4", 4.0),
];

/// `periodFromToken` : chiffre de tête d'un jeton « 1ST »… (OT : prolongation).
fn period_from_token(tok: &str) -> Option<f64> {
    let t = tok.to_uppercase();
    if let Some(rest) = t.strip_prefix("OT") {
        let n = num(rest);
        return Some(4.0 + if n == 0.0 || n.is_nan() { 1.0 } else { n });
    }
    let n = t.chars().next().map_or(f64::NAN, |c| num(&c.to_string()));
    (1.0..=4.0).contains(&n).then_some(n)
}

/// `parseScoreboardText` : (période, chrono) d'un texte OCR de bandeau ;
/// rejette les bilans (« 2-0 ») et les valeurs impossibles.
pub fn parse_scoreboard_text(text: &str) -> Option<ClockReading> {
    let t = normalize_ocr_text(text);
    let period = parse_period_text(&t);
    let candidates = parse_clock_candidates(&t);
    let clock = *candidates.first()?;
    if period.is_some_and(|p| p > 4.0) && clock > 300.0 {
        return None;
    }
    Some(ClockReading {
        period,
        clock_sec: clock,
    })
}

/// `normalizeOcrText` : majuscules, séparateurs `|` neutralisés, espaces compactés.
pub fn normalize_ocr_text(text: &str) -> String {
    let up = text.to_uppercase().replace('|', " ");
    jsre!(r"\s+").replace_all(&up, " ").into_owned()
}

/// `parsePeriodText` : période lue dans un texte OCR normalisé, ou `None`.
pub fn parse_period_text(t: &str) -> Option<f64> {
    let strict = exec(fre!(r"\b(1ST|2ND|3RD|4TH)\b"), t)
        .or_else(|| exec(fre!(r"(1ST|2ND|3RD|4TH)(?![A-Z])"), t))
        .and_then(|g| g[1].clone());
    if let Some((_, s)) = strict.filter(|(_, s)| !s.is_empty()) {
        return period_from_token(&s);
    }
    if let Some(g) = exec(fre!(r"\bQ([1-4])\b"), t) {
        return g[1].as_ref().map(|(_, s)| num(s));
    }
    for (pat, value) in PERIOD_VARIANTS {
        if t.contains(pat) {
            return Some(value);
        }
    }
    if let Some(g) = exec(fre!(r"\bOT(\d?)\b"), t) {
        let n = g[1].as_ref().map_or(f64::NAN, |(_, s)| num(s));
        return Some(4.0 + if n == 0.0 || n.is_nan() { 1.0 } else { n });
    }
    None
}

/// `parseClockCandidates` : chronos (s) d'un texte normalisé, dans l'ordre :
/// les `m:ss`, et seulement à défaut les `ss.d` (dixièmes, arrondis).
pub fn parse_clock_candidates(t: &str) -> Vec<f64> {
    let mut out = Vec::new();
    for (_, _, g) in match_all(fre!(r"(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])"), t) {
        let mm = num(g[0].as_deref().unwrap_or(""));
        let ss = num(g[1].as_deref().unwrap_or(""));
        if mm <= 12.0 && ss < 60.0 && !(mm == 12.0 && ss > 0.0) {
            out.push(mm * 60.0 + ss);
        }
    }
    if out.is_empty() {
        for (_, _, g) in match_all(fre!(r"(?<![\d.])(?<!\d:)(\d{1,2})\.(\d)(?![\d.])"), t) {
            let s = num(g[0].as_deref().unwrap_or(""));
            if s < 60.0 {
                out.push(js::round(s + num(g[1].as_deref().unwrap_or("")) / 10.0));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- scores et cohérence

/// Score du match après une action du play-by-play (`ScorePoint`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScorePoint {
    pub period: f64,
    pub clock_sec: f64,
    pub home: f64,
    pub away: f64,
}

/// Action telle que [`score_timeline`] la lit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScorePlay {
    pub seq: f64,
    pub period: f64,
    pub clock_sec: f64,
    pub home_score: Option<f64>,
    pub away_score: Option<f64>,
}

/// Comparateur `(a, b) => x` de JavaScript : signe de `x`, NaN = égalité.
pub(crate) fn sign(x: f64) -> std::cmp::Ordering {
    if x < 0.0 {
        std::cmp::Ordering::Less
    } else if x > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// `scoreTimeline` : évolution du score, triée par séquence (actions sans score ignorées).
pub fn score_timeline(plays: &[ScorePlay]) -> Vec<ScorePoint> {
    let mut s = plays.to_vec();
    s.sort_by(|a, b| sign(a.seq - b.seq));
    s.into_iter()
        .filter_map(|p| match (p.home_score, p.away_score) {
            (Some(home), Some(away)) => Some(ScorePoint {
                period: p.period,
                clock_sec: p.clock_sec,
                home,
                away,
            }),
            _ => None,
        })
        .collect()
}

/// `scoresMatchAt` : les nombres lus contiennent-ils les DEUX scores du
/// match autour de (période, chrono) ? Fenêtre de 45 s avant, 10 s après.
pub fn scores_match_at(
    read: &[f64],
    timeline: &[ScorePoint],
    period: f64,
    clock_sec: f64,
    back: f64,
    fwd: f64,
) -> bool {
    if read.len() < 2 || timeline.is_empty() {
        return false;
    }
    let g = game_elapsed(period, clock_sec);
    let mut before: Option<ScorePoint> = None;
    let mut states: Vec<ScorePoint> = Vec::new();
    for s in timeline {
        let e = game_elapsed(s.period, s.clock_sec);
        if e < g - back {
            before = Some(*s);
        } else if e <= g + fwd {
            states.push(*s);
        } else {
            break;
        }
    }
    if let Some(b) = before {
        states.push(b);
    }
    states
        .iter()
        .any(|s| s.home != s.away && read.contains(&s.home) && read.contains(&s.away))
}

/// Réglages de [`select_consistent_observations`] (`ConsistencyOptions`).
#[derive(Debug, Clone, Default)]
pub struct ConsistencyOptions {
    /// Tolérance (s) sur les écarts vidéo/réel (15).
    pub tolerance: Option<f64>,
    /// Évolution du score (play-by-play).
    pub scores: Option<Vec<ScorePoint>>,
    /// Au-delà de cette durée (s) de chrono arrêté, une lecture est ambiguë (8).
    pub frozen_max: Option<f64>,
}

/// `clockWallInterval` : intervalle wallclock pendant lequel le chrono
/// affiche (période, chrono) — un instant s'il tourne, l'arrêt entier sinon.
pub fn clock_wall_interval(period: f64, clock_sec: f64, tp: &[TimedPlay]) -> Option<(f64, f64)> {
    let mut first: Option<usize> = None;
    let mut last = 0;
    for (i, p) in tp.iter().enumerate() {
        if p.period == period && p.clock_sec == clock_sec {
            if first.is_none() {
                first = Some(i);
            }
            last = i;
        }
    }
    let Some(first) = first else {
        let w = resolve_anchor_wall(period, clock_sec, None, tp)?;
        return Some((w, w));
    };
    // Début de période : le bandeau l'affiche aussi AVANT la première action.
    let lo = if clock_sec >= if period <= 4.0 { 720.0 } else { 300.0 } {
        tp[first].wall - 600.0
    } else {
        tp[first].wall
    };
    let mut hi = tp[last].wall;
    match tp[last + 1..]
        .iter()
        .find(|p| p.period == period && p.clock_sec < clock_sec)
    {
        Some(next) => hi = js::max(hi, next.wall - (clock_sec - next.clock_sec)),
        // Fin de période (0.0) : affiché pendant toute la pause qui suit.
        None => hi += 600.0,
    }
    Some((lo, hi))
}

struct Candidate {
    wall: f64,
    lo: f64,
    hi: f64,
    video: f64,
    period: f64,
    clock_sec: f64,
    weight: f64,
}

/// `selectConsistentObservations` : plus longue chaîne d'observations
/// cohérentes (programmation dynamique), périodes illisibles résolues par
/// hypothèses, scores lus comme bonus ; voir `ocr.ts` pour le détail.
pub fn select_consistent_observations(
    obs: &[FrameObservation],
    tp: &[TimedPlay],
    breaks: &[BreakInfo],
    o: &ConsistencyOptions,
) -> Vec<ResolvedAnchor> {
    let tol = o.tolerance.unwrap_or(15.0);
    let frozen_max = o.frozen_max.unwrap_or(8.0);
    let tl = Timeline::new(breaks);
    let max_period = tp.iter().fold(0.0, |m, p| js::max(m, p.period));
    let mut sorted = obs.to_vec();
    sorted.sort_by(|a, b| sign(a.video_ts - b.video_ts));
    let mut cands: Vec<Candidate> = Vec::new();
    for ob in &sorted {
        let known = ob.period.filter(|p| *p != 0.0 && !p.is_nan());
        let periods: Vec<f64> = match known {
            Some(p) => vec![p],
            None => (0..max_period.max(0.0) as i64)
                .map(|i| (i + 1) as f64)
                .collect(),
        };
        for p in periods {
            if p > max_period {
                continue;
            }
            if ob.clock_sec > if p <= 4.0 { 720.0 } else { 300.0 } {
                continue;
            }
            let Some((lo, hi)) = clock_wall_interval(p, ob.clock_sec, tp) else {
                continue;
            };
            // Arrêt long : poids de base divisé par deux, le bonus des scores reste entier.
            let mut weight = (if known.is_some() { 1.0 } else { 0.6 })
                * (if hi - lo > frozen_max { 0.5 } else { 1.0 });
            if let (Some(sc), Some(read)) = (o.scores.as_ref(), ob.scores.as_ref()) {
                if scores_match_at(read, sc, p, ob.clock_sec, 45.0, 10.0) {
                    weight += if known.is_some() { 0.5 } else { 0.6 };
                }
            }
            cands.push(Candidate {
                wall: (lo + hi) / 2.0,
                lo,
                hi,
                video: ob.video_ts,
                period: p,
                clock_sec: ob.clock_sec,
                weight,
            });
        }
    }
    let n = cands.len();
    if n == 0 {
        return Vec::new();
    }
    let mut score = vec![0.0; n];
    let mut prev: Vec<Option<usize>> = vec![None; n];
    for j in 0..n {
        let b = &cands[j];
        score[j] = b.weight;
        for i in 0..j {
            let a = &cands[i];
            if b.video <= a.video || b.hi < a.lo {
                continue;
            }
            if game_elapsed(b.period, b.clock_sec) < game_elapsed(a.period, a.clock_sec) {
                continue;
            }
            let dv = b.video - a.video;
            let min_live = tl.live(a.hi, b.lo);
            let max_span = tl.live(a.lo, b.hi) + tl.comp(a.lo, b.hi);
            if dv < min_live - tol || dv > max_span + tol {
                continue;
            }
            if score[i] + b.weight > score[j] {
                score[j] = score[i] + b.weight;
                prev[j] = Some(i);
            }
        }
    }
    let mut best = 0;
    for j in 1..n {
        if score[j] > score[best] {
            best = j;
        }
    }
    let mut chain: Vec<&Candidate> = Vec::new();
    let mut k = Some(best);
    while let Some(i) = k {
        chain.push(&cands[i]);
        k = prev[i];
    }
    chain.reverse();
    // Une seule observation par instant vidéo (hypothèses de période exclusives).
    let unique: Vec<&Candidate> = chain
        .iter()
        .enumerate()
        .filter(|(i, a)| *i == 0 || a.video != chain[i - 1].video)
        .map(|(_, a)| *a)
        .collect();
    let precise: Vec<f64> = unique
        .iter()
        .filter(|a| a.hi - a.lo <= frozen_max)
        .map(|a| a.period)
        .collect();
    unique
        .iter()
        .filter(|a| {
            a.hi - a.lo <= frozen_max || (a.hi - a.lo <= 180.0 && !precise.contains(&a.period))
        })
        .map(|a| ResolvedAnchor {
            wall: a.wall,
            video: a.video,
            method: "auto".into(),
            period: a.period,
            clock_sec: a.clock_sec,
        })
        .collect()
}

// ---------------------------------------------------------------- ffmpeg

/// Sortie d'un ffmpeg lancé par [`run_ffmpeg`].
struct FfmpegRun {
    status: Option<ExitStatus>,
    stdout: Vec<u8>,
    stderr: String,
    timed_out: bool,
}

/// ffmpeg en priorité basse, entrée `stdin` (PNG) éventuelle, tué (SIGKILL) au délai.
async fn run_ffmpeg(
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<FfmpegRun, String> {
    let bin = ffmpeg_bin();
    let mut child = Command::new(&bin)
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error_text(&bin, &e))?;
    lower_priority(child.id());
    let input = stdin.map(<[u8]>::to_vec);
    let mut pipe_in = child.stdin.take();
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let write = async move {
        if let (Some(p), Some(data)) = (pipe_in.as_mut(), input) {
            // Le processus peut déjà être tué : l'erreur est gérée par la fin du processus.
            let _ = p.write_all(&data).await;
        }
        drop(pipe_in);
    };
    let read = async {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf).await;
        buf
    };
    let read_err = async {
        let mut tail = String::new();
        let mut buf = vec![0u8; 4096];
        while let Ok(n) = err.read(&mut buf).await {
            if n == 0 {
                break;
            }
            keep_tail(&mut tail, &String::from_utf8_lossy(&buf[..n]), 500);
        }
        tail
    };
    // Délai dépassé : ffmpeg est tué (SIGKILL), sa sortie d'erreur est gardée.
    let io = async {
        let ((), stdout, stderr) = tokio::join!(write, read, read_err);
        (stdout, stderr)
    };
    tokio::pin!(io);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut timed_out = false;
    let (stdout, stderr) = loop {
        tokio::select! {
            r = &mut io => break r,
            _ = &mut deadline, if !timed_out => {
                timed_out = true;
                let _ = child.start_kill();
            }
        }
    };
    let status = child.wait().await.ok();
    Ok(FfmpegRun {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

fn exit_ok(s: Option<&ExitStatus>) -> bool {
    s.and_then(ExitStatus::code) == Some(0)
}

/// `grabFrame` : image PNG à l'instant `t` d'une source lisible par ffmpeg
/// (playlist HLS ou MP4 progressif). Délai : 60 s par défaut.
pub async fn grab_frame(
    source_url: &str,
    t: f64,
    user_agent: &str,
    referer: &str,
    timeout: Option<Duration>,
) -> Result<Vec<u8>, String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-user_agent",
        user_agent,
        "-headers",
        &format!("Referer: {referer}\r\n"),
        "-ss",
        &crate::jsval::js_number_string(t),
        "-i",
        source_url,
        "-an",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ]
    .map(String::from)
    .to_vec();
    let r = run_ffmpeg(&args, None, timeout.unwrap_or(Duration::from_secs(60))).await?;
    if exit_ok(r.status.as_ref()) && !r.stdout.is_empty() {
        Ok(r.stdout)
    } else {
        Err(format!(
            "ffmpeg frame @{}s code {}: {}",
            crate::jsval::js_number_string(t),
            exit_code_text(r.status.as_ref()),
            r.stderr
        ))
    }
}

/// `filterImage` : filtre ffmpeg sur une image PNG en mémoire (délai 20 s :
/// un ffmpeg bloqué ne doit jamais garder l'analyse occupée).
pub async fn filter_image(
    png: &[u8],
    vf: &str,
    timeout_ms: Option<u64>,
) -> Result<Vec<u8>, String> {
    let ms = timeout_ms.unwrap_or(20_000);
    let args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "png_pipe",
        "-i",
        "pipe:0",
        "-vf",
        vf,
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ]
    .map(String::from)
    .to_vec();
    let r = run_ffmpeg(&args, Some(png), Duration::from_millis(ms)).await?;
    if r.timed_out {
        return Err(format!("ffmpeg filtre : timeout {ms} ms"));
    }
    if exit_ok(r.status.as_ref()) {
        Ok(r.stdout)
    } else {
        Err(format!(
            "ffmpeg filtre code {}",
            exit_code_text(r.status.as_ref())
        ))
    }
}

/// `rawGray` : image PNG → niveaux de gris bruts (1 octet par pixel) en
/// `w`×`h`, après le filtre `pre` éventuel. Délai : 20 s par défaut.
pub async fn raw_gray(
    png: &[u8],
    w: u32,
    h: u32,
    timeout_ms: Option<u64>,
    pre: &str,
) -> Result<Vec<u8>, String> {
    let ms = timeout_ms.unwrap_or(20_000);
    let vf = format!(
        "{}scale={w}:{h}:flags=area,format=gray",
        if pre.is_empty() {
            String::new()
        } else {
            format!("{pre},")
        }
    );
    let args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "png_pipe",
        "-i",
        "pipe:0",
        "-vf",
        &vf,
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    .map(String::from)
    .to_vec();
    let r = run_ffmpeg(&args, Some(png), Duration::from_millis(ms)).await?;
    if r.timed_out {
        return Err(format!("ffmpeg gris : timeout {ms} ms"));
    }
    if exit_ok(r.status.as_ref()) && r.stdout.len() == (w * h) as usize {
        Ok(r.stdout)
    } else {
        Err(format!(
            "ffmpeg gris code {} ({} octets)",
            exit_code_text(r.status.as_ref()),
            r.stdout.len()
        ))
    }
}

// ---------------------------------------------------------------- moteur OCR

/// Mot reconnu, avec sa boîte en pixels de l'image analysée (`OcrWord`).
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub confidence: f64,
}

/// Résultat d'une reconnaissance : texte de la page et mots.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OcrPage {
    pub text: String,
    pub words: Vec<OcrWord>,
}

/// Paramètres d'une reconnaissance (`OcrParams`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct OcrParams {
    /// Mode de segmentation : '11' texte épars (défaut), '7' une ligne, '8' un mot.
    pub psm: Option<String>,
    /// Alphabet autorisé ('' = aucun filtre, défaut).
    pub whitelist: Option<String>,
}

impl OcrParams {
    pub fn new(psm: &str, whitelist: &str) -> Self {
        OcrParams {
            psm: Some(psm.into()),
            whitelist: Some(whitelist.into()),
        }
    }

    /// `tessedit_pageseg_mode` appliqué.
    pub fn psm(&self) -> &str {
        self.psm.as_deref().unwrap_or("11")
    }

    /// `tessedit_char_whitelist` appliqué.
    pub fn whitelist(&self) -> &str {
        self.whitelist.as_deref().unwrap_or("")
    }
}

/// Futur d'une reconnaissance.
pub type OcrFut<'a> = Pin<Box<dyn Future<Output = Result<OcrPage, String>> + Send + 'a>>;

/// Moteur OCR (`OcrWorker` de tesseract.js) : reconnaît une image PNG avec
/// les paramètres donnés (`tessedit_pageseg_mode`,
/// `tessedit_char_whitelist`), et rend le texte de la page et ses mots (boîte
/// et confiance de chaque mot, dans l'ordre bloc → paragraphe → ligne → mot).
/// Les reconnaissances d'un moteur sont faites l'une après l'autre.
pub trait OcrEngine: Send + Sync {
    fn recognize<'a>(&'a self, png: &'a [u8], params: &'a OcrParams) -> OcrFut<'a>;
}

/// Alphabet des petites zones « période » (1ST, 2ND, 3RD, 4TH, OT, Q1…) —
/// jamais appliqué à un bandeau entier (tout se collerait en un seul mot).
pub const OCR_WHITELIST: &str = "0123456789:.STNDRHOQ";

/// `recognizeWords` : texte et mots (textes rognés, mots vides écartés).
pub async fn recognize_words(
    engine: &dyn OcrEngine,
    img: &[u8],
    params: &OcrParams,
) -> Result<OcrPage, String> {
    let page = engine.recognize(img, params).await?;
    Ok(OcrPage {
        text: page.text,
        words: page
            .words
            .into_iter()
            .filter_map(|w| {
                let text = js::trim(&w.text).to_string();
                (!text.is_empty()).then_some(OcrWord { text, ..w })
            })
            .collect(),
    })
}

/// `createOcrWorker` : moteur OCR du serveur — Tesseract natif (fonction
/// cargo `ocr`), données de langue `eng` lues dans `TESSDATA_PREFIX`.
pub fn create_ocr_engine() -> Result<Arc<dyn OcrEngine>, String> {
    #[cfg(feature = "ocr")]
    {
        crate::media::tesseract::TesseractEngine::new().map(|e| Arc::new(e) as Arc<dyn OcrEngine>)
    }
    #[cfg(not(feature = "ocr"))]
    {
        Err("OCR indisponible : serveur compilé sans Tesseract (fonction cargo « ocr »)".into())
    }
}

/// `pngSize` : dimensions d'une image PNG (en-tête IHDR), ou `None`.
pub fn png_size(png: &[u8]) -> Option<(f64, f64)> {
    if png.len() < 24 || png[0..4] != [0x89, 0x50, 0x4e, 0x47] || &png[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]) as f64;
    Some((be(16), be(20)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motifs_comme_javascript() {
        assert_eq!(parse_period_text("2ND24"), Some(2.0));
        // Forme stricte refusée, mais la liste des confusions la reprend (comme Node).
        assert_eq!(parse_period_text("1STX"), Some(1.0));
        assert_eq!(parse_period_text("OT7THH"), None);
        assert_eq!(parse_period_text("1:12 OT"), Some(5.0));
        assert_eq!(parse_period_text("OT2"), Some(6.0));
        assert_eq!(parse_period_text("ÉQ3"), Some(3.0));
        assert_eq!(parse_clock_candidates("2ND :29.7 24"), vec![30.0]);
        assert_eq!(parse_clock_candidates("12:01 11:59"), vec![719.0]);
        assert_eq!(u16_index("é😀a", "é😀".len()), 3);
    }
}
