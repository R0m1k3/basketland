//! Proxy vidéo ok.ru face à un faux ok.ru local (serveur axum sur
//! 127.0.0.1) : cache des segments (segments à venir protégés),
//! préchargement qui suit la qualité lue, reprise des téléchargements
//! bloqués, cache des playlists et des flux résolus, relais MP4 avec Range.
//! Portage de `tests/video-proxy.test.ts` et `tests/okru-stream.test.ts`,
//! où ok.ru est simulé en remplaçant `fetch`. Ici, le proxy envoie ses
//! requêtes au faux serveur (hôte d'origine dans `x-upstream-host`) ; les
//! contrôles d'hôte (allow-list, https) portent toujours sur les URL ok.ru.

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use basketland_server::db::Db;
use basketland_server::video::testkit::{
    embed_html, media_playlist, signed_master, signed_mp4, MASTER, OK_ID,
};
use basketland_server::video::{TestConfig, VErr, Video, TEST_HOST_HEADER};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// 40 segments, pour laisser la place à une fenêtre de préchargement de 15 segments.
const SEG_COUNT: usize = 40;
const SEG_SIZE: usize = 1000;
const MP4_SIZE: usize = 5000;
const TS: &str = "video/MP2T";

fn seg(n: usize) -> String {
    format!("MEDIUM{n:05}.ts")
}

fn seg_bytes(i: usize) -> Vec<u8> {
    vec![(i % 256) as u8; SEG_SIZE]
}

/// Octets tous différents d'une position à l'autre : un décalage de reprise se verrait.
fn patterned(seed: usize) -> Vec<u8> {
    (0..SEG_SIZE)
        .map(|i| ((i * 7 + seed) % 256) as u8)
        .collect()
}

// ------------------------------------------------------------------ faux ok.ru

/// Réponse simulée.
enum R {
    Full(u16, Vec<(&'static str, String)>, Vec<u8>),
    /// Livre les octets puis ne donne plus rien, sans se fermer (connexion bloquée).
    Stall(Vec<(&'static str, String)>, Vec<u8>),
    /// Livre les octets au compte-gouttes (50 octets toutes les 50 ms).
    Trickle(u16, Vec<(&'static str, String)>, Vec<u8>),
    /// Livre les octets puis coupe la connexion (avant la fin annoncée).
    Truncated(Vec<(&'static str, String)>, Vec<u8>),
    /// Les en-têtes n'arrivent jamais.
    Hang,
    /// Comme `Stall`, et lève le drapeau quand le serveur abandonne le corps
    /// (connexion fermée par le proxy).
    StallUntilClosed(Vec<(&'static str, String)>, Vec<u8>, Arc<AtomicBool>),
}

/// Lève le drapeau à sa destruction.
struct OnDrop(Arc<AtomicBool>);
impl Drop for OnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn ts_headers(len: Option<usize>) -> Vec<(&'static str, String)> {
    let mut h = vec![("content-type", TS.to_string())];
    if let Some(l) = len {
        h.push(("content-length", l.to_string()));
    }
    h
}

#[derive(Clone, Debug)]
struct Call {
    url: String,
    range: Option<String>,
    peer: SocketAddr,
}

type StatusFn = Box<dyn Fn(&str, usize) -> u16 + Send + Sync>;
type DelayFn = Box<dyn Fn(&str, usize) -> u64 + Send + Sync>;
type SegResponder = Box<dyn Fn(&str, usize, Option<&str>) -> Option<R> + Send + Sync>;
type Mp4Responder = Box<dyn Fn(&str, Option<&str>) -> R + Send + Sync>;

struct Fake {
    exp: Mutex<i64>,
    embed: Mutex<String>,
    embed_delay_ms: Mutex<u64>,
    /// Playlist maître servie ; None : celle de `video-proxy.test.ts` (sd, hd).
    master: Mutex<Option<String>>,
    master_status: Mutex<u16>,
    calls: Mutex<Vec<Call>>,
    active: Mutex<(usize, usize)>,
    segment_status: Mutex<StatusFn>,
    /// Délai de réponse d'un segment (URL, index).
    seg_delay: Mutex<DelayFn>,
    playlist_status: Mutex<u16>,
    playlist_body: Mutex<Option<String>>,
    mp4_responder: Mutex<Option<Mp4Responder>>,
    segment_responder: Mutex<Option<SegResponder>>,
}

impl Fake {
    fn exp(&self) -> i64 {
        *self.exp.lock().unwrap()
    }
    fn set_embed(&self, html: String) {
        *self.embed.lock().unwrap() = html;
    }
    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    fn seg_calls(&self, name: &str) -> usize {
        let suffix = format!("/{name}");
        self.calls()
            .iter()
            .filter(|c| c.url.ends_with(&suffix))
            .count()
    }
    fn seg_ranges(&self, name: &str) -> Vec<Option<String>> {
        let suffix = format!("/{name}");
        self.calls()
            .into_iter()
            .filter(|c| c.url.ends_with(&suffix))
            .map(|c| c.range)
            .collect()
    }
    /// Index des segments demandés pour une variante (type/2 = sd, type/3 = hd), dans l'ordre.
    fn seg_order(&self, ty: u32) -> Vec<usize> {
        seg_numbers(&self.calls(), ty)
    }
    fn embed_calls(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.url.contains("ok.ru/videoembed/"))
            .count()
    }
    fn playlist_calls(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.url.ends_with("/video/"))
            .count()
    }
    fn master_calls(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.url.contains("video.m3u8"))
            .count()
    }
    fn max_active(&self) -> usize {
        self.active.lock().unwrap().1
    }
}

fn seg_numbers(calls: &[Call], ty: u32) -> Vec<usize> {
    let marker = format!("/type/{ty}/");
    calls
        .iter()
        .filter(|c| c.url.contains(&marker))
        .filter_map(|c| {
            let name = c.url.rsplit('/').next()?;
            name.strip_prefix("MEDIUM")?
                .strip_suffix(".ts")?
                .parse()
                .ok()
        })
        .collect()
}

fn build(status: u16, headers: Vec<(&'static str, String)>, body: Body) -> Response {
    let mut b = Response::builder().status(status);
    for (k, v) in headers {
        b = b.header(k, v);
    }
    b.body(body).unwrap()
}

async fn render(r: R) -> Response {
    match r {
        R::Full(s, h, b) => build(s, h, Body::from(b)),
        R::Stall(h, b) => {
            let s =
                futures_util::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(b)) })
                    .chain(futures_util::stream::pending());
            build(200, h, Body::from_stream(s))
        }
        R::Trickle(s, h, b) => {
            let st = futures_util::stream::unfold(0usize, move |off| {
                let b = b.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    if off >= b.len() {
                        return None;
                    }
                    let end = (off + 50).min(b.len());
                    Some((
                        Ok::<_, std::io::Error>(Bytes::copy_from_slice(&b[off..end])),
                        end,
                    ))
                }
            });
            build(s, h, Body::from_stream(st))
        }
        R::Truncated(h, b) => {
            // Les octets partent d'abord (le temps qu'ils soient écrits), puis la connexion est coupée.
            let s =
                futures_util::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(b)) })
                    .chain(futures_util::stream::once(async {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Err(std::io::Error::other("coupure"))
                    }));
            build(200, h, Body::from_stream(s))
        }
        R::Hang => std::future::pending().await,
        R::StallUntilClosed(h, b, flag) => {
            let guard = OnDrop(flag);
            let s =
                futures_util::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(b)) })
                    .chain(futures_util::stream::unfold(guard, |g| async move {
                        std::future::pending::<()>().await;
                        Some((Ok(Bytes::new()), g))
                    }));
            build(200, h, Body::from_stream(s))
        }
    }
}

