//! Serveur Basketland en Rust.
//!
//! Migration par étapes : ce binaire écoute sur le port public, sert
//! lui-même les routes déjà portées (voir [`app`]) et relaie tout le reste à
//! l'application Next.js, lancée en sous-processus sur un port interne
//! (voir `docs/migration-rust.md`).

pub mod accounts;
pub mod api;
pub mod auth;
pub mod cron;
pub mod db;
pub mod espn;
pub mod espn_events;
pub mod hls;
pub mod http;
pub mod ingest;
pub mod ingest_db;
pub mod js;
pub mod jsval;
pub mod node;
pub mod okru;
pub mod present;
pub mod proxy;
pub mod routes;
pub mod routes_auth;
pub mod routes_ingest;
pub mod routes_match;
pub mod routes_video;
pub mod state;
pub mod time;
pub mod vf;
pub mod vf_sync;
pub mod video;
pub mod writes;

use axum::routing::{get, post};
use axum::Router;

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
        .route("/api/video/{ok_id}/master.m3u8", get(routes_video::master))
        .route(
            "/api/video/{ok_id}/playlist.m3u8",
            get(routes_video::playlist),
        )
        .route("/api/video/{ok_id}/segment.ts", get(routes_video::segment))
        .route("/api/video/{ok_id}/asset.ts", get(routes_video::asset))
        .route("/api/video/{ok_id}/file.mp4", get(routes_video::file_mp4))
        .route(
            "/api/ingest",
            post(routes_ingest::ingest).fallback(proxy::forward),
        )
        .fallback(proxy::forward)
        .with_state(state)
}
