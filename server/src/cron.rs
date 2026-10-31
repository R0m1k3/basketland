//! Cron interne (équivalent de `src/lib/scheduler.ts`) : mêmes délais
//! initiaux, mêmes intervalles. Calendrier 15 min, stats 5 min, replays
//! 20 min, VF 60 min, analyses vidéo et pré-traductions 10 min ; base presque
//! vide au démarrage (< 50 matchs) : saison complète. `DISABLE_CRON=1` le
//! désactive. Node ne lance plus aucun job (`BL_RUST_JOBS`, voir `node.rs`).
//! Un replay apparu pendant `sync-videos` est mis en file de traduction et
//! d'analyse aussitôt (`queueNewReplayWork`), comme le faisait Node.

use crate::db::{self, Db, MatchFilters};
use crate::state::AppState;
use crate::{ingest, replay, scheduler};
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

/// Schéma présent : la base est créée et migrée par Node (au démarrage de
/// son planificateur). Sur une installation neuve, le fichier n'existe pas
/// encore quand le serveur Rust démarre.
async fn schema_ready(db: &Db) -> bool {
    db.run(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('matches', 'ingest_log')",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .await
    .map(|n| n == 2)
    .unwrap_or(false)
}

/// Démarre les jobs (à appeler depuis le runtime tokio) une fois la base
/// prête : mêmes délais qu'avant, comptés à partir de ce moment.
pub fn start(st: AppState) {
    if std::env::var("DISABLE_CRON").as_deref() == Ok("1") {
        return;
    }
    tokio::spawn(async move {
        let t0 = std::time::Instant::now();
        let mut warned = false;
        while !schema_ready(&st.db).await {
            if !warned && t0.elapsed() > Duration::from_secs(30) {
                eprintln!("[cron] base pas encore créée par l'application Node : jobs en attente");
                warned = true;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        schedule(st);
    });
}

fn schedule(st: AppState) {
    let db = st.db.clone();
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
    // Recherche des replays ; un replay qui vient d'apparaître est mis en
    // file de traduction et d'analyse tout de suite (pas d'attente des jobs
    // de 10 min).
    let s = st.clone();
    every(
        Duration::from_millis(replay::VIDEO_JOB_INTERVAL_MS as u64),
        Duration::from_secs(3 * MIN),
        move || {
            let st = s.clone();
            async move {
                let (_, changed) = st.replays.sync_videos(&st.db, 20).await;
                if changed > 0 {
                    let (d, m) = (st.db.clone(), st.media.clone());
                    if let Err(e) = tokio::task::spawn_blocking(move || {
                        scheduler::queue_new_replay_work(&d, &m)
                    })
                    .await
                    {
                        eprintln!("[cron] {e}");
                    }
                }
            }
        },
    );
    let d = db.clone();
    every(
        Duration::from_secs(60 * MIN),
        Duration::from_secs(10 * MIN),
        move || {
            let d = d.clone();
            async move {
                ingest::sync_subtitles(&d, 50).await;
            }
        },
    );
    // Tâches de fond lourdes (analyse vidéo OCR, pré-traduction des
    // commentaires) : seulement si la traduction automatique est activée et
    // dans la fenêtre autorisée (`COMMENTARY_NIGHT_WINDOW`) ; sinon un match
    // n'est analysé et traduit que quand quelqu'un le demande.
    let s = st.clone();
    every(
        Duration::from_secs(10 * MIN),
        Duration::from_secs(4 * MIN),
        move || {
            let st = s.clone();
            async move {
                let r = tokio::task::spawn_blocking(move || {
                    scheduler::queue_recent_work(&st.db, &st.media, false, true).analyses
                })
                .await;
                match r {
                    Ok(0) => {}
                    Ok(n) => println!("[cron] {n} analyse(s) vidéo mise(s) en file"),
                    Err(e) => eprintln!("[cron] {e}"),
                }
            }
        },
    );
    every(
        Duration::from_secs(10 * MIN),
        Duration::from_secs(6 * MIN),
        move || {
            let st = st.clone();
            async move {
                let r = tokio::task::spawn_blocking(move || {
                    scheduler::queue_recent_work(&st.db, &st.media, true, false).commentaries
                })
                .await;
                match r {
                    Ok(0) => {}
                    Ok(n) => println!("[cron] pré-traduction : {n} match(s) mis en file"),
                    Err(e) => eprintln!("[cron] {e}"),
                }
            }
        },
    );
}