fn mp4_response(range: Option<&str>) -> R {
    let parsed = range.and_then(|r| {
        let rest = r.strip_prefix("bytes=")?;
        let (a, b) = rest.split_once('-')?;
        Some((a.parse::<usize>().ok()?, b.to_string()))
    });
    let Some((start, end)) = parsed else {
        return R::Full(
            200,
            vec![
                ("content-type", "video/mp4".into()),
                ("accept-ranges", "bytes".into()),
            ],
            vec![0; MP4_SIZE],
        );
    };
    if start >= MP4_SIZE {
        return R::Full(
            416,
            vec![("content-range", format!("bytes */{MP4_SIZE}"))],
            vec![],
        );
    }
    let end = if end.is_empty() {
        MP4_SIZE - 1
    } else {
        end.parse::<usize>().unwrap().min(MP4_SIZE - 1)
    };
    R::Full(
        206,
        vec![
            ("content-type", "video/mp4".into()),
            ("content-range", format!("bytes {start}-{end}/{MP4_SIZE}")),
        ],
        vec![0; end - start + 1],
    )
}

async fn fake_handler(
    State(f): State<Arc<Fake>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let host = req
        .headers()
        .get(TEST_HOST_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("?")
        .to_string();
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let url = format!(
        "https://{host}{}",
        req.uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
    );
    let n = {
        let mut calls = f.calls.lock().unwrap();
        calls.push(Call {
            url: url.clone(),
            range: range.clone(),
            peer,
        });
        calls.iter().filter(|c| c.url == url).count()
    };
    let r = if url.contains("ok.ru/videoembed/") {
        let d = *f.embed_delay_ms.lock().unwrap();
        if d > 0 {
            tokio::time::sleep(Duration::from_millis(d)).await;
        }
        R::Full(200, vec![], f.embed.lock().unwrap().clone().into_bytes())
    } else if url.contains("video.m3u8") {
        let status = *f.master_status.lock().unwrap();
        if status != 200 {
            R::Full(status, vec![], vec![])
        } else {
            let exp = f.exp();
            let body = f.master.lock().unwrap().clone().unwrap_or_else(|| {
                format!(
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,QUALITY=sd,RESOLUTION=852x480\nhttps://vd123.okcdn.ru/expires/{exp}/type/2/sig/S/video/\n\
                     #EXT-X-STREAM-INF:BANDWIDTH=4600000,QUALITY=hd,RESOLUTION=1280x720\nhttps://vd123.okcdn.ru/expires/{exp}/type/3/sig/S/video/\n"
                )
            });
            R::Full(200, vec![], body.into_bytes())
        }
    } else if url.ends_with("/video/") {
        let status = *f.playlist_status.lock().unwrap();
        if status != 200 {
            R::Full(status, vec![], b"x".to_vec())
        } else {
            let body = f
                .playlist_body
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| media_playlist(SEG_COUNT));
            R::Full(
                200,
                vec![("content-type", "application/x-mpegURL".into())],
                body.into_bytes(),
            )
        }
    } else if let Some(name) = url
        .rsplit_once("/video/")
        .map(|(_, n)| n.to_string())
        .filter(|n| n.starts_with("MEDIUM") && n.ends_with(".ts"))
    {
        let i: usize = name[6..name.len() - 3].parse().unwrap();
        let custom = f
            .segment_responder
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|r| r(&name, n, range.as_deref()));
        if let Some(c) = custom {
            return render(c).await;
        }
        let status = (f.segment_status.lock().unwrap())(&name, n);
        if status != 200 {
            R::Full(status, vec![], b"x".to_vec())
        } else if i >= SEG_COUNT {
            // Au-delà du dernier segment, ok.ru renvoie la playlist (200).
            R::Full(
                200,
                vec![("content-type", "application/x-mpegURL".into())],
                media_playlist(SEG_COUNT).into_bytes(),
            )
        } else {
            {
                let mut a = f.active.lock().unwrap();
                a.0 += 1;
                a.1 = a.1.max(a.0);
            }
            let delay = (f.seg_delay.lock().unwrap())(&url, i);
            tokio::time::sleep(Duration::from_millis(delay)).await;
            f.active.lock().unwrap().0 -= 1;
            if range.is_some() {
                R::Full(
                    206,
                    vec![
                        ("content-type", TS.into()),
                        ("content-range", format!("bytes 0-9/{SEG_SIZE}")),
                    ],
                    seg_bytes(i)[..10].to_vec(),
                )
            } else {
                R::Full(200, ts_headers(None), seg_bytes(i))
            }
        }
    } else if url.contains("okcdn.ru/?expires=") && f.mp4_responder.lock().unwrap().is_some() {
        let g = f.mp4_responder.lock().unwrap();
        (g.as_ref().unwrap())(&url, range.as_deref())
    } else {
        R::Full(404, vec![], b"not found".to_vec())
    };
    render(r).await
}

struct H {
    v: Video,
    db: Db,
    f: Arc<Fake>,
    _dir: tempfile::TempDir,
}

