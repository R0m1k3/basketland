//! Téléchargement parallèle des segments HLS (audio des commentaires) contre
//! un serveur local qui bride CHAQUE connexion comme ok.ru, avec le vrai
//! ffmpeg : même son que la lecture directe par ffmpeg, au bon endroit,
//! nettement plus vite, et un segment qui cale est repris.

use axum::body::Body;
use axum::extract::{Path as AxPath, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use basketland_server::media::audio::{
    extract_audio_chunk, extract_hls_chunk_parallel, ExtractOptions,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn has_ffmpeg() -> bool {
    let ok = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("libopus")
        });
    if !ok {
        eprintln!("ffmpeg (libopus) absent : téléchargement parallèle non testé");
    }
    ok
}

/// 60 s de « match » en HLS (vidéo + son, segments de 2 s). Le son change de
/// hauteur chaque seconde : un décalage se voit à la corrélation.
fn make_hls(dir: &Path) {
    let st = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=25:duration=60",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc='0.5*sin(2*PI*(220+40*mod(floor(t),13))*t)':s=44100:d=60",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-b:v",
            "400k",
            "-g",
            "50",
            "-c:a",
            "aac",
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_list_size",
            "0",
            "-hls_segment_filename",
        ])
        .arg(dir.join("LOW%05d.ts"))
        .arg(dir.join("index.m3u8"))
        .status()
        .unwrap();
    assert!(st.success());
}

#[derive(Clone)]
struct Srv {
    dir: PathBuf,
    /// Octets par seconde et par connexion.
    rate: usize,
    /// Le premier envoi de ce segment cale après quelques octets.
    stall_once: Option<String>,
    stalled: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
}

async fn serve_file(State(s): State<Srv>, AxPath(name): AxPath<String>) -> Response {
    s.requests.fetch_add(1, Ordering::SeqCst);
    let Ok(data) = std::fs::read(s.dir.join(&name)) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let len = data.len();
    let stall = s.stall_once.as_deref() == Some(name.as_str())
        && s.stalled.fetch_add(1, Ordering::SeqCst) == 0;
    let rate = s.rate;
    let body = async_stream(data, rate, stall);
    Response::builder()
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from_stream(body))
        .unwrap()
}

/// Corps bridé : morceaux de 8 Ko espacés pour tenir `rate` ; `stall` : se tait après 8 Ko.
fn async_stream(
    data: Vec<u8>,
    rate: usize,
    stall: bool,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    let pieces: Vec<Vec<u8>> = data.chunks(8192).map(<[u8]>::to_vec).collect();
    let pause = Duration::from_secs_f64(8192.0 / rate as f64);
    futures_util::stream::unfold(
        (pieces.into_iter(), 0usize),
        move |(mut it, n)| async move {
            if stall && n == 1 {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
            let p = it.next()?;
            if n > 0 {
                tokio::time::sleep(pause).await;
            }
            Some((Ok(p), (it, n + 1)))
        },
    )
}

async fn start(s: Srv) -> String {
    let app = Router::new()
        .route("/hls/{name}", get(serve_file))
        .with_state(s);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}/hls/index.m3u8")
}

