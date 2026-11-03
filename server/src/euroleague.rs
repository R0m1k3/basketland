//! Onglet Euroleague (`GET /api/pages/euroleague`) : matchs à venir, derniers
//! résultats et classement de la saison en cours.
//!
//! Source : l'API publique de l'Euroleague (`api-live.euroleague.net`, celle
//! du site officiel), lue à la demande et gardée 10 min en cache
//! (`kv_cache`, clé `euroleague:<saison>`). Rien n'est écrit dans la table
//! des matchs : l'Euroleague n'a ni replays ni sous-titres ici.
//!
//! - calendrier : `v2/competitions/E/seasons/E<année>/games` (toute la
//!   saison, `played` vrai une fois le score officiel) ;
//! - classement : `v3/…/rounds/<journée>/basicstandings`, pour la dernière
//!   journée de saison régulière jouée (départages officiels compris).

use crate::time;
use chrono::{DateTime, Datelike, Duration, Utc};
use serde_json::{json, Value};

pub const API: &str = "https://api-live.euroleague.net";

/// Durée de validité du cache (scores du soir rafraîchis assez vite).
pub const CACHE_MS: i64 = 10 * 60_000;

/// Un match non marqué joué est « en cours » pendant ce temps après le coup d'envoi.
const LIVE_WINDOW_H: i64 = 3;

/// Nombre de journées montrées dans « À venir » et dans « Résultats ».
const ROUNDS_SHOWN: usize = 2;

/// Saison Euroleague à une date : `E2026` pour 2026-27 (début en juillet).
pub fn season_code(now: DateTime<Utc>) -> String {
    let p = now.with_timezone(&chrono_tz::Europe::Paris);
    let year = if p.month() >= 7 {
        p.year()
    } else {
        p.year() - 1
    };
    format!("E{year}")
}

pub fn cache_key(season: &str) -> String {
    format!("euroleague:{season}")
}

fn games_url(season: &str) -> String {
    format!("{API}/v2/competitions/E/seasons/{season}/games")
}

fn standings_url(season: &str, round: i64) -> String {
    format!("{API}/v3/competitions/E/seasons/{season}/rounds/{round}/basicstandings")
}

// ---------------------------------------------------------------- lecture de l'API

fn s(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
}

/// Club d'un match ou d'une ligne de classement.
fn club(c: &Value) -> Value {
    let code = s(&c["code"]).unwrap_or_default();
    let full = s(&c["name"]).unwrap_or_else(|| code.clone());
    let short = s(&c["abbreviatedName"])
        .or_else(|| s(&c["editorialName"]))
        .unwrap_or_else(|| full.clone());
    json!({
        "code": code,
        "tv": s(&c["tvCode"]).unwrap_or_else(|| code.clone()),
        "name": short,
        "full": full,
        "crest": s(&c["images"]["crest"]),
    })
}

/// Libellé de la phase et de la journée d'un match.
fn round_label(g: &Value) -> String {
    let round = g["round"].as_i64();
    match g["phaseType"]["code"].as_str().unwrap_or("") {
        "RS" => round.map_or("Saison régulière".into(), |r| format!("Journée {r}")),
        "PI" => "Play-in".into(),
        "PO" => "Playoffs".into(),
        "FF" => "Final Four".into(),
        _ => s(&g["phaseType"]["name"])
            .or_else(|| s(&g["roundName"]))
            .unwrap_or_else(|| "Euroleague".into()),
    }
}

/// Matchs de la réponse `games`, réduits à ce que la page affiche, triés
/// par coup d'envoi. Les matchs sans date lisible sont écartés.
pub fn parse_games(raw: &Value) -> Vec<Value> {
    let list = raw["data"].as_array().or_else(|| raw.as_array());
    let mut out: Vec<(DateTime<Utc>, Value)> = list
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let at = s(&g["utcDate"]).and_then(|d| time::parse_instant(&d))?;
            let played = g["played"].as_bool().unwrap_or(false);
            let side = |k: &str| {
                let mut c = club(&g[k]["club"]);
                c["score"] = if played {
                    g[k]["score"].clone()
                } else {
                    Value::Null
                };
                c
            };
            Some((
                at,
                json!({
                    "code": g["gameCode"].as_i64().or_else(|| g["code"].as_i64()),
                    "phase": s(&g["phaseType"]["code"]).unwrap_or_default(),
                    "round": g["round"].as_i64(),
                    "round_label": round_label(g),
                    "utc": time::iso_utc(at),
                    "played": played,
                    "home": side("local"),
                    "away": side("road"),
                    "venue": s(&g["venue"]["name"]),
                }),
            ))
        })
        .collect();
    out.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1["code"].as_i64().cmp(&b.1["code"].as_i64()))
    });
    out.into_iter().map(|(_, g)| g).collect()
}

