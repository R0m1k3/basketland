//! Routes servies par Rust, sur une vraie base SQLite temporaire.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use basketland_server::{app, auth, db, proxy, state};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::Value;
use tower::ServiceExt;

const SCHEMA: &str = "
CREATE TABLE matches (
  id INTEGER PRIMARY KEY, espn_id TEXT UNIQUE NOT NULL, league TEXT NOT NULL DEFAULT 'nba', season INTEGER NOT NULL,
  season_type TEXT NOT NULL, date_utc TEXT NOT NULL, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, home_score INTEGER, away_score INTEGER, status TEXT NOT NULL,
  status_detail TEXT DEFAULT '', period INTEGER DEFAULT 0, clock_display TEXT DEFAULT '', venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '', slug TEXT, video_ok_id TEXT, video_duration INTEGER, video_available INTEGER DEFAULT 0,
  video_checked_at TEXT, stats_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, video_kind TEXT);
CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER DEFAULT 0, detail TEXT DEFAULT '');
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT 'x', last_login_at TEXT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE team_stats (match_id INTEGER NOT NULL, team_abbr TEXT NOT NULL, stats_json TEXT NOT NULL, PRIMARY KEY (match_id, team_abbr));
CREATE TABLE player_stats (match_id INTEGER NOT NULL, team_abbr TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT NOT NULL,
  position TEXT DEFAULT '', jersey TEXT DEFAULT '', starter INTEGER DEFAULT 0, stats_json TEXT NOT NULL, PRIMARY KEY (match_id, player_id));
CREATE TABLE match_leaders (match_id INTEGER NOT NULL, team_abbr TEXT NOT NULL, category TEXT NOT NULL, label TEXT, player TEXT, value TEXT);
CREATE TABLE user_clips (id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, video_ts REAL NOT NULL, duration REAL, text_fr TEXT, created_at TEXT NOT NULL);
";

struct Env {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

fn setup() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    let c = Connection::open(&path).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    let now = Utc::now();
    let iso = |d: chrono::DateTime<Utc>| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let ins = "INSERT INTO matches (id, espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, home_score, away_score, status, video_ok_id, video_available, video_duration, video_kind, created_at, updated_at)
               VALUES (?1, ?2, 2026, 'regular', ?3, 'LAL', 'Lakers', 'BOS', 'Celtics', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'x', 'x')";
    c.execute(
        ins,
        rusqlite::params![
            1,
            "e1",
            iso(now - Duration::days(1)),
            101,
            99,
            "final",
            "ok1",
            1,
            8000,
            Option::<String>::None
        ],
    )
    .unwrap();
    c.execute(
        ins,
        rusqlite::params![
            2,
            "e2",
            iso(now + Duration::days(1)),
            Option::<i64>::None,
            Option::<i64>::None,
            "scheduled",
            Option::<String>::None,
            0,
            Option::<i64>::None,
            Option::<String>::None
        ],
    )
    .unwrap();
    c.execute(
        ins,
        rusqlite::params![
            3,
            "e3",
            iso(now + Duration::days(40)),
            Option::<i64>::None,
            Option::<i64>::None,
            "scheduled",
            "ok3",
            1,
            10,
            "mp4"
        ],
    )
    .unwrap();
    c.execute("INSERT INTO ingest_log (task, started_at, finished_at, ok, detail) VALUES ('schedule', 'a', 'b', 1, 'fini')", []).unwrap();
    c.execute(
        "INSERT INTO users (id, username, role, password_hash) VALUES (1, 'michel', 'admin', 'x')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sessions VALUES (?1, 1, 'x', ?2)",
        [
            auth::hash_token("jeton-valide"),
            iso(now + Duration::days(29) - Duration::hours(1)),
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sessions VALUES (?1, 1, 'x', ?2)",
        [
            auth::hash_token("jeton-frais"),
            iso(now + Duration::days(30)),
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sessions VALUES (?1, 1, 'x', ?2)",
        [
            auth::hash_token("jeton-expire"),
            iso(now - Duration::hours(1)),
        ],
    )
    .unwrap();
    Env { _dir: dir, path }
}

fn router(env: &Env) -> axum::Router {
    // Port fermé : ce qui n'est pas servi par Rust échoue en 502.
    app(state::AppState::new(
        db::Db::new(env.path.clone()),
        proxy::Upstream::new("http://127.0.0.1:9"),
        basketland_server::video::Video::new(),
    ))
}

async fn get(
    env: &Env,
    uri: &str,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut b = Request::get(uri);
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, format!("bl_session={c}"));
    }
    let res = router(env)
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn sante_publique() {
    let env = setup();
    let (s, h, v) = get(&env, "/api/health", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CACHE_CONTROL], "no-store");
    assert_eq!(v["status"], "ok");
    assert_eq!(v["db"], serde_json::json!({ "ok": true, "matches": 3 }));
    assert_eq!(
        v["last_sync"],
        serde_json::json!({ "task": "schedule", "finished_at": "b", "detail": "fini" })
    );
    assert_eq!(
        v["recent_jobs"],
        serde_json::json!([{ "task": "schedule", "ok": true, "finished_at": "b" }])
    );
}

