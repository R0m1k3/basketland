//! Synchronisation VF ↔ vidéo (équivalent de `src/lib/sync.ts`) : modèle de
//! temps compressible, ancres, alignement sur les coupures audio, calcul des
//! `video_ts` / `end_ts`. Mêmes opérations flottantes, dans le même ordre,
//! que Node : les horodatages produits sont identiques au bit près.

use crate::js;
use crate::time::parse_instant;
use serde_json::Value;
use std::cmp::Ordering;

pub const REG_PERIOD_SEC: f64 = 720.0;
pub const OT_PERIOD_SEC: f64 = 300.0;

pub fn period_length(period: f64) -> f64 {
    if period <= 4.0 {
        REG_PERIOD_SEC
    } else {
        OT_PERIOD_SEC
    }
}

/// Secondes de jeu écoulées depuis le coup d'envoi.
pub fn game_elapsed(period: f64, clock_sec: f64) -> f64 {
    let mut t = 0.0;
    let mut p = 1.0;
    while p < period {
        t += period_length(p);
        p += 1.0;
    }
    t + (period_length(period) - clock_sec)
}

/// `Date.parse(x) / 1000` (NaN si illisible).
pub fn wall_of(s: &str) -> f64 {
    parse_instant(s)
        .map(|d| d.timestamp_millis() as f64 / 1000.0)
        .unwrap_or(f64::NAN)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedPlay {
    pub seq: f64,
    pub period: f64,
    pub clock_sec: f64,
    pub wall: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Interval {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BreakInfo {
    pub interval: Interval,
    pub before: TimedPlay,
    pub after: TimedPlay,
}

/// Comparateur `(a, b) => x` de JavaScript : signe de `x`, NaN = égalité.
fn sign(x: f64) -> Ordering {
    if x < 0.0 {
        Ordering::Less
    } else if x > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `toTimedPlays` : actions datées, triées par séquence, wallclock rendu monotone.
pub fn to_timed_plays<'a>(
    plays: impl IntoIterator<Item = (f64, f64, f64, &'a str)>,
) -> Vec<TimedPlay> {
    let mut sorted: Vec<(f64, f64, f64, &str)> = plays.into_iter().collect();
    sorted.sort_by(|a, b| sign(a.0 - b.0));
    let mut out: Vec<TimedPlay> = Vec::new();
    for (seq, period, clock_sec, wallclock) in sorted {
        let w = wall_of(wallclock);
        if !w.is_finite() {
            continue;
        }
        out.push(TimedPlay {
            seq,
            period,
            clock_sec,
            wall: w,
        });
    }
    for i in 1..out.len() {
        if out[i].wall < out[i - 1].wall {
            out[i].wall = out[i - 1].wall;
        }
    }
    out
}

/// `findBreaks` (options par défaut : 60 s de temps mort, 8 s gardées de part et d'autre).
pub fn find_breaks(tp: &[TimedPlay]) -> Vec<BreakInfo> {
    let (min_dead, keep_after, keep_before) = (60.0, 8.0, 8.0);
    let mut out = Vec::new();
    for i in 1..tp.len() {
        let a = tp[i - 1];
        let b = tp[i];
        let wall_gap = b.wall - a.wall;
        let game_delta = js::max(
            0.0,
            game_elapsed(b.period, b.clock_sec) - game_elapsed(a.period, a.clock_sec),
        );
        let dead = wall_gap - game_delta;
        if dead < min_dead || dead.is_nan() {
            continue;
        }
        let start = a.wall + keep_after;
        let end = b.wall - game_delta - keep_before;
        if end - start > 5.0 {
            out.push(BreakInfo {
                interval: Interval { start, end },
                before: a,
                after: b,
            });
        }
    }
    out
}

/// Temps vivant / compressible entre deux instants wallclock.
pub struct Timeline {
    breaks: Vec<Interval>,
}

impl Timeline {
    pub fn new(breaks: &[BreakInfo]) -> Self {
        Timeline {
            breaks: breaks.iter().map(|b| b.interval).collect(),
        }
    }

    pub fn comp(&self, w1: f64, w2: f64) -> f64 {
        if w2 <= w1 {
            return 0.0;
        }
        let mut c = 0.0;
        for b in &self.breaks {
            let s = js::max(w1, b.start);
            let e = js::min(w2, b.end);
            if e > s {
                c += e - s;
            }
        }
        c
    }

    pub fn live(&self, w1: f64, w2: f64) -> f64 {
        if w2 <= w1 {
            return 0.0;
        }
        w2 - w1 - self.comp(w1, w2)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAnchor {
    pub wall: f64,
    pub video: f64,
    pub method: String,
    pub period: f64,
    pub clock_sec: f64,
}

/// Ancre lue en base (`AnchorRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnchorRow {
    pub period: f64,
    pub clock_sec: f64,
    pub video_ts: f64,
    pub method: String,
    pub wallclock: Option<String>,
}

/// `resolveAnchorWall` : instant wallclock d'une ancre (période, chrono).
pub fn resolve_anchor_wall(
    period: f64,
    clock_sec: f64,
    wallclock: Option<&str>,
    tp: &[TimedPlay],
) -> Option<f64> {
    if let Some(w) = wallclock.filter(|w| !w.is_empty()) {
        let w = wall_of(w);
        if w.is_finite() {
            return Some(w);
        }
    }
    if let Some(p) = tp
        .iter()
        .find(|p| p.period == period && p.clock_sec == clock_sec)
    {
        return Some(p.wall);
    }
    let in_period: Vec<&TimedPlay> = tp.iter().filter(|p| p.period == period).collect();
    if in_period.is_empty() {
        return None;
    }
    let mut before: Option<&TimedPlay> = None;
    let mut after: Option<&TimedPlay> = None;
    for p in in_period {
        if p.clock_sec > clock_sec {
            before = Some(p);
        } else if p.clock_sec < clock_sec && after.is_none() {
            after = Some(p);
        }
    }
    match (before, after) {
        (Some(b), Some(a)) => Some(js::max(b.wall, a.wall - (clock_sec - a.clock_sec))),
        (Some(b), None) => Some(b.wall + (b.clock_sec - clock_sec)),
        (None, Some(a)) => Some(a.wall - (clock_sec - a.clock_sec)),
        (None, None) => None,
    }
}

/// `METHOD_PRIORITY` (méthode inconnue : `undefined`, soit NaN).
fn method_priority(m: &str) -> f64 {
    match m {
        "manual" => 3.0,
        "auto" => 2.0,
        "audio" => 1.0,
        "est" => 0.0,
        _ => f64::NAN,
    }
}

/// `consistentAnchors` : ensemble strictement monotone, priorité manuel > auto > audio.
pub fn consistent_anchors(anchors: &[ResolvedAnchor]) -> Vec<ResolvedAnchor> {
    let mut by_priority: Vec<ResolvedAnchor> = anchors.to_vec();
    by_priority.sort_by(|a, b| {
        let d = method_priority(&b.method) - method_priority(&a.method);
        if d != 0.0 && !d.is_nan() {
            sign(d)
        } else {
            sign(a.wall - b.wall)
        }
    });
    let mut kept: Vec<ResolvedAnchor> = Vec::new();
    for a in by_priority {
        let ok = kept.iter().all(|k| {
            if a.wall == k.wall {
                false
            } else {
                (a.wall - k.wall) * (a.video - k.video) > 0.0
            }
        });
        if ok {
            kept.push(a);
        }
    }
    kept.sort_by(|a, b| sign(a.wall - b.wall));
    kept
}

/// `estimateStart` : offset de départ et ρ déduits de la durée vidéo.
pub fn estimate_start(tp: &[TimedPlay], tl: &Timeline, video_duration: Option<f64>) -> (f64, f64) {
    let rho0 = 0.3;
    let d = video_duration.unwrap_or(0.0);
    if tp.is_empty() || d == 0.0 || d.is_nan() {
        return (0.0, rho0);
    }
    let post = 120.0;
    let max_pre = 900.0;
    let w0 = tp[0].wall;
    let w_end = tp[tp.len() - 1].wall;
    let l = tl.live(w0, w_end);
    let k = tl.comp(w0, w_end);
    let mut rho = rho0;
    let mut v0 = d - post - (l + rho * k);
    if v0 < 0.0 || v0 > max_pre {
        let target = if v0 < 0.0 { 0.0 } else { max_pre };
        rho = if k > 0.0 {
            js::min(1.0, js::max(0.0, (d - post - target - l) / k))
        } else {
            rho0
        };
        v0 = js::min(max_pre, js::max(0.0, d - post - (l + rho * k)));
    }
    (v0, rho)
}

struct Seg {
    a: ResolvedAnchor,
    sigma: f64,
    rho: f64,
}

/// Correspondance wallclock → temps vidéo (`Mapping`).
pub struct Mapping {
    tl: Timeline,
    pub anchors: Vec<ResolvedAnchor>,
    pub default_rho: f64,
    segs: Vec<Seg>,
}

/// Erreur de JavaScript reproduite : instant illisible avec une seule ancre.
pub const MAP_TYPE_ERROR: &str = "Cannot read properties of undefined (reading 'a')";

impl Mapping {
    pub fn map(&self, w: f64) -> Result<f64, &'static str> {
        let Some(first) = self.anchors.first() else {
            return Ok(0.0);
        };
        let last = &self.anchors[self.anchors.len() - 1];
        let tl = &self.tl;
        if w <= first.wall {
            return Ok(first.video
                - tl.live(w, first.wall)
                - self.default_rho * tl.comp(w, first.wall));
        }
        if w >= last.wall {
            return Ok(last.video
                + tl.live(last.wall, w)
                + self.default_rho * tl.comp(last.wall, w));
        }
        if self.segs.is_empty() {
            return Err(MAP_TYPE_ERROR);
        }
        let mut lo: i64 = 0;
        let mut hi: i64 = self.segs.len() as i64 - 1;
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if self.segs[mid as usize].a.wall <= w {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let s = &self.segs[lo as usize];
        Ok(s.a.video + s.sigma * tl.live(s.a.wall, w) + s.rho * tl.comp(s.a.wall, w))
    }
}

/// `buildMapping` (ρ par défaut 0,3 ; sans ancre : estimation par la durée vidéo).
pub fn build_mapping(
    tp: &[TimedPlay],
    breaks: &[BreakInfo],
    anchors_in: &[ResolvedAnchor],
    video_duration: Option<f64>,
) -> Mapping {
    let tl = Timeline::new(breaks);
    let mut anchors = consistent_anchors(anchors_in);
    let mut default_rho = 0.3;
    if anchors.is_empty() {
        let (v0, rho) = estimate_start(tp, &tl, video_duration);
        default_rho = rho;
        if let Some(first) = tp.first() {
            anchors = vec![ResolvedAnchor {
                wall: first.wall,
                video: v0,
                method: "est".into(),
                period: first.period,
                clock_sec: first.clock_sec,
            }];
        }
    }
    let mut segs: Vec<Seg> = Vec::new();
    let mut k_sum = 0.0;
    let mut rho_k = 0.0;
    for i in 0..anchors.len().saturating_sub(1) {
        let a = &anchors[i];
        let b = &anchors[i + 1];
        let dv = b.video - a.video;
        let l = tl.live(a.wall, b.wall);
        let k = tl.comp(a.wall, b.wall);
        let mut sigma = 1.0;
        let rho;
        if k <= 0.0 || dv < l {
            rho = 0.0;
            sigma = if l > 0.0 { dv / l } else { 1.0 };
        } else if dv > l + k {
            rho = 1.0;
            sigma = if l > 0.0 { (dv - k) / l } else { 1.0 };
        } else {
            rho = (dv - l) / k;
        }
        segs.push(Seg {
            a: a.clone(),
            sigma,
            rho,
        });
        if k > 0.0 {
            k_sum += k;
            rho_k += rho * k;
        }
    }
    if k_sum > 0.0 && anchors.len() >= 2 {
        default_rho = js::min(1.0, js::max(0.0, rho_k / k_sum));
    }
    Mapping {
        tl,
        anchors,
        default_rho,
        segs,
    }
}

// ------------------------------------------------------------------ alignement audio

/// Coupure audio détectée (`CutInterval`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cut {
    pub start: f64,
    pub end: f64,
}

impl Cut {
    /// Coupure relue du JSON en base (`{ start, end, meanDb }`).
    pub fn from_json(v: &Value) -> Cut {
        Cut {
            start: js::to_number(v.get("start")),
            end: js::to_number(v.get("end")),
        }
    }
}

/// `alignWithCuts` (tolérance 12 s, préroll ≤ 900 s, pas de 1 s, ρ a priori 0,3) :
/// ancres « audio » si assez d'arrêts de jeu ont trouvé leur coupure.
pub fn align_with_cuts(
    tp: &[TimedPlay],
    breaks: &[BreakInfo],
    cuts: &[Cut],
    video_duration: f64,
) -> Option<Vec<ResolvedAnchor>> {
    if tp.is_empty() || cuts.is_empty() {
        return None;
    }
    let tol = 12.0;
    let max_pre = js::min(900.0, js::max(0.0, video_duration - 60.0));
    let step = 1.0;
    let rho_prior = 0.3;
    let tl = Timeline::new(breaks);
    let w0 = tp[0].wall;
    let mut sorted_cuts: Vec<Cut> = cuts.to_vec();
    sorted_cuts.sort_by(|a, b| sign(a.start - b.start));

    struct Best {
        v0: f64,
        score: f64,
        matched: Vec<(usize, Cut)>,
    }
    let mut best: Option<Best> = None;
    let mut v0 = 0.0;
    while v0 <= max_pre {
        let mut last_wall = w0;
        let mut last_video = v0;
        let mut score = 0.0;
        let mut matched: Vec<(usize, Cut)> = Vec::new();
        let mut cut_idx = 0usize;
        for (bi, b) in breaks.iter().enumerate() {
            let live = tl.live(last_wall, b.interval.start);
            let comp = tl.comp(last_wall, b.interval.start);
            let s_min = last_video + live;
            let s_max = s_min + comp;
            let expected = s_min + rho_prior * comp;
            let lo = s_min - tol;
            let hi = s_max + tol;
            while cut_idx < sorted_cuts.len() && sorted_cuts[cut_idx].start < lo {
                cut_idx += 1;
            }
            let mut pick: Option<usize> = None;
            let mut pick_d = f64::INFINITY;
            let mut j = cut_idx;
            while j < sorted_cuts.len() && sorted_cuts[j].start <= hi {
                let c = sorted_cuts[j];
                let break_len = b.interval.end - b.interval.start;
                if c.end - c.start > break_len + tol {
                    j += 1;
                    continue;
                }
                let d = (c.start - expected).abs();
                if d < pick_d {
                    pick_d = d;
                    pick = Some(j);
                }
                j += 1;
            }
            if let Some(pk) = pick {
                let c = sorted_cuts[pk];
                let spread = tol + (s_max - s_min);
                score += 1.0 - js::min(1.0, (c.start - expected).abs() / (spread * 2.0));
                matched.push((bi, c));
                last_wall = b.interval.end;
                last_video = c.end;
                cut_idx = pk + 1;
            }
        }
        if best.as_ref().is_none_or(|b| score > b.score + 1e-9) {
            best = Some(Best { v0, score, matched });
        }
        v0 += step;
    }
    let best = best?;
    let min_matches = js::max(3.0, (breaks.len() as f64 * 0.25).ceil());
    if (best.matched.len() as f64) < min_matches {
        return None;
    }
    let first = tp[0];
    let mut anchors = vec![ResolvedAnchor {
        wall: first.wall,
        video: best.v0,
        method: "audio".into(),
        period: first.period,
        clock_sec: first.clock_sec,
    }];
    for (bi, cut) in &best.matched {
        let b = &breaks[*bi];
        anchors.push(ResolvedAnchor {
            wall: b.after.wall,
            video: cut.end + (b.after.wall - b.interval.end),
            method: "audio".into(),
            period: b.after.period,
            clock_sec: b.after.clock_sec,
        });
    }
    Some(anchors)
}

// ------------------------------------------------------------------ sous-titres

/// Réglages manuels (`SyncSettings`) : offset global + offsets par quart.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncSettings {
    pub global_offset: f64,
    /// Objet JSON relu (`quarter_offsets_json`).
    pub quarter_offsets: Value,
}

/// `applyOffsets`.
pub fn apply_offsets(ts: f64, period: f64, s: &SyncSettings) -> f64 {
    let g = if s.global_offset == 0.0 || s.global_offset.is_nan() {
        0.0
    } else {
        s.global_offset
    };
    let key = crate::jsval::js_number_string(period);
    let q = js::to_number(js::prop(Some(&s.quarter_offsets), &key));
    let q = if q == 0.0 || q.is_nan() { 0.0 } else { q };
    ts + g + q
}

/// Ligne horodatée.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedLine<T> {
    pub line: T,
    pub video_ts: f64,
    pub end_ts: f64,
}

/// `timeLines` : `video_ts` / `end_ts` de chaque ligne, triées par `video_ts`.
/// `line` donne (seq, période, wallclock, durée d'affichage).
pub fn time_lines<T>(
    lines: Vec<T>,
    fields: impl Fn(&T) -> (f64, f64, &str, f64),
    mapping: &Mapping,
    settings: &SyncSettings,
    video_duration: Option<f64>,
) -> Result<Vec<TimedLine<T>>, &'static str> {
    let vd = video_duration.filter(|d| *d != 0.0 && !d.is_nan());
    let mut timed: Vec<TimedLine<T>> = Vec::with_capacity(lines.len());
    for l in lines {
        let (_, period, wallclock, _) = fields(&l);
        let w = wall_of(wallclock);
        let mut ts = apply_offsets(mapping.map(w)?, period, settings);
        if !ts.is_finite() {
            ts = 0.0;
        }
        ts = js::max(
            0.0,
            match vd {
                Some(d) => js::min(ts, d),
                None => ts,
            },
        );
        timed.push(TimedLine {
            line: l,
            video_ts: js::round(ts * 100.0) / 100.0,
            end_ts: 0.0,
        });
    }
    timed.sort_by(|a, b| {
        let d = a.video_ts - b.video_ts;
        if d != 0.0 && !d.is_nan() {
            sign(d)
        } else {
            sign(fields(&a.line).0 - fields(&b.line).0)
        }
    });
    for i in 0..timed.len() {
        let next = timed
            .get(i + 1)
            .map(|t| t.video_ts)
            .unwrap_or(f64::INFINITY);
        let v = timed[i].video_ts;
        let hold = fields(&timed[i].line).3;
        let end = js::min(v + hold, js::max(v + 0.8, next - 0.05));
        timed[i].end_ts = js::round(end * 100.0) / 100.0;
    }
    Ok(timed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temps_de_jeu() {
        assert_eq!(game_elapsed(1.0, 720.0), 0.0);
        assert_eq!(game_elapsed(2.0, 700.0), 740.0);
        assert_eq!(game_elapsed(5.0, 300.0), 2880.0);
    }
}
