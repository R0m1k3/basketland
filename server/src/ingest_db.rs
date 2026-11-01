//! Écritures et lectures de l'ingestion ESPN (équivalents de `upsertMatch(es)`,
//! `replaceStats`, `replacePlays`, `replaceSubtitles`, ancres, réglages de
//! synchro, profil audio, journal `ingest_log` de `src/lib/db.ts`) : mêmes
//! requêtes, mêmes transactions.
//!
//! Les nombres sont liés comme le fait `node:sqlite` (réels doubles) :
//! l'affinité des colonnes les convertit ensuite de la même façon.

use crate::db::{col, col_text, match_row, MatchRow};
use crate::espn_events::{LeaderRow, ParsedMatch, PlayRow, PlayerStatRow, TeamStatRow};
use crate::vf_sync::{AnchorRow, Cut, SyncSettings};
use rusqlite::types::Value as SqlValue;
use rusqlite::{named_params, params, Connection};
use serde_json::Value;

/// Nombre JavaScript lié comme par `node:sqlite` (NaN devient NULL).
fn num(n: f64) -> SqlValue {
    SqlValue::Real(n)
}

fn opt_num(n: Option<f64>) -> SqlValue {
    n.map(num).unwrap_or(SqlValue::Null)
}

fn now_iso() -> String {
    crate::time::iso_utc(chrono::Utc::now())
}

/// `tx` de `db.ts` : BEGIN … COMMIT, ROLLBACK en cas d'erreur.
fn tx<T>(c: &Connection, f: impl FnOnce() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    c.execute_batch("BEGIN")?;
    match f() {
        Ok(v) => {
            c.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Valeur SQLite lue → nombre JavaScript (`node:sqlite` rend INTEGER et REAL en `number`).
fn as_num(v: &SqlValue) -> Option<f64> {
    match v {
        SqlValue::Integer(i) => Some(*i as f64),
        SqlValue::Real(f) => Some(*f),
        SqlValue::Text(s) => Some(crate::api::js_number(s)),
        _ => None,
    }
}

// ---------------------------------------------------------------- matchs

const UPSERT_MATCH: &str = "INSERT INTO matches (id, espn_id, league, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name,
       home_score, away_score, status, status_detail, period, clock_display, venue, broadcast, created_at, updated_at)
     VALUES (:id, :espn_id, :league, :season, :season_type, :date_utc, :home_abbr, :home_name, :away_abbr, :away_name,
       :home_score, :away_score, :status, :status_detail, :period, :clock_display, :venue, :broadcast, :now, :now)
     ON CONFLICT(id) DO UPDATE SET
       season = excluded.season, season_type = excluded.season_type, date_utc = excluded.date_utc,
       home_abbr = excluded.home_abbr, home_name = excluded.home_name,
       away_abbr = excluded.away_abbr, away_name = excluded.away_name,
       home_score = excluded.home_score, away_score = excluded.away_score,
       status = excluded.status, status_detail = excluded.status_detail,
       period = excluded.period, clock_display = excluded.clock_display,
       venue = CASE WHEN excluded.venue <> '' THEN excluded.venue ELSE matches.venue END,
       broadcast = CASE WHEN excluded.broadcast <> '' THEN excluded.broadcast ELSE matches.broadcast END,
       updated_at = excluded.updated_at";

pub fn upsert_match(c: &Connection, m: &ParsedMatch) -> rusqlite::Result<()> {
    let mut st = c.prepare_cached(UPSERT_MATCH)?;
    st.execute(named_params! {
        ":id": num(m.id),
        ":espn_id": m.espn_id,
        ":league": m.league,
        ":season": num(m.season),
        ":season_type": m.season_type,
        ":date_utc": m.date_utc,
        ":home_abbr": m.home_abbr,
        ":home_name": m.home_name,
        ":away_abbr": m.away_abbr,
        ":away_name": m.away_name,
        ":home_score": opt_num(m.home_score),
        ":away_score": opt_num(m.away_score),
        ":status": m.status,
        ":status_detail": m.status_detail,
        ":period": num(m.period),
        ":clock_display": m.clock_display,
        ":venue": m.venue,
        ":broadcast": m.broadcast,
        ":now": now_iso(),
    })?;
    Ok(())
}

pub fn upsert_matches(c: &Connection, list: &[ParsedMatch]) -> rusqlite::Result<usize> {
    tx(c, || {
        for m in list {
            upsert_match(c, m)?;
        }
        Ok(())
    })?;
    Ok(list.len())
}

/// Notes ESPN des matchs (colonne `competition`, ajoutée par `migrate`) :
/// seules les notes présentes sont écrites (une fiche sans notes n'efface
/// pas celles du calendrier). Nombre de lignes modifiées.
pub fn save_notes(c: &Connection, list: &[ParsedMatch]) -> rusqlite::Result<usize> {
    tx(c, || {
        let mut st = c.prepare_cached(
            "UPDATE matches SET competition = ?1 WHERE id = ?2 AND IFNULL(competition, '') <> ?1",
        )?;
        let mut n = 0;
        for m in list.iter().filter(|m| !m.note.is_empty()) {
            n += st.execute(params![m.note, num(m.id)])?;
        }
        Ok(n)
    })
}

fn matches_where(
    c: &Connection,
    sql: &str,
    p: &[&dyn rusqlite::ToSql],
) -> rusqlite::Result<Vec<MatchRow>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map(p, match_row)?;
    rows.collect()
}

pub fn final_matches_needing_stats(c: &Connection, limit: i64) -> rusqlite::Result<Vec<MatchRow>> {
    matches_where(
        c,
        "SELECT * FROM matches WHERE status = 'final' AND stats_synced_at IS NULL ORDER BY date_utc DESC LIMIT ?1",
        &[&limit],
    )
}

pub fn live_matches(c: &Connection) -> rusqlite::Result<Vec<MatchRow>> {
    matches_where(
        c,
        "SELECT * FROM matches WHERE status = 'live' ORDER BY date_utc",
        &[],
    )
}

pub fn mark_stats_synced(c: &Connection, match_id: i64) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE matches SET stats_synced_at = ?1 WHERE id = ?2",
        params![now_iso(), match_id],
    )
    .map(|_| ())
}

