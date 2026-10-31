//! Localisation ADAPTATIVE du bandeau de score et lecture d'une image
//! (équivalent de `scoreboard.ts`), portée à l'étape 7, **pas encore branchée**.
//!
//! Les replays viennent de diffuseurs différents : le bandeau change de place
//! et de taille. Localisation, sur 8 à 12 images échantillons :
//!  1. ZONES FIXES : les incrustations ne bougent pas d'une image à l'autre
//!     ([`static_overlay_regions`], sur des vignettes) ; dans chaque zone, les
//!     CASES CLAIRES fixes sont lues seules ([`static_bright_cells`]) ;
//!  2. OCR de la zone (texte sombre et texte clair fusionnés), relecture
//!     serrée des mots douteux, puis repérage des jetons « chrono » et de la
//!     période voisine avec les boîtes de mots ;
//!  3. vote : la région qui revient sur le plus d'images est le bandeau ;
//!  4. repli : bandes bas/haut en tuiles qui se recouvrent.
//!
//! Lecture d'une image ([`read_scoreboard`]) : empreinte du bandeau (est-il
//! à l'écran ?), puis « gabarit » — chrono, période et scores relus chacun à
//! sa place apprise, en mode une ligne, avec vote entre binarisations.
//!
//! Toutes les coordonnées publiques sont en FRACTIONS de l'image (0..1). Mêmes
//! opérations flottantes, dans le même ordre, que Node (`Math.hypot` compris).

use crate::api::js_num_value;
use crate::js::{self, jsre};
use crate::media::ocr::{
    exec, filter_image, fre, match_all, normalize_ocr_text, num, parse_clock_candidates,
    parse_period_text, parse_scoreboard_text, png_size, raw_gray, recognize_words, replace_all,
    sign, test, u16_index, OcrEngine, OcrParams, OcrWord, OCR_WHITELIST,
};
use crate::media::video_scan::ScoreboardReading;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};

/// Rectangle en fractions de l'image (`Rect`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("x".into(), js_num_value(self.x));
        m.insert("y".into(), js_num_value(self.y));
        m.insert("w".into(), js_num_value(self.w));
        m.insert("h".into(), js_num_value(self.h));
        Value::Object(m)
    }

    pub fn from_json(v: &Value) -> Option<Rect> {
        let f = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(Rect {
            x: f("x")?,
            y: f("y")?,
            w: f("w")?,
            h: f("h")?,
        })
    }
}

/// Boîte en pixels (`Box`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Bx {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn bx(w: &OcrWord) -> Bx {
    Bx {
        x0: w.x0,
        y0: w.y0,
        x1: w.x1,
        y1: w.y1,
    }
}

/// `Math.hypot(a, b)` de V8 (normalisation par le maximum, sommation de Kahan).
pub fn js_hypot(a: f64, b: f64) -> f64 {
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let (aa, ab) = (a.abs(), b.abs());
    let max = if ab > aa { ab } else { aa };
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [aa, ab] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

// ---------------------------------------------------------------- jetons

/// `periodValue` : valeur d'un jeton de période isolé (« 2ND », « Q3 », « OT2 »…).
fn period_value(tok: &str) -> Option<f64> {
    if let Some(rest) = tok.strip_prefix("OT") {
        let n = num(rest);
        return Some(4.0 + if n == 0.0 || n.is_nan() { 1.0 } else { n });
    }
    let mut ch = tok.chars();
    if tok.starts_with('Q') {
        ch.next();
        return Some(ch.next().map_or(f64::NAN, |c| num(&c.to_string())));
    }
    let n = ch.next().map_or(f64::NAN, |c| num(&c.to_string()));
    (1.0..=4.0).contains(&n).then_some(n)
}

/// Jetons d'un mot OCR (`WordTokens`).
#[derive(Debug, Clone, PartialEq)]
pub struct WordTokens {
    pub period: Option<f64>,
    pub clock: Option<f64>,
    /// Nombres de 1 à 3 chiffres (≤ 199) hors chrono et période : scores, shot clock.
    pub numbers: Vec<f64>,
}

const PERIOD_TOKENS: &str =
    r"Q[1-4](?=\d{1,2}[:.]\d)|\bQ[1-4]\b|1ST|2ND|3RD|4TH|1S7|2NO|2N0|3RO|3R0|4T4|\bOT\d?\b";

/// `analyzeWord` : décompose un mot OCR où tesseract a collé les éléments
/// voisins (« H54ND61Q27:43 » = 54, 61, Q2, 7:43).
pub fn analyze_word(text: &str) -> WordTokens {
    let norm = normalize_ocr_text(text);
    let t = js::trim(&norm).to_string();
    let mut period = parse_period_text(&t);
    if period.is_none() {
        if let Some(g) = exec(fre!(r"Q([1-4])(?=\d{1,2}[:.]\d)"), &t) {
            period = g[1].as_ref().map(|(_, s)| num(s));
        }
    }
    // Mot collé contenant le chrono : la période est le jeton le plus PROCHE du chrono.
    if let Some(g) = exec(fre!(r"\d{1,2}[:.]\d"), &t) {
        let (cb, cs) = g[0].clone().expect("correspondance");
        let ci = u16_index(&t, cb) as f64;
        let cl = cs.encode_utf16().count() as f64;
        let mut best_d = f64::INFINITY;
        for (start_b, m, _) in match_all(fre!(PERIOD_TOKENS), &t) {
            let start = u16_index(&t, start_b) as f64;
            let end = start + m.encode_utf16().count() as f64;
            let d = if end <= ci {
                ci - end
            } else {
                js::max(0.0, start - (ci + cl))
            };
            if let Some(p) = period_value(&m) {
                if d < best_d {
                    best_d = d;
                    period = Some(p);
                }
            }
        }
    }
    let rest = replace_all(fre!(PERIOD_TOKENS), &t, " ");
    let mut clock = parse_clock_candidates(&rest).first().copied();
    let mut clock_re = jsre!(r"\d{1,2}:\d{2}|\d{1,2}\.\d");
    if clock.is_none() {
        // Minute à un chiffre précédée d'un chiffre parasite (« 27:43 » → 7:43).
        if let Some(g) = exec(fre!(r"(\d):([0-5]\d)(?!\d)"), &rest) {
            let mm = num(&g[1].as_ref().expect("minute").1);
            let ss = num(&g[2].as_ref().expect("secondes").1);
            clock = Some(mm * 60.0 + ss);
            clock_re = jsre!(r"\d:\d{2}");
        }
    }
    let scan = if clock.is_none() {
        rest.clone()
    } else {
        clock_re.replace_all(&rest, " ").into_owned()
    };
    let mut numbers = Vec::new();
    for (_, run, _) in match_all(fre!(r"(?<!\d)\d{1,6}(?!\d)"), &scan) {
        if run.len() <= 3 {
            if num(&run) <= 199.0 {
                numbers.push(num(&run));
            }
            continue;
        }
        // Deux scores collés (« 5461 » = 54 et 61) : toutes les coupures plausibles.
        for i in 1..run.len() {
            let (a, b) = run.split_at(i);
            if a.len() > 3
                || b.len() > 3
                || (b.len() > 1 && b.starts_with('0'))
                || (a.len() > 1 && a.starts_with('0'))
            {
                continue;
            }
            if num(a) <= 199.0 && num(b) <= 199.0 {
                numbers.push(num(a));
                numbers.push(num(b));
            }
        }
    }
    WordTokens {
        period,
        clock,
        numbers,
    }
}

/// `clockFromWord` : chrono (s) porté par un mot OCR.
pub fn clock_from_word(text: &str) -> Option<f64> {
    analyze_word(text).clock
}

/// `periodFromWord` : période portée par un mot OCR.
pub fn period_from_word(text: &str) -> Option<f64> {
    analyze_word(text).period
}

fn height(b: &Bx) -> f64 {
    js::max(1.0, b.y1 - b.y0)
}
fn cy(b: &Bx) -> f64 {
    (b.y0 + b.y1) / 2.0
}
fn h_gap(a: &Bx, b: &Bx) -> f64 {
    js::max(0.0, js::max(a.x0, b.x0) - js::min(a.x1, b.x1))
}
fn union(a: &Bx, b: &Bx) -> Bx {
    Bx {
        x0: js::min(a.x0, b.x0),
        y0: js::min(a.y0, b.y0),
        x1: js::max(a.x1, b.x1),
        y1: js::max(a.y1, b.y1),
    }
}

/// `mergeSplitClocks` : recolle les chronos coupés en deux mots (« 7: » + « 43 »).
pub fn merge_split_clocks(words: &[OcrWord]) -> Vec<OcrWord> {
    let mut sorted = words.to_vec();
    sorted.sort_by(|a, b| sign(a.x0 - b.x0));
    let mut used = vec![false; sorted.len()];
    let mut out = Vec::new();
    for i in 0..sorted.len() {
        if used[i] {
            continue;
        }
        let a = &sorted[i];
        let mut merged: Option<OcrWord> = None;
        if clock_from_word(&a.text).is_none() {
            for j in i + 1..sorted.len() {
                if used[j] {
                    continue;
                }
                let b = &sorted[j];
                let (ba, bb) = (bx(a), bx(b));
                let h = js::max(height(&ba), height(&bb));
                if (cy(&ba) - cy(&bb)).abs() > 0.5 * h || h_gap(&ba, &bb) > 0.6 * h {
                    continue;
                }
                let text = format!("{}{}", a.text, b.text);
                if clock_from_word(&b.text).is_none() && clock_from_word(&text).is_some() {
                    let u = union(&ba, &bb);
                    merged = Some(OcrWord {
                        text,
                        x0: u.x0,
                        y0: u.y0,
                        x1: u.x1,
                        y1: u.y1,
                        confidence: js::min(a.confidence, b.confidence),
                    });
                    used[j] = true;
                    break;
                }
            }
        }
        out.push(merged.unwrap_or_else(|| a.clone()));
    }
    out
}

// ---------------------------------------------------------------- candidats chrono + période

/// Chrono repéré sur une image (`ClockCandidate`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClockCandidate {
    /// Index de l'image échantillon.
    pub frame: usize,
    pub period: Option<f64>,
    pub clock_sec: f64,
    /// Boîte chrono ∪ période, en fractions de l'image.
    pub rect: Rect,
    /// Hauteur du texte du chrono, en fraction de la hauteur d'image.
    pub text_h: f64,
    /// Nombres lus près du chrono (scores, shot clock), avec leurs boîtes.
    pub scores: Vec<f64>,
    pub score_rects: Vec<Rect>,
    /// Boîte du seul chrono.
    pub clock_rect: Rect,
    /// Boîte de la période quand elle est un mot séparé du chrono.
    pub period_rect: Option<Rect>,
    /// Période trouvée à côté du chrono (lecture fiable).
    pub strong: bool,
    /// Chrono lu dans une case claire entière.
    pub from_cell: bool,
}

