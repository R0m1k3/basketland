//! Outils communs des tests de la file de traduction (`tests/commentary.rs`,
//! `tests/commentary_node.rs`) : base au schéma réel (relevé par
//! `node-fixtures-commentary.mts`), matchs comme `tests/helpers/db.ts`, faux
//! transcripteur et faux traducteur comme `tests/commentary-ondemand.test.ts`.
#![allow(dead_code)]

use basketland_server::db::{sql_to_json, Db};
use basketland_server::espn_events::ParsedMatch;
use basketland_server::ingest_db::{set_video, upsert_match, VideoUpdate};
use basketland_server::media::commentary::{
    plan_chunks, ChunkPlan, Commentary, CommentaryDeps, CommentaryError, CommentaryOptions,
    CommentaryProgress, ExtractRequest, StreamInfo, Transcriber, TranslatorSession,
};
use basketland_server::media::commentary_ai::{Service, ServiceError, TranslatedLine};
use basketland_server::media::commentary_cues::{AsrSegment, AsrWord, Transcript};
use basketland_server::media::viewers::Viewers;
use basketland_server::okru::Variant;
use regex::Regex;
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const DURATION: f64 = 1300.0;
pub const CHUNK: f64 = 600.0;

/// Sorties du code TypeScript.
pub fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let p = format!(
            "{}/tests/fixtures/commentary.expected.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    })
}

/// Verrou des tests : variables d'environnement et dossier de données partagés.
pub static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const ENV_KEYS: &[&str] = &[
    "TRANSCRIBE_URL",
    "TRANSLATE_URL",
    "TRANSCRIBE_MODEL",
    "TRANSLATE_MODEL",
    "TRANSLATE_BATCH",
    "TRANSLATE_PARALLEL",
    "TRANSLATE_ENGINE",
    "TRANSLATE_API_KEY",
    "COMMENTARY_DISABLED",
    "COMMENTARY_CHUNK_SEC",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "MINIMAX_API_KEY",
    "MINIMAX_TRANSLATE",
    "WHISPER_PYTHON",
    "WHISPER_WORKER",
    "OLLAMA_BIN",
    "COMMENTARY_NIGHT_WINDOW",
    "COMMENTARY_VIEWER_IDLE_MS",
    "COMMENTARY_VIEWER_GONE_MS",
    "COMMENTARY_MAX_LEAD_SEC",
    "COMMENTARY_LEAD_POLL_MS",
    "COMMENTARY_REPUMP_MS",
    "COMMENTARY_FULL_AUDIO",
    "COMMENTARY_FULL_AUDIO_POLL_MS",
    "WHISPER_PROMPT",
    "WHISPER_HOTWORDS",
    "COMMENTARY_TIMEOUT_MS",
];

/// Environnement d'un test : variables neutres, serveurs « configurés »,
/// dossier de données neuf. Rend le dossier (supprimé à la fin du test).
pub fn env_setup() -> tempfile::TempDir {
    for k in ENV_KEYS {
        std::env::remove_var(k);
    }
    std::env::set_var("TRANSCRIBE_URL", "http://gpu.local:8000/v1");
    std::env::set_var("TRANSLATE_URL", "http://gpu.local:11434/v1");
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("DATA_DIR", dir.path());
    dir
}

pub fn set_env(k: &str, v: &str) {
    std::env::set_var(k, v);
}

pub fn unset_env(k: &str) {
    std::env::remove_var(k);
}