const SCHEMA: &str = "
CREATE TABLE matches (
  id INTEGER PRIMARY KEY, espn_id TEXT UNIQUE NOT NULL, league TEXT NOT NULL DEFAULT 'nba', season INTEGER NOT NULL,
  season_type TEXT NOT NULL, date_utc TEXT NOT NULL, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, home_score INTEGER, away_score INTEGER, status TEXT NOT NULL,
  status_detail TEXT DEFAULT '', period INTEGER DEFAULT 0, clock_display TEXT DEFAULT '', venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '', slug TEXT, video_ok_id TEXT, video_duration INTEGER, video_available INTEGER DEFAULT 0,
  video_checked_at TEXT, stats_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, video_kind TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT 'x', last_login_at TEXT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
";

async fn harness(env: &[(&str, &str)]) -> H {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    // Replay WNBA : le proxy sert toute ligue (`leagueAny`).
    c.execute(
        "INSERT INTO matches (espn_id, league, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status,
           video_ok_id, video_available, video_kind, created_at, updated_at)
         VALUES ('401', 'wnba', 2026, 'regular', '2026-10-29T02:30:00Z', 'LAC', 'LA Clippers', 'LAL', 'Los Angeles Lakers', 'final',
           ?1, 1, 'mp4', 'x', 'x')",
        [OK_ID],
    )
    .unwrap();
    c.execute(
        "INSERT INTO matches (espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status,
           video_ok_id, video_available, created_at, updated_at)
         VALUES ('402', 2026, 'regular', '2026-10-29T02:30:00Z', 'LAC', 'x', 'LAL', 'y', 'final', '99999999999', 0, 'x', 'x')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO users (id, username, password_hash) VALUES (1, 'michel', 'x')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sessions VALUES (?1, 1, 'x', '2999-01-01T00:00:00.000Z')",
        [basketland_server::auth::hash_token("jeton")],
    )
    .unwrap();
    drop(c);

    let exp = now_ms() + 24 * 3_600_000;
    let f = Arc::new(Fake {
        exp: Mutex::new(exp),
        embed: Mutex::new(embed_html(
            Some(&signed_master(exp)),
            &[("sd", signed_mp4("sd", exp, "vd123.okcdn.ru"), false)],
            false,
        )),
        embed_delay_ms: Mutex::new(0),
        master: Mutex::new(None),
        master_status: Mutex::new(200),
        calls: Mutex::new(Vec::new()),
        active: Mutex::new((0, 0)),
        segment_status: Mutex::new(Box::new(|_, _| 200)),
        seg_delay: Mutex::new(Box::new(|_, _| 5)),
        playlist_status: Mutex::new(200),
        playlist_body: Mutex::new(None),
        mp4_responder: Mutex::new(None),
        segment_responder: Mutex::new(None),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .fallback(fake_handler)
        .with_state(f.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let v = Video::for_tests(TestConfig {
        upstream: Some(format!("http://{addr}")),
        env: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    });
    H {
        v,
        db: Db::new(path),
        f,
        _dir: dir,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn body(r: Response) -> Result<Vec<u8>, String> {
    r.into_body()
        .collect()
        .await
        .map(|b| b.to_bytes().to_vec())
        .map_err(|e| e.to_string())
}

fn hdr(r: &Response, name: &str) -> Option<String> {
    r.headers()
        .get(name)
        .map(|v| v.to_str().unwrap().to_string())
}

impl H {
    async fn seg(&self, key: &str, s: &str) -> Result<Response, VErr> {
        self.v
            .segment(&self.db, OK_ID, Some(key), Some(s), None)
            .await
    }
    async fn seg_body(&self, key: &str, s: &str) -> Vec<u8> {
        body(self.seg(key, s).await.unwrap()).await.unwrap()
    }
    async fn media(&self, key: &str) -> String {
        self.v.media(&self.db, OK_ID, Some(key)).await.unwrap()
    }
    async fn mp4(&self, range: Option<&str>) -> Result<Response, VErr> {
        self.v.mp4(&self.db, OK_ID, range).await
    }
    fn set_clock(&self, target_ms: i64) {
        self.v.advance_clock(target_ms - self.v.now_ms() as i64);
    }
    fn window(&self) -> usize {
        self.v.prefetch_window(6.0) as usize
    }
    fn concurrency(&self) -> usize {
        self.v.prefetch_settings().1
    }
}

/// Attend qu'une condition devienne vraie (au plus 5 s).
async fn eventually(mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "condition jamais remplie"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

// ------------------------------------------------------------------ segments : cache + préchargement

#[tokio::test]
async fn sert_le_segment_puis_precharge_90_s() {
    let h = harness(&[]).await;
    let r = h.seg("sd", "MEDIUM00003.ts").await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("video/mp2t"));
    assert_eq!(
        hdr(&r, "cache-control").as_deref(),
        Some("public, max-age=3600")
    );
    assert_eq!(hdr(&r, "accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(hdr(&r, "access-control-allow-origin").as_deref(), Some("*"));
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("1000"));
    assert_eq!(body(r).await.unwrap(), seg_bytes(3));
    h.v.prefetch_idle().await;
    let w = h.window();
    assert_eq!(w, 15);
    // La playlist (lue au passage) donne la durée des segments et borne la fenêtre.
    for n in 4..=3 + w {
        assert_eq!(h.f.seg_calls(&seg(n)), 1, "{n}");
    }
    assert_eq!(h.f.seg_calls(&seg(4 + w)), 0);
    // Concurrence bornée : la requête du lecteur + PREFETCH_CONCURRENCY préchargements.
    assert!(h.f.max_active() <= 1 + h.concurrency());

    // Le suivant vient du cache, avec sa taille.
    let r2 = h.seg("sd", "MEDIUM00004.ts").await.unwrap();
    assert_eq!(hdr(&r2, "content-length").as_deref(), Some("1000"));
    assert_eq!(body(r2).await.unwrap(), seg_bytes(4));
    assert_eq!(h.f.seg_calls("MEDIUM00004.ts"), 1);
    // La fenêtre avance d'un segment avec le lecteur.
    h.v.prefetch_idle().await;
    assert_eq!(h.f.seg_calls(&seg(4 + w)), 1);
    assert_eq!(h.f.seg_calls(&seg(5 + w)), 0);
}

#[tokio::test]
async fn precharge_du_plus_proche_au_plus_lointain() {
    let h = harness(&[]).await;
    h.media("sd").await;
    h.seg_body("sd", &seg(10)).await;
    h.v.prefetch_idle().await;
    let order = h.f.seg_order(2);
    assert_eq!(order[0], 10);
    assert_eq!(
        order[1..].to_vec(),
        (11..11 + h.window()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn apres_un_saut_la_nouvelle_position_passe_devant() {
    let h = harness(&[]).await;
    // Les préchargements 3, 4, 5 durent assez pour que le saut arrive pendant qu'ils sont en vol.
    *h.f.seg_delay.lock().unwrap() = Box::new(|_, i| if (3..=5).contains(&i) { 150 } else { 5 });
    h.media("sd").await;
    h.seg_body("sd", &seg(2)).await; // 3, 4, 5 en vol
    let before = h.f.calls().len();
    h.seg_body("sd", &seg(25)).await; // saut
    h.v.prefetch_idle().await;
    let after: Vec<usize> = seg_numbers(&h.f.calls()[before..], 2)
        .into_iter()
        .filter(|n| *n != 25)
        .collect();
    assert_eq!(after[..3].to_vec(), vec![26, 27, 28]);
    for n in 26..SEG_COUNT {
        assert_eq!(h.f.seg_calls(&seg(n)), 1, "{n}");
    }
}

#[tokio::test]
async fn changement_de_qualite_le_prechargement_suit() {
    let h = harness(&[]).await;
    // Les préchargements hd sont encore en vol quand le lecteur passe en sd
    // (côté Node, la vérification en base est synchrone : la bascule arrive
    // avant leur fin ; ici elle passe par un fil de la base).
    *h.f.seg_delay.lock().unwrap() = Box::new(|url, i| {
        if url.contains("/type/3/") && i > 3 {
            150
        } else {
            5
        }
    });
    h.media("hd").await;
    h.media("sd").await;
    let r_hd = h.seg("hd", &seg(3)).await.unwrap(); // hd 4, 5, 6 partent
    let r_sd = h.seg("sd", &seg(4)).await.unwrap(); // l'ABR descend en sd
    assert_eq!(body(r_hd).await.unwrap(), seg_bytes(3));
    assert_eq!(body(r_sd).await.unwrap(), seg_bytes(4));
    h.v.prefetch_idle().await;
    let hd = h.f.seg_order(3);
    assert!(hd.len() <= 1 + h.concurrency(), "{hd:?}");
    let sd = h.f.seg_order(2);
    for n in 5..=4 + h.window() {
        assert!(sd.contains(&n), "{n}");
    }
}

#[tokio::test]
async fn cache_plein_les_segments_lus_partent_avant_ceux_a_venir() {
    // 12 segments de cache, dont 60 % (7) pour l'avance : le lecteur lit 0 → 24 à la suite.
    let mb = (12 * SEG_SIZE) as f64 / (1024.0 * 1024.0);
    let h = harness(&[("SEGMENT_CACHE_MB", &mb.to_string())]).await;
    assert_eq!(h.v.segment_cache_stats().1, (12 * SEG_SIZE) as u64);
    h.media("sd").await;
    for i in 0..25 {
        let prefetched = h.f.seg_calls(&seg(i)) == 1;
        assert_eq!(h.seg_body("sd", &seg(i)).await, seg_bytes(i));
        // Servi depuis le cache : préchargé, et toujours là au moment d'être lu.
        if i >= 1 {
            assert!(prefetched, "{i}");
        }
        assert_eq!(h.f.seg_calls(&seg(i)), 1, "{i}");
        h.v.prefetch_idle().await;
        assert!(h.v.segment_cache_stats().0 <= (12 * SEG_SIZE) as u64);
    }
    // L'avance est bornée par le budget du cache (7 segments), pas par la fenêtre (15).
    assert_eq!(h.f.seg_calls(&seg(24 + 7)), 1);
    assert_eq!(h.f.seg_calls(&seg(24 + 8)), 0);
}

#[tokio::test]
async fn deux_lecteurs_un_seul_appel_amont() {
    let h = harness(&[]).await;
    let (a, b) = tokio::join!(h.seg("sd", "MEDIUM00000.ts"), h.seg("sd", "MEDIUM00000.ts"));
    assert_eq!(body(a.unwrap()).await.unwrap(), seg_bytes(0));
    assert_eq!(body(b.unwrap()).await.unwrap(), seg_bytes(0));
    assert_eq!(h.f.seg_calls("MEDIUM00000.ts"), 1);
}

#[tokio::test]
async fn une_requete_pendant_le_prechargement_le_rejoint() {
    let h = harness(&[]).await;
    h.seg_body("sd", "MEDIUM00000.ts").await;
    assert_eq!(h.seg_body("sd", "MEDIUM00001.ts").await, seg_bytes(1));
    assert_eq!(h.f.seg_calls("MEDIUM00001.ts"), 1);
}

#[tokio::test]
async fn le_prechargement_s_arrete_au_dernier_segment() {
    let h = harness(&[]).await;
    h.media("sd").await;
    h.seg_body("sd", &seg(SEG_COUNT - 2)).await;
    h.v.prefetch_idle().await;
    assert_eq!(h.f.seg_calls(&seg(SEG_COUNT - 1)), 1);
    assert_eq!(h.f.seg_calls(&seg(SEG_COUNT)), 0);
}

#[tokio::test]
async fn reponse_playlist_au_dela_de_la_fin_jamais_mise_en_cache() {
    let h = harness(&[]).await;
    h.seg_body("sd", &seg(SEG_COUNT - 1)).await;
    h.v.prefetch_idle().await;
    let e = h.seg("sd", &seg(SEG_COUNT)).await.unwrap_err();
    assert_eq!(e, VErr::proxy(404, "segment introuvable"));
}

#[tokio::test]
async fn range_relais_direct_sans_cache() {
    let h = harness(&[]).await;
    let r =
        h.v.segment(
            &h.db,
            OK_ID,
            Some("sd"),
            Some("MEDIUM00002.ts"),
            Some("bytes=0-9"),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(hdr(&r, "content-range").as_deref(), Some("bytes 0-9/1000"));
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("10"));
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("video/mp2t"));
    assert_eq!(body(r).await.unwrap(), seg_bytes(2)[..10].to_vec());
    assert_eq!(
        h.f.seg_ranges("MEDIUM00002.ts"),
        vec![Some("bytes=0-9".into())]
    );
}

#[tokio::test]
async fn signature_expiree_une_re_resolution_puis_succes() {
    let h = harness(&[]).await;
    h.media("sd").await;
    h.v.advance_clock(60_000);
    *h.f.segment_status.lock().unwrap() = Box::new(|name, n| {
        if name == "MEDIUM00005.ts" && n == 1 {
            403
        } else {
            200
        }
    });
    let before = h.f.embed_calls();
    assert_eq!(h.seg_body("sd", "MEDIUM00005.ts").await, seg_bytes(5));
    assert_eq!(h.f.embed_calls(), before + 1);
}

#[tokio::test]
async fn flux_en_cache_sans_hls_re_resolution_au_lieu_d_un_404() {
    let h = harness(&[]).await;
    let exp = h.f.exp();
    h.f.set_embed(embed_html(
        None,
        &[("sd", signed_mp4("sd", exp, "vd123.okcdn.ru"), false)],
        false,
    ));
    let e = h.v.master(&h.db, OK_ID).await.unwrap_err();
    assert_eq!(e, VErr::proxy(404, "pas de flux HLS (MP4 seul)"));
    h.f.set_embed(embed_html(
        Some(&signed_master(exp)),
        &[("sd", signed_mp4("sd", exp, "vd123.okcdn.ru"), false)],
        false,
    ));
    h.v.advance_clock(15_000);
    assert_eq!(h.seg_body("sd", "MEDIUM00001.ts").await, seg_bytes(1));
}

#[tokio::test]
async fn refuse_un_nom_de_segment_qui_n_est_pas_un_fichier_ts() {
    let h = harness(&[]).await;
    for s in ["../x.ts", "https://evil/x.ts"] {
        let e = h.seg("sd", s).await.unwrap_err();
        assert_eq!(e, VErr::proxy(400, format!("nom de segment invalide: {s}")));
    }
    let e =
        h.v.segment(&h.db, OK_ID, Some("sd"), None, None)
            .await
            .unwrap_err();
    assert_eq!(e, VErr::proxy(400, "paramètre s manquant"));
}

#[tokio::test]
async fn refuse_une_cle_de_variante_mal_formee() {
    let h = harness(&[]).await;
    let e = h.seg("sd|x", &seg(1)).await.unwrap_err();
    assert_eq!(e, VErr::proxy(404, "variante inconnue: sd|x"));
    let e =
        h.v.segment(&h.db, OK_ID, None, Some(&seg(1)), None)
            .await
            .unwrap_err();
    assert_eq!(e, VErr::proxy(404, "variante inconnue: null"));
    assert_eq!(h.f.calls().len(), 0);
}

#[tokio::test]
async fn playlist_illisible_la_fin_est_apprise_du_premier_segment_introuvable() {
    let h = harness(&[]).await;
    *h.f.playlist_status.lock().unwrap() = 500;
    h.seg_body("sd", &seg(SEG_COUNT - 3)).await;
    h.v.prefetch_idle().await;
    // Sans playlist, le préchargement avance à l'aveugle puis s'arrête à la fin :
    // au plus un appel par place de préchargement au-delà, jamais répété.
    let beyond: Vec<usize> =
        h.f.seg_order(2)
            .into_iter()
            .filter(|n| *n >= SEG_COUNT)
            .collect();
    assert!(beyond.len() <= h.concurrency(), "{beyond:?}");
    let uniq: std::collections::HashSet<_> = beyond.iter().collect();
    assert_eq!(uniq.len(), beyond.len());
    for n in SEG_COUNT - 2..SEG_COUNT {
        assert_eq!(h.f.seg_calls(&seg(n)), 1, "{n}");
    }
}

// ------------------------------------------------------------------ téléchargement surveillé

const STALL: [(&str, &str); 1] = [("SEGMENT_STALL_MS", "200")];

#[tokio::test]
async fn flux_bloque_coupe_puis_repris_a_l_octet_atteint() {
    let h = harness(&STALL).await;
    let full = patterned(42);
    let f2 = full.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, _| {
        if name != seg(2) {
            return None;
        }
        Some(if n == 1 {
            R::Stall(ts_headers(Some(SEG_SIZE)), f2[..400].to_vec())
        } else {
            R::Full(
                206,
                vec![
                    ("content-type", TS.into()),
                    ("content-range", format!("bytes 400-999/{SEG_SIZE}")),
                ],
                f2[400..].to_vec(),
            )
        })
    }));
    let r = h.seg("sd", &seg(2)).await.unwrap();
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("1000"));
    assert_eq!(body(r).await.unwrap(), full);
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=400-".into())]
    );
    let re = regex::Regex::new(r"^\[vidéo\] flux ok\.ru aucun octet depuis 0\.2 s : reprise n° 1 à 0/1 Ko sur une connexion neuve — sd MEDIUM00002\.ts$").unwrap();
    assert!(
        h.v.logs().iter().any(|l| re.is_match(l)),
        "{:?}",
        h.v.logs()
    );
    // Rangé complet au cache : la demande suivante ne repasse pas par ok.ru.
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(h.f.seg_ranges(&seg(2)).len(), 2);
}

#[tokio::test]
async fn amont_qui_ignore_range_a_la_reprise() {
    let h = harness(&STALL).await;
    let full = patterned(42);
    let f2 = full.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, _| {
        if name != seg(2) {
            return None;
        }
        Some(if n == 1 {
            R::Stall(ts_headers(Some(SEG_SIZE)), f2[..300].to_vec())
        } else {
            R::Full(200, ts_headers(Some(SEG_SIZE)), f2.clone())
        })
    }));
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=300-".into())]
    );
}

