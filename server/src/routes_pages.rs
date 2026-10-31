//! `GET /api/pages/…` : données de chaque page (étape 8a, voir
//! [`crate::pages`] et `docs/migration-rust.md`). Toutes exigent une session
//! (`guarded`), sauf `/api/pages/session`, lue par `/login` et `/setup` avant
//! qu'une session existe.
//!
//! Ce que tiennent encore les files de Node (match en cours de traduction,
//! activité, raisons de désactivation de la traduction et du doublage) est lu
//! par un appel interne, `POST /api/internal/page-state` (jeton d'ingestion,
//! jamais relayé depuis l'extérieur), comme `POST /api/internal/replays`.
//! L'étape qui branche les médias en Rust remplacera cet appel par la
//! lecture directe des services Rust ([`fetch_node_state`]).

use crate::api::{error, json_response, ok, Query};
use crate::auth::{self, Session};
use crate::db;
use crate::pages::{self, NodeState, NotFound, PageCtx};
use crate::queries::STANDINGS_KEY;
use crate::routes::{db_error, guarded, guarded_session};
use crate::state::AppState;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;

/// Chemin public (sans session) des données de page : layout, `/login`, `/setup`.
pub const PUBLIC_SESSION_PATH: &str = "/api/pages/session";

/// Appel interne à Node ; jamais relayé depuis l'extérieur (voir `lib.rs`).
pub const NODE_PAGE_STATE_PATH: &str = "/api/internal/page-state";

/// Cookie du mode « scores masqués » (`SPOILER_COOKIE`).
pub const SPOILER_COOKIE: &str = "bl_spoilers";

/// `spoilerMode()`.
pub fn spoiler_mode(headers: &HeaderMap) -> &'static str {
    if auth::cookie(headers, SPOILER_COOKIE).as_deref() == Some("hide") {
        "hide"
    } else {
        "show"
    }
}