/// Dernière journée de saison régulière où au moins un match est joué.
pub fn last_played_round(games: &[Value]) -> Option<i64> {
    games
        .iter()
        .filter(|g| g["phase"] == "RS" && g["played"] == true)
        .filter_map(|g| g["round"].as_i64())
        .max()
}

fn int(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| {
            v.as_str()
                .and_then(|x| x.trim().trim_start_matches('+').parse().ok())
        })
        .unwrap_or(0)
}

/// Lignes de la réponse `basicstandings`.
pub fn parse_standings(raw: &Value) -> Vec<Value> {
    let mut rows: Vec<Value> = raw["teams"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let mut row = club(&t["club"]);
            let form: Vec<Value> = t["last5Form"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str().map(|r| json!(r.to_ascii_uppercase())))
                .collect();
            let fields = json!({
                "position": int(&t["position"]),
                "played": int(&t["gamesPlayed"]),
                "wins": int(&t["gamesWon"]),
                "losses": int(&t["gamesLost"]),
                "pct": s(&t["winPercentage"]).unwrap_or_default(),
                "pf": int(&t["pointsFor"]),
                "pa": int(&t["pointsAgainst"]),
                "diff": int(&t["pointsDifference"]),
                "home": s(&t["homeRecord"]).unwrap_or_default(),
                "road": s(&t["awayRecord"]).unwrap_or_default(),
                "form": form,
            });
            for (k, v) in fields.as_object().unwrap() {
                row[k] = v.clone();
            }
            row
        })
        .collect();
    rows.sort_by_key(|r| r["position"].as_i64().unwrap_or(i64::MAX));
    rows
}

/// Données mises en cache : calendrier de la saison et classement.
pub fn snapshot(
    season: &str,
    games: Vec<Value>,
    standings: Vec<Value>,
    round: Option<i64>,
) -> Value {
    json!({
        "season": season,
        "games": games,
        "standings": standings,
        "standings_round": round,
    })
}

/// Lit l'API : calendrier, puis classement de la dernière journée jouée.
/// Un classement injoignable n'empêche pas d'afficher les matchs.
pub async fn fetch(season: &str) -> Result<Value, String> {
    let raw = crate::http::fetch_json(&games_url(season)).await?;
    let games = parse_games(&raw);
    let round = last_played_round(&games);
    let standings = match round {
        Some(r) => match crate::http::fetch_json(&standings_url(season, r)).await {
            Ok(v) => parse_standings(&v),
            Err(e) => {
                eprintln!("[euroleague] classement indisponible : {e}");
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    Ok(snapshot(season, games, standings, round))
}

// ---------------------------------------------------------------- page

/// `2026-27` pour `E2026`.
pub fn season_label(season: &str) -> String {
    season
        .trim_start_matches('E')
        .parse::<i32>()
        .map(|y| format!("{y}-{:02}", (y + 1) % 100))
        .unwrap_or_else(|_| season.to_string())
}

/// État d'un match à `now` : `final`, `live`, `pending` (heure passée, score
/// pas encore publié) ou `scheduled`.
fn status(g: &Value, now: DateTime<Utc>) -> &'static str {
    if g["played"] == true {
        return "final";
    }
    match g["utc"].as_str().and_then(time::parse_instant) {
        Some(at) if at <= now && now < at + Duration::hours(LIVE_WINDOW_H) => "live",
        Some(at) if at <= now => "pending",
        _ => "scheduled",
    }
}

fn view(g: &Value, now: DateTime<Utc>) -> Value {
    let mut v = g.clone();
    if let Some(at) = g["utc"].as_str().and_then(time::parse_instant) {
        v["day_paris"] = json!(time::paris_date_key(at));
        v["time_paris"] = json!(time::paris_time(at));
    }
    v["status"] = json!(status(g, now));
    v
}

/// Garde les matchs des `n` premières journées rencontrées (ordre de `games`).
fn first_rounds<'a>(games: impl Iterator<Item = &'a Value>, n: usize) -> Vec<&'a Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for g in games {
        let key = format!("{}:{}", g["phase"], g["round_label"]);
        if !seen.contains(&key) {
            if seen.len() == n {
                break;
            }
            seen.push(key);
        }
        out.push(g);
    }
    out
}

