//! Jobs d'ingestion (équivalent de `src/lib/ingest.ts`) : calendrier,
//! saison, stats + play-by-play, VF ; la recherche des replays
//! (`sync-videos`) est dans [`crate::replay`]. Chaque job est isolé et
//! journalisé dans `ingest_log` ; un job déjà en cours n'est pas relancé
//! (« déjà en cours »).

use crate::db::{self, Db, MatchFilters, MatchRow};
use crate::espn_events::{self, espn_date, season_text, PlayRow};
use crate::ingest_db::{self as idb, NewAnchor, SubtitleRow};
use crate::vf::{self, Category};
use crate::vf_sync::{self as vs, ResolvedAnchor};
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::sync::Mutex;

/// Jobs lancés par le cron Rust, que le planificateur de Node saute
/// (`BL_RUST_JOBS`) : tous, analyses vidéo et pré-traductions comprises.
pub const RUST_JOBS: [&str; 7] = [
    "sync-schedule",
    "sync-season",
    "sync-stats",
    "sync-videos",
    "sync-subtitles",
    "analyses",
    "commentaries",
];

/// Résultat d'un job (`{ ok, detail }`).
#[derive(Debug, Clone, PartialEq)]
pub struct JobResult {
    pub ok: bool,
    pub detail: String,
}

impl JobResult {
    pub fn to_json(&self) -> Value {
        json!({ "ok": self.ok, "detail": self.detail })
    }
}

fn running() -> &'static Mutex<HashSet<String>> {
    static R: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Libère la place du job quoi qu'il arrive (fin, erreur, abandon).
struct Slot(String);
impl Drop for Slot {
    fn drop(&mut self) {
        running()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// `runLogged` : un seul exemplaire du job à la fois, début et fin dans `ingest_log`.
pub async fn run_logged<F, Fut>(db: &Db, task: &str, f: F) -> JobResult
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    if !running()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(task.to_string())
    {
        return JobResult {
            ok: false,
            detail: "déjà en cours".into(),
        };
    }
    let _slot = Slot(task.to_string());
    let t = task.to_string();
    let id = match db.run(move |c| idb::log_ingest_start(c, &t)).await {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[ingest] {task} échoué: {e}");
            return JobResult {
                ok: false,
                detail: e,
            };
        }
    };
    let (ok, detail) = match f().await {
        Ok(d) => (true, d),
        Err(e) => {
            eprintln!("[ingest] {task} échoué: {e}");
            (false, e)
        }
    };
    let d = detail.clone();
    if let Err(e) = db.run(move |c| idb::log_ingest_end(c, id, ok, &d)).await {
        eprintln!("[ingest] {task} : journal non mis à jour ({e})");
    }
    JobResult { ok, detail }
}

/// `currentSeason` : année de début de la saison NBA en cours (septembre et après).
pub fn current_season() -> i32 {
    let now = Utc::now();
    if now.month0() >= 8 {
        now.year()
    } else {
        now.year() - 1
    }
}

/// Calendrier : 7 jours passés + 7 jours à venir (+ live).
pub async fn sync_schedule(db: &Db) -> JobResult {
    run_logged(db, "sync-schedule", || async {
        let now = Utc::now();
        let from = (now - Duration::days(7)).date_naive();
        let to = (now + Duration::days(7)).date_naive();
        let matches = espn_events::fetch_scoreboard_range(from, to, "nba", 1000).await?;
        let n = matches.len();
        db.run(move |c| idb::upsert_matches(c, &matches)).await?;
        Ok(format!(
            "{n} matchs ({}→{})",
            espn_date(from),
            espn_date(to)
        ))
    })
    .await
}

/// Premier et dernier jour du mois `month0` (0 = janvier) de `year`, comme
/// `Date.UTC(year, month, 1)` et `Date.UTC(year, month + 1, 0)`.
fn month_bounds(year: i32, month0: u32) -> Option<(NaiveDate, NaiveDate)> {
    let first = NaiveDate::from_ymd_opt(year, month0 + 1, 1)?;
    let next = if month0 == 11 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month0 + 2, 1)?
    };
    Some((first, next - Duration::days(1)))
}

