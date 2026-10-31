//! Tables de la traduction des commentaires (`commentary_tracks`,
//! `commentary_cues`, `commentary_chunks`) : section « traduction des
//! commentaires » et « traduction à la demande » de `src/lib/db.ts`, mêmes
//! requêtes, mêmes transactions (BEGIN … COMMIT).
//!
//! Les nombres sont liés en réels doubles comme le fait `node:sqlite`
//! (l'affinité des colonnes les convertit ensuite de la même façon).

use crate::db::{col, col_int, col_text, match_row, MatchRow};
use rusqlite::types::Value as SqlValue;
use rusqlite::{named_params, Connection, Row};
use std::collections::{HashMap, HashSet};

pub(crate) fn now_iso() -> String {
    crate::time::iso_utc(chrono::Utc::now())
}

/// `tx` de `db.ts` : BEGIN … COMMIT, ROLLBACK en cas d'erreur.
pub(crate) fn tx<T>(
    c: &Connection,
    f: impl FnOnce() -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
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

pub(crate) fn num(v: &SqlValue) -> f64 {
    match v {
        SqlValue::Integer(i) => *i as f64,
        SqlValue::Real(f) => *f,
        SqlValue::Text(s) => crate::api::js_number(s),
        _ => 0.0,
    }
}

fn opt_num(v: &SqlValue) -> Option<f64> {
    match v {
        SqlValue::Null => None,
        v => Some(num(v)),
    }
}

/// Sous-titre traduit en base (`CommentaryCueRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryCueRow {
    pub match_id: i64,
    pub seq: i64,
    pub start_ts: f64,
    pub end_ts: f64,
    pub text_en: String,
    pub text_fr: String,
    pub untranslated: i64,
    /// 0 ton normal, 1 voix qui monte, 2 moment fort.
    pub emphasis: i64,
}

fn cue_row(r: &Row) -> rusqlite::Result<CommentaryCueRow> {
    Ok(CommentaryCueRow {
        match_id: col_int(r, "match_id").unwrap_or(0),
        seq: col_int(r, "seq").unwrap_or(0),
        start_ts: num(&col(r, "start_ts")),
        end_ts: num(&col(r, "end_ts")),
        text_en: col_text(r, "text_en").unwrap_or_default(),
        text_fr: col_text(r, "text_fr").unwrap_or_default(),
        untranslated: col_int(r, "untranslated").unwrap_or(0),
        emphasis: col_int(r, "emphasis").unwrap_or(0),
    })
}

/// Sous-titre à publier (`CueInput` : ligne sans `match_id`).
#[derive(Debug, Clone, PartialEq)]
pub struct CueInput {
    pub seq: i64,
    pub start_ts: f64,
    pub end_ts: f64,
    pub text_en: String,
    pub text_fr: String,
    /// Vrai (non nul) : ligne restée en anglais.
    pub untranslated: bool,
    pub emphasis: f64,
}

/// Piste traduite d'un match (`CommentaryTrackRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryTrackRow {
    pub match_id: i64,
    pub ok_id: String,
    pub transcribe_model: String,
    pub translate_model: String,
    pub cues: i64,
    pub untranslated: i64,
    pub created_at: String,
    /// 1 : tout le match est traduit ; 0 : publication partielle.
    pub complete: i64,
    /// Durée d'un tronçon (s) ; `None` pour une piste antérieure à la traduction à la demande.
    pub chunk_sec: Option<f64>,
    pub chunks_total: Option<f64>,
}

fn track_row(r: &Row) -> rusqlite::Result<CommentaryTrackRow> {
    Ok(CommentaryTrackRow {
        match_id: col_int(r, "match_id").unwrap_or(0),
        ok_id: col_text(r, "ok_id").unwrap_or_default(),
        transcribe_model: col_text(r, "transcribe_model").unwrap_or_default(),
        translate_model: col_text(r, "translate_model").unwrap_or_default(),
        cues: col_int(r, "cues").unwrap_or(0),
        untranslated: col_int(r, "untranslated").unwrap_or(0),
        created_at: col_text(r, "created_at").unwrap_or_default(),
        complete: col_int(r, "complete").unwrap_or(0),
        chunk_sec: opt_num(&col(r, "chunk_sec")),
        chunks_total: opt_num(&col(r, "chunks_total")),
    })
}

