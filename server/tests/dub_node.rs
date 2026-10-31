//! File de doublage (étape 6b) comparée à Node : `fixtures/dub.expected.json`
//! contient les sorties du code TypeScript (`node-fixtures-dub.mts`) —
//! fonctions pures (calage, phrases, empreintes, locuteurs et voix),
//! arguments de ffmpeg du montage et fichier produit, travaux complets avec
//! le faux moteur de voix de `tests/dub.test.ts` (résultat, avancement,
//! appels, journaux, lignes de la base, fichiers, manifeste) et états de la
//! file, traduction branchée sur le doublage. Manifestes, résultats des
//! demandes et activité sont comparés À L'OCTET (ordre des clés compris).

#[path = "helpers/dub_kit.rs"]
mod dkit;
#[path = "helpers/commentary_kit.rs"]
mod kit;

use basketland_server::api::js_num_value as n;
use basketland_server::commentary_db::{self as cdb, CommentaryCueRow};
use basketland_server::dub_db as ddb;
use basketland_server::ingest_db::{set_video, VideoUpdate};
use basketland_server::media::abort::AbortSignal;
use basketland_server::media::commentary::{CommentaryOutcome, Runner as CommentaryRunner};
use basketland_server::media::dub::{
    self as dub, AssembleClip, AssignOptions, Dub, DubEngine, DubEnqueueOptions, DubFailureKind,
    DubJob, DubOutcome, DubProgress, DubProgressFn, DubRunner, DubYield, SpeakerState, VoiceRole,
};
use dkit::*;
use kit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn fx(k: &str) -> &'static Value {
    &dub_fixture()[k]
}

/// Égalité des JSON (ordre des clés compris, voir `assert_json`).
fn same_bytes(got: &Value, want: &Value, what: &str) {
    assert_json(got, want, what);
}

fn opt(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

// ------------------------------------------------------------------ fonctions pures

#[test]
fn texte_et_calage_comme_node() {
    for c in fx("emphasize").as_array().unwrap() {
        let got = dub::emphasize(c["text"].as_str().unwrap(), opt(&c["emphasis"]));
        assert_eq!(Value::from(got), c["out"], "emphasize {c}");
    }
    for c in fx("fitCue").as_array().unwrap() {
        let f = dub::fit_cue(
            c["duration"].as_f64().unwrap(),
            c["start"].as_f64().unwrap(),
            c["end"].as_f64().unwrap(),
            opt(&c["next"]),
        );
        let got = json!({ "slot": n(f.slot), "tempo": n(f.tempo), "fitted": n(f.fitted), "overrun": f.overrun });
        same_bytes(&got, &c["fit"], &format!("fitCue {c}"));
    }
    for c in fx("placeClips").as_array().unwrap() {
        let clips: Vec<(f64, f64)> = c["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (x["start"].as_f64().unwrap(), x["fitted"].as_f64().unwrap()))
            .collect();
        let got: Vec<Value> = dub::place_clips(&clips, None).into_iter().map(n).collect();
        same_bytes(&Value::from(got), &c["at"], &format!("placeClips {c}"));
    }
    for c in fx("speechRanges").as_array().unwrap() {
        let r: Vec<[f64; 2]> = c["ranges"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| [x[0].as_f64().unwrap(), x[1].as_f64().unwrap()])
            .collect();
        let got: Vec<Value> = dub::speech_ranges(&r, None)
            .iter()
            .map(|[a, b]| json!([n(*a), n(*b)]))
            .collect();
        same_bytes(&Value::from(got), &c["out"], &format!("speechRanges {c}"));
    }
    let todo: Vec<(f64, f64)> = [0.0, 2.0, 3.0]
        .iter()
        .map(|i| {
            (
                i * 120.0,
                if *i == 3.0 {
                    f64::INFINITY
                } else {
                    (i + 1.0) * 120.0
                },
            )
        })
        .collect();
    let idx = [0, 2, 3];
    for c in fx("nextDubChunk").as_array().unwrap() {
        let got = dub::next_dub_chunk(&todo, c["target"].as_f64().unwrap()).map(|k| idx[k]);
        assert_eq!(json!(got), c["idx"], "nextDubChunk {c}");
    }
    for c in fx("downloadText").as_array().unwrap() {
        let got = dub::download_text(c["done"].as_f64().unwrap(), c["total"].as_f64().unwrap());
        assert_eq!(Value::from(got), c["text"], "downloadText {c}");
    }
}

fn cue_row(v: &Value, i: usize) -> CommentaryCueRow {
    CommentaryCueRow {
        match_id: 1,
        seq: v["seq"].as_i64().unwrap_or(i as i64),
        start_ts: v["start_ts"].as_f64().unwrap(),
        end_ts: v["end_ts"].as_f64().unwrap(),
        text_en: "x".into(),
        text_fr: v["text_fr"].as_str().unwrap().into(),
        untranslated: v["untranslated"].as_i64().unwrap(),
        emphasis: v["emphasis"].as_i64().unwrap(),
    }
}

#[test]
fn phrases_et_empreintes_comme_node() {
    for c in fx("groupCues").as_array().unwrap() {
        let cues: Vec<CommentaryCueRow> = c["cues"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, v)| cue_row(v, i))
            .collect();
        let speakers: Vec<Option<i64>> = c["speakers"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_i64)
            .collect();
        let got: Vec<Value> = dub::group_cues(&cues, &speakers, None, None)
            .iter()
            .map(|g| {
                json!({ "idx": g.idx, "text": g.text, "start": n(g.start), "end": n(g.end), "emphasis": n(g.emphasis) })
            })
            .collect();
        same_bytes(&Value::from(got), &c["groups"], &format!("groupCues {c}"));
    }
    for c in fx("cuesSignature").as_array().unwrap() {
        let cues: Vec<CommentaryCueRow> = c["cues"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, v)| cue_row(v, i))
            .collect();
        assert_eq!(
            Value::from(dub::cues_signature(&cues)),
            c["sig"],
            "cuesSignature {c}"
        );
    }
}

