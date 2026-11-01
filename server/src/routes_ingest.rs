//! `POST /api/ingest` (chemin public, jeton propre) : lance des jobs
//! d'ingestion, tous servis par Rust (`sync-videos` compris).

use crate::api::{error, ok};
use crate::ingest;
use crate::state::AppState;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

const JOBS: [&str; 7] = [
    "sync-schedule",
    "sync-season",
    "sync-stats",
    "sync-videos",
    "sync-subtitles",
    "sync-cup",
    "sync-tv-fr",
];

/// En-tête tel que le voit Node : octets lus en ISO-8859-1.
fn latin1(v: &HeaderValue) -> String {
    v.as_bytes().iter().map(|&b| b as char).collect()
}

/// Corps `{ "jobs": [...], "season": 2026 }` ; jeton `Authorization: Bearer <INGEST_TOKEN>`.
pub async fn ingest(State(st): State<AppState>, req: Request) -> Response {
    let auth = req.headers().get(header::AUTHORIZATION).cloned();
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
        let r = match ingest::run_job(&st.db, &st.replays, name, season).await {
            Some(r) => r.to_json(),
            None => json!({ "ok": false, "detail": format!("job inconnu : {name}") }),
        };
        results.insert(name.to_string(), r);
    }
    let all_ok = results
        .values()
        .all(|r| r.get("ok") != Some(&Value::Bool(false)));
    ok(json!({ "ok": all_ok, "results": results }))
}
