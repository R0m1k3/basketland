//! Tables du doublage français (`dub_tracks`, `dub_chunks`) : section
//! « doublage français » de `src/lib/db.ts`, mêmes requêtes, mêmes
//! transactions (BEGIN … COMMIT). Le schéma reste créé par Node
//! (`DUB_SCHEMA_SQL`).
//!
//! Les nombres sont liés en réels doubles comme le fait `node:sqlite`.

use crate::commentary_db::{now_iso, num, tx};
use crate::db::{col, col_int, col_text};
use rusqlite::{named_params, Connection, Row};

/// Piste doublée d'un match (`DubTrackRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubTrackRow {
    pub match_id: i64,
    pub ok_id: String,
    /// Piste traduite doublée (`commentaryKey`).
    pub commentary_key: String,
    /// Rôles de voix utilisés (JSON : `["A","B4",…]`).
    pub voices: String,
    /// Locuteurs reconnus et leur voix (JSON, voir [`crate::media::dub::SpeakerState`]).
    pub speakers: String,
    pub complete: i64,
    pub updated_at: String,
}

/// Tronçon doublé publié (`DubChunkRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubChunkRow {
    pub match_id: i64,
    pub idx: i64,
    pub start_ts: f64,
    pub end_ts: f64,
    pub file: String,
    /// Plages de parole française, en temps absolu de la vidéo (JSON `[[s, e], …]`).
    pub speech: String,
    pub cues_sig: String,
    pub created_at: String,
}

fn track_row(r: &Row) -> rusqlite::Result<DubTrackRow> {
    Ok(DubTrackRow {
        match_id: col_int(r, "match_id").unwrap_or(0),
        ok_id: col_text(r, "ok_id").unwrap_or_default(),
        commentary_key: col_text(r, "commentary_key").unwrap_or_default(),
        voices: col_text(r, "voices").unwrap_or_default(),
        speakers: col_text(r, "speakers").unwrap_or_default(),
        complete: col_int(r, "complete").unwrap_or(0),
        updated_at: col_text(r, "updated_at").unwrap_or_default(),
    })
}

fn chunk_row(r: &Row) -> rusqlite::Result<DubChunkRow> {
    Ok(DubChunkRow {
        match_id: col_int(r, "match_id").unwrap_or(0),
        idx: col_int(r, "idx").unwrap_or(0),
        start_ts: num(&col(r, "start_ts")),
        end_ts: num(&col(r, "end_ts")),
        file: col_text(r, "file").unwrap_or_default(),
        speech: col_text(r, "speech").unwrap_or_default(),
        cues_sig: col_text(r, "cues_sig").unwrap_or_default(),
        created_at: col_text(r, "created_at").unwrap_or_default(),
    })
}

/// `getDubTrack`.
pub fn get_dub_track(c: &Connection, match_id: i64) -> rusqlite::Result<Option<DubTrackRow>> {
    let mut st = c.prepare("SELECT * FROM dub_tracks WHERE match_id = ?1")?;
    let mut rows = st.query_map([match_id as f64], track_row)?;
    rows.next().transpose()
}

/// `getDubChunks` : tronçons doublés, dans l'ordre de la vidéo.
pub fn get_dub_chunks(c: &Connection, match_id: i64) -> rusqlite::Result<Vec<DubChunkRow>> {
    let mut st = c.prepare("SELECT * FROM dub_chunks WHERE match_id = ?1 ORDER BY start_ts")?;
    let rows = st.query_map([match_id as f64], chunk_row)?;
    rows.collect()
}

/// `getDubChunk`.
pub fn get_dub_chunk(
    c: &Connection,
    match_id: i64,
    idx: i64,
) -> rusqlite::Result<Option<DubChunkRow>> {
    let mut st = c.prepare("SELECT * FROM dub_chunks WHERE match_id = ?1 AND idx = ?2")?;
    let mut rows = st.query_map([match_id as f64, idx as f64], chunk_row)?;
    rows.next().transpose()
}