#[tokio::test]
async fn connexion_coupee_avant_la_fin_reprise() {
    let h = harness(&STALL).await;
    let full = patterned(42);
    let f2 = full.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, _| {
        if name != seg(2) {
            return None;
        }
        Some(if n == 1 {
            R::Truncated(ts_headers(Some(SEG_SIZE)), f2[..700].to_vec())
        } else {
            R::Full(
                206,
                vec![
                    ("content-type", TS.into()),
                    ("content-range", format!("bytes 700-999/{SEG_SIZE}")),
                ],
                f2[700..].to_vec(),
            )
        })
    }));
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=700-".into())]
    );
}

#[tokio::test]
async fn connexion_degradee_une_seule_reprise() {
    let h = harness(&STALL).await;
    // Segments de 0,2 s : au-delà de 2,5 × 0,2 s prévus, la connexion est jugée trop lente.
    let mut pl = vec!["#EXTM3U".to_string(), "#EXT-X-TARGETDURATION:1".into()];
    for i in 0..SEG_COUNT {
        pl.push(format!("#EXTINF:0.2,\n{}", seg(i)));
    }
    pl.push("#EXT-X-ENDLIST".into());
    pl.push(String::new());
    *h.f.playlist_body.lock().unwrap() = Some(pl.join("\n"));
    h.media("sd").await;
    let full = patterned(42);
    let f2 = full.clone();
    // Les deux connexions traînent (~1 Ko/s) : la seconde n'est pas relancée à son tour.
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, range| {
        if name != seg(2) {
            return None;
        }
        Some(if n == 1 {
            R::Trickle(200, ts_headers(Some(SEG_SIZE)), f2.clone())
        } else {
            let from: usize = range
                .unwrap()
                .strip_prefix("bytes=")
                .unwrap()
                .trim_end_matches('-')
                .parse()
                .unwrap();
            R::Trickle(
                206,
                vec![
                    ("content-type", TS.into()),
                    ("content-range", format!("bytes {from}-999/{SEG_SIZE}")),
                ],
                f2[from..].to_vec(),
            )
        })
    }));
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    let ranges = h.f.seg_ranges(&seg(2));
    assert_eq!(ranges.len(), 2);
    assert!(regex::Regex::new(r"^bytes=[0-9]+-$")
        .unwrap()
        .is_match(ranges[1].as_deref().unwrap()));
    let re = regex::Regex::new(r"\[vidéo\] flux ok\.ru trop lent \([0-9]+ kb/s\) : reprise n° 1")
        .unwrap();
    assert!(
        h.v.logs().iter().any(|l| re.is_match(l)),
        "{:?}",
        h.v.logs()
    );
}

