//! Requêtes de lecture des pages (accueil, calendrier, équipes), équivalent
//! de `src/lib/queries.ts`. Les « jours » sont des jours de Paris (clé
//! `YYYY-MM-DD`) ; une « nuit NBA » va de midi (Paris) au lendemain midi.
//!
//! Différences de forme avec Node, sans effet sur les pages : l'instant
//! présent (`now`) et le match en cours de traduction (`running`, état de la
//! file de Node, voir `routes_pages`) sont passés en paramètres au lieu
//! d'être lus par chaque fonction.

use crate::api::js_num_value;
use crate::commentary_db::commentary_progress_by_ids;
use crate::db::{self, list_matches, match_row, MatchFilters, MatchRow};
use crate::present::to_dto;
use crate::time::{self, iso_utc, paris_date_key, paris_day_start_utc, parse_instant};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

const HOUR_MS: i64 = 3_600_000;
/// Un match « programmé » dont l'heure est passée depuis moins de ça est sans doute en cours.
const IN_PROGRESS_GRACE_MS: i64 = 3 * HOUR_MS;

// ---------------------------------------------------------------- jours & nuits

/// `todayKey`.
pub fn today_key(now: DateTime<Utc>) -> String {
    paris_date_key(now)
}

/// `shiftKey` (clé valide attendue ; chaîne vide sinon).
pub fn shift_key(key: &str, n: i64) -> String {
    time::shift_key(key, n).unwrap_or_default()
}

/// `isDateKey` : `YYYY-MM-DD` d'un jour qui existe (`2026-02-30` refusé).
pub fn is_date_key(v: &str) -> bool {
    let b = v.as_bytes();
    let shape = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    shape && time::shift_key(v, 0).as_deref() == Some(v)
}

/// `nightKeyOf` : jour de Paris de (début − 12 h).
pub fn night_key_of(date_utc: &str) -> String {
    parse_instant(date_utc)
        .map(|d| paris_date_key(d - Duration::milliseconds(12 * HOUR_MS)))
        .unwrap_or_default()
}

fn plus_hours(iso: &str, h: i64) -> String {
    parse_instant(iso)
        .map(|d| iso_utc(d + Duration::milliseconds(h * HOUR_MS)))
        .unwrap_or_default()
}

/// Bornes UTC [début, fin) de la nuit `key` : de midi à midi, heure de Paris.
fn night_bounds(key: &str) -> (String, String) {
    let from = plus_hours(&paris_day_start_utc(key).unwrap_or_default(), 12);
    let to = plus_hours(
        &paris_day_start_utc(&shift_key(key, 1)).unwrap_or_default(),
        12,
    );
    (from, to)
}

fn day_bounds(key: &str) -> (String, String) {
    (
        paris_day_start_utc(key).unwrap_or_default(),
        paris_day_start_utc(&shift_key(key, 1)).unwrap_or_default(),
    )
}

// ---------------------------------------------------------------- vue enrichie

/// Identifiants des matchs qui ont des stats joueurs en base.
fn ids_with_stats(c: &Connection, ids: &[i64]) -> rusqlite::Result<HashSet<i64>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let list: Vec<String> = ids.iter().map(i64::to_string).collect();
    let mut st = c.prepare(&format!(
        "SELECT DISTINCT match_id FROM player_stats WHERE match_id IN ({})",
        list.join(",")
    ))?;
    let rows = st.query_map([], |r| r.get::<_, i64>(0))?;
    rows.collect()
}

