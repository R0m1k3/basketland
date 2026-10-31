//! Outils communs des tests de l'OCR (`tests/ocr_node.rs`, `tests/ocr_native.rs`) :
//! sorties de tesseract.js enregistrées par `node-fixtures-ocr.mts`, images
//! des tests de Node refaites par le même ffmpeg (vraies images recomposées,
//! scènes synthétiques), moteur qui rejoue les réponses enregistrées.
#![allow(dead_code)]

use basketland_server::media::ocr::{OcrEngine, OcrFut, OcrPage, OcrParams, OcrWord};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

/// Sorties du code TypeScript.
pub fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let p = format!(
            "{}/tests/fixtures/ocr.expected.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    })
}

pub fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

pub fn ffmpeg_ok() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn frames_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/real-frames")
}

/// Image 1280x720 de `tests/real-frames.test.ts` : haut bruité (graine) + bas réel.
pub fn frame(file: &str, seed: u64) -> Vec<u8> {
    let out = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=0x707070:s=1280x432:d=1,noise=alls=90:allf=t:all_seed={seed}"),
            "-i",
            frames_dir().join(file).to_str().unwrap(),
            "-filter_complex",
            "[0:v][1:v]vstack=inputs=2,format=rgb24",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// `renderScene` de `tests/helpers/scoreboardImages.ts` (spécification JSON enregistrée).
pub fn render_scene(spec: &Value, font: &str) -> Vec<u8> {
    let w = spec["width"].as_f64().unwrap_or(1280.0);
    let h = spec["height"].as_f64().unwrap_or(720.0);
    let dir = tempfile::tempdir().unwrap();
    let seed = spec["seed"].as_f64().unwrap_or(1.0) as i64;
    let hue = (seed * 47) % 360;
    let mut filters = vec![
        format!("color=c=0xC89A5E:s={w}x{h}:d=1,format=yuv420p"),
        format!(
            "drawbox=x=0:y=0:w={w}:h={}:color=0x1A1426:t=fill",
            round(h * 0.38)
        ),
        format!(
            "drawbox=x={}:y={}:w={}:h={}:color=0x4B2E83:t=fill",
            round(w * 0.3),
            round(h * 0.5),
            round(w * 0.4),
            round(h * 0.18)
        ),
        format!("hue=h={hue}:s=0.8"),
        "noise=alls=18:allf=t".to_string(),
    ];
    let mut items: Vec<(String, f64, f64, f64, String)> = vec![
        (
            (10 + seed % 80).to_string(),
            0.42 + (seed % 5) as f64 * 0.02,
            0.55,
            0.07,
            "white".into(),
        ),
        (
            "CRYPTO.COM ARENA".into(),
            0.08,
            0.25,
            0.035,
            "0xF2C14E".into(),
        ),
        ("3-0".into(), 0.62, 0.3, 0.03, "white".into()),
    ];
    for t in spec["texts"].as_array().unwrap() {
        items.push((
            t["text"].as_str().unwrap().into(),
            t["x"].as_f64().unwrap(),
            t["y"].as_f64().unwrap(),
            t["size"].as_f64().unwrap(),
            t["color"].as_str().unwrap_or("white").into(),
        ));
    }
    for b in spec["boxes"].as_array().unwrap() {
        let f = |k: &str| b[k].as_f64().unwrap();
        filters.push(format!(
            "drawbox=x={}:y={}:w={}:h={}:color={}:t=fill",
            round(f("x") * w),
            round(f("y") * h),
            round(f("w") * w),
            round(f("h") * h),
            b["color"].as_str().unwrap()
        ));
    }
    for (i, (text, x, y, size, color)) in items.iter().enumerate() {
        let f = dir.path().join(format!("t{i}.txt"));
        std::fs::write(&f, text).unwrap();
        filters.push(format!(
            "drawtext=fontfile={font}:textfile={}:x={}:y={}:fontsize={}:fontcolor={color}",
            f.display(),
            round(x * w),
            round(y * h),
            8.max(round(size * h)),
        ));
    }
    let out = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &filters.join(","),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// Clé d'un appel OCR enregistré : empreinte de l'image filtrée, psm, alphabet.
pub fn call_key(png: &[u8], p: &OcrParams) -> String {
    format!("{}|{}|{}", sha(png), p.psm(), p.whitelist())
}

pub fn page_of(v: &Value) -> OcrPage {
    OcrPage {
        text: v["text"].as_str().unwrap().into(),
        words: v["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| OcrWord {
                text: w[0].as_str().unwrap().into(),
                x0: w[1].as_f64().unwrap(),
                y0: w[2].as_f64().unwrap(),
                x1: w[3].as_f64().unwrap(),
                y1: w[4].as_f64().unwrap(),
                confidence: w[5].as_f64().unwrap(),
            })
            .collect(),
    }
}

/// Moteur qui rejoue les réponses de tesseract.js ; un appel jamais vu par
/// Node est compté (et rend une erreur, comme une image illisible).
#[derive(Default)]
pub struct Replay {
    pub calls: AtomicUsize,
    pub missing: Mutex<Vec<String>>,
    /// Images reçues, par clé (pour les comparer ensuite à Tesseract natif).
    pub images: Mutex<HashMap<String, (Vec<u8>, OcrParams)>>,
    pub keep_images: bool,
}

impl OcrEngine for Replay {
    fn recognize<'a>(&'a self, png: &'a [u8], params: &'a OcrParams) -> OcrFut<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let key = call_key(png, params);
            if self.keep_images {
                self.images
                    .lock()
                    .unwrap()
                    .entry(key.clone())
                    .or_insert_with(|| (png.to_vec(), params.clone()));
            }
            match fixture()["calls"].get(&key) {
                Some(v) => Ok(page_of(v)),
                None => {
                    self.missing.lock().unwrap().push(key);
                    Err("appel OCR inconnu de Node".into())
                }
            }
        })
    }
}