/// Saison complète (année de début), mois par mois de septembre à juin.
pub async fn sync_season(db: &Db, season: f64) -> JobResult {
    run_logged(db, "sync-season", || async {
        let mut total = 0usize;
        let mut errors: Vec<String> = Vec::new();
        for i in 0..10u32 {
            let month0 = (8 + i) % 12;
            let year = season + if 8 + i >= 12 { 1.0 } else { 0.0 };
            // Saison non numérique : Date invalide, aucune période interrogée.
            if !year.is_finite() {
                continue;
            }
            let Some((from, to)) = month_bounds(year.trunc() as i32, month0) else {
                continue;
            };
            let r = async {
                let matches = espn_events::fetch_scoreboard_range(from, to, "nba", 1000).await?;
                let n = matches.len();
                db.run(move |c| idb::upsert_matches(c, &matches)).await?;
                Ok::<usize, String>(n)
            }
            .await;
            match r {
                Ok(n) => total += n,
                Err(e) => errors.push(format!("{}-{}: {e}", season_text(year), month0 + 1)),
            }
        }
        if !errors.is_empty() && total == 0 {
            return Err(errors.join(" | "));
        }
        Ok(format!(
            "{total} matchs (saison {}){}",
            season_text(season),
            if errors.is_empty() {
                String::new()
            } else {
                format!(" — erreurs: {}", errors.join(" | "))
            }
        ))
    })
    .await
}

/// Fin de match présente dans le play-by-play.
fn has_game_end(plays: &[PlayRow]) -> bool {
    plays.iter().any(|p| {
        vf::classify_play(&p.event_type, &p.text_en, p.scoring != 0.0) == Category::GameEnd
    })
}

/// Partie « base » de `ingestMatchDetails`, une fois la fiche ESPN obtenue.
pub fn store_match_details(
    c: &Connection,
    m: &MatchRow,
    s: &espn_events::ParsedSummary,
) -> rusqlite::Result<Result<String, String>> {
    if let Some(g) = &s.game {
        idb::upsert_match(c, g)?;
    }
    idb::replace_stats(c, m.id, &s.teams, &s.players, &s.leaders)?;
    idb::replace_plays(c, m.id, &s.plays)?;
    let fresh = db::get_match(c, m.id)?;
    // Synchronisé seulement si les données sont complètes (joueurs + fin de match).
    let complete = !s.players.is_empty() && has_game_end(&s.plays);
    if fresh.is_some_and(|f| f.status == "final") && complete {
        idb::mark_stats_synced(c, m.id)?;
    }
    let subs = match regenerate_subtitles(c, m.id, Some(s.plays.clone()))? {
        Ok(n) => n,
        Err(e) => return Ok(Err(e)),
    };
    Ok(Ok(format!(
        "{}@{}: {} joueurs, {} actions, {subs} sous-titres",
        m.away_abbr,
        m.home_abbr,
        s.players.len(),
        s.plays.len()
    )))
}

/// `ingestMatchDetails` : stats + play-by-play d'un match, puis VF.
pub async fn ingest_match_details(db: &Db, m: &MatchRow) -> Result<String, String> {
    let s = espn_events::fetch_summary(m.id, &m.league).await?;
    let m = m.clone();
    db.run(move |c| store_match_details(c, &m, &s)).await?
}

pub async fn sync_stats(db: &Db, limit: i64) -> JobResult {
    run_logged(db, "sync-stats", || async {
        let todo = db
            .run(move |c| {
                let mut v = idb::final_matches_needing_stats(c, limit)?;
                v.extend(idb::live_matches(c)?);
                Ok(v)
            })
            .await?;
        let mut done: Vec<String> = Vec::new();
        for m in &todo {
            match ingest_match_details(db, m).await {
                Ok(l) => done.push(l),
                Err(e) => done.push(format!("{}: {e}", m.id)),
            }
        }
        Ok(if done.is_empty() {
            "rien à faire".into()
        } else {
            done.join(" | ")
        })
    })
    .await
}

