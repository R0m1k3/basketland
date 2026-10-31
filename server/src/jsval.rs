//! Valeurs JSON telles que JavaScript les écrirait (`JSON.parse` puis
//! `JSON.stringify`), pour rendre à l'octet près les réponses de Node.

use serde_json::{Map, Value};

/// Clé d'objet qui est un index de tableau (`"0"`, `"12"`) : JavaScript les
/// range en tête, par ordre croissant, avant les autres clés.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// Normalise une valeur lue avec `serde_json` comme la verrait `JSON.parse` :
/// réels entiers écrits sans « .0 », ordre des clés de JavaScript.
pub fn js_normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => crate::api::js_num_value(f),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(js_normalize).collect()),
        Value::Object(o) => {
            let mut idx: Vec<(u32, String, Value)> = Vec::new();
            let mut rest: Vec<(String, Value)> = Vec::new();
            for (k, v) in o {
                match array_index(&k) {
                    Some(i) => idx.push((i, k, js_normalize(v))),
                    None => rest.push((k, js_normalize(v))),
                }
            }
            idx.sort_by_key(|(i, _, _)| *i);
            let mut m = Map::new();
            for (_, k, v) in idx {
                m.insert(k, v);
            }
            for (k, v) in rest {
                m.insert(k, v);
            }
            Value::Object(m)
        }
        other => other,
    }
}

/// Texte JSON → valeur normalisée (`JSON.parse`).
pub fn js_parse(s: &str) -> Option<Value> {
    serde_json::from_str::<Value>(s).ok().map(js_normalize)
}

/// `String(x)` de JavaScript.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => js_number_string(f),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(nombre)` (cas courants : entiers, décimaux).
pub fn js_number_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{}", f as i128)
    } else {
        format!("{f}")
    }
}

/// `a ?? b` sur des valeurs JSON (absent ou null → `b`).
pub fn or_else<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(Value::Null) | None => b,
        x => x,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn comme_json_parse_puis_stringify() {
        let v = js_parse(r#"{"b":1,"2":"x","a":1.0,"10":2.5,"01":3,"0":[1.50,{"z":1,"1":2}]}"#)
            .unwrap();
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"0":[1.5,{"1":2,"z":1}],"2":"x","10":2.5,"b":1,"a":1,"01":3}"#
        );
    }

    #[test]
    fn string_comme_javascript() {
        assert_eq!(js_string(&json!(12)), "12");
        assert_eq!(js_string(&json!(0.5)), "0.5");
        assert_eq!(js_string(&json!(3.0)), "3");
        assert_eq!(js_string(&json!("W3")), "W3");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({})), "[object Object]");
    }
}
