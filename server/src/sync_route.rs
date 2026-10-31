//! `GET` / `POST /api/matches/[id]/sync` (équivalent de
//! `src/app/api/matches/[id]/sync/route.ts`) — portée à l'étape 7 mais **pas
//! encore branchée** sur le routeur : la route reste servie par Node tant que
//! la file d'analyse n'est pas basculée (étape de branchement). Les
//! gestionnaires rendent la réponse complète ; le branchement n'aura qu'à
//! lire l'identifiant, les en-têtes et le corps, après la session.
//!
//! - `{ global_offset, quarter_offsets }` → réglage manuel persistant ;
//! - `{ action: 'nudge', delta, period? }` → ± décalage relatif ;
//! - `{ action: 'anchor', seq, video_ts }` → « cette action se passe maintenant » ;
//! - `{ action: 'clock', video_ts, period, clock_sec }` → ancre manuelle
//!   « à cette position, le chrono affiché indique période P, chrono C » ;
//! - `{ anchors: [{ period, clock_sec, video_ts }] }` → ancres manuelles brutes ;
//! - `{ action: 'delete-anchor', period, clock_sec }` / `{ action: 'reset' }` ;
//! - `{ action: 'analyze' }` / `'analyze-audio'` → analyse en TÊTE de file.
//!
//! Toute écriture exige une origine autorisée (`SYNC_WRITE_ORIGINS`) et un
//! Content-Type JSON, comme Node.

use crate::analysis_db::{self as adb, AnchorInput};
use crate::api::{error, js_num_value, json_response};
use crate::db::{self, Db};
use crate::ingest_db;
use crate::js::jsre;
use crate::jsval::js_number_string;
use crate::media::analysis::{Analysis, EnqueueOptions};
use crate::routes_match::parse_id;
use crate::vf_sync::{resolve_anchor_wall, to_timed_plays};
use crate::writes::{allowed_origins, is_json_content_type, is_origin_allowed};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value};

/// Exception de Node (TypeError…) : réponse 500 de Next.
fn crash(msg: &str) -> Response {
    eprintln!("[sync] erreur : {msg}");
    error(StatusCode::INTERNAL_SERVER_ERROR, msg)
}

/// `syncState` : réglages, ancres, statut d'analyse et profil audio d'un match.
pub fn sync_state(db: &Db, analysis: &Analysis, id: i64) -> Result<Map<String, Value>, String> {
    let profile = db.with(|c| adb::audio_summary(c, id))??;
    let st = analysis.status(id);
    let settings = db.with(|c| adb::sync_settings_json(c, id))?;
    let anchors = db.with(|c| adb::anchors_json(c, id))?;
    let mut audio = Map::new();
    audio.insert("status".into(), Value::from(st.name()));
    audio.insert(
        "analyzed_at".into(),
        profile
            .as_ref()
            .map_or(Value::Null, |p| p.analyzed_at.clone()),
    );
    audio.insert(
        "seconds".into(),
        Value::from(profile.as_ref().map_or(0, |p| p.seconds)),
    );
    audio.insert(
        "cuts".into(),
        profile
            .map(|p| p.cuts)
            .filter(|c| !c.is_null())
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    let mut m = Map::new();
    m.insert("match_id".into(), Value::from(id));
    m.insert("settings".into(), settings);
    m.insert("anchors".into(), Value::Array(anchors));
    m.insert("analysis".into(), st.to_json());
    m.insert("audio".into(), Value::Object(audio));
    Ok(m)
}

/// `GET /api/matches/[id]/sync`.
pub fn get(db: &Db, analysis: &Analysis, raw_id: &str) -> Response {
    let Some(id) = parse_id(raw_id) else {
        return error(StatusCode::BAD_REQUEST, "id invalide");
    };
    match db.with(|c| db::get_match(c, id)) {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "match introuvable"),
        Err(e) => return crash(&e),
    }
    match sync_state(db, analysis, id) {
        Ok(s) => json_response(StatusCode::OK, &Value::Object(s)),
        Err(e) => crash(&e),
    }
}