impl ClockCandidate {
    /// Objet de Node (clés dans l'ordre de `findClockCandidates`).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("frame".into(), Value::from(self.frame));
        m.insert(
            "period".into(),
            self.period.map_or(Value::Null, js_num_value),
        );
        m.insert("clock_sec".into(), js_num_value(self.clock_sec));
        m.insert("rect".into(), self.rect.to_json());
        m.insert("clockRect".into(), self.clock_rect.to_json());
        if let Some(p) = self.period_rect {
            m.insert("periodRect".into(), p.to_json());
        }
        m.insert("textH".into(), js_num_value(self.text_h));
        m.insert(
            "scores".into(),
            Value::Array(self.scores.iter().map(|n| js_num_value(*n)).collect()),
        );
        m.insert(
            "scoreRects".into(),
            Value::Array(self.score_rects.iter().map(Rect::to_json).collect()),
        );
        m.insert("strong".into(), Value::from(self.strong));
        if self.from_cell {
            m.insert("fromCell".into(), Value::from(true));
        }
        Value::Object(m)
    }
}

fn to_rect(b: &Bx, w: f64, h: f64) -> Rect {
    Rect {
        x: b.x0 / w,
        y: b.y0 / h,
        w: (b.x1 - b.x0) / w,
        h: (b.y1 - b.y0) / h,
    }
}

/// `findClockCandidates` : chronos et période voisine parmi les mots OCR
/// d'une image (pixels de l'image source `w`×`h`).
pub fn find_clock_candidates(
    words_in: &[OcrWord],
    w: f64,
    h: f64,
    frame: usize,
) -> Vec<ClockCandidate> {
    let words = merge_split_clocks(words_in);
    let tok: Vec<WordTokens> = words.iter().map(|x| analyze_word(&x.text)).collect();
    let mut out = Vec::new();
    for (ci, cw) in words.iter().enumerate() {
        let Some(clock) = tok[ci].clock else { continue };
        let c = bx(cw);
        let th = height(&c);
        let mut period = tok[ci].period;
        let mut bbox = c;
        let mut pi: Option<usize> = None;
        if period.is_none() {
            let mut best = f64::INFINITY;
            for (wi, ww) in words.iter().enumerate() {
                if wi == ci {
                    continue;
                }
                let Some(p) = tok[wi].period else { continue };
                if tok[wi].clock.is_some() {
                    continue;
                }
                let wb = bx(ww);
                let hw = height(&wb);
                if hw < 0.4 * th || hw > 2.5 * th {
                    continue;
                }
                let dy = (cy(&wb) - cy(&c)).abs();
                let gap = h_gap(&wb, &c);
                let same_line = dy <= 1.2 * th && gap <= 6.0 * th;
                let stacked = gap <= 2.0 * th && dy <= 2.5 * th;
                if !same_line && !stacked {
                    continue;
                }
                let d = gap + dy;
                if d < best {
                    best = d;
                    period = Some(p);
                    pi = Some(wi);
                }
            }
            if let Some(pi) = pi {
                bbox = union(&c, &bx(&words[pi]));
            }
        }
        if period.is_some_and(|p| p > 4.0) && clock > 300.0 {
            continue;
        }
        let mut scores: Vec<f64> = tok[ci].numbers.clone();
        if let Some(pi) = pi {
            scores.extend(tok[pi].numbers.iter().copied());
        }
        let mut score_rects = Vec::new();
        for (wi, ww) in words.iter().enumerate() {
            if wi == ci || Some(wi) == pi || tok[wi].clock.is_some() || tok[wi].numbers.is_empty() {
                continue;
            }
            let wb = bx(ww);
            let hw = height(&wb);
            if hw < 0.6 * th || hw > 2.2 * th {
                continue;
            }
            if (cy(&wb) - cy(&c)).abs() > 3.0 * th || h_gap(&wb, &bbox) > 14.0 * th {
                continue;
            }
            scores.extend(tok[wi].numbers.iter().copied());
            score_rects.push(to_rect(&wb, w, h));
        }
        out.push(ClockCandidate {
            frame,
            period,
            clock_sec: clock,
            rect: to_rect(&bbox, w, h),
            clock_rect: to_rect(&c, w, h),
            period_rect: pi.map(|pi| to_rect(&bx(&words[pi]), w, h)),
            text_h: th / h,
            scores,
            score_rects,
            strong: period.is_some(),
            from_cell: false,
        });
    }
    out
}

// ---------------------------------------------------------------- vote

/// Empreinte d'un bandeau (`PanelSignature`) : niveaux de gris médians de sa
/// zone sur la vignette, et masque des pixels stables.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelSignature {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub med: Vec<u8>,
    pub mask: Vec<usize>,
}

impl PanelSignature {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("x".into(), Value::from(self.x));
        m.insert("y".into(), Value::from(self.y));
        m.insert("w".into(), Value::from(self.w));
        m.insert("h".into(), Value::from(self.h));
        m.insert("med".into(), Value::from(self.med.clone()));
        m.insert("mask".into(), Value::from(self.mask.clone()));
        Value::Object(m)
    }

    pub fn from_json(v: &Value) -> Option<PanelSignature> {
        let u = |k: &str| v.get(k).and_then(Value::as_u64).map(|n| n as usize);
        let list = |k: &str| -> Option<Vec<u64>> {
            v.get(k)?.as_array()?.iter().map(Value::as_u64).collect()
        };
        Some(PanelSignature {
            x: u("x")?,
            y: u("y")?,
            w: u("w")?,
            h: u("h")?,
            med: list("med")?.into_iter().map(|n| n.min(255) as u8).collect(),
            mask: list("mask")?.into_iter().map(|n| n as usize).collect(),
        })
    }
}

/// Région du bandeau (`ScoreboardLocation`), mise en cache par vidéo
/// (`kv_cache`, clé `scoreboard:<okId>`, même JSON que Node).
#[derive(Debug, Clone)]
pub struct ScoreboardLocation {
    /// Région à recadrer pour lire le bandeau (chrono, période et scores proches).
    pub rect: Rect,
    /// Bloc chrono + période seul.
    pub core: Rect,
    /// Hauteur du texte du chrono (fraction de la hauteur d'image).
    pub text_h: f64,
    /// Images échantillons où le bandeau a été lu à cet endroit.
    pub frames: f64,
    pub strong_frames: f64,
    /// Boîte médiane du seul chrono.
    pub clock: Option<Rect>,
    /// Boîte médiane de la période (si elle a été lue à part).
    pub period: Option<Rect>,
    /// Emplacements des nombres récurrents près du chrono.
    pub scores: Option<Vec<Rect>>,
    /// Empreinte du bandeau, pour savoir s'il est à l'écran.
    pub panel: Option<PanelSignature>,
    /// Case de période qui a réussi en dernier (`periodHint`, propre à
    /// l'objet : partagée par les clones, comme une référence JavaScript).
    hint: Arc<Mutex<Option<&'static str>>>,
}

impl PartialEq for ScoreboardLocation {
    fn eq(&self, o: &Self) -> bool {
        self.to_json() == o.to_json()
    }
}

impl ScoreboardLocation {
    /// Objet de Node (`JSON.stringify` de la localisation).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("rect".into(), self.rect.to_json());
        m.insert("core".into(), self.core.to_json());
        m.insert("textH".into(), js_num_value(self.text_h));
        m.insert("frames".into(), js_num_value(self.frames));
        m.insert("strongFrames".into(), js_num_value(self.strong_frames));
        if let Some(c) = self.clock {
            m.insert("clock".into(), c.to_json());
        }
        if let Some(p) = self.period {
            m.insert("period".into(), p.to_json());
        }
        if let Some(s) = &self.scores {
            m.insert(
                "scores".into(),
                Value::Array(s.iter().map(Rect::to_json).collect()),
            );
        }
        if let Some(p) = &self.panel {
            m.insert("panel".into(), p.to_json());
        }
        Value::Object(m)
    }

    /// Localisation lue en cache (`kvGet`) ; `None` si l'objet est inutilisable.
    pub fn from_json(v: &Value) -> Option<ScoreboardLocation> {
        let r = |k: &str| v.get(k).and_then(Rect::from_json);
        Some(ScoreboardLocation {
            rect: r("rect")?,
            core: r("core")?,
            text_h: v.get("textH").and_then(Value::as_f64)?,
            frames: v.get("frames").and_then(Value::as_f64).unwrap_or(0.0),
            strong_frames: v.get("strongFrames").and_then(Value::as_f64).unwrap_or(0.0),
            clock: r("clock"),
            period: r("period"),
            scores: v
                .get("scores")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Rect::from_json).collect()),
            panel: v.get("panel").and_then(PanelSignature::from_json),
            hint: Arc::default(),
        })
    }
}

/// Vignettes (largeur × hauteur) de l'analyse structurelle.
pub const THUMB_W: usize = 320;
pub const THUMB_H: usize = 180;

/// `panelSignature` : empreinte du bandeau sur des vignettes (médiane + pixels stables).
pub fn panel_signature(thumbs: &[Vec<u8>], r: &Rect) -> Option<PanelSignature> {
    let n = thumbs.len();
    if n < 3 {
        return None;
    }
    let x = js::max(0.0, (r.x * THUMB_W as f64).floor());
    let y = js::max(0.0, (r.y * THUMB_H as f64).floor());
    let w = js::min(THUMB_W as f64 - x, (r.w * THUMB_W as f64).ceil());
    let h = js::min(THUMB_H as f64 - y, (r.h * THUMB_H as f64).ceil());
    if w.is_nan() || h.is_nan() || w <= 0.0 || h <= 0.0 {
        return None;
    }
    let (x, y, w, h) = (x as usize, y as usize, w as usize, h as usize);
    let mut med = Vec::new();
    let mut mask = Vec::new();
    let mut vals = vec![0u8; n];
    for j in 0..h {
        for i in 0..w {
            let p = (y + j) * THUMB_W + x + i;
            for k in 0..n {
                vals[k] = thumbs[k][p];
            }
            vals.sort_unstable();
            let m = vals[n >> 1];
            let c = vals
                .iter()
                .filter(|v| (**v as i32 - m as i32).abs() <= 20)
                .count();
            med.push(m);
            if c as f64 / n as f64 >= 0.5 {
                mask.push(j * w + i);
            }
        }
    }
    (mask.len() >= 20).then_some(PanelSignature {
        x,
        y,
        w,
        h,
        med,
        mask,
    })
}

