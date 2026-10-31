//! Contre le VRAI ok.ru (réseau) : le son seul du manifeste DASH donne le même
//! son, au même instant, que le flux vidéo HLS, pour bien moins d'octets.
//!
//! Ignoré par défaut :
//! `OKRU_TEST_ID=16301368281746 cargo test --test okru_audio_reel -- --ignored --nocapture`

use basketland_server::media::audio::{
    extract_dash_audio_chunk, extract_hls_chunk_parallel, ExtractOptions, SourceHeaders,
};
use basketland_server::media::commentary::StreamInfo;
use std::path::Path;
use std::process::Command;

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

/// Décalage (échantillons à 8 kHz) qui aligne le mieux `b` sur `a`, sur 3 s.
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

#[tokio::test]
#[ignore = "réseau : vrai ok.ru"]
async fn son_seul_dash_comme_le_flux_hls() {
    let id = std::env::var("OKRU_TEST_ID").unwrap_or_else(|_| "16301368281746".into());
    let video = basketland_server::video::Video::new();
    let s = video.resolve_ok_stream(&id, false).await.unwrap();
    let stream = StreamInfo::from(&*s);
    let mpd = stream.dash_url.clone().expect("manifeste DASH annoncé");
    let hls = basketland_server::media::commentary::audio_sources(&stream)[0]
        .url
        .clone();
    let o = ExtractOptions {
        headers: SourceHeaders {
            user_agent: Some(basketland_server::http::BROWSER_UA.into()),
            referer: Some(basketland_server::okru::OK_REFERER.into()),
        },
        ..Default::default()
    };
    let dir = tempfile::tempdir().unwrap();
    let (from, len) = (20.5, 30.0);
    let a = dir.path().join("dash.ogg");
    let how_a = extract_dash_audio_chunk(&mpd, from, len, &a.to_string_lossy(), &o)
        .await
        .unwrap();
    let b = dir.path().join("hls.ogg");
    let how_b = extract_hls_chunk_parallel(&hls, from, len, &b.to_string_lossy(), &o)
        .await
        .unwrap();
    eprintln!("son seul : {how_a}\nvidéo HLS : {how_b}");
    // Référence exacte : tout le flux HLS décodé depuis le début, SANS `-ss`
    // (un `-ss` avant `-i`, même à 0, décale le son d'ok.ru de ~0,77 s), puis
    // les échantillons de [from, from + len[ : l'axe du temps du lecteur.
    let o2 = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-user_agent",
            basketland_server::http::BROWSER_UA,
        ])
        .args(["-headers", "Referer: https://ok.ru/\r\n", "-i", &hls])
        .args(["-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"])
        .output()
        .unwrap();
    assert!(o2.status.success());
    let whole: Vec<f32> = o2
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let pr = whole[(from * 8000.0) as usize..((from + len) * 8000.0) as usize].to_vec();
    let (pa, pb) = (pcm(&a), pcm(&b));
    eprintln!(
        "durées : réf {} / son seul {} / HLS parallèle {} échantillons à 8 kHz",
        pr.len(),
        pa.len(),
        pb.len()
    );
    for (name, p) in [("son seul", &pa), ("HLS parallèle", &pb)] {
        assert!((pr.len() as i64 - p.len() as i64).abs() < 800, "{name}");
        let (lag, c) = best_lag(&pr, p, 1600);
        eprintln!(
            "{name} : décalage {lag} éch. ({:.0} ms), corrélation {c:.2}",
            lag as f64 / 8.0
        );
        assert!(c > 0.5, "{name} : sons différents (corrélation {c})");
        // Un sous-titre décalé de moins de 100 ms ne se voit pas.
        assert!(lag.abs() <= 800, "{name} : décalage {lag} éch. (> 100 ms)");
    }
}
