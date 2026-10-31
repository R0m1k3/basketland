//! `GET /api/pages/…` : données de chaque page (étape 8a, voir
//! [`crate::pages`] et `docs/migration-rust.md`). Toutes exigent une session
//! (`guarded`), sauf `/api/pages/session`, lue par `/login` et `/setup` avant
//! qu'une session existe.
//!
//! L'état des files médias (match en cours de traduction, activité, raisons
//! de désactivation de la traduction et du doublage) est lu dans les services
//! du processus ([`media_state`]).

use crate::api::{error, json_response, ok, Query};
use crate::auth::{self, Session};
use crate::db;
use crate::pages::{self, MediaState, NotFound, PageCtx};
use crate::queries::STANDINGS_KEY;
use crate::routes::{db_error, guarded, guarded_session};
use crate::state::AppState;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::future::Future;

/// Chemin public (sans session) des données de page : layout, `/login`, `/setup`.
pub const PUBLIC_SESSION_PATH: &str = "/api/pages/session";

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

/// État des files médias pour les pages ; `dub` : aussi `dubDisabledReason()`
/// (charge le moteur de voix : page Paramètres d'un administrateur seule).
pub async fn media_state(st: &AppState, dub: bool) -> Result<MediaState, String> {
    let (db, media) = (st.db.clone(), st.media.clone());
    tokio::task::spawn_blocking(move || {
        let activity = db.with(|c| crate::activity::current_activity(c, &media))?;
        Ok(MediaState {
            running_match_id: media.commentary.running_match_id(),
            activity,
            commentary_disabled_reason: media.commentary.disabled_reason(),
            dub_disabled_reason: if dub {
                media.dub.disabled_reason()
            } else {
                None
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn not_found(nf: NotFound) -> Response {
    json_response(StatusCode::NOT_FOUND, &nf.0)
}

/// Page servie : session exigée, état des files lu si `needs_media`, puis
/// `build` sur la base.
async fn page<F>(
    st: &AppState,
    uri: &OriginalUri,
    headers: &HeaderMap,
    needs_media: bool,
    build: F,
) -> Response
where
    F: FnOnce(&rusqlite::Connection, &PageCtx) -> pages::PageResult + Send + 'static,
{
    let spoilers = spoiler_mode(headers);
    guarded_session(st, uri, headers, |session| async move {
        let media = if needs_media {
            match media_state(st, false).await {
                Ok(n) => n,
                Err(e) => return db_error(e),
            }
        } else {
            MediaState::default()
        };
        let now = Utc::now();
        let r = st
            .db
            .run(move |c| {
                let ctx = PageCtx {
                    now,
                    spoilers,
                    session: session.as_ref(),
                    media: &media,
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
    // `toDto` seul (pas de `toViews`) : l'état des files n'est pas lu.
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
        let media = if session.role == "admin" {
            match media_state(&st, true).await {
                Ok(n) => n,
                Err(e) => return db_error(e),
            }
        } else {
            MediaState::default()
        };
        match st
            .db
            .run(move |c| pages::parametres(c, &session, &media))
            .await
        {
            Ok(v) => ok(v),
            Err(e) => db_error(e),
        }
    })
    .await
}