/// `GET /api/pages/euroleague` : `data` est le cache (ou `None` si l'API n'a
/// jamais répondu).
pub fn page(data: Option<&Value>, season: &str, now: DateTime<Utc>, spoilers: &str) -> Value {
    let empty = Vec::new();
    let games = data.and_then(|d| d["games"].as_array()).unwrap_or(&empty);
    // À venir : matchs pas encore joués (en cours compris), deux journées.
    let upcoming: Vec<Value> =
        first_rounds(games.iter().filter(|g| g["played"] != true), ROUNDS_SHOWN)
            .into_iter()
            .map(|g| view(g, now))
            .collect();
    // Résultats : deux dernières journées jouées, le plus récent d'abord.
    let results: Vec<Value> = first_rounds(
        games.iter().rev().filter(|g| g["played"] == true),
        ROUNDS_SHOWN,
    )
    .into_iter()
    .map(|g| view(g, now))
    .collect();
    let season = data.and_then(|d| d["season"].as_str()).unwrap_or(season);
    json!({
        "spoilers": spoilers,
        "today": time::paris_date_key(now),
        "season": season_label(season),
        "available": data.is_some(),
        "total": games.len(),
        "played": games.iter().filter(|g| g["played"] == true).count(),
        "upcoming": upcoming,
        "results": results,
        "standings": data.map(|d| d["standings"].clone()).filter(Value::is_array).unwrap_or_else(|| json!([])),
        "standings_round": data.map(|d| d["standings_round"].clone()).unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn game(
        code: i64,
        round: i64,
        utc: &str,
        played: bool,
        home: (&str, i64),
        away: (&str, i64),
    ) -> Value {
        let side = |(c, sc): (&str, i64)| {
            json!({
                "club": {
                    "code": c, "name": format!("{c} Club"), "abbreviatedName": format!("{c} abbr"),
                    "tvCode": c, "images": { "crest": format!("https://img/{c}.png") }
                },
                "score": sc
            })
        };
        json!({
            "gameCode": code, "round": round, "played": played, "utcDate": utc,
            "phaseType": { "code": "RS", "name": "Regular Season" },
            "local": side(home), "road": side(away),
            "venue": { "name": "Salle" }
        })
    }

    fn sample() -> Vec<Value> {
        parse_games(&json!({ "data": [
            game(21, 3, "2026-11-04T19:45:00Z", false, ("PAN", 0), ("BAR", 0)),
            game(11, 2, "2026-10-29T19:00:00Z", true, ("MAD", 90), ("OLY", 85)),
            game(1, 1, "2026-10-01T18:00:00Z", true, ("ASV", 70), ("PAR", 80)),
            game(12, 2, "2026-10-30T19:30:00Z", true, ("FEN", 101), ("ULK", 103)),
            game(31, 4, "2026-11-11T19:00:00Z", false, ("ASV", 0), ("MAD", 0)),
            game(41, 5, "2026-11-18T19:00:00Z", false, ("BAR", 0), ("OLY", 0)),
            { "gameCode": 99, "utcDate": null },
        ]}))
    }

    #[test]
    fn saison_qui_commence_en_juillet() {
        let at = |y, m, d| Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap();
        assert_eq!(season_code(at(2026, 11, 3)), "E2026");
        assert_eq!(season_code(at(2027, 5, 20)), "E2026");
        assert_eq!(season_code(at(2027, 7, 1)), "E2027");
        assert_eq!(season_label("E2026"), "2026-27");
        assert_eq!(season_label("E2099"), "2099-00");
    }

    #[test]
    fn matchs_tries_scores_seulement_une_fois_joues() {
        let g = sample();
        assert_eq!(g.len(), 6, "match sans date écarté");
        let codes: Vec<i64> = g.iter().map(|x| x["code"].as_i64().unwrap()).collect();
        assert_eq!(codes, [1, 11, 12, 21, 31, 41]);
        assert_eq!(g[1]["home"]["score"], 90);
        assert_eq!(g[1]["home"]["name"], "MAD abbr");
        assert_eq!(g[1]["home"]["full"], "MAD Club");
        assert_eq!(g[1]["home"]["crest"], "https://img/MAD.png");
        assert_eq!(g[1]["round_label"], "Journée 2");
        assert_eq!(g[3]["home"]["score"], Value::Null);
        assert_eq!(last_played_round(&g), Some(2));
    }

    #[test]
    fn page_a_venir_et_resultats_sur_deux_journees() {
        let data = snapshot("E2026", sample(), vec![], Some(2));
        let now = Utc.with_ymd_and_hms(2026, 11, 4, 20, 30, 0).unwrap();
        let p = page(Some(&data), "E2026", now, "show");
        let codes = |k: &str| -> Vec<i64> {
            p[k].as_array()
                .unwrap()
                .iter()
                .map(|x| x["code"].as_i64().unwrap())
                .collect()
        };
        assert_eq!(codes("upcoming"), [21, 31]);
        assert_eq!(codes("results"), [12, 11, 1]);
        assert_eq!(p["upcoming"][0]["status"], "live");
        assert_eq!(p["upcoming"][1]["status"], "scheduled");
        assert_eq!(p["upcoming"][1]["day_paris"], "2026-11-11");
        assert_eq!(p["upcoming"][1]["time_paris"], "20:00");
        assert_eq!(p["results"][0]["status"], "final");
        assert_eq!(p["season"], "2026-27");
        assert_eq!(p["available"], true);
        assert_eq!(p["played"], 3);
        // Coup d'envoi passé depuis longtemps, sans score : en attente.
        let later = now + Duration::hours(5);
        assert_eq!(
            page(Some(&data), "E2026", later, "show")["upcoming"][0]["status"],
            "pending"
        );
    }

    #[test]
    fn page_sans_donnees() {
        let now = Utc.with_ymd_and_hms(2026, 11, 4, 12, 0, 0).unwrap();
        let p = page(None, "E2026", now, "hide");
        assert_eq!(p["available"], false);
        assert_eq!(p["spoilers"], "hide");
        assert_eq!(p["upcoming"], json!([]));
        assert_eq!(p["standings"], json!([]));
        assert_eq!(p["season"], "2026-27");
    }

    #[test]
    fn classement_officiel() {
        let raw = json!({ "teams": [
            { "position": 2, "gamesPlayed": 9, "gamesWon": 6, "gamesLost": 3, "winPercentage": "66.7%",
              "pointsDifference": "-4", "pointsFor": 700, "pointsAgainst": 704, "homeRecord": "4-1",
              "awayRecord": "2-2", "last5Form": ["w", "L"],
              "club": { "code": "MAD", "name": "Real Madrid", "abbreviatedName": "Real Madrid", "tvCode": "RMB" } },
            { "position": 1, "gamesPlayed": 9, "gamesWon": 7, "gamesLost": 2, "winPercentage": "77.8%",
              "pointsDifference": "+86", "pointsFor": 761, "pointsAgainst": 675, "homeRecord": "6-1",
              "awayRecord": "1-1", "last5Form": ["W"],
              "club": { "code": "PAN", "name": "Panathinaikos AKTOR Athens", "abbreviatedName": "Panathinaikos",
                        "tvCode": "PAO", "images": { "crest": "https://img/pan.png" } } }
        ]});
        let rows = parse_standings(&raw);
        assert_eq!(rows[0]["code"], "PAN");
        assert_eq!(rows[0]["diff"], 86);
        assert_eq!(rows[0]["tv"], "PAO");
        assert_eq!(rows[0]["crest"], "https://img/pan.png");
        assert_eq!(rows[1]["diff"], -4);
        assert_eq!(rows[1]["form"], json!(["W", "L"]));
        assert_eq!(rows[1]["crest"], Value::Null);
        assert_eq!(rows[1]["home"], "4-1");
    }
}
