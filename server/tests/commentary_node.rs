//! File de traduction (étape 6b) comparée à Node : `fixtures/commentary.expected.json`
//! contient les sorties du code TypeScript (`node-fixtures-commentary.mts`) —
//! découpage, ordre et couverture des tronçons, sources audio, backoff,
//! requêtes des tables de la traduction, travaux complets avec de faux
//! transcripteur et traducteur (lignes de la base, avancement, appels,
//! résultat, statut), et statuts de la file dans chaque état. Les statuts
//! sont comparés À L'OCTET (ordre des clés compris), le reste comme valeurs
//! JSON.

#[path = "helpers/commentary_kit.rs"]
mod kit;

use basketland_server::commentary_db as cdb;
use basketland_server::db::Db;
use basketland_server::media::commentary::{
    self as cm, ChunkPlan, Commentary, CommentaryControl, CommentaryDeps, CommentaryError,
    CommentaryOutcome, CommentaryRecord, EnqueueOptions, FailureKind, Job, ProgressFn, Runner,
    StreamInfo,
};
use basketland_server::media::commentary_ai::Service;
use basketland_server::media::{abort::AbortSignal, commentary_cues::Cue};
use basketland_server::okru::{Mp4Source, Variant};
use kit::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const A: i64 = 402000001;
const B: i64 = 402000002;
const C: i64 = 402000003;

fn fx(k: &str) -> &'static Value {
    &fixture()[k]
}

/// Égalité des JSON sérialisés (ordre des clés compris).
fn same_bytes(got: &Value, want: &Value, what: &str) {
    assert_eq!(got.to_string(), want.to_string(), "{what}");
}

fn n(x: f64) -> Value {
    basketland_server::api::js_num_value(x)
}

fn plan_json(p: &ChunkPlan) -> Value {
    json!({
        "index": p.index, "start": n(p.start), "length": n(p.length), "keepFrom": n(p.keep_from),
        "keepTo": if p.keep_to.is_finite() { n(p.keep_to) } else { Value::Null },
    })
}

// ------------------------------------------------------------------ fonctions pures

#[test]
fn decoupage_ordre_et_couverture_comme_node() {
    for c in fx("plans").as_array().unwrap() {
        let d = c["duration"].as_f64().unwrap();
        let s = c["chunkSec"].as_f64().unwrap();
        let o = c["overlap"].as_f64();
        let got: Vec<Value> = cm::plan_chunks(d, s, o).iter().map(plan_json).collect();
        assert_eq!(Value::from(got), c["plans"], "planChunks({d}, {s}, {o:?})");
    }
    let pa = cm::plan_chunks(1300.0, 600.0, None);
    let pb = cm::plan_chunks(7480.0, 120.0, None);
    for c in fx("order").as_array().unwrap() {
        let (p, dur) = if c["which"] == "a" {
            (&pa, 1300.0)
        } else {
            (&pb, 7480.0)
        };
        let done: HashSet<usize> = c["done"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as usize)
            .collect();
        let t = c["target"].as_f64().unwrap();
        let got = json!({
            "which": c["which"], "done": c["done"], "target": c["target"],
            "next": cm::next_chunk(p, &done, t).map(|x| x.index),
            "at": cm::chunk_at(p, t),
            "covered": n(cm::covered_from(p, &done, t, dur)),
        });
        assert_eq!(&got, c, "ordre");
    }
}

fn cue_json(c: &cm::ChunkCue) -> Value {
    let mut v = json!({ "seq": c.seq, "start": n(c.start), "end": n(c.end), "text": c.text });
    if let Some(e) = c.emphasis {
        v["emphasis"] = json!(e);
    }
    v
}

