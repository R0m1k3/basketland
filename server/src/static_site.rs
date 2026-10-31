//! Interface servie par Rust (étape 8b) : fichiers de l'export statique de
//! Next (`next build` avec `output: 'export'`, dossier `out/`, chemin donné
//! par `BL_STATIC_DIR`), derrière les mêmes règles d'accès que l'ancien
//! middleware de Node (`decideAccess` de `src/lib/authRoutes.ts`) :
//! page protégée sans session → `/login?next=…` (ou `/setup` sans aucun
//! compte), `/setup` une fois un compte créé → `/login` (ou l'accueil),
//! `/login` déjà connecté → la destination `next` ; renouvellement glissant
//! du cookie de session.
//!
//! Résolution d'un chemin `/a/b` dans `out/` : le fichier exact
//! (`_next/…`, icônes, `matchs.txt`…), sinon `a/b.html`, sinon
//! `a/b/index.html`, sinon la page de remplacement d'une route dynamique
//! (`a/_.html`, ou `a/_.txt` pour la charge RSC d'une navigation client :
//! `generateStaticParams` n'exporte que le paramètre `_`, la page lit le vrai
//! dans l'adresse). `/` → `index.html`. Rien : `404.html`, statut 404.

use crate::api::error;
use crate::auth::{self, encode_uri_component, is_api_path, is_public_path, safe_next_path};
use crate::state::AppState;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use std::path::{Path, PathBuf};

pub const LOGIN_PATH: &str = "/login";
pub const SETUP_PATH: &str = "/setup";

/// Décision d'accès (`AccessDecision`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    Allow,
    Redirect(String),
    Unauthorized,
}

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

/// `decideAccess` : `search` avec ou sans « ? ».
pub fn decide_access(pathname: &str, search: &str, authenticated: bool, has_users: bool) -> Access {
    let path = normalize(pathname);
    if is_public_path(path) {
        return Access::Allow;
    }
    let search = search.strip_prefix('?').unwrap_or(search);
    let params: Vec<(String, String)> = url::form_urlencoded::parse(search.as_bytes())
        .into_owned()
        .collect();
    let get = |k: &str| params.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
    if path == SETUP_PATH {
        return if has_users {
            Access::Redirect(if authenticated { "/" } else { LOGIN_PATH }.into())
        } else {
            Access::Allow
        };
    }
    if path == LOGIN_PATH {
        if !has_users {
            return Access::Redirect(SETUP_PATH.into());
        }
        return if authenticated {
            Access::Redirect(safe_next_path(get("next")))
        } else {
            Access::Allow
        };
    }
    if authenticated {
        return Access::Allow;
    }
    if is_api_path(path) {
        return Access::Unauthorized;
    }
    if !has_users {
        return Access::Redirect(SETUP_PATH.into());
    }
    // `_rsc` n'est qu'un paramètre anti-cache des navigations client de Next.
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in params.iter().filter(|(k, _)| k != "_rsc") {
        ser.append_pair(k, v);
    }
    let qs = ser.finish();
    let target = if qs.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{qs}")
    };
    Access::Redirect(if target == "/" {
        LOGIN_PATH.into()
    } else {
        format!("{LOGIN_PATH}?next={}", encode_uri_component(&target))
    })
}

