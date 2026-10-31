//! Files médias de test pour les routes : traduction configurée (serveurs
//! fictifs), ffmpeg « présent », spectateurs à part ; un travail lancé
//! reste « en cours » jusqu'à son interruption.

#![allow(dead_code)]

use basketland_server::db::Db;
use basketland_server::media::abort::AbortSignal;
use basketland_server::media::analysis::{Analysis, AnalysisDeps, AnalysisOptions};
use basketland_server::media::commentary::{
    Commentary, CommentaryDeps, CommentaryError, CommentaryOptions,
};
use basketland_server::media::dub::Dub;
use basketland_server::media::viewers::{now_ms, Viewers};
use basketland_server::state::Media;
use basketland_server::video::Video;
use std::sync::Arc;

/// Variables de la traduction (une fois par processus de test).
pub fn media_env() {
    static ENV: std::sync::Once = std::sync::Once::new();
    ENV.call_once(|| {
        std::env::set_var("TRANSCRIBE_URL", "http://gpu.local:8000/v1");
        std::env::set_var("TRANSLATE_URL", "http://gpu.local:11434/v1");
        // Moteur de voix jamais chargé (pas de processus Python).
        std::env::set_var("DUB_DISABLED", "1");
    });
}

pub fn test_media(db: &Db, video: &Video) -> Media {
    media_env();
    let viewers: &'static Viewers = Box::leak(Box::default());
    let commentary = Commentary::with_options(
        db.clone(),
        CommentaryDeps::defaults(video.clone()),
        CommentaryOptions {
            viewers,
            clock: Arc::new(now_ms),
            ffmpeg_available: Arc::new(|| true),
        },
    );
    // Comme un vrai travail : ne rend la main qu'interrompu.
    commentary.set_runner(Some(Arc::new(|_, _, signal: AbortSignal, _| {
        Box::pin(async move {
            signal.aborted().await;
            Err(CommentaryError::Other("travail interrompu".into()))
        })
    })));
    let analysis = Analysis::with_options(
        db.clone(),
        AnalysisDeps::defaults(db.clone(), video.clone()),
        AnalysisOptions::shared_with(&commentary),
    );
    analysis.set_runner(Some(Arc::new(|_, _, _| Box::pin(std::future::pending()))));
    let dub = Dub::new(commentary.clone(), video.clone());
    Media::wire(commentary, dub, analysis)
}
