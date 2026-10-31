//! Interface statique servie par Rust (étape 8b) : règles d'accès de l'ancien
//! middleware (redirections, 401 des API, renouvellement du cookie),
//! résolution des fichiers de l'export Next, méthodes non servies, et
//! `POST /api/diag/stall`.

#[path = "helpers/media_kit.rs"]
mod media_kit;

use axum::body::Body;
use axum::http::{header, StatusCode};
use basketland_server::state::AppState;
use basketland_server::{app, auth, db, proxy, schema};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use tower::ServiceExt;

struct T {
    _dir: tempfile::TempDir,
    db_path: std::path::PathBuf,
    r: axum::Router,
}

fn setup(with_users: bool) -> T {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("data").join("basketland.db");
    schema::ensure_schema(&db_path).unwrap();
    let c = Connection::open(&db_path).unwrap();
    if with_users {
        c.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'michel', 'x', 'admin', 'x')",
            [],
        )
        .unwrap();
        let now = Utc::now();
        for (token, exp) in [
            ("frais", now + Duration::days(30)),
            ("a-renouveler", now + Duration::days(10)),
        ] {
            c.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, 1, 'x', ?2)",
                rusqlite::params![auth::hash_token(token), basketland_server::time::iso_utc(exp)],
            )
            .unwrap();
        }
    }
    let out = dir.path().join("out");
    for f in [
        "index.html",
        "login.html",
        "setup.html",
        "matchs.html",
        "matchs.txt",
        "matchs/_.html",
        "matchs/_.txt",
        "404.html",
        "_next/static/chunks/app.js",
        "favicon.ico",
    ] {
        let p = out.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("<{f}>")).unwrap();
    }
    let dbh = db::Db::new(db_path.clone());
    let video = basketland_server::video::Video::new();
    let media = media_kit::test_media(&dbh, &video);
    let mut st = AppState::with_media(
        dbh,
        proxy::Upstream::new("http://127.0.0.1:9"),
        video,
        media,
    );
    st.static_dir = Some(out);
    T {
        _dir: dir,
        db_path,
        r: app(st),
    }
}

struct Res {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: String,
}

async fn send(
    t: &T,
    method: &str,
    uri: &str,
    session: Option<&str>,
    body: &str,
    h: &[(&str, &str)],
) -> Res {
    let mut b = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "nas.local:3012");
    if let Some(s) = session {
        b = b.header(header::COOKIE, format!("bl_session={s}"));
    }
    for (k, v) in h {
        b = b.header(*k, *v);
    }
    let res =
        t.r.clone()
            .oneshot(b.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
    let (parts, body) = res.into_parts();
    Res {
        status: parts.status,
        headers: parts.headers,
        body: String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).into_owned(),
    }
}

async fn get(t: &T, uri: &str, session: Option<&str>) -> Res {
    send(t, "GET", uri, session, "", &[]).await
}

fn location(r: &Res) -> &str {
    r.headers[header::LOCATION].to_str().unwrap()
}