fn opt_string(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// État des files de Node (`POST /api/internal/page-state`, jeton
/// d'ingestion) ; `dub` : aussi `await dubDisabledReason()`.
pub async fn fetch_node_state(st: &AppState, dub: bool) -> Result<NodeState, String> {
    let token = tokio::task::spawn_blocking(crate::ingest::ingest_token)
        .await
        .map_err(|e| e.to_string())??;
    let (status, v) = st
        .upstream
        .post_json(
            NODE_PAGE_STATE_PATH,
            &token,
            &json!({ "dub": dub }),
            Duration::from_secs(15),
        )
        .await?;
    if status != 200 {
        return Err(match v.get("error").and_then(Value::as_str) {
            Some(e) => format!("HTTP {status} ({e})"),
            None => format!("HTTP {status}"),
        });
    }
    let v = crate::jsval::js_normalize(v);
    Ok(NodeState {
        running_match_id: v.get("running_match_id").and_then(Value::as_i64),
        activity: v.get("activity").cloned().unwrap_or(Value::Null),
        commentary_disabled_reason: opt_string(&v, "commentary_disabled_reason"),
        dub_disabled_reason: opt_string(&v, "dub_disabled_reason"),
    })
}

fn node_error(e: String) -> Response {
    eprintln!("[serveur] état des files de Node illisible : {e}");
    error(
        StatusCode::BAD_GATEWAY,
        "application Node injoignable (démarrage en cours ?)",
    )
}

fn not_found(nf: NotFound) -> Response {
    json_response(StatusCode::NOT_FOUND, &nf.0)
}

/// Page servie : session exigée, état de Node lu si `needs_node`, puis
/// `build` sur la base.
async fn page<F>(
    st: &AppState,
    uri: &OriginalUri,
    headers: &HeaderMap,
    needs_node: bool,
    build: F,
) -> Response
where
    F: FnOnce(&rusqlite::Connection, &PageCtx) -> pages::PageResult + Send + 'static,
{
    let spoilers = spoiler_mode(headers);
    guarded_session(st, uri, headers, |session| async move {
        let node = if needs_node {
            match fetch_node_state(st, false).await {
                Ok(n) => n,
                Err(e) => return node_error(e),
            }
        } else {
            NodeState::default()
        };
        let now = Utc::now();
        let r = st
            .db
            .run(move |c| {
                let ctx = PageCtx {
                    now,
                    spoilers,
                    session: session.as_ref(),
                    node: &node,
                };
                build(c, &ctx)
            })
            .await;
        match r {
            Ok(Ok(v)) => ok(v),
            Ok(Err(nf)) => not_found(nf),
            Err(e) => db_error(e),
        }
    })
    .await
}

/// `GET /api/pages/session?next=…` (public).
pub async fn session(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    let next = Query::parse(uri.query()).get("next").map(str::to_string);
    let token = auth::cookie(&headers, auth::SESSION_COOKIE);
    let r = st
        .db
        .run(move |c| {
            // Comme le middleware sur /login et /setup : session validée et
            // renouvelée (cookie réémis), mais jamais exigée.
            let s = auth::validate_session(c, token.as_deref(), Utc::now())?;
            let body = pages::session(c, s.as_ref(), next.as_deref())?;
            Ok((s, body))
        })
        .await;
    let (s, body) = match r {
        Ok(x) => x,
        Err(e) => return db_error(e),
    };
    let mut res = ok(body);
    if let Some(s) = s.filter(|s| s.renewed) {
        if let Some(token) = auth::cookie(&headers, auth::SESSION_COOKIE) {
            if let Some(v) =
                auth::session_cookie(&token, &s.expires_at, auth::is_https(&headers), Utc::now())
            {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    res
}

pub async fn home(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    page(&st, &uri, &headers, true, |c, ctx| {
        Ok(Ok(pages::home(c, ctx)?))
    })
    .await
}

pub async fn matchs(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    let q = Query::parse(uri.query());
    let team = q.get("team").map(str::to_string);
    let d = q.get("d").map(str::to_string);
    page(&st, &uri, &headers, true, move |c, ctx| {
        Ok(Ok(pages::matchs(c, ctx, team.as_deref(), d.as_deref())?))
    })
    .await
}

pub async fn match_page(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    // `toDto` seul (pas de `toViews`) : rien à demander à Node.
    page(&st, &uri, &headers, false, move |c, ctx| {
        pages::match_page(c, ctx, &raw)
    })
    .await
}

pub async fn equipes(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    page(&st, &uri, &headers, true, |c, ctx| {
        Ok(Ok(pages::equipes(c, ctx)?))
    })
    .await
}

pub async fn equipe(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    page(&st, &uri, &headers, true, move |c, ctx| {
        pages::equipe(c, ctx, &raw)
    })
    .await
}

/// `loadStandings` de la page Classement : cache de 30 min, sinon ESPN
/// (`fetch`), cache périmé si ESPN échoue, `[]` faute de mieux.
pub async fn load_standings<F, Fut>(
    db: &db::Db,
    now: DateTime<Utc>,
    fetch: F,
) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    if let Some(v) = db
        .run(move |c| db::kv_get_at(c, STANDINGS_KEY, Some(30 * 60_000), now))
        .await?
    {
        return Ok(v);
    }
    let fresh = match fetch().await {
        Ok(v) => {
            let v2 = v.clone();
            db.run(move |c| db::kv_set(c, STANDINGS_KEY, &v2))
                .await
                .map(|_| v)
        }
        Err(e) => Err(e),
    };
    match fresh {
        Ok(v) => Ok(v),
        Err(_) => Ok(db
            .run(move |c| db::kv_get_at(c, STANDINGS_KEY, None, now))
            .await?
            .unwrap_or_else(|| json!([]))),
    }
}

pub async fn classement(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        match load_standings(&st.db, Utc::now(), || crate::espn::fetch_standings("nba")).await {
            Ok(v) => ok(pages::classement(v)),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

pub async fn parametres(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    guarded_session(&st, &uri, &headers, |session| async {
        let Some(session): Option<Session> = session else {
            return error(StatusCode::UNAUTHORIZED, "non connecté");
        };
        let node = if session.role == "admin" {
            match fetch_node_state(&st, true).await {
                Ok(n) => n,
                Err(e) => return node_error(e),
            }
        } else {
            NodeState::default()
        };
        match st
            .db
            .run(move |c| pages::parametres(c, &session, &node))
            .await
        {
            Ok(v) => ok(v),
            Err(e) => db_error(e),
        }
    })
    .await
}