/// `toViews` : DTO du match + `hasStats`, `hasReplay`, `hasVf` et l'état de la VF.
pub fn to_views(
    c: &Connection,
    rows: &[MatchRow],
    running: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let finals: Vec<i64> = rows
        .iter()
        .filter(|r| r.status == "final")
        .map(|r| r.id)
        .collect();
    let stats = ids_with_stats(c, &finals)?;
    let progress = commentary_progress_by_ids(c, &finals)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Value::Object(mut dto) = to_dto(r) else {
            unreachable!("to_dto rend un objet")
        };
        let available = dto["video"]["available"] == true;
        let p = if available { progress.get(&r.id) } else { None };
        let pct = match p {
            Some(p) if p.total != 0.0 && !p.total.is_nan() => {
                crate::js::min(99.0, crate::js::round(p.done as f64 / p.total * 100.0))
            }
            _ => 0.0,
        };
        let vf = if !available {
            json!({ "state": "none" })
        } else if p.is_some_and(|p| p.complete) {
            json!({ "state": "ready" })
        } else if running == Some(r.id) {
            json!({ "state": "running", "pct": js_num_value(pct) })
        } else if p.is_some_and(|p| p.done > 0) {
            json!({ "state": "partial", "pct": js_num_value(pct) })
        } else {
            json!({ "state": "none" })
        };
        dto.insert("hasStats".into(), stats.contains(&r.id).into());
        dto.insert("hasReplay".into(), available.into());
        dto.insert("hasVf".into(), (vf["state"] == "ready").into());
        dto.insert("vf".into(), vf);
        out.push(Value::Object(dto));
    }
    Ok(out)
}

fn filters() -> MatchFilters {
    MatchFilters {
        limit: 50,
        ..Default::default()
    }
}

// ---------------------------------------------------------------- accueil

/// `latestReplays` : derniers matchs terminés avec un replay, du plus récent au plus ancien.
pub fn latest_replays(
    c: &Connection,
    limit: i64,
    running: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let f = MatchFilters {
        status: Some("final".into()),
        video: Some(true),
        desc: true,
        limit,
        ..filters()
    };
    to_views(c, &list_matches(c, &f)?, running)
}

/// `liveGames`.
pub fn live_games(c: &Connection, running: Option<i64>) -> rusqlite::Result<Vec<Value>> {
    let f = MatchFilters {
        status: Some("live".into()),
        limit: 20,
        ..filters()
    };
    to_views(c, &list_matches(c, &f)?, running)
}

/// `nextNightKey` : nuit d'un match en cours, sinon du prochain match programmé
/// (un match « programmé » commencé depuis peu compte encore).
pub fn next_night_key(c: &Connection, now: DateTime<Utc>) -> rusqlite::Result<Option<String>> {
    let since = iso_utc(now - Duration::milliseconds(IN_PROGRESS_GRACE_MS));
    let r: Option<String> = c
        .query_row(
            "SELECT date_utc FROM matches
              WHERE league = 'nba'
                AND (status = 'live' OR (status = 'scheduled' AND date_utc >= ?1))
              ORDER BY (status = 'live') DESC, date_utc ASC LIMIT 1",
            [since],
            |r| Ok(db::col_text(r, "date_utc").unwrap_or_default()),
        )
        .optional()?;
    Ok(r.map(|d| night_key_of(&d)))
}

/// `gamesOfNight`.
pub fn games_of_night(
    c: &Connection,
    key: &str,
    running: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let (from, to) = night_bounds(key);
    let f = MatchFilters {
        from: Some(from),
        to: Some(to),
        limit: 40,
        ..filters()
    };
    to_views(c, &list_matches(c, &f)?, running)
}