/// `typeof v === 'number' && Number.isFinite(v)`.
fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// « 7:43 »
fn fmt_clock(s: f64) -> String {
    format!(
        "{}:{:0>2}",
        js_number_string((s / 60.0).floor()),
        js_number_string(s % 60.0)
    )
}

/// « 2e période », « prolongation 1 »
fn fmt_period(p: f64) -> String {
    if p <= 4.0 {
        format!("{}e période", js_number_string(p))
    } else {
        format!("prolongation {}", js_number_string(p - 4.0))
    }
}

/// `Number(q[String(p)]) || 0`.
fn offset_of(q: &Value, p: f64) -> f64 {
    let n = crate::js::to_number(q.get(js_number_string(p)));
    if n.is_nan() || n == 0.0 {
        0.0
    } else {
        n
    }
}

fn round2(v: f64) -> f64 {
    crate::js::round(v * 100.0) / 100.0
}

/// `Object.entries(v)` (objet, tableau ou chaîne ; sinon aucune entrée).
fn entries(v: &Value) -> Vec<(String, Value)> {
    match crate::jsval::js_normalize(v.clone()) {
        Value::Object(m) => m.into_iter().collect(),
        Value::Array(a) => a
            .into_iter()
            .enumerate()
            .map(|(i, x)| (i.to_string(), x))
            .collect(),
        Value::String(s) => s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::from(c.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

fn wall_iso(wall: f64) -> Result<String, String> {
    let ms = (wall * 1000.0).trunc();
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .filter(|_| ms.is_finite())
        .map(crate::time::iso_utc)
        .ok_or_else(|| "Invalid time value".to_string())
}

/// `POST /api/matches/[id]/sync` : `body` est le corps brut de la requête.
pub fn post(
    db: &Db,
    analysis: &Analysis,
    raw_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    let Some(id) = parse_id(raw_id) else {
        return error(StatusCode::BAD_REQUEST, "id invalide");
    };
    let m = match db.with(|c| db::get_match(c, id)) {
        Ok(Some(m)) => m,
        Ok(None) => return error(StatusCode::NOT_FOUND, "match introuvable"),
        Err(e) => return crash(&e),
    };
    let text = String::from_utf8_lossy(body);
    let Ok(body) = serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text))
    else {
        return error(StatusCode::BAD_REQUEST, "JSON invalide");
    };
    // Toute écriture (offsets et ancres brutes comprises) : origine contrôlée.
    if !is_origin_allowed(headers, &allowed_origins()) {
        return error(
            StatusCode::FORBIDDEN,
            "origine non autorisée pour cette écriture",
        );
    }
    // Essence MIME exigée : une requête « simple » text/plain passerait sans preflight.
    if !is_json_content_type(headers) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type application/json requis",
        );
    }
    if body.is_null() {
        return crash("Cannot read properties of null (reading 'action')");
    }
    match handle(db, analysis, id, &m, &body) {
        Ok(r) => r,
        Err(e) => crash(&e),
    }
}