/// `panelPresence` : part des pixels stables du bandeau retrouvés sur une vignette (0..1).
pub fn panel_presence(thumb: &[u8], sig: &PanelSignature) -> f64 {
    let mut ok = 0usize;
    for &idx in &sig.mask {
        let i = idx % sig.w;
        let j = idx / sig.w;
        let p = (sig.y + j) * THUMB_W + sig.x + i;
        if let (Some(v), Some(m)) = (thumb.get(p), sig.med.get(idx)) {
            if (*v as i32 - *m as i32).abs() <= 28 {
                ok += 1;
            }
        }
    }
    ok as f64 / sig.mask.len() as f64
}

/// En dessous de cette présence, le bandeau n'est pas à l'écran.
pub const PANEL_MIN_PRESENCE: f64 = 0.6;

fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| sign(a - b));
    let m = s.len() >> 1;
    if s.len() % 2 == 1 {
        s[m]
    } else if m == 0 {
        f64::NAN
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}

fn center(r: &Rect) -> (f64, f64) {
    (r.x + r.w / 2.0, r.y + r.h / 2.0)
}

/// Rectangle médian (bord par bord).
fn median_rect(rs: &[Rect]) -> Rect {
    let x0 = median(&rs.iter().map(|r| r.x).collect::<Vec<_>>());
    let y0 = median(&rs.iter().map(|r| r.y).collect::<Vec<_>>());
    let x1 = median(&rs.iter().map(|r| r.x + r.w).collect::<Vec<_>>());
    let y1 = median(&rs.iter().map(|r| r.y + r.h).collect::<Vec<_>>());
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

fn clamp01(v: f64) -> f64 {
    js::min(1.0, js::max(0.0, v))
}

/// Réglages de [`vote_scoreboard_region`] (`VoteOptions`).
#[derive(Debug, Clone, Copy, Default)]
pub struct VoteOptions {
    /// Nombre d'images effectivement analysées (règle d'acceptation).
    pub sampled_frames: Option<f64>,
    pub tol_x: Option<f64>,
    pub tol_y: Option<f64>,
}

/// Résultat du vote : la localisation et les candidats de la région gagnante.
#[derive(Debug, Clone)]
pub struct Vote {
    pub location: ScoreboardLocation,
    pub members: Vec<ClockCandidate>,
}

/// `voteScoreboardRegion` : région la plus récurrente (groupes de centres ;
/// valeur = images fiables + 0,35 × autres images ; voir `scoreboard.ts`).
pub fn vote_scoreboard_region(cands: &[ClockCandidate], o: &VoteOptions) -> Option<Vote> {
    let tol_x = o.tol_x.unwrap_or(0.05);
    let tol_y = o.tol_y.unwrap_or(0.04);
    struct Cluster {
        cx: f64,
        cy: f64,
        members: Vec<ClockCandidate>,
    }
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut sorted = cands.to_vec();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.strong));
    for c in sorted {
        let p = center(&c.rect);
        if let Some(cl) = clusters
            .iter_mut()
            .find(|k| (k.cx - p.0).abs() <= tol_x && (k.cy - p.1).abs() <= tol_y)
        {
            cl.members.push(c);
            cl.cx = median(
                &cl.members
                    .iter()
                    .map(|m| center(&m.rect).0)
                    .collect::<Vec<_>>(),
            );
            cl.cy = median(
                &cl.members
                    .iter()
                    .map(|m| center(&m.rect).1)
                    .collect::<Vec<_>>(),
            );
        } else {
            clusters.push(Cluster {
                cx: p.0,
                cy: p.1,
                members: vec![c],
            });
        }
    }
    let frames_of = |ms: &[ClockCandidate], strong_only: bool| {
        let mut f: Vec<usize> = Vec::new();
        for m in ms {
            if (!strong_only || m.strong) && !f.contains(&m.frame) {
                f.push(m.frame);
            }
        }
        f.len() as f64
    };
    let mut best: Option<(f64, f64, f64, &Vec<ClockCandidate>)> = None;
    for k in &clusters {
        let strong = frames_of(&k.members, true);
        let all = frames_of(&k.members, false);
        let value = strong + 0.35 * (all - strong);
        if best.is_none_or(|b| value > b.0) {
            best = Some((value, strong, all, &k.members));
        }
    }
    let (_, strong_frames, frames, members) = best?;
    let sampled = o.sampled_frames.unwrap_or(f64::INFINITY);
    // Chrono seul : il doit revenir à la même place sur plusieurs images.
    let weak_ok = frames >= js::max(2.0, (js::min(sampled, 40.0) * 0.25).ceil());
    let accepted = strong_frames >= 2.0
        || (strong_frames >= 1.0 && frames >= 2.0)
        || (sampled <= 1.0 && strong_frames >= 1.0)
        || weak_ok;
    if !accepted {
        return None;
    }
    // Un seul représentant par image (le plus fiable) pour les médianes.
    let mut per_frame: Vec<(usize, &ClockCandidate)> = Vec::new();
    for m in members {
        match per_frame.iter_mut().find(|(f, _)| *f == m.frame) {
            Some(cur) => {
                if m.strong && !cur.1.strong {
                    cur.1 = m;
                }
            }
            None => per_frame.push((m.frame, m)),
        }
    }
    let reps: Vec<&ClockCandidate> = per_frame.iter().map(|(_, c)| *c).collect();
    let core = {
        let x0 = median(&reps.iter().map(|r| r.rect.x).collect::<Vec<_>>());
        let y0 = median(&reps.iter().map(|r| r.rect.y).collect::<Vec<_>>());
        let x1 = median(&reps.iter().map(|r| r.rect.x + r.rect.w).collect::<Vec<_>>());
        let y1 = median(&reps.iter().map(|r| r.rect.y + r.rect.h).collect::<Vec<_>>());
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    };
    let text_h = median(&reps.iter().map(|r| r.text_h).collect::<Vec<_>>());

    // Scores : on n'élargit que vers des nombres qui reviennent à la même place.
    let (mut x0, mut y0, mut x1, mut y1) = (core.x, core.y, core.x + core.w, core.y + core.h);
    struct Spot {
        cx: f64,
        cy: f64,
        rects: Vec<Rect>,
        frames: Vec<usize>,
    }
    let mut spots: Vec<Spot> = Vec::new();
    for r in &reps {
        for sr in &r.score_rects {
            let p = center(sr);
            if let Some(s) = spots
                .iter_mut()
                .find(|s| (s.cx - p.0).abs() <= 0.03 && (s.cy - p.1).abs() <= 0.03)
            {
                s.rects.push(*sr);
                if !s.frames.contains(&r.frame) {
                    s.frames.push(r.frame);
                }
            } else {
                spots.push(Spot {
                    cx: p.0,
                    cy: p.1,
                    rects: vec![*sr],
                    frames: vec![r.frame],
                });
            }
        }
    }
    let min_spot = js::max(2.0, (reps.len() as f64 * 0.4).ceil());
    let mut score_rects = Vec::new();
    for s in &spots {
        let nf = s.frames.len() as f64;
        if nf < min_spot && !(reps.len() == 1 && s.frames.len() == 1) {
            continue;
        }
        score_rects.push(median_rect(&s.rects));
        x0 = js::min(x0, median(&s.rects.iter().map(|r| r.x).collect::<Vec<_>>()));
        y0 = js::min(y0, median(&s.rects.iter().map(|r| r.y).collect::<Vec<_>>()));
        x1 = js::max(
            x1,
            median(&s.rects.iter().map(|r| r.x + r.w).collect::<Vec<_>>()),
        );
        y1 = js::max(
            y1,
            median(&s.rects.iter().map(|r| r.y + r.h).collect::<Vec<_>>()),
        );
    }
    // Marge : « 10:00 » est plus large que « 7:43 », la période peut changer de forme.
    let pad_x = js::max(text_h * 1.6, core.w * 0.25);
    let pad_y = text_h * 0.6;
    let rx0 = clamp01(x0 - pad_x);
    let ry0 = clamp01(y0 - pad_y);
    let rx1 = clamp01(x1 + pad_x);
    let ry1 = clamp01(y1 + pad_y);
    // Boîtes de période serrées seulement.
    let period_all: Vec<Rect> = members.iter().filter_map(|m| m.period_rect).collect();
    let pmin = if period_all.is_empty() {
        0.0
    } else {
        period_all
            .iter()
            .fold(f64::INFINITY, |a, r| js::min(a, r.h))
    };
    let period_rects: Vec<Rect> = period_all
        .into_iter()
        .filter(|r| r.h <= pmin * 1.35)
        .collect();
    // Boîte du chrono : seulement les boîtes SERRÉES ; les mots priment sur les cases.
    let word_members: Vec<&ClockCandidate> = members.iter().filter(|m| !m.from_cell).collect();
    let clock_src: Vec<&ClockCandidate> = if word_members.is_empty() {
        members.iter().collect()
    } else {
        word_members
    };
    let hmin = clock_src
        .iter()
        .fold(f64::INFINITY, |a, m| js::min(a, m.clock_rect.h));
    let clock = median_rect(
        &clock_src
            .iter()
            .filter(|m| m.clock_rect.h <= hmin * 1.35)
            .map(|m| m.clock_rect)
            .collect::<Vec<_>>(),
    );
    Some(Vote {
        location: ScoreboardLocation {
            rect: Rect {
                x: rx0,
                y: ry0,
                w: rx1 - rx0,
                h: ry1 - ry0,
            },
            core,
            text_h,
            frames,
            strong_frames,
            clock: Some(clock),
            period: (!period_rects.is_empty()).then(|| median_rect(&period_rects)),
            scores: (!score_rects.is_empty()).then_some(score_rects),
            panel: None,
            hint: Arc::default(),
        },
        members: members.clone(),
    })
}

// ---------------------------------------------------------------- zones fixes (incrustations)

/// Zone fixe d'une image à l'autre (`StaticRegion`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StaticRegion {
    pub rect: Rect,
    /// Pixels « fixes et contrastés » dans la zone.
    pub score: f64,
}

/// Réglages des zones fixes (vignettes `w`×`h`, accord minimal).
#[derive(Debug, Clone, Copy, Default)]
pub struct StaticOptions {
    pub w: Option<usize>,
    pub h: Option<usize>,
    pub min_agree: Option<f64>,
    pub max_regions: Option<usize>,
}