/// `upcomingDays` : prochains jours (Paris) avec des matchs programmés dans le
/// futur, à partir de `from_key`.
pub fn upcoming_days(
    c: &Connection,
    from_key: &str,
    max_days: usize,
    now: DateTime<Utc>,
    running: Option<i64>,
) -> rusqlite::Result<Vec<(String, Vec<Value>)>> {
    let start = paris_day_start_utc(from_key).unwrap_or_default();
    let now_iso = iso_utc(now);
    let since = if start > now_iso { start } else { now_iso };
    let mut st = c.prepare(
        "SELECT * FROM matches
          WHERE league = 'nba' AND status = 'scheduled' AND date_utc >= ?1
          ORDER BY date_utc ASC, id ASC LIMIT 120",
    )?;
    let rows: Vec<MatchRow> = st
        .query_map([since], match_row)?
        .collect::<rusqlite::Result<_>>()?;
    let mut groups: Vec<(String, Vec<MatchRow>)> = Vec::new();
    for r in rows {
        let k = crate::present::day_key(&r.date_utc);
        if groups.last().is_none_or(|g| g.0 != k) {
            if groups.len() >= max_days {
                break;
            }
            groups.push((k, Vec::new()));
        }
        if let Some(g) = groups.last_mut() {
            g.1.push(r);
        }
    }
    groups
        .into_iter()
        .map(|(k, rows)| Ok((k, to_views(c, &rows, running)?)))
        .collect()
}

// ---------------------------------------------------------------- calendrier

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DayCount {
    pub total: i64,
    pub final_: i64,
    pub live: i64,
    pub replays: i64,
}

impl DayCount {
    pub fn to_json(self) -> Value {
        json!({ "total": self.total, "final": self.final_, "live": self.live, "replays": self.replays })
    }
}

/// `dayCounts` : matchs par jour de Paris sur [from_key, to_key] (inclus),
/// par clé croissante.
pub fn day_counts(
    c: &Connection,
    from_key: &str,
    to_key: &str,
) -> rusqlite::Result<BTreeMap<String, DayCount>> {
    let mut st = c.prepare(
        "SELECT date_utc, status, video_available FROM matches
          WHERE league = 'nba' AND date_utc >= ?1 AND date_utc < ?2",
    )?;
    let from = paris_day_start_utc(from_key).unwrap_or_default();
    let to = paris_day_start_utc(&shift_key(to_key, 1)).unwrap_or_default();
    let rows = st.query_map(params![from, to], |r| {
        Ok((
            db::col_text(r, "date_utc").unwrap_or_default(),
            db::col_text(r, "status").unwrap_or_default(),
            // `if (r.video_available)` : valeur « vraie ».
            match db::col(r, "video_available") {
                rusqlite::types::Value::Integer(i) => i != 0,
                rusqlite::types::Value::Real(f) => f != 0.0 && !f.is_nan(),
                rusqlite::types::Value::Text(s) => !s.is_empty(),
                _ => false,
            },
        ))
    })?;
    let mut map: BTreeMap<String, DayCount> = BTreeMap::new();
    for r in rows {
        let (date, status, video) = r?;
        let e = map.entry(crate::present::day_key(&date)).or_default();
        e.total += 1;
        if status == "final" {
            e.final_ += 1;
        }
        if status == "live" {
            e.live += 1;
        }
        if video {
            e.replays += 1;
        }
    }
    Ok(map)
}

/// `gamesOfDay`.
pub fn games_of_day(
    c: &Connection,
    key: &str,
    running: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let (from, to) = day_bounds(key);
    let f = MatchFilters {
        from: Some(from),
        to: Some(to),
        limit: 40,
        ..filters()
    };
    to_views(c, &list_matches(c, &f)?, running)
}

fn first_date(c: &Connection, sql: &str, bound: String) -> rusqlite::Result<Option<String>> {
    let r: Option<String> = c
        .query_row(sql, [bound], |r| {
            Ok(db::col_text(r, "date_utc").unwrap_or_default())
        })
        .optional()?;
    Ok(r.map(|d| crate::present::day_key(&d)))
}

/// `nextDayWithGames` : premier jour (Paris) ≥ `key` (> si `strict`) ayant un match.
pub fn next_day_with_games(
    c: &Connection,
    key: &str,
    strict: bool,
) -> rusqlite::Result<Option<String>> {
    let from = paris_day_start_utc(&if strict {
        shift_key(key, 1)
    } else {
        key.to_string()
    })
    .unwrap_or_default();
    first_date(
        c,
        "SELECT date_utc FROM matches WHERE league = 'nba' AND date_utc >= ?1 ORDER BY date_utc ASC LIMIT 1",
        from,
    )
}