// ---------------------------------------------------------------- stats

pub fn replace_stats(
    c: &Connection,
    match_id: i64,
    teams: &[TeamStatRow],
    players: &[PlayerStatRow],
    leaders: &[LeaderRow],
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute("DELETE FROM team_stats WHERE match_id = ?1", [match_id])?;
        c.execute("DELETE FROM player_stats WHERE match_id = ?1", [match_id])?;
        c.execute("DELETE FROM match_leaders WHERE match_id = ?1", [match_id])?;
        let mut ts = c.prepare(
            "INSERT INTO team_stats (match_id, team_abbr, stats_json) VALUES (?1, ?2, ?3)",
        )?;
        for t in teams {
            ts.execute(params![match_id, t.team_abbr, t.stats.to_string()])?;
        }
        let mut ps = c.prepare(
            "INSERT OR REPLACE INTO player_stats (match_id, team_abbr, player_id, player_name, position, jersey, starter, stats_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for p in players {
            ps.execute(params![
                match_id,
                p.team_abbr,
                p.player_id,
                p.player_name,
                p.position,
                p.jersey,
                num(p.starter),
                p.stats.to_string()
            ])?;
        }
        let mut ls = c.prepare(
            "INSERT OR REPLACE INTO match_leaders (match_id, team_abbr, category, label, player, value) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for l in leaders {
            ls.execute(params![
                match_id,
                l.team_abbr,
                l.category,
                l.label,
                l.player,
                l.value
            ])?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------- actions

pub fn replace_plays(c: &Connection, match_id: i64, plays: &[PlayRow]) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute("DELETE FROM plays WHERE match_id = ?1", [match_id])?;
        let mut st = c.prepare(
            "INSERT INTO plays (match_id, seq, period, clock_display, clock_sec, wallclock, event_type, text_en, actor, team_abbr,
         home_score, away_score, scoring, is_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for p in plays {
            st.execute(params![
                match_id,
                num(p.seq),
                num(p.period),
                p.clock_display,
                num(p.clock_sec),
                p.wallclock,
                p.event_type,
                p.text_en,
                p.actor,
                p.team_abbr,
                opt_num(p.home_score),
                opt_num(p.away_score),
                num(p.scoring),
                num(p.is_key)
            ])?;
        }
        Ok(())
    })
}

/// `getPlays` : actions d'un match par séquence (sans `score_value` ni `participants`).
pub fn get_plays(c: &Connection, match_id: i64) -> rusqlite::Result<Vec<PlayRow>> {
    let mut st = c.prepare("SELECT * FROM plays WHERE match_id = ?1 ORDER BY seq")?;
    let rows = st.query_map([match_id], |r| {
        let n = |k: &str| as_num(&col(r, k));
        let s = |k: &str| col_text(r, k).unwrap_or_default();
        Ok(PlayRow {
            match_id: n("match_id").unwrap_or(f64::NAN),
            seq: n("seq").unwrap_or(f64::NAN),
            period: n("period").unwrap_or(f64::NAN),
            clock_display: s("clock_display"),
            clock_sec: n("clock_sec").unwrap_or(f64::NAN),
            wallclock: s("wallclock"),
            event_type: s("event_type"),
            text_en: s("text_en"),
            actor: s("actor"),
            team_abbr: s("team_abbr"),
            home_score: n("home_score"),
            away_score: n("away_score"),
            scoring: n("scoring").unwrap_or(0.0),
            is_key: n("is_key").unwrap_or(0.0),
            score_value: None,
            participants: None,
        })
    })?;
    rows.collect()
}