#[tokio::test]
async fn en_tetes_qui_n_arrivent_jamais_nouvelle_requete_apres_le_delai() {
    let h = harness(&STALL).await;
    let full = patterned(42);
    let f2 = full.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, _| {
        if name != seg(2) {
            return None;
        }
        Some(if n == 1 {
            R::Hang
        } else {
            R::Full(200, ts_headers(Some(SEG_SIZE)), f2.clone())
        })
    }));
    let t0 = Instant::now();
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(h.f.seg_ranges(&seg(2)), vec![None, None]);
    // ~1,6 × SEGMENT_STALL_MS (320 ms) + pause de 300 ms, bien loin des 60 s d'avant.
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert!(t0.elapsed() >= Duration::from_millis(600));
}

#[tokio::test]
async fn signature_expiree_au_moment_de_la_reprise() {
    let h = harness(&STALL).await;
    h.media("sd").await;
    h.v.advance_clock(60_000);
    let full = patterned(42);
    let f2 = full.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, n, _| {
        if name != seg(2) {
            return None;
        }
        Some(match n {
            1 => R::Stall(ts_headers(Some(SEG_SIZE)), f2[..500].to_vec()),
            2 => R::Full(403, vec![], b"expired".to_vec()),
            _ => R::Full(
                206,
                vec![
                    ("content-type", TS.into()),
                    ("content-range", format!("bytes 500-999/{SEG_SIZE}")),
                ],
                f2[500..].to_vec(),
            ),
        })
    }));
    let before = h.f.embed_calls();
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(h.f.embed_calls(), before + 1);
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=500-".into()), Some("bytes=500-".into())]
    );
}

#[tokio::test]
async fn blocages_repetes_abandon_puis_nouvelle_demande_depuis_zero() {
    let h = harness(&[("SEGMENT_STALL_MS", "200"), ("SEGMENT_RETRIES", "1")]).await;
    let full = patterned(42);
    let f2 = full.clone();
    let healthy = Arc::new(AtomicBool::new(false));
    let h2 = healthy.clone();
    *h.f.segment_responder.lock().unwrap() = Some(Box::new(move |name, _, _| {
        if name != seg(2) {
            return None;
        }
        Some(if h2.load(Ordering::SeqCst) {
            R::Full(200, ts_headers(Some(SEG_SIZE)), f2.clone())
        } else {
            R::Stall(ts_headers(Some(SEG_SIZE)), f2[..100].to_vec())
        })
    }));
    let r = h.seg("sd", &seg(2)).await.unwrap();
    assert!(body(r).await.is_err(), "corps interrompu");
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=100-".into())]
    );
    let re = regex::Regex::new(r"^\[vidéo\] segment abandonné après 1 reprise\(s\) : aucun octet depuis 0\.2 s \(100/1000 octets\) — sd MEDIUM00002\.ts$").unwrap();
    assert!(
        h.v.logs().iter().any(|l| re.is_match(l)),
        "{:?}",
        h.v.logs()
    );
    h.v.prefetch_idle().await;
    healthy.store(true, Ordering::SeqCst);
    assert_eq!(h.seg_body("sd", &seg(2)).await, full);
    assert_eq!(
        h.f.seg_ranges(&seg(2)),
        vec![None, Some("bytes=100-".into()), None]
    );
}

#[tokio::test]
async fn connexions_persistantes_vers_ok_ru() {
    // Sans préchargement : deux segments à la suite passent par la même connexion.
    let h = harness(&[("PREFETCH_AHEAD_SEC", "0")]).await;
    h.seg_body("sd", &seg(1)).await;
    h.seg_body("sd", &seg(2)).await;
    let peers: Vec<SocketAddr> =
        h.f.calls()
            .into_iter()
            .filter(|c| c.url.ends_with(".ts"))
            .map(|c| c.peer)
            .collect();
    assert_eq!(peers.len(), 2);
    assert_eq!(peers[0], peers[1]);
}

// ------------------------------------------------------------------ playlists

#[tokio::test]
async fn playlist_media_une_seule_lecture_amont() {
    let h = harness(&[]).await;
    let (a, b) = tokio::join!(h.media("sd"), h.media("sd"));
    let c = h.media("sd").await;
    assert_eq!(a, b);
    assert_eq!(c, a);
    assert!(a.contains(&format!(
        "/api/video/{OK_ID}/segment.ts?v=sd&s=MEDIUM00000.ts"
    )));
    assert_eq!(
        a,
        basketland_server::hls::rewrite_media_playlist(&media_playlist(SEG_COUNT), OK_ID, "sd")
    );
    assert_eq!(h.f.playlist_calls(), 1);
}

#[tokio::test]
async fn playlist_media_signature_expiree_une_re_resolution() {
    let h = harness(&[]).await;
    *h.f.playlist_status.lock().unwrap() = 403;
    let e = h.v.media(&h.db, OK_ID, Some("sd")).await.unwrap_err();
    assert_eq!(e, VErr::proxy(502, "amont HTTP 403"));
    assert_eq!(h.f.playlist_calls(), 2);
    let e = h.v.media(&h.db, OK_ID, Some("xx")).await.unwrap_err();
    assert_eq!(e, VErr::proxy(404, "variante inconnue: xx"));
}

