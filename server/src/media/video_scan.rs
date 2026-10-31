//! Balayage de la vidéo pour la synchro (équivalent de `videoScan.ts`) :
//! localisation du bandeau, passe grossière puis affinage ciblé.
//!
//! 1. Localisation : 10 images réparties sur la vidéo → région du bandeau.
//!    Les lectures de ces images servent aussi d'observations.
//! 2. Passe grossière : une image toutes les ~105 s.
//! 3. Affinage (2 tours au plus) : là où les ancres manquent ou se
//!    contredisent, on resserre le pas (~30 s).
//!
//! L'OCR (`ocr.ts`, `scoreboard.ts`) sera porté à l'étape 7 : extraction
//! d'image, lecture et localisation du bandeau, et choix des observations
//! cohérentes sont fournis par l'appelant ([`ScanDeps`]). La planification
//! ([`spread`], [`coarse_times`], [`plan_refinement`]) est portée à l'identique.

use crate::js;
use crate::vf_sync::{build_mapping, BreakInfo, ResolvedAnchor, TimedPlay};
use std::collections::BTreeMap;
use std::future::Future;
use std::time::Instant;

/// `spread` : instants répartis uniformément dans `[from, to]`, bornes comprises si n ≥ 2.
pub fn spread(from: f64, to: f64, n: i64) -> Vec<f64> {
    if n <= 0 || to < from {
        return Vec::new();
    }
    if n == 1 {
        return vec![js::round((from + to) / 2.0)];
    }
    (0..n)
        .map(|i| js::round(from + ((to - from) * i as f64) / (n - 1) as f64))
        .collect()
}

/// `safeStep` : pas de balayage borné ET fini (`raw` absent ou non numérique : `def`).
pub fn safe_step(raw: Option<f64>, def: f64, min: f64) -> f64 {
    match raw {
        Some(n) if n.is_finite() && n > 0.0 => js::max(min, n.trunc()),
        _ => def,
    }
}

/// `coarseTimes` : un instant tous les `step` s (à partir de `start`, 30 par
/// défaut), en évitant ceux déjà lus.
pub fn coarse_times(duration: f64, step: f64, already: &[f64], start: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut t = start;
    while t < duration - 5.0 {
        let r = js::round(t);
        if !already.iter().any(|a| (a - r).abs() < step / 4.0) {
            out.push(r);
        }
        t += step;
    }
    out
}

/// Lecture du bandeau sur une image (`FrameObservation`).
#[derive(Debug, Clone, PartialEq)]
pub struct FrameObservation {
    pub video_ts: f64,
    pub period: Option<f64>,
    pub clock_sec: f64,
    /// Nombres lus près du chrono (scores…), si disponibles.
    pub scores: Option<Vec<f64>>,
}

/// Lecture du bandeau (`ScoreboardReading`).
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreboardReading {
    pub period: Option<f64>,
    pub clock_sec: f64,
    pub scores: Vec<f64>,
}

/// Résultat de la localisation (`LocateResult`) ; `L` : région du bandeau.
#[derive(Debug, Clone, PartialEq)]
pub struct LocateResult<L> {
    pub location: Option<L>,
    /// Lecture retenue par image échantillon, réutilisable comme observation.
    pub readings: Vec<Option<ScoreboardReading>>,
}

/// Entrée de [`plan_refinement`].
pub struct RefinementInput<'a> {
    pub anchors: &'a [ResolvedAnchor],
    pub observations: &'a [FrameObservation],
    /// Instants vidéo déjà lus (réussis ou non).
    pub scanned: &'a [f64],
    pub duration: f64,
    pub tp: &'a [TimedPlay],
    pub breaks: &'a [BreakInfo],
}

/// Réglages de [`plan_refinement`] (`None` : défaut de Node).
#[derive(Debug, Clone, Copy, Default)]
pub struct RefinementOptions {
    pub fine_step: Option<f64>,
    pub per_window: Option<usize>,
    pub max_frames: Option<usize>,
    pub max_gap: Option<f64>,
}

