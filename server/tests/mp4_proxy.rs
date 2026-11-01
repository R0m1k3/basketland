//! MP4 servi par blocs ([`mp4_proxy`]) depuis un serveur qui bride chaque
//! connexion comme ok.ru : mêmes octets, plages respectées, lecture anticipée
//! en parallèle (bien plus rapide qu'une connexion), cache.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use basketland_server::mp4_proxy::{Mp4Cache, RangeFetch};
use http_body_util::BodyExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Srv {
    data: Arc<Vec<u8>>,
    /// Octets par seconde et par connexion.
    rate: usize,
    served: Arc<AtomicU64>,
    requests: Arc<AtomicU64>,
}

async fn serve(
    State(s): State<Srv>,
    q: Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    s.requests.fetch_add(1, Ordering::SeqCst);
    // Lien signé : seul le jeton « bon » est accepté.
    if q.get("sig").map(String::as_str) != Some("bon") {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }
    let total = s.data.len() as u64;
    let (a, b) = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .map(|(a, b)| {
            (
                a.parse::<u64>().unwrap(),
                b.parse::<u64>().unwrap_or(total - 1).min(total - 1),
            )
        })
        .unwrap_or((0, total - 1));
    let slice = s.data[a as usize..=b as usize].to_vec();
    s.served.fetch_add(slice.len() as u64, Ordering::SeqCst);
    let pause = Duration::from_secs_f64(16384.0 / s.rate as f64);
    let pieces: Vec<Vec<u8>> = slice.chunks(16384).map(<[u8]>::to_vec).collect();
    let body = futures_util::stream::unfold(
        (pieces.into_iter(), true),
        move |(mut it, first)| async move {
            let p = it.next()?;
            if !first {
                tokio::time::sleep(pause).await;
            }
            Some((Ok::<_, std::io::Error>(p), (it, false)))
        },
    );
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{total}"))
        .header(header::CONTENT_LENGTH, b - a + 1)
        .body(Body::from_stream(body))
        .unwrap()
}

async fn start(s: Srv) -> String {
    let app = Router::new().route("/video.mp4", get(serve)).with_state(s);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}/video.mp4")
}

/// Lecture d'une plage chez le serveur bridé (comme le proxy vidéo le fait chez ok.ru).
fn range_fetch(base: &str) -> RangeFetch {
    let (base, client) = (format!("{base}?sig=bon"), reqwest::Client::new());
    Arc::new(move |a, b| {
        let (url, client) = (base.clone(), client.clone());
        Box::pin(async move {
            let r = client
                .get(&url)
                .header("Range", format!("bytes={a}-{b}"))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let total = r
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit('/').next())
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or("taille inconnue")?;
            let bytes = r.bytes().await.map_err(|e| e.to_string())?;
            Ok((bytes, total))
        })
    })
}

async fn read(
    cache: &Mp4Cache,
    fetch: RangeFetch,
    range: Option<&str>,
) -> (u16, HeaderMap, Vec<u8>) {
    let r = cache.serve("test:mobile", fetch, range).await.unwrap();
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let body = r.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mp4_par_blocs_cache_et_lecture_anticipee() {
    let data: Vec<u8> = (0..24u64 << 20)
        .map(|i| ((i * 2_654_435_761) >> 13) as u8)
        .collect();
    let srv = Srv {
        data: Arc::new(data.clone()),
        rate: 2 << 20, // 2 Mo/s par connexion : 12 s pour 24 Mo sur une seule
        served: Arc::default(),
        requests: Arc::default(),
    };
    let base = start(srv.clone()).await;
    let fetch = range_fetch(&base);
    let cache = Mp4Cache::new(64 << 20, 6, 12);

    // Tout le fichier, comme le lecteur (« bytes=0- ») : mêmes octets, bien
    // plus vite qu'une seule connexion grâce à la lecture anticipée.
    let t0 = Instant::now();
    let (status, h, body) = read(&cache, fetch.clone(), Some("bytes=0-")).await;
    let took = t0.elapsed().as_secs_f64();
    eprintln!(
        "24 Mo en {took:.1} s ({} requêtes)",
        srv.requests.load(Ordering::SeqCst)
    );
    assert_eq!(status, 206);
    assert_eq!(
        h[header::CONTENT_RANGE],
        format!("bytes 0-{}/{}", data.len() - 1, data.len())
    );
    assert!(body == data, "octets différents");
    assert!(took < 6.0, "{took:.1} s");

    // Plage à cheval sur deux blocs : depuis le cache, rien de plus chez l'amont.
    let before = srv.served.load(Ordering::SeqCst);
    let (a, b) = ((5u64 << 20) - 100, (5u64 << 20) + 100);
    let (status, h, body) = read(&cache, fetch.clone(), Some(&format!("bytes={a}-{b}"))).await;
    assert_eq!(status, 206);
    assert_eq!(h[header::CONTENT_LENGTH], "201");
    assert_eq!(body, data[a as usize..=b as usize]);
    assert_eq!(
        srv.served.load(Ordering::SeqCst),
        before,
        "relu depuis le cache"
    );

    // Au-delà de la fin : 416.
    let (status, h, _) = read(&cache, fetch.clone(), Some("bytes=999999999-")).await;
    assert_eq!(status, 416);
    assert_eq!(h[header::CONTENT_RANGE], format!("bytes */{}", data.len()));
    assert!(cache.cached_bytes() >= 24 << 20);
}
