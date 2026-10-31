//! Tesseract natif (fonction cargo `ocr`) face à tesseract.js : mêmes images
//! que `tests/real-frames.test.ts` et `tests/scoreboard.test.ts`, mêmes
//! données de langue (`eng.traineddata` 4.0.0_best_int de
//! `@tesseract.js-data/eng`, décompressé si `TESSDATA_PREFIX` n'est pas posé).
//!
//! - mêmes règles que les tests de Node (bandeau localisé, période + chrono
//!   lus sur au moins 80 % des images où le bandeau est lisible, jamais de
//!   chrono faux, rien sur les plans sans bandeau) ;
//! - accord avec tesseract.js, appel par appel (texte et mots de chaque image
//!   filtrée) et lecture par lecture (`cargo test --features ocr -- --nocapture`
//!   affiche les mesures). À lancer avec `OMP_THREAD_LIMIT=1`, comme le
//!   serveur dans l'image (sinon très lent sur une machine chargée).
#![cfg(feature = "ocr")]

#[path = "helpers/ocr_kit.rs"]
mod kit;

use basketland_server::media::ocr::{OcrEngine, OcrParams};
use basketland_server::media::scoreboard::{self as sb, ScoreboardLocation};
use basketland_server::media::tesseract::{tesseract_version, TesseractEngine};
use basketland_server::media::video_scan::ScoreboardReading;
use kit::*;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Données de langue de tesseract.js (ou celles déjà désignées par `TESSDATA_PREFIX`).
fn engine() -> TesseractEngine {
    static DIR: OnceLock<Option<tempfile::TempDir>> = OnceLock::new();
    DIR.get_or_init(|| {
        if std::env::var_os("TESSDATA_PREFIX").is_some() {
            return None;
        }
        let gz = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz");
        if !gz.exists() {
            eprintln!(
                "données de tesseract.js absentes ({}) : données de langue du système",
                gz.display()
            );
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("gunzip")
            .arg("-c")
            .arg(&gz)
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(dir.path().join("eng.traineddata"), out.stdout).unwrap();
        std::env::set_var("TESSDATA_PREFIX", dir.path());
        Some(dir)
    });
    TesseractEngine::new().expect("Tesseract natif")
}

fn reading(r: Option<&ScoreboardReading>) -> Value {
    sb::reading_json(r)
}

fn pc(v: &Value) -> (Option<f64>, Option<f64>) {
    (v["period"].as_f64(), v["clock_sec"].as_f64())
}

fn truth() -> Value {
    serde_json::from_str(&std::fs::read_to_string(frames_dir().join("truth.json")).unwrap())
        .unwrap()
}

fn key_of(file: &str) -> String {
    let t = file.rsplit('-').next().unwrap();
    t.trim_end_matches(".jpg").to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn vraies_images_tesseract_natif_contre_tesseract_js() {
    if !ffmpeg_ok() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let eng = engine();
    println!(
        "[mesure] libtesseract {} contre tesseract.js {}",
        tesseract_version(),
        fixture()["tesseract"]
    );
    let truth = truth();
    let runs = fixture()["runs"].as_array().unwrap();
    let mut locations: HashMap<String, ScoreboardLocation> = HashMap::new();
    let (mut same_reading, mut same_pc, mut total) = (0, 0, 0);
    let mut mismatches: Vec<String> = Vec::new();
    for run in runs.iter().filter(|r| r["kind"] == "reel") {
        let m = run["match"].as_str().unwrap();
        let files: Vec<&str> = run["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        let frames: Vec<Vec<u8>> = files
            .iter()
            .enumerate()
            .map(|(i, f)| frame(f, i as u64 + 1))
            .collect();
        let t0 = std::time::Instant::now();
        let loc = sb::locate_scoreboard(&eng, &frames, &Default::default()).await;
        let loc_ms = t0.elapsed().as_millis();
        let node_loc = &run["locate"]["location"];
        let location = loc
            .location
            .clone()
            .unwrap_or_else(|| panic!("{m} : bandeau non localisé"));
        let same_loc = basketland_server::jsval::js_normalize(location.to_json())
            == basketland_server::jsval::js_normalize(node_loc.clone());
        println!(
            "[mesure] {m} : localisation {} ms ({} OCR, Node {}), {}",
            loc_ms,
            loc.ocr_calls,
            run["locate"]["ocrCalls"],
            if same_loc {
                "identique à tesseract.js".to_string()
            } else {
                format!(
                    "DIFFÉRENTE de tesseract.js\n    natif : {}\n    Node  : {}",
                    location.to_json(),
                    node_loc
                )
            }
        );
        for (i, r) in loc.readings.iter().enumerate() {
            let want = &run["locate"]["readings"][i];
            if reading(r.as_ref()) != *want {
                mismatches.push(format!(
                    "{m} {} (localisation) : natif {} / tesseract.js {}",
                    files[i],
                    reading(r.as_ref()),
                    want
                ));
            }
        }
        let (mut ok, mut visible) = (0, 0);
        let mut read_ms = 0;
        for (i, f) in frames.iter().enumerate() {
            let t1 = std::time::Instant::now();
            let r = sb::read_scoreboard(&eng, f, Some(&location)).await;
            read_ms += t1.elapsed().as_millis();
            let got = reading(r.as_ref());
            let want = &run["reads"][i];
            total += 1;
            if got == *want {
                same_reading += 1;
            }
            if pc(&got) == pc(want) {
                same_pc += 1;
            } else {
                mismatches.push(format!(
                    "{m} {} : natif {got} / tesseract.js {want}",
                    files[i]
                ));
            }
            let t = &truth[m][key_of(files[i])];
            if t.is_null() {
                assert!(
                    r.is_none(),
                    "{m} {} sans bandeau : aucune lecture ({got})",
                    files[i]
                );
                continue;
            }
            if t["optional"].as_bool() == Some(true) {
                continue;
            }
            visible += 1;
            if let Some(r) = &r {
                let tc = t["clock"].as_f64().unwrap();
                assert!(
                    (r.clock_sec - tc).abs() <= 1.0,
                    "{m} {} : chrono faux {} (vrai {tc})",
                    files[i],
                    r.clock_sec
                );
                if let Some(p) = r.period {
                    assert_eq!(Some(p), t["period"].as_f64(), "{m} {} : période", files[i]);
                }
                if r.period == t["period"].as_f64() {
                    ok += 1;
                }
            }
        }
        println!(
            "[mesure] {m} : {ok}/{visible} période+chrono (natif), lecture {} ms/image",
            read_ms / frames.len() as u128
        );
        assert!(ok as f64 / visible as f64 >= 0.8, "{m} : {ok}/{visible}");
        locations.insert(m.into(), location);
    }
    // Plans sans bandeau.
    let vide = runs.iter().find(|r| r["kind"] == "vide").unwrap();
    for e in vide["reads"].as_array().unwrap() {
        let file = e["file"].as_str().unwrap();
        let png = frame(file, e["seed"].as_u64().unwrap());
        let loc = e["loc"].as_str().map(|m| &locations[m]);
        let r = sb::read_scoreboard(&eng, &png, loc).await;
        total += 1;
        let got = reading(r.as_ref());
        if got == e["reading"] {
            same_reading += 1;
        }
        if pc(&got) == pc(&e["reading"]) {
            same_pc += 1;
        } else {
            mismatches.push(format!(
                "{file} ({}) : natif {got} / tesseract.js {}",
                e["loc"], e["reading"]
            ));
        }
        assert!(
            r.is_none(),
            "{file} ({}) : aucune lecture attendue, lu {got}",
            e["loc"]
        );
    }
    println!(
        "[mesure] lectures finales : {same_pc}/{total} (période, chrono) identiques à tesseract.js, {same_reading}/{total} identiques avec les scores"
    );
    for m in &mismatches {
        println!("[écart] {m}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn appels_ocr_tesseract_natif_contre_tesseract_js() {
    if !ffmpeg_ok() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let eng = engine();
    // Images filtrées de tous les appels de Node (rejoués pour les retrouver).
    let replay = Replay {
        keep_images: true,
        ..Default::default()
    };
    let runs = fixture()["runs"].as_array().unwrap();
    let mut locations: HashMap<String, ScoreboardLocation> = HashMap::new();
    for run in runs.iter().filter(|r| r["kind"] == "reel") {
        let files: Vec<&str> = run["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        let frames: Vec<Vec<u8>> = files
            .iter()
            .enumerate()
            .map(|(i, f)| frame(f, i as u64 + 1))
            .collect();
        let loc = sb::locate_scoreboard(&replay, &frames, &Default::default())
            .await
            .location
            .unwrap();
        for f in &frames {
            sb::read_scoreboard(&replay, f, Some(&loc)).await;
        }
        locations.insert(run["match"].as_str().unwrap().into(), loc);
    }
    let images = replay.images.lock().unwrap().clone();
    let (mut same_text, mut same_words, mut same_boxes) = (0, 0, 0);
    let mut by_psm: HashMap<String, (usize, usize)> = HashMap::new();
    let mut examples: Vec<String> = Vec::new();
    for (key, (png, params)) in &images {
        let want = page_of(&fixture()["calls"][key]);
        let got = eng.recognize(png, params).await.unwrap();
        let st = got.text == want.text;
        let texts = |p: &basketland_server::media::ocr::OcrPage| {
            p.words.iter().map(|w| w.text.clone()).collect::<Vec<_>>()
        };
        let sw = texts(&got) == texts(&want);
        let sbx = got
            .words
            .iter()
            .map(|w| (w.x0, w.y0, w.x1, w.y1))
            .collect::<Vec<_>>()
            == want
                .words
                .iter()
                .map(|w| (w.x0, w.y0, w.x1, w.y1))
                .collect::<Vec<_>>();
        if !st && examples.len() < 12 {
            examples.push(format!(
                "psm {} « {} » : natif {:?} / tesseract.js {:?}",
                params.psm(),
                params.whitelist(),
                got.text,
                want.text
            ));
        }
        same_text += usize::from(st);
        same_words += usize::from(sw);
        same_boxes += usize::from(sw && sbx);
        let e = by_psm
            .entry(format!(
                "psm {} {}",
                params.psm(),
                if params.whitelist().is_empty() {
                    "sans alphabet"
                } else {
                    "avec alphabet"
                }
            ))
            .or_default();
        e.0 += 1;
        e.1 += usize::from(st);
    }
    let n = images.len();
    println!(
        "[mesure] {n} appels OCR distincts (vraies images) : texte identique {same_text}/{n} ({:.1} %), mots identiques {same_words}/{n} ({:.1} %), mots et boîtes identiques {same_boxes}/{n} ({:.1} %)",
        100.0 * same_text as f64 / n as f64,
        100.0 * same_words as f64 / n as f64,
        100.0 * same_boxes as f64 / n as f64
    );
    let mut keys: Vec<_> = by_psm.into_iter().collect();
    keys.sort();
    for (k, (t, s)) in keys {
        println!("[mesure]   {k} : texte identique {s}/{t}");
    }
    for e in &examples {
        println!("[écart] {e}");
    }
    let _ = OcrParams::default();
}

/// Rectangles attendus des dispositions synthétiques (`LAYOUT_RECTS`).
fn layout_rect(name: &str) -> (f64, f64, f64, f64) {
    match name {
        "bottom-wide" => (0.22, 0.86, 0.56, 0.07),
        "bottom-left" => (0.03, 0.8, 0.27, 0.14),
        "top-right" => (0.66, 0.03, 0.31, 0.065),
        _ => (0.3, 0.78, 0.4, 0.08),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_synthetiques_tesseract_natif() {
    let font = fixture()["font"].as_str().unwrap_or("");
    if !ffmpeg_ok() || font.is_empty() || !std::path::Path::new(font).exists() {
        eprintln!("ffmpeg ou police absents : test sauté");
        return;
    }
    let eng = engine();
    for run in fixture()["runs"].as_array().unwrap() {
        match run["kind"].as_str().unwrap() {
            "synthetique" => {
                let layout = run["layout"].as_str().unwrap();
                let frames: Vec<Vec<u8>> = run["specs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| render_scene(s, font))
                    .collect();
                let loc = sb::locate_scoreboard(&eng, &frames, &Default::default()).await;
                let l = loc
                    .location
                    .clone()
                    .unwrap_or_else(|| panic!("{layout} : bandeau non localisé"));
                let (x, y, w, h) = layout_rect(layout);
                let (cx, cy) = (l.core.x + l.core.w / 2.0, l.core.y + l.core.h / 2.0);
                assert!(
                    cx >= x && cx <= x + w && cy >= y && cy <= y + h,
                    "{layout} : bandeau mal placé"
                );
                let r0 = loc.readings[0].as_ref().unwrap();
                let r1 = loc.readings[1].as_ref().unwrap();
                assert_eq!((r0.period, r0.clock_sec), (Some(2.0), 463.0), "{layout}");
                assert_eq!((r1.period, r1.clock_sec), (Some(3.0), 125.0), "{layout}");
                let probe = render_scene(&run["probeSpec"], font);
                let r = sb::read_scoreboard(&eng, &probe, Some(&l)).await.unwrap();
                assert_eq!(
                    (r.period, r.clock_sec),
                    (Some(4.0), 43.0),
                    "{layout} : lecture"
                );
                let same = basketland_server::jsval::js_normalize(l.to_json())
                    == basketland_server::jsval::js_normalize(run["locate"]["location"].clone());
                println!(
                    "[mesure] {layout} : localisation {} tesseract.js ({} OCR, Node {})",
                    if same {
                        "identique à"
                    } else {
                        "différente de"
                    },
                    loc.ocr_calls,
                    run["locate"]["ocrCalls"]
                );
            }
            "synthetique-repli" => {
                let png = render_scene(&run["spec"], font);
                let r = sb::read_scoreboard(&eng, &png, None).await.unwrap();
                assert_eq!(
                    (r.period, r.clock_sec),
                    (Some(2.0), 463.0),
                    "repli pleine largeur"
                );
            }
            "synthetique-vide" => {
                let png = render_scene(&run["spec"], font);
                assert!(sb::locate_scoreboard(&eng, &[png], &Default::default())
                    .await
                    .location
                    .is_none());
            }
            _ => {}
        }
    }
}