// ---------------------------------------------------------------- sous-titres

/// Sous-titre à écrire (`Omit<SubtitleRow, 'match_id'>`).
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleRow {
    pub seq: f64,
    pub video_ts: f64,
    pub end_ts: f64,
    pub text_fr: String,
    pub speaker: String,
    pub kind: &'static str,
}

pub fn replace_subtitles(
    c: &Connection,
    match_id: i64,
    subs: &[SubtitleRow],
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute("DELETE FROM subtitles WHERE match_id = ?1", [match_id])?;
        let mut st = c.prepare(
            "INSERT INTO subtitles (match_id, seq, video_ts, end_ts, text_fr, speaker, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for s in subs {
            st.execute(params![
                match_id,
                num(s.seq),
                num(s.video_ts),
                num(s.end_ts),
                s.text_fr,
                s.speaker,
                s.kind
            ])?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------- synchro

pub fn get_anchors(c: &Connection, match_id: i64) -> rusqlite::Result<Vec<AnchorRow>> {
    let mut st = c.prepare("SELECT * FROM sync_anchors WHERE match_id = ?1 ORDER BY video_ts")?;
    let rows = st.query_map([match_id], |r| {
        let n = |k: &str| as_num(&col(r, k)).unwrap_or(f64::NAN);
        Ok(AnchorRow {
            period: n("period"),
            clock_sec: n("clock_sec"),
            video_ts: n("video_ts"),
            method: col_text(r, "method").unwrap_or_default(),
            wallclock: col_text(r, "wallclock"),
        })
    })?;
    rows.collect()
}

/// Ancre à écrire (`AnchorRow` de `anchorRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct NewAnchor {
    pub period: f64,
    pub clock_sec: f64,
    pub video_ts: f64,
    pub wallclock: String,
}

/// `replaceAnchorsByMethod` : remplace les ancres d'une méthode (jamais les manuelles).
pub fn replace_anchors_by_method(
    c: &Connection,
    match_id: i64,
    method: &str,
    anchors: &[NewAnchor],
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute(
            "DELETE FROM sync_anchors WHERE match_id = ?1 AND method = ?2",
            params![match_id, method],
        )?;
        let mut st = c.prepare(
            "INSERT OR IGNORE INTO sync_anchors (match_id, period, clock_sec, video_ts, method, wallclock) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for a in anchors {
            st.execute(params![
                match_id,
                num(a.period),
                num(a.clock_sec),
                num(a.video_ts),
                method,
                a.wallclock
            ])?;
        }
        Ok(())
    })
}

/// `getSyncSettings` : offsets manuels (zéro et `{}` sans réglage, ou JSON illisible).
pub fn get_sync_settings(c: &Connection, match_id: i64) -> rusqlite::Result<SyncSettings> {
    let mut st = c.prepare("SELECT * FROM sync_settings WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id], |r| {
        Ok((
            as_num(&col(r, "global_offset")).unwrap_or(f64::NAN),
            col_text(r, "quarter_offsets_json"),
        ))
    })?;
    let Some((g, q)) = rows.next().transpose()? else {
        return Ok(SyncSettings {
            global_offset: 0.0,
            quarter_offsets: Value::Object(Default::default()),
        });
    };
    let q = q
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| Value::Object(Default::default()));
    Ok(SyncSettings {
        global_offset: g,
        quarter_offsets: q,
    })
}

/// Profil audio utile à la synchro (`getAudioProfile`).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioProfile {
    pub ok_id: Option<String>,
    /// `None` : `cuts_json` n'est pas un tableau (`!cuts.length`).
    pub cuts: Option<Vec<Cut>>,
}

