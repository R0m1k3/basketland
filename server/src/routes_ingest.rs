//! `POST /api/ingest` (chemin public, jeton propre) : lance des jobs
//! d'ingestion. Les jobs portés tournent en Rust ; `sync-videos` (recherche
//! des replays, encore côté Node) est relayé à Node.

use crate::api::{error, ok};
use crate::ingest;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

const JOBS: [&str; 5] = [
    "sync-schedule",
    "sync-season",
    "sync-stats",
    "sync-videos",
    "sync-subtitles",
];

/// En-tête tel que le voit Node : octets lus en ISO-8859-1.
fn latin1(v: &HeaderValue) -> String {
    v.as_bytes().iter().map(|&b| b as char).collect()
}

/// `sync-videos` exécuté par Node : même jeton, résultat du job repris tel quel.
async fn node_sync_videos(
    st: &AppState,
    host: Option<HeaderValue>,
    auth: Option<HeaderValue>,
) -> Value {
    let mut b = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/ingest")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(h) = host {
        b = b.header(header::HOST, h);
    }
    if let Some(a) = auth {
        b = b.header(header::AUTHORIZATION, a);
    }
    let Ok(req) = b.body(Body::from(r#"{"jobs":["sync-videos"]}"#)) else {
        return json!({ "ok": false, "detail": "requête vers Node invalide" });
    };
    let res = crate::proxy::forward(State(st.clone()), req).await;
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), 4 << 20)
        .await
        .ok()
        .and_then(|b| crate::jsval::js_parse(&String::from_utf8_lossy(&b)));
    match body {
        Some(v) if status.is_success() => v
            .get("results")
            .and_then(|r| r.get("sync-videos"))
            .cloned()
            .unwrap_or_else(
                || json!({ "ok": false, "detail": "réponse de Node sans résultat sync-videos" }),
            ),
        Some(v) => json!({
            "ok": false,
            "detail": v.get("error").and_then(Value::as_str).map(str::to_string)
                .unwrap_or_else(|| format!("application Node : HTTP {}", status.as_u16())),
        }),
        None => {
            json!({ "ok": false, "detail": format!("application Node : HTTP {}", status.as_u16()) })
        }
    }
}

/// Corps `{ "jobs": [...], "season": 2026 }` ; jeton `Authorization: Bearer <INGEST_TOKEN>`.
pub async fn ingest(State(st): State<AppState>, req: Request) -> Response {
    let auth = req.headers().get(header::AUTHORIZATION).cloned();
    let host = req.headers().get(header::HOST).cloned();
    match tokio::task::spawn_blocking({
        let a = auth.as_ref().map(latin1);
        move || ingest::check_ingest_auth(a.as_deref())
    })
    .await
    {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return error(StatusCode::UNAUTHORIZED, "jeton invalide"),
        Ok(Err(e)) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
    // `await req.json()` : corps illisible → {}.
    let body: Value = match axum::body::to_bytes(req.into_body(), 1 << 20).await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    };
    if body.is_null() {
        // `null.jobs` : TypeError côté Node.
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "corps JSON null : objet attendu",
        );
    }
    let defaults = || -> Vec<Value> {
        ["sync-schedule", "sync-stats", "sync-videos"]
            .iter()
            .map(|j| Value::from(*j))
            .collect()
    };
    // `body.jobs?.length ? body.jobs : défaut`
    let jobs: Vec<Value> = match body.get("jobs") {
        Some(Value::Array(a)) if !a.is_empty() => a.clone(),
        Some(Value::String(s)) if !s.is_empty() => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "jobs doit être une liste",
            )
        }
        _ => defaults(),
    };
    let unknown: Vec<String> = jobs
        .iter()
        .filter(|j| !j.as_str().is_some_and(|s| JOBS.contains(&s)))
        .map(|j| crate::js::str_or_empty(Some(j)))
        .collect();
    if !unknown.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            &format!(
                "jobs inconnus: {} (attendus: {})",
                unknown.join(", "),
                JOBS.join(", ")
            ),
        );
    }
    let season = match body.get("season") {
        None | Some(Value::Null) => None,
        v => Some(crate::js::to_number(v)),
    };
    let mut results = Map::new();
    for j in &jobs {
        let name = j.as_str().unwrap_or_default();
        let r = match ingest::run_job(&st.db, name, season).await {
            Some(r) => r.to_json(),
            None => node_sync_videos(&st, host.clone(), auth.clone()).await,
        };
        results.insert(name.to_string(), r);
    }
    let all_ok = results
        .values()
        .all(|r| r.get("ok") != Some(&Value::Bool(false)));
    ok(json!({ "ok": all_ok, "results": results }))
}
