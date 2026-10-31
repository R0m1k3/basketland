//! Routes des files médias (étape 6b) : sous-titres, export WebVTT,
//! traduction, signe de vie, doublage, tronçons doublés, activité, et les
//! mises en file de fond (`scheduler`). Files réelles, exécuteurs simulés
//! (un travail lancé reste « en cours ») ; base de `fixtures/pages.expected.json`
//! plus des sous-titres et un doublage écrits ici. Les réponses ont aussi été
//! comparées en direct à celles de Node (voir `docs/migration-rust.md`).

#[path = "helpers/media_kit.rs"]
mod media_kit;

use axum::body::Body;
use axum::http::{header, StatusCode};
use basketland_server::routes_media::{byte_range, to_web_vtt, vtt_timestamp, VttCue};
use basketland_server::state::{AppState, Media};
use basketland_server::{app, auth, db, proxy, scheduler, settings};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Un seul jeu de variables (`DATA_DIR`) par processus : tests en série.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct T {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    data: std::path::PathBuf,
    r: axum::Router,
    media: Media,
    /// Replay récent avec une piste complète (sous-titres et doublage écrits ici).
    full: i64,
    /// Replay récent avec une piste partielle.
    partial: i64,
}

fn setup() -> T {
    let fx: Value =
        serde_json::from_str(include_str!("fixtures/pages.expected.json")).expect("fixture");
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    std::env::set_var("DATA_DIR", &data);
    let path = data.join("basketland.db");
    let c = Connection::open(&path).unwrap();
    for s in fx["schema"].as_array().unwrap() {
        c.execute_batch(s.as_str().unwrap()).unwrap();
    }
    for s in fx["inserts"].as_array().unwrap() {
        c.execute(s.as_str().unwrap(), []).unwrap();
    }
    let exp = basketland_server::time::iso_utc(Utc::now() + Duration::days(30));
    for (token, user) in [("admin", 1), ("paul", 2)] {
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, 'x', ?3)",
            rusqlite::params![auth::hash_token(token), user, exp],
        )
        .unwrap();
    }
    let pick = |complete: i64| -> i64 {
        c.query_row(
            "SELECT t.match_id FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
              WHERE t.ok_id = m.video_ok_id AND t.cues > 0 AND m.video_available = 1 AND t.complete = ?1
              ORDER BY m.date_utc DESC LIMIT 1",
            [complete],
            |r| r.get(0),
        )
        .unwrap()
    };
    let (full, partial) = (pick(1), pick(0));
    c.execute("DELETE FROM commentary_cues WHERE match_id = ?1", [full])
        .unwrap();
    for (seq, start, end, fr, untranslated, emphasis) in [
        (1, 12.5, 14.0, "Et il marque !", 0, 2),
        (2, 3.25, 6.5, "Tir & panier <b>gras</b> --> flèche", 0, 0),
        (3, 20.0, 21.0, "line still in English", 1, 0),
        (
            4,
            3.25,
            3.3,
            "Une phrase un peu plus longue que d'habitude, coupée sur deux lignes à l'export",
            0,
            1,
        ),
    ] {
        c.execute(
            "INSERT INTO commentary_cues VALUES (?1, ?2, ?3, ?4, 'en', ?5, ?6, ?7)",
            rusqlite::params![full, seq, start, end, fr, untranslated, emphasis],
        )
        .unwrap();
    }
    // Doublage : trois tronçons, fichiers dans DATA_DIR/dub/<id>/.
    let ok: String = c
        .query_row(
            "SELECT video_ok_id FROM matches WHERE id = ?1",
            [full],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "INSERT INTO dub_tracks VALUES (?1, ?2, 'cle', '[\"A\"]', '{}', 0, '2026-10-30T10:00:00.000Z')",
        rusqlite::params![full, ok],
    )
    .unwrap();
    let dub_dir = data.join("dub").join(full.to_string());
    std::fs::create_dir_all(&dub_dir).unwrap();
    std::fs::write(
        dub_dir.join("c000.m4a"),
        (0..=255u8).cycle().take(1000).collect::<Vec<_>>(),
    )
    .unwrap();
    c.execute(
        "INSERT INTO dub_chunks VALUES (?1, 0, 0, 120, '/ailleurs/c000.m4a', '[[1,2]]', 'sig', '2026-10-30T10:00:00.000Z')",
        [full],
    )
    .unwrap();
    // Tronçon en base sans fichier.
    c.execute(
        "INSERT INTO dub_chunks VALUES (?1, 1, 120, 240, 'c001.m4a', '[]', 'sig', '2026-10-30T10:01:00.000Z')",
        [full],
    )
    .unwrap();
    drop(c);
    let dbh = db::Db::new(path.clone());
    let video = basketland_server::video::Video::new();
    let media = media_kit::test_media(&dbh, &video);
    let r = app(AppState::with_media(
        dbh,
        proxy::Upstream::new("http://127.0.0.1:9"),
        video,
        media.clone(),
    ));
    T {
        _dir: dir,
        path,
        data,
        r,
        media,
        full,
        partial,
    }
}

