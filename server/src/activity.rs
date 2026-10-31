//! « En cours de traitement » (équivalent de `src/lib/activity.ts`) : ce que
//! font les files médias en ce moment, pour le panneau de l'accueil
//! (`GET /api/activity`, données de la page d'accueil).

use crate::api::js_num_value;
use crate::db;
use crate::media::analysis::PAUSED_PHASE;
use crate::media::commentary::CommentaryPhase;
use crate::state::Media;
use rusqlite::Connection;
use serde_json::{json, Value};

/// Libellé d'une phase de la traduction (`PHASE`).
fn phase_label(p: CommentaryPhase) -> &'static str {
    match p {
        CommentaryPhase::Extraction => "Lecture de l’audio",
        CommentaryPhase::Preparation => "Chargement des modèles",
        CommentaryPhase::Transcription => "Transcription des commentateurs",
        CommentaryPhase::Traduction => "Traduction en français",
    }
}

/// `matchOf` : match du panneau, ou rien s'il n'existe plus.
fn match_of(c: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    Ok(db::get_match(c, id)?.map(|m| {
        json!({ "id": id, "away": m.away_abbr, "home": m.home_abbr, "awayName": m.away_name, "homeName": m.home_name })
    }))
}

/// `Math.round(done / total * 100)` quand `total` est vrai (non nul, pas NaN), sinon null.
fn pct(done: f64, total: f64) -> Value {
    if total != 0.0 && !total.is_nan() {
        js_num_value(crate::js::round(done / total * 100.0))
    } else {
        Value::Null
    }
}

/// `currentActivity()` : `{ tasks, queued, watching }`, même ordre des clés.
pub fn current_activity(c: &Connection, media: &Media) -> rusqlite::Result<Value> {
    let cm = &media.commentary;
    let ca = cm.activity();
    let aa = media.analysis.activity();
    let watching = !cm.viewers().active_ids_at(cm.now()).is_empty();
    let mut tasks = Vec::new();
    if let Some(r) = &ca.running {
        if let Some(m) = match_of(c, r.match_id)? {
            let p = match r.phase {
                Some(ph) if ph != CommentaryPhase::Preparation => pct(r.done, r.total),
                _ => Value::Null,
            };
            tasks.push(json!({
                "kind": "traduction",
                "match": m,
                "label": r.phase.map_or("Démarrage", phase_label),
                "pct": p,
                "paused": false,
                "watched": r.watched,
            }));
        }
    }
    for r in &aa.running {
        let Some(m) = match_of(c, r.match_id)? else {
            continue;
        };
        let paused = r.phase == PAUSED_PHASE;
        tasks.push(json!({
            "kind": "analyse",
            "match": m,
            "label": if paused { "Analyse vidéo en pause".to_string() } else { format!("Analyse vidéo · {}", r.phase) },
            "pct": if paused { Value::Null } else { pct(r.done, r.total) },
            "paused": paused,
            "watched": false,
        }));
    }
    // Doublage français (voix de synthèse), quand le GPU est libre.
    let da = media.dub.activity();
    if let Some(r) = &da.running {
        if let Some(m) = match_of(c, r.match_id)? {
            tasks.push(json!({
                "kind": "doublage",
                "match": m,
                "label": "Doublage en français",
                "pct": pct(r.done, r.total),
                "paused": false,
                "watched": r.watched,
            }));
        }
    }
    let mut queued = Vec::new();
    for (kind, ids) in [
        ("traduction", &ca.queued),
        ("analyse", &aa.queued),
        ("doublage", &da.queued),
    ] {
        for id in ids {
            if let Some(m) = match_of(c, *id)? {
                queued.push(json!({ "kind": kind, "match": m }));
            }
        }
    }
    Ok(json!({ "tasks": tasks, "queued": queued, "watching": watching }))
}