/// `planRefinement` : instants à relire pour compléter les ancres —
/// quarts-temps sans ancre, grands trous entre deux ancres, lectures fiables
/// rejetées par la chaîne. Erreur : celle du mapping (instant illisible).
pub fn plan_refinement(p: &RefinementInput, o: &RefinementOptions) -> Result<Vec<f64>, String> {
    let fine = o.fine_step.unwrap_or(30.0);
    let per_window = o.per_window.unwrap_or(10);
    let max_frames = o.max_frames.unwrap_or(40);
    let max_gap = o.max_gap.unwrap_or(1500.0);
    let d = p.duration;
    if p.tp.is_empty() || d <= 0.0 {
        return Ok(Vec::new());
    }
    let mut out: Vec<f64> = Vec::new();
    let add = |out: &mut Vec<f64>, times: &[f64], cap: usize| {
        let mut n = 0;
        for &t in times {
            if n >= cap || out.len() >= max_frames {
                break;
            }
            let free = t >= 0.0
                && t < d - 5.0
                && !p.scanned.iter().any(|s| (s - t).abs() < fine / 2.0)
                && !out.iter().any(|s| (s - t).abs() < fine / 2.0);
            if free {
                out.push(t);
                n += 1;
            }
        }
    };

    let mapping = build_mapping(p.tp, p.breaks, p.anchors, Some(d));
    let margin = if p.anchors.is_empty() { 300.0 } else { 90.0 };
    let mut periods: Vec<f64> = Vec::new();
    for x in p.tp {
        if !periods.contains(&x.period) {
            periods.push(x.period);
        }
    }
    periods.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    for period in periods {
        if p.anchors.iter().any(|a| a.period == period) {
            continue;
        }
        let plays: Vec<&TimedPlay> = p.tp.iter().filter(|x| x.period == period).collect();
        let vs = js::max(0.0, mapping.map(plays[0].wall)? - margin);
        let ve = js::min(d - 5.0, mapping.map(plays[plays.len() - 1].wall)? + margin);
        if ve <= vs {
            continue;
        }
        let n = js::max(
            1.0,
            js::min(per_window as f64, ((ve - vs) / fine).floor() + 1.0),
        ) as i64;
        let mid = (vs + ve) / 2.0;
        let mut times = spread(vs, ve, n);
        times.sort_by(|a, b| {
            ((a - mid).abs() - (b - mid).abs())
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        add(&mut out, &times, per_window);
    }

    let mut anchors = p.anchors.to_vec();
    anchors.sort_by(|a, b| {
        a.video
            .partial_cmp(&b.video)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for w in anchors.windows(2) {
        let gap = w[1].video - w[0].video;
        if gap <= max_gap {
            continue;
        }
        let n = js::min(6.0, (gap / js::max(fine, gap / 8.0)).floor()) as i64;
        add(
            &mut out,
            &spread(w[0].video + fine, w[1].video - fine, n),
            6,
        );
    }

    let rejected: Vec<f64> = p
        .observations
        .iter()
        .filter(|x| x.period.is_some() && !p.anchors.iter().any(|a| a.video == x.video_ts))
        .flat_map(|x| [x.video_ts - fine, x.video_ts + fine])
        .collect();
    add(&mut out, &rejected, 8);

    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// `anchorsPerPeriod` : nombre d'ancres par période (périodes croissantes).
pub fn anchors_per_period(anchors: &[ResolvedAnchor]) -> BTreeMap<i64, usize> {
    let mut out = BTreeMap::new();
    for a in anchors {
        *out.entry(a.period as i64).or_insert(0) += 1;
    }
    out
}

// ---------------------------------------------------------------- balayage

/// Phase du balayage (progression).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanPhase {
    Localisation,
    Balayage,
    Affinage,
}

impl ScanPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanPhase::Localisation => "localisation",
            ScanPhase::Balayage => "balayage",
            ScanPhase::Affinage => "affinage",
        }
    }
}

/// Ce que le balayage demande à l'appelant : extraction d'une image (ffmpeg
/// sur la source choisie), lecture et localisation du bandeau (OCR), et
/// choix des observations cohérentes (`selectConsistentObservations`).
pub trait ScanDeps {
    /// Région du bandeau (`ScoreboardLocation`).
    type Location: Clone;
    /// Image à l'instant `t` (s).
    fn grab(&self, t: f64) -> impl Future<Output = Result<Vec<u8>, String>>;
    /// Lecture du bandeau sur une image ; `Ok(None)` : rien de lisible.
    fn read(
        &self,
        image: &[u8],
        location: Option<&Self::Location>,
    ) -> impl Future<Output = Result<Option<ScoreboardReading>, String>>;
    /// Localisation sur des images échantillons ; `progress(fait, total)`.
    fn locate(
        &self,
        frames: &[Vec<u8>],
        progress: &dyn Fn(usize, usize),
    ) -> impl Future<Output = Result<LocateResult<Self::Location>, String>>;
    /// Ancres de la chaîne cohérente des observations.
    fn consistent(&self, observations: &[FrameObservation]) -> Vec<ResolvedAnchor>;
}

/// Options de [`scan_video`].
pub struct ScanOptions<'a, L> {
    pub duration: f64,
    pub tp: &'a [TimedPlay],
    pub breaks: &'a [BreakInfo],
    /// Localisation déjà connue (cache par vidéo) : la localisation est sautée.
    pub location: Option<L>,
    /// Pas de la passe grossière (s), 105 par défaut (20 au moins).
    pub step_sec: Option<f64>,
    /// Images échantillons pour la localisation (10).
    pub sample_frames: Option<f64>,
    /// Tours d'affinage au plus (2).
    pub refine_rounds: Option<f64>,
    pub on_progress: Option<&'a (dyn Fn(ScanPhase, usize, usize) + 'a)>,
}