#[tokio::test]
async fn pages_protegees_et_redirections() {
    let t = setup(true);
    for (uri, want) in [
        ("/", "/login"),
        (
            "/matchs/401909880?x=2&_rsc=abc",
            "/login?next=%2Fmatchs%2F401909880%3Fx%3D2",
        ),
        ("/parametres", "/login?next=%2Fparametres"),
        ("/setup", "/login"),
    ] {
        let r = get(&t, uri, None).await;
        assert_eq!(r.status, StatusCode::TEMPORARY_REDIRECT, "{uri}");
        assert_eq!(location(&r), want, "{uri}");
    }
    // Session inconnue : comme sans session.
    assert_eq!(
        get(&t, "/matchs", Some("inconnu")).await.status,
        StatusCode::TEMPORARY_REDIRECT
    );
    // Publics : connexion, ressources de build, icônes.
    for (uri, body, ct) in [
        ("/login", "<login.html>", "text/html; charset=utf-8"),
        (
            "/_next/static/chunks/app.js",
            "<_next/static/chunks/app.js>",
            "application/javascript; charset=utf-8",
        ),
        ("/favicon.ico", "<favicon.ico>", "image/x-icon"),
    ] {
        let r = get(&t, uri, None).await;
        assert_eq!((r.status, r.body.as_str()), (StatusCode::OK, body), "{uri}");
        assert_eq!(r.headers[header::CONTENT_TYPE], ct, "{uri}");
    }
    assert_eq!(
        get(&t, "/_next/static/chunks/app.js", None).await.headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    // Connecté : pages servies, routes dynamiques par leur page `_`.
    for (uri, body) in [
        ("/", "<index.html>"),
        ("/matchs", "<matchs.html>"),
        ("/matchs.txt?_rsc=1", "<matchs.txt>"),
        ("/matchs/401909880", "<matchs/_.html>"),
        ("/matchs/401909880.txt?_rsc=1", "<matchs/_.txt>"),
    ] {
        let r = get(&t, uri, Some("frais")).await;
        assert_eq!((r.status, r.body.as_str()), (StatusCode::OK, body), "{uri}");
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store", "{uri}");
        assert!(r.headers.get(header::SET_COOKIE).is_none());
    }
    // Déjà connecté : /login → destination, /setup → accueil.
    let r = get(&t, "/login?next=%2Fmatchs", Some("frais")).await;
    assert_eq!(location(&r), "/matchs");
    assert_eq!(location(&get(&t, "/setup", Some("frais")).await), "/");
    // Introuvable : page 404 de l'export.
    let r = get(&t, "/equipes/LAL", Some("frais")).await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (StatusCode::NOT_FOUND, "<404.html>")
    );
    // HEAD : en-têtes sans corps.
    let r = send(&t, "HEAD", "/matchs", Some("frais"), "", &[]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers[header::CONTENT_LENGTH], "13");
    assert!(r.body.is_empty());
    // Renouvellement glissant du cookie, comme le middleware.
    let r = get(&t, "/matchs", Some("a-renouveler")).await;
    assert_eq!(r.status, StatusCode::OK);
    let set = r.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        set.starts_with("bl_session=a-renouveler; Path=/; Expires="),
        "{set}"
    );
    let exp: String = Connection::open(&t.db_path)
        .unwrap()
        .query_row(
            "SELECT expires_at FROM sessions WHERE token_hash = ?1",
            [auth::hash_token("a-renouveler")],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        basketland_server::time::parse_instant(&exp).unwrap() > Utc::now() + Duration::days(29)
    );
}

#[tokio::test]
async fn api_et_methodes() {
    let t = setup(true);
    // API inconnue : 401 sans session, 404 avec.
    let r = get(&t, "/api/inconnue", None).await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (StatusCode::UNAUTHORIZED, r#"{"error":"non connecté"}"#)
    );
    let r = get(&t, "/api/inconnue", Some("frais")).await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (StatusCode::NOT_FOUND, r#"{"error":"introuvable"}"#)
    );
    // Anciens chemins internes de Node : toujours 404.
    assert_eq!(
        send(
            &t,
            "POST",
            "/api/internal/replays",
            Some("frais"),
            "{}",
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    // Méthode non servie par une route portée ou une page : 405 (plus de Node).
    assert_eq!(
        send(
            &t,
            "PUT",
            "/api/matches/1/subtitles",
            Some("frais"),
            "",
            &[]
        )
        .await
        .status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        send(&t, "POST", "/matchs", Some("frais"), "", &[])
            .await
            .status,
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[tokio::test]
async fn premier_demarrage() {
    let t = setup(false);
    for uri in ["/", "/matchs", "/login"] {
        let r = get(&t, uri, None).await;
        assert_eq!(location(&r), "/setup", "{uri}");
    }
    let r = get(&t, "/setup", None).await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (StatusCode::OK, "<setup.html>")
    );
}

#[tokio::test]
async fn signalement_des_gels_de_lecture() {
    let t = setup(true);
    let origin = [
        ("origin", "http://nas.local:3012"),
        ("content-type", "text/plain"),
    ];
    let s = |r: Res| r.status;
    assert_eq!(
        s(send(&t, "POST", "/api/diag/stall", None, r#"{"ms":1}"#, &origin).await),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        s(send(
            &t,
            "POST",
            "/api/diag/stall",
            Some("frais"),
            r#"{"ms":3200,"t":754}"#,
            &origin
        )
        .await),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        s(send(
            &t,
            "POST",
            "/api/diag/stall",
            Some("frais"),
            r#"{"ms":1}"#,
            &[("origin", "https://evil.example")]
        )
        .await),
        StatusCode::FORBIDDEN
    );
    for body in ["pas du json", r#"{"t":3}"#, r#"{"ms":"3"}"#] {
        assert_eq!(
            s(send(&t, "POST", "/api/diag/stall", Some("frais"), body, &origin).await),
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    let big = format!(r#"{{"ms":1,"x":"{}"}}"#, "a".repeat(2000));
    assert_eq!(
        s(send(&t, "POST", "/api/diag/stall", Some("frais"), &big, &origin).await),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