#[tokio::test]
async fn master_reecrit_et_mp4_seul() {
    let h = harness(&[]).await;
    let m = h.v.master(&h.db, OK_ID).await.unwrap();
    assert_eq!(
        m,
        format!("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,QUALITY=sd,RESOLUTION=852x480\n/api/video/{OK_ID}/playlist.m3u8?v=sd\n#EXT-X-STREAM-INF:BANDWIDTH=4600000,QUALITY=hd,RESOLUTION=1280x720\n/api/video/{OK_ID}/playlist.m3u8?v=hd\n")
    );
    let h = harness(&[]).await;
    let exp = h.f.exp();
    h.f.set_embed(embed_html(
        None,
        &[("mobile", signed_mp4("mobile", exp, "vd123.okcdn.ru"), false)],
        false,
    ));
    let e = h.v.master(&h.db, OK_ID).await.unwrap_err();
    assert_eq!(e.http_status(), 404);
}

#[tokio::test]
async fn okid_invalide_ou_inconnu() {
    let h = harness(&[]).await;
    assert_eq!(
        h.v.master(&h.db, "abc").await.unwrap_err(),
        VErr::proxy(400, "okId invalide")
    );
    assert_eq!(
        h.v.master(&h.db, "12345678901").await.unwrap_err(),
        VErr::proxy(404, "replay inconnu")
    );
    // Connu mais sans vidéo disponible.
    assert_eq!(
        h.v.master(&h.db, "99999999999").await.unwrap_err(),
        VErr::proxy(404, "replay inconnu")
    );
    assert_eq!(h.f.calls().len(), 0);
}

// ------------------------------------------------------------------ ressources annexes

#[tokio::test]
async fn ressource_annexe_relayee_depuis_le_dossier_de_la_variante() {
    let h = harness(&[]).await;
    *h.f.segment_responder.lock().unwrap() = None;
    let a = h.v.asset(&h.db, OK_ID, Some("sd"), Some("key.bin")).await;
    // Le faux ok.ru ne connaît pas ce fichier : 404 amont → 502.
    assert_eq!(a.unwrap_err(), VErr::proxy(502, "amont HTTP 404"));
    let call =
        h.f.calls()
            .into_iter()
            .find(|c| c.url.ends_with("key.bin"))
            .unwrap();
    assert_eq!(
        call.url,
        format!(
            "https://vd123.okcdn.ru/expires/{}/type/2/sig/S/video/key.bin",
            h.f.exp()
        )
    );
    for (a, e) in [
        (None, VErr::proxy(400, "paramètre a manquant")),
        (
            Some("../k.bin"),
            VErr::proxy(400, "nom de ressource invalide"),
        ),
        (Some("k"), VErr::proxy(400, "nom de ressource invalide")),
    ] {
        assert_eq!(h.v.asset(&h.db, OK_ID, Some("sd"), a).await.unwrap_err(), e);
    }
    // ok.ru répond par la playlist pour un nom inconnu : 404.
    let e =
        h.v.asset(&h.db, OK_ID, Some("sd"), Some("MEDIUM00099.ts"))
            .await
            .unwrap_err();
    assert_eq!(e, VErr::proxy(404, "ressource introuvable"));
    let r =
        h.v.asset(&h.db, OK_ID, Some("sd"), Some("MEDIUM00001.ts"))
            .await
            .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("video/mp2t"));
    assert_eq!(
        hdr(&r, "cache-control").as_deref(),
        Some("public, max-age=3600")
    );
    assert_eq!(body(r).await.unwrap(), seg_bytes(1));
}

// ------------------------------------------------------------------ MP4 progressif

/// Relais direct du MP4 (une connexion, `MP4_PROXY_CACHE=0`) ; le relais par
/// blocs est testé par `mp4_blocs_*`.
async fn mp4_harness() -> H {
    mp4_harness_env(&[("MP4_PROXY_CACHE", "0")]).await
}

async fn mp4_harness_env(env: &[(&str, &str)]) -> H {
    let h = harness(env).await;
    let exp = h.f.exp();
    h.f.set_embed(embed_html(
        None,
        &[
            ("mobile", signed_mp4("mobile", exp, "vd123.okcdn.ru"), false),
            ("sd", signed_mp4("sd", exp, "vd123.okcdn.ru"), false),
            ("hd", signed_mp4("hd", exp, "vd123.okcdn.ru"), true),
        ],
        false,
    ));
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(|_, range| mp4_response(range)));
    h
}

fn mp4_call(h: &H) -> Option<Call> {
    h.f.calls()
        .into_iter()
        .find(|c| c.url.contains("?expires="))
}

#[tokio::test]
async fn mp4_range_206_meilleure_qualite_permise() {
    let h = mp4_harness().await;
    let r = h.mp4(Some("bytes=100-199")).await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(
        hdr(&r, "content-range").as_deref(),
        Some("bytes 100-199/5000")
    );
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("100"));
    assert_eq!(hdr(&r, "accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("video/mp4"));
    assert_eq!(hdr(&r, "cache-control").as_deref(), Some("no-store"));
    assert_eq!(body(r).await.unwrap().len(), 100);
    let up = mp4_call(&h).unwrap();
    assert_eq!(up.url, signed_mp4("sd", h.f.exp(), "vd123.okcdn.ru")); // hd disallowed, sd > mobile
    assert_eq!(up.range.as_deref(), Some("bytes=100-199"));
}

#[tokio::test]
async fn mp4_sans_range_200_complet() {
    let h = mp4_harness().await;
    let r = h.mp4(None).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("5000"));
    assert_eq!(body(r).await.unwrap().len(), MP4_SIZE);
    assert_eq!(mp4_call(&h).unwrap().range, None);
}

#[tokio::test]
async fn mp4_416_relaye() {
    let h = mp4_harness().await;
    let r = h.mp4(Some("bytes=5000-")).await.unwrap();
    assert_eq!(r.status(), 416);
    assert_eq!(hdr(&r, "content-range").as_deref(), Some("bytes */5000"));
    assert_eq!(hdr(&r, "access-control-allow-origin").as_deref(), Some("*"));
}

#[tokio::test]
async fn mp4_range_malforme_ignore() {
    let h = mp4_harness().await;
    let r = h.mp4(Some("items=0-1")).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(mp4_call(&h).unwrap().range, None);
}

#[tokio::test]
async fn mp4_403_re_resolution_puis_succes() {
    let h = mp4_harness().await;
    body(h.mp4(Some("bytes=0-9")).await.unwrap()).await.unwrap();
    h.v.advance_clock(60_000);
    let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(move |_, range| {
        if n2.fetch_add(1, Ordering::SeqCst) == 0 {
            R::Full(403, vec![], b"expired".to_vec())
        } else {
            mp4_response(range)
        }
    }));
    let before = h.f.embed_calls();
    let r = h.mp4(Some("bytes=0-9")).await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(h.f.embed_calls(), before + 1);
}

// ------------------------------------------------------------------ MP4 par blocs (défaut)

fn mp4_calls(h: &H) -> Vec<Call> {
    h.f.calls()
        .into_iter()
        .filter(|c| c.url.contains("?expires="))
        .collect()
}

