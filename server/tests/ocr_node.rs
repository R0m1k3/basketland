//! Analyse vidéo (étape 7, non branchée) comparée au code TypeScript :
//! sorties de `server/tests/node-fixtures-ocr.mts` (`fixtures/ocr.expected.json`).
//!
//! - fonctions pures de `ocr.ts` et `scoreboard.ts` sur des entrées réelles
//!   (textes et mots lus par tesseract.js, vignettes des vraies images) ;
//! - localisation et lecture des vraies images (`tests/real-frames.test.ts`)
//!   et des images synthétiques (`tests/scoreboard.test.ts`), en rejouant les
//!   réponses de tesseract.js : mêmes appels OCR (mêmes images filtrées par
//!   ffmpeg), mêmes localisations (JSON du cache à l'octet), mêmes lectures.

#[path = "helpers/ocr_kit.rs"]
mod kit;

use basketland_server::api::js_num_value;
use basketland_server::jsval::js_normalize;
use basketland_server::media::ocr::{self, OcrWord, ScorePlay, ScorePoint};
use basketland_server::media::scoreboard::{self as sb, ClockCandidate, Rect, ScoreboardLocation};
use basketland_server::media::video_scan::FrameObservation;
use basketland_server::vf_sync::{find_breaks, to_timed_plays};
use kit::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;

fn n(f: f64) -> Value {
    js_num_value(f)
}
fn on(f: Option<f64>) -> Value {
    f.map_or(Value::Null, n)
}
fn nums(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|x| n(*x)).collect())
}

fn cases(f: &str) -> Vec<&'static Value> {
    fixture()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["fn"] == f)
        .collect()
}