/// Métadonnées d'une piste (`CommentaryTrackMeta`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryTrackMeta {
    pub ok_id: String,
    pub transcribe_model: String,
    pub translate_model: String,
    pub chunk_sec: Option<f64>,
    pub chunks_total: Option<f64>,
}

fn insert_cues(c: &Connection, match_id: i64, cues: &[CueInput]) -> rusqlite::Result<()> {
    let mut st = c.prepare(
        "INSERT OR REPLACE INTO commentary_cues (match_id, seq, start_ts, end_ts, text_en, text_fr, untranslated, emphasis)
     VALUES (:m, :seq, :start, :end, :en, :fr, :u, :e)",
    )?;
    for q in cues {
        st.execute(named_params! {
            ":m": match_id as f64,
            ":seq": q.seq as f64,
            ":start": q.start_ts,
            ":end": q.end_ts,
            ":en": q.text_en,
            ":fr": q.text_fr,
            ":u": if q.untranslated { 1.0 } else { 0.0 },
            ":e": crate::js::max(0.0, crate::js::min(2.0, crate::js::round(q.emphasis))),
        })?;
    }
    Ok(())
}

/// `writeTrack` : métadonnées de la piste ; compteurs recalculés sur les sous-titres en base.
fn write_track(
    c: &Connection,
    match_id: i64,
    t: &CommentaryTrackMeta,
    complete: bool,
) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR REPLACE INTO commentary_tracks (match_id, ok_id, transcribe_model, translate_model, cues, untranslated, created_at, complete, chunk_sec, chunks_total)
     SELECT :m, :ok, :tm, :lm, COUNT(*), COALESCE(SUM(untranslated != 0), 0), :now, :c, :cs, :ct FROM commentary_cues WHERE match_id = :m",
        named_params! {
            ":m": match_id as f64,
            ":ok": t.ok_id,
            ":tm": t.transcribe_model,
            ":lm": t.translate_model,
            ":now": now_iso(),
            ":c": if complete { 1.0 } else { 0.0 },
            ":cs": t.chunk_sec,
            ":ct": t.chunks_total,
        },
    )
    .map(|_| ())
}

/// `chunkSeqBase` : premier seq des sous-titres du tronçon `idx`.
pub fn chunk_seq_base(idx: usize) -> i64 {
    (idx as i64 + 1) * 100_000
}

/// `openCommentaryTrack` : ouvre (ou reprend) la piste d'un match. Autre
/// vidéo, autres modèles, autre découpage — ou `fresh` : tout est effacé
/// (doublage compris). Rend les index des tronçons déjà publiés.
pub fn open_commentary_track(
    c: &Connection,
    match_id: i64,
    track: &CommentaryTrackMeta,
    fresh: bool,
) -> rusqlite::Result<HashSet<usize>> {
    tx(c, || {
        let prev = get_commentary_track(c, match_id)?;
        let same = prev.as_ref().is_some_and(|p| {
            p.ok_id == track.ok_id
                && p.transcribe_model == track.transcribe_model
                && p.translate_model == track.translate_model
                && p.chunk_sec == track.chunk_sec
                && p.chunks_total == track.chunks_total
        });
        if !same || fresh {
            for sql in [
                "DELETE FROM commentary_cues WHERE match_id = ?1",
                "DELETE FROM commentary_chunks WHERE match_id = ?1",
                "DELETE FROM commentary_tracks WHERE match_id = ?1",
                // Sous-titres refaits de zéro : le doublage qui les disait n'est plus valable.
                "DELETE FROM dub_chunks WHERE match_id = ?1",
                "UPDATE dub_tracks SET complete = 0 WHERE match_id = ?1",
            ] {
                c.execute(sql, [match_id as f64])?;
            }
            return Ok(HashSet::new());
        }
        let mut st = c.prepare("SELECT idx FROM commentary_chunks WHERE match_id = ?1")?;
        let rows = st.query_map([match_id as f64], |r| Ok(col_int(r, "idx").unwrap_or(0)))?;
        rows.map(|r| r.map(|i| i as usize)).collect()
    })
}