#[tokio::test]
async fn sante_sans_base() {
    let dir = tempfile::tempdir().unwrap();
    let env = Env {
        path: dir.path().join("absente.db"),
        _dir: dir,
    };
    let (s, _, v) = get(&env, "/api/health", None).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["status"], "error");
    assert!(!env.path.exists(), "la base n'est jamais créée par Rust");
}

#[tokio::test]
async fn session_exigee() {
    let env = setup();
    for c in [None, Some("inconnu"), Some("jeton-expire")] {
        let (s, h, v) = get(&env, "/api/matches", c).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{c:?}");
        assert_eq!(v, serde_json::json!({ "error": "non connecté" }));
        assert_eq!(h[header::CACHE_CONTROL], "no-store");
    }
    // Session expirée effacée, comme côté Node.
    let c = Connection::open(&env.path).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE token_hash = ?1",
            [auth::hash_token("jeton-expire")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn renouvellement_glissant() {
    let env = setup();
    let (s, h, _) = get(&env, "/api/schedule", Some("jeton-valide")).await;
    assert_eq!(s, StatusCode::OK);
    let set = h[header::SET_COOKIE].to_str().unwrap();
    assert!(
        set.starts_with("bl_session=jeton-valide; Path=/; Expires="),
        "{set}"
    );
    assert!(
        set.contains("HttpOnly; SameSite=lax") && !set.contains("Secure"),
        "{set}"
    );
    // Session récente : pas de réécriture.
    let (s, h, _) = get(&env, "/api/schedule", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::OK);
    assert!(h.get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn liste_des_matchs() {
    let env = setup();
    let (s, _, v) = get(&env, "/api/matches?all=1", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["total"], 3);
    assert_eq!(
        v["filters"],
        serde_json::json!({ "status": null, "season": null, "team": null, "date": null, "from": null })
    );
    let m = &v["matches"][0];
    assert_eq!(m["id"], 1);
    assert_eq!(
        m["home"]["logo"],
        "https://a.espncdn.com/i/teamlogos/nba/500/lal.png"
    );
    assert_eq!(m["video"]["kind"], "hls");
    assert_eq!(m["video"]["src"], "/api/video/ok1/master.m3u8");
    assert_eq!(m["video"]["master"], "/api/video/ok1/master.m3u8");
    assert_eq!(m["stats_available"], true);
    assert_eq!(v["matches"][1]["video"]["kind"], Value::Null);
    assert_eq!(v["matches"][1]["home"]["score"], Value::Null);
    assert_eq!(v["matches"][2]["video"]["src"], "/api/video/ok3/file.mp4");
    assert_eq!(v["matches"][2]["video"]["master"], Value::Null);
    // Par défaut : à partir d'aujourd'hui (Paris).
    let (_, _, v) = get(&env, "/api/matches", Some("jeton-frais")).await;
    assert_eq!(v["total"], 2);
    assert!(v["filters"]["from"]
        .as_str()
        .unwrap()
        .ends_with(":00:00.000Z"));
    let (_, _, v) = get(
        &env,
        "/api/matches?status=final&season=2026&team=lal&order=desc",
        Some("jeton-frais"),
    )
    .await;
    assert_eq!(v["total"], 1);
    assert_eq!(v["filters"]["season"], 2026);
    assert_eq!(v["filters"]["team"], "lal");
    let (s, _, v) = get(&env, "/api/matches?status=fini", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "status invalide (scheduled|live|final)");
    let (s, _, _) = get(&env, "/api/matches?date=28-10-2026", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn calendrier_groupe_par_jour() {
    let env = setup();
    let (s, _, v) = get(&env, "/api/schedule", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["timezone"], "Europe/Paris");
    let days = v["days"].as_array().unwrap();
    // Le match dans 40 jours est hors plage (7 jours par défaut).
    let ids: Vec<i64> = days
        .iter()
        .flat_map(|d| {
            d["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["id"].as_i64().unwrap())
        })
        .collect();
    assert_eq!(ids, vec![1, 2]);
    assert!(days
        .iter()
        .all(|d| d["label"].as_str().unwrap().split(' ').count() == 4));
}

#[tokio::test]
async fn le_reste_part_a_node() {
    let env = setup();
    let (s, _, v) = get(&env, "/api/matches/1/replay", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert!(v["error"].as_str().unwrap().contains("Node"));
}

#[tokio::test]
async fn fiche_stats_et_clips() {
    let env = setup();
    let c = Connection::open(&env.path).unwrap();
    c.execute_batch(
        "UPDATE matches SET stats_synced_at = 'x' WHERE id = 1;
         INSERT INTO team_stats VALUES (1, 'LAL', '{\"PTS\":101,\"FG%\":45.0}');
         INSERT INTO player_stats VALUES (1, 'BOS', 'p2', 'Tatum', 'F', '0', 1, '{\"PTS\":\"30\"}');
         INSERT INTO player_stats VALUES (1, 'LAL', 'p1', 'James', 'F', '23', 1, '{\"PTS\":\"28\"}');
         INSERT INTO match_leaders VALUES (1, 'LAL', 'points', 'Points', 'James', '28');
         INSERT INTO user_clips VALUES (5, 1, 12.5, 3, 'panier', 'x');",
    )
    .unwrap();
    let tok = Some("jeton-frais");
    let (s, _, v) = get(&env, "/api/matches/1", tok).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["id"], 1);
    for (uri, code, msg) in [
        ("/api/matches/abc", 400, "id invalide"),
        ("/api/matches/99", 404, "match introuvable"),
    ] {
        let (s, _, v) = get(&env, uri, tok).await;
        assert_eq!(s.as_u16(), code, "{uri}");
        assert_eq!(v["error"], msg);
    }
    let (s, _, v) = get(&env, "/api/matches/1/stats", tok).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["available"], true);
    // Visiteurs d'abord, puis domicile ; stats d'équipe absentes → {}.
    assert_eq!(v["teams"][0]["abbr"], "BOS");
    assert_eq!(v["teams"][0]["stats"], serde_json::json!({}));
    assert_eq!(v["teams"][0]["players"][0]["name"], "Tatum");
    assert_eq!(
        v["teams"][1]["stats"],
        serde_json::json!({ "PTS": 101, "FG%": 45 })
    );
    assert_eq!(v["teams"][1]["score"], 101);
    assert_eq!(v["leaders"][0]["player"], "James");
    let (_, _, v) = get(&env, "/api/matches/2/stats", tok).await;
    assert_eq!(v["available"], false);
    assert_eq!(v["reason"], "Statistiques disponibles à la fin du match");
    let (_, _, v) = get(&env, "/api/matches/1/clips", tok).await;
    assert_eq!(
        v,
        serde_json::json!({ "match_id": 1, "clips": [{ "id": 5, "match_id": 1, "video_ts": 12.5, "duration": 3, "text_fr": "panier", "created_at": "x" }], "implemented": false })
    );
    let (s, _, _) = get(&env, "/api/matches/1/clips", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stats_pas_encore_recuperees_espn_injoignable() {
    let env = setup();
    // Match terminé sans stats_synced_at : récupérées chez ESPN à la volée (ici injoignable → 502).
    std::env::set_var("BL_ESPN_SITE", "http://127.0.0.1:9");
    let (s, _, v) = get(&env, "/api/matches/1/stats", Some("jeton-frais")).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(
        v,
        serde_json::json!({ "available": false, "status": "final", "reason": "Récupération ESPN impossible : fetch failed" })
    );
}

async fn post(
    env: &Env,
    uri: &str,
    body: Value,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut b = Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "nas:3012")
        .header(header::ORIGIN, "http://nas:3012");
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, format!("bl_session={c}"));
    }
    let res = router(env)
        .oneshot(b.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn session_of(h: &axum::http::HeaderMap) -> String {
    let c = h[header::SET_COOKIE].to_str().unwrap();
    c.strip_prefix("bl_session=")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn comptes_de_bout_en_bout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(SCHEMA)
        .unwrap();
    let env = Env { _dir: dir, path };
    basketland_server::accounts::reset_attempts();

    let (s, h, v) = post(&env, "/api/auth/setup", serde_json::json!({ "username": " Admin ", "password": "motdepasse", "confirm": "motdepasse" }), None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        v["user"],
        serde_json::json!({ "id": 1, "username": "admin", "role": "admin" })
    );
    let admin = session_of(&h);
    let (s, _, v) = post(&env, "/api/auth/setup", serde_json::json!({ "username": "autre", "password": "motdepasse", "confirm": "motdepasse" }), None).await;
    assert_eq!(
        (s, v["error"].as_str().unwrap()),
        (
            StatusCode::FORBIDDEN,
            "Le compte administrateur existe déjà."
        )
    );

    let (s, _, v) = post(&env, "/api/admin/users", serde_json::json!({ "action": "create", "username": "lea", "password": "motdepasse", "role": "user" }), Some(&admin)).await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["users"].as_array().unwrap().len(), 2);

    let (s, h, v) = post(
        &env,
        "/api/auth/login",
        serde_json::json!({ "username": "LEA", "password": "motdepasse", "next": "/matchs/2" }),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["next"], "/matchs/2");
    let lea = session_of(&h);
    let (s, _, _) = get(&env, "/api/admin/users", Some(&lea)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    for _ in 0..5 {
        let (s, _, _) = post(
            &env,
            "/api/auth/login",
            serde_json::json!({ "username": "lea", "password": "mauvais" }),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }
    let (s, _, v) = post(
        &env,
        "/api/auth/login",
        serde_json::json!({ "username": "lea", "password": "motdepasse" }),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"], "Trop de tentatives. Réessayez dans 60 s.");

    // Réinitialisation par l'administrateur : la session de Léa est révoquée.
    let (s, _, _) = post(
        &env,
        "/api/admin/users",
        serde_json::json!({ "action": "reset-password", "id": 2, "password": "nouveaumdp" }),
        Some(&admin),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = get(&env, "/api/matches", Some(&lea)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, h, _) = post(
        &env,
        "/api/auth/logout",
        serde_json::json!({}),
        Some(&admin),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        h[header::SET_COOKIE],
        "bl_session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax"
    );
    let (s, _, _) = get(&env, "/api/admin/users", Some(&admin)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}
