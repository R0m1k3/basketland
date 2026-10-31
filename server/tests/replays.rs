//! Recherche des replays (étape 5b) face à un faux basketball-video et un
//! faux ok.ru locaux (serveur axum sur 127.0.0.1, comme `tests/video.rs`) :
//! portage de `tests/bv*.test.ts`, `tests/sync-videos.test.ts`,
//! `tests/replay-route.test.ts` et de la part serveur de
//! `tests/replay-watch.test.ts`. Là où Node remplace `fetch` ou `findReplay`,
//! les requêtes partent ici vers le faux site (hôte d'origine dans
//! `x-upstream-host`). L'application Node (files de traduction) est simulée
//! elle aussi : on y lit les appels de `POST /api/internal/replays`.
//!
//! Les analyseurs sont aussi comparés aux sorties du code TypeScript
//! (`fixtures/bv.expected.json`, produit par `node-fixtures-bv.mts`).

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use basketland_server::bv::{self, Bv, ListingEntry, ReplayMatch};
use basketland_server::okru::parse_ok_embed;
use basketland_server::replay::{self, Replays};
use basketland_server::state::AppState;
use basketland_server::video::testkit::{embed_html_with, signed_master, signed_mp4};
use basketland_server::video::{TestConfig, Video, TEST_HOST_HEADER};
use basketland_server::{app, auth, db, proxy};
use chrono::{Duration as Days, Utc};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

const TOKEN: &str = "jeton-ingest-test";

// ------------------------------------------------------------------ faux site et faux ok.ru

#[derive(Default)]
struct Fake {
    /// URL d'origine complète → HTML.
    pages: Mutex<HashMap<String, String>>,
    /// okId → page d'embed.
    embeds: Mutex<HashMap<String, String>>,
    /// URL d'origine → délai de réponse (ms).
    delays: Mutex<HashMap<String, u64>>,
    fetched: Mutex<Vec<String>>,
}

impl Fake {
    fn page(&self, url: &str, html: impl Into<String>) {
        self.pages
            .lock()
            .unwrap()
            .insert(url.to_string(), html.into());
    }
    fn embed(&self, id: &str, html: String) {
        self.embeds.lock().unwrap().insert(id.to_string(), html);
    }
    fn delay(&self, url: &str, ms: u64) {
        self.delays.lock().unwrap().insert(url.to_string(), ms);
    }
    fn fetched(&self) -> Vec<String> {
        self.fetched.lock().unwrap().clone()
    }
    fn clear_fetched(&self) {
        self.fetched.lock().unwrap().clear();
    }
    fn count(&self, url: &str) -> usize {
        self.fetched().iter().filter(|u| *u == url).count()
    }
}

