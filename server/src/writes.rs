//! Garde-fous des écritures (équivalents de `isOriginAllowed`,
//! `allowedOrigins` et `readJsonWrite`) : origine contrôlée, Content-Type
//! JSON exigé, corps objet.

use crate::api::error;
use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value};

/// `new URL(x).host` : hôte en minuscules, port omis s'il est celui par défaut.
fn url_host(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw).ok()?;
    let host = u.host_str()?;
    Some(match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    })
}

fn url_hostname(raw: &str) -> Option<String> {
    url::Url::parse(raw).ok()?.host_str().map(str::to_string)
}

/// Origines autorisées (`SYNC_WRITE_ORIGINS`) : une URL complète apporte aussi son hôte et son hôte:port.
pub fn allowed_origins() -> Vec<String> {
    let raw = std::env::var("SYNC_WRITE_ORIGINS").unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    for s in raw.split(',') {
        let v = s.trim();
        if v.is_empty() {
            continue;
        }
        push(v.to_string());
        let lower = v.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            if let (Some(h), Some(n)) = (url_host(v), url_hostname(v)) {
                push(h);
                push(n);
            }
        }
    }
    out
}

/// Origine (hôte:port) de la requête : `Origin`, sinon `Referer`.
pub fn request_origin(h: &HeaderMap) -> Option<String> {
    if let Some(o) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        return Some(url_host(o).unwrap_or_else(|| o.to_string()));
    }
    h.get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .and_then(url_host)
}

/// Même origine que l'hôte servi (`Host`), ou dans la liste blanche ; sans
/// origine (curl, job interne) : accepté seulement si la liste est vide.
pub fn is_origin_allowed(h: &HeaderMap, allowed: &[String]) -> bool {
    let o = request_origin(h);
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok());
    if let (Some(s), Some(o)) = (host, o.as_deref()) {
        if o == s {
            return true;
        }
    }
    let Some(o) = o else {
        return allowed.is_empty();
    };
    if allowed.contains(&o) {
        return true;
    }
    let bare = match o.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h.to_string(),
        _ => o.clone(),
    };
    allowed.contains(&bare)
}

/// `readJsonWrite` : corps JSON objet d'une écriture autorisée, sinon la réponse d'erreur.
pub async fn read_json_write(
    headers: &HeaderMap,
    body: Body,
) -> Result<Map<String, Value>, Response> {
    if !is_origin_allowed(headers, &allowed_origins()) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "origine non autorisée pour cette écriture",
        ));
    }
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let essence = ct.to_ascii_lowercase();
    let essence = essence.split(';').next().unwrap_or("").trim();
    if essence != "application/json" {
        return Err(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type application/json requis",
        ));
    }
    let bytes = axum::body::to_bytes(body, 1 << 20)
        .await
        .map_err(|_| error(StatusCode::BAD_REQUEST, "JSON invalide"))?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(error(StatusCode::BAD_REQUEST, "JSON invalide")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn origines_comme_node() {
        let none: Vec<String> = vec![];
        assert!(is_origin_allowed(
            &h(&[("host", "nas:3012"), ("origin", "http://nas:3012")]),
            &none
        ));
        assert!(is_origin_allowed(
            &h(&[("host", "nas"), ("origin", "http://NAS:80")]),
            &none
        ));
        assert!(!is_origin_allowed(
            &h(&[("host", "nas:3012"), ("origin", "http://evil.example")]),
            &none
        ));
        assert!(is_origin_allowed(&h(&[("host", "nas:3012")]), &none));
        assert!(is_origin_allowed(
            &h(&[
                ("host", "nas:3012"),
                ("referer", "http://nas:3012/matchs/1")
            ]),
            &none
        ));
        let allowed = vec![
            "http://192.168.1.16:3012".to_string(),
            "192.168.1.16:3012".into(),
            "192.168.1.16".into(),
        ];
        assert!(is_origin_allowed(
            &h(&[("host", "x"), ("origin", "http://192.168.1.16:9999")]),
            &allowed
        ));
        assert!(!is_origin_allowed(&h(&[("host", "x")]), &allowed));
    }
}
