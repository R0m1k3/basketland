//! Sémantique JavaScript dont dépendent les portages à l'identique :
//! `Math.round`, `Math.min`/`Math.max`, `Number(x)`, `String(x)`, valeurs
//! « vraies », longueurs et coupes en unités UTF-16, `trim`, et expressions
//! régulières écrites comme en JavaScript (classes `\d`, `\s`, `\w`, `\b` et
//! `.` de JavaScript, pas celles d'Unicode).

use crate::jsval::js_string;
use regex::Regex;
use serde_json::Value;

/// `Math.round` : au plus proche, les demis vers +∞ (`-2.5` → `-2`, `-0.4` → `-0`).
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        r
    }
}

/// `Math.min(a, b)` : NaN contagieux, `-0` plus petit que `+0`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() {
            a
        } else {
            b
        }
    } else if b < a {
        b
    } else {
        a
    }
}

/// `Math.max(a, b)` : NaN contagieux, `+0` plus grand que `-0`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() {
            a
        } else {
            b
        }
    } else if b > a {
        b
    } else {
        a
    }
}

/// `chaîne.length` (unités UTF-16).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `chaîne.slice(0, n)` en unités UTF-16 (une paire coupée devient U+FFFD,
/// comme à l'écriture d'une chaîne JavaScript en UTF-8).
pub fn slice_utf16(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// Blancs de `String.prototype.trim` et de `\s` (WhiteSpace + LineTerminator).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// Valeur « vraie » (`!!x`) ; `None` = `undefined`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number(x)` ; `None` = `undefined` (NaN).
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => crate::api::js_number(s),
        Some(a @ Value::Array(_)) => crate::api::js_number(&js_string(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(x)` ; `None` = `undefined`.
pub fn string_of(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(x) => js_string(x),
    }
}

/// `String(x ?? '')`.
pub fn str_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(x) => js_string(x),
    }
}

/// `x?.clé` : propriété d'un objet, élément d'un tableau (`"0"`, `"1"`…).
pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v? {
        Value::Object(m) => m.get(key),
        Value::Array(a) => {
            if key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit())) {
                key.parse::<usize>().ok().and_then(|i| a.get(i))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Éléments parcourus par `for (const x of v ?? [])` : tableau, ou
/// caractères d'une chaîne ; toute autre valeur est traitée comme vide.
pub fn items(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| Value::from(c.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// Classe `\s` de JavaScript, à insérer dans une classe de caractères.
const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// Expression régulière JavaScript → `regex` de Rust, avec la sémantique de
/// JavaScript pour `\d` `\w` `\s` `\b` (ASCII / blancs de JavaScript) et `.`
/// (tout sauf fin de ligne). Drapeau pris en compte : `i`. Les motifs portés
/// n'emploient ni rétro-références ni assertions avant/arrière.
pub fn regex(src: &str, flags: &str) -> Regex {
    let mut out = String::new();
    if flags.contains('i') {
        out.push_str("(?i)");
    }
    let mut in_class = false;
    let mut chars = src.chars();
    while let Some(c) = chars.next() {
        // `[\s\S]` : tout caractère, fins de ligne comprises.
        if c == '[' && !in_class && chars.as_str().starts_with(r"\s\S]") {
            out.push_str("(?s:.)");
            for _ in 0..5 {
                chars.next();
            }
            continue;
        }
        match c {
            '\\' => {
                let Some(n) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (n, in_class) {
                    ('d', false) => out.push_str("[0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('w', false) => out.push_str("[A-Za-z0-9_]"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('W', false) => out.push_str("[^A-Za-z0-9_]"),
                    ('s', false) => {
                        out.push('[');
                        out.push_str(JS_SPACE_CLASS);
                        out.push(']');
                    }
                    ('s', true) => out.push_str(JS_SPACE_CLASS),
                    ('S', false) => {
                        out.push_str("[^");
                        out.push_str(JS_SPACE_CLASS);
                        out.push(']');
                    }
                    ('b', false) => out.push_str(r"(?-u:\b)"),
                    ('B', false) => out.push_str(r"(?-u:\B)"),
                    (n, _) => {
                        out.push('\\');
                        out.push(n);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '.' if !in_class => out.push_str(r"[^\n\r\u{2028}\u{2029}]"),
            c => out.push(c),
        }
    }
    Regex::new(&out).unwrap_or_else(|e| panic!("expression régulière invalide {src:?} : {e}"))
}

/// Expression régulière JavaScript compilée une fois : `jsre!("motif")`, `jsre!("motif", "i")`.
macro_rules! jsre {
    ($p:expr) => {
        jsre!($p, "")
    };
    ($p:expr, $f:expr) => {{
        static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        R.get_or_init(|| $crate::js::regex($p, $f))
    }};
}
pub(crate) use jsre;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arrondis_comme_math_round() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert!(round(-0.4).is_sign_negative() && round(-0.4) == 0.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(round(1234.565 * 100.0) / 100.0, 1234.57);
        assert!(min(f64::NAN, 1.0).is_nan());
        assert!(max(-0.0, 0.0).is_sign_positive());
        assert!(min(0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn chaines_comme_javascript() {
        assert_eq!(utf16_len("é😀"), 3);
        assert_eq!(slice_utf16("ab😀c", 3), "ab\u{FFFD}");
        assert_eq!(trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(to_number(Some(&json!("12"))), 12.0);
        assert_eq!(to_number(Some(&json!([5]))), 5.0);
        assert!(to_number(Some(&json!({}))).is_nan());
        assert!(to_number(None).is_nan());
        assert_eq!(string_of(None), "undefined");
        assert_eq!(str_or_empty(Some(&json!(13))), "13");
    }

    #[test]
    fn regex_comme_javascript() {
        // `\b` ASCII : « é » n'est pas une lettre pour JavaScript.
        assert!(regex(r"\bmakes\b", "").is_match("émakes"));
        // `\d` ASCII seulement.
        assert!(!regex(r"^\d$", "").is_match("٣"));
        // `.` ne traverse pas une fin de ligne.
        assert!(!regex(r"^a.b$", "").is_match("a\rb"));
        assert!(regex(r"^a\s+b$", "").is_match("a\u{feff}b"));
        assert!(regex(r"^[\p{L}'’.-]+$", "u").is_match("Dončić"));
        assert!(regex("^makes$", "i").is_match("MAKES"));
        assert!(regex(r"^a[\s\S]b$", "").is_match("a\u{85}b"));
    }
}
