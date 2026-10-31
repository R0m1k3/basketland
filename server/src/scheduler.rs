//! Mises en file de fond des files médias (équivalents de `queueRecentWork`
//! et `queueNewReplayWork` de `src/lib/scheduler.ts`, et de
//! `prioritizeFoundReplay` de `src/lib/replayCheck.ts`). Fonctions
//! synchrones (elles lisent la base) : depuis le runtime, les appeler par
//! `spawn_blocking`.

use crate::db::Db;
use crate::settings::{self, Settings};
use crate::state::Media;

/// `autoTranslateEnabled` (réglage illisible : activée, comme sans réglage).
fn auto_translate(db: &Db) -> bool {
    let s = db
        .with(Settings::load)
        .unwrap_or_else(|_| Settings::unreadable());
    settings::auto_translate_enabled(&s)
}

/// Travaux mis en file (`{ commentaries, analyses }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Queued {
    pub commentaries: usize,
    pub analyses: usize,
}

/// `queueRecentWork` : traductions et/ou analyses des replays récents ; rien
/// quand la « Traduction automatique » est désactivée ni hors de la fenêtre
/// autorisée (`COMMENTARY_NIGHT_WINDOW`).
pub fn queue_recent_work(db: &Db, media: &Media, commentaries: bool, analyses: bool) -> Queued {
    if !auto_translate(db) || !media.commentary.in_night_window() {
        return Queued::default();
    }
    Queued {
        commentaries: if commentaries {
            media.commentary.enqueue_recent(None, None)
        } else {
            0
        },
        analyses: if analyses {
            media.analysis.enqueue_recent(None, None)
        } else {
            0
        },
    }
}

/// `queueNewReplayWork` : après une recherche des replays qui en a trouvé.
pub fn queue_new_replay_work(db: &Db, media: &Media) -> Queued {
    let r = queue_recent_work(db, media, true, true);
    if r.commentaries > 0 || r.analyses > 0 {
        println!(
            "[cron] nouveaux replays : {} traduction(s), {} analyse(s) mise(s) en file",
            r.commentaries, r.analyses
        );
    }
    r
}

/// `prioritizeFoundReplay` : replay trouvé par une recherche à la demande →
/// traduction de ce match en tête de file (sauf traduction automatique
/// désactivée ; piste prête et backoff après un échec respectés).
pub fn prioritize_found_replay(db: &Db, media: &Media, match_id: i64) -> bool {
    if !auto_translate(db) {
        return false;
    }
    let c = media.commentary.clone();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.prioritize_on_view(match_id)
    })) {
        Ok(()) => true,
        Err(e) => {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            eprintln!("[replay] mise en file de la traduction impossible : {msg}");
            false
        }
    }
}