/// `getAudioProfile` : comme `JSON.parse`, un JSON illisible est une erreur.
pub fn get_audio_profile(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Result<Option<AudioProfile>, String>> {
    let mut st = c.prepare("SELECT * FROM audio_profiles WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id], |r| {
        Ok((
            col_text(r, "ok_id"),
            col_text(r, "rms_db_json"),
            col_text(r, "cuts_json"),
        ))
    })?;
    let Some((ok_id, rms, cuts)) = rows.next().transpose()? else {
        return Ok(Ok(None));
    };
    let parse = |s: Option<String>| -> Result<Value, String> {
        serde_json::from_str::<Value>(s.as_deref().unwrap_or("null"))
            .map_err(|e| format!("JSON du profil audio illisible : {e}"))
    };
    if let Err(e) = parse(rms) {
        return Ok(Err(e));
    }
    let cuts = match parse(cuts) {
        Ok(Value::Array(a)) => Some(a.iter().map(Cut::from_json).collect()),
        Ok(_) => None,
        Err(e) => return Ok(Err(e)),
    };
    Ok(Ok(Some(AudioProfile { ok_id, cuts })))
}

// ---------------------------------------------------------------- journal

pub fn log_ingest_start(c: &Connection, task: &str) -> rusqlite::Result<i64> {
    c.execute(
        "INSERT INTO ingest_log (task, started_at) VALUES (?1, ?2)",
        params![task, now_iso()],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn log_ingest_end(c: &Connection, id: i64, ok: bool, detail: &str) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE ingest_log SET finished_at = ?1, ok = ?2, detail = ?3 WHERE id = ?4",
        params![
            now_iso(),
            i64::from(ok),
            crate::js::slice_utf16(detail, 2000),
            id
        ],
    )
    .map(|_| ())
}

/// Durée de la vidéo d'un match (`video_duration`), nombre ou absente.
pub fn video_duration(m: &MatchRow) -> Option<f64> {
    match m.video_duration {
        SqlValue::Integer(i) => Some(i as f64),
        SqlValue::Real(f) => Some(f),
        _ => None,
    }
}

// ---------------------------------------------------------------- replays

/// Bornes (ISO) de `finalMatchesNeedingVideo` (`ReplayRecheckWindow`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayRecheckWindow {
    /// Coup d'envoi au plus tôt (21 jours).
    pub since: String,
    /// Coup d'envoi au plus tôt pour être « récent » (fin estimée < 12 h).
    pub recent_since: String,
    /// Match récent sans replay : vérifié avant cette date → à revérifier.
    pub recent_recheck_before: String,
    /// Autres : vérifié avant cette date → à revérifier.
    pub recheck_before: String,
}

/// `finalMatchesNeedingVideo` : matchs terminés sans replay (ou en MP4 seul)
/// dont la dernière vérification est assez ancienne, les plus récents d'abord.
pub fn final_matches_needing_video(
    c: &Connection,
    w: &ReplayRecheckWindow,
    limit: i64,
) -> rusqlite::Result<Vec<MatchRow>> {
    let mut st = c.prepare(
        "SELECT * FROM matches WHERE status = 'final' AND (video_available = 0 OR video_kind = 'mp4') AND date_utc >= :since
       AND (video_checked_at IS NULL OR video_checked_at < :recheck
            OR (video_available = 0 AND date_utc >= :recentSince AND video_checked_at < :recentRecheck))
     ORDER BY date_utc DESC LIMIT :limit",
    )?;
    let rows = st.query_map(
        named_params! {
            ":since": w.since,
            ":recheck": w.recheck_before,
            ":recentSince": w.recent_since,
            ":recentRecheck": w.recent_recheck_before,
            ":limit": limit,
        },
        match_row,
    )?;
    rows.collect()
}

/// Replay à enregistrer (`setVideo`).
#[derive(Debug, Clone, PartialEq)]
pub struct VideoUpdate {
    pub slug: Option<String>,
    pub ok_id: Option<String>,
    pub duration: Option<f64>,
    pub available: bool,
    pub kind: Option<&'static str>,
}

/// `setVideo` : pas de type sans replay lisible (`hls` par défaut sinon).
pub fn set_video(c: &Connection, match_id: i64, v: &VideoUpdate) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE matches SET slug = :slug, video_ok_id = :okId, video_duration = :duration, video_available = :available,
       video_kind = :kind, video_checked_at = :now, updated_at = :now WHERE id = :id",
        named_params! {
            ":id": match_id,
            ":slug": v.slug,
            ":okId": v.ok_id,
            ":duration": opt_num(v.duration),
            ":available": num(if v.available { 1.0 } else { 0.0 }),
            ":kind": if v.available { Some(v.kind.unwrap_or("hls")) } else { None },
            ":now": now_iso(),
        },
    )
    .map(|_| ())
}

/// `markVideoChecked`.
pub fn mark_video_checked(c: &Connection, match_id: i64) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE matches SET video_checked_at = ?1 WHERE id = ?2",
        params![now_iso(), match_id],
    )
    .map(|_| ())
}