/// `staticOverlayRegions` : zones FIXES d'une image à l'autre (incrustations
/// du diffuseur), triées par nombre de pixels fixes et contrastés.
pub fn static_overlay_regions(thumbs: &[Vec<u8>], o: &StaticOptions) -> Vec<StaticRegion> {
    let w = o.w.unwrap_or(THUMB_W);
    let h = o.h.unwrap_or(THUMB_H);
    let n = thumbs.len();
    if n < 2 {
        return Vec::new();
    }
    let min_agree = o.min_agree.unwrap_or(0.4);
    let mut med = vec![0u8; w * h];
    // Float32Array de Node : l'accord est arrondi en simple précision.
    let mut agree = vec![0f32; w * h];
    let mut vals = vec![0u8; n];
    for i in 0..w * h {
        for k in 0..n {
            vals[k] = thumbs[k][i];
        }
        vals.sort_unstable();
        let m = vals[n >> 1];
        med[i] = m;
        let c = vals
            .iter()
            .filter(|v| (**v as i32 - m as i32).abs() <= 14)
            .count();
        agree[i] = (c as f64 / n as f64) as f32;
    }
    const C: usize = 4;
    let cw = w.div_ceil(C);
    let chh = h.div_ceil(C);
    let mut cells = vec![0u16; cw * chh];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w - 1 {
            let i = y * w + x;
            if (agree[i] as f64) < min_agree {
                continue;
            }
            let g = (med[i + 1] as i32 - med[i - 1] as i32).abs()
                + (med[i + w] as i32 - med[i - w] as i32).abs();
            if g < 48 {
                continue;
            }
            cells[(y / C) * cw + x / C] += 1;
        }
    }
    // Cellule retenue : au moins 3 pixels sur 16, dilatée d'une cellule horizontalement.
    let mut on = vec![false; cw * chh];
    for cy in 0..chh {
        for cx in 0..cw {
            if cells[cy * cw + cx] < 3 {
                continue;
            }
            for dx in -1i64..=1 {
                let nx = cx as i64 + dx;
                if nx >= 0 && (nx as usize) < cw {
                    on[cy * cw + nx as usize] = true;
                }
            }
        }
    }
    let mut seen = vec![false; cw * chh];
    let mut out = Vec::new();
    for start in 0..cw * chh {
        if !on[start] || seen[start] {
            continue;
        }
        let mut stack = vec![start];
        seen[start] = true;
        let (mut x0, mut y0, mut x1, mut y1) = (cw as i64, chh as i64, -1i64, -1i64);
        let mut score = 0.0;
        let mut count = 0;
        while let Some(c) = stack.pop() {
            let cx = (c % cw) as i64;
            let cy = (c / cw) as i64;
            x0 = x0.min(cx);
            y0 = y0.min(cy);
            x1 = x1.max(cx);
            y1 = y1.max(cy);
            score += cells[c] as f64;
            count += 1;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let nx = cx + dx;
                    let ny = cy + dy;
                    if nx < 0 || ny < 0 || nx >= cw as i64 || ny >= chh as i64 {
                        continue;
                    }
                    let j = ny as usize * cw + nx as usize;
                    if on[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        let bw = x1 - x0 + 1;
        // Trop petit pour un bandeau (logo, coin de panneau) : ignoré.
        if count < 8 || bw < 5 || score < 40.0 {
            continue;
        }
        let pad = 1;
        let rx0 = (x0 - pad).max(0) * C as i64;
        let ry0 = (y0 - pad).max(0) * C as i64;
        let rx1 = (cw as i64).min(x1 + 1 + pad) * C as i64;
        let ry1 = (chh as i64).min(y1 + 1 + pad) * C as i64;
        let (wf, hf) = (w as f64, h as f64);
        out.push(StaticRegion {
            rect: Rect {
                x: rx0 as f64 / wf,
                y: ry0 as f64 / hf,
                w: ((w as i64).min(rx1) - rx0) as f64 / wf,
                h: ((h as i64).min(ry1) - ry0) as f64 / hf,
            },
            score,
        });
    }
    out.sort_by(|a, b| sign(b.score - a.score));
    out.truncate(o.max_regions.unwrap_or(4));
    out
}

/// `staticBrightCells` : cases CLAIRES fixes dans une zone (case blanche du
/// chrono, pastille), les plus grandes d'abord.
pub fn static_bright_cells(thumbs: &[Vec<u8>], zone: &Rect, o: &StaticOptions) -> Vec<Rect> {
    let w = o.w.unwrap_or(THUMB_W);
    let h = o.h.unwrap_or(THUMB_H);
    let n = thumbs.len();
    if n < 2 {
        return Vec::new();
    }
    let min_agree = o.min_agree.unwrap_or(0.4);
    let (wf, hf) = (w as f64, h as f64);
    let zx0 = js::max(0.0, (zone.x * wf).floor());
    let zy0 = js::max(0.0, (zone.y * hf).floor());
    let zx1 = js::min(wf, ((zone.x + zone.w) * wf).ceil());
    let zy1 = js::min(hf, ((zone.y + zone.h) * hf).ceil());
    let zw = zx1 - zx0;
    let zh = zy1 - zy0;
    if zw.is_nan() || zh.is_nan() || zw <= 0.0 || zh <= 0.0 {
        return Vec::new();
    }
    let (zx0, zy0, zw, zh) = (zx0 as usize, zy0 as usize, zw as usize, zh as usize);
    let mut mask = vec![false; zw * zh];
    let mut vals = vec![0u8; n];
    for y in 0..zh {
        for x in 0..zw {
            let i = (zy0 + y) * w + zx0 + x;
            for k in 0..n {
                vals[k] = thumbs[k][i];
            }
            vals.sort_unstable();
            let m = vals[n >> 1];
            if m < 170 {
                continue;
            }
            let c = vals
                .iter()
                .filter(|v| (**v as i32 - m as i32).abs() <= 30)
                .count();
            if c as f64 / n as f64 >= min_agree {
                mask[y * zw + x] = true;
            }
        }
    }
    // Fermeture horizontale (trous de 4 pixels au plus).
    let mut closed = mask.clone();
    for y in 0..zh {
        let mut last: i64 = -1;
        for x in 0..zw {
            if !mask[y * zw + x] {
                continue;
            }
            let xi = x as i64;
            if last >= 0 && xi - last > 1 && xi - last <= 5 {
                for k in (last + 1) as usize..x {
                    closed[y * zw + k] = true;
                }
            }
            last = xi;
        }
    }
    let total = zw * zh;
    let mut seen = vec![false; total];
    let mut out = Vec::new();
    for s in 0..total {
        if !closed[s] || seen[s] {
            continue;
        }
        let mut stack = vec![s];
        seen[s] = true;
        let (mut x0, mut y0, mut x1, mut y1) = (zw as i64, zh as i64, -1i64, -1i64);
        let mut count = 0f64;
        while let Some(c) = stack.pop() {
            let cx = (c % zw) as i64;
            let cyy = (c / zw) as i64;
            x0 = x0.min(cx);
            y0 = y0.min(cyy);
            x1 = x1.max(cx);
            y1 = y1.max(cyy);
            count += 1.0;
            let ci = c as i64;
            for j in [ci - 1, ci + 1, ci - zw as i64, ci + zw as i64] {
                if j < 0 || j >= total as i64 || seen[j as usize] || !closed[j as usize] {
                    continue;
                }
                if (j == ci - 1 && cx == 0) || (j == ci + 1 && cx == zw as i64 - 1) {
                    continue;
                }
                seen[j as usize] = true;
                stack.push(j as usize);
            }
        }
        let bw = (x1 - x0 + 1) as f64;
        let bh = (y1 - y0 + 1) as f64;
        // Case de chrono : 3 à 20 pixels de haut, plus large que haute, bien remplie.
        if !(3.0..=20.0).contains(&bh) || bw < 1.2 * bh || bw > 8.0 * bh || count < 0.45 * bw * bh {
            continue;
        }
        out.push(Rect {
            x: (zx0 as f64 + x0 as f64) / wf,
            y: (zy0 as f64 + y0 as f64) / hf,
            w: bw / wf,
            h: bh / hf,
        });
    }
    out.sort_by(|a, b| sign(b.w * b.h - a.w * a.h));
    out
}

// ---------------------------------------------------------------- filtres d'image

/// Binarisations disponibles (`BINARIZATIONS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binarization {
    /// Texte clair sur fond sombre → noir sur blanc.
    Light,
    /// Idem, seuil plus haut.
    LightHigh,
    /// Niveaux de gris (tesseract binarise lui-même).
    Gray,
    /// Texte sombre sur fond clair → noir sur blanc.
    Dark,
}

impl Binarization {
    pub fn filter(self) -> &'static str {
        match self {
            Binarization::Light => "format=gray,lutyuv=y='if(gt(val,165),0,255)'",
            Binarization::LightHigh => "format=gray,lutyuv=y='if(gt(val,205),0,255)'",
            Binarization::Gray => "format=gray",
            Binarization::Dark => "format=gray,lutyuv=y='if(lt(val,110),0,255)'",
        }
    }
}

/// Rectangle en pixels pairs, borné à l'image (`pixelCrop`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelCrop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `pixelCrop`.
pub fn pixel_crop(r: &Rect, w: f64, h: f64) -> PixelCrop {
    let x = js::max(0.0, ((r.x * w) / 2.0).floor() * 2.0);
    let y = js::max(0.0, ((r.y * h) / 2.0).floor() * 2.0);
    let cw = js::max(2.0, js::min(w - x, ((r.w * w) / 2.0).ceil() * 2.0));
    let ch = js::max(2.0, js::min(h - y, ((r.h * h) / 2.0).ceil() * 2.0));
    PixelCrop { x, y, w: cw, h: ch }
}

fn n(f: f64) -> String {
    crate::jsval::js_number_string(f)
}

fn scaled(v: f64, k: f64) -> f64 {
    js::max(2.0, js::round((v * k) / 2.0) * 2.0)
}

/// `cropFilter` : recadrage, agrandissement ×k (bicubique), binarisation.
pub fn crop_filter(r: &Rect, w: f64, h: f64, k: f64, bin: Binarization) -> String {
    let c = pixel_crop(r, w, h);
    format!(
        "crop={}:{}:{}:{},scale={}:{}:flags=bicubic,{}",
        n(c.w),
        n(c.h),
        n(c.x),
        n(c.y),
        n(scaled(c.w, k)),
        n(scaled(c.h, k)),
        bin.filter()
    )
}

/// `upscaleFor` : tesseract lit le mieux des glyphes de ~40-50 px.
pub fn upscale_for(text_px: f64) -> f64 {
    js::min(6.0, js::max(1.0, 46.0 / js::max(4.0, text_px)))
}

// ---------------------------------------------------------------- OCR d'une zone

