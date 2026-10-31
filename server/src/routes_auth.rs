//! Routes des comptes : connexion, déconnexion, premier compte, mot de passe,
//! administration des utilisateurs.

use crate::accounts::{self, Fail, LoggedIn};
use crate::api::{error, json_response};
use crate::auth::{self, Session};
use crate::routes::{db_error, guarded};
use crate::state::AppState;
use crate::writes::read_json_write;
use axum::extract::{OriginalUri, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use chrono::Utc;
use serde_json::{json, Map, Value};

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn fail_response((code, msg): Fail) -> Response {
    error(status(code), &msg)
}

/// `clientIp` : premier `X-Forwarded-For`, sinon `X-Real-IP`, sinon « inconnue ».
fn client_ip(h: &HeaderMap) -> String {
    let get = |n: &str| {
        h.get(n)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    h.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| get("x-real-ip"))
        .unwrap_or_else(|| "inconnue".into())
}

/// `safeNextPath` : destination après connexion, chemin relatif du même site seulement.
pub fn safe_next_path(raw: Option<&str>) -> String {
    let Some(raw) = raw else { return "/".into() };
    if !raw.starts_with('/')
        || raw.starts_with("//")
        || raw.contains('\\')
        || raw.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
    {
        return "/".into();
    }
    let Ok(base) = url::Url::parse("http://basketland.invalid") else {
        return "/".into();
    };
    let Ok(u) = base.join(raw) else {
        return "/".into();
    };
    if u.origin() != base.origin() {
        return "/".into();
    }
    let path = u.path();
    let norm = if path.len() > 1 && path.ends_with('/') {
        let t = path.trim_end_matches('/');
        if t.is_empty() {
            "/"
        } else {
            t
        }
    } else {
        path
    };
    if norm == "/login" || norm == "/setup" || norm == "/api" || norm.starts_with("/api/") {
        return "/".into();
    }
    let mut out = path.to_string();
    if let Some(q) = u.query() {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = u.fragment() {
        out.push('#');
        out.push_str(f);
    }
    out
}

fn with_session_cookie(
    mut res: Response,
    headers: &HeaderMap,
    s: &accounts::NewSession,
) -> Response {
    if let Some(v) =
        auth::session_cookie(&s.token, &s.expires_at, auth::is_https(headers), Utc::now())
    {
        res.headers_mut().append(header::SET_COOKIE, v);
    }
    res
}

/// Session de la requête (sans renouvellement), avec l'empreinte de son jeton.
async fn require_user(st: &AppState, headers: &HeaderMap) -> Result<(Session, String), Response> {
    let token = auth::cookie(headers, auth::SESSION_COOKIE);
    let t2 = token.clone();
    let s = st
        .db
        .run(move |c| {
            // renew: false — le middleware (garde) a déjà renouvelé si besoin.
            auth::validate_session_opts(c, t2.as_deref(), Utc::now(), false)
        })
        .await
        .map_err(db_error)?;
    match (s, token) {
        (Some(s), Some(t)) => Ok((s, auth::hash_token(&t))),
        _ => Err(error(StatusCode::UNAUTHORIZED, "non connecté")),
    }
}

pub(crate) async fn require_admin(
    st: &AppState,
    headers: &HeaderMap,
) -> Result<(Session, String), Response> {
    let (s, h) = require_user(st, headers).await?;
    if s.role == "admin" {
        Ok((s, h))
    } else {
        Err(error(StatusCode::FORBIDDEN, "réservé aux administrateurs"))
    }
}

fn get(body: &Map<String, Value>, k: &str) -> Option<Value> {
    body.get(k).cloned()
}

// ---------------------------------------------------------------- /api/auth/*

/// `POST /api/auth/login { username, password, next? }` → `{ ok, user, next }` + cookie.
pub async fn login(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let body = match read_json_write(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let ip = client_ip(&parts.headers);
    let (u, p) = (get(&body, "username"), get(&body, "password"));
    let next = safe_next_path(body.get("next").and_then(Value::as_str));
    let r = st
        .db
        .run_own(move |c| accounts::login(c, u.as_ref(), p.as_ref(), &ip))
        .await;
    match r {
        Ok(Ok(LoggedIn { user, session })) => with_session_cookie(
            json_response(
                StatusCode::OK,
                &json!({ "ok": true, "user": user, "next": next }),
            ),
            &parts.headers,
            &session,
        ),
        Ok(Err(f)) => fail_response(f),
        Err(e) => db_error(e),
    }
}

/// `POST /api/auth/setup { username, password, confirm }` : premier administrateur, connecté.
pub async fn setup(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let body = match read_json_write(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let (u, p, cf) = (
        get(&body, "username"),
        get(&body, "password"),
        get(&body, "confirm"),
    );
    match st
        .db
        .run_own(move |c| accounts::setup_first_admin(c, u.as_ref(), p.as_ref(), cf.as_ref()))
        .await
    {
        Ok(Ok(LoggedIn { user, session })) => with_session_cookie(
            json_response(StatusCode::OK, &json!({ "ok": true, "user": user })),
            &parts.headers,
            &session,
        ),
        Ok(Err(f)) => fail_response(f),
        Err(e) => db_error(e),
    }
}

/// `POST /api/auth/logout` : session supprimée, cookie effacé (origine contrôlée).
pub async fn logout(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    if let Err(r) = read_json_write(&parts.headers, body).await {
        return r;
    }
    if let Some(t) = auth::cookie(&parts.headers, auth::SESSION_COOKIE).filter(|t| !t.is_empty()) {
        let h = auth::hash_token(&t);
        if let Err(e) = st.db.run(move |c| crate::db::delete_session(c, &h)).await {
            return db_error(e);
        }
    }
    let mut res = json_response(StatusCode::OK, &json!({ "ok": true }));
    res.headers_mut().append(
        header::SET_COOKIE,
        auth::clear_session_cookie(auth::is_https(&parts.headers)),
    );
    res
}

// ---------------------------------------------------------------- compte courant

/// `POST /api/account/password { current, password, confirm }` : autres sessions révoquées.
pub async fn account_password(
    State(st): State<AppState>,
    uri: OriginalUri,
    req: Request,
) -> Response {
    let headers = req.headers().clone();
    let st2 = st.clone();
    let fut = async move {
        let (parts, body) = req.into_parts();
        let (s, h) = match require_user(&st2, &parts.headers).await {
            Ok(x) => x,
            Err(r) => return r,
        };
        let body = match read_json_write(&parts.headers, body).await {
            Ok(b) => b,
            Err(r) => return r,
        };
        let (cur, pw, cf) = (
            get(&body, "current"),
            get(&body, "password"),
            get(&body, "confirm"),
        );
        match st2
            .db
            .run_own(move |c| {
                accounts::change_own_password(
                    c,
                    s.user_id,
                    &h,
                    cur.as_ref(),
                    pw.as_ref(),
                    cf.as_ref(),
                )
            })
            .await
        {
            Ok(Ok(())) => json_response(StatusCode::OK, &json!({ "ok": true })),
            Ok(Err(f)) => fail_response(f),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

// ---------------------------------------------------------------- /api/admin/users

pub async fn users_list(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        if let Err(r) = require_admin(&st, &headers).await {
            return r;
        }
        match st.db.run(accounts::list_users).await {
            Ok(users) => json_response(StatusCode::OK, &json!({ "users": users })),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `POST /api/admin/users` : create, delete, reset-password, set-role.
pub async fn users_post(State(st): State<AppState>, uri: OriginalUri, req: Request) -> Response {
    let headers = req.headers().clone();
    let st2 = st.clone();
    let fut = async move {
        let (parts, body) = req.into_parts();
        let (s, token_hash) = match require_admin(&st2, &parts.headers).await {
            Ok(x) => x,
            Err(r) => return r,
        };
        let body = match read_json_write(&parts.headers, body).await {
            Ok(b) => b,
            Err(r) => return r,
        };
        let action = body
            .get("action")
            .and_then(Value::as_str)
            .map(str::to_string);
        if action.as_deref() == Some("create") {
            let (u, p, role) = (
                get(&body, "username"),
                get(&body, "password"),
                get(&body, "role"),
            );
            let r = st2
                .db
                .run_own(move |c| {
                    Ok(
                        match accounts::create_user(c, u.as_ref(), p.as_ref(), role.as_ref())? {
                            Ok(id) => Ok((id, accounts::list_users(c)?)),
                            Err(f) => Err(f),
                        },
                    )
                })
                .await;
            return match r {
                Ok(Ok((id, users))) => json_response(
                    StatusCode::CREATED,
                    &json!({ "ok": true, "id": id, "users": users }),
                ),
                Ok(Err(f)) => fail_response(f),
                Err(e) => db_error(e),
            };
        }
        // typeof id === 'number' && Number.isInteger(id) && id > 0
        let id = body
            .get("id")
            .and_then(Value::as_f64)
            .filter(|n| n.fract() == 0.0 && *n > 0.0 && n.is_finite());
        let Some(id) = id else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        let id = if id > i64::MAX as f64 {
            i64::MAX
        } else {
            id as i64
        };
        let (pw, role) = (get(&body, "password"), get(&body, "role"));
        let actor = s.user_id;
        let r = st2
            .db
            .run_own(move |c| {
                let r = match action.as_deref() {
                    Some("delete") => accounts::delete_user(c, actor, id)?,
                    Some("reset-password") => {
                        accounts::reset_user_password(c, actor, &token_hash, id, pw.as_ref())?
                    }
                    Some("set-role") => accounts::set_user_role(c, id, role.as_ref())?,
                    _ => return Ok(None),
                };
                Ok(Some(match r {
                    Ok(()) => Ok(accounts::list_users(c)?),
                    Err(f) => Err(f),
                }))
            })
            .await;
        match r {
            Ok(Some(Ok(users))) => {
                json_response(StatusCode::OK, &json!({ "ok": true, "users": users }))
            }
            Ok(Some(Err(f))) => fail_response(f),
            Ok(None) => error(
                StatusCode::BAD_REQUEST,
                "action invalide (attendu : 'create', 'delete', 'reset-password' ou 'set-role')",
            ),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

#[cfg(test)]
mod tests {
    use super::safe_next_path;

    #[test]
    fn destination_comme_safenextpath() {
        assert_eq!(safe_next_path(Some("/matchs/3?t=1#x")), "/matchs/3?t=1#x");
        assert_eq!(safe_next_path(Some("/a b")), "/a%20b");
        assert_eq!(safe_next_path(Some("/../matchs")), "/matchs");
        for bad in [
            "//evil.example",
            "https://evil.example",
            "/\\evil",
            "/login",
            "/setup/",
            "/api/matches",
            "matchs",
            "/x\ty",
        ] {
            assert_eq!(safe_next_path(Some(bad)), "/", "{bad}");
        }
        assert_eq!(safe_next_path(None), "/");
    }
}
