//! Outils communs des tests du doublage (`tests/dub.rs`, `tests/dub_node.rs`) :
//! faux moteur de voix, fausse extraction et faux montage comme
//! `tests/dub.test.ts` (et `node-fixtures-dub.mts`), publication des
//! sous-titres traduits, instantanés de la base. S'appuie sur
//! `commentary_kit.rs` (base au schéma réel, matchs, horloge).
#![allow(dead_code)]

use crate::kit::*;
use basketland_server::api::js_num_value as n;
use basketland_server::commentary_db::{
    self as cdb, CommentaryTrackMeta, CueInput, PublishedChunk,
};
use basketland_server::db::Db;
use basketland_server::media::abort::AbortSignal;
use basketland_server::media::commentary::{Commentary, ExtractRequest, StreamInfo};
use basketland_server::media::dub::{
    to_fixed, AssembleClip, Dub, DubControl, DubDeps, DubEngine, DubOptions, DubVoiceSession,
    DubYield,
};
use basketland_server::media::voice_ai::EmbedResult;
use basketland_server::okru::Variant;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const M: i64 = 403000001;
pub const M2: i64 = 403000002;

/// Sorties du code TypeScript (`node-fixtures-dub.mts`).
pub fn dub_fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let p = format!(
            "{}/tests/fixtures/dub.expected.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    })
}

/// Environnement d'un test du doublage : celui de la traduction, variables
/// du doublage retirées, fenêtre de nuit « toujours ».
pub fn dub_env() -> tempfile::TempDir {
    let dir = env_setup();
    let keys: Vec<String> = std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| {
            k.starts_with("DUB_")
                || k.starts_with("TTS_")
                || k.starts_with("MINIMAX_")
                || k == "FFMPEG_PATH"
        })
        .collect();
    for k in keys {
        std::env::remove_var(k);
    }
    set_env("COMMENTARY_NIGHT_WINDOW", "always");
    dir
}

// ------------------------------------------------------------------ sous-titres

/// `[début, fin, texte FR, locuteur, emphase, non traduit]`.
#[derive(Debug, Clone)]
pub struct Line(pub f64, pub f64, pub String, pub char, pub f64, pub bool);

pub fn lines(v: &Value) -> Vec<Line> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|l| {
            Line(
                l[0].as_f64().unwrap(),
                l[1].as_f64().unwrap(),
                l[2].as_str().unwrap().into(),
                l[3].as_str().unwrap().chars().next().unwrap(),
                l.get(4).and_then(Value::as_f64).unwrap_or(0.0),
                l.get(5).and_then(Value::as_bool).unwrap_or(false),
            )
        })
        .collect()
}

pub fn chunk_lines(k: &str) -> Vec<Line> {
    lines(&dub_fixture()["lines"][k])
}

pub fn l(a: f64, b: f64, text: &str, who: char) -> Line {
    Line(a, b, text.into(), who, 0.0, false)
}

pub fn track_meta(db: &Db, id: i64) -> CommentaryTrackMeta {
    CommentaryTrackMeta {
        ok_id: ok_id(db, id),
        transcribe_model: "large-v3-turbo".into(),
        translate_model: "translategemma:12b".into(),
        chunk_sec: Some(120.0),
        chunks_total: Some(3.0),
    }
}

/// `publish(matchId, idx, lines, track)` des tests de Node.
pub fn publish(db: &Db, id: i64, idx: usize, ls: &[Line], track: &CommentaryTrackMeta) {
    let cues: Vec<CueInput> = ls
        .iter()
        .enumerate()
        .map(|(k, Line(s, e, fr, _, emph, untranslated))| CueInput {
            seq: cdb::chunk_seq_base(idx) + k as i64 + 1,
            start_ts: *s,
            end_ts: *e,
            text_en: format!("EN {fr}"),
            text_fr: if *untranslated {
                format!("EN {fr}")
            } else {
                fr.clone()
            },
            untranslated: *untranslated,
            emphasis: *emph,
        })
        .collect();
    let chunk = PublishedChunk {
        idx,
        keep_from: idx as f64 * 120.0,
        keep_to: if idx == 2 {
            f64::INFINITY
        } else {
            (idx as f64 + 1.0) * 120.0
        },
    };
    db.with(|c| cdb::publish_commentary_chunk(c, id, track, chunk, &cues))
        .unwrap();
}

