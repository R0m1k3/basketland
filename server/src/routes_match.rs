//! Fiche d'un match (`/api/matches/[id]`, `/stats`, `/clips`) et classements.

use crate::api::{error, js_number, json_response, ok};
use crate::db;
use crate::present::to_dto;
use crate::routes::{db_error, guarded};
use crate::state::AppState;
use axum::extract::{OriginalUri, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

/// `parseId` : `Number(segment)` entier strictement positif.
pub fn parse_id(raw: &str) -> Option<i64> {
    let n = js_number(raw);
    (n.is_finite() && n.fract() == 0.0 && n > 0.0).then_some(if n > i64::MAX as f64 {
        i64::MAX
    } else {
        n as i64
    })
}

pub async fn detail(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        let Some(id) = parse_id(&raw) else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        match st.db.run(move |c| db::get_match(c, id)).await {
            Ok(Some(m)) => ok(to_dto(&m)),
            Ok(None) => error(StatusCode::NOT_FOUND, "match introuvable"),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

const STAT_COLUMNS: [&str; 14] = [
    "MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "TO", "STL", "BLK", "OREB", "DREB", "PF", "+/-",
];

/// Stats équipe + joueurs. Match terminé dont les stats ne sont pas encore
/// en base : relayé à Node, qui les récupère chez ESPN à la volée.
pub async fn stats(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let uri = OriginalUri(req.uri().clone());
    let headers = req.headers().clone();
    let st2 = st.clone();
    let fut = async move {
        let Some(id) = parse_id(&raw) else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        let r = st2
            .db
            .run(move |c| {
                let Some(m) = db::get_match(c, id)? else {
                    return Ok(None);
                };
                if m.status != "final" || !db::stats_synced(c, id)? {
                    return Ok(Some((m, None)));
                }
                Ok(Some((
                    m,
                    Some((
                        db::team_stats(c, id)?,
                        db::player_stats(c, id)?,
                        db::leaders(c, id)?,
                    )),
                )))
            })
            .await;
        let (m, data) = match r {
            Ok(Some(x)) => x,
            Ok(None) => return error(StatusCode::NOT_FOUND, "match introuvable"),
            Err(e) => return db_error(e),
        };
        if m.status != "final" {
            return ok(
                json!({ "available": false, "status": m.status, "reason": "Statistiques disponibles à la fin du match" }),
            );
        }
        let Some((teams, players, leaders)) = data else {
            return crate::proxy::forward(State(st2.clone()), req).await;
        };
        if players.is_empty() {
            return ok(
                json!({ "available": false, "status": m.status, "reason": "Statistiques pas encore publiées" }),
            );
        }
        let order = [m.away_abbr.clone(), m.home_abbr.clone()];
        let teams_out: Vec<Value> = order
            .iter()
            .map(|abbr| {
                let home = *abbr == m.home_abbr;
                let stats = match teams.iter().find(|(t, _)| t == abbr).map(|(_, s)| s.clone()) {
                    None | Some(Value::Null) => json!({}),
                    Some(s) => s,
                };
                json!({
                    "abbr": abbr,
                    "name": if home { &m.home_name } else { &m.away_name },
                    "score": db::sql_to_json(if home { m.home_score.clone() } else { m.away_score.clone() }),
                    "stats": stats,
                    "players": players.iter().filter(|p| p.team_abbr == *abbr).map(|p| json!({
                        "id": p.player_id, "name": p.player_name, "position": p.position, "jersey": p.jersey,
                        "starter": p.starter, "stats": p.stats,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        ok(
            json!({ "available": true, "status": m.status, "columns": STAT_COLUMNS, "teams": teams_out, "leaders": leaders }),
        )
    };
    guarded(&st, &uri, &headers, fut).await
}

/// Hors périmètre v1 : enregistrements personnels (table user_clips prévue).
pub async fn clips(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        let Some(id) = parse_id(&raw) else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        let r = st
            .db
            .run(move |c| {
                Ok(if db::get_match(c, id)?.is_some() {
                    Some(db::clips(c, id)?)
                } else {
                    None
                })
            })
            .await;
        match r {
            Ok(Some(clips)) => ok(json!({ "match_id": id, "clips": clips, "implemented": false })),
            Ok(None) => error(StatusCode::NOT_FOUND, "match introuvable"),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

pub async fn clips_post(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    guarded(&st, &uri, &headers, async {
        error(
            StatusCode::NOT_IMPLEMENTED,
            "Enregistrement personnel non disponible en v1",
        )
    })
    .await
}

/// Classements NBA : cache de 30 min, cache périmé si ESPN ne répond pas.
pub async fn standings(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    const KEY: &str = "standings:nba";
    let fut = async {
        let cached = match st.db.run(|c| db::kv_get(c, KEY, Some(30 * 60_000))).await {
            Ok(v) => v,
            Err(e) => return db_error(e),
        };
        let data = match cached {
            Some(v) => v,
            None => match crate::espn::fetch_standings("nba").await {
                Ok(v) => {
                    let v2 = v.clone();
                    if let Err(e) = st.db.run(move |c| db::kv_set(c, KEY, &v2)).await {
                        return db_error(e);
                    }
                    v
                }
                Err(msg) => match st.db.run(|c| db::kv_get(c, KEY, None)).await {
                    Ok(Some(v)) => v,
                    Ok(None) => {
                        return json_response(StatusCode::BAD_GATEWAY, &json!({ "error": msg }))
                    }
                    Err(e) => return db_error(e),
                },
            },
        };
        ok(json!({ "conferences": data }))
    };
    guarded(&st, &uri, &headers, fut).await
}

#[cfg(test)]
mod tests {
    use super::parse_id;

    #[test]
    fn identifiant_comme_parseid() {
        assert_eq!(parse_id("401"), Some(401));
        assert_eq!(parse_id("1e3"), Some(1000));
        assert_eq!(parse_id("0x10"), Some(16));
        assert_eq!(parse_id("0"), None);
        assert_eq!(parse_id("-3"), None);
        assert_eq!(parse_id("1.5"), None);
        assert_eq!(parse_id("abc"), None);
        assert_eq!(parse_id(""), None);
    }
}
