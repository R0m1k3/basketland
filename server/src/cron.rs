//! Cron interne des jobs portés (équivalent de la part de
//! `src/lib/scheduler.ts` qui les concerne) : mêmes délais initiaux, mêmes
//! intervalles. Calendrier 15 min, stats 5 min, VF 60 min ; base presque
//! vide au démarrage (< 50 matchs) : saison complète. `DISABLE_CRON=1` le
//! désactive. Node ne lance plus ces jobs (`BL_RUST_JOBS`, voir `node.rs`).

use crate::db::{self, Db, MatchFilters};
use crate::ingest;
use std::future::Future;
use std::time::Duration;

const MIN: u64 = 60;

/// `every` : premier passage après `initial`, puis toutes les `period`
/// (sans attendre la fin du précédent, comme `setInterval` : un job encore
/// en cours répond « déjà en cours »).
fn every<F, Fut>(period: Duration, initial: Duration, f: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        tokio::time::sleep(initial).await;
        tokio::spawn(f());
        let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            tokio::spawn(f());
        }
    });
}

/// Démarre les jobs (à appeler depuis le runtime tokio).
pub fn start(db: Db) {
    if std::env::var("DISABLE_CRON").as_deref() == Ok("1") {
        return;
    }
    println!(
        "[cron] démarrage des jobs internes : {}",
        ingest::RUST_JOBS.join(", ")
    );

    // Premier démarrage : base vide → saison complète.
    let d = db.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        match d
            .run(|c| db::count_matches(c, &MatchFilters::default()))
            .await
        {
            Ok(n) if n < 50 => {
                ingest::sync_season(&d, f64::from(ingest::current_season())).await;
            }
            Ok(_) => {}
            Err(e) => eprintln!("[cron] init {e}"),
        }
    });

    let d = db.clone();
    every(
        Duration::from_secs(15 * MIN),
        Duration::from_secs(5),
        move || {
            let d = d.clone();
            async move {
                ingest::sync_schedule(&d).await;
            }
        },
    );
    let d = db.clone();
    every(
        Duration::from_secs(5 * MIN),
        Duration::from_secs(60),
        move || {
            let d = d.clone();
            async move {
                ingest::sync_stats(&d, 15).await;
            }
        },
    );
    every(
        Duration::from_secs(60 * MIN),
        Duration::from_secs(10 * MIN),
        move || {
            let d = db.clone();
            async move {
                ingest::sync_subtitles(&d, 50).await;
            }
        },
    );
}