/// Base neuve au schéma réel (migrations de `db.ts`).
pub fn fresh_db(dir: &Path) -> Db {
    let path = dir.join(format!(
        "basketland-{}.db",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let c = Connection::open(&path).unwrap();
    for sql in fixture()["schema"].as_array().unwrap() {
        c.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    Db::new(path)
}

/// `insertMatch` de `tests/helpers/db.ts`.
pub fn insert_match(db: &Db, id: i64, duration: Option<f64>) {
    let m = ParsedMatch {
        id: id as f64,
        espn_id: id.to_string(),
        league: "nba".into(),
        season: 2026.0,
        season_type: "regular",
        date_utc: Some(basketland_server::time::iso_utc(
            chrono::Utc::now() - chrono::Duration::hours(24),
        )),
        home_abbr: "LAL".into(),
        home_name: "Los Angeles Lakers".into(),
        away_abbr: "POR".into(),
        away_name: "Portland Trail Blazers".into(),
        home_score: Some(110.0),
        away_score: Some(102.0),
        status: "final",
        status_detail: "Final".into(),
        period: 4.0,
        clock_display: "0.0".into(),
        venue: String::new(),
        broadcast: "NBC".into(),
    };
    let s = id.to_string();
    let ok_id = format!("1665649{}", &s[s.len().saturating_sub(7)..]);
    db.with(|c| {
        upsert_match(c, &m)?;
        set_video(
            c,
            id,
            &VideoUpdate {
                slug: None,
                ok_id: Some(ok_id.clone()),
                duration,
                available: true,
                kind: None,
            },
        )
    })
    .unwrap();
}

pub fn ok_id(db: &Db, id: i64) -> String {
    db.with(|c| basketland_server::db::get_match(c, id))
        .unwrap()
        .unwrap()
        .video_ok_id
        .unwrap()
}

/// Horloge réglable (décalage sur l'heure réelle, comme `vi.setSystemTime`).
#[derive(Clone, Default)]
pub struct TestClock(Arc<AtomicI64>);

impl TestClock {
    pub fn advance_ms(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn now(&self) -> f64 {
        basketland_server::media::viewers::now_ms() + self.0.load(Ordering::SeqCst) as f64
    }
}

/// Service de test : spectateurs à part, horloge réglable, ffmpeg « présent ».
pub fn service(db: &Db, deps: CommentaryDeps) -> (Commentary, TestClock) {
    let clock = TestClock::default();
    let c2 = clock.clone();
    let viewers: &'static Viewers = Box::leak(Box::default());
    let svc = Commentary::with_options(
        db.clone(),
        deps,
        CommentaryOptions {
            viewers,
            clock: Arc::new(move || c2.now()),
            ffmpeg_available: Arc::new(|| true),
        },
    );
    (svc, clock)
}

// ------------------------------------------------------------------ faux transcripteur et traducteur

pub fn script() -> Vec<(f64, String)> {
    fixture()["script"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| (x[0].as_f64().unwrap(), x[1].as_str().unwrap().to_string()))
        .collect()
}

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Transcription simulée d'un tronçon : les mots audibles dans sa fenêtre d'extraction, en temps local.
pub fn fake_transcript(plans: &[ChunkPlan], index: usize) -> Transcript {
    let plan = plans[index];
    let (from, to) = (plan.start, plan.start + plan.length);
    let mut words = Vec::new();
    let mut segments = Vec::new();
    for (t0, text) in script() {
        let ws: Vec<AsrWord> = text
            .split(' ')
            .enumerate()
            .map(|(i, w)| {
                (
                    format!(" {w}"),
                    t0 + i as f64 * 0.3,
                    t0 + i as f64 * 0.3 + 0.25,
                )
            })
            .filter(|(_, s, e)| *s >= from && *e <= to)
            .map(|(w, s, e)| AsrWord::new(&w, r3(s - from), r3(e - from)))
            .collect();
        if ws.is_empty() {
            continue;
        }
        let text: String = ws.iter().map(|w| w.word.as_str()).collect();
        segments.push(AsrSegment {
            avg_logprob: Some(-0.2),
            no_speech_prob: Some(0.02),
            compression_ratio: Some(1.1),
            ..AsrSegment::new(ws[0].start, ws[ws.len() - 1].end, &text)
        });
        words.extend(ws);
    }
    Transcript { segments, words }
}

#[derive(Default, Debug, Clone)]
pub struct Calls {
    pub extract: Vec<i64>,
    pub transcribe: Vec<i64>,
    pub translated: Vec<i64>,
    pub events: Vec<String>,
    pub hotwords: Vec<Option<String>>,
}

#[derive(Default, Clone)]
pub struct Fake {
    pub fail_transcribe_at: Option<i64>,
    pub fail_extract_at: Option<i64>,
    pub after_chunk: Option<Arc<dyn Fn(i64) + Send + Sync>>,
    pub untranslatable: Option<Regex>,
    /// Transcription remplacée par « Thank you. » seul (aucune parole), sans trace d'appel.
    pub no_speech: bool,
}

pub type CallsRef = Arc<Mutex<Calls>>;

fn chunk_start(file: &str) -> f64 {
    let m = Regex::new(r"chunk-(\d+)-").unwrap();
    m.captures(file).unwrap()[1].parse().unwrap()
}

/// `fakeDeps` de `tests/commentary-ondemand.test.ts` (tronçons de
/// `COMMENTARY_CHUNK_SEC`, 1 300 s de vidéo).
pub fn fake_deps(o: Fake) -> (CommentaryDeps, CallsRef) {
    let chunk: f64 = std::env::var("COMMENTARY_CHUNK_SEC")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120.0);
    let plans = Arc::new(plan_chunks(DURATION, chunk, None));
    let calls: CallsRef = Arc::default();
    let index_of = {
        let plans = plans.clone();
        move |start: f64| {
            plans
                .iter()
                .position(|p| p.start == start)
                .map_or(-1, |i| i as i64)
        }
    };
    let (c1, c2, c3, c4, c5) = (
        calls.clone(),
        calls.clone(),
        calls.clone(),
        calls.clone(),
        calls.clone(),
    );
    let o1 = o.clone();
    let idx1 = index_of.clone();
    let p2 = plans.clone();
    let o2 = o.clone();
    let o3 = o.clone();
    let transcribe: basketland_server::media::commentary::TranscribeFn =
        Arc::new(move |file, _cfg, _opts| {
            if o2.no_speech {
                let mut seg = AsrSegment::new(1.0, 2.0, " Thank you.");
                seg.no_speech_prob = Some(0.9);
                seg.avg_logprob = Some(-1.5);
                return Box::pin(async move {
                    Ok(Transcript {
                        segments: vec![seg],
                        words: vec![],
                    })
                });
            }
            let idx = index_of(chunk_start(&file));
            {
                let mut c = c2.lock().unwrap();
                c.transcribe.push(idx);
                c.events.push(format!("transcription {idx}"));
            }
            let fail = o2.fail_transcribe_at == Some(idx);
            let t = (idx >= 0).then(|| fake_transcript(&p2, idx as usize));
            Box::pin(async move {
                if fail {
                    return Err(CommentaryError::Service(ServiceError {
                        message: "Whisper s’est arrêté".into(),
                        service: Service::Transcription,
                    }));
                }
                Ok(t.unwrap_or_default())
            })
        });
    let tr = transcribe.clone();
    let deps = CommentaryDeps {
        resolve_stream: Arc::new(|_, _| {
            Box::pin(async {
                Ok(StreamInfo {
                    variants: vec![Variant {
                        key: "low".into(),
                        bandwidth: 600_000.0,
                        resolution: "640x360".into(),
                        url: "https://vd.okcdn.ru/low.m3u8".into(),
                    }],
                    mp4: vec![],
                    duration: Some(DURATION),
                })
            })
        }),
        extract: Arc::new(move |r: ExtractRequest| {
            let idx = idx1(r.start);
            c1.lock().unwrap().extract.push(idx);
            let fail = o1.fail_extract_at == Some(idx);
            Box::pin(async move {
                if fail {
                    return Err("ffmpeg audio code 1: HTTP error 403 Forbidden".into());
                }
                std::fs::write(&r.out_file, vec![0u8; 4096]).map_err(|e| e.to_string())
            })
        }),
        extract_full: None,
        cut: None,
        transcribe,
        translate: Arc::new(move |lines, _ctx, _cfg, _o| {
            {
                let mut c = c3.lock().unwrap();
                c.events.push(format!("traduction {}", lines.len()));
                c.translated.extend(lines.iter().map(|l| l.i));
            }
            let res: Vec<TranslatedLine> = lines
                .iter()
                .map(|l| {
                    if o3
                        .untranslatable
                        .as_ref()
                        .is_some_and(|re| re.is_match(&l.en))
                    {
                        TranslatedLine {
                            i: l.i,
                            fr: l.en.clone(),
                            untranslated: true,
                        }
                    } else {
                        TranslatedLine {
                            i: l.i,
                            fr: format!("FR {}", l.en),
                            untranslated: false,
                        }
                    }
                })
                .collect();
            let idx = lines[0].i / 100_000 - 1;
            if let Some(f) = &o3.after_chunk {
                f(idx);
            }
            Box::pin(async move { Ok(res) })
        }),
        open_transcriber: Some(Arc::new(move |cfg, _signal| {
            c4.lock().unwrap().events.push("whisper ouvert".into());
            let (tr, calls, calls2) = (tr.clone(), c4.clone(), c4.clone());
            Box::pin(async move {
                Ok(Transcriber {
                    transcribe: Arc::new(move |file, prompt, signal, hotwords| {
                        calls.lock().unwrap().hotwords.push(hotwords);
                        tr(
                            file,
                            cfg.clone(),
                            basketland_server::media::commentary_ai::TranscribeOptions {
                                prompt,
                                signal: Some(signal),
                                ..Default::default()
                            },
                        )
                    }),
                    close: Arc::new(move || {
                        calls2.lock().unwrap().events.push("whisper fermé".into());
                        Box::pin(async {})
                    }),
                })
            })
        })),
        open_translator: Some(Arc::new(move |_cfg, _signal, _progress| {
            c5.lock().unwrap().events.push("ollama ouvert".into());
            let c = c5.clone();
            Box::pin(async move {
                Ok(TranslatorSession {
                    close: Arc::new(move || {
                        c.lock().unwrap().events.push("ollama fermé".into());
                        Box::pin(async {})
                    }),
                })
            })
        })),
        envelope: None,
    };
    (deps, calls)
}

// ------------------------------------------------------------------ lectures de la base

pub fn rows(db: &Db, sql: &str) -> Vec<Value> {
    let sql = sql.to_string();
    db.with(move |c| {
        let mut st = c.prepare(&sql)?;
        let names: Vec<String> = st.column_names().into_iter().map(str::to_string).collect();
        let out = st
            .query_map([], |r| {
                let mut m = serde_json::Map::new();
                for (i, n) in names.iter().enumerate() {
                    m.insert(n.clone(), sql_to_json(r.get::<_, SqlValue>(i)?));
                }
                Ok(Value::Object(m))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(out)
    })
    .unwrap()
}

/// `snapshot()` du générateur : pistes (sans `created_at`), sous-titres, tronçons, kv_cache.
pub fn snapshot(db: &Db) -> Value {
    let tracks: Vec<Value> = rows(db, "SELECT * FROM commentary_tracks ORDER BY match_id")
        .into_iter()
        .map(|mut r| {
            r.as_object_mut().unwrap().shift_remove("created_at");
            r
        })
        .collect();
    let kv: Vec<Value> = rows(
        db,
        "SELECT key, value FROM kv_cache WHERE key LIKE 'commentary%' ORDER BY key",
    )
    .into_iter()
    .map(|r| {
        let mut v: Value = serde_json::from_str(r["value"].as_str().unwrap()).unwrap();
        if let Some(o) = v.as_object_mut() {
            if o.contains_key("at") {
                o.insert("at".into(), json!("<at>"));
            }
        }
        json!({ "key": r["key"], "value": v })
    })
    .collect();
    json!({
        "tracks": tracks,
        "cues": rows(db, "SELECT * FROM commentary_cues ORDER BY match_id, seq"),
        "chunks": rows(db, "SELECT * FROM commentary_chunks ORDER BY match_id, idx"),
        "kv": kv,
    })
}

/// Avancement d'un travail, comme le générateur l'écrit (« phase fait/total disponible »).
pub fn fmt_progress(p: &CommentaryProgress) -> String {
    use basketland_server::jsval::js_number_string as n;
    format!(
        "{} {}/{} {}",
        p.phase.as_str(),
        n(p.done),
        n(p.total),
        p.available_until.map_or("-".into(), n)
    )
}

/// Attend une condition (comme `vi.waitFor`), 5 s au plus.
pub async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t0 = std::time::Instant::now();
    while !f() {
        assert!(t0.elapsed().as_secs() < 5, "délai dépassé : {what}");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

pub fn data_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().to_path_buf()
}