pub async fn sync_subtitles(db: &Db, limit: i64) -> JobResult {
    run_logged(db, "sync-subtitles", || async {
        let from = crate::time::iso_utc(Utc::now() - Duration::days(21));
        let f = MatchFilters {
            status: Some("final".into()),
            from: Some(from),
            limit,
            desc: true,
            ..Default::default()
        };
        let recent = db.run(move |c| db::list_matches(c, &f)).await?;
        let mut n = 0;
        for m in recent {
            let id = m.id;
            if db.run(move |c| regenerate_subtitles(c, id, None)).await?? > 0 {
                n += 1;
            }
        }
        Ok(format!("{n} matchs"))
    })
    .await
}

/// Ancre persistée (`anchorRow`) : `video_ts` au centième, wallclock ISO.
fn anchor_row(a: &ResolvedAnchor) -> NewAnchor {
    let ms = (a.wall * 1000.0).trunc();
    let wallclock = Utc
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(crate::time::iso_utc)
        .unwrap_or_default();
    NewAnchor {
        period: a.period,
        clock_sec: a.clock_sec,
        video_ts: crate::js::round(a.video * 100.0) / 100.0,
        wallclock,
    }
}

/// `regenerateSubtitles` : (re)génère la VF d'un match — sélection et
/// traduction des actions, puis `video_ts` (ancres manuelles et OCR, audio
/// en repli, estimation par la durée, offsets manuels). Rend le nombre de
/// lignes ; `Err` reproduit une exception de Node.
pub fn regenerate_subtitles(
    c: &Connection,
    match_id: i64,
    plays_in: Option<Vec<PlayRow>>,
) -> rusqlite::Result<Result<usize, String>> {
    let Some(m) = db::get_match(c, match_id)? else {
        return Ok(Ok(0));
    };
    let plays = match plays_in {
        Some(p) => p,
        None => idb::get_plays(c, match_id)?,
    };
    if plays.is_empty() {
        return Ok(Ok(0));
    }
    let lines = vf::build_commentary(&plays, &m.home_abbr, &m.away_abbr);
    let tp = vs::to_timed_plays(
        plays
            .iter()
            .map(|p| (p.seq, p.period, p.clock_sec, p.wallclock.as_str())),
    );
    let breaks = vs::find_breaks(&tp);
    let duration = idb::video_duration(&m);

    // Ancres : manuelles + OCR en base ; audio seulement en repli (< 2 ancres fiables).
    let mut resolved: Vec<ResolvedAnchor> = Vec::new();
    for a in idb::get_anchors(c, match_id)? {
        if a.method == "audio" {
            continue;
        }
        if let Some(w) = vs::resolve_anchor_wall(a.period, a.clock_sec, a.wallclock.as_deref(), &tp)
        {
            resolved.push(ResolvedAnchor {
                wall: w,
                video: a.video_ts,
                method: a.method,
                period: a.period,
                clock_sec: a.clock_sec,
            });
        }
    }
    let profile = match idb::get_audio_profile(c, match_id)? {
        Ok(p) => p,
        Err(e) => return Ok(Err(e)),
    };
    if resolved.len() < 2 {
        if let (Some(p), Some(d)) = (profile, duration.filter(|d| *d != 0.0 && !d.is_nan())) {
            if p.ok_id.is_some() && p.ok_id == m.video_ok_id {
                if let Some(anchors) = p
                    .cuts
                    .as_deref()
                    .and_then(|cuts| vs::align_with_cuts(&tp, &breaks, cuts, d))
                {
                    let rows: Vec<NewAnchor> = anchors.iter().map(anchor_row).collect();
                    idb::replace_anchors_by_method(c, match_id, "audio", &rows)?;
                    resolved.extend(anchors);
                }
            }
        }
    }
    let mapping = vs::build_mapping(&tp, &breaks, &resolved, duration);
    let settings = idb::get_sync_settings(c, match_id)?;
    let timed = match vs::time_lines(
        lines,
        |l: &vf::CommentaryLine| (l.seq, l.period, l.wallclock.as_str(), l.hold),
        &mapping,
        &settings,
        duration,
    ) {
        Ok(t) => t,
        Err(e) => return Ok(Err(e.to_string())),
    };
    let subs: Vec<SubtitleRow> = timed
        .iter()
        .map(|t| SubtitleRow {
            seq: t.line.seq,
            video_ts: t.video_ts,
            end_ts: t.end_ts,
            text_fr: t.line.text_fr.clone(),
            speaker: t.line.speaker.clone(),
            kind: t.line.kind,
        })
        .collect();
    idb::replace_subtitles(c, match_id, &subs)?;
    Ok(Ok(subs.len()))
}