/// Texte et mots d'une zone (pixels de l'image SOURCE), avec le nombre d'appels OCR.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZoneRead {
    pub text: String,
    pub words: Vec<OcrWord>,
    pub calls: usize,
}

/// `ocrZone` : OCR d'une zone d'une image ; mots en pixels de l'image source.
#[allow(clippy::too_many_arguments)]
pub async fn ocr_zone(
    engine: &dyn OcrEngine,
    png: &[u8],
    w: f64,
    h: f64,
    r: &Rect,
    k: f64,
    bin: Binarization,
    params: &OcrParams,
) -> Result<ZoneRead, String> {
    let c = pixel_crop(r, w, h);
    let img = filter_image(png, &crop_filter(r, w, h, k, bin), None).await?;
    let page = recognize_words(engine, &img, params).await?;
    let sx = c.w / scaled(c.w, k);
    let sy = c.h / scaled(c.h, k);
    Ok(ZoneRead {
        text: page.text,
        words: page
            .words
            .into_iter()
            .map(|wd| OcrWord {
                x0: c.x + wd.x0 * sx,
                x1: c.x + wd.x1 * sx,
                y0: c.y + wd.y0 * sy,
                y1: c.y + wd.y1 * sy,
                ..wd
            })
            .collect(),
        calls: 1,
    })
}

/// Bandes candidates (repli sans zone fixe) : bas d'abord, puis haut (`SEARCH_BANDS`).
pub const SEARCH_BANDS: [(&str, f64, f64); 2] = [("bas", 0.68, 0.32), ("haut", 0.0, 0.24)];

/// Tuiles horizontales qui se recouvrent de moitié (`TILES` : x, largeur).
pub const TILES: [(f64, f64); 3] = [(0.0, 0.5), (0.25, 0.5), (0.5, 0.5)];

/// Binarisations lues et FUSIONNÉES pour une même zone.
pub const MERGED_BINARIZATIONS: [Binarization; 2] = [Binarization::Gray, Binarization::Light];

/// Binarisations des petits recadrages (une case), départagées par vote.
pub const REFINE_BINARIZATIONS: [Binarization; 3] =
    [Binarization::Dark, Binarization::Light, Binarization::Gray];

/// `ocrZoneMerged` : OCR d'une zone avec plusieurs binarisations, mots réunis.
pub async fn ocr_zone_merged(
    engine: &dyn OcrEngine,
    png: &[u8],
    w: f64,
    h: f64,
    r: &Rect,
    k: f64,
    bins: &[Binarization],
) -> ZoneRead {
    let mut out = ZoneRead::default();
    let mut texts = Vec::new();
    for &bin in bins {
        // Binarisation illisible : on passe.
        if let Ok(z) = ocr_zone(engine, png, w, h, r, k, bin, &OcrParams::default()).await {
            out.calls += 1;
            out.words.extend(z.words);
            texts.push(z.text);
        }
    }
    out.text = texts.join("\n");
    out
}

fn digit_count(t: &str) -> usize {
    t.bytes().filter(u8::is_ascii_digit).count()
}

/// `clockLikeWords` : mots « chrono probable » à relire seuls.
fn clock_like_words(words: &[OcrWord], max: usize) -> Vec<OcrWord> {
    let rank = |w: &OcrWord| -> f64 {
        let d = digit_count(&w.text);
        let h = w.y1 - w.y0;
        if h < 6.0 {
            return -1.0;
        }
        if (2..=5).contains(&d) {
            if test(fre!(r"\d[:.]\d"), &w.text) || test(fre!(r"^[:.]\d"), &w.text) {
                return 3.0;
            }
            // Bilan « 54-28 » : jamais un chrono.
            if test(fre!(r"\d-\d"), &w.text) {
                return -1.0;
            }
            return if d >= 3 { 2.0 } else { 0.8 };
        }
        // Mot illisible de la taille d'un chrono : relu seul, il se lit souvent.
        let letters = w.text.chars().filter(char::is_ascii_alphabetic).count() as f64;
        let aspect = (w.x1 - w.x0) / h;
        if d == 0
            && h >= 10.0
            && (1.3..=6.0).contains(&aspect)
            && letters / js::max(1.0, js::utf16_len(&w.text) as f64) < 0.7
        {
            return 1.0;
        }
        -1.0
    };
    let mut ranked: Vec<(f64, &OcrWord)> = words
        .iter()
        .map(|w| (rank(w), w))
        .filter(|(r, _)| *r > 0.0)
        .collect();
    ranked.sort_by(|a, b| sign(b.0 - a.0));
    let mut out: Vec<OcrWord> = Vec::new();
    for (_, w) in ranked {
        let h = w.y1 - w.y0;
        if out.iter().any(|o| {
            ((o.x0 + o.x1) / 2.0 - (w.x0 + w.x1) / 2.0).abs() < 2.0 * h
                && ((o.y0 + o.y1) / 2.0 - (w.y0 + w.y1) / 2.0).abs() < h
        }) {
            continue;
        }
        out.push(w.clone());
        if out.len() >= max {
            break;
        }
    }
    out
}

/// `ocrZoneRefined` : texte épars (binarisations fusionnées), puis relecture
/// « une ligne » d'un recadrage serré autour des mots qui ressemblent à un chrono.
#[allow(clippy::too_many_arguments)]
pub async fn ocr_zone_refined(
    engine: &dyn OcrEngine,
    png: &[u8],
    w: f64,
    h: f64,
    r: &Rect,
    k: f64,
    bins: Option<&[Binarization]>,
    max_refine: Option<usize>,
) -> ZoneRead {
    let first = ocr_zone_merged(
        engine,
        png,
        w,
        h,
        r,
        k,
        bins.unwrap_or(&MERGED_BINARIZATIONS),
    )
    .await;
    let mut calls = first.calls;
    let mut words = first.words.clone();
    let mut texts = vec![first.text.clone()];
    for wd in clock_like_words(&first.words, max_refine.unwrap_or(5)) {
        let hh = wd.y1 - wd.y0;
        let px = if digit_count(&wd.text) > 0 {
            1.6 * hh
        } else {
            0.5 * hh
        };
        let sub = Rect {
            x: (wd.x0 - px) / w,
            y: (wd.y0 - 0.35 * hh) / h,
            w: (wd.x1 - wd.x0 + 2.0 * px) / w,
            h: (1.7 * hh) / h,
        };
        let clipped = Rect {
            x: js::max(0.0, sub.x),
            y: js::max(0.0, sub.y),
            w: js::min(1.0, sub.x + sub.w) - js::max(0.0, sub.x),
            h: js::min(1.0, sub.y + sub.h) - js::max(0.0, sub.y),
        };
        // Mot illisible recadré serré : alphabet des chiffres.
        let params = OcrParams::new(
            "7",
            if digit_count(&wd.text) > 0 {
                ""
            } else {
                "0123456789:."
            },
        );
        for bin in REFINE_BINARIZATIONS {
            if let Ok(z) = ocr_zone(
                engine,
                png,
                w,
                h,
                &clipped,
                js::min(6.0, js::max(1.5, 46.0 / hh)),
                bin,
                &params,
            )
            .await
            {
                calls += 1;
                words.extend(z.words);
                texts.push(z.text);
            }
        }
    }
    ZoneRead {
        text: texts.join("\n"),
        words,
        calls,
    }
}

/// Facteur d'agrandissement d'une zone fixe (texte ≈ 10-17 px en 720p → 30-50 px).
fn zone_scale(h: f64) -> f64 {
    js::min(4.0, js::max(1.5, (3.0 * 720.0) / h))
}

/// Méthode qui a trouvé le bandeau.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocateMethod {
    ZonesFixes,
    Bandes,
}

impl LocateMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            LocateMethod::ZonesFixes => "zones-fixes",
            LocateMethod::Bandes => "bandes",
        }
    }
}

/// Résultat de [`locate_scoreboard`] (`LocateResult`).
#[derive(Debug, Clone)]
pub struct LocateOutcome {
    pub location: Option<ScoreboardLocation>,
    /// Lecture retenue par image échantillon (dans la région gagnante).
    pub readings: Vec<Option<ScoreboardReading>>,
    pub ocr_calls: usize,
    pub method: Option<LocateMethod>,
}

/// Réglages de [`locate_scoreboard`] (`LocateOptions`).
#[derive(Default)]
pub struct LocateOptions<'a> {
    pub on_progress: Option<&'a (dyn Fn(usize, usize) + Send + Sync)>,
    /// Bandes de repli (nom, y, hauteur) ; [`SEARCH_BANDS`] par défaut.
    pub bands: Option<Vec<(&'static str, f64, f64)>>,
    pub binarizations: Option<Vec<Binarization>>,
    /// Zones fixes candidates examinées au plus (3).
    pub max_zones: Option<usize>,
}