// ------------------------------------------------------------------ voix simulées

pub fn basis(k: usize) -> Vec<f64> {
    let mut v = vec![0.02; 192];
    v[k] = 1.0;
    v
}

pub fn vec_of(w: char) -> Vec<f64> {
    basis(match w {
        'X' => 0,
        'Y' => 1,
        _ => 2,
    })
}

fn f0_of(w: char) -> f64 {
    match w {
        'X' => 112.0,
        'Y' => 128.0,
        _ => 214.0,
    }
}

fn female_of(w: char) -> f64 {
    match w {
        'X' => 0.02,
        'Y' => 0.06,
        _ => 0.96,
    }
}

/// Rappel à chaque synthèse (numéro de l'appel, texte).
pub type OnSynth = Arc<dyn Fn(usize, &str) + Send + Sync>;

/// Options du faux moteur (`FakeOpts` du générateur).
#[derive(Default, Clone)]
pub struct FakeOpts {
    pub voices: Option<Vec<String>>,
    pub fail_open: bool,
    /// Répliques en échec ; `["*"]` : toutes.
    pub fail_synth: Vec<String>,
    pub fail_embed: bool,
    pub durations: HashMap<String, f64>,
    pub script: Option<Vec<Line>>,
    pub no_gender: bool,
    pub resolve_fails: usize,
    pub variants: Option<usize>,
    pub extract_fails: usize,
    pub local: Option<bool>,
    /// Appelé à chaque synthèse (numéro, texte).
    pub on_synth: Option<OnSynth>,
}

#[derive(Default, Debug, Clone)]
pub struct Calls {
    pub synth: Vec<Value>,
    pub extract: Vec<Value>,
    pub resolve: Vec<bool>,
    pub embed: Vec<Value>,
    pub opened: usize,
    pub closed: usize,
    pub slices: Vec<Value>,
    pub assemble: Vec<Value>,
}

impl Calls {
    pub fn to_json(&self) -> Value {
        json!({
            "synth": self.synth, "extract": self.extract, "resolve": self.resolve, "embed": self.embed,
            "opened": self.opened, "closed": self.closed, "slices": self.slices, "assemble": self.assemble,
        })
    }
    pub fn synth_texts(&self) -> Vec<String> {
        self.synth
            .iter()
            .map(|s| s["text"].as_str().unwrap().to_string())
            .collect()
    }
    pub fn synth_voices(&self) -> Vec<String> {
        self.synth
            .iter()
            .map(|s| s["voice"].as_str().unwrap().to_string())
            .collect()
    }
}

pub type CallsRef = Arc<Mutex<Calls>>;

