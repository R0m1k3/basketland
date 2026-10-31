//! Routes d'API servies par Rust. Toute autre requête est relayée à Node.

use crate::api::{error, int_param, js_num_value, js_number, json_response, ok, Query};
use crate::auth::{self, Access};
use crate::db::{self, MatchFilters};
use crate::present::{group_by_paris_day, to_dto};
use crate::state::AppState;
use crate::time::{self, PARIS_TZ};
use axum::extract::{OriginalUri, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use chrono::Utc;
use serde_json::{json, Value};

/// Garde d'accès + renouvellement du cookie de session, autour d'un gestionnaire.
pub(crate) async fn guarded(
    st: &AppState,
    uri: &OriginalUri,
    headers: &HeaderMap,
    res: impl std::future::Future<Output = Response>,
) -> Response {
    let session = match auth::check_api(&st.db, uri.path(), headers).await {
        Ok(Access::Allowed(s)) => s,
        Ok(Access::Unauthorized) => return error(StatusCode::UNAUTHORIZED, "non connecté"),
        Err(e) => {
            eprintln!("[serveur] session illisible : {e}");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "base de données indisponible",
            );
        }
    };
    let mut res = res.await;
    if let Some(s) = session.filter(|s| s.renewed) {
        if let Some(token) = auth::cookie(headers, auth::SESSION_COOKIE) {
            if let Some(v) =
                auth::session_cookie(&token, &s.expires_at, auth::is_https(headers), Utc::now())
            {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    res
}

pub(crate) fn db_error(e: String) -> Response {
    eprintln!("[serveur] erreur SQLite : {e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, &e)
}

// ---------------------------------------------------------------- /api/health

pub async fn health(State(st): State<AppState>) -> Response {
    let r = st
        .db
        .run(|c| {
            let n = db::count_all_matches(c)?;
            Ok((n, db::last_successful_ingest(c)?, db::last_ingests(c, 5)?))
        })
        .await;
    let (h, last, recent) = match r {
        Ok((n, last, recent)) => (json!({ "ok": true, "matches": n }), last, recent),
        Err(e) => (
            json!({ "ok": false, "matches": 0, "error": e }),
            None,
            Vec::new(),
        ),
    };
    let up = h["ok"] == true;
    let body = json!({
        "status": if up { "ok" } else { "error" },
        "db": h,
        "last_sync": last.map(|l| json!({ "task": l.task, "finished_at": l.finished_at, "detail": l.detail })),
        "recent_jobs": recent.into_iter().map(|j| json!({ "task": j.task, "ok": j.ok, "finished_at": j.finished_at })).collect::<Vec<_>>(),
        "ffmpeg": crate::state::ffmpeg_available(),
        "node": crate::state::node_version(),
        "server": concat!("rust ", env!("CARGO_PKG_VERSION")),
        "time": time::iso_utc(Utc::now()),
    });
    json_response(
        if up {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        &body,
    )
}

// ---------------------------------------------------------------- /api/schedule

/// Calendrier : matchs récents + à venir, groupés par date Europe/Paris.
pub async fn schedule(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let q = Query::parse(uri.query());
    let fut = async {
        let back = int_param(q.get("days_back"), 3, 0, 30);
        let ahead = int_param(q.get("days_ahead"), 7, 0, 30);
        let today = time::paris_date_key(Utc::now());
        let (Some(from), Some(to)) = (
            time::shift_key(&today, -back).and_then(|k| time::paris_day_start_utc(&k)),
            time::shift_key(&today, ahead + 1).and_then(|k| time::paris_day_start_utc(&k)),
        ) else {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "date invalide");
        };
        let f = MatchFilters {
            team: q.get("team").filter(|t| !t.is_empty()).map(str::to_string),
            from: Some(from.clone()),
            to: Some(to.clone()),
            limit: 1000,
            ..Default::default()
        };
        let rows = match st.db.run(move |c| db::list_matches(c, &f)).await {
            Ok(r) => r,
            Err(e) => return db_error(e),
        };
        let days: Vec<Value> = group_by_paris_day(rows.iter().map(to_dto).collect())
            .into_iter()
            .map(|g| json!({ "date": g.date, "label": g.label, "is_today": g.date == today, "matches": g.matches }))
            .collect();
        ok(json!({ "timezone": PARIS_TZ, "today": today, "from": from, "to": to, "days": days }))
    };
    guarded(&st, &uri, &headers, fut).await
}

// ---------------------------------------------------------------- /api/matches

const STATUSES: [&str; 3] = ["scheduled", "live", "final"];

fn is_date_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `GET /api/matches?status=final&season=2026&team=LAL&date=2026-10-28&limit=50&offset=0`
/// Sans filtre de statut/saison/date : matchs du jour (Paris) et à venir.
pub async fn matches(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    let q = Query::parse(uri.query());
    let fut = async {
        let status = q.get("status");
        if let Some(s) = status.filter(|s| !s.is_empty()) {
            if !STATUSES.contains(&s) {
                return error(
                    StatusCode::BAD_REQUEST,
                    &format!("status invalide ({})", STATUSES.join("|")),
                );
            }
        }
        let date = q.get("date");
        if let Some(d) = date.filter(|d| !d.is_empty()) {
            if !is_date_key(d) {
                return error(
                    StatusCode::BAD_REQUEST,
                    "date attendue au format YYYY-MM-DD (jour à Paris)",
                );
            }
        }
        // `Number(season)` : NaN et 0 ne filtrent pas (falsy), mais 0 est renvoyé tel quel.
        let season_raw = q.get("season").filter(|s| !s.is_empty()).map(js_number);
        let season = season_raw.filter(|s| !s.is_nan() && *s != 0.0);
        let team = q.get("team");
        let mut f = MatchFilters {
            league: Some(q.get("league").unwrap_or("nba").to_string()),
            status: status.filter(|s| !s.is_empty()).map(str::to_string),
            season,
            team: team.filter(|t| !t.is_empty()).map(str::to_string),
            limit: int_param(q.get("limit"), 50, 1, 500),
            offset: int_param(q.get("offset"), 0, 0, 1_000_000),
            desc: q.get("order") == Some("desc"),
            ..Default::default()
        };
        if q.get("video") == Some("1") {
            f.video = Some(true);
        }
        if let Some(d) = date.filter(|d| !d.is_empty()) {
            let (Some(from), Some(to)) = (
                time::paris_day_start_utc(d),
                time::next_utc_day(d).and_then(|n| time::paris_day_start_utc(&n)),
            ) else {
                return error(StatusCode::BAD_REQUEST, "date invalide");
            };
            f.from = Some(from);
            f.to = Some(to);
        } else if f.status.is_none() && f.season.is_none() && q.get("all") != Some("1") {
            // Par défaut : à partir du début de la journée en cours à Paris.
            f.from = time::paris_day_start_utc(&time::paris_date_key(Utc::now()));
        }
        let f2 = f.clone();
        let (rows, total) = match st
            .db
            .run(move |c| Ok((db::list_matches(c, &f2)?, db::count_matches(c, &f2)?)))
            .await
        {
            Ok(r) => r,
            Err(e) => return db_error(e),
        };
        let dtos: Vec<Value> = rows.iter().map(to_dto).collect();
        let groups: Vec<Value> = group_by_paris_day(dtos.clone())
            .into_iter()
            .map(|g| json!({ "date": g.date, "label": g.label, "ids": g.matches.iter().map(|m| m["id"].clone()).collect::<Vec<_>>() }))
            .collect();
        ok(json!({
            "timezone": PARIS_TZ,
            "total": total,
            "limit": f.limit,
            "offset": f.offset,
            "filters": {
                "status": status,
                "season": season_raw.map(js_num_value),
                "team": team,
                "date": date,
                "from": f.from,
            },
            "matches": dtos,
            "groups": groups,
        }))
    };
    guarded(&st, &uri, &headers, fut).await
}