// ------------------------------------------------------------------ jeton /api/ingest

/// Dossier des données (`dataDir()` de Node) : `DATA_DIR`, sinon `/data`, sinon `./data`.
pub fn data_dir() -> std::path::PathBuf {
    match std::env::var("DATA_DIR") {
        Ok(d) if !d.is_empty() => d.into(),
        _ if std::path::Path::new("/data").exists() => "/data".into(),
        _ => std::env::current_dir().unwrap_or_default().join("data"),
    }
}

/// `ingestToken` : `INGEST_TOKEN`, sinon le fichier `ingest_token` (créé au besoin).
pub fn ingest_token() -> Result<String, String> {
    if let Ok(t) = std::env::var("INGEST_TOKEN") {
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let file = data_dir().join("ingest_token");
    if let Ok(b) = std::fs::read(&file) {
        return Ok(crate::js::trim(&String::from_utf8_lossy(&b)).to_string());
    }
    let mut bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    let t = hex::encode(bytes);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&file)
        .map_err(|e| e.to_string())?;
    f.write_all(t.as_bytes()).map_err(|e| e.to_string())?;
    Ok(t)
}

/// `checkIngestAuth` : `Bearer <jeton>`, comparaison en temps constant sur des empreintes.
pub fn check_ingest_auth(header: Option<&str>) -> Result<bool, String> {
    let expected = ingest_token()?;
    let raw = header.unwrap_or("");
    let got = crate::js::jsre!(r"^Bearer\s+", "i").replace(raw, "");
    let got = crate::js::trim(&got);
    if got.is_empty() {
        return Ok(false);
    }
    use sha2::{Digest, Sha256};
    use subtle::ConstantTimeEq;
    let a = Sha256::digest(got.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    Ok(a.ct_eq(&b).into())
}

/// `runJob` pour les jobs portés.
pub async fn run_job(
    db: &Db,
    replays: &crate::replay::Replays,
    name: &str,
    season: Option<f64>,
) -> Option<JobResult> {
    Some(match name {
        "sync-schedule" => sync_schedule(db).await,
        "sync-season" => {
            sync_season(db, season.unwrap_or_else(|| f64::from(current_season()))).await
        }
        "sync-stats" => sync_stats(db, 15).await,
        "sync-videos" => replays.sync_videos(db, 20).await.0,
        "sync-subtitles" => sync_subtitles(db, 50).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bornes_des_mois_comme_date_utc() {
        let (a, b) = month_bounds(2026, 8).unwrap();
        assert_eq!(
            (espn_date(a), espn_date(b)),
            ("20260901".into(), "20260930".into())
        );
        let (a, b) = month_bounds(2026, 11).unwrap();
        assert_eq!(
            (espn_date(a), espn_date(b)),
            ("20261201".into(), "20261231".into())
        );
        let (_, b) = month_bounds(2028, 1).unwrap();
        assert_eq!(espn_date(b), "20280229");
    }

    #[test]
    fn jeton_bearer() {
        std::env::set_var("INGEST_TOKEN", "secret-é");
        assert!(check_ingest_auth(Some("Bearer secret-é")).unwrap());
        assert!(check_ingest_auth(Some("bearer   secret-é  ")).unwrap());
        assert!(!check_ingest_auth(Some("Bearer autre")).unwrap());
        assert!(!check_ingest_auth(Some("Bearer ")).unwrap());
        assert!(!check_ingest_auth(None).unwrap());
    }
}