/// Résultat de [`scan_video`].
#[derive(Debug, Clone)]
pub struct ScanResult<L> {
    pub observations: Vec<FrameObservation>,
    pub anchors: Vec<ResolvedAnchor>,
    pub location: Option<L>,
    /// La localisation vient-elle du cache ?
    pub cached_location: bool,
    pub frames_read: usize,
    pub elapsed_ms: u128,
    pub per_period: BTreeMap<i64, usize>,
}

struct ScanState<L> {
    observations: Vec<FrameObservation>,
    scanned: Vec<f64>,
    location: Option<L>,
    frames_read: usize,
}

fn observation(t: f64, r: &ScoreboardReading) -> FrameObservation {
    FrameObservation {
        video_ts: t,
        period: r.period,
        clock_sec: r.clock_sec,
        scores: Some(r.scores.clone()),
    }
}

async fn read_at<D: ScanDeps>(
    deps: &D,
    st: &mut ScanState<D::Location>,
    times: &[f64],
    phase: ScanPhase,
    progress: Option<&(dyn Fn(ScanPhase, usize, usize) + '_)>,
) {
    for (k, &t) in times.iter().enumerate() {
        st.scanned.push(t);
        if let Ok(img) = deps.grab(t).await {
            st.frames_read += 1;
            // Image illisible : on continue.
            if let Ok(Some(r)) = deps.read(&img, st.location.as_ref()).await {
                st.observations.push(observation(t, &r));
            }
        }
        if let Some(f) = progress {
            f(phase, k + 1, times.len());
        }
    }
}

async fn localize<D: ScanDeps>(
    deps: &D,
    st: &mut ScanState<D::Location>,
    d: f64,
    sample_frames: Option<f64>,
    progress: Option<&(dyn Fn(ScanPhase, usize, usize) + '_)>,
) -> Result<(), String> {
    let n = js::max(1.0, sample_frames.unwrap_or(10.0).trunc()) as i64;
    let sample_times = spread(d * 0.06, d * 0.94, n);
    let total = sample_times.len() * 2;
    let mut frames = Vec::new();
    let mut frame_times = Vec::new();
    for (k, &t) in sample_times.iter().enumerate() {
        st.scanned.push(t);
        if let Ok(img) = deps.grab(t).await {
            frames.push(img);
            frame_times.push(t);
            st.frames_read += 1;
        }
        if let Some(f) = progress {
            f(ScanPhase::Localisation, k + 1, total);
        }
    }
    let ns = sample_times.len();
    let on_locate = |done: usize, tot: usize| {
        if let Some(f) = progress {
            let k = ns as f64 + js::round((done as f64 / tot.max(1) as f64) * ns as f64);
            f(ScanPhase::Localisation, k as usize, total);
        }
    };
    let loc = deps.locate(&frames, &on_locate).await?;
    st.location = loc.location;
    for (i, r) in loc.readings.iter().enumerate() {
        if let (Some(r), Some(t)) = (r, frame_times.get(i)) {
            st.observations.push(observation(*t, r));
        }
    }
    Ok(())
}

/// `scanVideo` : localisation (sauf si connue), passe grossière, relocalisation
/// si la localisation en cache ne lit (presque) rien, puis affinage ciblé.
pub async fn scan_video<D: ScanDeps>(
    deps: &D,
    o: ScanOptions<'_, D::Location>,
) -> Result<ScanResult<D::Location>, String> {
    let t0 = Instant::now();
    let d = o.duration;
    let step = safe_step(o.step_sec, 105.0, 20.0);
    let cached_location = o.location.is_some();
    let progress = o.on_progress;
    let mut st = ScanState {
        observations: Vec::new(),
        scanned: Vec::new(),
        location: o.location,
        frames_read: 0,
    };

    if st.location.is_none() && d > 60.0 {
        localize(deps, &mut st, d, o.sample_frames, progress).await?;
    }
    let coarse = coarse_times(d, step, &st.scanned, 30.0);
    read_at(deps, &mut st, &coarse, ScanPhase::Balayage, progress).await;
    // Localisation en cache qui ne lit (presque) rien : l'habillage a changé.
    if cached_location && st.observations.len() < 3 && d > 60.0 {
        st.location = None;
        st.observations.clear();
        localize(deps, &mut st, d, o.sample_frames, progress).await?;
        if st.location.is_some() {
            read_at(deps, &mut st, &coarse, ScanPhase::Balayage, progress).await;
        }
    }
    let rounds = js::max(0.0, o.refine_rounds.unwrap_or(2.0).trunc()) as usize;
    for _ in 0..rounds {
        let anchors = deps.consistent(&st.observations);
        let plan = plan_refinement(
            &RefinementInput {
                anchors: &anchors,
                observations: &st.observations,
                scanned: &st.scanned,
                duration: d,
                tp: o.tp,
                breaks: o.breaks,
            },
            &RefinementOptions::default(),
        )?;
        if plan.is_empty() {
            break;
        }
        read_at(deps, &mut st, &plan, ScanPhase::Affinage, progress).await;
    }
    let anchors = deps.consistent(&st.observations);
    Ok(ScanResult {
        per_period: anchors_per_period(&anchors),
        observations: st.observations,
        anchors,
        location: st.location,
        cached_location,
        frames_read: st.frames_read,
        elapsed_ms: t0.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outils_de_planification() {
        assert_eq!(safe_step(None, 105.0, 10.0), 105.0);
        assert_eq!(safe_step(Some(f64::NAN), 105.0, 10.0), 105.0);
        assert_eq!(safe_step(Some(0.0), 105.0, 10.0), 105.0);
        assert_eq!(safe_step(Some(3.0), 105.0, 20.0), 20.0);
        assert_eq!(safe_step(Some(90.7), 105.0, 10.0), 90.0);
        assert_eq!(spread(0.0, 100.0, 3), vec![0.0, 50.0, 100.0]);
        assert_eq!(
            coarse_times(500.0, 100.0, &[], 30.0),
            vec![30.0, 130.0, 230.0, 330.0, 430.0]
        );
        assert_eq!(
            coarse_times(500.0, 100.0, &[128.0], 30.0),
            vec![30.0, 230.0, 330.0, 430.0]
        );
    }
}