fn union_rect(a: &Rect, b: &Rect) -> Rect {
    let x0 = js::min(a.x, b.x);
    let y0 = js::min(a.y, b.y);
    let x1 = js::max(a.x + a.w, b.x + b.w);
    let y1 = js::max(a.y + a.h, b.y + b.h);
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// Mot synthétique « m:ss » d'un chrono lu dans une case.
fn clock_text(v: f64) -> String {
    format!("{}:{:0>2}", n((v / 60.0).floor()), n(v % 60.0))
}

/// Valeur la plus lue ; à égalité, la première (`sort` stable par fréquence).
fn most_read(values: &[f64]) -> f64 {
    let count = |x: f64| values.iter().filter(|v| **v == x).count() as f64;
    let mut s = values.to_vec();
    s.sort_by(|a, b| sign(count(*b) - count(*a)));
    s[0]
}

/// `locateScoreboard` : localise le bandeau sur des images échantillons
/// (zones fixes d'abord, puis bandes en tuiles) ; voir `scoreboard.ts`.
pub async fn locate_scoreboard(
    engine: &dyn OcrEngine,
    frames: &[Vec<u8>],
    o: &LocateOptions<'_>,
) -> LocateOutcome {
    let sizes: Vec<Option<(f64, f64)>> = frames.iter().map(|f| png_size(f)).collect();
    let bins: Vec<Binarization> = o
        .binarizations
        .clone()
        .unwrap_or(MERGED_BINARIZATIONS.to_vec());
    let bands = o.bands.clone().unwrap_or(SEARCH_BANDS.to_vec());
    let mut ocr_calls = 0;

    let mut thumbs: Vec<Vec<u8>> = Vec::new();
    let finish = |cands: &[ClockCandidate],
                  method: LocateMethod,
                  panel: Option<&Rect>,
                  thumbs: &[Vec<u8>],
                  calls: usize| {
        let vote = vote_scoreboard_region(
            cands,
            &VoteOptions {
                sampled_frames: Some(frames.len() as f64),
                ..Default::default()
            },
        )?;
        let mut location = vote.location;
        // Empreinte sur la région « utile » et non sur la zone fixe entière.
        let sig = if thumbs.len() >= 3 {
            panel_signature(thumbs, &location.rect)
        } else {
            None
        };
        if let Some(p) = panel {
            location.rect = union_rect(&location.rect, p);
        }
        if sig.is_some() {
            location.panel = sig;
        }
        let readings = (0..frames.len())
            .map(|i| {
                let ms: Vec<ClockCandidate> = vote
                    .members
                    .iter()
                    .filter(|m| m.frame == i)
                    .cloned()
                    .collect();
                best_reading(&ms, Some(&location.core), 0.08)
            })
            .collect();
        Some(LocateOutcome {
            location: Some(location),
            readings,
            ocr_calls: calls,
            method: Some(method),
        })
    };

    // 1. Zones fixes.
    let mut zones: Vec<Rect> = Vec::new();
    let mut min_agree = 0.4;
    if frames.len() >= 3 {
        for f in frames {
            if let Ok(t) = raw_gray(f, THUMB_W as u32, THUMB_H as u32, None, "").await {
                thumbs.push(t);
            }
        }
        // Avec peu d'images, on exige plus d'accord.
        min_agree = if thumbs.len() <= 5 { 0.6 } else { 0.4 };
        zones = static_overlay_regions(
            &thumbs,
            &StaticOptions {
                min_agree: Some(min_agree),
                ..Default::default()
            },
        )
        .into_iter()
        .map(|z| z.rect)
        .filter(|r| r.w * r.h <= 0.3 && r.h <= 0.35)
        .take(o.max_zones.unwrap_or(3))
        .collect();
    }
    let total = (zones.len() + bands.len()) * frames.len();
    let mut done = 0;
    for zone in &zones {
        let mut cands: Vec<ClockCandidate> = Vec::new();
        let cells: Vec<Rect> = static_bright_cells(
            &thumbs,
            zone,
            &StaticOptions {
                min_agree: Some(min_agree),
                ..Default::default()
            },
        )
        .into_iter()
        .take(2)
        .collect();
        for (i, frame) in frames.iter().enumerate() {
            let Some((w, h)) = sizes[i] else { continue };
            // Cases claires fixes d'abord : lues seules, vote entre binarisations.
            let mut cell_words: Vec<OcrWord> = Vec::new();
            for cell in &cells {
                let Some(r) = clip(&expand(cell, 0.08, 0.12)) else {
                    continue;
                };
                let reads = ocr_line(
                    engine,
                    frame,
                    w,
                    h,
                    &r,
                    cell.h * h * 0.6,
                    &[Binarization::Dark, Binarization::Gray],
                    "0123456789:.",
                    "7",
                )
                .await;
                ocr_calls += 2;
                let values: Vec<f64> = reads
                    .iter()
                    .filter_map(|x| clock_from_slot_text(&x.text))
                    .collect();
                if values.is_empty() {
                    continue;
                }
                let v = most_read(&values);
                let ih = cell.h * h * 0.7;
                let icy = (cell.y + cell.h / 2.0) * h;
                cell_words.push(OcrWord {
                    text: clock_text(v),
                    x0: cell.x * w,
                    x1: (cell.x + cell.w) * w,
                    y0: icy - ih / 2.0,
                    y1: icy + ih / 2.0,
                    confidence: 90.0,
                });
            }
            // Puis la zone entière ; relecture des mots douteux seulement sans case lue.
            let z = ocr_zone_refined(
                engine,
                frame,
                w,
                h,
                zone,
                zone_scale(h),
                Some(&bins),
                Some(if cell_words.is_empty() { 3 } else { 1 }),
            )
            .await;
            ocr_calls += z.calls;
            cands.extend(find_clock_candidates(&z.words, w, h, i));
            for cw in &cell_words {
                let mut all = vec![cw.clone()];
                all.extend(z.words.iter().cloned());
                if let Some(c) = find_clock_candidates(&all, w, h, i)
                    .into_iter()
                    .find(|x| x.clock_rect.x == cw.x0 / w)
                {
                    cands.push(ClockCandidate {
                        from_cell: true,
                        ..c
                    });
                }
            }
            done += 1;
            if let Some(f) = o.on_progress {
                f(done, total);
            }
        }
        if let Some(r) = finish(
            &cands,
            LocateMethod::ZonesFixes,
            Some(zone),
            &thumbs,
            ocr_calls,
        ) {
            return r;
        }
    }

    // 2. Repli : bandes en tuiles.
    let mut cands: Vec<ClockCandidate> = Vec::new();
    for &(_, by, bh) in &bands {
        for (i, frame) in frames.iter().enumerate() {
            let Some((w, h)) = sizes[i] else { continue };
            let k = js::min(4.0, js::max(1.0, 1440.0 / h));
            for (tx, tw) in TILES {
                let r = Rect {
                    x: tx,
                    y: by,
                    w: tw,
                    h: bh,
                };
                let z = ocr_zone_merged(engine, frame, w, h, &r, k, &bins).await;
                ocr_calls += z.calls;
                cands.extend(find_clock_candidates(&z.words, w, h, i));
            }
            done += 1;
            if let Some(f) = o.on_progress {
                f(done, total);
            }
        }
        if let Some(r) = finish(&cands, LocateMethod::Bandes, None, &thumbs, ocr_calls) {
            return r;
        }
    }
    LocateOutcome {
        location: None,
        readings: vec![None; frames.len()],
        ocr_calls,
        method: None,
    }
}

// ---------------------------------------------------------------- lecture d'une image

/// `bestCandidate` : candidat le plus fiable et le plus proche du bloc chrono attendu.
fn best_candidate<'a>(
    cands: &'a [ClockCandidate],
    core: Option<&Rect>,
    max_dist: f64,
) -> Option<&'a ClockCandidate> {
    let mut best = None;
    let mut best_d = f64::INFINITY;
    let target = core.map(center);
    for c in cands {
        let p = center(&c.rect);
        let d = target.map_or(0.0, |t| js_hypot(p.0 - t.0, (p.1 - t.1) * 1.5));
        if target.is_some() && d > max_dist {
            continue;
        }
        let score = d - if c.strong { 1.0 } else { 0.0 };
        if score < best_d {
            best_d = score;
            best = Some(c);
        }
    }
    best
}

fn best_reading(
    cands: &[ClockCandidate],
    core: Option<&Rect>,
    max_dist: f64,
) -> Option<ScoreboardReading> {
    best_candidate(cands, core, max_dist).map(|b| ScoreboardReading {
        period: b.period,
        clock_sec: b.clock_sec,
        scores: b.scores.clone(),
    })
}

/// `loosePeriod` : période d'un PETIT jeton voisin du chrono, en tolérant les
/// confusions des périodes en exposant (« 187 », « 1T », « 15T ») ; `bare_suffix`
/// (vrai par défaut) admet un suffixe seul (« ND »).
pub fn loose_period(text: &str, bare_suffix: Option<bool>) -> Option<f64> {
    let t = jsre!(r"[^0-9A-Z]")
        .replace_all(&normalize_ocr_text(text), "")
        .into_owned();
    if t.is_empty() {
        return None;
    }
    let strict = parse_period_text(&t);
    if strict.is_some() && js::utf16_len(&t) <= 4 {
        return strict;
    }
    if jsre!(r"^1(?:[S58][T7]|[ST])$").is_match(&t) {
        return Some(1.0);
    }
    if jsre!(r"^2(?:N[D0O]?)$").is_match(&t) {
        return Some(2.0);
    }
    if jsre!(r"^3(?:R[D0O]?)$").is_match(&t) {
        return Some(3.0);
    }
    if jsre!(r"^4(?:[T7][H4]|T)$").is_match(&t) {
        return Some(4.0);
    }
    // Chiffre perdu, suffixe lu : les quatre suffixes sont distincts.
    let re = if bare_suffix.unwrap_or(true) {
        jsre!(r"^[0-9A-Z]?(ST|ND|RD|TH)$")
    } else {
        jsre!(r"^[0-9A-Z](ST|ND|RD|TH)$")
    };
    let m = re.captures(&t)?;
    let v = match &m[1] {
        "ST" => 1.0,
        "ND" => 2.0,
        "RD" => 3.0,
        _ => 4.0,
    };
    let lead = num(&t[..1]);
    if t.len() == 3 && (1.0..=4.0).contains(&lead) && lead != v {
        None
    } else {
        Some(v)
    }
}

/// `colonlessClock` : chrono sans deux-points (« 857 », « 8.57 »), seulement
/// si la valeur est un chrono valide.
pub fn colonless_clock(text: &str) -> Option<f64> {
    let t = jsre!(r"[^0-9.,]").replace_all(text, "").into_owned();
    let m = jsre!(r"^(\d{1,2})[.,]?(\d{2})$").captures(&t)?;
    if !t.contains(['.', ',']) && t.len() < 3 {
        return None;
    }
    let mm = num(&m[1]);
    let ss = num(&m[2]);
    if mm > 12.0 || ss >= 60.0 || (mm == 12.0 && ss > 0.0) {
        return None;
    }
    Some(mm * 60.0 + ss)
}

fn overlaps(w: &OcrWord, r: &Rect, iw: f64, ih: f64) -> bool {
    let cx = (w.x0 + w.x1) / 2.0 / iw;
    let cyy = (w.y0 + w.y1) / 2.0 / ih;
    let mx = r.w * 0.6;
    let my = r.h * 0.8;
    cx >= r.x - mx && cx <= r.x + r.w + mx && cyy >= r.y - my && cyy <= r.y + r.h + my
}