/// Premier écart entre deux valeurs JSON (chemin, Rust, Node).
fn first_diff(g: &Value, w: &Value, path: &str) -> Option<String> {
    match (g, w) {
        (Value::Object(a), Value::Object(b)) => {
            for k in a.keys().chain(b.keys()) {
                match (a.get(k), b.get(k)) {
                    (Some(x), Some(y)) => {
                        if let Some(d) = first_diff(x, y, &format!("{path}.{k}")) {
                            return Some(d);
                        }
                    }
                    (x, y) => return Some(format!("{path}.{k} : Rust {x:?} / Node {y:?}")),
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                if let Some(d) = first_diff(x, y, &format!("{path}[{i}]")) {
                    return Some(d);
                }
            }
            (a.len() != b.len())
                .then(|| format!("{path} : {} éléments / Node {}", a.len(), b.len()))
        }
        _ => (g != w).then(|| format!("{path} : Rust {g} / Node {w}")),
    }
}

/// Égalité des valeurs JSON (ordre des clés ignoré), avec le premier écart.
fn same(got: &Value, want: &Value, what: &str) {
    let (g, w) = (js_normalize(got.clone()), js_normalize(want.clone()));
    if g != w {
        panic!("{what} : {}", first_diff(&g, &w, "").unwrap_or_default());
    }
}

fn word(v: &Value) -> OcrWord {
    OcrWord {
        text: v[0].as_str().unwrap().into(),
        x0: v[1].as_f64().unwrap(),
        y0: v[2].as_f64().unwrap(),
        x1: v[3].as_f64().unwrap(),
        y1: v[4].as_f64().unwrap(),
        confidence: v[5].as_f64().unwrap(),
    }
}

fn word_json(w: &OcrWord) -> Value {
    json!({ "text": w.text, "x0": n(w.x0), "y0": n(w.y0), "x1": n(w.x1), "y1": n(w.y1), "confidence": n(w.confidence) })
}

fn rect(v: &Value) -> Rect {
    Rect::from_json(v).unwrap()
}

fn cand(v: &Value) -> ClockCandidate {
    ClockCandidate {
        frame: v["frame"].as_u64().unwrap() as usize,
        period: v["period"].as_f64(),
        clock_sec: v["clock_sec"].as_f64().unwrap(),
        rect: rect(&v["rect"]),
        text_h: v["textH"].as_f64().unwrap(),
        scores: v["scores"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect(),
        score_rects: v["scoreRects"]
            .as_array()
            .unwrap()
            .iter()
            .map(rect)
            .collect(),
        clock_rect: rect(&v["clockRect"]),
        period_rect: v.get("periodRect").map(rect),
        strong: v["strong"].as_bool().unwrap(),
        from_cell: v.get("fromCell").and_then(Value::as_bool).unwrap_or(false),
    }
}

#[test]
fn textes_comme_node() {
    let all = cases("texte");
    assert!(all.len() > 200, "{} textes", all.len());
    for c in all {
        let t = c["input"].as_str().unwrap();
        let norm = ocr::normalize_ocr_text(t);
        let w = sb::analyze_word(t);
        let got = json!({
            "normalize": norm,
            "period": on(ocr::parse_period_text(&norm)),
            "clocks": nums(&ocr::parse_clock_candidates(&norm)),
            "scoreboard": ocr::parse_scoreboard_text(t).map_or(Value::Null, |r| json!({ "period": on(r.period), "clock_sec": n(r.clock_sec) })),
            "word": { "period": on(w.period), "clock": on(w.clock), "numbers": nums(&w.numbers) },
            "loose": on(sb::loose_period(t, None)),
            "looseStrict": on(sb::loose_period(t, Some(false))),
            "colonless": on(sb::colonless_clock(t)),
            "glued": on(sb::glued_clock(t)),
            "slot": on(sb::clock_from_slot_text(t)),
        });
        same(&got, &c["output"]["ok"], &format!("texte {t:?}"));
    }
}

#[test]
fn mots_comme_node() {
    let all = cases("mots");
    assert!(all.len() > 100);
    for c in all {
        let words: Vec<OcrWord> = c["input"]["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(word)
            .collect();
        let frame = c["input"]["frame"].as_u64().unwrap() as usize;
        let slot: Vec<Value> = [17.0, 25.0, 40.0]
            .iter()
            .flat_map(|px| {
                [
                    on(sb::period_from_slot(&words, *px, true, None)),
                    on(sb::period_from_slot(&words, *px, false, None)),
                    on(sb::period_from_slot(&words, *px, true, Some(true))),
                    on(sb::period_from_slot(&words, *px, false, Some(false))),
                ]
            })
            .collect();
        let got = json!({
            "candidates": sb::find_clock_candidates(&words, 1280.0, 720.0, frame).iter().map(ClockCandidate::to_json).collect::<Vec<_>>(),
            "merged": sb::merge_split_clocks(&words).iter().map(word_json).collect::<Vec<_>>(),
            "slot": slot,
        });
        same(
            &got,
            &c["output"]["ok"],
            &format!("mots {}", c["input"]["words"]),
        );
    }
}

fn vote_json(v: Option<sb::Vote>) -> Value {
    let Some(v) = v else { return Value::Null };
    let mut m = match v.location.to_json() {
        Value::Object(m) => m,
        _ => unreachable!(),
    };
    m.insert(
        "members".into(),
        Value::Array(v.members.iter().map(ClockCandidate::to_json).collect()),
    );
    Value::Object(m)
}

#[test]
fn vote_comme_node() {
    let all = cases("vote");
    assert!(all.len() >= 46);
    let mut accepted = 0;
    for c in all {
        let cands: Vec<ClockCandidate> = c["input"]["cands"]
            .as_array()
            .unwrap()
            .iter()
            .map(cand)
            .collect();
        let sampled = c["input"]["sampledFrames"].as_f64();
        let v = sb::vote_scoreboard_region(
            &cands,
            &sb::VoteOptions {
                sampled_frames: sampled,
                ..Default::default()
            },
        );
        accepted += usize::from(v.is_some());
        let got = vote_json(v);
        same(&got, &c["output"]["ok"], "voteScoreboardRegion");
        // Ordre des clés compris (objet mis en cache par Node).
        assert_eq!(
            js_normalize(got).to_string(),
            js_normalize(c["output"]["ok"].clone()).to_string()
        );
    }
    assert!(accepted > 5, "{accepted} votes acceptés");
}

fn region_json(r: &sb::StaticRegion) -> Value {
    json!({ "rect": r.rect.to_json(), "score": n(r.score) })
}

fn rects_json(r: &[Rect]) -> Value {
    Value::Array(r.iter().map(Rect::to_json).collect())
}

/// Vignette synthétique de `tests/scoreboard-real-rules.test.ts`.
fn thumb(seed: i64, overlays: &[(usize, usize, usize, usize, u8, bool)]) -> Vec<u8> {
    let (w, h) = (sb::THUMB_W, sb::THUMB_H);
    let mut b = vec![0u8; w * h];
    let mut s: i64 = seed * 7919 + 17;
    let mut blocks = Vec::new();
    for _ in 0..(w / 16) * h.div_ceil(16) {
        // `(s * 1103515245 + 12345) & 0x7fffffff` en flottants (produit arrondi), puis ToInt32.
        let p = s as f64 * 1103515245.0 + 12345.0;
        s = (p.rem_euclid(4294967296.0) as i64) & 0x7fffffff;
        blocks.push(40 + ((s as u64 >> 16) % 180) as u8);
    }
    for y in 0..h {
        for x in 0..w {
            b[y * w + x] = blocks[(y / 16) * (w / 16) + x / 16];
        }
    }
    for &(ox, oy, ow, oh, v, digits) in overlays {
        for y in oy..oy + oh {
            for x in ox..ox + ow {
                let border = y == oy || y == oy + oh - 1 || x == ox || x == ox + ow - 1;
                let digit = digits && y > oy + 2 && y < oy + oh - 3 && (x as i64 + seed) % 5 == 0;
                b[y * w + x] = if border {
                    10
                } else if digit {
                    30
                } else {
                    v
                };
            }
        }
    }
    b
}

#[test]
fn vignettes_synthetiques_comme_node() {
    let c = cases("vignettes")[0];
    let bug = [
        (100, 150, 120, 14, 30, false),
        (150, 152, 24, 10, 235, true),
    ];
    let with_bug: Vec<Vec<u8>> = (1..=8).map(|i| thumb(i, &bug)).collect();
    let no_bug = thumb(99, &[]);
    let mut all = with_bug.clone();
    all.push(no_bug.clone());
    let shas: Vec<Value> = all.iter().map(|t| Value::from(sha(t))).collect();
    assert_eq!(
        Value::Array(shas),
        c["input"]["thumbs"],
        "mêmes vignettes que Node"
    );
    let z = sb::static_overlay_regions(&all, &Default::default());
    let zb = sb::static_overlay_regions(&with_bug, &Default::default());
    let sig = sb::panel_signature(
        &with_bug,
        &Rect {
            x: 100.0 / 320.0,
            y: 150.0 / 180.0,
            w: 120.0 / 320.0,
            h: 14.0 / 180.0,
        },
    )
    .unwrap();
    let got = json!({
        "z": z.iter().map(region_json).collect::<Vec<_>>(),
        "zb": zb.iter().map(region_json).collect::<Vec<_>>(),
        "cells": rects_json(&sb::static_bright_cells(&with_bug, &zb[0].rect, &Default::default())),
        "sig": sig.to_json(),
        "presence": [n(sb::panel_presence(&thumb(42, &bug), &sig)), n(sb::panel_presence(&no_bug, &sig))],
    });
    same(&got, &c["output"]["ok"], "vignettes synthétiques");
}

#[test]
fn recadrages_comme_node() {
    let all = cases("recadrage");
    assert_eq!(all.len(), 60);
    for c in all {
        let r = rect(&c["input"]["r"]);
        let k = c["input"]["k"].as_f64().unwrap();
        let crop = |w: f64, h: f64| {
            let p = sb::pixel_crop(&r, w, h);
            json!({ "x": n(p.x), "y": n(p.y), "w": n(p.w), "h": n(p.h) })
        };
        let bins = [
            sb::Binarization::Light,
            sb::Binarization::LightHigh,
            sb::Binarization::Gray,
            sb::Binarization::Dark,
        ];
        let got = json!({
            "crop": crop(1280.0, 720.0),
            "crop480": crop(854.0, 480.0),
            "filters": bins.iter().map(|b| sb::crop_filter(&r, 1280.0, 720.0, k, *b)).collect::<Vec<_>>(),
            "upscale": n(sb::upscale_for(r.h * 720.0)),
        });
        same(&got, &c["output"]["ok"], "recadrage");
    }
}

fn score_points_json(tl: &[ScorePoint]) -> Value {
    Value::Array(
        tl.iter()
            .map(|s| json!({ "period": n(s.period), "clock_sec": n(s.clock_sec), "home": n(s.home), "away": n(s.away) }))
            .collect(),
    )
}

fn score_plays(v: &Value) -> Vec<ScorePlay> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| ScorePlay {
            seq: p["seq"].as_f64().unwrap(),
            period: p["period"].as_f64().unwrap(),
            clock_sec: p["clock_sec"].as_f64().unwrap(),
            home_score: p["home_score"].as_f64(),
            away_score: p["away_score"].as_f64(),
        })
        .collect()
}

#[test]
fn scores_comme_node() {
    let all = cases("scores");
    assert_eq!(all.len(), 3);
    for c in all {
        let tl = ocr::score_timeline(&score_plays(&c["input"]["plays"]));
        let matches: Vec<Value> = c["input"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                let read: Vec<f64> = k["read"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect();
                Value::from(ocr::scores_match_at(
                    &read,
                    &tl,
                    k["period"].as_f64().unwrap(),
                    k["clock"].as_f64().unwrap(),
                    45.0,
                    10.0,
                ))
            })
            .collect();
        same(
            &json!({ "timeline": score_points_json(&tl), "matches": matches }),
            &c["output"]["ok"],
            "scores",
        );
    }
}

#[test]
fn coherence_comme_node() {
    let c = cases("coherence")[0];
    let plays = c["input"]["plays"].as_array().unwrap();
    let tp = to_timed_plays(plays.iter().map(|p| {
        (
            p["seq"].as_f64().unwrap(),
            p["period"].as_f64().unwrap(),
            p["clock_sec"].as_f64().unwrap(),
            p["wallclock"].as_str().unwrap(),
        )
    }));
    let breaks = find_breaks(&tp);
    let want = &c["output"]["ok"];
    let tl = ocr::score_timeline(&score_plays(&c["input"]["plays"]));
    same(&score_points_json(&tl), &want["timeline"], "scoreTimeline");
    for iv in want["intervals"].as_array().unwrap() {
        let (p, k) = (iv[0].as_f64().unwrap(), iv[1].as_f64().unwrap());
        let got = ocr::clock_wall_interval(p, k, &tp)
            .map_or(Value::Null, |(lo, hi)| json!({ "lo": n(lo), "hi": n(hi) }));
        same(&got, &iv[2], &format!("clockWallInterval({p}, {k})"));
    }
    let mut total = 0;
    for s in want["sets"].as_array().unwrap() {
        let obs: Vec<FrameObservation> = s["obs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| FrameObservation {
                video_ts: o["video_ts"].as_f64().unwrap(),
                period: o["period"].as_f64(),
                clock_sec: o["clock_sec"].as_f64().unwrap(),
                scores: o.get("scores").map(|a| {
                    a.as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_f64().unwrap())
                        .collect()
                }),
            })
            .collect();
        let o = &s["opts"];
        let opts = ocr::ConsistencyOptions {
            tolerance: o["tolerance"].as_f64(),
            frozen_max: o["frozenMax"].as_f64(),
            scores: o["scores"].as_bool().unwrap().then(|| tl.clone()),
        };
        let anchors = ocr::select_consistent_observations(&obs, &tp, &breaks, &opts);
        total += anchors.len();
        let got: Vec<Value> = anchors
            .iter()
            .map(|a| json!({ "wall": n(a.wall), "video": n(a.video), "method": a.method, "period": n(a.period), "clock_sec": n(a.clock_sec) }))
            .collect();
        same(
            &Value::Array(got),
            &s["anchors"],
            "selectConsistentObservations",
        );
    }
    assert!(total > 50, "{total} ancres");
}

