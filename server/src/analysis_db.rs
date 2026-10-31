//! Requêtes de `db.ts` propres à l'analyse vidéo et au calage manuel
//! (étape 7, non branchées) : matchs à analyser, ancres, offsets, profil
//! audio — mêmes requêtes et mêmes valeurs liées que Node (nombres liés en
//! réels, comme `node:sqlite`).

use crate::api::js_num_value;
use crate::db::{col, col_text, match_row, sql_to_json, MatchRow};
use crate::media::audio::CutInterval;
use rusqlite::types::Value as SqlValue;
use rusqlite::{named_params, params, Connection};
use serde_json::{Map, Value};

fn now_iso() -> String {
    crate::time::iso_utc(chrono::Utc::now())
}

/// `finalMatchesNeedingAnalysis` : matchs terminés récents avec replay HLS, sans ancre OCR.
pub fn final_matches_needing_analysis(
    c: &Connection,
    since_iso: &str,
    limit: i64,
) -> rusqlite::Result<Vec<MatchRow>> {
    let mut st = c.prepare(
        "SELECT * FROM matches m WHERE m.status = 'final' AND m.video_available = 1 AND m.video_ok_id IS NOT NULL
       AND COALESCE(m.video_kind, 'hls') = 'hls'
       AND m.date_utc >= :since
       AND NOT EXISTS (SELECT 1 FROM sync_anchors a WHERE a.match_id = m.id AND a.method = 'auto')
     ORDER BY m.date_utc DESC LIMIT :limit",
    )?;
    let rows = st.query_map(
        named_params! { ":since": since_iso, ":limit": limit as f64 },
        match_row,
    )?;
    rows.collect()
}

/// Ancre à écrire (`AnchorRow` de `upsertAnchor`).
#[derive(Debug, Clone, PartialEq)]
pub struct AnchorInput {
    pub match_id: i64,
    pub period: f64,
    pub clock_sec: f64,
    pub video_ts: f64,
    pub method: String,
    pub wallclock: Option<String>,
}

/// `upsertAnchor`.
pub fn upsert_anchor(c: &Connection, a: &AnchorInput) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO sync_anchors (match_id, period, clock_sec, video_ts, method, wallclock) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(match_id, period, clock_sec) DO UPDATE SET video_ts = excluded.video_ts, method = excluded.method, wallclock = excluded.wallclock",
        params![
            a.match_id as f64,
            a.period,
            a.clock_sec,
            a.video_ts,
            a.method,
            a.wallclock
        ],
    )
    .map(|_| ())
}

/// `deleteAnchor`.
pub fn delete_anchor(
    c: &Connection,
    match_id: i64,
    period: f64,
    clock_sec: f64,
) -> rusqlite::Result<()> {
    c.execute(
        "DELETE FROM sync_anchors WHERE match_id = ?1 AND period = ?2 AND clock_sec = ?3",
        params![match_id as f64, period, clock_sec],
    )
    .map(|_| ())
}

/// `clearAnchors` : supprime les ancres des méthodes données.
pub fn clear_anchors(c: &Connection, match_id: i64, methods: &[&str]) -> rusqlite::Result<()> {
    for m in methods {
        c.execute(
            "DELETE FROM sync_anchors WHERE match_id = ?1 AND method = ?2",
            params![match_id as f64, m],
        )?;
    }
    Ok(())
}

/// Ancres d'un match telles que les rend `getAnchors` (toutes les colonnes, par `video_ts`).
pub fn anchors_json(c: &Connection, match_id: i64) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare("SELECT * FROM sync_anchors WHERE match_id = ?1 ORDER BY video_ts")?;
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let rows = st.query_map([match_id], |r| {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_to_json(r.get::<_, SqlValue>(i)?));
        }
        Ok(Value::Object(m))
    })?;
    rows.collect()
}

