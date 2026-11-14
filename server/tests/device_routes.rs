//! Connexion d'une TV par code, de bout en bout, sur une vraie base SQLite temporaire.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use basketland_server::{app, db, device_auth, proxy, state};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

struct Env {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

fn setup() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    basketland_server::schema::ensure_schema(&path).unwrap();
    Env { _dir: dir, path }
}

async fn call(
    env: &Env,
    method: &str,
    uri: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    ip: &str,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "nas:3012")
        .header(header::ORIGIN, "http://nas:3012")
        .header("x-forwarded-for", ip);
    if body.is_some() {
        b = b.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, format!("bl_session={c}"));
    }
    let router = app(state::AppState::new(
        db::Db::new(env.path.clone()),
        proxy::Upstream::new("http://127.0.0.1:9"),
        basketland_server::video::Video::new(),
    ));
    let req = b
        .body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
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
async fn tv_connectee_par_code_puis_revoquee() {
    device_auth::reset();
    let env = setup();
    let (s, h, _) = call(
        &env,
        "POST",
        "/api/auth/setup",
        Some(json!({ "username": "michael", "password": "motdepasse", "confirm": "motdepasse" })),
        None,
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let phone = session_of(&h);

    // La TV, sans session, demande un code.
    let (s, _, v) = call(
        &env,
        "POST",
        "/api/auth/device/start",
        Some(json!({ "name": "Fire TV Cube" })),
        None,
        "2.2.2.2",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let device = v["device_code"].as_str().unwrap().to_string();
    let code = v["user_code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 9);
    assert_eq!(v["interval"], 3);

    let (_, _, v) = call(
        &env,
        "POST",
        "/api/auth/device/poll",
        Some(json!({ "device_code": device })),
        None,
        "2.2.2.2",
    )
    .await;
    assert_eq!(v["status"], "pending");

    // Valider exige une session.
    let (s, _, _) = call(
        &env,
        "POST",
        "/api/auth/device/approve",
        Some(json!({ "code": code })),
        None,
        "3.3.3.3",
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, _, v) = call(
        &env,
        "POST",
        "/api/auth/device/check",
        Some(json!({ "code": code.to_lowercase() })),
        Some(&phone),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        (v["name"].as_str(), v["ip"].as_str()),
        (Some("Fire TV Cube"), Some("2.2.2.2"))
    );
    let (s, _, _) = call(
        &env,
        "POST",
        "/api/auth/device/approve",
        Some(json!({ "code": code })),
        Some(&phone),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // La TV reçoit sa session, une seule fois.
    let (s, h, v) = call(
        &env,
        "POST",
        "/api/auth/device/poll",
        Some(json!({ "device_code": device })),
        None,
        "2.2.2.2",
    )
    .await;
    assert_eq!(
        (s, v["status"].as_str()),
        (StatusCode::OK, Some("approved"))
    );
    assert_eq!(v["user"]["username"], "michael");
    let tv = session_of(&h);
    let (_, _, v) = call(
        &env,
        "POST",
        "/api/auth/device/poll",
        Some(json!({ "device_code": device })),
        None,
        "2.2.2.2",
    )
    .await;
    assert_eq!(v["status"], "expired");
    let (s, _, _) = call(&env, "GET", "/api/matches", None, Some(&tv), "2.2.2.2").await;
    assert_eq!(s, StatusCode::OK);

    // « Mes appareils » : la TV apparaît avec son nom ; on la révoque depuis le téléphone.
    let (s, _, v) = call(
        &env,
        "GET",
        "/api/account/sessions",
        None,
        Some(&phone),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let list = v["sessions"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let tv_row = list.iter().find(|x| x["label"] == "Fire TV Cube").unwrap();
    assert_eq!(tv_row["current"], false);
    let id = tv_row["id"].as_str().unwrap().to_string();
    assert!(list
        .iter()
        .any(|x| x["current"] == true && x["label"].is_null()));

    let (s, _, _) = call(
        &env,
        "POST",
        "/api/account/sessions",
        Some(json!({ "action": "revoke", "id": id })),
        Some(&phone),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(&env, "GET", "/api/matches", None, Some(&tv), "2.2.2.2").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = call(
        &env,
        "POST",
        "/api/account/sessions",
        Some(json!({ "action": "revoke", "id": id })),
        Some(&phone),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn origine_etrangere_refusee() {
    let env = setup();
    let req = Request::post("/api/auth/device/start")
        .header(header::HOST, "nas:3012")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let router = app(state::AppState::new(
        db::Db::new(env.path.clone()),
        proxy::Upstream::new("http://127.0.0.1:9"),
        basketland_server::video::Video::new(),
    ));
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}