#[tokio::test]
async fn mp4_blocs_plage_servie_depuis_un_bloc_aligne_puis_le_cache() {
    let h = mp4_harness_env(&[]).await;
    let r = h.mp4(Some("bytes=100-199")).await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(
        hdr(&r, "content-range").as_deref(),
        Some("bytes 100-199/5000")
    );
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("100"));
    assert_eq!(hdr(&r, "accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("video/mp4"));
    assert_eq!(hdr(&r, "cache-control").as_deref(), Some("no-store"));
    assert_eq!(body(r).await.unwrap().len(), 100);
    // Un bloc entier demandé à ok.ru, dans la meilleure qualité permise.
    let calls = mp4_calls(&h);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].url, signed_mp4("sd", h.f.exp(), "vd123.okcdn.ru"));
    assert_eq!(calls[0].range.as_deref(), Some("bytes=0-2097151"));

    // Autre plage du même bloc, puis le fichier entier : depuis le cache.
    let r = h.mp4(Some("bytes=0-9")).await.unwrap();
    assert_eq!(body(r).await.unwrap().len(), 10);
    let r = h.mp4(None).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(hdr(&r, "content-length").as_deref(), Some("5000"));
    assert_eq!(body(r).await.unwrap().len(), MP4_SIZE);
    assert_eq!(mp4_calls(&h).len(), 1, "aucune nouvelle requête amont");

    // Au-delà de la fin : 416.
    let r = h.mp4(Some("bytes=5000-")).await.unwrap();
    assert_eq!(r.status(), 416);
    assert_eq!(hdr(&r, "content-range").as_deref(), Some("bytes */5000"));
}

#[tokio::test]
async fn mp4_blocs_lien_expire_re_resolu() {
    let h = mp4_harness_env(&[]).await;
    let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(move |_, range| {
        if n2.fetch_add(1, Ordering::SeqCst) == 0 {
            R::Full(403, vec![], b"expired".to_vec())
        } else {
            mp4_response(range)
        }
    }));
    let before = h.f.embed_calls();
    let r = h.mp4(Some("bytes=0-9")).await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(body(r).await.unwrap().len(), 10);
    assert!(h.f.embed_calls() > before, "flux re-résolu");
}

#[tokio::test]
async fn mp4_blocs_redirection_vers_un_hote_non_autorise_refusee() {
    let h = mp4_harness_env(&[]).await;
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(|url, _| {
        if url.contains("evil") {
            mp4_response(None)
        } else {
            R::Full(
                302,
                vec![("location", "https://evil.example/x.mp4".into())],
                vec![],
            )
        }
    }));
    let e = h.mp4(Some("bytes=0-9")).await.unwrap_err();
    assert_eq!(e.http_status(), 502);
    assert!(!h.f.calls().iter().any(|c| c.url.contains("evil.example")));
}

#[tokio::test]
async fn mp4_redirection_vers_un_hote_non_autorise_refusee() {
    let h = mp4_harness().await;
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(|url, _| {
        if url.contains("evil") {
            mp4_response(None)
        } else {
            R::Full(
                302,
                vec![("location", "https://evil.example/x.mp4".into())],
                vec![],
            )
        }
    }));
    let e = h.mp4(Some("bytes=0-9")).await.unwrap_err();
    assert_eq!(e, VErr::proxy(502, "redirection refusée"));
    assert!(!h.f.calls().iter().any(|c| c.url.contains("evil.example")));
}

#[tokio::test]
async fn mp4_redirection_vers_un_hote_ok_ru_suivie_range_conserve() {
    let h = mp4_harness().await;
    let exp = h.f.exp();
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(move |url, range| {
        if url.contains("vd999") {
            mp4_response(range)
        } else {
            R::Full(
                302,
                vec![("location", signed_mp4("sd", exp, "vd999.okcdn.ru"))],
                vec![],
            )
        }
    }));
    let r = h.mp4(Some("bytes=0-9")).await.unwrap();
    assert_eq!(r.status(), 206);
    let c =
        h.f.calls()
            .into_iter()
            .find(|c| c.url.contains("vd999"))
            .unwrap();
    assert_eq!(c.range.as_deref(), Some("bytes=0-9"));
}

#[tokio::test]
async fn mp4_qualite_epinglee_pendant_la_lecture() {
    let h = mp4_harness().await;
    body(h.mp4(Some("bytes=0-9")).await.unwrap()).await.unwrap();
    let exp = h.f.exp();
    h.f.set_embed(embed_html(
        None,
        &[
            ("sd", signed_mp4("sd", exp, "vd123.okcdn.ru"), false),
            ("full", signed_mp4("full", exp, "vd123.okcdn.ru"), false),
        ],
        false,
    ));
    h.v.clear_stream_cache();
    h.f.calls.lock().unwrap().clear();
    body(h.mp4(Some("bytes=10-19")).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        mp4_call(&h).unwrap().url,
        signed_mp4("sd", exp, "vd123.okcdn.ru")
    );
}

#[tokio::test]
async fn mp4_okid_inconnu_404_sans_appel_amont() {
    let h = mp4_harness().await;
    let e =
        h.v.mp4(&h.db, "12345678901", Some("bytes=0-1"))
            .await
            .unwrap_err();
    assert_eq!(e.status, Some(404));
    assert_eq!(h.f.calls().len(), 0);
}

#[tokio::test]
async fn mp4_client_parti_telechargement_amont_coupe() {
    let h = mp4_harness().await;
    let closed = Arc::new(AtomicBool::new(false));
    let c2 = closed.clone();
    // Corps sans fin : il ne s'arrête que si le proxy coupe la connexion.
    *h.f.mp4_responder.lock().unwrap() = Some(Box::new(move |_, _| {
        R::StallUntilClosed(
            vec![("content-type", "video/mp4".into())],
            vec![1; 100],
            c2.clone(),
        )
    }));
    let r = h.mp4(None).await.unwrap();
    assert_eq!(r.status(), 200);
    let mut b = r.into_body().into_data_stream();
    assert_eq!(b.next().await.unwrap().unwrap().len(), 100);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!closed.load(Ordering::SeqCst));
    // Le navigateur abandonne : la réponse est abandonnée, le téléchargement amont aussi.
    drop(b);
    eventually(|| closed.load(Ordering::SeqCst)).await;
}

// ------------------------------------------------------------------ résolution du flux (okru-stream)

async fn stream_harness() -> H {
    let h = harness(&[]).await;
    *h.f.master.lock().unwrap() = Some(MASTER.to_string());
    // Latence réaliste : les appels concurrents doivent se retrouver pendant la résolution.
    *h.f.embed_delay_ms.lock().unwrap() = 5;
    h
}

#[tokio::test]
async fn flux_mp4_seul() {
    let h = stream_harness().await;
    let exp = h.f.exp();
    h.f.set_embed(embed_html(
        None,
        &[("mobile", signed_mp4("mobile", exp, "vd123.okcdn.ru"), false)],
        false,
    ));
    let s = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert_eq!(s.master_text, "");
    assert_eq!(s.master_url, "");
    assert!(s.variants.is_empty());
    assert_eq!(s.mp4.len(), 1);
    assert_eq!(s.mp4[0].name, "mobile");
    assert_eq!(s.mp4[0].url, signed_mp4("mobile", exp, "vd123.okcdn.ru"));
    assert_eq!(s.expires_at, exp as f64);
    assert_eq!(h.f.master_calls(), 0);
}

#[tokio::test]
async fn flux_ni_hls_ni_mp4() {
    let h = stream_harness().await;
    h.f.set_embed(embed_html(None, &[], false));
    let e = h.v.resolve_ok_stream(OK_ID, false).await.unwrap_err();
    assert_eq!(
        e.msg,
        format!("Pas de flux pour ok.ru/{OK_ID}, ni HLS ni MP4 (statut: OK)")
    );
    assert_eq!(e.http_status(), 502);
}

#[tokio::test]
async fn flux_hls_variantes_et_mp4() {
    let h = stream_harness().await;
    let s = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert_eq!(
        s.variants
            .iter()
            .map(|v| v.key.as_str())
            .collect::<Vec<_>>(),
        ["sd", "lowest"]
    );
    assert_eq!(
        s.mp4.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["sd"]
    );
    assert_eq!(s.expires_at, h.f.exp() as f64);
    assert_eq!(s.master_url, signed_master(h.f.exp()));
}

