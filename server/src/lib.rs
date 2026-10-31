//! Serveur Basketland en Rust.
//!
//! Migration par étapes : ce binaire écoute sur le port public, sert
//! lui-même les routes déjà portées (voir [`app`]) et relaie tout le reste à
//! l'application Next.js, lancée en sous-processus sur un port interne
//! (voir `docs/migration-rust.md`).

pub mod accounts;
pub mod activity;
pub mod analysis_db;
pub mod api;
pub mod auth;
pub mod bv;
pub mod commentary_db;
pub mod cron;
pub mod db;
pub mod dub_db;
pub mod espn;
pub mod espn_events;
pub mod hls;
pub mod http;
pub mod ingest;
pub mod ingest_db;
pub mod js;
pub mod jsval;
pub mod linescore;
pub mod media;
pub mod node;
pub mod okru;
pub mod pages;
pub mod present;
pub mod proxy;
pub mod queries;
pub mod replay;
pub mod reset_password;
pub mod routes;
pub mod routes_auth;
pub mod routes_diag;
pub mod routes_ingest;
pub mod routes_match;
pub mod routes_media;
pub mod routes_pages;
pub mod routes_replay;
pub mod routes_settings;
pub mod routes_video;
pub mod scheduler;
pub mod schema;
pub mod settings;
pub mod state;
pub mod static_site;
pub mod sync_route;
pub mod teams;
pub mod time;
pub mod version;
pub mod vf;
pub mod vf_sync;
pub mod video;
pub mod writes;

use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

/// Chemins internes de l'application Node (`/api/internal/…`), appelés par
/// le serveur Rust seul (jeton d'ingestion) : jamais relayés depuis
/// l'extérieur, quelle que soit leur écriture (casse, `%xx`, `//`).
pub fn is_internal_path(path: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let mut p = String::with_capacity(decoded.len());
    for c in decoded.chars() {
        if !(c == '/' && p.ends_with('/')) {
            p.push(c);
        }
    }
    let p = p.trim_end_matches('/');
    p == "/api/internal" || p.starts_with("/api/internal/")
}

/// Requête non routée : interface statique servie par Rust (`BL_STATIC_DIR`),
/// sinon relais vers Node ; chemins internes toujours en 404.
async fn relay(st: State<state::AppState>, req: Request) -> Response {
    if is_internal_path(req.uri().path()) {
        return api::error(axum::http::StatusCode::NOT_FOUND, "introuvable");
    }
    if let Some(root) = st.static_dir.clone() {
        return static_site::serve(&st, &root, req).await;
    }
    proxy::forward(st, req).await
}

/// Méthode non servie par une route portée : 405, ou la réponse de Node
/// quand il sert encore l'interface.
async fn method_fallback(st: State<state::AppState>, req: Request) -> Response {
    if st.static_dir.is_some() {
        return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    proxy::forward(st, req).await
}

/// Routes servies par Rust ; tout le reste part à Node.
pub fn app(state: state::AppState) -> Router {
    Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/schedule", get(routes::schedule))
        .route("/api/matches", get(routes::matches))
        .route("/api/matches/{id}", get(routes_match::detail))
        .route("/api/matches/{id}/stats", get(routes_match::stats))
        .route(
            "/api/matches/{id}/clips",
            get(routes_match::clips).post(routes_match::clips_post),
        )
        .route("/api/standings", get(routes_match::standings))
        .route("/api/auth/login", post(routes_auth::login))
        .route("/api/auth/setup", post(routes_auth::setup))
        .route("/api/auth/logout", post(routes_auth::logout))
        .route("/api/account/password", post(routes_auth::account_password))
        .route(
            "/api/admin/users",
            get(routes_auth::users_list).post(routes_auth::users_post),
        )
        .route(
            "/api/admin/settings",
            get(routes_settings::get).post(routes_settings::post),
        )
        .route("/api/video/{ok_id}/master.m3u8", get(routes_video::master))
        .route(
            "/api/video/{ok_id}/playlist.m3u8",
            get(routes_video::playlist),
        )
        .route("/api/video/{ok_id}/segment.ts", get(routes_video::segment))
        .route("/api/video/{ok_id}/asset.ts", get(routes_video::asset))
        .route("/api/video/{ok_id}/file.mp4", get(routes_video::file_mp4))
        .route(
            "/api/matches/{id}/replay",
            post(routes_replay::replay).fallback(method_fallback),
        )
        .route(
            "/api/ingest",
            post(routes_ingest::ingest).fallback(method_fallback),
        )
        // Files médias (étapes 6b et 7).
        .route(
            "/api/matches/{id}/subtitles",
            get(routes_media::subtitles).fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/subtitles.vtt",
            get(routes_media::subtitles_vtt).fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/commentary",
            get(routes_media::commentary_get)
                .post(routes_media::commentary_post)
                .fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/watching",
            post(routes_media::watching).fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/dub",
            get(routes_media::dub_get)
                .post(routes_media::dub_post)
                .fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/dub/{idx}",
            get(routes_media::dub_chunk).fallback(method_fallback),
        )
        .route(
            "/api/matches/{id}/sync",
            get(routes_media::sync_get)
                .post(routes_media::sync_post)
                .fallback(method_fallback),
        )
        .route(
            "/api/diag/stall",
            post(routes_diag::stall).fallback(method_fallback),
        )
        .route(
            "/api/activity",
            get(routes_media::activity).fallback(method_fallback),
        )
        // Données des pages (étape 8a) ; seule `/api/pages/session` est publique.
        .route(
            routes_pages::PUBLIC_SESSION_PATH,
            get(routes_pages::session),
        )
        .route("/api/pages/home", get(routes_pages::home))
        .route("/api/pages/matchs", get(routes_pages::matchs))
        .route("/api/pages/matchs/{id}", get(routes_pages::match_page))
        .route("/api/pages/equipes", get(routes_pages::equipes))
        .route("/api/pages/equipes/{abbr}", get(routes_pages::equipe))
        .route("/api/pages/classement", get(routes_pages::classement))
        .route("/api/pages/parametres", get(routes_pages::parametres))
        .fallback(relay)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::is_internal_path;

    #[test]
    fn chemins_internes_jamais_relayes() {
        for p in [
            "/api/internal/replays",
            "/api/internal/replays/",
            "/api/internal",
            "/API/Internal/replays",
            "//api//internal/replays",
            "/api/%69nternal/replays",
            "/api%2Finternal%2Freplays",
        ] {
            assert!(is_internal_path(p), "{p}");
        }
        for p in ["/api/internals", "/api/ingest", "/internal/replays"] {
            assert!(!is_internal_path(p), "{p}");
        }
    }
}
