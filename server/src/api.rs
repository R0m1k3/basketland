//! Outils communs des routes (équivalents de `src/lib/api.ts`).

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

/// Réponse JSON `Cache-Control: no-store`, comme `json()` côté Node.
pub fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut res = (status, axum::Json(body.clone())).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn ok(body: Value) -> Response {
    json_response(StatusCode::OK, &body)
}

pub fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, &json!({ "error": message }))
}

/// Paramètres de requête dans l'ordre ; `get` rend la PREMIÈRE valeur, comme `URLSearchParams.get`.
pub struct Query(Vec<(String, String)>);

impl Query {
    pub fn parse(raw: Option<&str>) -> Self {
        Query(
            form_urlencoded::parse(raw.unwrap_or("").as_bytes())
                .into_owned()
                .collect(),
        )
    }
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    }
}

/// `Number(chaîne)` de JavaScript (décimal, exposant, Infinity, 0x/0o/0b ; vide → 0 ; sinon NaN).
pub fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut n = 0f64;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(d) => n = n * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return n;
        }
    }
    // Décimal strict : [+-] chiffres [. chiffres] [e [+-] chiffres] (Rust accepte aussi « inf », « nan »…).
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// `intParam` : entier borné, valeur par défaut si absent, vide ou non numérique.
pub fn int_param(v: Option<&str>, def: i64, min: i64, max: i64) -> i64 {
    let Some(v) = v else { return def };
    if v.is_empty() {
        return def;
    }
    let n = js_number(v);
    if !n.is_finite() {
        return def;
    }
    (n.trunc() as i64).clamp(min, max)
}

/// Nombre JSON tel que l'écrirait `JSON.stringify` (entier sans « .0 », NaN → null).
pub fn js_num_value(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_comme_javascript() {
        assert_eq!(js_number("12"), 12.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("1e2"), 100.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("-3.7"), -3.7);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert!(js_number("inf").is_nan());
        assert!(js_number("nan").is_nan());
        assert!(js_number("12abc").is_nan());
        assert!(js_number("1e").is_nan());
    }

    #[test]
    fn int_param_comme_node() {
        assert_eq!(int_param(None, 3, 0, 30), 3);
        assert_eq!(int_param(Some(""), 3, 0, 30), 3);
        assert_eq!(int_param(Some("abc"), 3, 0, 30), 3);
        assert_eq!(int_param(Some("99"), 3, 0, 30), 30);
        assert_eq!(int_param(Some("-4"), 3, 0, 30), 0);
        assert_eq!(int_param(Some("7.9"), 3, 0, 30), 7);
        assert_eq!(int_param(Some("Infinity"), 3, 0, 30), 3);
    }

    #[test]
    fn premiere_valeur_comme_urlsearchparams() {
        let q = Query::parse(Some("team=lal&team=bos&x=a%20b&y"));
        assert_eq!(q.get("team"), Some("lal"));
        assert_eq!(q.get("x"), Some("a b"));
        assert_eq!(q.get("y"), Some(""));
        assert_eq!(q.get("z"), None);
    }
}