struct Res {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    bytes: Vec<u8>,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }
}

async fn send(
    t: &T,
    method: &str,
    uri: &str,
    user: Option<&str>,
    h: &[(&str, &str)],
    body: &str,
) -> Res {
    let mut b = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "nas.local:3012");
    if let Some(u) = user {
        b = b.header(header::COOKIE, format!("bl_session={u}"));
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
        bytes: body.collect().await.unwrap().to_bytes().to_vec(),
    }
}

const JSON_WRITE: [(&str, &str); 2] = [
    ("content-type", "application/json"),
    ("origin", "http://nas.local:3012"),
];

async fn post(t: &T, uri: &str, user: &str, body: &str) -> Res {
    send(t, "POST", uri, Some(user), &JSON_WRITE, body).await
}

async fn get(t: &T, uri: &str, user: &str) -> Res {
    send(t, "GET", uri, Some(user), &[], "").await
}

fn set_auto_translate(t: &T, on: bool) {
    let c = Connection::open(&t.path).unwrap();
    settings::setting_set(&c, "auto_translate", Some(if on { "1" } else { "0" })).unwrap();
}

async fn wait_running(media: &Media, id: i64) {
    for _ in 0..200 {
        if media.commentary.running_match_id() == Some(id) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("traduction de {id} jamais démarrée");
}

// ---------------------------------------------------------------- fonctions pures

#[test]
fn horodatage_et_export_webvtt_comme_node() {
    assert_eq!(vtt_timestamp(0.0), "00:00:00.000");
    assert_eq!(vtt_timestamp(-4.0), "00:00:00.000");
    assert_eq!(vtt_timestamp(3725.0005), "01:02:05.001");
    assert_eq!(vtt_timestamp(1.2345), "00:00:01.235");
    let cue = |seq, video_ts, end_ts: Option<f64>, text: &str, speaker: &str| VttCue {
        seq,
        video_ts,
        end_ts,
        text_fr: text.into(),
        speaker: speaker.into(),
    };
    let out = to_web_vtt(
        &[
            cue(2, 5.0, None, "b > a", ""),
            cue(1, 5.0, Some(5.1), "x & y", "Jo<"),
            cue(3, 1.0, Some(2.0), "a --> b", ""),
        ],
        "T --> U",
    );
    assert_eq!(
        out,
        // `>` échappé avant `-->` (comme Node) : la flèche du texte reste `--&gt;`.
        "WEBVTT\nNOTE T → U\n\n1\n00:00:01.000 --> 00:00:02.000\na --&gt; b\n\n2\n00:00:05.000 --> 00:00:05.500\n<v Jo&lt;>x &amp; y\n\n3\n00:00:05.000 --> 00:00:08.000\nb &gt; a\n"
    );
    assert_eq!(to_web_vtt(&[], ""), "WEBVTT\n");
}

#[test]
fn plages_range_comme_node() {
    let size = 1000;
    for (r, want) in [
        ("bytes=0-99", Some((0, 99))),
        ("bytes=100-", Some((100, 999))),
        ("bytes=-50", Some((950, 999))),
        ("bytes=-5000", Some((0, 999))),
        ("bytes=990-5000", Some((990, 999))),
        (" bytes=1-2 ", Some((1, 2))),
        ("bytes=0-0", Some((0, 0))),
        ("bytes=-0", None),
        ("bytes=1000-", None),
        ("bytes=10-5", None),
        ("bytes=-", None),
        ("octets=0-1", None),
        ("bytes=0-1,4-5", None),
    ] {
        assert_eq!(byte_range(r, size), want, "{r}");
    }
}

// ---------------------------------------------------------------- routes

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_exigee_partout() {
    let _g = LOCK.lock().await;
    let t = setup();
    let id = t.full;
    for (m, p) in [
        ("GET", format!("/api/matches/{id}/subtitles")),
        ("GET", format!("/api/matches/{id}/subtitles.vtt")),
        ("GET", format!("/api/matches/{id}/commentary")),
        ("POST", format!("/api/matches/{id}/commentary")),
        ("POST", format!("/api/matches/{id}/watching")),
        ("GET", format!("/api/matches/{id}/dub")),
        ("POST", format!("/api/matches/{id}/dub")),
        ("GET", format!("/api/matches/{id}/dub/0")),
        ("GET", format!("/api/matches/{id}/sync")),
        ("POST", format!("/api/matches/{id}/sync")),
        ("GET", "/api/activity".to_string()),
    ] {
        for user in [None, Some("inconnu")] {
            let res = send(&t, m, &p, user, &JSON_WRITE, "{}").await;
            assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{m} {p}");
            assert_eq!(res.json(), json!({ "error": "non connecté" }));
        }
    }
    // Rien n'a bougé dans les files ni chez les spectateurs.
    assert!(t.media.commentary.activity().queued.is_empty());
    assert!(!t.media.commentary.viewer_active(id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sous_titres_publies_et_signe_de_vie() {
    let _g = LOCK.lock().await;
    let t = setup();
    let id = t.full;
    let res = get(&t, &format!("/api/matches/{id}/subtitles"), "paul").await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.headers[header::CACHE_CONTROL], "no-store");
    let v = res.json();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["match_id", "count", "subtitles", "commentary"]);
    assert_eq!(v["count"], 3, "la ligne restée en anglais n'est pas servie");
    // Triés par position dans la vidéo.
    let seqs: Vec<i64> = v["subtitles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, [2, 4, 1]);
    assert_eq!(
        v["subtitles"][2],
        json!({ "seq": 1, "video_ts": 12.5, "end_ts": 14, "text": "Et il marque !", "speaker": "", "kind": "voice", "emphasis": 2 })
    );
    assert!(v["subtitles"][0].get("emphasis").is_none());
    assert_eq!(v["subtitles"][1]["emphasis"], 1);
    assert_eq!(v["commentary"]["status"], "ready");
    // Sans `t` : `Number(null)` vaut 0, le spectateur est à 0 s.
    assert!(t.media.commentary.viewer_active(id));
    assert_eq!(t.media.commentary.viewer_position(id), Some(0.0));
    get(&t, &format!("/api/matches/{id}/subtitles?t=42.5"), "paul").await;
    assert_eq!(t.media.commentary.viewer_position(id), Some(42.5));
    // Position illisible : dernière position connue gardée.
    get(&t, &format!("/api/matches/{id}/subtitles?t=abc"), "paul").await;
    assert_eq!(t.media.commentary.viewer_position(id), Some(42.5));
    // Erreurs.
    for (p, s, e) in [
        ("/api/matches/abc/subtitles", 400, "id invalide"),
        ("/api/matches/0/subtitles", 400, "id invalide"),
        ("/api/matches/999/subtitles", 404, "match introuvable"),
        ("/api/matches/999/subtitles.vtt", 404, "match introuvable"),
        ("/api/matches/999/commentary", 404, "match introuvable"),
    ] {
        let res = get(&t, p, "paul").await;
        assert_eq!(
            (res.status.as_u16(), res.json()),
            (s, json!({ "error": e })),
            "{p}"
        );
    }
    // Signe de vie du lecteur.
    let w = format!("/api/matches/{}/watching", t.partial);
    let res = post(&t, &w, "paul", r#"{"t":300}"#).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert!(res.bytes.is_empty());
    assert_eq!(t.media.commentary.viewer_position(t.partial), Some(300.0));
    for body in ["", "x", r#"{"t":"9"}"#, "null"] {
        assert_eq!(
            post(&t, &w, "paul", body).await.status,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(t.media.commentary.viewer_position(t.partial), Some(300.0));
    let res = send(
        &t,
        "POST",
        &w,
        Some("paul"),
        &[("origin", "http://evil.example")],
        "{}",
    )
    .await;
    assert_eq!(
        (res.status, res.json()),
        (
            StatusCode::FORBIDDEN,
            json!({ "error": "origine non autorisée" })
        )
    );
    // Activité : quelqu'un regarde.
    let res = get(&t, "/api/activity", "paul").await;
    assert_eq!(
        res.json(),
        json!({ "tasks": [], "queued": [], "watching": true })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_webvtt() {
    let _g = LOCK.lock().await;
    let t = setup();
    let res = get(
        &t,
        &format!("/api/matches/{}/subtitles.vtt", t.full),
        "paul",
    )
    .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.headers[header::CONTENT_TYPE], "text/vtt; charset=utf-8");
    assert_eq!(
        res.headers[header::CONTENT_DISPOSITION],
        format!("inline; filename=\"basketland-{}-fr.vtt\"", t.full).as_str()
    );
    assert_eq!(res.headers[header::CACHE_CONTROL], "no-store");
    let body = String::from_utf8(res.bytes).unwrap();
    let c = Connection::open(&t.path).unwrap();
    let (away, home): (String, String) = c
        .query_row(
            "SELECT away_name, home_name FROM matches WHERE id = ?1",
            [t.full],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        body,
        format!(
            "WEBVTT\nNOTE BasketLand VF — {away} @ {home}\n\n\
             1\n00:00:03.250 --> 00:00:06.500\nTir &amp; panier &lt;b&gt;gras&lt;/b&gt; --&gt; flèche\n\n\
             2\n00:00:03.250 --> 00:00:03.750\nUne phrase un peu plus longue que d'habitude,\ncoupée sur deux lignes à l'export\n\n\
             3\n00:00:12.500 --> 00:00:14.000\nEt il marque !\n"
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lancement_de_la_traduction() {
    let _g = LOCK.lock().await;
    let t = setup();
    let p = format!("/api/matches/{}/commentary", t.partial);
    // Garde-fous.
    for (h, body, s, e) in [
        (
            vec![
                ("content-type", "application/json"),
                ("origin", "http://evil.example"),
            ],
            r#"{"action":"start"}"#,
            403,
            "origine non autorisée pour cette écriture",
        ),
        (
            vec![
                ("content-type", "text/plain"),
                ("origin", "http://nas.local:3012"),
            ],
            r#"{"action":"start"}"#,
            415,
            "Content-Type application/json requis",
        ),
        (JSON_WRITE.to_vec(), "pas du json", 400, "JSON invalide"),
        (
            JSON_WRITE.to_vec(),
            "null",
            400,
            "action invalide (attendu : 'start' ou 'retry')",
        ),
        (
            JSON_WRITE.to_vec(),
            r#"{"action":"stop"}"#,
            400,
            "action invalide (attendu : 'start' ou 'retry')",
        ),
    ] {
        let res = send(&t, "POST", &p, Some("paul"), &h, body).await;
        assert_eq!(
            (res.status.as_u16(), res.json()),
            (s, json!({ "error": e })),
            "{body}"
        );
    }
    let res = post(&t, &p, "paul", r#"{"action":"retry"}"#).await;
    assert_eq!(
        (res.status, res.json()),
        (
            StatusCode::FORBIDDEN,
            json!({ "error": "réservé aux administrateurs" })
        )
    );
    // Traduction automatique désactivée : rien en file, la fiche montre le bouton.
    set_auto_translate(&t, false);
    let res = post(&t, &p, "paul", r#"{"action":"start"}"#).await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    assert_eq!(v["autoTranslate"], false);
    assert_eq!(
        v["message"],
        "Traduction automatique désactivée : lancez-la avec « Sous-titrer ce match »."
    );
    assert!(t.media.commentary.activity().running.is_none());
    // Activée : lancée à l'ouverture (202).
    set_auto_translate(&t, true);
    let res = post(&t, &p, "paul", r#"{"action":"start"}"#).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    let v = res.json();
    assert_eq!(v["message"], "Traduction des commentaires lancée");
    assert!(matches!(
        v["commentary"]["status"].as_str(),
        Some("queued" | "running")
    ));
    wait_running(&t.media, t.partial).await;
    // Déjà en cours : 200, « Pas de lancement » n'apparaît pas (statut running).
    let res = post(&t, &p, "paul", r#"{"action":"start","manual":true}"#).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["message"], "Traduction déjà en cours");
    // Piste prête : pas de lancement automatique, relance par un administrateur.
    let pf = format!("/api/matches/{}/commentary", t.full);
    let res = post(&t, &pf, "paul", r#"{"action":"start"}"#).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["message"], "Pas de lancement (ready)");
    let res = post(&t, &pf, "admin", r#"{"action":"retry"}"#).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json()["commentary"]["status"], "queued");
    assert_eq!(t.media.commentary.activity().queued, vec![t.full]);
    // Activité : traduction en cours et en file.
    let v = get(&t, "/api/activity", "paul").await.json();
    assert_eq!(v["tasks"][0]["kind"], "traduction");
    assert_eq!(v["tasks"][0]["match"]["id"], t.partial);
    assert_eq!(v["tasks"][0]["label"], "Démarrage");
    assert_eq!(v["tasks"][0]["watched"], true);
    assert_eq!(v["queued"][0]["kind"], "traduction");
    assert_eq!(v["queued"][0]["match"]["id"], t.full);
    // GET : statut seul, sans effet de bord.
    let res = get(&t, &p, "paul").await;
    assert_eq!(res.json()["commentary"]["status"], "running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn doublage_et_troncons() {
    let _g = LOCK.lock().await;
    let t = setup();
    let p = format!("/api/matches/{}/dub", t.full);
    let res = get(&t, &p, "paul").await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    assert_eq!(v["status"], "disabled");
    assert_eq!(v["reason"], "doublage désactivé (DUB_DISABLED=1)");
    assert!(
        !t.media.commentary.viewer_active(t.full),
        "sans `t` : aucun effet de bord"
    );
    get(&t, &format!("{p}?t=30"), "paul").await;
    assert_eq!(t.media.commentary.viewer_position(t.full), Some(30.0));
    for (body, s) in [
        (r#"{"action":"nope"}"#, 400),
        (r#"{"action":"retry"}"#, 403),
    ] {
        assert_eq!(
            post(&t, &p, "paul", body).await.status.as_u16(),
            s,
            "{body}"
        );
    }
    let res = post(&t, &p, "paul", r#"{"action":"stop"}"#).await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["dub", "commentary", "message"]);
    assert_eq!(v["commentary"]["status"], "ready");
    let res = post(&t, &p, "paul", r#"{"action":"start"}"#).await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "doublage désactivé : rien en file"
    );
    assert!(t.media.dub.activity().queued.is_empty());

    // Tronçons doublés.
    let c0 = format!("/api/matches/{}/dub/0", t.full);
    let res = get(&t, &c0, "paul").await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.headers[header::CONTENT_TYPE], "audio/mp4");
    assert_eq!(res.headers[header::ACCEPT_RANGES], "bytes");
    assert_eq!(res.headers[header::CACHE_CONTROL], "private, max-age=86400");
    assert_eq!(res.headers[header::CONTENT_LENGTH], "1000");
    let file = std::fs::read(t.data.join("dub").join(t.full.to_string()).join("c000.m4a")).unwrap();
    assert_eq!(res.bytes, file);
    let res = send(
        &t,
        "GET",
        &c0,
        Some("paul"),
        &[("range", "bytes=10-19")],
        "",
    )
    .await;
    assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(res.headers[header::CONTENT_RANGE], "bytes 10-19/1000");
    assert_eq!(res.headers[header::CONTENT_LENGTH], "10");
    assert_eq!(res.bytes, file[10..20]);
    let res = send(
        &t,
        "GET",
        &c0,
        Some("paul"),
        &[("range", "bytes=2000-")],
        "",
    )
    .await;
    assert_eq!(res.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(res.headers[header::CONTENT_RANGE], "bytes */1000");
    assert!(res.bytes.is_empty());
    for (idx, s) in [
        ("1", 404),
        ("2", 404),
        ("x", 400),
        ("-1", 400),
        ("1.0", 400),
        ("99999999999999999999", 400),
    ] {
        let res = get(&t, &format!("/api/matches/{}/dub/{idx}", t.full), "paul").await;
        assert_eq!(res.status.as_u16(), s, "{idx}");
    }
    assert_eq!(
        get(&t, "/api/matches/abc/dub/0", "paul").await.status,
        StatusCode::BAD_REQUEST
    );
}

// ---------------------------------------------------------------- mises en file de fond

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mises_en_file_de_fond_et_replay_trouve() {
    let _g = LOCK.lock().await;
    let t = setup();
    let dbh = db::Db::new(t.path.clone());
    let (d, m) = (dbh.clone(), t.media.clone());
    let block = move |f: fn(&db::Db, &Media) -> scheduler::Queued| {
        let (d, m) = (d.clone(), m.clone());
        async move {
            tokio::task::spawn_blocking(move || f(&d, &m))
                .await
                .unwrap()
        }
    };
    // Traduction automatique désactivée : rien en file, ni de fond ni sur un replay trouvé.
    set_auto_translate(&t, false);
    assert_eq!(
        block(scheduler::queue_new_replay_work).await,
        scheduler::Queued::default()
    );
    let (d2, m2, id) = (dbh.clone(), t.media.clone(), t.partial);
    let r = tokio::task::spawn_blocking(move || scheduler::prioritize_found_replay(&d2, &m2, id))
        .await
        .unwrap();
    assert!(!r);
    assert!(t.media.commentary.activity().running.is_none());
    // Activée : replay trouvé → traduction de ce match en tête de file.
    set_auto_translate(&t, true);
    let (d2, m2) = (dbh.clone(), t.media.clone());
    let r = tokio::task::spawn_blocking(move || scheduler::prioritize_found_replay(&d2, &m2, id))
        .await
        .unwrap();
    assert!(r);
    wait_running(&t.media, t.partial).await;
    // Pré-traduction de fond : replays récents sans piste complète.
    let q = block(|d, m| scheduler::queue_recent_work(d, m, true, false)).await;
    assert_eq!(q.analyses, 0);
    assert!(q.commentaries > 0, "{q:?}");
    let a = t.media.commentary.activity();
    assert_eq!(a.queued.len(), q.commentaries);
    assert!(
        !a.queued.contains(&t.partial),
        "le match en cours n'est pas remis en file"
    );
    // Analyses : uniquement quand on les demande.
    let q = block(|d, m| scheduler::queue_recent_work(d, m, false, true)).await;
    assert_eq!(q.commentaries, 0);
    assert_eq!(
        t.media.analysis.activity().queued.len() + t.media.analysis.activity().running.len(),
        q.analyses
    );
}