fn content_type(file: &Path) -> &'static str {
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        // Charge RSC des navigations client : Next accepte text/plain pour un export.
        Some("txt") => "text/plain; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("xml") => "application/xml",
        _ => "application/octet-stream",
    }
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// Fichier de `root` pour le chemin d'URL (déjà décodé) `path`, ou rien.
pub fn resolve(root: &Path, path: &str) -> Option<PathBuf> {
    let rel = path.trim_start_matches('/');
    let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segs
        .iter()
        .any(|s| *s == "." || *s == ".." || s.contains('\\') || s.contains('\0'))
    {
        return None;
    }
    if segs.is_empty() {
        let f = root.join("index.html");
        return is_file(&f).then_some(f);
    }
    let base = segs.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    let joined = segs.join("/");
    let mut candidates = vec![
        base.clone(),
        root.join(format!("{joined}.html")),
        base.join("index.html"),
    ];
    // Route dynamique : dernier segment remplacé par `_`, extension gardée.
    if segs.len() >= 2 {
        let last = segs[segs.len() - 1];
        let parent = segs[..segs.len() - 1]
            .iter()
            .fold(root.to_path_buf(), |p, s| p.join(s));
        let placeholder = match last.rsplit_once('.') {
            Some((_, ext)) if ext == "txt" => format!("_.{ext}"),
            _ => "_".into(),
        };
        candidates.push(parent.join(format!("{placeholder}.html")));
        candidates.push(parent.join(&placeholder));
    }
    candidates.into_iter().find(|c| is_file(c))
}

