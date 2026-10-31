//! Routes `GET /api/pages/…` (étape 8a) : accès, 404, cookie « scores
//! masqués », renouvellement de session, et l'état des files médias lu dans
//! les services du processus (exécuteurs simulés). La base
//! est celle de `fixtures/pages.expected.json` (schéma réel, lignes écrites
//! par Node) ; le contenu des pages lui-même est comparé à Node par
//! `pages_node.rs`.

#[path = "helpers/media_kit.rs"]
mod media_kit;

use axum::body::Body;
use axum::http::{header, StatusCode};
use basketland_server::media::commentary::EnqueueOptions;
use basketland_server::state::Media;
use basketland_server::{app, auth, db, proxy, routes_pages, state};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "jeton-interne-pages";

struct Env {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

fn iso(d: chrono::DateTime<Utc>) -> String {
    basketland_server::time::iso_utc(d)
}

/// Base de la fixture des pages, plus des sessions valables maintenant.
fn setup() -> Env {
    static ENV: std::sync::Once = std::sync::Once::new();
    ENV.call_once(|| std::env::set_var("INGEST_TOKEN", TOKEN));
    let fx: Value =
        serde_json::from_str(include_str!("fixtures/pages.expected.json")).expect("fixture");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    let c = Connection::open(&path).unwrap();
    for s in fx["schema"].as_array().unwrap() {
        c.execute_batch(s.as_str().unwrap()).unwrap();
    }
    for s in fx["inserts"].as_array().unwrap() {
        c.execute(s.as_str().unwrap(), []).unwrap();
    }
    let now = Utc::now();
    for (token, user, exp) in [
        ("admin-frais", 1, now + Duration::days(30)),
        ("paul-frais", 2, now + Duration::days(30)),
        ("paul-a-renouveler", 2, now + Duration::days(10)),
    ] {
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, 'x', ?3)",
            rusqlite::params![auth::hash_token(token), user, iso(exp)],
        )
        .unwrap();
    }
    Env { _dir: dir, path }
}

fn router(env: &Env) -> (axum::Router, Media) {
    let db = db::Db::new(env.path.clone());
    let video = basketland_server::video::Video::new();
    let media = media_kit::test_media(&db, &video);
    let r = app(state::AppState::with_media(
        db,
        // Node absent : aucune page n'en dépend.
        proxy::Upstream::new("http://127.0.0.1:9"),
        video,
        media.clone(),
    ));
    (r, media)
}

struct Res {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Value,
}

