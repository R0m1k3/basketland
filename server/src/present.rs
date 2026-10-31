//! Mise en forme des matchs pour l'API (équivalent de `src/lib/present.ts`).

use crate::db::{sql_to_json, MatchRow};
use crate::time::{self, PARIS_TZ};
use serde_json::{json, Value};

pub fn team_logo(abbr: &str, league: &str) -> String {
    format!(
        "https://a.espncdn.com/i/teamlogos/{league}/500/{}.png",
        abbr.to_lowercase()
    )
}

/// Champs d'heure de Paris d'une date en base (vides si elle est illisible).
fn paris_fields(date_utc: &str) -> (String, String, String) {
    match time::parse_instant(date_utc) {
        Some(d) => (
            time::paris_iso(d),
            time::paris_date_key(d),
            time::paris_time(d),
        ),
        None => (String::new(), String::new(), String::new()),
    }
}

pub fn day_key(date_utc: &str) -> String {
    time::parse_instant(date_utc)
        .map(time::paris_date_key)
        .unwrap_or_default()
}

pub fn to_dto(m: &MatchRow) -> Value {
    let available = m.video_available && m.video_ok_id.as_deref().is_some_and(|s| !s.is_empty());
    // Ligne antérieure à la colonne video_kind (NULL) mais disponible : c'était du HLS.
    let kind = if !available {
        None
    } else if m.video_kind.as_deref() == Some("mp4") {
        Some("mp4")
    } else {
        Some("hls")
    };
    let ok_id = m.video_ok_id.clone().unwrap_or_default();
    let src = match kind {
        Some("hls") => Some(format!("/api/video/{ok_id}/master.m3u8")),
        Some("mp4") => Some(format!("/api/video/{ok_id}/file.mp4")),
        _ => None,
    };
    let (date_paris, day_paris, time_paris) = paris_fields(&m.date_utc);
    let period = match sql_to_json(m.period.clone()) {
        Value::Null => Value::from(0),
        v => v,
    };
    json!({
        "id": m.id,
        "espn_id": m.espn_id,
        "league": m.league,
        "season": sql_to_json(m.season.clone()),
        "season_type": m.season_type,
        "date_utc": m.date_utc,
        "date_paris": date_paris,
        "day_paris": day_paris,
        "time_paris": time_paris,
        "timezone": PARIS_TZ,
        "status": m.status,
        "status_detail": m.status_detail.clone().unwrap_or_default(),
        "period": period,
        "clock_display": m.clock_display.clone().unwrap_or_default(),
        "home": { "abbr": m.home_abbr, "name": m.home_name, "score": sql_to_json(m.home_score.clone()), "logo": team_logo(&m.home_abbr, &m.league) },
        "away": { "abbr": m.away_abbr, "name": m.away_name, "score": sql_to_json(m.away_score.clone()), "logo": team_logo(&m.away_abbr, &m.league) },
        "venue": m.venue.clone().unwrap_or_default(),
        "broadcast": m.broadcast.clone().unwrap_or_default(),
        "stats_available": m.status == "final",
        "video": {
            "available": available,
            "ok_id": m.video_ok_id,
            "duration": sql_to_json(m.video_duration.clone()),
            "kind": kind,
            "src": src,
            "master": if kind == Some("hls") { src.clone() } else { None },
            "checked_at": m.video_checked_at,
        },
    })
}

pub struct DayGroup {
    pub date: String,
    pub label: String,
    pub matches: Vec<Value>,
}

/// Groupe des DTO (triés par date) selon leur jour à Paris, dans l'ordre d'apparition.
pub fn group_by_paris_day(items: Vec<Value>) -> Vec<DayGroup> {
    let mut groups: Vec<DayGroup> = Vec::new();
    for it in items {
        let key = day_key(it["date_utc"].as_str().unwrap_or(""));
        let idx = match groups.iter().rposition(|g| g.date == key) {
            Some(i) => i,
            None => {
                let label = time::label_for_date_key(&key).unwrap_or_default();
                groups.push(DayGroup {
                    date: key,
                    label,
                    matches: Vec::new(),
                });
                groups.len() - 1
            }
        };
        groups[idx].matches.push(it);
    }
    groups
}