/// `prevDayWithGames` : dernier jour (Paris) < `key` ayant un match.
pub fn prev_day_with_games(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    first_date(
        c,
        "SELECT date_utc FROM matches WHERE league = 'nba' AND date_utc < ?1 ORDER BY date_utc DESC LIMIT 1",
        paris_day_start_utc(key).unwrap_or_default(),
    )
}

/// `defaultCalendarDay` : aujourd'hui s'il reste des matchs à jouer, sinon le
/// prochain jour avec des matchs.
///
/// Côté Node, la seconde condition (« ou le matin », heure de Paris < 14) ne
/// joue jamais : `Intl` en français écrit l'heure « 20 h », et
/// `Number('20 h')` vaut NaN. Reproduit tel quel (même jour par défaut) ;
/// à corriger des deux côtés ensemble, ou à l'étape 8b.
pub fn default_calendar_day(c: &Connection, now: DateTime<Utc>) -> rusqlite::Result<String> {
    let today = today_key(now);
    let counts = day_counts(c, &today, &today)?;
    if let Some(d) = counts.get(&today) {
        if d.final_ < d.total {
            return Ok(today);
        }
    }
    Ok(next_day_with_games(c, &today, true)?.unwrap_or(today))
}

// ---------------------------------------------------------------- équipes

/// `latestSeason` : saison la plus récente en base (année de début).
pub fn latest_season(c: &Connection) -> rusqlite::Result<Option<i64>> {
    c.query_row(
        "SELECT MAX(season) AS s FROM matches WHERE league = 'nba'",
        [],
        |r| r.get::<_, Option<i64>>(0),
    )
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamRecord {
    pub wins: i64,
    pub losses: i64,
}

impl TeamRecord {
    pub fn to_json(self) -> Value {
        json!({ "wins": self.wins, "losses": self.losses })
    }
}

/// `seasonRecords` : bilan V-D de la saison régulière `season`, par équipe.
pub fn season_records(
    c: &Connection,
    season: Option<i64>,
) -> rusqlite::Result<BTreeMap<String, TeamRecord>> {
    let mut map = BTreeMap::new();
    let Some(season) = season else {
        return Ok(map);
    };
    let mut st = c.prepare(
        "SELECT abbr, SUM(win) AS w, SUM(1 - win) AS l FROM (
            SELECT home_abbr AS abbr, (home_score > away_score) AS win FROM matches
             WHERE league = 'nba' AND season = ?1 AND season_type = 'regular' AND status = 'final'
               AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score
            UNION ALL
            SELECT away_abbr, (away_score > home_score) FROM matches
             WHERE league = 'nba' AND season = ?1 AND season_type = 'regular' AND status = 'final'
               AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score
          ) GROUP BY abbr",
    )?;
    let rows = st.query_map([season], |r| {
        Ok((
            db::col_text(r, "abbr").unwrap_or_default(),
            db::col_int(r, "w").unwrap_or(0),
            db::col_int(r, "l").unwrap_or(0),
        ))
    })?;
    for r in rows {
        let (abbr, w, l) = r?;
        map.insert(abbr, TeamRecord { wins: w, losses: l });
    }
    Ok(map)
}