fn vec_arg(v: &Value) -> Option<Vec<f64>> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(vec_of(s.chars().next().unwrap())),
        x => Some(basis(x.as_u64().unwrap() as usize)),
    }
}

fn num_arg(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
        x => x.as_f64(),
    }
}

#[tokio::test]
async fn locuteurs_et_voix_comme_node() {
    let _g = LOCK.lock().await;
    let _dir = dub_env();
    for seq in fx("speakers").as_array().unwrap() {
        let name = seq["name"].as_str().unwrap();
        for (k, v) in seq["env"].as_object().unwrap() {
            set_env(k, v.as_str().unwrap());
        }
        let mut st = SpeakerState::default();
        for (op, want) in seq["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(seq["steps"].as_array().unwrap())
        {
            let got = if op[0] == "speakers" {
                let d: Vec<f64> = op[1]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect();
                let e: Vec<Option<Vec<f64>>> =
                    op[2].as_array().unwrap().iter().map(vec_arg).collect();
                let f0: Vec<Option<f64>> = op[3].as_array().unwrap().iter().map(num_arg).collect();
                let fem: Vec<Option<f64>> = op[4].as_array().unwrap().iter().map(num_arg).collect();
                let o = AssignOptions {
                    threshold: op[5]["threshold"].as_f64(),
                    min_new_sec: op[5]["minNewSec"].as_f64(),
                    max_speakers: op[5]["maxSpeakers"].as_f64(),
                };
                let ids = dub::assign_speakers(&mut st, &d, &e, &f0, &fem, o);
                json!({ "ids": ids })
            } else {
                let voices = strs(&op[1]);
                let switched = dub::assign_roles(
                    &mut st,
                    &voices,
                    op.get(2).and_then(Value::as_f64),
                    op.get(3).and_then(Value::as_f64),
                );
                json!({ "switched": switched })
            };
            let mut got = got;
            got["state"] = st.to_json();
            got["used"] = dub::roles_used(&st)
                .iter()
                .map(|r| r.as_str())
                .collect::<Vec<_>>()
                .into();
            same_bytes(&got, want, &format!("locuteurs {name} {op}"));
        }
        for k in seq["env"].as_object().unwrap().keys() {
            unset_env(k);
        }
    }
    for c in fx("voiceFor").as_array().unwrap() {
        let role = VoiceRole::parse(c["role"].as_str().unwrap()).unwrap();
        assert_eq!(
            Value::from(dub::voice_for(role, &strs(&c["voices"]))),
            c["voice"],
            "voiceFor {c}"
        );
    }
}

// ------------------------------------------------------------------ montage

fn has_ffmpeg() -> bool {
    ["ffmpeg", "ffprobe"].iter().all(|b| {
        std::process::Command::new(b)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    })
}

#[tokio::test]
async fn montage_memes_arguments_et_meme_fichier_que_node() {
    let _g = LOCK.lock().await;
    let dir = dub_env();
    let want = fx("assemble");
    let fake = format!(
        "{}/tests/helpers/fake_ffmpeg.sh",
        env!("CARGO_MANIFEST_DIR")
    );
    let log = dir.path().join("ffmpeg-args.txt");
    set_env("FFMPEG_PATH", &fake);
    set_env("FAKE_FFMPEG_LOG", log.to_str().unwrap());
    let out = dir.path().join("chunk.m4a.part");
    let out_s = out.to_string_lossy().into_owned();
    for c in want["args"].as_array().unwrap() {
        let clips: Vec<AssembleClip> = c["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| AssembleClip {
                file: x["file"].as_str().unwrap().into(),
                at: x["at"].as_f64().unwrap(),
                tempo: x["tempo"].as_f64().unwrap(),
            })
            .collect();
        let duration = c["duration"].as_f64().unwrap_or(f64::NAN);
        // Contrat : la fonction pure et le processus lancé.
        let pure: Vec<String> = dub::assemble_args(&clips, duration, &out_s)
            .into_iter()
            .map(|a| if a == out_s { "<out>".into() } else { a })
            .collect();
        assert_eq!(Value::from(pure), c["args"], "arguments {c}");
        dub::assemble_chunk(&clips, duration, &out_s, None)
            .await
            .unwrap();
        let args: Vec<String> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|a| {
                if a == out_s {
                    "<out>".into()
                } else {
                    a.to_string()
                }
            })
            .collect();
        assert_eq!(Value::from(args), c["args"], "ffmpeg lancé {c}");
    }
    unset_env("FFMPEG_PATH");
    unset_env("FAKE_FFMPEG_LOG");
    if !has_ffmpeg() {
        eprintln!("ffmpeg absent : montage réel sauté");
        return;
    }
    let absent = dir.path().join("absent.wav").to_string_lossy().into_owned();
    let err = dub::assemble_chunk(
        &[AssembleClip {
            file: absent,
            at: 0.0,
            tempo: 1.0,
        }],
        1.0,
        &dir.path().join("x.m4a").to_string_lossy(),
        None,
    )
    .await
    .unwrap_err();
    // Adresses des objets internes de ffmpeg (« [in#1 @ 0x…] ») : variables d'un lancement à l'autre.
    let addr = |s: &str| {
        regex::Regex::new(r"@ 0x[0-9a-f]+")
            .unwrap()
            .replace_all(s, "@ 0x…")
            .into_owned()
    };
    let data = dir.path().to_string_lossy().into_owned();
    assert_eq!(
        addr(&err.replacen(&data, "<data>", 1)),
        addr(want["failure"].as_str().unwrap())
    );
    let (a, b) = (dir.path().join("a.wav"), dir.path().join("b.wav"));
    for (f, src) in [
        (&a, "sine=frequency=440:duration=0.5:sample_rate=22050"),
        (&b, "sine=frequency=660:duration=0.4:sample_rate=24000"),
    ] {
        std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", src, "-ac", "1"])
            .arg(f)
            .status()
            .unwrap();
    }
    let o = dir.path().join("real.m4a");
    dub::assemble_chunk(
        &[
            AssembleClip {
                file: a.to_string_lossy().into(),
                at: 1.0,
                tempo: 1.0,
            },
            AssembleClip {
                file: b.to_string_lossy().into(),
                at: 2.5,
                tempo: 1.25,
            },
        ],
        4.0,
        &o.to_string_lossy(),
        None,
    )
    .await
    .unwrap();
    let p = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels,duration_ts:format=duration,format_name,size",
            "-of",
            "json",
        ])
        .arg(&o)
        .output()
        .unwrap();
    let got: Value = serde_json::from_slice(&p.stdout).unwrap();
    same_bytes(&got, &want["probe"], "fichier produit par le vrai ffmpeg");
}

