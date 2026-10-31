//! Texte et calage des répliques (fonctions pures de `dub.ts`) : moments
//! forts, place et accélération d'une réplique, positions, plages de
//! parole, empreinte des sous-titres d'un tronçon, phrases dites d'une
//! traite ; et les petites pièces JavaScript dont elles dépendent
//! (`toFixed`, `JSON.stringify` des nombres, `envNum`).

use crate::commentary_db::CommentaryCueRow;
use crate::js::{self, jsre};
use serde_json::Value;
use sha1::{Digest, Sha1};

/// `envNum` : nombre fini de la variable, sinon `def` (absente ou vide : `def`).
pub fn env_num(name: &str, def: f64) -> f64 {
    match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => {
            let n = crate::api::js_number(&raw);
            if n.is_finite() {
                n
            } else {
                def
            }
        }
        _ => def,
    }
}

/// `x.toFixed(digits)` de JavaScript (développement décimal exact, égalité
/// arrondie vers le haut ; NaN : « NaN » ; |x| ≥ 1e21 : `String(x)`).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 {
        return crate::jsval::js_number_string(x);
    }
    let neg = x < 0.0;
    // f64 : au plus 1 074 décimales, ce développement est exact.
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_v: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = digits_v.len();
        loop {
            if i == 0 {
                digits_v.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_v[i] == b'9' {
                digits_v[i] = b'0';
            } else {
                digits_v[i] += 1;
                break;
            }
        }
    }
    let split = digits_v.len() - digits;
    let mut s = String::from_utf8(digits_v[..split].to_vec()).unwrap_or_default();
    if digits > 0 {
        s.push('.');
        s.push_str(std::str::from_utf8(&digits_v[split..]).unwrap_or_default());
    }
    if neg {
        format!("-{s}")
    } else {
        s
    }
}

/// `Number.prototype.toString()` (base 10), notation exponentielle comprise.
pub fn js_num_str(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f == 0.0 {
        return "0".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f < 0.0 {
        return format!("-{}", js_num_str(-f));
    }
    // Chiffres les plus courts (comme JavaScript) : « d.ddde±x ».
    let e = format!("{f:e}");
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { "-" } else { "+" };
        let rest = if k > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!("{}{rest}e{sign}{}", &digits[..1], (n - 1).abs())
    }
}

/// `JSON.stringify` d'une valeur (nombres écrits comme JavaScript).
pub fn js_json(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Number(x) => match x.as_f64() {
            Some(f) if x.is_f64() => {
                if f.is_finite() {
                    out.push_str(&js_num_str(f));
                } else {
                    out.push_str("null");
                }
            }
            _ => out.push_str(&x.to_string()),
        },
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::from(k.as_str()).to_string());
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Nombre JSON (`NaN`, ±∞ → `null` comme `JSON.stringify`).
pub(crate) fn num(x: f64) -> Value {
    crate::api::js_num_value(x)
}

// ---------------------------------------------------------------- texte

fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(js::is_space)
}

/// `emphasize` : moment fort (emphasis 2) : une réplique qui ne finit pas
/// par « ! », « ? » ou « … » finit par « ! » (un point, une virgule ou
/// deux-points final est remplacé).
pub fn emphasize(text: &str, emphasis: Option<f64>) -> String {
    let t = js::trim(text);
    if emphasis != Some(2.0) || t.is_empty() {
        return t.to_string();
    }
    if jsre!(r#"(?:[!?…]|\.\.\.)[\s"'»”’)\]]*$"#).is_match(t) {
        return t.to_string();
    }
    if let Some(c) = jsre!(r#"[.,;:]+([\s"'»”’)\]]*)$"#).captures(t) {
        let m = c.get(0).map_or(t.len(), |m| m.start());
        let tail = c.get(1).map_or("", |g| g.as_str());
        return trim_end_js(&format!("{} !{tail}", &t[..m])).to_string();
    }
    format!("{t} !")
}

