//! Parties pures de `commentary.ts` : découpage en tronçons, ordre de
//! traitement, couverture, sous-titres d'un tronçon ; et les petites pièces
//! d'`analysis.ts` dont la file dépend (choix des sources audio, backoff).

use crate::commentary_db::chunk_seq_base;
use crate::js;
use crate::js::jsre;
use crate::media::commentary_cues::{
    build_cues, filter_transcript, shift_transcript, words_from_transcript, AsrWord, Cue,
    CueOptions, Transcript,
};
use crate::okru::{Mp4Source, Variant};
use std::collections::HashSet;

// ---------------------------------------------------------------- tronçons

/// Recouvrement entre deux tronçons (s) : un mot coupé à la frontière est entier dans l'un des deux.
pub const CHUNK_OVERLAP_SEC: f64 = 3.0;

/// Un tronçon (`ChunkPlan`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChunkPlan {
    pub index: usize,
    /// Début de l'extraction dans la vidéo (s).
    pub start: f64,
    /// Durée extraite (s).
    pub length: f64,
    /// Zone gardée de ce tronçon (milieu des mots dans [keep_from, keep_to[).
    pub keep_from: f64,
    /// `f64::INFINITY` pour le dernier tronçon.
    pub keep_to: f64,
}

/// `planChunks` : tronçons de `chunk_sec`, chevauchant de `overlap` s
/// ([`CHUNK_OVERLAP_SEC`] par défaut). Un reliquat de moins de 30 s est
/// rattaché au tronçon précédent ; le dernier est lu jusqu'à la fin du flux.
pub fn plan_chunks(duration: f64, chunk_sec: f64, overlap: Option<f64>) -> Vec<ChunkPlan> {
    let overlap = overlap.unwrap_or(CHUNK_OVERLAP_SEC);
    let d = js::max(0.0, duration);
    let mut n = js::max(1.0, (d / chunk_sec).ceil()) as usize;
    if n > 1 && d - (n as f64 - 1.0) * chunk_sec < 30.0 {
        n -= 1;
    }
    (0..n)
        .map(|i| {
            let keep_from = i as f64 * chunk_sec;
            let last = i == n - 1;
            let keep_to = if last {
                f64::INFINITY
            } else {
                (i as f64 + 1.0) * chunk_sec
            };
            let start = js::max(0.0, keep_from - overlap);
            let end = if last { d + 60.0 } else { keep_to + overlap };
            ChunkPlan {
                index: i,
                start,
                length: js::round(end - start),
                keep_from,
                keep_to,
            }
        })
        .collect()
}

/// Nom des fichiers d'un tronçon, par position dans la vidéo : un
/// changement de découpage n'en réutilise jamais un qui ne correspond pas.
pub fn chunk_name(p: &ChunkPlan) -> String {
    format!(
        "chunk-{:0>5}-{}",
        crate::jsval::js_number_string(js::round(p.start)),
        crate::jsval::js_number_string(p.length)
    )
}

/// `chunkAt` : index du tronçon qui contient la seconde `t`.
pub fn chunk_at(plans: &[ChunkPlan], t: f64) -> usize {
    plans
        .iter()
        .position(|p| t < p.keep_to)
        .unwrap_or(plans.len().saturating_sub(1))
}

/// `nextChunk` : premier tronçon pas encore fait à partir de `target`, puis
/// ceux d'avant ; `None` : tout est fait.
pub fn next_chunk<'a>(
    plans: &'a [ChunkPlan],
    done: &HashSet<usize>,
    target: f64,
) -> Option<&'a ChunkPlan> {
    if plans.is_empty() {
        return None;
    }
    let at = chunk_at(plans, js::max(0.0, target));
    (at..plans.len())
        .chain(0..at)
        .find(|i| !done.contains(i))
        .map(|i| &plans[i])
}

/// `coveredFrom` : fin des sous-titres prêts d'un seul tenant à partir de `t`
/// (0 si le passage de `t` n'est pas traduit).
pub fn covered_from(plans: &[ChunkPlan], done: &HashSet<usize>, t: f64, duration: f64) -> f64 {
    if plans.is_empty() {
        return 0.0;
    }
    let mut i = chunk_at(plans, js::max(0.0, t));
    if !done.contains(&i) {
        return 0.0;
    }
    while i + 1 < plans.len() && done.contains(&(i + 1)) {
        i += 1;
    }
    if plans[i].keep_to.is_finite() {
        plans[i].keep_to
    } else {
        duration
    }
}

/// `chunkWords` : mots d'un tronçon, hallucinations retirées, remis à leur place dans la vidéo.
pub fn chunk_words(
    plan: &ChunkPlan,
    transcript: &Transcript,
    prompt: Option<&str>,
) -> Vec<AsrWord> {
    let (filtered, _) = filter_transcript(transcript, prompt);
    words_from_transcript(&shift_transcript(
        &filtered,
        plan.start,
        plan.keep_from,
        plan.keep_to,
    ))
}