fn base(p: &str) -> String {
    Path::new(p)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn who_at(t: f64, script: &[Line]) -> Option<char> {
    script.iter().find(|x| t >= x.0 && t <= x.1).map(|x| x.3)
}

fn full_script() -> Vec<Line> {
    let mut s = chunk_lines("CHUNK0");
    s.extend(chunk_lines("CHUNK1"));
    s.extend(chunk_lines("CHUNK2"));
    s
}

/// Faux moteur, fausse extraction et faux montage (`fake()` des tests de Node).
pub fn fake(o: FakeOpts) -> (DubDeps, CallsRef, DubVoiceSession) {
    let calls: CallsRef = Arc::default();
    let starts: Arc<Mutex<HashMap<String, f64>>> = Arc::default();
    let script = Arc::new(o.script.clone().unwrap_or_else(full_script));
    let o = Arc::new(o);
    let (c1, o1) = (calls.clone(), o.clone());
    let (c2, o2, st2) = (calls.clone(), o.clone(), starts.clone());
    let c3 = calls.clone();
    let session = DubVoiceSession {
        voices: o
            .voices
            .clone()
            .unwrap_or_else(|| vec!["A".into(), "B4".into(), "B1".into()]),
        synth: Arc::new(move |text, voice, file, _signal, emphasis| {
            let k = {
                let mut c = c1.lock().unwrap();
                c.synth
                    .push(json!({ "text": text, "voice": voice, "emphasis": emphasis.map(n) }));
                c.synth.len()
            };
            if let Some(f) = &o1.on_synth {
                f(k, &text);
            }
            let fail = o1.fail_synth.iter().any(|t| t == "*" || *t == text);
            let d = o1.durations.get(&text).copied().unwrap_or(1.0);
            Box::pin(async move {
                if fail {
                    return Err("la voix a planté\n  (CUDA)".into());
                }
                std::fs::write(&file, "RIFF").map_err(|e| e.to_string())?;
                Ok((d, 24_000))
            })
        }),
        embed: Arc::new(move |file, segments, _signal| {
            c2.lock().unwrap().embed.push(Value::Array(
                segments
                    .iter()
                    .map(|(a, b)| json!([n(*a), n(*b)]))
                    .collect(),
            ));
            let s0 = st2
                .lock()
                .unwrap()
                .get(&base(&file))
                .copied()
                .unwrap_or(0.0);
            let who: Vec<Option<char>> = segments
                .iter()
                .map(|(a, b)| who_at(s0 + (a + b) / 2.0, &script))
                .collect();
            let (fail, no_gender) = (o2.fail_embed, o2.no_gender);
            Box::pin(async move {
                if fail {
                    return Err("ECAPA indisponible".into());
                }
                Ok(EmbedResult {
                    embeddings: who.iter().map(|w| w.map(vec_of)).collect(),
                    f0: who.iter().map(|w| w.map(f0_of)).collect(),
                    female: (!no_gender).then(|| who.iter().map(|w| w.map(female_of)).collect()),
                })
            })
        }),
        close: Arc::new(move || {
            c3.lock().unwrap().closed += 1;
            Box::pin(async {})
        }),
    };
    let resolved = Arc::new(AtomicUsize::new(0));
    let (c4, o4) = (calls.clone(), o.clone());
    let (c5, o5, st5) = (calls.clone(), o.clone(), starts.clone());
    let (c6, o6, s6) = (calls.clone(), o.clone(), session.clone());
    let c7 = calls.clone();
    let (c8, st8) = (calls.clone(), starts.clone());
    let local = o.local;
    let deps = DubDeps {
        resolve_stream: Arc::new(move |_ok, force| {
            c4.lock().unwrap().resolve.push(force);
            let fail = resolved.fetch_add(1, Ordering::SeqCst) < o4.resolve_fails;
            let k = o4.variants.unwrap_or(1);
            Box::pin(async move {
                if fail {
                    return Err("ok.ru : 503\nService Unavailable".into());
                }
                Ok(StreamInfo {
                    dash_url: None,
                    variants: (0..k)
                        .map(|i| Variant {
                            key: format!("v{i}"),
                            bandwidth: 600_000.0 + i as f64,
                            resolution: "640x360".into(),
                            url: format!("https://vd.okcdn.ru/v{i}.m3u8"),
                        })
                        .collect(),
                    mp4: vec![],
                    duration: Some(400.0),
                })
            })
        }),
        extract: Arc::new(move |r: ExtractRequest| {
            let k = {
                let mut c = c5.lock().unwrap();
                c.extract.push(json!({
                    "url": r.source_url, "start": n(r.start), "length": n(r.length),
                    "ua": r.options.headers.user_agent.as_ref().map(|_| "BROWSER_UA"),
                    "referer": r.options.headers.referer,
                }));
                c.extract.len()
            };
            let fail = k <= o5.extract_fails;
            if !fail {
                st5.lock().unwrap().insert(base(&r.out_file), r.start);
            }
            Box::pin(async move {
                if fail {
                    return Err("HTTP 403".into());
                }
                std::fs::write(&r.out_file, vec![0u8; 2048]).map_err(|e| e.to_string())
            })
        }),
        open_voice: Arc::new(move |_signal| {
            let fail = o6.fail_open;
            if !fail {
                c6.lock().unwrap().opened += 1;
            }
            let s = s6.clone();
            Box::pin(async move {
                if fail {
                    return Err("CUDA indisponible\n\tsur ce serveur".into());
                }
                Ok(s)
            })
        }),
        assemble: Arc::new(move |clips: Vec<AssembleClip>, duration, out, _signal| {
            c7.lock().unwrap().assemble.push(json!({
                "clips": clips.iter().map(|c| json!({ "file": base(&c.file), "at": n(c.at), "tempo": n(c.tempo) })).collect::<Vec<_>>(),
                "duration": n(duration),
                "out": base(&out),
            }));
            let body = format!("m4a:{}:{}", clips.len(), to_fixed(duration, 2));
            Box::pin(async move { std::fs::write(&out, body).map_err(|e| e.to_string()) })
        }),
        local_audio: local.map(|ok| {
            Arc::new(
                move |_ok: String, start: f64, length: f64, out: String, _s: AbortSignal| {
                    c8.lock().unwrap().slices.push(json!([n(start), n(length)]));
                    if ok {
                        st8.lock().unwrap().insert(base(&out), start);
                    }
                    Box::pin(async move { ok && std::fs::write(&out, vec![0u8; 2048]).is_ok() })
                        as basketland_server::media::commentary::BoxFut<bool>
                },
            ) as basketland_server::media::dub::LocalAudioFn
        }),
        spell_names: None,
    };
    (deps, calls, session)
}

/// Moteur de voix simulé : configuré, ouvre `session` (ou échoue).
pub fn fake_engine(session: Option<DubVoiceSession>) -> DubEngine {
    DubEngine {
        config: Arc::new(|| Ok(None)),
        open: Arc::new(move |_| {
            let s = session.clone();
            Box::pin(async move { s.ok_or_else(|| "pas de moteur".to_string()) })
        }),
        prepare: None,
        download: None,
        uses_gpu: None,
    }
}

/// Journal capturé : `(« log » | « error », ligne)`.
pub type Logs = Arc<Mutex<Vec<(String, String)>>>;

/// Services de test : traduction (spectateurs à part, horloge réglable,
/// ffmpeg « présent ») et doublage branché dessus, journal capturé.
pub fn services(db: &Db, deps: DubDeps) -> (Commentary, Dub, TestClock, Logs) {
    let (cdeps, _) = fake_deps(Fake::default());
    let (c, clock) = service(db, cdeps);
    let logs: Logs = Arc::default();
    let l2 = logs.clone();
    let d = Dub::with_options(
        c.clone(),
        deps,
        DubOptions {
            ffmpeg_available: Arc::new(|| true),
            log: Arc::new(move |err, line| {
                l2.lock()
                    .unwrap()
                    .push((if err { "error" } else { "log" }.into(), line.to_string()))
            }),
        },
    );
    d.set_engine(Some(fake_engine(None)));
    (c, d, clock, logs)
}

/// Pilotage d'un travail : cède la place (GPU) après `after` vérifications ; position visée.
pub fn ctl(after: Option<usize>, target: f64) -> DubControl {
    let k = Arc::new(AtomicUsize::new(0));
    DubControl {
        yield_reason: Arc::new(move || {
            let i = k.fetch_add(1, Ordering::SeqCst) + 1;
            after.filter(|a| i > *a).map(|_| DubYield::Gpu)
        }),
        target: Arc::new(move || target),
    }
}

// ------------------------------------------------------------------ lectures

fn mask_at(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        if o.contains_key("at") {
            o.insert("at".into(), json!("<at>"));
        }
    }
    v
}

