//! Fondations du traitement des médias (étape 6a de la migration) : modules
//! de bibliothèque portés de Node, PAS encore branchés sur une route ni sur
//! le cron — les files de traduction, de doublage et d'analyse vidéo restent
//! côté Node tant qu'elles ne sont pas basculées ensemble (étapes 6b et 7).
//!
//! | Module | Équivalent Node |
//! |--------|-----------------|
//! | [`abort`] | `AbortController` / `AbortSignal` |
//! | [`proc`] | `procPriority.ts`, `stopChild`, processus de travail JSON |
//! | [`night_window`] | `nightWindow.ts` |
//! | [`viewers`] | `viewers.ts` |
//! | [`commentary_cues`] | `commentaryCues.ts` |
//! | [`roster_names`] | `rosterNames.ts` |
//! | [`audio`] | `audio.ts` + extraction ffmpeg de `commentary.ts` |
//! | [`audio_energy`] | `audioEnergy.ts` |
//! | [`local_ai`] | `localAi.ts` (Whisper et Ollama embarqués) |
//! | [`commentary_ai`] | `commentaryAi.ts` (transcription, traduction) |
//! | [`commentary`] | `commentary.ts` (file de traduction, étape 6b, non branchée) |
//! | [`dub`] | `dub.ts` (file de doublage, étape 6b, non branchée) |
//! | [`voice_minimax`] | `voiceMinimax.ts` |
//! | [`voice_ai`] | `voiceAi.ts` (Qwen3-TTS embarqué) |
//! | [`video_scan`] | `videoScan.ts` |
//!
//! Les réglages (`settings.ts`) sont dans [`crate::settings`].

pub mod abort;
pub mod audio;
pub mod audio_energy;
pub mod commentary;
pub mod commentary_ai;
pub mod commentary_cues;
pub mod dub;
pub mod local_ai;
pub mod night_window;
pub mod proc;
pub mod roster_names;
pub mod video_scan;
pub mod viewers;
pub mod voice_ai;
pub mod voice_minimax;

pub use abort::AbortSignal;

/// Verrou des tests qui modifient les variables d'environnement (lues à
/// chaque appel, comme `process.env` côté Node).
#[cfg(test)]
pub(crate) static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Pose ou retire des variables d'environnement ; rend l'état précédent.
#[cfg(test)]
pub(crate) fn set_env(vars: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
    let saved = vars
        .iter()
        .map(|(k, _)| (k.to_string(), std::env::var(k).ok()))
        .collect();
    for (k, v) in vars {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
    saved
}

/// Remet les variables d'environnement sauvées par [`set_env`].
#[cfg(test)]
pub(crate) fn restore_env(saved: Vec<(String, Option<String>)>) {
    for (k, v) in saved {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
}