#[tokio::test]
async fn flux_appels_concurrents_une_seule_resolution() {
    let h = stream_harness().await;
    let (a, b, c) = tokio::join!(
        h.v.resolve_ok_stream(OK_ID, false),
        h.v.resolve_ok_stream(OK_ID, false),
        h.v.resolve_ok_stream(OK_ID, false)
    );
    assert_eq!(h.f.embed_calls(), 1);
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert!(Arc::ptr_eq(&a, &b) && Arc::ptr_eq(&b, &c));
}

#[tokio::test]
async fn flux_force_simultanes_une_seule_resolution() {
    let h = stream_harness().await;
    h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    h.v.advance_clock(60_000);
    let before = h.f.embed_calls();
    let (a, b, c) = tokio::join!(
        h.v.resolve_ok_stream(OK_ID, true),
        h.v.resolve_ok_stream(OK_ID, true),
        h.v.resolve_ok_stream(OK_ID, true)
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    assert_eq!(h.f.embed_calls(), before + 1);
    // Un 403 tardif, juste après la résolution forcée, réutilise le flux frais.
    h.v.resolve_ok_stream(OK_ID, true).await.unwrap();
    assert_eq!(h.f.embed_calls(), before + 1);
}

#[tokio::test]
async fn flux_garde_en_cache_jusqu_a_l_expiration() {
    let h = stream_harness().await;
    let first = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    h.v.advance_clock(2 * 3_600_000);
    let again = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(h.f.embed_calls(), 1);
}

#[tokio::test]
async fn flux_stale_while_revalidate() {
    let h = stream_harness().await;
    let exp = h.f.exp();
    let first = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    h.set_clock(exp - 20 * 60_000);
    let exp2 = exp + 24 * 3_600_000;
    h.f.set_embed(embed_html(Some(&signed_master(exp2)), &[], false));
    let served = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert!(Arc::ptr_eq(&served, &first)); // pas d'attente
    eventually(|| h.f.embed_calls() == 2).await; // rafraîchissement lancé
    let t0 = Instant::now();
    loop {
        if h.v
            .resolve_ok_stream(OK_ID, false)
            .await
            .unwrap()
            .expires_at
            == exp2 as f64
        {
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(h.f.embed_calls(), 2);
}

#[tokio::test]
async fn flux_au_dela_de_la_marge_attend_une_nouvelle_resolution() {
    let h = stream_harness().await;
    let exp = h.f.exp();
    let first = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    h.set_clock(exp - 5 * 60_000 + 1000);
    let exp2 = exp + 24 * 3_600_000;
    h.f.set_embed(embed_html(Some(&signed_master(exp2)), &[], false));
    let s = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert!(!Arc::ptr_eq(&s, &first));
    assert_eq!(s.expires_at, exp2 as f64);
}

#[tokio::test]
async fn flux_hls_momentanement_illisible_retente_apres_30_s() {
    let h = stream_harness().await;
    *h.f.master_status.lock().unwrap() = 403;
    let degraded = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    assert!(degraded.hls_error);
    assert!(degraded.variants.is_empty());
    *h.f.master_status.lock().unwrap() = 200;
    h.v.advance_clock(5_000);
    assert!(Arc::ptr_eq(
        &h.v.resolve_ok_stream(OK_ID, false).await.unwrap(),
        &degraded
    ));
    h.v.advance_clock(30_000);
    // Servi pendant le rafraîchissement en fond.
    assert!(Arc::ptr_eq(
        &h.v.resolve_ok_stream(OK_ID, false).await.unwrap(),
        &degraded
    ));
    eventually(|| h.f.embed_calls() == 2).await;
    let t0 = Instant::now();
    let healed = loop {
        let s = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
        if !s.hls_error {
            break s;
        }
        assert!(t0.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(
        healed
            .variants
            .iter()
            .map(|v| v.key.as_str())
            .collect::<Vec<_>>(),
        ["sd", "lowest"]
    );
}

#[tokio::test]
async fn flux_un_rafraichissement_en_echec_garde_le_flux_valable() {
    let h = stream_harness().await;
    let exp = h.f.exp();
    let first = h.v.resolve_ok_stream(OK_ID, false).await.unwrap();
    h.set_clock(exp - 20 * 60_000);
    h.f.set_embed(embed_html(None, &[], false));
    assert!(Arc::ptr_eq(
        &h.v.resolve_ok_stream(OK_ID, false).await.unwrap(),
        &first
    ));
    eventually(|| h.f.embed_calls() == 2).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(Arc::ptr_eq(
        &h.v.resolve_ok_stream(OK_ID, false).await.unwrap(),
        &first
    ));
}

// ------------------------------------------------------------------ routes (session, en-têtes)

#[tokio::test]
async fn routes_video_protegees_par_session() {
    use tower::ServiceExt;
    let h = harness(&[]).await;
    let app = basketland_server::app(basketland_server::state::AppState::new(
        h.db.clone(),
        basketland_server::proxy::Upstream::new("http://127.0.0.1:9"),
        h.v.clone(),
    ));
    let get = |uri: String, cookie: bool| {
        let mut b = axum::http::Request::get(uri);
        if cookie {
            b = b.header(header::COOKIE, "bl_session=jeton");
        }
        b.body(Body::empty()).unwrap()
    };
    for p in [
        "master.m3u8",
        "playlist.m3u8?v=sd",
        "segment.ts?v=sd&s=MEDIUM00001.ts",
        "asset.ts?v=sd&a=k.bin",
        "file.mp4",
    ] {
        let r = app
            .clone()
            .oneshot(get(format!("/api/video/{OK_ID}/{p}"), false))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED, "{p}");
    }
    assert_eq!(h.f.calls().len(), 0);

    let r = app
        .clone()
        .oneshot(get(format!("/api/video/{OK_ID}/master.m3u8"), true))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        hdr(&r, "content-type").as_deref(),
        Some("application/vnd.apple.mpegurl")
    );
    assert_eq!(hdr(&r, "cache-control").as_deref(), Some("no-store"));
    assert_eq!(hdr(&r, "access-control-allow-origin").as_deref(), Some("*"));
    assert!(String::from_utf8(body(r).await.unwrap())
        .unwrap()
        .contains("playlist.m3u8?v=sd"));

    let r = app
        .clone()
        .oneshot(get(format!("/api/video/{OK_ID}/playlist.m3u8?v=sd"), true))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(String::from_utf8(body(r).await.unwrap())
        .unwrap()
        .contains("segment.ts?v=sd&s=MEDIUM00000.ts"));

    let mut req = get(
        format!("/api/video/{OK_ID}/segment.ts?v=sd&s=MEDIUM00002.ts"),
        true,
    );
    req.headers_mut()
        .insert(header::RANGE, "bytes=0-9".parse().unwrap());
    let r = app.clone().oneshot(req).await.unwrap();
    assert_eq!(r.status(), 206);

    let r = app
        .clone()
        .oneshot(get("/api/video/abc/master.m3u8".into(), true))
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(hdr(&r, "content-type").as_deref(), Some("application/json"));
    assert_eq!(hdr(&r, "cache-control").as_deref(), Some("no-store"));
    assert_eq!(
        body(r).await.unwrap(),
        br#"{"error":"okId invalide"}"#.to_vec()
    );

    let r = app
        .clone()
        .oneshot(get(format!("/api/video/{OK_ID}/file.mp4"), true))
        .await
        .unwrap();
    // Le faux ok.ru ne sert pas ce MP4 : 404 amont, rendu en 502 (relais par blocs).
    assert_eq!(r.status(), 502);
    assert_eq!(
        body(r).await.unwrap(),
        br#"{"error":"MP4 indisponible : HTTP 404"}"#.to_vec()
    );
}