/// `wordsFromChunks` : mots de plusieurs tronçons, dans l'ordre chronologique.
pub fn words_from_chunks(chunks: &[(ChunkPlan, Transcript)], prompt: Option<&str>) -> Vec<AsrWord> {
    let mut out: Vec<AsrWord> = chunks
        .iter()
        .flat_map(|(p, t)| chunk_words(p, t, prompt))
        .collect();
    out.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// `cuesFromChunks` : sous-titres (anglais) d'un match à partir de ses tronçons.
pub fn cues_from_chunks(chunks: &[(ChunkPlan, Transcript)], prompt: Option<&str>) -> Vec<Cue> {
    build_cues(&words_from_chunks(chunks, prompt), &CueOptions::default())
}

/// Sous-titre d'un tronçon, numéroté dans sa plage de seq ([`chunk_seq_base`]).
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkCue {
    pub seq: i64,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub emphasis: Option<u8>,
}

/// `chunkCues` : sous-titres d'UN tronçon, numérotés dans sa plage de seq.
pub fn chunk_cues(
    plan: &ChunkPlan,
    transcript: &Transcript,
    prompt: Option<&str>,
) -> Vec<ChunkCue> {
    let base = chunk_seq_base(plan.index);
    build_cues(
        &chunk_words(plan, transcript, prompt),
        &CueOptions::default(),
    )
    .into_iter()
    .enumerate()
    .map(|(k, c)| ChunkCue {
        seq: base + k as i64 + 1,
        start: c.start,
        end: c.end,
        text: c.text,
        emphasis: c.emphasis,
    })
    .collect()
}

// ---------------------------------------------------------------- sources (analysis.ts)

/// Flux tel que la file le voit : variantes HLS, MP4 progressifs, durée annoncée.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamInfo {
    pub variants: Vec<Variant>,
    pub mp4: Vec<Mp4Source>,
    pub duration: Option<f64>,
    /// Manifeste DASH (son seul), s'il existe.
    pub dash_url: Option<String>,
}

impl From<&crate::video::OkStream> for StreamInfo {
    fn from(s: &crate::video::OkStream) -> Self {
        StreamInfo {
            variants: s.variants.clone(),
            mp4: s.mp4.clone(),
            duration: s.duration,
            dash_url: s.dash_url.clone(),
        }
    }
}

/// Nature d'une source (`AnalysisSource.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Hls,
    Mp4,
}

/// Source média (`AnalysisSource`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisSource {
    pub kind: SourceKind,
    pub url: String,
    /// Clé de variante HLS ou nom de qualité ok.ru.
    pub label: String,
    pub height: Option<f64>,
}

#[derive(Clone)]
struct Candidate {
    src: AnalysisSource,
    bandwidth: f64,
}

/// Hauteurs des qualités MP4 d'ok.ru.
fn quality_height(name: &str) -> Option<f64> {
    Some(match name {
        "mobile" => 144.0,
        "lowest" => 240.0,
        "low" => 360.0,
        "sd" => 480.0,
        "hd" => 720.0,
        "full" => 1080.0,
        "quad" => 1440.0,
        "ultra" => 2160.0,
        _ => return None,
    })
}

fn candidates(stream: &StreamInfo) -> (Vec<Candidate>, Vec<Candidate>) {
    let hls = stream
        .variants
        .iter()
        .filter(|v| !v.url.is_empty())
        .map(|v| {
            let h = jsre!(r"x(\d{3,4})$")
                .captures(&v.resolution)
                .map(|m| crate::api::js_number(&m[1]))
                .or_else(|| quality_height(&v.key));
            Candidate {
                src: AnalysisSource {
                    kind: SourceKind::Hls,
                    url: v.url.clone(),
                    label: v.key.clone(),
                    height: h,
                },
                bandwidth: if v.bandwidth.is_nan() {
                    0.0
                } else {
                    v.bandwidth
                },
            }
        })
        .collect();
    let mp4 = stream
        .mp4
        .iter()
        .filter(|x| !x.url.is_empty())
        .map(|x| {
            let name = x.name.to_lowercase();
            Candidate {
                src: AnalysisSource {
                    kind: SourceKind::Mp4,
                    url: x.url.clone(),
                    height: quality_height(&name),
                    label: name,
                },
                bandwidth: 0.0,
            }
        })
        .collect();
    (hls, mp4)
}

