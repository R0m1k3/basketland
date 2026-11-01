//! Son d'un MP4 progressif par ses trames AAC seules ([`mp4_audio`]) : index
//! lu par plages d'octets (au début ou à la fin du fichier), trames du
//! tronçon téléchargées en parallèle, même son au même endroit que le
//! décodage complet par ffmpeg.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use basketland_server::media::audio::{extract_mp4_audio_chunk, ExtractOptions};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

fn has_ffmpeg() -> bool {
    let ok = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("libopus")
        });
    if !ok {
        eprintln!("ffmpeg absent : son des MP4 non testé");
    }
    ok
}

/// 60 s de « match » (vidéo + son AAC dont la hauteur change chaque seconde).
fn make_mp4(out: &Path, faststart: bool) {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error"])
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=25:duration=60",
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            "aevalsrc='0.5*sin(2*PI*(220+40*mod(floor(t),13))*t)':s=44100:d=60",
        ])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-b:v",
            "600k",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
        ]);
    if faststart {
        cmd.args(["-movflags", "+faststart"]);
    }
    assert!(cmd.arg("-y").arg(out).status().unwrap().success());
}

#[derive(Clone)]
struct Srv {
    file: PathBuf,
    served: Arc<AtomicU64>,
}

/// Fichier servi avec les plages d'octets (`Range: bytes=a-b` → 206).
async fn serve(State(s): State<Srv>, headers: HeaderMap) -> Response {
    let data = std::fs::read(&s.file).unwrap();
    let total = data.len() as u64;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(a, b)| {
            Some((
                a.parse::<u64>().ok()?,
                b.parse::<u64>().ok().unwrap_or(total - 1),
            ))
        });
    match range {
        Some((a, b)) => {
            let b = b.min(total - 1);
            s.served.fetch_add(b - a + 1, Ordering::SeqCst);
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{total}"))
                .header(header::CONTENT_LENGTH, b - a + 1)
                .body(Body::from(data[a as usize..=b as usize].to_vec()))
                .unwrap()
        }
        None => {
            s.served.fetch_add(total, Ordering::SeqCst);
            Response::builder()
                .header(header::CONTENT_LENGTH, total)
                .body(Body::from(data))
                .unwrap()
        }
    }
}

async fn start(s: Srv) -> String {
    let app = Router::new().route("/video.mp4", get(serve)).with_state(s);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}/video.mp4")
}

fn pcm(args: &[&str]) -> Vec<f32> {
    let o = Command::new("ffmpeg")
        .args(["-v", "error"])
        .args(args)
        .args(["-f", "f32le", "-ac", "1", "-ar", "8000", "-"])
        .output()
        .unwrap();
    assert!(o.status.success());
    o.stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn best_lag(a: &[f32], b: &[f32], max: i64) -> (i64, f64) {
    let n = (a.len().min(b.len()) as i64 - max).min(max + 24_000);
    let corr = |lag: i64| -> f64 {
        let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
        for i in max..n {
            let (x, y) = (f64::from(a[i as usize]), f64::from(b[(i + lag) as usize]));
            ab += x * y;
            aa += x * x;
            bb += y * y;
        }
        ab / (aa.sqrt() * bb.sqrt()).max(1e-12)
    };
    (-max..=max)
        .map(|l| (l, corr(l)))
        .max_by(|x, y| x.1.total_cmp(&y.1))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn trames_audio_seules_meme_son() {
    if !has_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    for faststart in [true, false] {
        let file = dir.path().join(format!("m-{faststart}.mp4"));
        make_mp4(&file, faststart);
        let total = std::fs::metadata(&file).unwrap().len();
        let srv = Srv {
            file: file.clone(),
            served: Arc::default(),
        };
        let url = start(srv.clone()).await;
        let (from, len) = (21.3, 16.0);
        let out = dir.path().join(format!("chunk-{faststart}.ogg"));
        let how = extract_mp4_audio_chunk(
            &url,
            from,
            len,
            &out.to_string_lossy(),
            &ExtractOptions::default(),
        )
        .await
        .unwrap();
        let served = srv.served.load(Ordering::SeqCst);
        eprintln!("moov au début : {faststart} — {how} ; {served} octets lus sur {total}");
        assert!(!PathBuf::from(format!("{}.src.aac", out.display())).exists());
        // Bien moins que le fichier : l'index, les trames son et les petits
        // bouts d'image entre deux (réunis pour faire moins de requêtes).
        assert!(served * 3 < total, "{served} / {total}");

        // Référence : tout le fichier décodé par ffmpeg, sans `-ss`.
        let whole = pcm(&["-i", &file.to_string_lossy(), "-vn"]);
        let reference = &whole[(from * 8000.0) as usize..((from + len) * 8000.0) as usize];
        let got = pcm(&["-i", &out.to_string_lossy()]);
        assert!(
            (reference.len() as i64 - got.len() as i64).abs() < 800,
            "{} / {}",
            reference.len(),
            got.len()
        );
        let (lag, c) = best_lag(reference, &got, 1600);
        eprintln!(
            "décalage {lag} éch. à 8 kHz ({:.0} ms), corrélation {c:.2}",
            lag as f64 / 8.0
        );
        assert!(c > 0.8, "corrélation {c}");
        assert!(lag.abs() <= 400, "décalage {lag} éch. (> 50 ms)");
    }
}