/// Réponse d'un fichier (corps omis pour HEAD).
async fn file_response(file: &Path, status: StatusCode, head: bool, rel: &str) -> Response {
    let Ok(bytes) = tokio::fs::read(file).await else {
        return error(StatusCode::NOT_FOUND, "introuvable");
    };
    let len = bytes.len();
    let mut res = Response::new(if head {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(file)),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    let cache = if rel.starts_with("/_next/static/") {
        "public, max-age=31536000, immutable"
    } else if matches!(
        file.extension().and_then(|e| e.to_str()),
        Some("html" | "txt")
    ) {
        "no-store"
    } else {
        "public, max-age=3600"
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

async fn not_found(root: &Path, head: bool, path: &str) -> Response {
    let page = root.join("404.html");
    if is_file(&page) {
        return file_response(&page, StatusCode::NOT_FOUND, head, path).await;
    }
    error(StatusCode::NOT_FOUND, "introuvable")
}

/// Renouvellement glissant : cookie réémis quand la session a été prolongée.
fn renew_cookie(res: &mut Response, headers: &HeaderMap, s: Option<&auth::Session>) {
    let Some(s) = s.filter(|s| s.renewed) else {
        return;
    };
    if let Some(token) = auth::cookie(headers, auth::SESSION_COOKIE) {
        if let Some(v) =
            auth::session_cookie(&token, &s.expires_at, auth::is_https(headers), Utc::now())
        {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
}

/// Toute requête non routée, quand l'interface est servie par Rust.
pub async fn serve(st: &AppState, root: &Path, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let raw_path = parts.uri.path().to_string();
    let search = parts.uri.query().unwrap_or("").to_string();
    let head = parts.method == Method::HEAD;
    let path = percent_encoding::percent_decode_str(&raw_path)
        .decode_utf8_lossy()
        .into_owned();
    let headers = parts.headers;

    let (session, has_users) = if is_public_path(&path) {
        (None, true)
    } else {
        let token = auth::cookie(&headers, auth::SESSION_COOKIE);
        let r = st
            .db
            .run(move |c| {
                let s = auth::validate_session(c, token.as_deref(), Utc::now())?;
                // Avec une session valide, un compte existe forcément : pas de requête.
                let n = if s.is_some() {
                    1
                } else {
                    crate::accounts::count_users(c)?
                };
                Ok((s, n > 0))
            })
            .await;
        match r {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[serveur] session illisible : {e}");
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "base de données indisponible",
                );
            }
        }
    };
    let decision = decide_access(&raw_path, &search, session.is_some(), has_users);
    let mut res = match decision {
        Access::Unauthorized => error(StatusCode::UNAUTHORIZED, "non connecté"),
        Access::Redirect(loc) => {
            let mut r = StatusCode::TEMPORARY_REDIRECT.into_response();
            if let Ok(v) = HeaderValue::from_str(&loc) {
                r.headers_mut().insert(header::LOCATION, v);
            }
            r
        }
        Access::Allow if is_api_path(&path) => error(StatusCode::NOT_FOUND, "introuvable"),
        Access::Allow if parts.method != Method::GET && !head => {
            StatusCode::METHOD_NOT_ALLOWED.into_response()
        }
        Access::Allow => match resolve(root, &path) {
            Some(f) => file_response(&f, StatusCode::OK, head, &path).await,
            None => not_found(root, head, &path).await,
        },
    };
    renew_cookie(&mut res, &headers, session.as_ref());
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cas de tests/auth.test.ts (decideAccess).
    #[test]
    fn decisions_comme_decideaccess() {
        let r = |l: &str| Access::Redirect(l.into());
        assert_eq!(decide_access("/", "", false, true), r("/login"));
        assert_eq!(
            decide_access("/matchs/1", "?x=2&_rsc=abc", false, true),
            r("/login?next=%2Fmatchs%2F1%3Fx%3D2")
        );
        assert_eq!(decide_access("/matchs", "", false, false), r("/setup"));
        assert_eq!(
            decide_access("/api/matches", "", false, true),
            Access::Unauthorized
        );
        assert_eq!(decide_access("/api/health", "", false, true), Access::Allow);
        assert_eq!(
            decide_access("/favicon.ico", "", false, true),
            Access::Allow
        );
        assert_eq!(
            decide_access("/_next/static/x.js", "", false, false),
            Access::Allow
        );
        assert_eq!(decide_access("/setup", "", false, false), Access::Allow);
        assert_eq!(decide_access("/setup", "", false, true), r("/login"));
        assert_eq!(decide_access("/setup/", "", true, true), r("/"));
        assert_eq!(decide_access("/login", "", false, false), r("/setup"));
        assert_eq!(decide_access("/login", "", false, true), Access::Allow);
        assert_eq!(
            decide_access("/login", "?next=%2Fequipes%2FLAL", true, true),
            r("/equipes/LAL")
        );
        assert_eq!(
            decide_access("/login", "?next=https://evil", true, true),
            r("/")
        );
        assert_eq!(decide_access("/matchs", "", true, true), Access::Allow);
        assert_eq!(
            decide_access("/matchs", "d=2026-10-28&team=LAL", false, true),
            r("/login?next=%2Fmatchs%3Fd%3D2026-10-28%26team%3DLAL")
        );
    }

    #[test]
    fn resolution_des_fichiers_de_l_export() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for f in [
            "index.html",
            "index.txt",
            "matchs.html",
            "matchs.txt",
            "matchs/_.html",
            "matchs/_.txt",
            "404.html",
            "_next/static/chunks/a.js",
            "favicon.ico",
            "docs/index.html",
        ] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, f).unwrap();
        }
        let got = |p: &str| {
            resolve(root, p).map(|f| f.strip_prefix(root).unwrap().to_string_lossy().into_owned())
        };
        assert_eq!(got("/").as_deref(), Some("index.html"));
        assert_eq!(got("/index.txt").as_deref(), Some("index.txt"));
        assert_eq!(got("/matchs").as_deref(), Some("matchs.html"));
        assert_eq!(got("/matchs/").as_deref(), Some("matchs.html"));
        assert_eq!(got("/matchs.txt").as_deref(), Some("matchs.txt"));
        assert_eq!(got("/matchs/401909880").as_deref(), Some("matchs/_.html"));
        assert_eq!(
            got("/matchs/401909880.txt").as_deref(),
            Some("matchs/_.txt")
        );
        assert_eq!(got("/docs").as_deref(), Some("docs/index.html"));
        assert_eq!(
            got("/_next/static/chunks/a.js").as_deref(),
            Some("_next/static/chunks/a.js")
        );
        assert_eq!(got("/favicon.ico").as_deref(), Some("favicon.ico"));
        assert_eq!(got("/inconnu"), None);
        assert_eq!(got("/equipes/LAL"), None);
        assert_eq!(got("/../etc/passwd"), None);
        assert_eq!(got("/matchs/../../x"), None);
    }
}
