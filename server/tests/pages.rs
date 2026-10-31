//! Routes `GET /api/pages/…` (étape 8a) : accès, 404, cookie « scores
//! masqués », renouvellement de session, et l'état des files lu chez Node par
//! `POST /api/internal/page-state` (jeton d'ingestion), face à une fausse
//! application Node. La base est celle de `fixtures/pages.expected.json`
//! (schéma réel, lignes écrites par Node) ; le contenu des pages lui-même est
//! comparé à Node par `pages_node.rs`.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use basketland_server::{app, auth, db, proxy, routes_pages, state};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
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

/// Fausse application Node : enregistre les appels internes, rend `reply`.
struct FakeNode {
    calls: Mutex<Vec<(String, Option<String>, Value)>>,
    reply: Value,
}

async fn node_handler(State(n): State<Arc<FakeNode>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let auth = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let b = req.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&b).unwrap_or(Value::Null);
    n.calls.lock().unwrap().push((path.clone(), auth, body));
    if path != routes_pages::NODE_PAGE_STATE_PATH {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(n.reply.to_string()))
        .unwrap()
}

async fn fake_node(reply: Value) -> (Arc<FakeNode>, String) {
    let n = Arc::new(FakeNode {
        calls: Mutex::new(Vec::new()),
        reply,
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let r = axum::Router::new()
        .fallback(node_handler)
        .with_state(n.clone());
    tokio::spawn(async move { axum::serve(l, r).await.unwrap() });
    (n, format!("http://{addr}"))
}

fn router(env: &Env, node_url: &str) -> axum::Router {
    app(state::AppState::new(
        db::Db::new(env.path.clone()),
        proxy::Upstream::new(node_url),
        basketland_server::video::Video::new(),
    ))
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

fn state_reply(running: Option<i64>) -> Value {
    json!({
        "running_match_id": running,
        "activity": { "tasks": [], "queued": [], "watching": true },
        "commentary_disabled_reason": null,
        "dub_disabled_reason": "moteur de voix indisponible : test",
    })
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
    let (node, url) = fake_node(state_reply(None)).await;
    let r = router(&env, &url);
    for p in PROTECTED {
        for c in [None, Some("bl_session=inconnu")] {
            let res = get(&r, p, c).await;
            assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{p} {c:?}");
            assert_eq!(res.body, json!({ "error": "non connecté" }));
            assert_eq!(res.headers[header::CACHE_CONTROL], "no-store");
        }
    }
    assert!(
        node.calls.lock().unwrap().is_empty(),
        "Node jamais appelé sans session"
    );
    let res = get(&r, "/api/pages/session?next=%2Fequipes%2FLAL", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body,
        json!({ "has_users": true, "user": null, "next": "/equipes/LAL" })
    );
    // Appel interne de Node : jamais relayé depuis l'extérieur.
    let res = get(
        &r,
        "/api/internal/page-state",
        Some("bl_session=admin-frais"),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert!(node.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn donnees_de_session_et_premier_demarrage() {
    let env = setup();
    let r = router(&env, "http://127.0.0.1:9");
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

#[tokio::test]
async fn etat_des_files_lu_chez_node() {
    let env = setup();
    // Un replay avec une piste partielle : en cours de traduction selon Node.
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
    let (node, url) = fake_node(state_reply(Some(running))).await;
    let r = router(&env, &url);
    let cookie = Some("bl_session=paul-frais; bl_spoilers=hide");
    let res = get(&r, "/api/pages/home", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["spoilers"], "hide");
    assert_eq!(
        res.body["activity"],
        json!({ "tasks": [], "queued": [], "watching": true })
    );
    let g = res.body["replays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == running)
        .expect("replay récent");
    assert_eq!(g["vf"]["state"], "running");
    {
        let calls = node.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "/api/internal/page-state");
        let bearer = format!("Bearer {TOKEN}");
        assert_eq!(calls[0].1.as_deref(), Some(bearer.as_str()));
        assert_eq!(calls[0].2, json!({ "dub": false }));
    }
    // Fiche : `toDto` seul, Node pas appelé.
    let res = get(&r, "/api/pages/matchs/401909880", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["is_admin"], false);
    assert_eq!(node.calls.lock().unwrap().len(), 1);
    // Paramètres : raison du doublage demandée pour un administrateur seulement.
    let res = get(&r, "/api/pages/parametres", cookie).await;
    assert_eq!(res.body["admin_data"], Value::Null);
    assert_eq!(node.calls.lock().unwrap().len(), 1);
    let res = get(&r, "/api/pages/parametres", Some("bl_session=admin-frais")).await;
    assert_eq!(
        res.body["admin_data"]["voice_disabled_reason"],
        "moteur de voix indisponible : test"
    );
    assert_eq!(node.calls.lock().unwrap()[1].2, json!({ "dub": true }));
    for p in [
        "/api/pages/matchs",
        "/api/pages/equipes",
        "/api/pages/equipes/POR",
    ] {
        assert_eq!(get(&r, p, cookie).await.status, StatusCode::OK, "{p}");
    }
    assert_eq!(node.calls.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn node_injoignable() {
    let env = setup();
    let r = router(&env, "http://127.0.0.1:9");
    let cookie = Some("bl_session=admin-frais");
    for p in [
        "/api/pages/home",
        "/api/pages/matchs",
        "/api/pages/equipes",
        "/api/pages/equipes/LAL",
        "/api/pages/parametres",
    ] {
        let res = get(&r, p, cookie).await;
        assert_eq!(res.status, StatusCode::BAD_GATEWAY, "{p}");
        assert_eq!(
            res.body,
            json!({ "error": "application Node injoignable (démarrage en cours ?)" })
        );
    }
    // Sans état de Node : servies quand même.
    let res = get(&r, "/api/pages/matchs/401909880", cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = get(&r, "/api/pages/parametres", Some("bl_session=paul-frais")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["user"]["username"], "paul");
}

#[tokio::test]
async fn pages_introuvables() {
    let env = setup();
    let (_node, url) = fake_node(state_reply(None)).await;
    let r = router(&env, &url);
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
    let r = router(&env, "http://127.0.0.1:9");
    let res = get(&r, "/api/pages/classement", Some("bl_session=paul-frais")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "conferences": cached }));
}
