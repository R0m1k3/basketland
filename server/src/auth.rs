//! Sessions et règles d'accès des routes servies par Rust (mêmes règles que
//! `src/middleware.ts`, `src/lib/authRoutes.ts` et `src/lib/auth.ts`). Les
//! routes relayées à Node y sont toujours contrôlées par son middleware.

use crate::db::{self, Db};
use crate::time::iso_utc;
use axum::http::{header, HeaderMap, HeaderValue};
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};

pub const SESSION_COOKIE: &str = "bl_session";
pub const SESSION_TTL_MS: i64 = 30 * 24 * 3_600_000;
/// La date d'expiration n'est réécrite qu'une fois par jour au plus.
pub const SESSION_RENEW_AFTER_MS: i64 = 24 * 3_600_000;

const PUBLIC_EXACT: [&str; 5] = [
    "/api/health",
    "/api/ingest",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/auth/logout",
];
const PUBLIC_PREFIXES: [&str; 2] = ["/_next/", "/__nextjs"];
const ROOT_STATIC_EXT: [&str; 13] = [
    "ico",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "avif",
    "txt",
    "xml",
    "webmanifest",
    "woff",
    "woff2",
];

fn normalize(p: &str) -> &str {
    if p.len() > 1 && p.ends_with('/') {
        let t = p.trim_end_matches('/');
        if t.is_empty() {
            "/"
        } else {
            t
        }
    } else {
        p
    }
}

/// Fichier statique à la racine (`/favicon.ico`, `/icon.svg`…).
fn root_static(p: &str) -> bool {
    let Some(name) = p.strip_prefix('/') else {
        return false;
    };
    if name.is_empty() || name.contains('/') {
        return false;
    }
    match name.rsplit_once('.') {
        Some((base, ext)) if !base.is_empty() => {
            ROOT_STATIC_EXT.iter().any(|e| e.eq_ignore_ascii_case(ext))
        }
        _ => false,
    }
}

pub fn is_public_path(pathname: &str) -> bool {
    let p = normalize(pathname);
    PUBLIC_EXACT.contains(&p) || PUBLIC_PREFIXES.iter().any(|x| p.starts_with(x)) || root_static(p)
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[derive(Debug, Clone)]
pub struct Session {
    pub user_id: i64,
    pub username: String,
    pub role: String,
    pub expires_at: String,
    /// Expiration repoussée : le cookie est à renvoyer.
    pub renewed: bool,
}

/// `validateSession` : session valide (renouvelée au besoin), sinon `None`.
pub fn validate_session(
    c: &rusqlite::Connection,
    token: Option<&str>,
    now: DateTime<Utc>,
) -> rusqlite::Result<Option<Session>> {
    let Some(token) = token.filter(|t| !t.is_empty() && t.len() <= 128) else {
        return Ok(None);
    };
    let h = hash_token(token);
    let Some(s) = db::session_with_user(c, &h)? else {
        return Ok(None);
    };
    let exp = crate::time::parse_instant(&s.expires_at);
    let Some(exp) = exp.filter(|e| *e > now) else {
        db::delete_session(c, &h)?;
        return Ok(None);
    };
    let mut expires_at = s.expires_at.clone();
    let mut renewed = false;
    if (exp - now).num_milliseconds() < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS {
        expires_at = iso_utc(now + Duration::milliseconds(SESSION_TTL_MS));
        db::extend_session(c, &h, &expires_at)?;
        renewed = true;
    }
    Ok(Some(Session {
        user_id: s.user_id,
        username: s.username,
        role: s.role,
        expires_at,
        renewed,
    }))
}

/// Valeur d'un cookie de l'en-tête `Cookie` (décodée comme le fait Next).
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for h in headers.get_all(header::COOKIE) {
        let Ok(s) = h.to_str() else { continue };
        for part in s.split(';') {
            let Some((k, v)) = part.split_once('=') else {
                continue;
            };
            if k.trim() == name {
                let v = v.trim();
                let v = v
                    .strip_prefix('"')
                    .and_then(|x| x.strip_suffix('"'))
                    .unwrap_or(v);
                return Some(
                    percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .into_owned(),
                );
            }
        }
    }
    None
}

/// `isHttps` : `X-Forwarded-Proto` d'abord (proxy inverse), sinon la connexion (HTTP ici).
pub fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// En-tête `Set-Cookie` du renouvellement glissant (comme `setSessionCookie`).
pub fn session_cookie(
    token: &str,
    expires_at: &str,
    https: bool,
    now: DateTime<Utc>,
) -> Option<HeaderValue> {
    let exp = crate::time::parse_instant(expires_at)?;
    let max_age = ((exp - now).num_milliseconds() / 1000).max(0);
    let enc = percent_encoding::utf8_percent_encode(token, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    // Jeton base64url : les caractères - et _ n'ont pas besoin d'être encodés.
    let enc = enc.replace("%2D", "-").replace("%5F", "_");
    let mut v = format!(
        "{SESSION_COOKIE}={enc}; Path=/; Expires={}; Max-Age={max_age}; HttpOnly; SameSite=lax",
        exp.format("%a, %d %b %Y %H:%M:%S GMT")
    );
    if https {
        v.push_str("; Secure");
    }
    HeaderValue::from_str(&v).ok()
}

/// Contrôle d'accès d'une route d'API servie par Rust.
pub enum Access {
    Allowed(Option<Session>),
    Unauthorized,
}

pub async fn check_api(db: &Db, path: &str, headers: &HeaderMap) -> Result<Access, String> {
    if is_public_path(path) {
        return Ok(Access::Allowed(None));
    }
    let token = cookie(headers, SESSION_COOKIE);
    let s = db
        .run(move |c| validate_session(c, token.as_deref(), Utc::now()))
        .await?;
    Ok(match s {
        Some(s) => Access::Allowed(Some(s)),
        None => Access::Unauthorized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chemins_publics_comme_authroutes() {
        for p in [
            "/api/health",
            "/api/health/",
            "/api/ingest",
            "/api/auth/login",
            "/_next/static/x.js",
            "/favicon.ico",
            "/icon.SVG",
        ] {
            assert!(is_public_path(p), "{p}");
        }
        for p in [
            "/api/matches",
            "/api/schedule",
            "/",
            "/matchs/1",
            "/a/b.png",
            "/.png",
            "/api/healthz",
        ] {
            assert!(!is_public_path(p), "{p}");
        }
    }

    #[test]
    fn hachage_du_jeton_comme_node() {
        // crypto.createHash('sha256').update('abc').digest('hex')
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn lecture_du_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; bl_session=AbC-_9%3D; b=2"),
        );
        assert_eq!(cookie(&h, SESSION_COOKIE).as_deref(), Some("AbC-_9="));
        assert_eq!(cookie(&h, "zz"), None);
    }
}