/// `a - b` d'un comparateur JavaScript → ordre (NaN : égal).
fn cmp(x: f64) -> std::cmp::Ordering {
    if x < 0.0 {
        std::cmp::Ordering::Less
    } else if x > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// `bestForOcr`.
fn best_for_ocr(list: &[Candidate]) -> Option<Candidate> {
    let known: Vec<&Candidate> = list.iter().filter(|c| c.src.height.is_some()).collect();
    let h = |c: &Candidate| c.src.height.unwrap_or(0.0);
    let mut under: Vec<&Candidate> = known.iter().copied().filter(|c| h(c) <= 720.0).collect();
    under.sort_by(|a, b| cmp(h(b) - h(a)).then(cmp(b.bandwidth - a.bandwidth)));
    let mut over: Vec<&Candidate> = known.iter().copied().filter(|c| h(c) > 720.0).collect();
    over.sort_by(|a, b| cmp(h(a) - h(b)).then(cmp(a.bandwidth - b.bandwidth)));
    let mut unknown: Vec<&Candidate> = list.iter().filter(|c| c.src.height.is_none()).collect();
    unknown.sort_by(|a, b| cmp(b.bandwidth - a.bandwidth));
    if let Some(u) = under.first() {
        if h(u) >= 480.0 {
            return Some((*u).clone());
        }
    }
    over.first()
        .or(under.first())
        .or(unknown.first())
        .map(|c| (*c).clone())
}

/// `pickAnalysisSource` : HLS ≈ 720p de préférence, sinon le meilleur MP4 ≤ 720p, sinon le meilleur MP4.
pub fn pick_analysis_source(stream: &StreamInfo) -> Option<AnalysisSource> {
    let (hls, mp4) = candidates(stream);
    if !hls.is_empty() {
        return best_for_ocr(&hls).map(|c| c.src);
    }
    if mp4.is_empty() {
        return None;
    }
    let mut under: Vec<&Candidate> = mp4
        .iter()
        .filter(|c| c.src.height.is_some_and(|h| h <= 720.0))
        .collect();
    under.sort_by(|a, b| cmp(b.src.height.unwrap_or(0.0) - a.src.height.unwrap_or(0.0)));
    if let Some(u) = under.first() {
        return Some(u.src.clone());
    }
    let mut all: Vec<&Candidate> = mp4.iter().collect();
    all.sort_by(|a, b| cmp(b.src.height.unwrap_or(0.0) - a.src.height.unwrap_or(0.0)));
    all.first().map(|c| c.src.clone())
}

/// `analysisSources` : toutes les sources exploitables, de la meilleure à la moins bonne.
pub fn analysis_sources(stream: &StreamInfo) -> Vec<AnalysisSource> {
    let (hls, mp4) = candidates(stream);
    let mut out: Vec<AnalysisSource> = Vec::new();
    if let Some(first) = pick_analysis_source(stream) {
        out.push(first);
    }
    let dist = |c: &Candidate| (c.src.height.unwrap_or(720.0) - 720.0).abs();
    let mut a: Vec<&Candidate> = hls
        .iter()
        .filter(|c| c.src.height.unwrap_or(0.0) <= 1080.0)
        .collect();
    a.sort_by(|x, y| cmp(dist(x) - dist(y)));
    let mut b: Vec<&Candidate> = mp4
        .iter()
        .filter(|c| {
            let h = c.src.height.unwrap_or(0.0);
            (360.0..=1080.0).contains(&h)
        })
        .collect();
    b.sort_by(|x, y| cmp(dist(x) - dist(y)));
    for c in a.into_iter().chain(b) {
        if !out.iter().any(|o| o.url == c.src.url) {
            out.push(c.src.clone());
        }
    }
    out
}

/// `pickAudioSource` : la source la plus légère (l'image ne sert à rien).
pub fn pick_audio_source(stream: &StreamInfo) -> Option<AnalysisSource> {
    let (hls, mp4) = candidates(stream);
    if !hls.is_empty() {
        let mut s: Vec<&Candidate> = hls.iter().collect();
        s.sort_by(|a, b| {
            cmp(a.bandwidth - b.bandwidth).then(cmp(
                a.src.height.unwrap_or(1e9) - b.src.height.unwrap_or(1e9)
            ))
        });
        return s.first().map(|c| c.src.clone());
    }
    let mut s: Vec<&Candidate> = mp4.iter().collect();
    s.sort_by(|a, b| cmp(a.src.height.unwrap_or(1e9) - b.src.height.unwrap_or(1e9)));
    s.first().map(|c| c.src.clone())
}

/// `audioSources` : sources audio d'un flux, de la plus légère à la plus
/// lourde (objets complets, comme Node : la première vient de `pickAudioSource`).
pub fn audio_sources(stream: &StreamInfo) -> Vec<AnalysisSource> {
    let mut out: Vec<AnalysisSource> = Vec::new();
    if let Some(first) = pick_audio_source(stream) {
        out.push(first);
    }
    for s in analysis_sources(stream).into_iter().rev() {
        if !out.iter().any(|o| o.url == s.url) {
            out.push(s);
        }
    }
    out
}

// ---------------------------------------------------------------- backoff (analysis.ts)

/// Échecs automatiques au-delà desquels on n'essaie plus (tant que la vidéo ne change pas).
pub const MAX_AUTO_FAILURES: i64 = 4;

/// `backoffMs` : 1 h, 4 h, 16 h, puis 24 h.
pub fn backoff_ms(failures: i64) -> f64 {
    if failures <= 0 {
        return 0.0;
    }
    js::min(
        24.0 * 3_600_000.0,
        3_600_000.0 * 4f64.powf((failures - 1) as f64),
    )
}

/// `networkBackoffMs` : 15 min, 30 min, 1 h… jusqu'à 6 h.
pub fn network_backoff_ms(net_failures: i64) -> f64 {
    if net_failures <= 0 {
        return 0.0;
    }
    js::min(
        6.0 * 3_600_000.0,
        15.0 * 60_000.0 * 2f64.powf((net_failures - 1) as f64),
    )
}