// ------------------------------------------------------------------ travaux complets

struct Ctx {
    _dir: tempfile::TempDir,
    db: Db,
    dub: Dub,
    logs: Logs,
}

use basketland_server::db::Db;

fn reset() -> Ctx {
    let dir = dub_env();
    let db = fresh_db(dir.path());
    insert_match(&db, M, Some(400.0));
    insert_match(&db, M2, Some(400.0));
    let (deps, _, _) = fake(FakeOpts::default());
    let (_c, dub, _clock, logs) = services(&db, deps);
    Ctx {
        _dir: dir,
        db,
        dub,
        logs,
    }
}

fn outcome_json(r: &Result<DubOutcome, String>) -> Value {
    match r {
        Ok(o) => json!({ "ok": o.to_json() }),
        Err(e) => json!({ "err": e }),
    }
}

fn progress_json(p: &DubProgress) -> Value {
    let mut v = json!({ "done": n(p.done), "total": n(p.total) });
    if let Some(c) = p.chunk {
        v["chunk"] = json!(c);
    }
    if let Some(s) = &p.step {
        v["step"] = json!(s);
    }
    v
}

#[derive(Default, Clone)]
struct StepOpts {
    fake: FakeOpts,
    yield_after: Option<usize>,
    target: f64,
}

async fn step(x: &Ctx, label: &str, o: StepOpts) -> Value {
    let (deps, calls, _) = fake(o.fake.clone());
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let ev = events.clone();
    let progress: DubProgressFn = Arc::new(move |p| ev.lock().unwrap().push(progress_json(&p)));
    let r = x
        .dub
        .run_dub(
            &DubJob::new(M),
            progress,
            AbortSignal::new(),
            &deps,
            &ctl(o.yield_after, o.target),
        )
        .await;
    let logs: Vec<Value> = std::mem::take(&mut *x.logs.lock().unwrap())
        .into_iter()
        .map(|(k, l)| json!([k, l]))
        .collect();
    let events = events.lock().unwrap().clone();
    json!({
        "label": label,
        "outcome": outcome_json(&r),
        "events": events,
        "calls": calls.lock().unwrap().to_json(),
        "db": dub_snapshot(&x.db),
        "files": dub_files(M),
        "logs": logs,
        "manifest": manifest_json(&x.dub, M),
    })
}

