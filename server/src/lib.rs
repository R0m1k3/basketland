//! Serveur Basketland en Rust.
//!
//! Migration par étapes : ce binaire écoute sur le port public, sert
//! lui-même les routes déjà portées (voir [`app`]) et relaie tout le reste à
//! l'application Next.js, lancée en sous-processus sur un port interne
//! (voir `docs/migration-rust.md`).

pub mod api;
pub mod auth;
pub mod db;
pub mod node;
pub mod present;
pub mod proxy;
pub mod routes;
pub mod state;
pub mod time;

use axum::routing::get;
use axum::Router;

/// Routes servies par Rust ; tout le reste part à Node.
pub fn app(state: state::AppState) -> Router {
    Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/schedule", get(routes::schedule))
        .route("/api/matches", get(routes::matches))
        .fallback(proxy::forward)
        .with_state(state)
}