fn handle(
    db: &Db,
    analysis: &Analysis,
    id: i64,
    m: &db::MatchRow,
    body: &Value,
) -> Result<Response, String> {
    let action = body.get("action").and_then(Value::as_str);
    let current = db.with(|c| ingest_db::get_sync_settings(c, id))?;
    let cur_q = current.quarter_offsets.clone();
    let mut message = "ok".to_string();

    if matches!(action, Some("analyze" | "analyze-audio")) {
        // Demande explicite : en tête de file (le cooldown après un succès reste appliqué).
        let r = analysis.enqueue(
            id,
            EnqueueOptions {
                priority: true,
                with_audio: action == Some("analyze-audio"),
                manual: true,
                background: false,
            },
        );
        let mut s = sync_state(db, analysis, id)?;
        s.insert("started".into(), Value::from(r.started));
        s.insert("queued".into(), Value::from(r.queued));
        if let Some(p) = r.position {
            s.insert("position".into(), Value::from(p));
        }
        s.insert("message".into(), Value::from(r.message));
        let status = if r.started || r.queued {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        };
        return Ok(json_response(status, &Value::Object(s)));
    }

    match action {
        Some("reset") => {
            db.with(|c| {
                adb::clear_anchors(c, id, &["manual"])?;
                adb::save_sync_settings(c, id, 0.0, &Map::new())
            })?;
            message = "réglages remis à zéro".into();
        }
        Some("nudge") => {
            let Some(delta) = finite(body.get("delta")).filter(|d| d.abs() <= 3600.0) else {
                return Ok(error(StatusCode::BAD_REQUEST, "delta invalide"));
            };
            if let Some(p) = finite(body.get("period")) {
                // Le quart doit être un entier de 1 à 10.
                if p.fract() != 0.0 || !(1.0..=10.0).contains(&p) {
                    return Ok(error(StatusCode::BAD_REQUEST, "période invalide"));
                }
                let mut q = cur_q.as_object().cloned().unwrap_or_default();
                let key = js_number_string(p);
                let prev = q.get(&key).and_then(Value::as_f64).unwrap_or(0.0);
                q.insert(key, js_num_value(round2(prev + delta)));
                db.with(|c| adb::save_sync_settings(c, id, current.global_offset, &q))?;
            } else {
                let q = cur_q.as_object().cloned().unwrap_or_default();
                db.with(|c| {
                    adb::save_sync_settings(c, id, round2(current.global_offset + delta), &q)
                })?;
            }
        }
        Some("anchor") => {
            let (Some(seq), Some(video_ts)) =
                (finite(body.get("seq")), finite(body.get("video_ts")))
            else {
                return Ok(error(StatusCode::BAD_REQUEST, "seq et video_ts requis"));
            };
            if video_ts < 0.0 {
                return Ok(error(StatusCode::BAD_REQUEST, "seq et video_ts requis"));
            }
            let plays = db.with(|c| ingest_db::get_plays(c, id))?;
            let Some(play) = plays.iter().find(|p| p.seq == seq) else {
                return Ok(error(StatusCode::NOT_FOUND, "action introuvable"));
            };
            // L'ancre fixe la position *finale* : l'offset ré-appliqué ensuite est retiré.
            let offset = current.global_offset + offset_of(&cur_q, play.period);
            let a = AnchorInput {
                match_id: id,
                period: play.period,
                clock_sec: play.clock_sec,
                video_ts: round2(video_ts - offset),
                method: "manual".into(),
                wallclock: Some(play.wallclock.clone()),
            };
            db.with(|c| adb::upsert_anchor(c, &a))?;
            message = format!(
                "ancre posée ({}e période, {})",
                js_number_string(play.period),
                play.clock_display
            );
        }
        Some("clock") => {
            let Some(video_ts) = finite(body.get("video_ts")).filter(|v| *v >= 0.0) else {
                return Ok(error(StatusCode::BAD_REQUEST, "video_ts invalide"));
            };
            if let Some(d) = ingest_db::video_duration(m).filter(|d| *d != 0.0 && !d.is_nan()) {
                if video_ts > d {
                    return Ok(error(
                        StatusCode::BAD_REQUEST,
                        "video_ts au-delà de la fin de la vidéo",
                    ));
                }
            }
            let Some(period) =
                finite(body.get("period")).filter(|p| p.fract() == 0.0 && (1.0..=10.0).contains(p))
            else {
                return Ok(error(
                    StatusCode::BAD_REQUEST,
                    "période invalide (entier de 1 à 10)",
                ));
            };
            let Some(clock) = finite(body.get("clock_sec")).filter(|c| (0.0..=720.0).contains(c))
            else {
                return Ok(error(
                    StatusCode::BAD_REQUEST,
                    "chrono invalide (0 à 720 s)",
                ));
            };
            if period > 4.0 && clock > 300.0 {
                return Ok(error(
                    StatusCode::BAD_REQUEST,
                    "chrono invalide pour une prolongation (5:00 au plus)",
                ));
            }
            // La clé d'une ancre est (période, chrono entier) : les dixièmes sont arrondis.
            let clock_sec = crate::js::round(clock);
            let plays = db.with(|c| ingest_db::get_plays(c, id))?;
            if plays.is_empty() {
                return Ok(error(
                    StatusCode::CONFLICT,
                    "play-by-play pas encore disponible pour ce match",
                ));
            }
            let tp = to_timed_plays(
                plays
                    .iter()
                    .map(|p| (p.seq, p.period, p.clock_sec, p.wallclock.as_str())),
            );
            let Some(wall) = resolve_anchor_wall(period, clock_sec, None, &tp) else {
                return Ok(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &format!("{} absente du play-by-play", fmt_period(period)),
                ));
            };
            let offset = current.global_offset + offset_of(&cur_q, period);
            let a = AnchorInput {
                match_id: id,
                period,
                clock_sec,
                video_ts: round2(video_ts - offset),
                method: "manual".into(),
                wallclock: Some(wall_iso(wall)?),
            };
            db.with(|c| adb::upsert_anchor(c, &a))?;
            message = format!(
                "ancre posée ({}, {})",
                fmt_period(period),
                fmt_clock(clock_sec)
            );
        }
        Some("delete-anchor") => {
            let (Some(p), Some(c)) = (finite(body.get("period")), finite(body.get("clock_sec")))
            else {
                return Ok(error(StatusCode::BAD_REQUEST, "period et clock_sec requis"));
            };
            db.with(|conn| adb::delete_anchor(conn, id, p, c))?;
        }
        _ => {
            let defined = |k: &str| body.get(k).is_some();
            if defined("global_offset") || defined("quarter_offsets") {
                let g = crate::jsval::or_else(body.get("global_offset"), None);
                let g = match g {
                    None => Some(current.global_offset),
                    Some(v) => finite(Some(v)),
                };
                let Some(g) = g.filter(|g| g.abs() <= 4.0 * 3600.0) else {
                    return Ok(error(StatusCode::BAD_REQUEST, "global_offset invalide"));
                };
                let src = crate::jsval::or_else(body.get("quarter_offsets"), Some(&cur_q))
                    .cloned()
                    .unwrap_or(Value::Null);
                let mut q = Map::new();
                for (k, v) in entries(&src) {
                    let ok_key = jsre!(r"^\d{1,2}$").is_match(&k);
                    match finite(Some(&v)).filter(|v| v.abs() <= 3600.0) {
                        Some(n) if ok_key => {
                            q.insert(k, js_num_value(n));
                        }
                        _ => {
                            return Ok(error(
                                StatusCode::BAD_REQUEST,
                                &format!("quarter_offsets[{k}] invalide"),
                            ))
                        }
                    }
                }
                db.with(|c| adb::save_sync_settings(c, id, g, &q))?;
            }
            let anchors: Vec<Value> = match body.get("anchors") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(a)) => a.clone(),
                Some(Value::String(s)) => s.chars().map(|c| Value::from(c.to_string())).collect(),
                Some(_) => return Err("body.anchors is not iterable".into()),
            };
            for a in &anchors {
                if a.is_null() {
                    return Err("Cannot read properties of null (reading 'period')".into());
                }
                let (Some(p), Some(c), Some(v)) = (
                    finite(a.get("period")),
                    finite(a.get("clock_sec")),
                    finite(a.get("video_ts")),
                ) else {
                    return Ok(error(StatusCode::BAD_REQUEST, "ancre invalide"));
                };
                if v < 0.0 {
                    return Ok(error(StatusCode::BAD_REQUEST, "ancre invalide"));
                }
                // Positions BRUTES : les offsets globaux et par quart sont ré-appliqués ensuite.
                let raw_offset = current.global_offset + offset_of(&cur_q, p.trunc());
                let wallclock = match a.get("wallclock") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(other) => Some(crate::jsval::js_string(other)),
                };
                let row = AnchorInput {
                    match_id: id,
                    period: p.trunc(),
                    clock_sec: c.trunc(),
                    video_ts: round2(v - raw_offset),
                    method: "manual".into(),
                    wallclock,
                };
                db.with(|conn| adb::upsert_anchor(conn, &row))?;
            }
        }
    }

    let count = db.with(|c| crate::ingest::regenerate_subtitles(c, id, None))??;
    let mut s = sync_state(db, analysis, id)?;
    s.insert("subtitles".into(), Value::from(count));
    s.insert("message".into(), Value::from(message));
    Ok(json_response(StatusCode::OK, &Value::Object(s)))
}