/// Place d'une réplique (`CueFit`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CueFit {
    /// Place disponible (s) à partir du début du sous-titre.
    pub slot: f64,
    /// Accélération appliquée (1 = aucune).
    pub tempo: f64,
    /// Durée après accélération (s).
    pub fitted: f64,
    /// Encore trop long après accélération maximale : déborde.
    pub overrun: bool,
}

/// Accélération maximale d'une réplique trop longue pour sa place.
pub const MAX_TEMPO: f64 = 1.35;
/// Une réplique peut déborder de 0,6 s après la fin du sous-titre.
pub const SLOT_TAIL_SEC: f64 = 0.6;
/// Écart minimal entre deux répliques doublées (s).
pub const CLIP_GAP_SEC: f64 = 0.05;
/// Fréquence d'échantillonnage des pistes doublées.
pub const DUB_SAMPLE_RATE: u32 = 24_000;

/// `fitCue` : place jusqu'au début du sous-titre suivant, au plus 0,6 s
/// après la fin du sien ; trop longue : accélérée (au plus ×1,35) ; au-delà, elle déborde.
pub fn fit_cue(duration: f64, start: f64, end: f64, next_start: Option<f64>) -> CueFit {
    let next = next_start.filter(|n| *n > start).unwrap_or(f64::INFINITY);
    let limit = js::min(next, end + SLOT_TAIL_SEC);
    let slot = js::max(0.2, js::round((limit - start) * 1000.0) / 1000.0);
    let tempo = if duration > slot {
        js::min(duration / slot, MAX_TEMPO)
    } else {
        1.0
    };
    let t = js::round(tempo * 1000.0) / 1000.0;
    let fitted = duration / t;
    CueFit {
        slot,
        tempo: t,
        fitted,
        overrun: fitted > slot + 0.01,
    }
}

/// `placeClips` : position de chaque réplique (s) : au début de son
/// sous-titre, ou juste après la précédente si celle-ci déborde.
pub fn place_clips(clips: &[(f64, f64)], gap: Option<f64>) -> Vec<f64> {
    let gap = gap.unwrap_or(CLIP_GAP_SEC);
    let mut prev_end = f64::NEG_INFINITY;
    clips
        .iter()
        .map(|&(start, fitted)| {
            let at = js::round(js::max(start, prev_end + gap) * 1000.0) / 1000.0;
            prev_end = at + fitted;
            at
        })
        .collect()
}