/// PCM 8 kHz mono (f32) d'un fichier son.
fn pcm(file: &Path) -> Vec<f32> {
    let o = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-f", "f32le", "-ac", "1", "-ar", "8000", "-"])
        .output()
        .unwrap();
    assert!(o.status.success());
    o.stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// Décalage (échantillons) qui aligne le mieux `b` sur `a`, dans ±`max`.
fn best_lag(a: &[f32], b: &[f32], max: i64) -> i64 {
    // Fenêtre de 3 s : assez pour reconnaître les marches de hauteur.
    let n = (a.len().min(b.len()) as i64 - max).min(max + 24_000);
    (-max..=max)
        .max_by(|&x, &y| {
            let c = |lag: i64| -> f64 {
                (max..n)
                    .map(|i| f64::from(a[i as usize]) * f64::from(b[(i + lag) as usize]))
                    .sum()
            };
            c(x).total_cmp(&c(y))
        })
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn segments_en_parallele_meme_son_plus_vite() {
    if !has_ffmpeg() {
        return;
    }
    std::env::set_var("COMMENTARY_FETCH_PARALLEL", "8");
    std::env::set_var("COMMENTARY_FETCH_STALL_MS", "1500");
    let dir = tempfile::tempdir().unwrap();
    let hls = dir.path().join("hls");
    std::fs::create_dir_all(&hls).unwrap();
    make_hls(&hls);
    let seg_bytes: u64 = std::fs::read_dir(&hls)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".ts"))
        .map(|e| e.metadata().unwrap().len())
        .sum();
    // Bride : ~1/3 du débit du flux par connexion (un seul flux = 3 fois plus lent que le temps réel).
    let rate = (seg_bytes as f64 / 60.0 / 3.0) as usize;
    let srv = Srv {
        dir: hls.clone(),
        rate,
        stall_once: Some("LOW00012.ts".into()),
        stalled: Arc::new(AtomicUsize::new(0)),
        requests: Arc::new(AtomicUsize::new(0)),
    };
    let url = start(srv.clone()).await;
    let (from, len) = (21.3, 16.0);
    let o = ExtractOptions::default();

    // Référence : ffmpeg sur la playlist locale (pas de réseau).
    let reference = dir.path().join("ref.ogg");
    extract_audio_chunk(
        &hls.join("index.m3u8").to_string_lossy(),
        from,
        len,
        &reference.to_string_lossy(),
        &o,
    )
    .await
    .unwrap();

    // Parallèle, par HTTP bridé (le segment 12, à 24 s, cale une fois).
    let par = dir.path().join("par.ogg");
    let t0 = Instant::now();
    let how = extract_hls_chunk_parallel(&url, from, len, &par.to_string_lossy(), &o)
        .await
        .unwrap();
    let t_par = t0.elapsed().as_secs_f64();
    assert!(
        srv.stalled.load(Ordering::SeqCst) >= 2,
        "segment calé repris"
    );
    assert!(!PathBuf::from(format!("{}.src.ts", par.display())).exists());

    // Ancienne voie : ffmpeg lit le flux bridé sur une connexion.
    let seq = dir.path().join("seq.ogg");
    let srv2 = Srv {
        stall_once: None,
        ..srv.clone()
    };
    let url2 = start(srv2).await;
    let t0 = Instant::now();
    extract_audio_chunk(&url2, from, len, &seq.to_string_lossy(), &o)
        .await
        .unwrap();
    let t_seq = t0.elapsed().as_secs_f64();
    eprintln!("parallèle : {t_par:.1} s ({how}) ; ffmpeg seul : {t_seq:.1} s");

    // Octets téléchargés = segments 10 à 18 recollés dans l'ordre.
    let ts = dir.path().join("range.ts");
    let st = basketland_server::media::hls_fetch::fetch_range(
        &url,
        from,
        len,
        &Default::default(),
        None,
        &ts,
    )
    .await
    .unwrap();
    let mut expected = Vec::new();
    for i in 10..=18 {
        expected.extend(std::fs::read(hls.join(format!("LOW{i:05}.ts"))).unwrap());
    }
    assert_eq!((st.segments, st.first_start), (9, 20.0));
    assert!(std::fs::read(&ts).unwrap() == expected, "octets différents");

    // Même son, au même endroit (à 50 ms près : un sous-titre ne se voit pas à moins), même durée.
    let (a, b) = (pcm(&reference), pcm(&par));
    eprintln!(
        "référence {} éch., parallèle {} éch., ffmpeg seul {} éch.",
        a.len(),
        b.len(),
        pcm(&seq).len()
    );
    assert!(
        (a.len() as i64 - b.len() as i64).abs() < 800,
        "{} / {}",
        a.len(),
        b.len()
    );
    let lag = best_lag(&a, &b, 800);
    eprintln!("décalage : {lag} éch. à 8 kHz");
    assert!(
        lag.abs() <= 400,
        "décalage de {lag} échantillons à 8 kHz (> 50 ms)"
    );
    assert!(
        t_par * 2.5 < t_seq,
        "parallèle {t_par:.1} s contre {t_seq:.1} s"
    );

    // Une URL qui n'est pas une playlist (MP4…) : erreur, l'appelant passe par ffmpeg.
    let bad = url.replace("index.m3u8", "LOW00000.ts");
    let e = extract_hls_chunk_parallel(&bad, 0.0, 4.0, &par.to_string_lossy(), &o)
        .await
        .unwrap_err();
    assert!(e.contains("pas une playlist"), "{e}");
}