async fn fake_handler(State(f): State<Arc<Fake>>, req: Request) -> Response {
    let host = req
        .headers()
        .get(TEST_HOST_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let url = format!("https://{host}{pq}");
    f.fetched.lock().unwrap().push(url.clone());
    let delay = f.delays.lock().unwrap().get(&url).copied();
    if let Some(ms) = delay {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    let body = if host == "ok.ru" {
        let id = pq.trim_start_matches("/videoembed/").to_string();
        f.embeds.lock().unwrap().get(&id).cloned()
    } else {
        f.pages.lock().unwrap().get(&url).cloned()
    };
    match body {
        Some(b) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(b))
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(Body::from("not found"))
            .unwrap(),
    }
}

async fn serve(router: axum::Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    format!("http://{addr}")
}

/// Fausse application Node : enregistre les appels internes (jeton, corps).
#[derive(Default)]
struct FakeNode {
    calls: Mutex<Vec<(Option<String>, Value)>>,
}

impl FakeNode {
    fn calls(&self) -> Vec<(Option<String>, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

async fn node_handler(State(n): State<Arc<FakeNode>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let auth = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let b = req.into_body().collect().await.unwrap().to_bytes();
    if path != replay::NODE_REPLAYS_PATH {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    }
    n.calls
        .lock()
        .unwrap()
        .push((auth, serde_json::from_slice(&b).unwrap_or(Value::Null)));
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"ok":true}"#))
        .unwrap()
}

struct H {
    f: Arc<Fake>,
    node: Arc<FakeNode>,
    node_url: String,
    video: Video,
    bv: Bv,
}

async fn harness() -> H {
    static ENV: std::sync::Once = std::sync::Once::new();
    ENV.call_once(|| std::env::set_var("INGEST_TOKEN", TOKEN));
    let f = Arc::new(Fake::default());
    let url = serve(
        axum::Router::new()
            .fallback(fake_handler)
            .with_state(f.clone()),
    )
    .await;
    let node = Arc::new(FakeNode::default());
    let node_url = serve(
        axum::Router::new()
            .fallback(node_handler)
            .with_state(node.clone()),
    )
    .await;
    let video = Video::for_tests(TestConfig {
        upstream: Some(url),
        env: HashMap::new(),
    });
    // Pas d'attente de 2 s entre deux pages (BV_RATE_MS=0 côté Node).
    let bv = Bv::with_rate(video.clone(), 0.0);
    H {
        f,
        node,
        node_url,
        video,
        bv,
    }
}

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Lien de liste au format réel du site.
fn link(away: &str, home: &str, d: &str) -> String {
    let (y, rest) = d.split_once('-').unwrap();
    let (m, day) = rest.split_once('-').unwrap();
    let month = MONTHS[m.parse::<usize>().unwrap() - 1];
    format!(
        r#"<a href="https://basketball-video.com/{away}-vs-{home}-nba-full-game-replay-{month}-{}-{y}">Watch</a>"#,
        day.parse::<u32>().unwrap()
    )
}

fn listing_page(links: &[String], max_pages: usize) -> String {
    let pager: String = (1..=max_pages)
        .map(|i| format!(r#"<a href="?page{i}">{i}</a>"#))
        .collect();
    format!("{}\n{pager}", links.join("\n"))
}

fn match_page(servers: &[&str]) -> String {
    servers
        .iter()
        .enumerate()
        .map(|(i, href)| {
            let label = ["OK", "DM", "FM"].get(i).copied().unwrap_or("X");
            format!(
                "<p><b>Server #{} ({label})</b></p>\n<p><a class=\"su-button\" href=\"{href}\">Watch</a></p>\n<p>---</p>",
                i + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn target_page(ids: &[&str]) -> String {
    ids.iter()
        .map(|id| {
            format!(r#"<iframe class="yt-embed" src="//ok.ru/videoembed/{id}"></iframe><p>---</p>"#)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn exp() -> i64 {
    Utc::now().timestamp_millis() + 86_400_000
}

fn mp4_only(duration: u64) -> String {
    embed_html_with(
        duration,
        None,
        &[(
            "mobile",
            signed_mp4("mobile", exp(), "vd123.okcdn.ru"),
            false,
        )],
        false,
    )
}

fn hls(duration: u64) -> String {
    embed_html_with(
        duration,
        Some(&signed_master(exp())),
        &[("sd", signed_mp4("sd", exp(), "vd123.okcdn.ru"), false)],
        false,
    )
}

fn nothing() -> String {
    embed_html_with(6016, None, &[], false)
}

fn disallowed_only() -> String {
    embed_html_with(
        6016,
        None,
        &[("hd", signed_mp4("hd", exp(), "vd123.okcdn.ru"), true)],
        false,
    )
}

// ------------------------------------------------------------------ analyseurs comparés à Node

fn entry_of(v: &Value) -> ListingEntry {
    ListingEntry {
        url: v["url"].as_str().unwrap().into(),
        slug: v["slug"].as_str().unwrap().into(),
        away_slug: v["awaySlug"].as_str().unwrap().into(),
        home_slug: v["homeSlug"].as_str().unwrap().into(),
        date: v["date"].as_str().map(str::to_string),
    }
}

fn result<T>(r: Result<T, String>, f: impl FnOnce(T) -> Value) -> Value {
    match r {
        Ok(v) => json!({ "ok": f(v) }),
        Err(e) => json!({ "err": e }),
    }
}

#[test]
fn analyseurs_comme_node() {
    let fx = |f: &str| {
        std::fs::read_to_string(format!(
            "{}/../tests/fixtures/{f}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    };
    let cases: Vec<Value> = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/tests/fixtures/bv.expected.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(cases.len() > 60);
    for (i, c) in cases.iter().enumerate() {
        let input = &c["input"];
        let s = input.as_str().unwrap_or("");
        let got = match c["fn"].as_str().unwrap() {
            "parseServerBlocks" => {
                json!({ "ok": bv::parse_server_blocks(s).iter().map(|b| b.to_json()).collect::<Vec<_>>() })
            }
            "parseOkIframes" => json!({ "ok": bv::parse_ok_iframes(s) }),
            "parseFirstOkIframe" => json!({ "ok": bv::parse_first_ok_iframe(s) }),
            "parseListing" => result(
                bv::parse_listing(s),
                |(e, max)| json!({ "entries": e.iter().map(|x| x.to_json()).collect::<Vec<_>>(), "maxPage": basketland_server::api::js_num_value(max) }),
            ),
            "parseReplaySlug" => {
                json!({ "ok": bv::parse_replay_slug(s).map(|x| x.to_json()) })
            }
            "teamSlug" => json!({ "ok": bv::team_slug(s) }),
            "usDateKey" => result(bv::us_date_key(s), Value::from),
            "seasonLabel" => json!({ "ok": bv::season_label(input.as_f64().unwrap()) }),
            "matchListingEntry" => {
                let entries: Vec<ListingEntry> = input["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(entry_of)
                    .collect();
                let m = &input["match"];
                let rm = ReplayMatch {
                    home_name: m["home_name"].as_str().unwrap().into(),
                    away_name: m["away_name"].as_str().unwrap().into(),
                    date_utc: m["date_utc"].as_str().unwrap().into(),
                    season: 2026.0,
                };
                result(bv::match_listing_entry(&entries, &rm), |e| {
                    e.map_or(Value::Null, |e| e.to_json())
                })
            }
            "embedKind" => {
                let e = parse_ok_embed(&fx(s), "16656495217324");
                json!({ "ok": { "kind": bv::embed_kind(&e), "duration": e.duration.map(basketland_server::api::js_num_value) } })
            }
            "humanReplayReason" => {
                json!({ "ok": replay::human_replay_reason(input.as_str()) })
            }
            "replayRecheckWindow" => {
                let now = basketland_server::time::parse_instant(s)
                    .unwrap()
                    .timestamp_millis() as f64;
                let w = replay::replay_recheck_window(now);
                json!({ "ok": { "since": w.since, "recentSince": w.recent_since, "recentRecheckBefore": w.recent_recheck_before, "recheckBefore": w.recheck_before } })
            }
            other => panic!("cas inconnu {other}"),
        };
        if let (Some(a), Some(b)) = (
            got["ok"]["entries"].as_array(),
            c["output"]["ok"]["entries"].as_array(),
        ) {
            for (j, (x, y)) in a.iter().zip(b).enumerate() {
                assert_eq!(x, y, "cas {i} : entrée {j}");
            }
        }
        assert_eq!(got, c["output"], "cas {i} ({}) : {input}", c["fn"]);
    }
}

// ------------------------------------------------------------------ findReplay (bv-replay.test.ts)

const SLUG: &str = "los-angeles-lakers-vs-la-clippers-nba-full-game-replay-october-28-2026";
const LISTING_URL: &str = "https://basketball-video.com/2026-27";

fn entry_url() -> String {
    format!("https://basketball-video.com/{SLUG}")
}

fn the_match() -> ReplayMatch {
    ReplayMatch {
        home_name: "LA Clippers".into(),
        away_name: "Los Angeles Lakers".into(),
        date_utc: "2026-10-29T02:30:00Z".into(),
        season: 2026.0,
    }
}

async fn replay_harness() -> H {
    let h = harness().await;
    h.f.page(LISTING_URL, format!(r#"<a href="/{SLUG}">Watch</a>"#));
    h
}

#[tokio::test]
async fn server1_mp4_seul_disponible_et_paresseux() {
    let h = replay_harness().await;
    h.f.page(
        &entry_url(),
        match_page(&["https://s1.example/a", "https://s2.example/b"]),
    );
    h.f.page("https://s1.example/a", target_page(&["111111"]));
    h.f.embed("111111", mp4_only(6016));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(r.slug.as_deref(), Some(SLUG));
    assert_eq!(r.ok_id.as_deref(), Some("111111"));
    assert_eq!(r.duration, Some(6016.0));
    assert!(r.available);
    assert_eq!(r.kind, Some("mp4"));
    // Paresseux : le Server #2 n'est pas téléchargé.
    assert_eq!(h.f.count("https://s2.example/b"), 0);
}

#[tokio::test]
async fn hls_retenu() {
    let h = replay_harness().await;
    h.f.page(&entry_url(), match_page(&["https://s1.example/a"]));
    h.f.page("https://s1.example/a", target_page(&["222222"]));
    h.f.embed("222222", hls(8033));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        (r.ok_id.as_deref(), r.available, r.kind, r.duration),
        (Some("222222"), true, Some("hls"), Some(8033.0))
    );
}

#[tokio::test]
async fn serveur_illisible_puis_mort_puis_lisible() {
    let h = replay_harness().await;
    h.f.page(
        &entry_url(),
        match_page(&[
            "https://s1.example/a",
            "https://s2.example/dead",
            "https://s3.example/c",
        ]),
    );
    h.f.page("https://s1.example/a", target_page(&["111111"]));
    h.f.embed("111111", nothing());
    h.f.page("https://s3.example/c", target_page(&["333333"]));
    h.f.embed("333333", mp4_only(6016));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        (r.ok_id.as_deref(), r.available, r.kind),
        (Some("333333"), true, Some("mp4"))
    );
}

#[tokio::test]
async fn premiers_iframes_avant_les_secondaires() {
    let h = replay_harness().await;
    h.f.page(
        &entry_url(),
        match_page(&["https://s1.example/a", "https://s2.example/b"]),
    );
    // Page cible partagée : le 2e iframe est un AUTRE match, lisible.
    h.f.page("https://s1.example/a", target_page(&["111111", "999999"]));
    h.f.embed("111111", hls(120));
    h.f.embed("999999", hls(8033));
    h.f.page("https://s2.example/b", target_page(&["222222"]));
    h.f.embed("222222", mp4_only(6016));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!((r.ok_id.as_deref(), r.kind), (Some("222222"), Some("mp4")));
    assert!(!h.f.fetched().iter().any(|u| u.contains("999999")));
}

#[tokio::test]
async fn iframes_secondaires_en_dernier_recours() {
    let h = replay_harness().await;
    h.f.page(&entry_url(), match_page(&["https://s1.example/a"]));
    h.f.page("https://s1.example/a", target_page(&["111111", "444444"]));
    h.f.embed("111111", disallowed_only());
    h.f.embed("444444", hls(8033));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        (r.ok_id.as_deref(), r.kind, r.available),
        (Some("444444"), Some("hls"), true)
    );
}

#[tokio::test]
async fn rien_de_lisible_premier_candidat_et_sa_raison() {
    let h = replay_harness().await;
    h.f.page(
        &entry_url(),
        match_page(&["https://s1.example/a", "https://s2.example/b"]),
    );
    h.f.page("https://s1.example/a", target_page(&["111111"]));
    h.f.embed("111111", hls(120));
    h.f.page("https://s2.example/b", target_page(&["222222"]));
    h.f.embed("222222", nothing());
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        r.to_json(),
        json!({ "slug": SLUG, "okId": "111111", "duration": 120, "available": false, "kind": null, "reason": "vidéo trop courte (teaser)" })
    );
}

#[tokio::test]
async fn embed_en_erreur_http_serveur_suivant() {
    let h = replay_harness().await;
    h.f.page(
        &entry_url(),
        match_page(&["https://s1.example/a", "https://s2.example/b"]),
    );
    h.f.page("https://s1.example/a", target_page(&["111111"])); // embed absent → 404
    h.f.page("https://s2.example/b", target_page(&["222222"]));
    h.f.embed("222222", hls(8033));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!((r.ok_id.as_deref(), r.kind), (Some("222222"), Some("hls")));

    // Aucun autre candidat : la raison porte l'erreur de l'embed.
    let h = replay_harness().await;
    h.f.page(&entry_url(), match_page(&["https://s1.example/a"]));
    h.f.page("https://s1.example/a", target_page(&["111111"]));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        r.to_json(),
        json!({ "slug": SLUG, "okId": "111111", "duration": null, "available": false, "kind": null,
                "reason": "embed ok.ru illisible (HTTP 404 pour https://ok.ru/videoembed/111111)" })
    );
}

#[tokio::test]
async fn aucun_iframe_raison_explicite() {
    let h = replay_harness().await;
    h.f.page(&entry_url(), match_page(&["https://s1.example/a"]));
    h.f.page("https://s1.example/a", "<p>rien</p>");
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        r.to_json(),
        json!({ "slug": SLUG, "okId": null, "duration": null, "available": false, "kind": null, "reason": "iframe ok.ru introuvable" })
    );
}

#[tokio::test]
async fn page_sans_bloc_server_avec_iframe_direct() {
    let h = replay_harness().await;
    h.f.page(&entry_url(), target_page(&["555555"]));
    h.f.embed("555555", mp4_only(6016));
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!((r.ok_id.as_deref(), r.kind), (Some("555555"), Some("mp4")));
}

#[tokio::test]
async fn replay_non_liste() {
    let h = harness().await;
    h.f.page(LISTING_URL, "<p>vide</p>");
    let r = h.bv.find_replay(&the_match(), false).await.unwrap();
    assert_eq!(
        r.to_json(),
        json!({ "slug": null, "okId": null, "duration": null, "available": false, "kind": null, "reason": "replay non listé" })
    );
}

#[tokio::test]
async fn liste_injoignable_erreur() {
    let h = harness().await;
    let e = h.bv.find_replay(&the_match(), false).await.unwrap_err();
    assert_eq!(e, "HTTP 404 pour https://basketball-video.com/2026-27");
}

// ------------------------------------------------------------------ cache des listes (bv-cache, bv-refresh)

fn pages_r1(h: &H) {
    let l = |ds: &[&str]| {
        listing_page(
            &ds.iter()
                .map(|d| link("2026-27/alpha", "omega", d))
                .collect::<Vec<_>>(),
            3,
        )
    };
    h.f.page(LISTING_URL, l(&["2026-11-15", "2026-11-14", "2026-11-13"]));
    h.f.page(
        &format!("{LISTING_URL}?page2"),
        l(&["2026-11-12", "2026-11-11", "2026-11-10"]),
    );
    h.f.page(
        &format!("{LISTING_URL}?page3"),
        l(&["2026-11-09", "2026-11-08", "2026-11-05"]),
    );
}

#[tokio::test]
async fn cache_tronque_jamais_reutilise_pour_une_date_plus_ancienne() {
    let h = harness().await;
    pages_r1(&h);
    // 14 nov. : page 1 (15, 14, 13) ne suffit pas, page 2 (12, 11, 10) oui.
    let recent =
        h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, false)
            .await
            .unwrap();
    assert_eq!(h.f.fetched().len(), 2);
    assert!(!recent.is_empty());
    // 4 nov. : plus ancien que la couverture (10 nov.) → nouveau parcours.
    h.f.clear_fetched();
    let older =
        h.bv.fetch_season_listing(2026.0, "2026-11-04", 15.0, false)
            .await
            .unwrap();
    assert!(!h.f.fetched().is_empty());
    assert!(older.len() > recent.len());
}

#[tokio::test]
async fn cache_reutilise_quand_la_date_est_couverte() {
    let h = harness().await;
    pages_r1(&h);
    let a =
        h.bv.fetch_season_listing(2026.0, "2026-11-04", 15.0, false)
            .await
            .unwrap();
    assert_eq!(h.f.fetched().len(), 3);
    let b =
        h.bv.fetch_season_listing(2026.0, "2026-11-06", 15.0, false)
            .await
            .unwrap();
    assert_eq!(h.f.fetched().len(), 3, "cache attendu");
    assert_eq!(a.len(), b.len());
}

fn pages_refresh(h: &H, first: Vec<String>) {
    h.f.page(LISTING_URL, listing_page(&first, 3));
    h.f.page(
        &format!("{LISTING_URL}?page2"),
        listing_page(
            &[
                link("delta", "omega", "2026-11-12"),
                link("alpha", "beta", "2026-11-11"),
            ],
            3,
        ),
    );
    h.f.page(
        &format!("{LISTING_URL}?page3"),
        listing_page(
            &[
                link("gamma", "delta", "2026-11-09"),
                link("omega", "alpha", "2026-11-05"),
            ],
            3,
        ),
    );
}

#[tokio::test]
async fn relecture_forcee_premiere_page_seule() {
    const { assert!(bv::LISTING_TTL_MS <= 10.0 * 60_000.0) };
    let h = harness().await;
    pages_refresh(
        &h,
        vec![
            link("alpha", "omega", "2026-11-15"),
            link("beta", "gamma", "2026-11-14"),
        ],
    );
    let first =
        h.bv.fetch_season_listing(2026.0, "2026-11-04", 15.0, false)
            .await
            .unwrap();
    assert_eq!(h.f.fetched().len(), 3);

    // Nouveau replay publié en tête de la 1re page.
    pages_refresh(
        &h,
        vec![
            link("epsilon", "zeta", "2026-11-16"),
            link("alpha", "omega", "2026-11-15"),
        ],
    );
    h.f.clear_fetched();
    let cached =
        h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, false)
            .await
            .unwrap();
    assert!(h.f.fetched().is_empty());
    assert!(!cached.iter().any(|e| e.away_slug == "epsilon"));

    h.video
        .advance_clock(bv::FIRST_PAGE_REFRESH_MS as i64 + 1000);
    let fresh =
        h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, true)
            .await
            .unwrap();
    assert_eq!(h.f.fetched(), vec![LISTING_URL.to_string()]);
    assert!(fresh
        .iter()
        .any(|e| e.away_slug == "epsilon" && e.home_slug == "zeta"));
    assert!(fresh
        .iter()
        .any(|e| e.away_slug == "beta" && e.home_slug == "gamma"));
    assert_eq!(fresh.len(), first.len() + 1);

    // La fusion reste en cache.
    h.f.clear_fetched();
    let again =
        h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, false)
            .await
            .unwrap();
    assert_eq!(again.len(), fresh.len());
    assert!(h.f.fetched().is_empty());
}

#[tokio::test]
async fn relecture_forcee_au_plus_une_fois_par_minute() {
    let h = harness().await;
    pages_refresh(
        &h,
        vec![
            link("alpha", "omega", "2026-11-15"),
            link("beta", "gamma", "2026-11-14"),
        ],
    );
    h.bv.fetch_season_listing(2026.0, "2026-11-04", 15.0, false)
        .await
        .unwrap();
    h.f.clear_fetched();
    h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, true)
        .await
        .unwrap();
    assert!(h.f.fetched().is_empty());
    h.video
        .advance_clock(bv::FIRST_PAGE_REFRESH_MS as i64 + 1000);
    h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, true)
        .await
        .unwrap();
    h.bv.fetch_season_listing(2026.0, "2026-11-12", 15.0, true)
        .await
        .unwrap();
    assert_eq!(h.f.fetched(), vec![LISTING_URL.to_string()]);
}

#[tokio::test]
async fn cache_perime_parcours_complet() {
    let h = harness().await;
    pages_refresh(
        &h,
        vec![
            link("alpha", "omega", "2026-11-15"),
            link("beta", "gamma", "2026-11-14"),
        ],
    );
    h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, false)
        .await
        .unwrap();
    let first_run = h.f.fetched().len();
    h.video.advance_clock(bv::LISTING_TTL_MS as i64 + 1000);
    h.f.clear_fetched();
    h.bv.fetch_season_listing(2026.0, "2026-11-14", 15.0, false)
        .await
        .unwrap();
    assert_eq!(h.f.fetched().len(), first_run);
    assert_eq!(h.f.fetched()[0], LISTING_URL);
}

#[tokio::test]
async fn quatre_saisons_au_plus_en_cache() {
    let h = harness().await;
    for s in 2020..2026 {
        let label = bv::season_label(f64::from(s));
        h.f.page(
            &format!("https://basketball-video.com/{label}"),
            listing_page(&[link("a", "b", &format!("{s}-11-10"))], 1),
        );
    }
    for s in 2020..2025 {
        h.bv.fetch_season_listing(f64::from(s), "2099-01-01", 15.0, false)
            .await
            .unwrap();
    }
    // 2020 (la plus ancienne) a été évincée ; 2024 est en cache.
    h.f.clear_fetched();
    h.bv.fetch_season_listing(2024.0, "2099-01-01", 15.0, false)
        .await
        .unwrap();
    assert!(h.f.fetched().is_empty());
    h.bv.fetch_season_listing(2020.0, "2099-01-01", 15.0, false)
        .await
        .unwrap();
    assert_eq!(h.f.fetched().len(), 1);
}

// ------------------------------------------------------------------ base

const SCHEMA: &str = "
CREATE TABLE matches (
  id INTEGER PRIMARY KEY, espn_id TEXT UNIQUE NOT NULL, league TEXT NOT NULL DEFAULT 'nba', season INTEGER NOT NULL,
  season_type TEXT NOT NULL, date_utc TEXT NOT NULL, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, home_score INTEGER, away_score INTEGER, status TEXT NOT NULL,
  status_detail TEXT DEFAULT '', period INTEGER DEFAULT 0, clock_display TEXT DEFAULT '', venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '', slug TEXT, video_ok_id TEXT, video_duration INTEGER, video_available INTEGER DEFAULT 0,
  video_checked_at TEXT, stats_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, video_kind TEXT);
CREATE TABLE plays (match_id INTEGER NOT NULL, seq INTEGER NOT NULL, period INTEGER NOT NULL,
  clock_display TEXT NOT NULL, clock_sec INTEGER NOT NULL, wallclock TEXT NOT NULL, event_type TEXT NOT NULL, text_en TEXT NOT NULL,
  actor TEXT DEFAULT '', team_abbr TEXT DEFAULT '', home_score INTEGER, away_score INTEGER, scoring INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0, PRIMARY KEY (match_id, seq));
CREATE TABLE subtitles (match_id INTEGER NOT NULL, seq INTEGER NOT NULL, video_ts REAL NOT NULL, end_ts REAL,
  text_fr TEXT NOT NULL, speaker TEXT DEFAULT '', kind TEXT DEFAULT 'action', PRIMARY KEY (match_id, seq));
CREATE TABLE sync_anchors (match_id INTEGER NOT NULL, period INTEGER NOT NULL, clock_sec INTEGER NOT NULL,
  video_ts REAL NOT NULL, method TEXT DEFAULT 'manual', wallclock TEXT, PRIMARY KEY (match_id, period, clock_sec));
CREATE TABLE sync_settings (match_id INTEGER PRIMARY KEY, global_offset REAL NOT NULL DEFAULT 0,
  quarter_offsets_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE audio_profiles (match_id INTEGER PRIMARY KEY, ok_id TEXT NOT NULL, window_sec REAL NOT NULL DEFAULT 1,
  rms_db_json TEXT NOT NULL, cuts_json TEXT NOT NULL DEFAULT '[]', analyzed_at TEXT NOT NULL);
CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER DEFAULT 0, detail TEXT DEFAULT '');
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT 'x', last_login_at TEXT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
";

struct Base {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    db: db::Db,
}

impl Base {
    fn conn(&self) -> Connection {
        Connection::open(&self.path).unwrap()
    }
    fn exec(&self, sql: &str, p: impl rusqlite::Params) {
        self.conn().execute(sql, p).unwrap();
    }
    fn video(&self, id: i64) -> Value {
        self.conn()
            .query_row(
                "SELECT video_available, video_ok_id, video_kind, video_duration, slug, video_checked_at FROM matches WHERE id = ?1",
                [id],
                |r| {
                    Ok(json!({
                        "available": r.get::<_, Option<i64>>(0)?,
                        "ok_id": r.get::<_, Option<String>>(1)?,
                        "kind": r.get::<_, Option<String>>(2)?,
                        "duration": r.get::<_, Option<i64>>(3)?,
                        "slug": r.get::<_, Option<String>>(4)?,
                        "checked": r.get::<_, Option<String>>(5)?.is_some(),
                    }))
                },
            )
            .unwrap()
    }
}

fn iso(d: chrono::DateTime<Utc>) -> String {
    d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn base() -> Base {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    let c = Connection::open(&path).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    c.execute(
        "INSERT INTO users (id, username, role, password_hash) VALUES (1, 'michel', 'admin', 'x')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sessions VALUES (?1, 1, 'x', ?2)",
        [
            auth::hash_token("jeton-valide"),
            iso(Utc::now() + Days::days(30)),
        ],
    )
    .unwrap();
    let db = db::Db::new(path.clone());
    Base {
        _dir: dir,
        path,
        db,
    }
}

/// Match LAL @ LAC terminé (`date` : coup d'envoi), sans replay.
fn insert_match(b: &Base, id: i64, date: chrono::DateTime<Utc>) {
    b.exec(
        "INSERT INTO matches (id, espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status, created_at, updated_at)
         VALUES (?1, ?2, 2026, 'regular', ?3, 'LAC', 'LA Clippers', 'LAL', 'Los Angeles Lakers', 'final', 'x', 'x')",
        rusqlite::params![id, id.to_string(), iso(date)],
    );
}

fn set_mp4(b: &Base, id: i64, ok_id: &str, duration: i64) {
    b.exec(
        "UPDATE matches SET slug = 's', video_ok_id = ?2, video_duration = ?3, video_available = 1, video_kind = 'mp4', video_checked_at = NULL WHERE id = ?1",
        rusqlite::params![id, ok_id, duration],
    );
}

/// Liste de la saison 2026 avec le replay du match (date US du coup d'envoi).
fn list_match(h: &H, date: chrono::DateTime<Utc>) -> String {
    let us = bv::us_date_key(&iso(date)).unwrap();
    let slug = link("los-angeles-lakers", "la-clippers", &us);
    let href = slug.split('"').nth(1).unwrap().to_string();
    h.f.page(LISTING_URL, listing_page(&[slug], 1));
    href
}

fn row(b: &Base, id: i64) -> db::MatchRow {
    b.db.with(|c| db::get_match(c, id)).unwrap().unwrap()
}

// ------------------------------------------------------------------ syncVideos (sync-videos.test.ts)

/// Un seul `sync-videos` à la fois dans le processus (« déjà en cours ») :
/// les tests qui lancent le job passent l'un après l'autre.
async fn job_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static L: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    L.lock().await
}

#[tokio::test]
async fn sync_videos_mp4_vers_hls() {
    let _job = job_lock().await;
    let h = harness().await;
    let b = base();
    let d = Utc::now() - Days::days(1);
    insert_match(&b, 401, d);
    set_mp4(&b, 401, "111111", 6016);
    let entry = list_match(&h, d);
    h.f.page(&entry, target_page(&["111111"]));
    h.f.embed("111111", hls(6016));
    let replays = Replays::new(h.bv.clone());
    let (r, changed) = replays.sync_videos(&b.db, 20).await;
    assert!(r.ok, "{}", r.detail);
    assert_eq!(r.detail, "LAL@LAC: ok.ru/111111 hls (6016s)");
    assert_eq!(changed, 1);
    let v = b.video(401);
    assert_eq!(
        (v["available"].clone(), v["kind"].clone()),
        (json!(1), json!("hls"))
    );
    let log: (String, i64, String) = b
        .conn()
        .query_row(
            "SELECT task, ok, detail FROM ingest_log ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        log,
        (
            "sync-videos".into(),
            1,
            "LAL@LAC: ok.ru/111111 hls (6016s)".into()
        )
    );
    // Revérifié il y a un instant : plus rien à faire.
    let (r, changed) = replays.sync_videos(&b.db, 20).await;
    assert_eq!((r.detail.as_str(), changed), ("rien à faire", 0));
}

#[tokio::test]
async fn sync_videos_echec_ne_retrograde_pas_un_mp4() {
    let _job = job_lock().await;
    let h = harness().await;
    let b = base();
    let d = Utc::now() - Days::days(1);
    insert_match(&b, 401, d);
    set_mp4(&b, 401, "111111", 6016);
    let entry = list_match(&h, d);
    h.f.page(&entry, "<p>plus de vidéo</p>");
    let (r, changed) = Replays::new(h.bv.clone()).sync_videos(&b.db, 20).await;
    assert_eq!(r.detail, "LAL@LAC: iframe ok.ru introuvable");
    assert_eq!(changed, 0);
    let v = b.video(401);
    assert_eq!(v["available"], 1);
    assert_eq!(v["ok_id"], "111111");
    assert_eq!(v["kind"], "mp4");
    assert_eq!(v["checked"], true);
}

#[tokio::test]
async fn sync_videos_replay_trouve_en_mp4() {
    let _job = job_lock().await;
    let h = harness().await;
    let b = base();
    let d = Utc::now() - Days::days(1);
    insert_match(&b, 401, d);
    let entry = list_match(&h, d);
    h.f.page(&entry, target_page(&["222222"]));
    h.f.embed("222222", mp4_only(6016));
    let (r, changed) = Replays::new(h.bv.clone()).sync_videos(&b.db, 20).await;
    assert_eq!(r.detail, "LAL@LAC: ok.ru/222222 mp4 (6016s)");
    assert_eq!(changed, 1);
    let v = b.video(401);
    assert_eq!(v["ok_id"], "222222");
    assert_eq!(v["kind"], "mp4");
    assert_eq!(v["duration"], 6016);
    assert_eq!(
        v["slug"],
        entry.trim_start_matches("https://basketball-video.com/")
    );
}

#[tokio::test]
async fn sync_videos_site_injoignable_marque_verifie() {
    let _job = job_lock().await;
    let h = harness().await;
    let b = base();
    let d = Utc::now() - Days::days(1);
    insert_match(&b, 401, d);
    let (r, changed) = Replays::new(h.bv.clone()).sync_videos(&b.db, 20).await;
    assert!(r.ok);
    assert_eq!(
        r.detail,
        "401: HTTP 404 pour https://basketball-video.com/2026-27"
    );
    assert_eq!(changed, 0);
    assert_eq!(b.video(401)["checked"], true);
    assert_eq!(b.video(401)["available"], 0);
}

#[tokio::test]
async fn deux_recherches_simultanees_un_seul_scraping() {
    let h = harness().await;
    let b = base();
    let d = Utc::now() - Days::days(1);
    insert_match(&b, 401, d);
    set_mp4(&b, 401, "111111", 6016);
    let entry = list_match(&h, d);
    h.f.delay(LISTING_URL, 300);
    h.f.page(&entry, target_page(&["111111"]));
    h.f.embed("111111", hls(6016));
    let replays = Replays::new(h.bv.clone());
    let (a, bb) = (replays.clone(), replays.clone());
    let (db1, db2) = (b.db.clone(), b.db.clone());
    let (m1, m2) = (row(&b, 401), row(&b, 401));
    let t1 = tokio::spawn(async move { a.search_replay(&db1, m1, false).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let t2 = tokio::spawn(async move { bb.search_replay(&db2, m2, false).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(replays.in_progress(401));
    let (ra, rb) = (t1.await.unwrap(), t2.await.unwrap());
    assert_eq!(h.f.count(LISTING_URL), 1);
    assert_eq!(ra, rb);
    assert!(ra.changed); // MP4 → HLS
    assert!(!replays.in_progress(401));
}

// ------------------------------------------------------------------ POST /api/matches/[id]/replay

const ID: i64 = 401909900;

struct R {
    h: H,
    b: Base,
    replays: Replays,
}

impl R {
    fn app(&self) -> axum::Router {
        app(AppState {
            db: self.b.db.clone(),
            upstream: proxy::Upstream::new(&self.h.node_url),
            video: self.h.video.clone(),
            replays: self.replays.clone(),
        })
    }

    async fn send(
        &self,
        req: axum::http::Request<Body>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let res = self.app().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post_with(
        &self,
        id: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut h: Vec<(&str, &str)> = vec![
            ("content-type", "application/json"),
            ("origin", "http://nas.local:3012"),
            ("host", "nas.local:3012"),
            ("cookie", "bl_session=jeton-valide"),
        ];
        for (k, v) in headers {
            h.retain(|(x, _)| x != k);
            h.push((k, v));
        }
        let mut b = axum::http::Request::post(format!("/api/matches/{id}/replay"));
        for (k, v) in h {
            if !v.is_empty() {
                b = b.header(k, v);
            }
        }
        self.send(b.body(Body::from(body.to_string())).unwrap())
            .await
    }

    async fn check(&self) -> (StatusCode, axum::http::HeaderMap, Value) {
        self.post_with(&ID.to_string(), r#"{"action":"check"}"#, &[])
            .await
    }
}

async fn route_harness(wait_ms: u64) -> R {
    let h = harness().await;
    let b = base();
    // Match terminé il y a peu, sans replay, jamais vérifié.
    insert_match(&b, ID, Utc::now() - Days::hours(3));
    let replays = Replays::with_wait(h.bv.clone(), wait_ms);
    R { h, b, replays }
}

/// Le replay du match est publié (HLS, 8033 s, ok.ru/777777).
fn publish(r: &R, embed: String) {
    let entry = list_match(&r.h, Utc::now() - Days::hours(3));
    r.h.f.page(&entry, target_page(&["777777"]));
    r.h.f.embed("777777", embed);
}

#[tokio::test]
async fn replay_garde_fous() {
    let r = route_harness(20_000).await;
    // Session exigée.
    let (s, _, _) = r
        .post_with(&ID.to_string(), r#"{"action":"check"}"#, &[("cookie", "")])
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // Origine tierce.
    let (s, _, v) = r
        .post_with(
            &ID.to_string(),
            r#"{"action":"check"}"#,
            &[("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(
        v,
        json!({ "error": "origine non autorisée pour cette écriture" })
    );
    // Content-Type.
    for ct in ["text/plain", "text/plain;charset=application/json", ""] {
        let (s, _, v) = r
            .post_with(
                &ID.to_string(),
                r#"{"action":"check"}"#,
                &[("content-type", ct)],
            )
            .await;
        assert_eq!(s, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{ct}");
        assert_eq!(
            v,
            json!({ "error": "Content-Type application/json requis" })
        );
    }
    // Action, JSON, identifiant.
    let (s, _, v) = r
        .post_with(&ID.to_string(), r#"{"action":"start"}"#, &[])
        .await;
    assert_eq!(
        (s, v),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "action invalide (attendu : 'check')" })
        )
    );
    for body in ["null", "[1]", "\"check\""] {
        let (s, _, _) = r.post_with(&ID.to_string(), body, &[]).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body}");
    }
    let (s, _, v) = r.post_with(&ID.to_string(), "{", &[]).await;
    assert_eq!(
        (s, v),
        (StatusCode::BAD_REQUEST, json!({ "error": "JSON invalide" }))
    );
    let (s, _, v) = r.post_with("999", r#"{"action":"check"}"#, &[]).await;
    assert_eq!(
        (s, v),
        (
            StatusCode::NOT_FOUND,
            json!({ "error": "match introuvable" })
        )
    );
    let (s, _, v) = r.post_with("abc", r#"{"action":"check"}"#, &[]).await;
    assert_eq!(
        (s, v),
        (StatusCode::BAD_REQUEST, json!({ "error": "id invalide" }))
    );
    // Aucune recherche lancée.
    assert!(r.h.f.fetched().is_empty());
    assert!(r.h.node.calls().is_empty());
}

#[tokio::test]
async fn replay_409_match_pas_termine() {
    let r = route_harness(20_000).await;
    r.b.exec("UPDATE matches SET status = 'live' WHERE id = ?1", [ID]);
    let (s, h, v) = r.check().await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(h["cache-control"], "no-store");
    assert_eq!(v["checked"], false);
    assert_eq!(v["video"]["available"], false);
    assert_eq!(
        v["message"],
        "Match pas encore terminé : le replay sera cherché automatiquement après le coup de sifflet final."
    );
    assert_eq!(
        v.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["video", "checked", "message"]
    );
    assert!(r.h.f.fetched().is_empty());
}

#[tokio::test]
async fn replay_deja_en_hls() {
    let r = route_harness(20_000).await;
    r.b.exec(
        "UPDATE matches SET video_ok_id = '555555', video_available = 1, video_kind = 'hls', video_duration = 8000 WHERE id = ?1",
        [ID],
    );
    let (s, _, v) = r.check().await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        (
            v["checked"].clone(),
            v["video"]["available"].clone(),
            v["video"]["kind"].clone(),
            v["message"].clone()
        ),
        (
            json!(false),
            json!(true),
            json!("hls"),
            json!("Replay déjà disponible.")
        )
    );
    assert!(r.h.f.fetched().is_empty());
}

#[tokio::test]
async fn replay_trouve_enregistre_et_traduction_en_file() {
    let r = route_harness(20_000).await;
    publish(&r, hls(8033));
    // Cache des listes chaud, 1re page lue il y a plus d'une minute : la
    // recherche à la demande la relit (`fresh`).
    r.h.f.page(LISTING_URL, "<p>pas encore</p>");
    r.h.bv
        .fetch_season_listing(2026.0, "2000-01-01", 15.0, false)
        .await
        .unwrap();
    publish(&r, hls(8033));
    r.h.video.advance_clock(61_000);
    r.h.f.clear_fetched();

    let (s, _, d) = r.check().await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(d["checked"], true);
    assert_eq!(d["message"], "Replay trouvé !");
    assert_eq!(d["video"]["available"], true);
    assert_eq!(d["video"]["ok_id"], "777777");
    assert_eq!(d["video"]["kind"], "hls");
    assert_eq!(d["video"]["src"], "/api/video/777777/master.m3u8");
    assert!(!d["video"]["checked_at"].is_null());
    assert_eq!(r.h.f.count(LISTING_URL), 1);
    let v = r.b.video(ID);
    assert_eq!(
        (
            v["available"].clone(),
            v["ok_id"].clone(),
            v["kind"].clone()
        ),
        (json!(1), json!("777777"), json!("hls"))
    );
    // Node met la traduction de ce match en tête de file (jeton d'ingestion).
    assert_eq!(
        r.h.node.calls(),
        vec![(Some(format!("Bearer {TOKEN}")), json!({ "match_id": ID }))]
    );
}

#[tokio::test]
async fn replay_trouve_en_mp4_version_provisoire() {
    let r = route_harness(20_000).await;
    publish(&r, mp4_only(8033));
    let (_, _, d) = r.check().await;
    assert_eq!(
        d["message"],
        "Replay trouvé ! Version provisoire : la haute définition suivra."
    );
    assert_eq!(d["video"]["src"], "/api/video/777777/file.mp4");
}

#[tokio::test]
async fn replay_pas_encore_publie() {
    let r = route_harness(20_000).await;
    r.h.f.page(LISTING_URL, "<p>vide</p>");
    let (s, _, d) = r.check().await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(d["checked"], true);
    assert_eq!(d["video"]["available"], false);
    assert_eq!(
        d["message"],
        "Pas encore de replay : pas encore publié sur le site des replays."
    );
    assert_eq!(r.b.video(ID)["checked"], true);
    assert!(r.h.node.calls().is_empty());
}

#[tokio::test]
async fn replay_site_injoignable() {
    let r = route_harness(20_000).await;
    let (_, _, d) = r.check().await;
    assert_eq!(
        d["message"],
        "Recherche impossible pour l’instant (site des replays injoignable). Nouvel essai automatique plus tard."
    );
}

#[tokio::test]
async fn replay_mp4_revérifie_passe_en_hls() {
    let r = route_harness(20_000).await;
    set_mp4(&r.b, ID, "777777", 8033);
    publish(&r, hls(8033));
    let (_, _, d) = r.check().await;
    assert_eq!(d["checked"], true);
    assert_eq!(d["video"]["kind"], "hls");
    assert_eq!(r.b.video(ID)["kind"], "hls");
}

#[tokio::test]
async fn replay_echec_ne_retrograde_pas_un_mp4() {
    let r = route_harness(20_000).await;
    set_mp4(&r.b, ID, "777777", 8033);
    r.h.f.page(LISTING_URL, "<p>vide</p>");
    let (_, _, d) = r.check().await;
    assert_eq!(d["video"]["available"], true);
    assert_eq!(d["video"]["kind"], "mp4");
    assert_eq!(
        d["message"],
        "Replay disponible ; la version haute définition n’est pas encore prête."
    );
    assert_eq!(r.b.video(ID)["kind"], "mp4");
}

#[tokio::test]
async fn replay_deuxieme_demande_429() {
    let r = route_harness(20_000).await;
    r.h.f.page(LISTING_URL, "<p>vide</p>");
    assert_eq!(r.check().await.0, StatusCode::OK);
    let (s, h, d) = r.check().await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(d["checked"], false);
    let n = d["retry_after"].as_i64().unwrap();
    assert!(n > 100 && n <= 120, "{n}");
    assert_eq!(h["retry-after"], n.to_string());
    assert_eq!(
        d["message"],
        format!("Recherche faite il y a moins de 2 min : nouvelle tentative possible dans {n} s.")
    );
    assert_eq!(
        d.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["video", "checked", "retry_after", "message"]
    );
    assert_eq!(r.h.f.count(LISTING_URL), 1);
}

#[tokio::test]
async fn replay_job_vient_de_verifier_429() {
    let r = route_harness(20_000).await;
    r.b.exec(
        "UPDATE matches SET video_checked_at = ?2 WHERE id = ?1",
        rusqlite::params![ID, iso(Utc::now() - Days::seconds(60))],
    );
    assert_eq!(r.check().await.0, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.h.f.fetched().is_empty());
}

#[tokio::test]
async fn replay_derniere_recherche_il_y_a_plus_de_2_min() {
    let r = route_harness(20_000).await;
    r.b.exec(
        "UPDATE matches SET video_checked_at = ?2 WHERE id = ?1",
        rusqlite::params![ID, iso(Utc::now() - Days::minutes(3))],
    );
    r.h.f.page(LISTING_URL, "<p>vide</p>");
    assert_eq!(r.check().await.0, StatusCode::OK);
    assert_eq!(r.h.f.count(LISTING_URL), 1);
}

#[tokio::test]
async fn replay_delai_propre_a_chaque_match() {
    let r = route_harness(20_000).await;
    insert_match(&r.b, ID + 1, Utc::now() - Days::days(1));
    r.h.f.page(LISTING_URL, "<p>vide</p>");
    assert_eq!(r.check().await.0, StatusCode::OK);
    let (s, _, _) = r
        .post_with(&(ID + 1).to_string(), r#"{"action":"check"}"#, &[])
        .await;
    assert_eq!(s, StatusCode::OK);
    // Deux recherches (la 2e lit la liste en cache : pas de requête de plus).
    assert_eq!(r.b.video(ID + 1)["checked"], true);
}

#[tokio::test]
async fn replay_demande_pendant_le_job_rejoint_sa_recherche() {
    let r = route_harness(20_000).await;
    publish(&r, hls(8033));
    r.h.f.delay(LISTING_URL, 300);
    let (rp, db, m) = (r.replays.clone(), r.b.db.clone(), row(&r.b, ID));
    let job = tokio::spawn(async move { rp.search_replay(&db, m, false).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (s, _, d) = r.check().await;
    let jr = job.await.unwrap();
    assert_eq!(r.h.f.count(LISTING_URL), 1);
    assert!(jr.available);
    assert_eq!(s, StatusCode::OK);
    assert_eq!(d["video"]["available"], true);
}

#[tokio::test]
async fn replay_recherche_trop_longue_202_puis_enregistree() {
    let r = route_harness(50).await;
    publish(&r, hls(8033));
    r.h.f.delay(LISTING_URL, 400);
    let (s, h, d) = r.check().await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert!(h.get("retry-after").is_none());
    assert_eq!(d["checked"], true);
    assert_eq!(d["pending"], true);
    assert_eq!(d["video"]["available"], false);
    assert_eq!(
        d["message"],
        "Recherche lancée : la page se mettra à jour dès que le replay sera trouvé."
    );
    assert_eq!(
        d.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["video", "checked", "pending", "message"]
    );
    // La recherche continue : replay enregistré, traduction mise en file.
    for _ in 0..100 {
        if !r.h.node.calls().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(r.h.node.calls().len(), 1);
    assert_eq!(r.b.video(ID)["ok_id"], "777777");
}

// ------------------------------------------------------------------ ingestion, cron et chemins internes

#[tokio::test]
async fn ingest_sync_videos_en_rust() {
    let _job = job_lock().await;
    let r = route_harness(20_000).await;
    publish(&r, hls(8033));
    let req = axum::http::Request::post("/api/ingest")
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"jobs":["sync-videos"]}"#))
        .unwrap();
    let (s, _, v) = r.send(req).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        v,
        json!({ "ok": true, "results": { "sync-videos": { "ok": true, "detail": "LAL@LAC: ok.ru/777777 hls (8033s)" } } })
    );
    // Comme côté Node : `runJob('sync-videos')` ne met rien en file.
    assert!(r.h.node.calls().is_empty());
}

#[tokio::test]
async fn chemins_internes_de_node_jamais_relayes() {
    let r = route_harness(20_000).await;
    for p in [
        "/api/internal/replays",
        "/api/%69nternal/replays",
        "//api/internal/replays/",
    ] {
        let req = axum::http::Request::post(p)
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let (s, _, _) = r.send(req).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{p}");
    }
    assert!(r.h.node.calls().is_empty());
}

#[tokio::test]
async fn signal_a_node_apres_le_job() {
    let h = harness().await;
    let up = proxy::Upstream::new(&h.node_url);
    replay::notify_node(&up, None).await.unwrap();
    assert_eq!(
        h.node.calls(),
        vec![(Some(format!("Bearer {TOKEN}")), json!({}))]
    );
    // Node absent : erreur, jamais de panique.
    let down = proxy::Upstream::new("http://127.0.0.1:9");
    assert!(replay::notify_node(&down, Some(1)).await.is_err());
}