async fn get(r: &axum::Router, uri: &str, cookie: Option<&str>) -> Res {
    let mut b = axum::http::Request::get(uri);
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    let res = r
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    Res {
        status: parts.status,
        headers: parts.headers,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

const PROTECTED: [&str; 7] = [
    "/api/pages/home",
    "/api/pages/matchs?d=2026-10-28",
    "/api/pages/matchs/401909880",
    "/api/pages/equipes",
    "/api/pages/equipes/LAL",
    "/api/pages/classement",
    "/api/pages/parametres",
];

#[tokio::test]
async fn session_exigee_sauf_pour_les_donnees_de_session() {
    let env = setup();
    let (r, _) = router(&env);
    for p in PROTECTED {
        for c in [None, Some("bl_session=inconnu")] {
            let res = get(&r, p, c).await;
            assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{p} {c:?}");
            assert_eq!(res.body, json!({ "error": "non connecté" }));
            assert_eq!(res.headers[header::CACHE_CONTROL], "no-store");
        }
    }
    let res = get(&r, "/api/pages/session?next=%2Fequipes%2FLAL", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body,
        json!({ "has_users": true, "user": null, "next": "/equipes/LAL" })
    );
    // Ancien appel interne de Node : jamais relayé depuis l'extérieur.
    let res = get(
        &r,
        "/api/internal/page-state",
        Some("bl_session=admin-frais"),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn donnees_de_session_et_premier_demarrage() {
    let env = setup();
    let (r, _) = router(&env);
    let res = get(&r, "/api/pages/session", Some("bl_session=admin-frais")).await;
    assert_eq!(
        res.body,
        json!({ "has_users": true, "user": { "id": 1, "username": "michel", "role": "admin" }, "next": "/" })
    );
    assert!(res.headers.get(header::SET_COOKIE).is_none());
    // Session à renouveler : cookie réémis, comme le middleware sur /login.
    let res = get(
        &r,
        "/api/pages/session",
        Some("bl_session=paul-a-renouveler"),
    )
    .await;
    assert_eq!(res.body["user"]["username"], "paul");
    let set = res.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        set.starts_with("bl_session=paul-a-renouveler; Path=/; Expires="),
        "{set}"
    );
    // Aucun compte : /setup.
    let c = Connection::open(&env.path).unwrap();
    c.execute_batch("DELETE FROM sessions; DELETE FROM users;")
        .unwrap();
    let res = get(
        &r,
        "/api/pages/session?next=/matchs",
        Some("bl_session=admin-frais"),
    )
    .await;
    assert_eq!(
        res.body,
        json!({ "has_users": false, "user": null, "next": "/matchs" })
    );
}

/// Match du panneau d'activité (`matchOf`).
fn activity_match(env: &Env, id: i64) -> Value {
    let c = Connection::open(&env.path).unwrap();
    c.query_row(
        "SELECT away_abbr, home_abbr, away_name, home_name FROM matches WHERE id = ?1",
        [id],
        |r| {
            Ok(json!({
                "id": id,
                "away": r.get::<_, String>(0)?,
                "home": r.get::<_, String>(1)?,
                "awayName": r.get::<_, String>(2)?,
                "homeName": r.get::<_, String>(3)?,
            }))
        },
    )
    .unwrap()
}

#[tokio::test]
async fn etat_des_files_lu_dans_les_services() {
    let env = setup();
    // Un replay avec une piste partielle, mis en traduction (exécuteur simulé).
    let c = Connection::open(&env.path).unwrap();
    let running: i64 = c
        .query_row(
            "SELECT t.match_id FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
              WHERE t.complete = 0 AND t.ok_id = m.video_ok_id AND t.cues > 0
              ORDER BY m.date_utc DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (r, media) = router(&env);
    let cookie = Some("bl_session=paul-frais; bl_spoilers=hide");
    // Rien ne tourne : activité vide, aucun replay « en cours ».
    let res = get(&r, "/api/pages/home", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body["activity"],
        json!({ "tasks": [], "queued": [], "watching": false })
    );
    let m = media.clone();
    let q = tokio::task::spawn_blocking(move || {
        m.commentary.enqueue(
            running,
            EnqueueOptions {
                priority: true,
                force: false,
                explicit: true,
            },
        )
    })
    .await
    .unwrap();
    assert!(q.queued, "{}", q.message);
    for _ in 0..100 {
        if media.commentary.running_match_id() == Some(running) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let res = get(&r, "/api/pages/home", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["spoilers"], "hide");
    let task = json!({
        "kind": "traduction",
        "match": activity_match(&env, running),
        "label": "Démarrage",
        "pct": null,
        "paused": false,
        "watched": false,
    });
    assert_eq!(
        res.body["activity"],
        json!({ "tasks": [task], "queued": [], "watching": false })
    );
    let g = res.body["replays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == running)
        .expect("replay récent");
    assert_eq!(g["vf"]["state"], "running");
    // Paramètres : raison du doublage pour un administrateur seulement.
    let res = get(&r, "/api/pages/parametres", cookie).await;
    assert_eq!(res.body["admin_data"], Value::Null);
    let res = get(&r, "/api/pages/parametres", Some("bl_session=admin-frais")).await;
    assert_eq!(
        res.body["admin_data"]["voice_disabled_reason"],
        "doublage désactivé (DUB_DISABLED=1)"
    );
    for p in [
        "/api/pages/matchs",
        "/api/pages/matchs/401909880",
        "/api/pages/equipes",
        "/api/pages/equipes/POR",
    ] {
        assert_eq!(get(&r, p, cookie).await.status, StatusCode::OK, "{p}");
    }
}

#[tokio::test]
async fn pages_introuvables() {
    let env = setup();
    let (r, _) = router(&env);
    let cookie = Some("bl_session=paul-frais");
    for p in [
        "/api/pages/matchs/abc",
        "/api/pages/matchs/0",
        "/api/pages/matchs/999",
    ] {
        let res = get(&r, p, cookie).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{p}");
        assert_eq!(
            res.body,
            json!({ "error": "match introuvable", "title": "Match introuvable" })
        );
    }
    for p in [
        "/api/pages/equipes/XYZ",
        "/api/pages/equipes/L1",
        "/api/pages/equipes/%C3%9F%C3%9F",
    ] {
        let res = get(&r, p, cookie).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{p}");
        assert_eq!(res.body, json!({ "error": "équipe introuvable" }));
    }
    // Abréviation en minuscules, encodée : la page de l'équipe.
    let res = get(&r, "/api/pages/equipes/l%61l", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["title"], "Los Angeles Lakers");
}

#[tokio::test]
async fn classement_cache_puis_espn_puis_cache_perime() {
    let env = setup();
    let shared = db::Db::new(env.path.clone());
    let c = Connection::open(&env.path).unwrap();
    let cached: String = c
        .query_row(
            "SELECT value FROM kv_cache WHERE key = 'standings:nba'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let cached: Value = serde_json::from_str(&cached).unwrap();
    let now = Utc::now();
    let touch = |at: chrono::DateTime<Utc>| {
        c.execute(
            "UPDATE kv_cache SET updated_at = ?1 WHERE key = 'standings:nba'",
            [iso(at)],
        )
        .unwrap();
    };
    let fresh = json!([{ "conference": "Conférence Est", "rows": [] }]);
    // Cache frais : ESPN pas appelé.
    touch(now - Duration::minutes(29));
    let v = routes_pages::load_standings(&shared, now, || async { panic!("ESPN appelé") }).await;
    assert_eq!(v.unwrap(), cached);
    // Cache périmé, ESPN répond : nouvelle valeur, mise en cache.
    touch(now - Duration::minutes(31));
    let f2 = fresh.clone();
    let v = routes_pages::load_standings(&shared, now, || async move { Ok(f2) }).await;
    assert_eq!(v.unwrap(), fresh);
    let v = routes_pages::load_standings(&shared, now, || async { panic!("ESPN appelé") }).await;
    assert_eq!(v.unwrap(), fresh);
    // Cache périmé, ESPN injoignable : cache périmé ; plus de cache : [].
    let later = now + Duration::hours(1);
    let offline = || async { Err::<Value, String>("hors ligne".into()) };
    let v = routes_pages::load_standings(&shared, later, offline).await;
    assert_eq!(v.unwrap(), fresh);
    c.execute("DELETE FROM kv_cache", []).unwrap();
    let v = routes_pages::load_standings(&shared, later, offline).await;
    assert_eq!(v.unwrap(), json!([]));
    // Route : cache frais servi.
    c.execute(
        "INSERT INTO kv_cache (key, value, updated_at) VALUES ('standings:nba', ?1, ?2)",
        [cached.to_string(), iso(Utc::now())],
    )
    .unwrap();
    let (r, _) = router(&env);
    let res = get(&r, "/api/pages/classement", Some("bl_session=paul-frais")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "conferences": cached }));
}