/// `getSyncSettings` en objet de Node (`{ match_id, global_offset, quarter_offsets, updated_at }`).
pub fn sync_settings_json(c: &Connection, match_id: i64) -> rusqlite::Result<Value> {
    let mut st = c.prepare("SELECT * FROM sync_settings WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id], |r| {
        Ok((
            sql_to_json(col(r, "global_offset")),
            col_text(r, "quarter_offsets_json"),
            sql_to_json(col(r, "updated_at")),
        ))
    })?;
    let mut m = Map::new();
    m.insert("match_id".into(), Value::from(match_id));
    match rows.next().transpose()? {
        None => {
            m.insert("global_offset".into(), Value::from(0));
            m.insert("quarter_offsets".into(), Value::Object(Map::new()));
            m.insert("updated_at".into(), Value::from(""));
        }
        Some((g, q, at)) => {
            // `JSON.parse(...) ?? {}` ; JSON illisible : `{}`.
            let q = q
                .as_deref()
                .and_then(crate::jsval::js_parse)
                .filter(|v| !v.is_null())
                .unwrap_or_else(|| Value::Object(Map::new()));
            m.insert("global_offset".into(), g);
            m.insert("quarter_offsets".into(), q);
            m.insert("updated_at".into(), at);
        }
    }
    Ok(Value::Object(m))
}

/// `saveSyncSettings` : enregistre les offsets ; `quarter_offsets` est écrit
/// comme `JSON.stringify` (clés numériques en tête, par ordre croissant).
pub fn save_sync_settings(
    c: &Connection,
    match_id: i64,
    global_offset: f64,
    quarter_offsets: &Map<String, Value>,
) -> rusqlite::Result<()> {
    let q = crate::jsval::js_normalize(Value::Object(quarter_offsets.clone()));
    c.execute(
        "INSERT INTO sync_settings (match_id, global_offset, quarter_offsets_json, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(match_id) DO UPDATE SET global_offset = excluded.global_offset, quarter_offsets_json = excluded.quarter_offsets_json, updated_at = excluded.updated_at",
        params![match_id as f64, global_offset, q.to_string(), now_iso()],
    )
    .map(|_| ())
}

/// Résumé du profil audio pour l'API (`analyzed_at`, secondes, coupures telles qu'enregistrées).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioSummary {
    pub analyzed_at: Value,
    pub seconds: usize,
    pub cuts: Value,
}

/// `getAudioProfile` réduit à ce qu'expose `GET /api/matches/[id]/sync` ;
/// `Err` : JSON illisible (`JSON.parse` lève une exception côté Node).
pub fn audio_summary(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Result<Option<AudioSummary>, String>> {
    let mut st = c.prepare("SELECT * FROM audio_profiles WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id], |r| {
        Ok((
            sql_to_json(col(r, "analyzed_at")),
            col_text(r, "rms_db_json"),
            col_text(r, "cuts_json"),
        ))
    })?;
    let Some((at, rms, cuts)) = rows.next().transpose()? else {
        return Ok(Ok(None));
    };
    let parse = |s: Option<String>| {
        crate::jsval::js_parse(s.as_deref().unwrap_or("null"))
            .ok_or_else(|| "JSON du profil audio illisible".to_string())
    };
    let rms = match parse(rms) {
        Ok(v) => v,
        Err(e) => return Ok(Err(e)),
    };
    let cuts = match parse(cuts) {
        Ok(v) => v,
        Err(e) => return Ok(Err(e)),
    };
    let seconds = match &rms {
        Value::Array(a) => a.len(),
        Value::String(s) => s.encode_utf16().count(),
        _ => 0,
    };
    Ok(Ok(Some(AudioSummary {
        analyzed_at: at,
        seconds,
        cuts,
    })))
}

/// Coupure audio en objet de Node (`{ start, end, meanDb }`).
pub fn cut_json(c: &CutInterval) -> Value {
    let mut m = Map::new();
    m.insert("start".into(), js_num_value(c.start));
    m.insert("end".into(), js_num_value(c.end));
    m.insert("meanDb".into(), js_num_value(c.mean_db));
    Value::Object(m)
}

/// `saveAudioProfile`.
pub fn save_audio_profile(
    c: &Connection,
    match_id: i64,
    ok_id: &str,
    window_sec: f64,
    rms_db: &[f64],
    cuts: &[CutInterval],
) -> rusqlite::Result<()> {
    let rms = Value::Array(rms_db.iter().map(|v| js_num_value(*v)).collect());
    let cuts = Value::Array(cuts.iter().map(cut_json).collect());
    c.execute(
        "INSERT OR REPLACE INTO audio_profiles (match_id, ok_id, window_sec, rms_db_json, cuts_json, analyzed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![match_id as f64, ok_id, window_sec, rms.to_string(), cuts.to_string(), now_iso()],
    )
    .map(|_| ())
}