// ------------------------------------------------------------------ vraies images, réponses rejouées

fn locate_json(r: &sb::LocateOutcome) -> Value {
    json!({
        "location": r.location.as_ref().map_or(Value::Null, ScoreboardLocation::to_json),
        "readings": r.readings.iter().map(|x| sb::reading_json(x.as_ref())).collect::<Vec<_>>(),
        "ocrCalls": r.ocr_calls,
        "method": r.method.map_or(Value::Null, |m| Value::from(m.as_str())),
    })
}

/// Localisation : même JSON que Node, à l'octet près (objet mis en cache).
fn same_locate(got: &sb::LocateOutcome, want: &Value, what: &str) {
    let g = locate_json(got);
    same(&g, want, what);
    assert_eq!(
        g["location"].to_string(),
        js_normalize(want["location"].clone()).to_string(),
        "{what} : JSON de la localisation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn zones_fixes_des_vraies_images_comme_node() {
    if !ffmpeg_ok() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let runs = fixture()["runs"].as_array().unwrap();
    let mut n = 0;
    for run in runs.iter().filter(|r| r["kind"] == "reel") {
        let files = run["files"].as_array().unwrap();
        let mut thumbs = Vec::new();
        for (i, f) in files.iter().enumerate() {
            let png = frame(f.as_str().unwrap(), i as u64 + 1);
            thumbs.push(ocr::raw_gray(&png, 320, 180, None, "").await.unwrap());
        }
        let m = run["match"].as_str().unwrap();
        for c in cases("zones")
            .into_iter()
            .filter(|c| c["input"]["match"] == m)
        {
            let shas: Vec<Value> = thumbs.iter().map(|t| Value::from(sha(t))).collect();
            assert_eq!(
                Value::Array(shas),
                c["input"]["thumbs"],
                "{m} : mêmes vignettes que Node"
            );
            let min_agree = c["input"]["minAgree"].as_f64().unwrap();
            let o = sb::StaticOptions {
                min_agree: Some(min_agree),
                ..Default::default()
            };
            let zones = sb::static_overlay_regions(&thumbs, &o);
            let got = json!({
                "zones": zones.iter().map(region_json).collect::<Vec<_>>(),
                "cells": zones.iter().map(|z| rects_json(&sb::static_bright_cells(&thumbs, &z.rect, &o))).collect::<Vec<_>>(),
                "panels": zones.iter().map(|z| match sb::panel_signature(&thumbs, &z.rect) {
                    Some(p) => json!({ "sig": p.to_json(), "presence": thumbs.iter().map(|t| crate::n(sb::panel_presence(t, &p))).collect::<Vec<_>>() }),
                    None => Value::Null,
                }).collect::<Vec<_>>(),
            });
            same(
                &got,
                &c["output"]["ok"],
                &format!("zones fixes {m} ({min_agree})"),
            );
            n += 1;
        }
    }
    assert_eq!(n, 6);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn localisation_et_lecture_rejouees_comme_node() {
    if !ffmpeg_ok() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let engine = Replay::default();
    let runs = fixture()["runs"].as_array().unwrap();
    let shas = fixture()["frameShas"].as_object().unwrap();
    let mut locations: HashMap<String, ScoreboardLocation> = HashMap::new();
    let mut reads = 0;
    for run in runs.iter().filter(|r| r["kind"] == "reel") {
        let m = run["match"].as_str().unwrap();
        let files = run["files"].as_array().unwrap();
        let frames: Vec<Vec<u8>> = files
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let png = frame(f.as_str().unwrap(), i as u64 + 1);
                assert_eq!(
                    shas[&format!("{}|{}", f.as_str().unwrap(), i + 1)],
                    sha(&png),
                    "image {f} identique à Node"
                );
                png
            })
            .collect();
        let loc = sb::locate_scoreboard(&engine, &frames, &Default::default()).await;
        same_locate(&loc, &run["locate"], &format!("{m} : localisation"));
        let location = loc.location.clone().expect("bandeau localisé");
        for (i, f) in frames.iter().enumerate() {
            let r = sb::read_scoreboard(&engine, f, Some(&location)).await;
            same(
                &sb::reading_json(r.as_ref()),
                &run["reads"][i],
                &format!("{m} : lecture de {}", files[i]),
            );
            reads += 1;
        }
        locations.insert(m.into(), location);
    }
    // Plans sans bandeau : mêmes localisations (la case de période retenue en dernier compte).
    let vide = runs.iter().find(|r| r["kind"] == "vide").unwrap();
    let mut cache: HashMap<String, Vec<u8>> = HashMap::new();
    for e in vide["reads"].as_array().unwrap() {
        let file = e["file"].as_str().unwrap();
        let seed = e["seed"].as_u64().unwrap();
        let png = cache
            .entry(format!("{file}|{seed}"))
            .or_insert_with(|| frame(file, seed))
            .clone();
        let loc = e["loc"].as_str().map(|m| &locations[m]);
        let r = sb::read_scoreboard(&engine, &png, loc).await;
        same(
            &sb::reading_json(r.as_ref()),
            &e["reading"],
            &format!("plan sans bandeau {file} ({:?})", e["loc"]),
        );
        reads += 1;
    }
    assert_eq!(reads, 22 + vide["reads"].as_array().unwrap().len());
    let missing = engine.missing.lock().unwrap().clone();
    assert!(
        missing.is_empty(),
        "{} appels OCR inconnus de Node, dont {:?}",
        missing.len(),
        &missing[..missing.len().min(3)]
    );
    println!(
        "[mesure] vraies images : {} appels OCR rejoués, tous connus de Node",
        engine.calls.load(Ordering::SeqCst)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_synthetiques_rejouees_comme_node() {
    let font = fixture()["font"].as_str().unwrap_or("");
    if !ffmpeg_ok() || font.is_empty() || !std::path::Path::new(font).exists() {
        eprintln!("ffmpeg ou police {font:?} absents : test sauté");
        return;
    }
    let engine = Replay::default();
    let mut n = 0;
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
                for (i, f) in frames.iter().enumerate() {
                    assert_eq!(run["shas"][i], sha(f), "{layout} : image identique à Node");
                }
                let loc = sb::locate_scoreboard(&engine, &frames, &Default::default()).await;
                same_locate(&loc, &run["locate"], &format!("{layout} : localisation"));
                let probe = render_scene(&run["probeSpec"], font);
                assert_eq!(run["probeSha"], sha(&probe));
                let r = sb::read_scoreboard(&engine, &probe, loc.location.as_ref()).await;
                same(
                    &sb::reading_json(r.as_ref()),
                    &run["read"],
                    &format!("{layout} : lecture"),
                );
                assert!(
                    r.is_some_and(|r| r.period == Some(4.0) && r.clock_sec == 43.0),
                    "{layout} : 4e période, 0:43"
                );
                n += 1;
            }
            "synthetique-repli" => {
                let png = render_scene(&run["spec"], font);
                assert_eq!(run["sha"], sha(&png));
                let r = sb::read_scoreboard(&engine, &png, None).await;
                same(
                    &sb::reading_json(r.as_ref()),
                    &run["read"],
                    "repli pleine largeur",
                );
                n += 1;
            }
            "synthetique-vide" => {
                let png = render_scene(&run["spec"], font);
                assert_eq!(run["sha"], sha(&png));
                let loc = sb::locate_scoreboard(&engine, &[png], &Default::default()).await;
                same_locate(&loc, &run["locate"], "sans bandeau");
                assert!(loc.location.is_none());
                n += 1;
            }
            _ => {}
        }
    }
    assert_eq!(n, 6);
    let missing = engine.missing.lock().unwrap().clone();
    assert!(
        missing.is_empty(),
        "{} appels OCR inconnus de Node",
        missing.len()
    );
}

#[test]
fn localisation_en_cache_relue() {
    // Une localisation relue dans le cache de Node redonne le même JSON.
    let run = fixture()["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "reel")
        .unwrap();
    let v = &run["locate"]["location"];
    let loc = ScoreboardLocation::from_json(v).unwrap();
    assert_eq!(
        loc.to_json().to_string(),
        js_normalize(v.clone()).to_string()
    );
    let _ = Map::<String, Value>::new();
}
