//! État partagé du serveur et informations sur l'environnement.

use crate::db::Db;
use crate::proxy::Upstream;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    /// Application Node, pour tout ce qui n'est pas encore servi par Rust.
    pub upstream: Upstream,
    /// Proxy vidéo ok.ru (caches de flux, playlists et segments).
    pub video: crate::video::Video,
    /// Recherche des replays basketball-video (cache des listes, recherches en vol).
    pub replays: crate::replay::Replays,
}

impl AppState {
    /// État complet ; la recherche des replays passe par le client du proxy vidéo.
    pub fn new(db: Db, upstream: Upstream, video: crate::video::Video) -> Self {
        let replays = crate::replay::Replays::new(crate::bv::Bv::new(video.clone()));
        AppState {
            db,
            upstream,
            video,
            replays,
        }
    }
}

/// ffmpeg présent sur le serveur (vérifié une fois, comme `ffmpegAvailable`).
pub fn ffmpeg_available() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| {
        let bin = std::env::var("FFMPEG_PATH")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "ffmpeg".into());
        Command::new(bin)
            .arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// Version de Node (`process.version`) de l'application relayée, si présente.
pub fn node_version() -> Option<String> {
    static V: OnceLock<Option<String>> = OnceLock::new();
    V.get_or_init(|| {
        let bin = std::env::var("BL_NODE_BIN")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "node".into());
        let out = Command::new(bin)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .clone()
}