/// Zones de repli sans localisation (`FALLBACK_ZONES`).
pub const FALLBACK_ZONES: [Rect; 3] = [
    Rect {
        x: 0.0,
        y: 0.74,
        w: 1.0,
        h: 0.26,
    },
    Rect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 0.22,
    },
    Rect {
        x: 0.42,
        y: 0.825,
        w: 0.15,
        h: 0.13,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Polarity {
    Sombre,
    Clair,
}

/// `clockPolarity` : polarité du texte du chrono (zone claire → texte sombre).
async fn clock_polarity(png: &[u8], r: &Rect) -> Option<Polarity> {
    let (w, h) = png_size(png)?;
    let c = pixel_crop(r, w, h);
    let pre = format!("crop={}:{}:{}:{}", n(c.w), n(c.h), n(c.x), n(c.y));
    let mut g = raw_gray(png, 48, 16, Some(10_000), &pre).await.ok()?;
    let len = g.len();
    g.sort_unstable();
    let v = g[len >> 1];
    if v >= 150 {
        Some(Polarity::Sombre)
    } else if v <= 90 {
        Some(Polarity::Clair)
    } else {
        None
    }
}

/// Rectangle agrandi de `ax` × largeur et `ay` × hauteur de chaque côté, borné à l'image.
fn expand(r: &Rect, ax: f64, ay: f64) -> Rect {
    let x0 = js::max(0.0, r.x - r.w * ax);
    let y0 = js::max(0.0, r.y - r.h * ay);
    let x1 = js::min(1.0, r.x + r.w * (1.0 + ax));
    let y1 = js::min(1.0, r.y + r.h * (1.0 + ay));
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// Lecture d'une petite zone par une binarisation (texte rogné non vide).
#[derive(Debug, Clone)]
struct LineRead {
    text: String,
    words: Vec<OcrWord>,
}

/// `ocrLine` : OCR « une ligne » d'une petite zone ; textes de chaque binarisation.
#[allow(clippy::too_many_arguments)]
async fn ocr_line(
    engine: &dyn OcrEngine,
    png: &[u8],
    w: f64,
    h: f64,
    r: &Rect,
    text_px: f64,
    bins: &[Binarization],
    whitelist: &str,
    psm: &str,
) -> Vec<LineRead> {
    let k = js::min(6.0, js::max(1.5, 46.0 / js::max(4.0, text_px)));
    let params = OcrParams::new(psm, whitelist);
    let mut out = Vec::new();
    for &bin in bins {
        if let Ok(z) = ocr_zone(engine, png, w, h, r, k, bin, &params).await {
            let t = js::trim(&z.text);
            if !t.is_empty() {
                out.push(LineRead {
                    text: t.to_string(),
                    words: z.words,
                });
            }
        }
    }
    out
}

/// `periodFromSlot` : période lue dans la case « période » d'un gabarit,
/// arbitrée par la hauteur des glyphes (voir `scoreboard.ts`).
pub fn period_from_slot(
    words: &[OcrWord],
    clock_px: f64,
    relaxed: bool,
    bare_suffix: Option<bool>,
) -> Option<f64> {
    let bare = bare_suffix.unwrap_or(!relaxed);
    for w in words {
        let h = w.y1 - w.y0;
        let t = jsre!(r"[^0-9A-Z.]")
            .replace_all(&normalize_ocr_text(&w.text), "")
            .into_owned();
        let p = loose_period(&t, Some(bare)).or_else(|| parse_period_text(&t));
        if h < 0.4 * clock_px {
            continue; // fragment parasite
        }
        if p.is_some() && h <= 1.3 * clock_px {
            return p;
        }
        if relaxed && h <= 1.3 * clock_px {
            if let Some(m) = jsre!(r"^([1-4])[A-Z0.]{0,2}$").captures(&t) {
                return Some(num(&m[1]));
            }
        }
        // Période en exposant à gauche du chrono (ESPN), nettement plus petite.
        if !relaxed && h <= 0.85 * clock_px {
            if let Some(m) = jsre!(r"^([1-4])[A-Z]{0,2}$").captures(&t) {
                return Some(num(&m[1]));
            }
        }
    }
    None
}

/// `clockFromLine` : chrono lu dans le texte d'une petite zone.
fn clock_from_line(text: &str) -> Option<f64> {
    let t = normalize_ocr_text(text);
    if let Some(c) = parse_clock_candidates(&t).first() {
        return Some(*c);
    }
    glued_clock(&t).or_else(|| colonless_clock(&jsre!(r"\s+").replace_all(&t, "")))
}

/// `gluedClock` : chrono pris dans une suite collée (« 114:562 » = 4:56).
pub fn glued_clock(text: &str) -> Option<f64> {
    let s = jsre!(r"\s+").replace_all(text, "").into_owned();
    let m = jsre!(r"(\d{1,2}):(\d{2})").captures(&s)?;
    let ss = num(&m[2]);
    if ss >= 60.0 {
        return None;
    }
    let mm_txt = &m[1];
    let opts: Vec<&str> = if mm_txt.len() == 2 {
        vec![mm_txt, &mm_txt[1..]]
    } else {
        vec![mm_txt]
    };
    for t in opts {
        let mm = num(t);
        if mm <= 12.0 && !(mm == 12.0 && ss > 0.0) {
            return Some(mm * 60.0 + ss);
        }
    }
    None
}

/// `clockFromSlotText` : chrono lu dans la case du chrono seule (formes
/// classiques, collées, sans deux-points, dixièmes « 129.7 »).
pub fn clock_from_slot_text(text: &str) -> Option<f64> {
    let t = jsre!(r"\s+")
        .replace_all(&normalize_ocr_text(text), "")
        .into_owned();
    if let Some(m) = jsre!(r"^[1:;]?(\d{1,2})\.(\d)$").captures(&t) {
        if num(&m[1]) < 60.0 {
            return Some(js::round(num(&m[1]) + num(&m[2]) / 10.0));
        }
    }
    parse_clock_candidates(&t)
        .first()
        .copied()
        .or_else(|| glued_clock(&t))
        .or_else(|| colonless_clock(&t))
}

/// `clockFromZone` : mots proches de la place du chrono, puis le texte entier.
fn clock_from_zone(z: &LineRead, clock: &Rect, w: f64, h: f64) -> Option<f64> {
    let cx = (clock.x + clock.w / 2.0) * w;
    let tol = js::max(clock.w * w * 0.6, clock.h * h * 1.2);
    for wd in z
        .words
        .iter()
        .filter(|x| ((x.x0 + x.x1) / 2.0 - cx).abs() <= tol)
    {
        let t = normalize_ocr_text(&wd.text);
        let v = parse_clock_candidates(&t)
            .first()
            .copied()
            .or_else(|| glued_clock(&t))
            .or_else(|| colonless_clock(&t));
        if v.is_some() {
            return v;
        }
    }
    clock_from_line(&z.text)
}

/// `readTemplate` : lecture « gabarit » — chrono, période et scores relus
/// chacun seul, à leur place apprise, en mode « une ligne ».
async fn read_template(
    engine: &dyn OcrEngine,
    png: &[u8],
    w: f64,
    h: f64,
    loc: &ScoreboardLocation,
) -> Option<ScoreboardReading> {
    let clock = loc.clock?;
    let ch = clock.h * h;
    let pad_x = (1.6 * ch) / w;
    let clock_zone = clip(&Rect {
        x: clock.x - pad_x,
        y: clock.y - clock.h * 0.3,
        w: clock.w + 2.0 * pad_x,
        h: clock.h * 1.6,
    })?;
    // 1. Sans alphabet restreint (cases voisines séparées) ; 2. le mot central relu seul.
    let zones = ocr_line(
        engine,
        png,
        w,
        h,
        &clock_zone,
        ch,
        &[Binarization::Gray, Binarization::Light],
        "",
        "7",
    )
    .await;
    let cx = (clock.x + clock.w / 2.0) * w;
    let tol = js::max(clock.w * w * 0.6, ch * 1.2);
    let central: Vec<&OcrWord> = zones
        .iter()
        .flat_map(|z| z.words.iter())
        .filter(|wd| ((wd.x0 + wd.x1) / 2.0 - cx).abs() <= tol && wd.y1 - wd.y0 >= ch * 0.6)
        .collect();
    let mut values: Vec<f64> = Vec::new();
    if !central.is_empty() {
        let parsed: Vec<&OcrWord> = central
            .iter()
            .copied()
            .filter(|wd| clock_from_slot_text(&wd.text).is_some())
            .collect();
        let digits: Vec<&OcrWord> = central
            .iter()
            .copied()
            .filter(|wd| wd.text.bytes().any(|b| b.is_ascii_digit()))
            .collect();
        let pool: Vec<&OcrWord> = if !parsed.is_empty() {
            vec![parsed[0]]
        } else if !digits.is_empty() {
            digits
        } else {
            central.clone()
        };
        // Le mot déjà lisible compte pour deux voix.
        if let Some(p) = parsed.first() {
            let v0 = clock_from_slot_text(&p.text).expect("lisible");
            values.push(v0);
            values.push(v0);
        }
        let mut bb = Bx {
            x0: pool[0].x0,
            y0: pool[0].y0,
            x1: pool[0].x1,
            y1: pool[0].y1,
        };
        for b in &pool[1..] {
            bb = Bx {
                x0: js::min(bb.x0, b.x0),
                x1: js::max(bb.x1, b.x1),
                y0: js::min(bb.y0, b.y0),
                y1: js::max(bb.y1, b.y1),
            };
        }
        let bh = bb.y1 - bb.y0;
        let tight = clip(&Rect {
            x: (bb.x0 - 0.3 * bh) / w,
            y: (bb.y0 - 0.2 * bh) / h,
            w: (bb.x1 - bb.x0 + 0.6 * bh) / w,
            h: (1.4 * bh) / h,
        });
        if let Some(tight) = tight {
            let polarity = clock_polarity(png, &tight).await;
            let bins: &[Binarization] = match polarity {
                Some(Polarity::Sombre) => &[Binarization::Dark, Binarization::Gray],
                Some(Polarity::Clair) => &[Binarization::Light, Binarization::Gray],
                None => &REFINE_BINARIZATIONS,
            };
            for z in ocr_line(engine, png, w, h, &tight, bh, bins, "0123456789:.", "7").await {
                if let Some(v) = clock_from_slot_text(&z.text) {
                    values.push(v);
                }
            }
        }
    }
    if values.is_empty() {
        for z in &zones {
            if let Some(v) = clock_from_zone(z, &clock, w, h) {
                values.push(v);
            }
        }
    }
    if values.is_empty() {
        return None;
    }
    let clock_sec = most_read(&values);

    // Période : place apprise, sinon à gauche du chrono, sinon dessous.
    struct PZone {
        key: &'static str,
        r: Rect,
        relaxed: bool,
        bare: bool,
    }
    let mut pzones: Vec<PZone> = Vec::new();
    if let Some(p) = loc.period {
        pzones.push(PZone {
            key: "appris",
            r: expand(&p, 0.35, 0.25),
            relaxed: true,
            bare: true,
        });
    }
    pzones.push(PZone {
        key: "gauche",
        r: Rect {
            x: clock.x - (4.0 * ch) / w,
            y: clock.y - clock.h * 0.25,
            w: (4.0 * ch) / w - clock.w * 0.05,
            h: clock.h * 1.5,
        },
        relaxed: false,
        bare: true,
    });
    pzones.push(PZone {
        key: "dessous",
        r: Rect {
            x: clock.x - clock.w * 0.15,
            y: clock.y + clock.h * 1.0,
            w: clock.w * 0.7,
            h: clock.h * 1.4,
        },
        relaxed: true,
        bare: false,
    });
    // La case qui a donné la période à l'image précédente est essayée d'abord.
    let hint = *loc.hint.lock().unwrap_or_else(|e| e.into_inner());
    pzones.sort_by_key(|z| std::cmp::Reverse(Some(z.key) == hint));
    let mut period: Option<f64> = None;
    for z in &pzones {
        let Some(r) = clip(&z.r) else { continue };
        for bin in [Binarization::Gray, Binarization::Light] {
            for mut t in ocr_line(
                engine,
                png,
                w,
                h,
                &r,
                ch * 0.55,
                &[bin],
                if z.relaxed { OCR_WHITELIST } else { "" },
                if z.relaxed { "7" } else { "11" },
            )
            .await
            {
                // Zone de gauche : le mot le plus proche du chrono d'abord.
                if !z.relaxed {
                    t.words.sort_by(|a, b| sign(b.x1 - a.x1));
                }
                period = period_from_slot(&t.words, ch, z.relaxed, Some(z.bare));
            }
            if period.is_some() {
                break;
            }
        }
        if period.is_some() {
            *loc.hint.lock().unwrap_or_else(|e| e.into_inner()) = Some(z.key);
            break;
        }
    }

    // Scores : nombres aux emplacements récurrents.
    let mut scores: Vec<f64> = Vec::new();
    for sr in loc.scores.iter().flatten().take(3) {
        let Some(r) = clip(&expand(sr, 0.3, 0.3)) else {
            continue;
        };
        for bin in [Binarization::Light, Binarization::Gray] {
            let lines = ocr_line(engine, png, w, h, &r, sr.h * h, &[bin], "0123456789", "7").await;
            let text = lines.first().map_or("", |l| l.text.as_str());
            let nums: Vec<f64> = match_all(fre!(r"(?<!\d)\d{1,3}(?!\d)"), text)
                .into_iter()
                .map(|(_, m, _)| num(&m))
                .filter(|v| *v <= 199.0)
                .collect();
            if !nums.is_empty() {
                scores.extend(nums);
                break;
            }
        }
    }
    Some(ScoreboardReading {
        period: if period.is_some_and(|p| p > 4.0) && clock_sec > 300.0 {
            None
        } else {
            period
        },
        clock_sec,
        scores,
    })
}

fn clip(r: &Rect) -> Option<Rect> {
    let x0 = js::max(0.0, r.x);
    let y0 = js::max(0.0, r.y);
    let x1 = js::min(1.0, r.x + r.w);
    let y1 = js::min(1.0, r.y + r.h);
    (x1 - x0 > 0.002 && y1 - y0 > 0.002).then_some(Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

/// `readScoreboard` : lit (période, chrono, scores) sur une image — empreinte
/// du bandeau, gabarit, puis repli sur la région entière ; sans localisation,
/// zones de repli en pleine largeur (lecture complète exigée).
pub async fn read_scoreboard(
    engine: &dyn OcrEngine,
    png: &[u8],
    loc: Option<&ScoreboardLocation>,
) -> Option<ScoreboardReading> {
    let (w, h) = png_size(png)?;
    let Some(loc) = loc else {
        for zone in &FALLBACK_ZONES {
            let z = ocr_zone_merged(
                engine,
                png,
                w,
                h,
                zone,
                js::min(4.0, js::max(1.0, 1440.0 / h)),
                &[
                    Binarization::LightHigh,
                    Binarization::Gray,
                    Binarization::Light,
                ],
            )
            .await;
            // Seule une lecture complète (période + chrono) est retenue.
            let r = best_reading(&find_clock_candidates(&z.words, w, h, 0), None, 0.08);
            if r.as_ref()
                .is_some_and(|r| r.period.is_some_and(|p| p != 0.0 && !p.is_nan()))
            {
                return r;
            }
        }
        return None;
    };

    // 0. Le bandeau est-il à l'écran ? (vignette impossible : on tente la lecture)
    if let Some(panel) = &loc.panel {
        if let Ok(thumb) = raw_gray(png, THUMB_W as u32, THUMB_H as u32, None, "").await {
            if panel_presence(&thumb, panel) < PANEL_MIN_PRESENCE {
                return None;
            }
        }
    }

    // 1. Gabarit appris à la localisation.
    if loc.clock.is_some() {
        if let Some(t) = read_template(engine, png, w, h, loc).await {
            return Some(t);
        }
    }

    // 2. Repli : la zone entière, une seule passe avec un gabarit.
    let k = upscale_for(loc.text_h * h);
    let z = ocr_zone_refined(
        engine,
        png,
        w,
        h,
        &loc.rect,
        k,
        None,
        Some(if loc.clock.is_some() { 0 } else { 3 }),
    )
    .await;
    let cands = find_clock_candidates(&z.words, w, h, 0);
    let best = best_candidate(&cands, Some(&loc.core), 0.08);
    let mut clock_word: Option<Bx> = best.map(|b| Bx {
        x0: b.clock_rect.x * w,
        y0: b.clock_rect.y * h,
        x1: (b.clock_rect.x + b.clock_rect.w) * w,
        y1: (b.clock_rect.y + b.clock_rect.h) * h,
    });
    let mut reading: Option<ScoreboardReading> = best.map(|b| ScoreboardReading {
        period: b.period,
        clock_sec: b.clock_sec,
        scores: b.scores.clone(),
    });

    // Chrono sans deux-points, à la place du chrono.
    if reading.is_none() {
        if let Some(lc) = loc.clock {
            for (wi, wd) in z.words.iter().enumerate() {
                if !overlaps(wd, &lc, w, h) {
                    continue;
                }
                let Some(c) = colonless_clock(&wd.text) else {
                    continue;
                };
                let mut all = vec![OcrWord {
                    text: clock_text(c),
                    ..wd.clone()
                }];
                all.extend(
                    z.words
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i != wi)
                        .map(|(_, x)| x.clone()),
                );
                let near = find_clock_candidates(&all, w, h, 0);
                reading = Some(match near.first() {
                    Some(b) => ScoreboardReading {
                        period: b.period,
                        clock_sec: c,
                        scores: b.scores.clone(),
                    },
                    None => ScoreboardReading {
                        period: None,
                        clock_sec: c,
                        scores: Vec::new(),
                    },
                });
                clock_word = Some(bx(wd));
                break;
            }
        }
    }
    let Some(mut reading) = reading else {
        return parse_scoreboard_text(&z.text).map(|p| ScoreboardReading {
            period: p.period,
            clock_sec: p.clock_sec,
            scores: Vec::new(),
        });
    };

    // Période illisible : relecture des petits jetons voisins du chrono.
    if let (None, Some(cw)) = (reading.period, clock_word) {
        let hh = js::max(1.0, cw.y1 - cw.y0);
        let cyc = (cw.y0 + cw.y1) / 2.0;
        let ccx = (cw.x0 + cw.x1) / 2.0;
        let mut near: Vec<&OcrWord> = z
            .words
            .iter()
            .filter(|wd| {
                if wd.x1 <= cw.x0 - 4.0 * hh || wd.x0 >= cw.x1 + 4.0 * hh {
                    return false;
                }
                let wh = wd.y1 - wd.y0;
                if wh < 0.4 * hh || wh > 1.7 * hh {
                    return false;
                }
                if ((wd.y0 + wd.y1) / 2.0 - cyc).abs() > 2.5 * hh {
                    return false;
                }
                // Le chrono lui-même (lu par l'autre binarisation) est exclu.
                let mx = (wd.x0 + wd.x1) / 2.0;
                !(mx >= cw.x0 && mx <= cw.x1 && ((wd.y0 + wd.y1) / 2.0 - cyc).abs() < 0.5 * hh)
            })
            .collect();
        near.sort_by(|a, b| {
            sign(
                js_hypot((a.x0 + a.x1) / 2.0 - ccx, (a.y0 + a.y1) / 2.0 - cyc)
                    - js_hypot((b.x0 + b.x1) / 2.0 - ccx, (b.y0 + b.y1) / 2.0 - cyc),
            )
        });
        let mut tried: Vec<&OcrWord> = Vec::new();
        for wd in near {
            if let Some(direct) = loose_period(&wd.text, None) {
                reading.period = Some(direct);
                break;
            }
            if tried
                .iter()
                .any(|t| (t.x0 - wd.x0).abs() < hh && (t.y0 - wd.y0).abs() < hh)
                || tried.len() >= 3
            {
                continue;
            }
            tried.push(wd);
            let wh = wd.y1 - wd.y0;
            let pad = 0.35 * wh;
            let sub = Rect {
                x: (wd.x0 - pad) / w,
                y: (wd.y0 - pad) / h,
                w: (wd.x1 - wd.x0 + 2.0 * pad) / w,
                h: (wh + 2.0 * pad) / h,
            };
            let params = OcrParams::new("7", OCR_WHITELIST);
            for bin in [Binarization::Gray, Binarization::Light] {
                if let Ok(r) = ocr_zone(
                    engine,
                    png,
                    w,
                    h,
                    &sub,
                    js::min(8.0, js::max(2.0, 46.0 / wh)),
                    bin,
                    &params,
                )
                .await
                {
                    if let Some(p) = loose_period(&r.text, None) {
                        reading.period = Some(p);
                        break;
                    }
                }
            }
            if reading.period.is_some() {
                break;
            }
        }
    }
    Some(reading)
}

/// Lecture (`ScoreboardReading`) en objet de Node.
pub fn reading_json(r: Option<&ScoreboardReading>) -> Value {
    match r {
        None => Value::Null,
        Some(r) => {
            let mut m = Map::new();
            m.insert("period".into(), r.period.map_or(Value::Null, js_num_value));
            m.insert("clock_sec".into(), js_num_value(r.clock_sec));
            m.insert(
                "scores".into(),
                Value::Array(r.scores.iter().map(|n| js_num_value(*n)).collect()),
            );
            Value::Object(m)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hypot_comme_v8() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, -0.0), 0.0);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn jetons_colles() {
        let t = analyze_word("H54ND61Q27:43");
        assert_eq!((t.period, t.clock), (Some(2.0), Some(463.0)));
        assert!(t.numbers.contains(&54.0) && t.numbers.contains(&61.0));
        assert_eq!(analyze_word("H12ND9Q19:12").period, Some(1.0));
        assert_eq!(clock_text(43.0), "0:43");
        assert_eq!(
            crop_filter(
                &Rect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.3,
                    h: 0.1
                },
                1280.0,
                720.0,
                2.5,
                Binarization::Gray
            ),
            "crop=384:72:128:144,scale=960:180:flags=bicubic,format=gray"
        );
    }
}