/// `nextGameByTeam` : prochain match (programmé et futur, ou en cours) de chaque équipe.
pub fn next_game_by_team(
    c: &Connection,
    now: DateTime<Utc>,
    running: Option<i64>,
) -> rusqlite::Result<HashMap<String, Value>> {
    let mut st = c.prepare(
        "SELECT * FROM matches
          WHERE league = 'nba' AND (status = 'live' OR (status = 'scheduled' AND date_utc > ?1))
          ORDER BY date_utc ASC LIMIT 300",
    )?;
    let rows: Vec<MatchRow> = st
        .query_map([iso_utc(now)], match_row)?
        .collect::<rusqlite::Result<_>>()?;
    let mut pick: Vec<(String, usize)> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        for abbr in [&r.home_abbr, &r.away_abbr] {
            if !pick.iter().any(|(a, _)| a == abbr) {
                pick.push((abbr.clone(), i));
            }
        }
    }
    // `[...new Set(pick.values())]` : chaque ligne une fois, ordre de première apparition.
    let mut uniq: Vec<usize> = Vec::new();
    for (_, i) in &pick {
        if !uniq.contains(i) {
            uniq.push(*i);
        }
    }
    let picked: Vec<MatchRow> = uniq.iter().map(|i| rows[*i].clone()).collect();
    let views = to_views(c, &picked, running)?;
    let by_row: HashMap<usize, &Value> = uniq.iter().copied().zip(views.iter()).collect();
    Ok(pick
        .into_iter()
        .map(|(abbr, i)| (abbr, by_row[&i].clone()))
        .collect())
}

/// `teamGames` : tous les matchs d'une équipe (toutes saisons en base), chronologiques.
pub fn team_games(
    c: &Connection,
    abbr: &str,
    running: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let f = MatchFilters {
        team: Some(abbr.to_string()),
        limit: 400,
        ..filters()
    };
    to_views(c, &list_matches(c, &f)?, running)
}

/// `isUpcoming` : programmé dans le futur, ou en cours.
pub fn is_upcoming(g: &Value, now: DateTime<Utc>) -> bool {
    let status = g["status"].as_str().unwrap_or("");
    status == "live"
        || (status == "scheduled"
            && g["date_utc"]
                .as_str()
                .and_then(parse_instant)
                .is_some_and(|d| d > now))
}

// ---------------------------------------------------------------- classement

pub const STANDINGS_KEY: &str = "standings:nba";

/// `cachedStandings` : classement ESPN tel qu'il est en cache (aucun appel réseau).
pub fn cached_standings(c: &Connection) -> rusqlite::Result<Option<Value>> {
    db::kv_get(c, STANDINGS_KEY, None)
}

/// `r.seed || i + 1`.
pub fn seed_or(row: &Value, i: usize) -> Value {
    if crate::js::truthy(row.get("seed")) {
        row["seed"].clone()
    } else {
        Value::from(i as i64 + 1)
    }
}

/// Lignes d'une conférence du classement en cache.
pub fn conference_rows(conf: &Value) -> Vec<Value> {
    crate::js::items(conf.get("rows"))
}

/// `conferenceSeeds` : rang de conférence par équipe, depuis le cache du classement.
pub fn conference_seeds(c: &Connection) -> rusqlite::Result<HashMap<String, Value>> {
    let mut map = HashMap::new();
    for conf in crate::js::items(cached_standings(c)?.as_ref()) {
        for (i, r) in conference_rows(&conf).iter().enumerate() {
            map.insert(crate::js::string_of(r.get("abbr")), seed_or(r, i));
        }
    }
    Ok(map)
}

/// Objet `{ clé: valeur }` dans l'ordre des clés (sérialisation d'une `Map`).
pub fn object_of<V>(map: &BTreeMap<String, V>, f: impl Fn(&V) -> Value) -> Value {
    let mut m = Map::new();
    for (k, v) in map {
        m.insert(k.clone(), f(v));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cles_de_jour_comme_node() {
        assert!(is_date_key("2026-10-31"));
        assert!(is_date_key("2024-02-29"));
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "2026-1-01",
            "2026-10-31x",
            "",
            "abcd-ef-gh",
        ] {
            assert!(!is_date_key(bad), "{bad}");
        }
        assert_eq!(night_key_of("2026-10-30T00:30Z"), "2026-10-29");
        assert_eq!(night_key_of("2026-10-29T17:00:00.000Z"), "2026-10-29");
        assert_eq!(
            night_bounds("2026-10-24"),
            (
                "2026-10-24T10:00:00.000Z".to_string(),
                "2026-10-25T10:00:00.000Z".to_string()
            )
        );
    }
}