/// `speechRanges` : plages de parole fusionnées (écart ≤ `gap`, 0,25 s), arrondies au centième.
pub fn speech_ranges(ranges: &[[f64; 2]], gap: Option<f64>) -> Vec<[f64; 2]> {
    let gap = gap.unwrap_or(0.25);
    let mut sorted = ranges.to_vec();
    sorted.sort_by(|x, y| {
        (x[0] - y[0])
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out: Vec<[f64; 2]> = Vec::new();
    for [a, b] in sorted {
        match out.last_mut() {
            Some(last) if a <= last[1] + gap => last[1] = js::max(last[1], b),
            _ => out.push([a, b]),
        }
    }
    let r2 = |x: f64| js::round(x * 100.0) / 100.0;
    out.into_iter().map(|[a, b]| [r2(a), r2(b)]).collect()
}

/// `cuesSignature` : empreinte des sous-titres d'un tronçon (un tronçon retraduit est redoublé).
pub fn cues_signature(cues: &[CommentaryCueRow]) -> String {
    let mut h = Sha1::new();
    for c in cues {
        let v = Value::Array(vec![
            Value::from(c.seq),
            num(c.start_ts),
            num(c.end_ts),
            Value::from(c.text_fr.as_str()),
            Value::from(c.untranslated),
            Value::from(c.emphasis),
        ]);
        h.update(js_json(&v).as_bytes());
    }
    hex::encode(h.finalize())[..16].to_string()
}

/// Réplique dite d'une seule traite (`CueGroup`).
#[derive(Debug, Clone, PartialEq)]
pub struct CueGroup {
    /// Indices (dans le tronçon) des sous-titres dits d'une traite.
    pub idx: Vec<usize>,
    pub text: String,
    pub start: f64,
    pub end: f64,
    /// Emphase la plus forte du groupe.
    pub emphasis: f64,
}

/// `groupCues` : morceaux consécutifs d'une même phrase — même locuteur,
/// pas de ponctuation finale, écart ≤ `max_gap` (0,8 s) — réunis jusqu'à
/// `max_sec` (12 s). Sous-titres non traduits ou vides : ignorés (et ils
/// coupent le groupe). `speakers[i]` absent : jamais réuni.
pub fn group_cues(
    cues: &[CommentaryCueRow],
    speakers: &[Option<i64>],
    max_sec: Option<f64>,
    max_gap: Option<f64>,
) -> Vec<CueGroup> {
    let max_sec = max_sec.unwrap_or(12.0);
    let max_gap = max_gap.unwrap_or(0.8);
    let mut groups: Vec<CueGroup> = Vec::new();
    let mut cur: Option<usize> = None;
    let mut cur_speaker: Option<i64> = None;
    for (i, c) in cues.iter().enumerate() {
        let text = js::trim(&c.text_fr);
        if c.untranslated != 0 || text.is_empty() {
            cur = None;
            continue;
        }
        let joinable = cur.is_some_and(|g| {
            let g = &groups[g];
            speakers.get(i).copied() == Some(cur_speaker)
                && !jsre!(r#"[.!?…:;]["'»”’)\]\s]*$"#).is_match(&g.text)
                && c.start_ts - g.end <= max_gap
                && c.end_ts - g.start <= max_sec
        });
        match cur {
            Some(g) if joinable => {
                let g = &mut groups[g];
                g.idx.push(i);
                g.text = format!("{} {text}", g.text);
                g.end = c.end_ts;
                g.emphasis = js::max(g.emphasis, c.emphasis as f64);
            }
            _ => {
                groups.push(CueGroup {
                    idx: vec![i],
                    text: text.to_string(),
                    start: c.start_ts,
                    end: c.end_ts,
                    emphasis: c.emphasis as f64,
                });
                cur = Some(groups.len() - 1);
                cur_speaker = speakers.get(i).copied().flatten();
            }
        }
    }
    groups
}

/// `nextDubChunk` : prochain tronçon à doubler : celui de la position visée
/// (`keep_to` > `target`) ou le suivant, sinon le premier. `todo` : (keep_from, keep_to).
pub fn next_dub_chunk(todo: &[(f64, f64)], target: f64) -> Option<usize> {
    todo.iter()
        .position(|(_, keep_to)| *keep_to > target)
        .or(if todo.is_empty() { None } else { Some(0) })
}

/// `downloadText` : téléchargement des modèles de voix, en clair (« 42 % · 1,1 / 2,5 Go »).
pub fn download_text(done: f64, total: f64) -> String {
    let go = |b: f64| to_fixed(b / 1e9, 1).replace('.', ",");
    let amount = if total > 0.0 {
        format!(
            "{} % · {} / {} Go",
            crate::jsval::js_number_string(js::min(99.0, (done * 100.0 / total).floor())),
            go(done),
            go(total)
        )
    } else {
        format!("{} Go", go(done))
    };
    format!("téléchargement des voix (premier usage, une seule fois) : {amount}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_comme_javascript() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(9.9996, 3), "10.000");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(4.0, 3), "4.000");
        assert_eq!(to_fixed(f64::NAN, 1), "NaN");
    }

    #[test]
    fn nombres_comme_javascript() {
        for (x, s) in [
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (0.00001, "0.00001"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (-2.5, "-2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(js_num_str(x), s, "{x}");
        }
    }
}