/// Tronçon publié (`{ idx, keepFrom, keepTo }`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PublishedChunk {
    pub idx: usize,
    pub keep_from: f64,
    pub keep_to: f64,
}

/// `publishCommentaryChunk` : publie les sous-titres d'UN tronçon (remplace
/// les siens), le marque fait, et marque la piste complète quand tous les
/// tronçons le sont. Rend `(faits, complète)`.
pub fn publish_commentary_chunk(
    c: &Connection,
    match_id: i64,
    track: &CommentaryTrackMeta,
    chunk: PublishedChunk,
    cues: &[CueInput],
) -> rusqlite::Result<(i64, bool)> {
    tx(c, || {
        let base = chunk_seq_base(chunk.idx) as f64;
        c.execute(
            "DELETE FROM commentary_cues WHERE match_id = ?1 AND seq >= ?2 AND seq < ?3",
            [match_id as f64, base, base + 100_000.0],
        )?;
        insert_cues(c, match_id, cues)?;
        // Tronçon (re)traduit : son doublage éventuel disait les anciens sous-titres, il sera refait.
        c.execute(
            "DELETE FROM dub_chunks WHERE match_id = ?1 AND idx = ?2",
            [match_id as f64, chunk.idx as f64],
        )?;
        c.execute(
            "UPDATE dub_tracks SET complete = 0 WHERE match_id = ?1",
            [match_id as f64],
        )?;
        c.execute(
            "INSERT OR REPLACE INTO commentary_chunks (match_id, idx, keep_from, keep_to) VALUES (?1, ?2, ?3, ?4)",
            [
                match_id as f64,
                chunk.idx as f64,
                chunk.keep_from,
                if chunk.keep_to.is_finite() {
                    chunk.keep_to
                } else {
                    1e9
                },
            ],
        )?;
        let done: i64 = c.query_row(
            "SELECT COUNT(*) AS n FROM commentary_chunks WHERE match_id = ?1",
            [match_id as f64],
            |r| r.get(0),
        )?;
        let complete = track
            .chunks_total
            .is_some_and(|t| t != 0.0 && !t.is_nan() && done as f64 >= t);
        write_track(c, match_id, track, complete)?;
        Ok((done, complete))
    })
}

/// `commentaryCoverage` : plages couvertes par des tronçons publiés, fusionnées.
pub fn commentary_coverage(c: &Connection, match_id: i64) -> rusqlite::Result<Vec<[f64; 2]>> {
    let mut st = c.prepare(
        "SELECT keep_from, keep_to FROM commentary_chunks WHERE match_id = ?1 ORDER BY keep_from",
    )?;
    let rows = st.query_map([match_id as f64], |r| {
        Ok((num(&col(r, "keep_from")), num(&col(r, "keep_to"))))
    })?;
    let mut out: Vec<[f64; 2]> = Vec::new();
    for r in rows {
        let (a, b) = r?;
        match out.last_mut() {
            Some(last) if a <= last[1] + 0.5 => last[1] = crate::js::max(last[1], b),
            _ => out.push([a, b]),
        }
    }
    Ok(out)
}

/// `commentaryCuesBefore` : anglais des sous-titres qui précèdent `t` de
/// moins de `window` secondes (30 par défaut), dans l'ordre de la vidéo.
pub fn commentary_cues_before(
    c: &Connection,
    match_id: i64,
    t: f64,
    limit: usize,
    window: Option<f64>,
) -> rusqlite::Result<Vec<String>> {
    let w = window.unwrap_or(30.0);
    let mut st = c.prepare(
        "SELECT text_en FROM commentary_cues WHERE match_id = :id AND start_ts < :t AND start_ts >= :from ORDER BY start_ts DESC LIMIT :n",
    )?;
    let rows = st.query_map(
        named_params! { ":id": match_id as f64, ":t": t, ":from": t - w, ":n": limit as f64 },
        |r| Ok(col_text(r, "text_en").unwrap_or_default()),
    )?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    out.reverse();
    Ok(out)
}

/// Avancement de la VF d'un match pour les badges (`commentaryProgressByIds`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackProgress {
    pub complete: bool,
    pub done: i64,
    pub total: f64,
}