/// `snapshot()` du générateur : pistes doublées (sans `updated_at`), tronçons (sans `created_at`), kv_cache.
pub fn dub_snapshot(db: &Db) -> Value {
    let strip = |sql: &str, k: &str| -> Vec<Value> {
        rows(db, sql)
            .into_iter()
            .map(|mut r| {
                r.as_object_mut().unwrap().shift_remove(k);
                r
            })
            .collect()
    };
    let kv: Vec<Value> = rows(db, "SELECT key, value FROM kv_cache WHERE key LIKE 'dub:%' ORDER BY key")
        .into_iter()
        .map(|r| {
            json!({ "key": r["key"], "value": mask_at(serde_json::from_str(r["value"].as_str().unwrap()).unwrap()) })
        })
        .collect();
    json!({
        "tracks": strip("SELECT * FROM dub_tracks ORDER BY match_id", "updated_at"),
        "chunks": strip("SELECT * FROM dub_chunks ORDER BY match_id, idx", "created_at"),
        "kv": kv,
    })
}

/// Manifeste, `?v=<date>` masqué.
pub fn manifest_json(d: &Dub, id: i64) -> Value {
    let s = d.manifest(id).to_json().to_string();
    let re = regex::Regex::new(r"\?v=\d+").unwrap();
    serde_json::from_str(&re.replace_all(&s, "?v=<t>")).unwrap()
}

