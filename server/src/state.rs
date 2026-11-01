//! État partagé du serveur et informations sur l'environnement.

use crate::db::Db;
use crate::media::analysis::{Analysis, AnalysisDeps, AnalysisOptions};
use crate::media::commentary::Commentary;
use crate::media::dub::{self, Dub};
use crate::proxy::Upstream;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

/// Files médias (étapes 6b et 7) : traduction des commentaires, doublage,
/// analyse vidéo. Une seule instance par processus, partagée par `Clone` ;
/// les trois partagent la table des spectateurs et l'horloge de la traduction,
/// le doublage est branché sur la traduction (crochets) et lit l'activité de
/// l'analyse (le GPU n'est pas partagé avec une analyse en cours).
#[derive(Clone)]
pub struct Media {
    pub commentary: Commentary,
    pub dub: Dub,
    pub analysis: Analysis,
}

impl Media {
    /// Services de production (proxy vidéo `video` pour lire les flux).
    pub fn new(db: Db, video: crate::video::Video) -> Self {
        let commentary = Commentary::new(db.clone(), video.clone());
        let analysis = Analysis::with_options(
            db.clone(),
            AnalysisDeps::defaults(db, video.clone()),
            AnalysisOptions::shared_with(&commentary),
        );
        let dub = Dub::new(commentary.clone(), video);
        Media::wire(commentary, dub, analysis)
    }

    /// Services donnés (tests) : le doublage lit l'activité de l'analyse.
    pub fn wire(commentary: Commentary, dub: Dub, analysis: Analysis) -> Self {
        let a = analysis.clone();
        dub.set_analysis_activity(Some(Arc::new(move || {
            let act = a.activity();
            dub::AnalysisActivity {
                running: act
                    .running
                    .into_iter()
                    .map(|r| dub::AnalysisRun {
                        match_id: r.match_id,
                        phase: r.phase,
                        done: r.done,
                        total: r.total,
                    })
                    .collect(),
                queued: act.queued,
            }
        })));
        // Par référence faible : le doublage tient déjà l'analyse (pas de cycle d'Arc).
        let d = Arc::downgrade(&dub.0);
        analysis.set_gpu_reserved(Some(Arc::new(move || {
            d.upgrade()
                .is_some_and(|i| !dub::Dub(i).gpu_reservations().is_empty())
        })));
        Media {
            commentary,
            dub,
            analysis,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    /// Application Node, pour tout ce qui n'est pas encore servi par Rust.
    pub upstream: Upstream,
    /// Proxy vidéo ok.ru (caches de flux, playlists et segments).
    pub video: crate::video::Video,
    /// Recherche des replays basketball-video (cache des listes, recherches en vol).
    pub replays: crate::replay::Replays,
    /// Files de traduction, de doublage et d'analyse.
    pub media: Media,
    /// Export statique de l'interface (`BL_STATIC_DIR`) : servi par Rust ;
    /// sans lui, tout ce qui n'est pas routé est relayé à Node.
    pub static_dir: Option<std::path::PathBuf>,
}

impl AppState {
    /// État complet ; la recherche des replays passe par le client du proxy vidéo.
    pub fn new(db: Db, upstream: Upstream, video: crate::video::Video) -> Self {
        let media = Media::new(db.clone(), video.clone());
        AppState::with_media(db, upstream, video, media)
    }

    /// État complet aux files médias données (tests).
    pub fn with_media(
        db: Db,
        upstream: Upstream,
        video: crate::video::Video,
        media: Media,
    ) -> Self {
        let replays = crate::replay::Replays::new(crate::bv::Bv::new(video.clone()));
        AppState {
            db,
            upstream,
            video,
            replays,
            media,
            static_dir: static_dir_from_env(),
        }
    }
}

/// `BL_STATIC_DIR` (non vide) : dossier de l'export statique de l'interface.
pub fn static_dir_from_env() -> Option<std::path::PathBuf> {
    std::env::var("BL_STATIC_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
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