fn ids_json(ids: &[i64]) -> String {
    let mut seen = Vec::new();
    for i in ids {
        if !seen.contains(i) {
            seen.push(*i);
        }
    }
    serde_json::to_string(&seen).unwrap_or_else(|_| "[]".into())
}

/// `commentaryProgressByIds` : piste du replay ACTUEL, complète ou part traduite.
pub fn commentary_progress_by_ids(
    c: &Connection,
    ids: &[i64],
) -> rusqlite::Result<HashMap<i64, TrackProgress>> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut st = c.prepare(
        "SELECT t.match_id, t.complete, t.chunks_total, (SELECT COUNT(*) FROM commentary_chunks c WHERE c.match_id = t.match_id) AS done
       FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
      WHERE t.ok_id = m.video_ok_id AND t.cues > 0 AND t.match_id IN (SELECT value FROM json_each(?1))",
    )?;
    let rows = st.query_map([ids_json(ids)], |r| {
        Ok((
            col_int(r, "match_id").unwrap_or(0),
            TrackProgress {
                complete: col_int(r, "complete") == Some(1),
                done: col_int(r, "done").unwrap_or(0),
                total: opt_num(&col(r, "chunks_total")).unwrap_or(0.0),
            },
        ))
    })?;
    for r in rows {
        let (id, p) = r?;
        out.insert(id, p);
    }
    Ok(out)
}

/// `replaceCommentary` : remplace d'un bloc la piste (sous-titres et
/// métadonnées), marquée complète.
pub fn replace_commentary(
    c: &Connection,
    match_id: i64,
    track: &CommentaryTrackMeta,
    cues: &[CueInput],
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute(
            "DELETE FROM commentary_cues WHERE match_id = ?1",
            [match_id as f64],
        )?;
        c.execute(
            "DELETE FROM commentary_chunks WHERE match_id = ?1",
            [match_id as f64],
        )?;
        insert_cues(c, match_id, cues)?;
        write_track(c, match_id, track, true)
    })
}

pub fn get_commentary_track(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Option<CommentaryTrackRow>> {
    let mut st = c.prepare("SELECT * FROM commentary_tracks WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id as f64], track_row)?;
    rows.next().transpose()
}

fn cues_query(c: &Connection, sql: &str, match_id: i64) -> rusqlite::Result<Vec<CommentaryCueRow>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map([match_id as f64], cue_row)?;
    rows.collect()
}

pub fn get_commentary_cues(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Vec<CommentaryCueRow>> {
    cues_query(
        c,
        "SELECT * FROM commentary_cues WHERE match_id = ?1 ORDER BY start_ts, seq",
        match_id,
    )
}

/// Sous-titres publiés restés en anglais, dans l'ordre de la vidéo.
pub fn untranslated_commentary_cues(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Vec<CommentaryCueRow>> {
    cues_query(
        c,
        "SELECT * FROM commentary_cues WHERE match_id = ?1 AND untranslated != 0 ORDER BY start_ts, seq",
        match_id,
    )
}

/// `setCommentaryCueTranslation` : traduction enfin trouvée ; compte de la
/// piste recalculé, doublage à refaire.
pub fn set_commentary_cue_translation(
    c: &Connection,
    match_id: i64,
    seq: i64,
    text_fr: &str,
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute(
            "UPDATE commentary_cues SET text_fr = :fr, untranslated = 0 WHERE match_id = :id AND seq = :seq",
            named_params! { ":id": match_id as f64, ":seq": seq as f64, ":fr": text_fr },
        )?;
        c.execute(
            "UPDATE commentary_tracks SET untranslated = (SELECT COUNT(*) FROM commentary_cues WHERE match_id = ?1 AND untranslated != 0) WHERE match_id = ?1",
            [match_id as f64],
        )?;
        c.execute(
            "UPDATE dub_tracks SET complete = 0 WHERE match_id = ?1",
            [match_id as f64],
        )?;
        Ok(())
    })
}

/// `commentaryPublishedUntil` : fin du dernier sous-titre en base, 0 sans sous-titre.
pub fn commentary_published_until(c: &Connection, match_id: i64) -> rusqlite::Result<f64> {
    c.query_row(
        "SELECT MAX(end_ts) AS t FROM commentary_cues WHERE match_id = ?1",
        [match_id as f64],
        |r| Ok(opt_num(&r.get::<_, SqlValue>(0)?).unwrap_or(0.0)),
    )
}

/// `commentaryReadyIds` : matchs dont la piste du replay ACTUEL est complète.
pub fn commentary_ready_ids(c: &Connection, ids: &[i64]) -> rusqlite::Result<HashSet<i64>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let mut st = c.prepare(
        "SELECT t.match_id FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
       WHERE t.ok_id = m.video_ok_id AND t.cues > 0 AND t.complete = 1 AND t.match_id IN (SELECT value FROM json_each(?1))",
    )?;
    let rows = st.query_map([ids_json(ids)], |r| Ok(col_int(r, "match_id").unwrap_or(0)))?;
    rows.collect()
}