/// Fichiers du dossier du doublage d'un match (triés), `None` s'il n'existe pas.
pub fn dub_files(id: i64) -> Option<Vec<String>> {
    let dir = basketland_server::media::dub::dub_dir(id);
    std::fs::read_dir(&dir).ok().map(|d| {
        let mut v: Vec<String> = d
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    })
}

// ------------------------------------------------------------------ comparaison des JSON

/// Première différence entre deux JSON (chemin et valeurs), `None` s'ils sont
/// égaux : mêmes clés DANS LE MÊME ORDRE, mêmes chaînes à l'octet (lignes de
/// la base comprises), mêmes nombres. Un nombre relu dans la fixture par
/// serde_json (lecture des décimaux pas toujours exacte au dernier bit, sans
/// la fonction `float_roundtrip`) peut différer de quelques ulp de celui de
/// Node : toléré pour les nombres seulement.
pub fn json_diff(got: &Value, want: &Value, path: &str) -> Option<String> {
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (x, y) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            let close = x == y || (x - y).abs() <= 4.0 * f64::EPSILON * x.abs().max(y.abs());
            (!close).then(|| format!("{path} : {a} ≠ {b}"))
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path} : {} éléments ≠ {}", a.len(), b.len()));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(i, (x, y))| json_diff(x, y, &format!("{path}[{i}]")))
        }
        (Value::Object(a), Value::Object(b)) => {
            let (ka, kb): (Vec<&String>, Vec<&String>) = (a.keys().collect(), b.keys().collect());
            if ka != kb {
                return Some(format!("{path} : clés {ka:?} ≠ {kb:?}"));
            }
            a.iter()
                .find_map(|(k, x)| json_diff(x, &b[k], &format!("{path}.{k}")))
        }
        (Value::String(a), Value::String(b)) if a != b => {
            let at = a
                .char_indices()
                .zip(b.chars())
                .find(|((_, x), y)| x != y)
                .map_or(a.len().min(b.len()), |((i, _), _)| i);
            let ctx = |s: &str| {
                s.get(at.saturating_sub(40)..(at + 60).min(s.len()))
                    .unwrap_or(s)
                    .to_string()
            };
            Some(format!(
                "{path} : chaînes différentes à l'octet {at} : …{}… ≠ …{}…",
                ctx(a),
                ctx(b)
            ))
        }
        (a, b) if a == b => None,
        (a, b) => Some(format!("{path} : {a} ≠ {b}")),
    }
}

/// Égalité de deux JSON comme les écrit Node (voir [`json_diff`]).
pub fn assert_json(got: &Value, want: &Value, what: &str) {
    if let Some(d) = json_diff(got, want, "") {
        panic!("{what} : {d}");
    }
}