#[test]
fn sous_titres_d_un_troncon_comme_node() {
    let plans = cm::plan_chunks(DURATION, CHUNK, None);
    for i in 0..3 {
        let got: Vec<Value> = cm::chunk_cues(&plans[i], &fake_transcript(&plans, i), None)
            .iter()
            .map(cue_json)
            .collect();
        assert_eq!(Value::from(got), fx("chunkCues")[i], "chunkCues {i}");
    }
    let chunks: Vec<_> = (0..3)
        .map(|i| (plans[i], fake_transcript(&plans, i)))
        .collect();
    let got: Vec<Value> = cm::cues_from_chunks(&chunks, None)
        .iter()
        .map(Cue::to_json)
        .collect();
    assert_eq!(Value::from(got), *fx("cuesFromChunks"));
}

fn stream_of(v: &Value) -> StreamInfo {
    StreamInfo {
        variants: v["variants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Variant {
                key: x["key"].as_str().unwrap().into(),
                bandwidth: x["bandwidth"].as_f64().unwrap(),
                resolution: x["resolution"].as_str().unwrap().into(),
                url: x["url"].as_str().unwrap().into(),
            })
            .collect(),
        mp4: v["mp4"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| Mp4Source {
                        name: x["name"].as_str().unwrap().into(),
                        url: x["url"].as_str().unwrap().into(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        duration: None,
    }
}

fn source_json(s: &cm::AnalysisSource) -> Value {
    json!({
        "kind": if s.kind == cm::SourceKind::Hls { "hls" } else { "mp4" },
        "url": s.url, "label": s.label, "height": s.height.map(n),
    })
}

#[test]
fn sources_audio_et_backoff_comme_node() {
    for c in fx("sources").as_array().unwrap() {
        let s = stream_of(&c["stream"]);
        let audio: Vec<Value> = cm::audio_sources(&s).iter().map(source_json).collect();
        assert_eq!(Value::from(audio), c["audio"], "audioSources {}", c["name"]);
        let analysis: Vec<Value> = cm::analysis_sources(&s).iter().map(source_json).collect();
        assert_eq!(
            Value::from(analysis),
            c["analysis"],
            "analysisSources {}",
            c["name"]
        );
        assert_eq!(
            cm::pick_analysis_source(&s)
                .as_ref()
                .map_or(Value::Null, source_json),
            c["pick"],
            "pickAnalysisSource {}",
            c["name"]
        );
        assert_eq!(
            cm::pick_audio_source(&s)
                .as_ref()
                .map_or(Value::Null, source_json),
            c["pickAudio"],
            "pickAudioSource {}",
            c["name"]
        );
    }
    for c in fx("backoff").as_array().unwrap() {
        let k = c["n"].as_i64().unwrap();
        assert_eq!(n(cm::backoff_ms(k)), c["backoff"]);
        assert_eq!(n(cm::network_backoff_ms(k)), c["network"]);
    }
    let cases = fx("retry").as_array().unwrap();
    assert!(cases.len() > 200);
    for c in cases {
        let rec = CommentaryRecord::from_json(&c["rec"]);
        let got = cm::commentary_retry_allowed(
            rec.as_ref(),
            c["okId"].as_str(),
            c["now"].as_f64().unwrap(),
        );
        assert_eq!(Value::from(got), c["allowed"], "commentaryRetryAllowed {c}");
    }
}

#[tokio::test]
async fn dossiers_de_travail_comme_node() {
    let _g = LOCK.lock().await;
    let dir = env_setup();
    for c in fx("workDir").as_array().unwrap() {
        let got = cm::work_dir(c["id"].as_str().unwrap());
        let rel = got
            .strip_prefix(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(Value::from(rel), c["dir"], "workDir {}", c["id"]);
    }
}

// ------------------------------------------------------------------ requêtes

fn cue_input(seq: i64, s: f64, en: &str, u: bool, e: f64) -> cdb::CueInput {
    cdb::CueInput {
        seq,
        start_ts: s,
        end_ts: s + 2.0,
        text_en: en.into(),
        text_fr: format!("FR {en}"),
        untranslated: u,
        emphasis: e,
    }
}

fn reset_db(dir: &tempfile::TempDir) -> Db {
    let db = fresh_db(dir.path());
    for id in [A, B, C] {
        insert_match(&db, id, Some(DURATION));
    }
    db
}

#[tokio::test]
async fn tables_de_la_traduction_comme_node() {
    let _g = LOCK.lock().await;
    let dir = env_setup();
    let db = reset_db(&dir);
    let meta = cdb::CommentaryTrackMeta {
        ok_id: ok_id(&db, A),
        transcribe_model: "w".into(),
        translate_model: "m".into(),
        chunk_sec: Some(60.0),
        chunks_total: Some(5.0),
    };
    let want = fx("coverage");
    let mut steps = Vec::new();
    for (idx, from, to) in [
        (2usize, 120.0, 180.0),
        (0, 0.0, 60.0),
        (4, 240.0, f64::INFINITY),
        (3, 180.0, 240.4),
        (1, 60.2, 120.0),
    ] {
        let base = cdb::chunk_seq_base(idx);
        let cues = [
            cue_input(
                base + 1,
                from + 5.0,
                &format!("line {idx}a"),
                idx == 3,
                idx as f64,
            ),
            cue_input(base + 2, from + 20.0, &format!("line {idx}b"), false, 2.6),
        ];
        let chunk = cdb::PublishedChunk {
            idx,
            keep_from: from,
            keep_to: to,
        };
        let (done, complete) = db
            .with(|c| cdb::publish_commentary_chunk(c, A, &meta, chunk, &cues))
            .unwrap();
        let cov = db.with(|c| cdb::commentary_coverage(c, A)).unwrap();
        let progress = db
            .with(|c| cdb::commentary_progress_by_ids(c, &[A, B, A]))
            .unwrap();
        steps.push(json!({
            "idx": idx,
            "res": { "done": done, "complete": complete },
            "coverage": cov.iter().map(|[a, b]| json!([n(*a), n(*b)])).collect::<Vec<_>>(),
            "until": n(db.with(|c| cdb::commentary_published_until(c, A)).unwrap()),
            "before": db.with(|c| cdb::commentary_cues_before(c, A, from + 21.0, 5, None)).unwrap(),
            "progress": progress.iter().map(|(id, p)| json!([id, { "complete": p.complete, "done": p.done, "total": n(p.total) }])).collect::<Vec<_>>(),
        }));
    }
    assert_eq!(Value::from(steps), want["steps"]);
    db.with(|c| cdb::set_commentary_cue_translation(c, A, cdb::chunk_seq_base(3) + 1, "enfin"))
        .unwrap();
    assert_eq!(snapshot(&db), want["after"]);
    let ready: Vec<i64> = db
        .with(|c| cdb::commentary_ready_ids(c, &[A, B]))
        .unwrap()
        .into_iter()
        .collect();
    assert_eq!(Value::from(ready), want["ready"]);
    let untranslated: Vec<Value> = db
        .with(|c| cdb::untranslated_commentary_cues(c, A))
        .unwrap()
        .into_iter()
        .map(|c| {
            json!({
                "match_id": c.match_id, "seq": c.seq, "start_ts": n(c.start_ts), "end_ts": n(c.end_ts),
                "text_en": c.text_en, "text_fr": c.text_fr, "untranslated": c.untranslated, "emphasis": c.emphasis,
            })
        })
        .collect();
    assert_eq!(Value::from(untranslated), want["untranslated"]);
}

// ------------------------------------------------------------------ travaux complets

fn outcome_json(r: &Result<CommentaryOutcome, CommentaryError>) -> Value {
    match r {
        Ok(o) => {
            let mut v = json!({ "ok": o.ok });
            if let Some(k) = o.kind {
                v["kind"] = json!(k.as_str());
            }
            if o.paused {
                v["paused"] = json!(true);
            }
            v["reason"] = json!(o.reason);
            json!({ "ok": v })
        }
        Err(e) => json!({
            "err": e.message(),
            "service": match e {
                CommentaryError::Service(s) => Value::from(if s.service == Service::Transcription { "transcription" } else { "traduction" }),
                CommentaryError::Other(_) => Value::Null,
            },
        }),
    }
}

fn ctl(
    target: impl Fn() -> f64 + Send + Sync + 'static,
    keep_going: impl Fn() -> bool + Send + Sync + 'static,
) -> CommentaryControl {
    CommentaryControl {
        keep_going: Arc::new(keep_going),
        target: Arc::new(target),
        watching: None,
        playing: None,
    }
}

struct Ctx {
    db: Db,
    svc: Commentary,
}

async fn step(
    x: &Ctx,
    label: &str,
    force: bool,
    deps: &CommentaryDeps,
    calls: &CallsRef,
    control: Option<CommentaryControl>,
) -> Value {
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let ev = events.clone();
    let progress: ProgressFn = Arc::new(move |p| ev.lock().unwrap().push(fmt_progress(&p)));
    let r = x
        .svc
        .run_commentary(
            &Job::new(A, force),
            progress,
            AbortSignal::new(),
            deps,
            &control.unwrap_or_else(CommentaryControl::run_to_end),
        )
        .await;
    let dir = cm::work_dir(&ok_id(&x.db, A));
    let mut c = calls.lock().unwrap().clone();
    c.extract.sort();
    let work = std::fs::read_dir(&dir).ok().map(|d| {
        let mut v: Vec<String> = d
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    });
    let events = events.lock().unwrap().clone();
    json!({
        "label": label,
        "outcome": outcome_json(&r),
        "events": events,
        "calls": { "extract": c.extract, "transcribe": c.transcribe, "translated": c.translated, "events": c.events, "hotwords": c.hotwords },
        "db": snapshot(&x.db),
        "status": x.svc.status(A).to_json(),
        "served": x.svc.served_cues(A).iter().map(|c| c.seq).collect::<Vec<_>>(),
        "ready": x.svc.ready(A),
        "leftoversPending": x.svc.leftovers_pending(A),
        "workDir": work,
    })
}

fn check_step(got: &Value, want: &Value, scenario: &str) {
    let label = want["label"].as_str().unwrap();
    for k in [
        "outcome",
        "events",
        "calls",
        "db",
        "served",
        "ready",
        "leftoversPending",
        "workDir",
        "full",
        "cuts",
    ] {
        assert_eq!(got[k], want[k], "{scenario} / {label} : {k}");
    }
    same_bytes(
        &got["status"],
        &want["status"],
        &format!("{scenario} / {label} : statut"),
    );
}

fn want_run(name: &str) -> &'static Vec<Value> {
    fx("runs")
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap_or_else(|| panic!("scénario {name}"))["steps"]
        .as_array()
        .unwrap()
}

fn new_ctx(dir: &tempfile::TempDir) -> Ctx {
    let db = reset_db(dir);
    let (deps, _) = fake_deps(Fake::default());
    let (svc, _) = service(&db, deps);
    Ctx { db, svc }
}

fn untranslatable() -> Option<Regex> {
    Some(Regex::new("^Timeout").unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn travaux_complets_comme_node() {
    let _g = LOCK.lock().await;
    let mut seen = 0;
    macro_rules! scenario {
        ($name:expr, |$x:ident| $body:block) => {{
            let dir = env_setup();
            set_env("COMMENTARY_CHUNK_SEC", &CHUNK.to_string());
            let $x = new_ctx(&dir);
            let got: Vec<Value> = $body;
            let want = want_run($name);
            assert_eq!(got.len(), want.len(), "{} : nombre d'étapes", $name);
            for (g, w) in got.iter().zip(want) {
                check_step(g, w, $name);
            }
            seen += 1;
        }};
    }

    scenario!("complet", |x| {
        let (d, c) = fake_deps(Fake::default());
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("saut", |x| {
        let target = Arc::new(Mutex::new(700.0));
        let t2 = target.clone();
        let (d, c) = fake_deps(Fake {
            after_chunk: Some(Arc::new(move |idx| {
                if idx == 1 {
                    *t2.lock().unwrap() = 1250.0;
                }
            })),
            ..Default::default()
        });
        let t3 = target.clone();
        vec![
            step(
                &x,
                "run",
                false,
                &d,
                &c,
                Some(ctl(move || *t3.lock().unwrap(), || true)),
            )
            .await,
        ]
    });
    scenario!("pause-reprise", |x| {
        let watching = Arc::new(Mutex::new(true));
        let w2 = watching.clone();
        let (d, c) = fake_deps(Fake {
            after_chunk: Some(Arc::new(move |_| *w2.lock().unwrap() = false)),
            ..Default::default()
        });
        let w3 = watching.clone();
        let a = step(
            &x,
            "pause",
            false,
            &d,
            &c,
            Some(ctl(|| 700.0, move || *w3.lock().unwrap())),
        )
        .await;
        let (d, c) = fake_deps(Fake::default());
        let b = step(&x, "reprise", false, &d, &c, Some(ctl(|| 0.0, || true))).await;
        vec![a, b]
    });
    scenario!("panne-transcription", |x| {
        let (d, c) = fake_deps(Fake {
            fail_transcribe_at: Some(2),
            ..Default::default()
        });
        let a = step(&x, "panne", false, &d, &c, None).await;
        let (d, c) = fake_deps(Fake::default());
        vec![a, step(&x, "reprise", false, &d, &c, None).await]
    });
    scenario!("relance-forcee", |x| {
        let (d, c) = fake_deps(Fake::default());
        let a = step(&x, "premier", false, &d, &c, None).await;
        let (d, c) = fake_deps(Fake::default());
        vec![a, step(&x, "force", true, &d, &c, None).await]
    });
    scenario!("intraduisible", |x| {
        let (d, c) = fake_deps(Fake {
            untranslatable: untranslatable(),
            ..Default::default()
        });
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("intraduisible-reprise", |x| {
        let watching = Arc::new(Mutex::new(true));
        let w2 = watching.clone();
        let (d, c) = fake_deps(Fake {
            untranslatable: untranslatable(),
            after_chunk: Some(Arc::new(move |_| *w2.lock().unwrap() = false)),
            ..Default::default()
        });
        let w3 = watching.clone();
        let a = step(
            &x,
            "pause",
            false,
            &d,
            &c,
            Some(ctl(|| 0.0, move || *w3.lock().unwrap())),
        )
        .await;
        let (d, c) = fake_deps(Fake::default());
        vec![a, step(&x, "reprise", false, &d, &c, None).await]
    });
    scenario!("rattrapage-seul", |x| {
        let (d, c) = fake_deps(Fake {
            untranslatable: untranslatable(),
            ..Default::default()
        });
        let a = step(&x, "piste", false, &d, &c, None).await;
        x.db.with(|c| {
            basketland_server::db::kv_set(
                c,
                &format!("commentary-leftovers:{A}"),
                &json!({ "okId": "ancien", "model": "ancien" }),
            )
        })
        .unwrap();
        let (d, c) = fake_deps(Fake::default());
        vec![a, step(&x, "rattrapage", false, &d, &c, None).await]
    });
    for (name, at) in [("flux-inaccessible", 0), ("flux-inaccessible-2", 1)] {
        scenario!(name, |x| {
            let (d, c) = fake_deps(Fake {
                fail_extract_at: Some(at),
                ..Default::default()
            });
            vec![step(&x, "run", false, &d, &c, None).await]
        });
    }
    scenario!("aucune-parole", |x| {
        let (d, c) = fake_deps(Fake {
            no_speech: true,
            ..Default::default()
        });
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("avance-max", |x| {
        set_env("COMMENTARY_MAX_LEAD_SEC", "500");
        set_env("COMMENTARY_LEAD_POLL_MS", "5");
        let checks = Arc::new(Mutex::new(0));
        let (d, c) = fake_deps(Fake::default());
        let k = checks.clone();
        let control = CommentaryControl {
            keep_going: Arc::new(move || {
                let mut n = k.lock().unwrap();
                *n += 1;
                *n < 20
            }),
            target: Arc::new(|| 0.0),
            watching: Some(Arc::new(|| true)),
            playing: Some(Arc::new(|| true)),
        };
        vec![step(&x, "run", false, &d, &c, Some(control)).await]
    });
    let roster = |x: &Ctx, names: &[&str]| {
        let players: Vec<_> = names
            .iter()
            .enumerate()
            .map(|(i, name)| basketland_server::espn_events::PlayerStatRow {
                team_abbr: if i == 0 { "BOS" } else { "MIN" }.into(),
                player_id: i.to_string(),
                player_name: name.to_string(),
                position: "G".into(),
                jersey: i.to_string(),
                starter: 1.0,
                stats: json!({}),
            })
            .collect();
        x.db.with(|c| basketland_server::ingest_db::replace_stats(c, A, &[], &players, &[]))
            .unwrap();
    };
    scenario!("effectif", |x| {
        roster(&x, &["Jaylen Brown", "Mike Conley", "Jaylen Brown", ""]);
        let (d, c) = fake_deps(Fake::default());
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("effectif-sans-hotwords", |x| {
        set_env("WHISPER_HOTWORDS", "0");
        roster(&x, &["Jaylen Brown"]);
        let (d, c) = fake_deps(Fake::default());
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("tronçons-120", |x| {
        set_env("COMMENTARY_CHUNK_SEC", "120");
        let (d, c) = fake_deps(Fake::default());
        vec![step(&x, "run", false, &d, &c, None).await]
    });
    scenario!("son-complet", |x| {
        set_env("COMMENTARY_FULL_AUDIO_POLL_MS", "5");
        let mut out = Vec::new();
        for (label, wants, force) in [("sans-doublage", false, false), ("doublage", true, true)] {
            x.svc.set_dub_wants_audio(Some(Arc::new(move |_| wants)));
            let (mut d, c) = fake_deps(Fake::default());
            let full = Arc::new(Mutex::new(Vec::<String>::new()));
            let cuts = Arc::new(Mutex::new(Vec::<f64>::new()));
            let f2 = full.clone();
            d.extract_full = Some(Arc::new(move |url, out, _o, progress| {
                // Partie synchrone de la fonction async de Node : le début est là tout de suite.
                f2.lock().unwrap().push(url);
                std::fs::write(&out, vec![0u8; 4096]).unwrap();
                progress(700.0);
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    progress(DURATION);
                    Ok(())
                })
            }));
            let c2 = cuts.clone();
            d.cut = Some(Arc::new(move |file, start, _len, out, _sig| {
                // `expect(fs.existsSync(file))` de Node : un échec rejette la découpe.
                if !std::path::Path::new(&file).exists() {
                    return Box::pin(async move { Err(format!("{file} absent")) });
                }
                c2.lock().unwrap().push(start);
                Box::pin(
                    async move { std::fs::write(&out, vec![0u8; 4096]).map_err(|e| e.to_string()) },
                )
            }));
            let mut s = step(&x, label, force, &d, &c, None).await;
            let mut cuts = cuts.lock().unwrap().clone();
            cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
            s["full"] = json!(full.lock().unwrap().clone());
            s["cuts"] = json!(cuts.into_iter().map(n).collect::<Vec<_>>());
            out.push(s);
        }
        out
    });
    assert_eq!(
        seen,
        fx("runs").as_array().unwrap().len(),
        "tous les scénarios de Node"
    );
}

// ------------------------------------------------------------------ statuts de la file

type Gates = Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<CommentaryOutcome>>>>;

fn outcome(ok: bool, kind: Option<FailureKind>, paused: bool, reason: &str) -> CommentaryOutcome {
    CommentaryOutcome {
        ok,
        reason: reason.into(),
        kind,
        paused,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn statuts_de_la_file_comme_node() {
    let _g = LOCK.lock().await;
    let dir = env_setup();
    let db = reset_db(&dir);
    let (deps, _) = fake_deps(Fake::default());
    let (svc, _) = service(&db, deps);
    let want = fx("queue");
    let gates: Gates = Arc::default();
    let progress_of: Arc<Mutex<Option<ProgressFn>>> = Arc::default();
    let runner: Runner = {
        let (gates, progress_of) = (gates.clone(), progress_of.clone());
        Arc::new(move |job: Job, progress, _signal, _ctl| {
            *progress_of.lock().unwrap() = Some(progress);
            let (tx, rx) = tokio::sync::oneshot::channel();
            gates.lock().unwrap().insert(job.match_id, tx);
            Box::pin(async move {
                Ok(rx
                    .await
                    .unwrap_or_else(|_| outcome(true, None, false, "abandon")))
            })
        })
    };
    svc.set_runner(Some(runner.clone()));
    let resolve = |id: i64, o: CommentaryOutcome| {
        let tx = gates.lock().unwrap().remove(&id).expect("travail en cours");
        let _ = tx.send(o);
    };
    let progress = |p: cm::CommentaryProgress| (progress_of.lock().unwrap().clone().unwrap())(p);
    let statuses = want["statuses"].as_array().unwrap();
    let mut k = 0;
    let mut snap = |label: &str, ids: &[i64]| {
        let w = &statuses[k];
        assert_eq!(w["label"], label);
        for id in ids {
            same_bytes(
                &svc.status(*id).to_json(),
                &w["status"][id.to_string()],
                &format!("{label} : statut de {id}"),
            );
        }
        assert_eq!(
            svc.activity().to_json(),
            w["activity"],
            "{label} : activité"
        );
        let q: Vec<Option<usize>> = ids.iter().map(|id| svc.queue_position(*id)).collect();
        assert_eq!(json!(q), w["queue"], "{label} : file");
        k += 1;
    };
    let abc = [A, B, C];
    let mut results = Vec::new();
    let enq = |id: i64, priority: bool, force: bool, explicit: bool| {
        svc.enqueue(
            id,
            EnqueueOptions {
                priority,
                force,
                explicit,
            },
        )
        .to_json()
    };
    let pause = || tokio::time::sleep(Duration::from_millis(60));

    results.push(enq(A, false, false, false));
    snap("en cours sans avancement", &abc);
    progress(cm::CommentaryProgress {
        phase: cm::CommentaryPhase::Transcription,
        done: 2.0,
        total: 3.0,
        available_until: None,
    });
    snap("en cours", &abc);
    progress(cm::CommentaryProgress {
        phase: cm::CommentaryPhase::Traduction,
        done: 1.0,
        total: 3.0,
        available_until: Some(600.0),
    });
    snap("en cours avec disponible", &abc);
    results.push(enq(B, false, false, false));
    results.push(enq(C, false, false, false));
    results.push(enq(B, false, false, false));
    results.push(enq(C, true, false, false));
    results.push(enq(A, false, false, true));
    snap("en file", &abc);
    let meta = cdb::CommentaryTrackMeta {
        ok_id: ok_id(&db, B),
        transcribe_model: "deepdml/faster-whisper-large-v3-turbo-ct2".into(),
        translate_model: "translategemma:12b".into(),
        chunk_sec: Some(600.0),
        chunks_total: Some(3.0),
    };
    let cue = |seq, s: f64, e: f64, en: &str, fr: &str, u| cdb::CueInput {
        seq,
        start_ts: s,
        end_ts: e,
        text_en: en.into(),
        text_fr: fr.into(),
        untranslated: u,
        emphasis: 0.0,
    };
    db.with(|c| {
        cdb::publish_commentary_chunk(
            c,
            B,
            &meta,
            cdb::PublishedChunk {
                idx: 0,
                keep_from: 0.0,
                keep_to: 600.0,
            },
            &[cue(100001, 10.0, 12.0, "Hi", "Salut", false)],
        )?;
        cdb::publish_commentary_chunk(
            c,
            B,
            &meta,
            cdb::PublishedChunk {
                idx: 2,
                keep_from: 1200.0,
                keep_to: f64::INFINITY,
            },
            &[cue(300001, 1210.0, 1212.0, "Bye", "Au revoir", true)],
        )
    })
    .unwrap();
    snap("en file, piste partielle", &abc);
    svc.touch_viewer(B, Some(1250.0));
    snap("en file, spectateur à 1250", &abc);
    svc.touch_viewer(B, Some(700.0));
    snap("en file, spectateur à 700", &abc);
    resolve(A, outcome(false, Some(FailureKind::Contenu), false, "vide"));
    pause().await;
    snap("A interrompu (remis en file), C en cours", &abc);
    resolve(C, outcome(true, None, false, "ok"));
    pause().await;
    snap("B en cours, A explicite en attente", &abc);
    resolve(B, outcome(false, None, true, "en pause"));
    pause().await;
    snap("A attend la fin de la lecture de B", &abc);
    svc.set_runner(Some(runner.clone()));
    snap("file vidée", &abc);
    results.push(enq(A, false, true, false));
    resolve(A, outcome(false, Some(FailureKind::Erreur), false, "boum"));
    svc.idle().await;
    results.push(enq(B, false, false, false));
    resolve(B, outcome(false, Some(FailureKind::Reseau), false, "flux"));
    svc.idle().await;
    snap("échecs", &abc);
    results.push(enq(B, false, false, false));
    resolve(
        B,
        outcome(false, Some(FailureKind::Reseau), false, "flux 2"),
    );
    svc.idle().await;
    results.push(enq(C, false, false, false));
    resolve(C, outcome(false, None, false, "sans nature"));
    svc.idle().await;
    snap("échecs répétés", &abc);
    results.push(enq(A, false, true, false));
    resolve(A, outcome(true, None, false, "ok"));
    svc.idle().await;
    let full = |id: i64, cues: &[cdb::CueInput]| {
        let meta = cdb::CommentaryTrackMeta {
            ok_id: ok_id(&db, id),
            transcribe_model: "w".into(),
            translate_model: "m".into(),
            chunk_sec: None,
            chunks_total: None,
        };
        db.with(|c| cdb::replace_commentary(c, id, &meta, cues))
            .unwrap();
    };
    full(A, &[cue(1, 1.0, 2.0, "Hi", "Salut", false)]);
    full(
        C,
        &[
            cue(1, 1.0, 2.0, "Hi", "Salut", false),
            cue(2, 3.0, 4.0, "Yo", "Yo", true),
        ],
    );
    snap("prêtes", &abc);
    results.push(enq(A, false, false, false));
    results.push(enq(C, false, false, false));
    snap("rattrapage en cours (C prête à l’écran)", &abc);
    resolve(C, outcome(true, None, false, "rattrapage"));
    svc.idle().await;
    db.with(|c| {
        basketland_server::ingest_db::set_video(
            c,
            B,
            &basketland_server::ingest_db::VideoUpdate {
                slug: None,
                ok_id: None,
                duration: None,
                available: false,
                kind: None,
            },
        )
    })
    .unwrap();
    results.push(enq(B, false, false, false));
    results.push(enq(999, false, false, false));
    snap("sans replay", &[B, 999]);
    set_env("COMMENTARY_DISABLED", "1");
    results.push(enq(A, false, false, false));
    snap("inactive", &abc);
    unset_env("COMMENTARY_DISABLED");
    assert_eq!(k, statuses.len());
    for (i, (g, w)) in results
        .iter()
        .zip(want["results"].as_array().unwrap())
        .enumerate()
    {
        same_bytes(g, w, &format!("mise en file n° {i}"));
    }
    assert_eq!(results.len(), want["results"].as_array().unwrap().len());
    assert_eq!(snapshot(&db), want["db"]);
    assert_eq!(json!(svc.disabled_reason()), want["disabled"]);
}