/// `openDubTrack` : ouvre (ou reprend) le doublage d'un match pour la piste
/// traduite `key`. Un doublage fait pour une autre piste (autre vidéo,
/// autres modèles) est effacé : rend alors `reset` vrai (l'appelant
/// supprime les fichiers).
pub fn open_dub_track(
    c: &Connection,
    match_id: i64,
    ok_id: &str,
    key: &str,
) -> rusqlite::Result<(bool, DubTrackRow)> {
    tx(c, || {
        let prev = get_dub_track(c, match_id)?;
        if let Some(p) = prev
            .as_ref()
            .filter(|p| p.commentary_key == key && p.ok_id == ok_id)
        {
            return Ok((false, p.clone()));
        }
        c.execute(
            "DELETE FROM dub_chunks WHERE match_id = ?1",
            [match_id as f64],
        )?;
        c.execute(
            "INSERT OR REPLACE INTO dub_tracks (match_id, ok_id, commentary_key, voices, speakers, complete, updated_at)
       VALUES (:id, :ok, :key, '[]', '{}', 0, :now)",
            named_params! { ":id": match_id as f64, ":ok": ok_id, ":key": key, ":now": now_iso() },
        )?;
        let track = get_dub_track(c, match_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        Ok((prev.is_some(), track))
    })
}

/// Tronçon doublé à publier (`{ idx, start, end, file, speech, cuesSig }`).
#[derive(Debug, Clone, PartialEq)]
pub struct DubChunkInput {
    pub idx: i64,
    pub start: f64,
    pub end: f64,
    pub file: String,
    /// `JSON.stringify(speech)`.
    pub speech_json: String,
    pub cues_sig: String,
}

/// `publishDubChunk` : publie un tronçon doublé (remplace le précédent) et
/// l'état des voix du match (JSON déjà sérialisés), d'un bloc.
pub fn publish_dub_chunk(
    c: &Connection,
    match_id: i64,
    chunk: &DubChunkInput,
    voices_json: &str,
    speakers_json: &str,
) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute(
            "INSERT OR REPLACE INTO dub_chunks (match_id, idx, start_ts, end_ts, file, speech, cues_sig, created_at)
       VALUES (:id, :idx, :s, :e, :f, :sp, :sig, :now)",
            named_params! {
                ":id": match_id as f64,
                ":idx": chunk.idx as f64,
                ":s": chunk.start,
                ":e": chunk.end,
                ":f": chunk.file,
                ":sp": chunk.speech_json,
                ":sig": chunk.cues_sig,
                ":now": now_iso(),
            },
        )?;
        c.execute(
            "UPDATE dub_tracks SET voices = :v, speakers = :sp, updated_at = :now WHERE match_id = :id",
            named_params! { ":id": match_id as f64, ":v": voices_json, ":sp": speakers_json, ":now": now_iso() },
        )?;
        Ok(())
    })
}

/// `setDubComplete`.
pub fn set_dub_complete(c: &Connection, match_id: i64, complete: bool) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE dub_tracks SET complete = :c, updated_at = :now WHERE match_id = :id",
        named_params! { ":id": match_id as f64, ":c": if complete { 1.0 } else { 0.0 }, ":now": now_iso() },
    )
    .map(|_| ())
}

/// `deleteDub` : efface le doublage d'un match (lignes seulement : les
/// fichiers sont supprimés par le doublage).
pub fn delete_dub(c: &Connection, match_id: i64) -> rusqlite::Result<()> {
    tx(c, || {
        c.execute(
            "DELETE FROM dub_chunks WHERE match_id = ?1",
            [match_id as f64],
        )?;
        c.execute(
            "DELETE FROM dub_tracks WHERE match_id = ?1",
            [match_id as f64],
        )?;
        Ok(())
    })
}

/// `dubPendingChunks` : tronçons traduits pas encore doublés pour la piste
/// traduite actuelle `key` (tous si le doublage en base a été fait pour une autre).
pub fn dub_pending_chunks(c: &Connection, match_id: i64, key: &str) -> rusqlite::Result<i64> {
    let d = get_dub_track(c, match_id)?;
    let total: i64 = c.query_row(
        "SELECT COUNT(*) AS n FROM commentary_chunks WHERE match_id = ?1",
        [match_id as f64],
        |r| r.get(0),
    )?;
    if d.is_none_or(|d| d.commentary_key != key) {
        return Ok(total);
    }
    c.query_row(
        "SELECT COUNT(*) AS n FROM commentary_chunks c
        WHERE c.match_id = ?1 AND NOT EXISTS (SELECT 1 FROM dub_chunks x WHERE x.match_id = c.match_id AND x.idx = c.idx)",
        [match_id as f64],
        |r| r.get(0),
    )
}