fn matches_query(
    c: &Connection,
    sql: &str,
    params: &[(&str, &dyn rusqlite::ToSql)],
) -> rusqlite::Result<Vec<MatchRow>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map(params, match_row)?;
    rows.collect()
}

/// `finalMatchesNeedingCommentary` : matchs terminés récents avec replay, sans
/// piste COMPLÈTE pour la vidéo actuelle (ou faite par un autre modèle de
/// traduction, si `translate_model` est donné).
pub fn final_matches_needing_commentary(
    c: &Connection,
    since_iso: &str,
    limit: i64,
    translate_model: Option<&str>,
) -> rusqlite::Result<Vec<MatchRow>> {
    matches_query(
        c,
        "SELECT * FROM matches m WHERE m.status = 'final' AND m.video_available = 1 AND m.video_ok_id IS NOT NULL
       AND m.date_utc >= :since
       AND NOT EXISTS (SELECT 1 FROM commentary_tracks t WHERE t.match_id = m.id AND t.ok_id = m.video_ok_id AND t.complete = 1
                         AND (:model IS NULL OR t.translate_model = :model))
     ORDER BY m.date_utc DESC LIMIT :limit",
        named_params! { ":since": since_iso, ":limit": limit as f64, ":model": translate_model },
    )
}

/// `finalMatchesWithUntranslatedCues` : pistes complètes du replay actuel avec des lignes restées en anglais.
pub fn final_matches_with_untranslated_cues(
    c: &Connection,
    since_iso: &str,
    limit: i64,
) -> rusqlite::Result<Vec<MatchRow>> {
    matches_query(
        c,
        "SELECT m.* FROM matches m JOIN commentary_tracks t ON t.match_id = m.id
     WHERE m.status = 'final' AND m.video_available = 1 AND m.date_utc >= :since
       AND t.ok_id = m.video_ok_id AND t.complete = 1 AND t.untranslated > 0
     ORDER BY m.date_utc DESC LIMIT :limit",
        named_params! { ":since": since_iso, ":limit": limit as f64 },
    )
}

/// Tronçon publié de la traduction (`CommentaryChunkRow` ; `keep_to` = 1e9 pour le dernier).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CommentaryChunkRow {
    pub idx: i64,
    pub keep_from: f64,
    pub keep_to: f64,
}

/// `commentaryKey` : identité d'une piste traduite (vidéo, modèles,
/// découpage) ; un doublage fait pour une autre clé est à refaire.
pub fn commentary_key(t: &CommentaryTrackRow) -> String {
    format!(
        "{}|{}|{}|{}",
        t.ok_id,
        t.transcribe_model,
        t.translate_model,
        t.chunk_sec
            .map(crate::jsval::js_number_string)
            .unwrap_or_default()
    )
}

/// `getCommentaryChunks` : tronçons publiés, dans l'ordre de la vidéo.
pub fn get_commentary_chunks(
    c: &Connection,
    match_id: i64,
) -> rusqlite::Result<Vec<CommentaryChunkRow>> {
    let mut st = c.prepare(
        "SELECT idx, keep_from, keep_to FROM commentary_chunks WHERE match_id = ?1 ORDER BY keep_from",
    )?;
    let rows = st.query_map([match_id as f64], |r| {
        Ok(CommentaryChunkRow {
            idx: col_int(r, "idx").unwrap_or(0),
            keep_from: num(&col(r, "keep_from")),
            keep_to: num(&col(r, "keep_to")),
        })
    })?;
    rows.collect()
}