fn run_opts(f: FakeOpts) -> StepOpts {
    StepOpts {
        fake: f,
        ..Default::default()
    }
}

fn check(got: &[Value], name: &str) {
    let want = fx("runs")
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap_or_else(|| panic!("scénario {name}"))["steps"]
        .as_array()
        .unwrap();
    assert_eq!(got.len(), want.len(), "{name} : nombre d'étapes");
    for (g, w) in got.iter().zip(want) {
        let label = w["label"].as_str().unwrap();
        for k in [
            "outcome",
            "events",
            "calls",
            "db",
            "files",
            "logs",
            "fullAudioKept",
        ] {
            assert_eq!(
                g.get(k).is_some(),
                w.get(k).is_some(),
                "{name} / {label} : {k}"
            );
            same_bytes(&g[k], &w[k], &format!("{name} / {label} : {k}"));
        }
        same_bytes(
            &g["manifest"],
            &w["manifest"],
            &format!("{name} / {label} : manifeste"),
        );
    }
}

fn voices(v: &[&str]) -> Option<Vec<String>> {
    Some(v.iter().map(|s| s.to_string()).collect())
}

const ALL: [&str; 4] = ["A", "B4", "B1", "F"];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn travaux_complets_comme_node() {
    let _g = LOCK.lock().await;
    let (c0, c1, c2) = (
        chunk_lines("CHUNK0"),
        chunk_lines("CHUNK1"),
        chunk_lines("CHUNK2"),
    );
    let mut seen = 0;
    macro_rules! scenario {
        ($name:expr, |$x:ident, $t:ident| $body:block) => {{
            let $x = reset();
            let $t = track_meta(&$x.db, M);
            let got: Vec<Value> = $body;
            check(&got, $name);
            seen += 1;
        }};
    }

    scenario!("partiel", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        publish(&x.db, M, 1, &c1, &t);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    voices: voices(&ALL),
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("stables-puis-complet", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let a = step(&x, "premier", StepOpts::default()).await;
        publish(&x.db, M, 2, &c2, &t);
        publish(&x.db, M, 1, &c1, &t);
        let b = step(
            &x,
            "second",
            StepOpts {
                target: 250.0,
                ..Default::default()
            },
        )
        .await;
        vec![a, b]
    });
    scenario!("bascule-vers-F", |x, t| {
        let late = vec![
            l(2.0, 8.0, "Tatum remonte le ballon.", 'X'),
            l(10.0, 13.0, "Je suis au bord du terrain.", 'W'),
            l(20.0, 26.0, "Il accélère et marque.", 'X'),
            l(125.0, 133.0, "Le coach semble inquiet.", 'W'),
            l(134.0, 140.0, "Panier à trois points.", 'X'),
            l(250.0, 253.0, "On revient au jeu.", 'W'),
        ];
        let o = FakeOpts {
            voices: voices(&ALL),
            script: Some(late.clone()),
            ..Default::default()
        };
        publish(&x.db, M, 0, &late[0..3], &t);
        let a = step(&x, "premier", run_opts(o.clone())).await;
        publish(&x.db, M, 1, &late[3..5], &t);
        publish(&x.db, M, 2, &late[5..], &t);
        vec![a, step(&x, "second", run_opts(o)).await]
    });
    scenario!("sans-classifieur", |x, t| {
        publish(&x.db, M, 1, &c1, &t);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    voices: voices(&ALL),
                    no_gender: true,
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("trop-longue", |x, t| {
        publish(
            &x.db,
            M,
            0,
            &[
                l(10.0, 13.0, "Une très longue phrase qui ne tient pas.", 'X'),
                l(13.8, 16.0, "Suite.", 'X'),
                l(16.2, 17.0, "Encore", 'Y'),
                l(17.1, 18.0, "et encore.", 'Y'),
            ],
            &t,
        );
        let durations = HashMap::from([
            ("Une très longue phrase qui ne tient pas.".to_string(), 6.0),
            ("Encore et encore.".to_string(), 2.7),
        ]);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    durations,
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("replique-en-echec", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let a = step(
            &x,
            "une",
            run_opts(FakeOpts {
                fail_synth: vec!["Le banc se lève.".into()],
                ..Default::default()
            }),
        )
        .await;
        publish(&x.db, M, 1, &c1, &t);
        vec![
            a,
            step(
                &x,
                "toutes",
                run_opts(FakeOpts {
                    fail_synth: vec!["*".into()],
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("synthese-vide", |x, t| {
        publish(&x.db, M, 0, &c0[0..2], &t);
        let durations = HashMap::from([("Tatum remonte le ballon.".to_string(), 0.0)]);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    durations,
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("moteur-indisponible", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    fail_open: true,
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("empreintes-impossibles", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        vec![
            step(
                &x,
                "run",
                run_opts(FakeOpts {
                    fail_embed: true,
                    ..Default::default()
                }),
            )
            .await,
        ]
    });
    scenario!("flux", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let a = step(
            &x,
            "resolution-en-echec",
            run_opts(FakeOpts {
                resolve_fails: 99,
                ..Default::default()
            }),
        )
        .await;
        let b = step(
            &x,
            "resolution-reessayee",
            run_opts(FakeOpts {
                resolve_fails: 1,
                ..Default::default()
            }),
        )
        .await;
        x.db.with(|c| ddb::delete_dub(c, M)).unwrap();
        let c = step(
            &x,
            "sources",
            run_opts(FakeOpts {
                variants: Some(5),
                extract_fails: 4,
                ..Default::default()
            }),
        )
        .await;
        x.db.with(|c| ddb::delete_dub(c, M)).unwrap();
        let d = step(
            &x,
            "sources-toutes-ko",
            run_opts(FakeOpts {
                variants: Some(2),
                extract_fails: 99,
                ..Default::default()
            }),
        )
        .await;
        vec![a, b, c, d]
    });
    scenario!("piste-changee", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let a = step(&x, "premier", StepOpts::default()).await;
        let mut re = c0.clone();
        re[0].2 = "Tatum avance.".into();
        re[0].4 = 0.0;
        re[0].5 = false;
        publish(&x.db, M, 0, &re, &t);
        let b = step(&x, "retraduit", StepOpts::default()).await;
        std::fs::write(dub::dub_dir(M).join("chunk-7.m4a"), "vieux").unwrap();
        let t2 = cdb::CommentaryTrackMeta {
            translate_model: "gemma4:e4b".into(),
            ..t.clone()
        };
        x.db.with(|c| cdb::open_commentary_track(c, M, &t2, false))
            .unwrap();
        publish(&x.db, M, 1, &c1, &t2);
        vec![a, b, step(&x, "nouveau-modele", StepOpts::default()).await]
    });
    scenario!("cede-la-place", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        publish(&x.db, M, 1, &c1, &t);
        let y = |k| StepOpts {
            yield_after: Some(k),
            ..Default::default()
        };
        vec![
            step(&x, "entre-deux-repliques", y(3)).await,
            step(&x, "avant-le-troncon", y(0)).await,
            step(&x, "apres-un-troncon", y(8)).await,
        ]
    });
    scenario!("une-traite", |x, t| {
        let mut ls = vec![
            l(2.0, 4.0, "Curry remonte la balle,", 'X'),
            l(4.2, 6.0, "cherche l’écran", 'X'),
            l(6.3, 8.0, "et déclenche !", 'X'),
            l(8.5, 10.0, "Dedans", 'Y'),
        ];
        ls[2].4 = 2.0;
        ls[3].4 = 1.0;
        publish(&x.db, M, 0, &ls, &t);
        vec![step(&x, "run", StepOpts::default()).await]
    });
    scenario!("son-complet", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let a = step(
            &x,
            "decoupe",
            run_opts(FakeOpts {
                local: Some(true),
                ..Default::default()
            }),
        )
        .await;
        x.db.with(|c| ddb::delete_dub(c, M)).unwrap();
        let b = step(
            &x,
            "absent",
            run_opts(FakeOpts {
                local: Some(false),
                ..Default::default()
            }),
        )
        .await;
        publish(&x.db, M, 1, &c1, &t);
        publish(&x.db, M, 2, &c2, &t);
        let full = basketland_server::media::commentary::full_audio_file(&ok_id(&x.db, M));
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, "ogg").unwrap();
        let mut c = step(
            &x,
            "complet",
            run_opts(FakeOpts {
                local: Some(true),
                ..Default::default()
            }),
        )
        .await;
        c["fullAudioKept"] = json!(full.exists());
        vec![a, b, c]
    });
    scenario!("troncons-sans-replique", |x, t| {
        let mut timeout = l(20.0, 23.0, "Timeout on the floor.", 'X');
        timeout.5 = true;
        publish(&x.db, M, 0, &[timeout], &t);
        publish(&x.db, M, 1, &[], &t);
        vec![step(&x, "run", StepOpts::default()).await]
    });
    scenario!("etat-en-base", |x, t| {
        publish(&x.db, M, 0, &c0, &t);
        let tr =
            x.db.with(|c| cdb::get_commentary_track(c, M))
                .unwrap()
                .unwrap();
        x.db.with(|c| ddb::open_dub_track(c, M, &tr.ok_id, &cdb::commentary_key(&tr)))
            .unwrap();
        let y: Vec<Value> = basis(1).into_iter().map(n).collect();
        let b9: Vec<Value> = basis(9).into_iter().map(n).collect();
        let state = json!({
            "zzz": 1,
            "speakers": [
                { "role": "B4", "id": 4, "extra": { "a": [1, 2] }, "f0": [128], "centroid": y, "talk": 12.345, "n": 3, "femaleP": 0.05, "femaleSec": 12.3 },
                { "id": "x", "centroid": [], "f0": [] },
                { "id": 1.5, "centroid": [], "f0": [] },
                null,
                { "id": 7, "centroid": b9, "f0": [] },
            ],
            "nextId": "2",
        });
        let s = state.to_string();
        x.db.with(|c| {
            c.execute(
                "UPDATE dub_tracks SET speakers = ?1 WHERE match_id = ?2",
                rusqlite::params![s, M],
            )
            .map(|_| ())
        })
        .unwrap();
        let a = step(&x, "relu", StepOpts::default()).await;
        x.db.with(|c| {
            c.execute(
                "UPDATE dub_tracks SET speakers = 'pas du json' WHERE match_id = ?1",
                [M],
            )
            .map(|_| ())
        })
        .unwrap();
        publish(&x.db, M, 0, &c0[0..3], &t);
        vec![a, step(&x, "illisible", StepOpts::default()).await]
    });
    scenario!("sans-replay-ni-sous-titres", |x, _t| {
        let a = step(&x, "sans-sous-titres", StepOpts::default()).await;
        x.db.with(|c| {
            set_video(
                c,
                M,
                &VideoUpdate {
                    slug: None,
                    ok_id: None,
                    duration: None,
                    available: false,
                    kind: None,
                },
            )
        })
        .unwrap();
        vec![a, step(&x, "sans-replay", StepOpts::default()).await]
    });
    assert_eq!(
        seen,
        fx("runs").as_array().unwrap().len(),
        "tous les scénarios de Node"
    );
}

// ------------------------------------------------------------------ file : états

/// Exécuteur simulé : chaque travail attend sa porte, ou l'interruption
/// (`{ ok: false, kind: 'erreur', reason: 'interrompu' }`).
#[derive(Clone, Default)]
struct DubGates {
    started: Arc<Mutex<Vec<i64>>>,
    gates: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<DubOutcome>>>>,
    progress: Arc<Mutex<Option<DubProgressFn>>>,
}

impl DubGates {
    fn runner(&self) -> DubRunner {
        let me = self.clone();
        Arc::new(move |job: DubJob, progress, signal: AbortSignal, _ctl| {
            me.started.lock().unwrap().push(job.match_id);
            *me.progress.lock().unwrap() = Some(progress);
            let (tx, rx) = tokio::sync::oneshot::channel();
            me.gates.lock().unwrap().insert(job.match_id, tx);
            Box::pin(async move {
                tokio::select! {
                    r = rx => Ok(r.unwrap_or_else(|_| DubOutcome::ok("abandon"))),
                    _ = signal.aborted() => Ok(DubOutcome::failed(DubFailureKind::Erreur, "interrompu")),
                }
            })
        })
    }

    /// `gates.get(id).resolve(o)` : sans effet si le travail est déjà fini.
    fn resolve(&self, id: i64, o: DubOutcome) {
        if let Some(tx) = self.gates.lock().unwrap().remove(&id) {
            let _ = tx.send(o);
        }
    }
}

#[derive(Clone, Default)]
struct CommentaryGates(Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<CommentaryOutcome>>>>);

impl CommentaryGates {
    fn runner(&self) -> CommentaryRunner {
        let me = self.clone();
        Arc::new(move |job, _p, _s, _c| {
            let (tx, rx) = tokio::sync::oneshot::channel();
            me.0.lock().unwrap().insert(job.match_id, tx);
            Box::pin(async move {
                Ok(rx
                    .await
                    .unwrap_or_else(|_| CommentaryOutcome::ok("abandon")))
            })
        })
    }
    fn resolve(&self, id: i64, o: CommentaryOutcome) {
        if let Some(tx) = self.0.lock().unwrap().remove(&id) {
            let _ = tx.send(o);
        }
    }
}

async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

fn failed(kind: Option<DubFailureKind>, reason: &str) -> DubOutcome {
    DubOutcome {
        ok: false,
        reason: reason.into(),
        kind,
        yielded: None,
    }
}

// Un seul fil, comme la boucle d'événements de Node : une demande synchrone (ici
// `request`) n'est jamais entrelacée avec la fin d'un travail qu'elle interrompt.
#[tokio::test(flavor = "current_thread")]
async fn etats_de_la_file_comme_node() {
    let _g = LOCK.lock().await;
    let x = reset();
    set_env("DUB_REPUMP_MS", "10");
    set_env("COMMENTARY_REPUMP_MS", "10");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    let t = track_meta(&x.db, M);
    let t2 = track_meta(&x.db, M2);
    let (c0, c1, c2) = (
        chunk_lines("CHUNK0"),
        chunk_lines("CHUNK1"),
        chunk_lines("CHUNK2"),
    );
    publish(&x.db, M, 0, &c0, &t);
    publish(&x.db, M2, 0, &c0, &t2);
    let d = &x.dub;
    let cm = d.commentary().clone();
    let want = fx("queue");
    let mut states: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let snap = |label: &str, states: &mut Vec<Value>| {
        let mut m = serde_json::Map::new();
        m.insert(M.to_string(), manifest_json(d, M));
        m.insert(M2.to_string(), manifest_json(d, M2));
        let got = json!({
            "label": label,
            "manifest": m,
            "activity": d.activity().to_json(),
            "positions": [d.queue_position(M), d.queue_position(M2)],
            "commentary": cm.activity().to_json(),
            "db": dub_snapshot(&x.db),
        });
        // Comparé tout de suite : la première divergence est celle qu'on voit.
        let w = &want["states"][states.len()];
        assert_eq!(w["label"], json!(label));
        for k in ["manifest", "activity", "positions", "commentary", "db"] {
            same_bytes(&got[k], &w[k], &format!("{label} : {k}"));
        }
        states.push(got);
    };
    let gates = DubGates::default();
    d.set_runner(Some(gates.runner()));
    let cgates = CommentaryGates::default();
    cm.set_runner(Some(cgates.runner()));
    let downloading: Arc<Mutex<Option<(f64, f64)>>> = Arc::default();
    let prepared = Arc::new(Mutex::new(0));
    let (dl, pr) = (downloading.clone(), prepared.clone());
    d.set_engine(Some(DubEngine {
        prepare: Some(Arc::new(move || {
            *pr.lock().unwrap() += 1;
            Box::pin(async { Ok(()) })
        })),
        download: Some(Arc::new(move || *dl.lock().unwrap())),
        ..fake_engine(None)
    }));
    let explicit = DubEnqueueOptions {
        priority: false,
        explicit: true,
    };
    let set_dl = |v: Option<(f64, f64)>| *downloading.lock().unwrap() = v;

    results.push(d.enqueue(M, DubEnqueueOptions::default()).to_json());
    results.push(json!(d
        .release_gpu_for_translation(None)
        .map(|_| "attente")));
    snap("rien", &mut states);
    results.push(d.enqueue(M, explicit).to_json());
    snap("en cours sans avancement", &mut states);
    (gates.progress.lock().unwrap().clone().unwrap())(DubProgress {
        done: 1.0,
        total: 3.0,
        chunk: Some(1),
        step: Some("synthèse des répliques : 1 / 4".into()),
    });
    snap("en cours", &mut states);
    set_dl(Some((1.1e9, 2.5e9)));
    snap("en cours, téléchargement des voix", &mut states);
    set_dl(None);
    results.push(d.enqueue(M2, explicit).to_json());
    results.push(d.enqueue(M, explicit).to_json());
    results.push(d.enqueue(M2, DubEnqueueOptions::default()).to_json());
    snap("M2 en file", &mut states);
    results.push(d.stop(M2).to_json());
    results.push(d.stop(M2).to_json());
    snap("M2 arrêté", &mut states);
    d.prioritize_on_view(M2);
    results.push(d.request(M2, false).to_json());
    sleep(150).await;
    snap(
        "M2 repris, sa traduction prend le GPU au doublage de M",
        &mut states,
    );
    set_dl(Some((3e8, 0.0)));
    snap("attente du GPU, téléchargement des voix", &mut states);
    set_dl(None);
    cgates.resolve(M2, CommentaryOutcome::ok("traduit"));
    sleep(100).await;
    snap(
        "traduction finie : M en tête (rendu par le GPU)",
        &mut states,
    );
    gates.resolve(
        M,
        failed(
            Some(DubFailureKind::Service),
            "Moteur de voix indisponible : x (nouvel essai automatique)",
        ),
    );
    sleep(50).await;
    snap("M en échec service, M2 en cours", &mut states);
    gates.resolve(
        M2,
        DubOutcome::yielded(
            DubYield::Viewer,
            "en pause (0 tronçon(s) doublé(s)) : un autre match est regardé",
        ),
    );
    sleep(50).await;
    snap("M2 a cédé (lecture)", &mut states);
    gates.resolve(
        M2,
        DubOutcome::yielded(
            DubYield::Window,
            "en pause (0 tronçon(s) doublé(s)) : hors de la fenêtre des tâches de fond",
        ),
    );
    sleep(50).await;
    snap("M2 hors fenêtre", &mut states);
    publish(&x.db, M, 1, &c1, &t);
    publish(&x.db, M, 2, &c2, &t);
    publish(&x.db, M2, 1, &c1, &t2);
    publish(&x.db, M2, 2, &c2, &t2);
    for (kind, reason) in [
        (Some(DubFailureKind::Service), "service encore"),
        (Some(DubFailureKind::Erreur), "boum"),
        (None, "sans nature"),
    ] {
        results.push(d.request(M, false).to_json());
        sleep(20).await;
        gates.resolve(M, failed(kind, reason));
        sleep(50).await;
    }
    snap("échecs répétés", &mut states);
    results.push(d.request(M, false).to_json());
    sleep(20).await;
    gates.resolve(M, DubOutcome::ok("1 tronçon(s) doublé(s)"));
    tokio::time::timeout(Duration::from_secs(5), d.idle())
        .await
        .unwrap_or_else(|_| panic!("file jamais vide : {:?}", d.activity()));
    snap("succès", &mut states);
    results.push(d.request(M2, false).to_json());
    sleep(20).await;
    cm.touch_viewer(M, Some(10.0));
    results.push(
        d.enqueue(
            M,
            DubEnqueueOptions {
                priority: true,
                explicit: false,
            },
        )
        .to_json(),
    );
    sleep(50).await;
    snap("M regardé passe devant M2", &mut states);
    gates.resolve(M, DubOutcome::ok("ok"));
    sleep(50).await;
    snap("M fini, M2 attend la fin de la lecture", &mut states);
    results.push(d.request(M, true).to_json());
    snap("M relancé", &mut states);
    results.push(d.request(M, true).to_json());
    gates.resolve(M, DubOutcome::ok("ok"));
    sleep(50).await;
    let tm =
        x.db.with(|c| cdb::get_commentary_track(c, M))
            .unwrap()
            .unwrap();
    x.db.with(|c| ddb::open_dub_track(c, M, &tm.ok_id, &cdb::commentary_key(&tm)))
        .unwrap();
    x.db.with(|c| ddb::set_dub_complete(c, M, true)).unwrap();
    results.push(d.request(M, false).to_json());
    snap("déjà doublé", &mut states);
    set_env("DUB_DISABLED", "1");
    results.push(d.enqueue(M, explicit).to_json());
    results.push(d.request(M, false).to_json());
    snap("inactif", &mut states);
    unset_env("DUB_DISABLED");
    for k in [
        "DUB_REPUMP_MS",
        "COMMENTARY_REPUMP_MS",
        "COMMENTARY_VIEWER_IDLE_MS",
    ] {
        unset_env(k);
    }
    d.set_runner(None);
    cm.set_runner(None);

    for (i, (g, w)) in results
        .iter()
        .zip(want["results"].as_array().unwrap())
        .enumerate()
    {
        same_bytes(g, w, &format!("résultat {i}"));
    }
    assert_eq!(results.len(), want["results"].as_array().unwrap().len());
    let ws = want["states"].as_array().unwrap();
    assert_eq!(states.len(), ws.len());
    for (g, w) in states.iter().zip(ws) {
        let label = w["label"].as_str().unwrap();
        for k in ["manifest", "activity", "positions", "commentary", "db"] {
            same_bytes(&g[k], &w[k], &format!("{label} : {k}"));
        }
    }
    assert_eq!(
        json!(gates.started.lock().unwrap().clone()),
        want["started"]
    );
    assert_eq!(json!(*prepared.lock().unwrap() > 0), want["prepared"]);
    let logs: Vec<Value> = x
        .logs
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, l)| l.starts_with("[doublage]"))
        .map(|(k, l)| json!([k, l]))
        .collect();
    assert_eq!(Value::from(logs), want["logs"]);
}
