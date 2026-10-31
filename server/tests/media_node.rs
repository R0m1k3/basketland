//! Fondations médias (étape 6a) comparées à Node : `tests/fixtures/media.expected.json`
//! contient les sorties du code TypeScript (produit par
//! `tests/node-fixtures-media.mts`) — sous-titres, noms des joueurs, prompts,
//! messages et corps exacts des requêtes, réglages et configurations, audio,
//! fenêtre de nuit, planification et balayage vidéo. Chaque cas est rejoué en
//! Rust et sa sortie doit être identique À L'OCTET (JSON sérialisé, ordre des
//! clés compris).

use base64::Engine;
use basketland_server::api::js_num_value;
use basketland_server::media::audio::{compute_rms_db, detect_cuts, CutOptions, RmsAccumulator};
use basketland_server::media::audio_energy::{
    add_word_energy, envelope_from_pcm, with_energy, FRAME_SEC,
};
use basketland_server::media::commentary_ai::{
    self as ai, CommentaryConfig, ServiceMode, TranslateEngine, TranslateLine, TranslateProvider,
};
use basketland_server::media::commentary_cues::{
    self as cues, AsrSegment, AsrWord, CueOptions, Transcript,
};
use basketland_server::media::night_window::{in_schedule_window, night_window_label};
use basketland_server::media::roster_names as roster;
use basketland_server::media::video_scan::{
    self as scan, FrameObservation, LocateResult, ScanDeps, ScanOptions, ScoreboardReading,
};
use basketland_server::media::voice_ai::{list_voices, voice_config, voice_engine_name};
use basketland_server::media::voice_minimax::{
    minimax_config, minimax_emotion, synth_body, to_wav,
};
use basketland_server::settings::{self as st, Settings};
use basketland_server::vf_sync::{BreakInfo, Interval, ResolvedAnchor, TimedPlay};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::path::Path;

fn root() -> String {
    std::fs::canonicalize(format!("{}/..", env!("CARGO_MANIFEST_DIR")))
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn cases() -> Vec<Value> {
    let path = format!(
        "{}/tests/fixtures/media.expected.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path)
        .unwrap()
        .replace("<ROOT>", &root());
    serde_json::from_str(&text).unwrap()
}

/// Égalité des JSON sérialisés (ordre des clés et écriture des nombres compris).
fn same(got: &Value, want: &Value, what: &str) {
    let (g, w) = (got.to_string(), want.to_string());
    if g != w {
        let at = g
            .bytes()
            .zip(w.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(g.len().min(w.len()));
        let from = at.saturating_sub(120);
        panic!(
            "{what} : écart à l'octet {at}\n  Rust : …{}\n  Node : …{}",
            &g[g.floor_char_boundary(from)..g.ceil_char_boundary((at + 120).min(g.len()))],
            &w[w.floor_char_boundary(from)..w.ceil_char_boundary((at + 120).min(w.len()))]
        );
    }
}

fn ok(c: &Value) -> &Value {
    &c["output"]["ok"]
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn words_of(v: &Value) -> Vec<AsrWord> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|w| AsrWord {
                    word: s(&w["word"]).to_string(),
                    start: num(&w["start"]),
                    end: num(&w["end"]),
                    energy: w.get("energy").and_then(Value::as_f64),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn words_json(w: &[AsrWord]) -> Value {
    Value::Array(w.iter().map(AsrWord::to_json).collect())
}

fn segments_of(v: &Value) -> Vec<AsrSegment> {
    cues::parse_verbose_json(&json!({ "segments": v })).segments
}

fn opt_f(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn cue_opts(v: &Value) -> CueOptions {
    CueOptions {
        max_chars: opt_f(&v["maxChars"]),
        min_duration: opt_f(&v["minDuration"]),
        max_duration: opt_f(&v["maxDuration"]),
        pause_split: opt_f(&v["pauseSplit"]),
        hard_gap: opt_f(&v["hardGap"]),
        reading_tail: opt_f(&v["readingTail"]),
        reading_cps: opt_f(&v["readingCps"]),
        tone_shift_db: opt_f(&v["toneShiftDb"]),
    }
}

fn lines_of(v: &Value) -> Vec<TranslateLine> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|l| TranslateLine {
            i: l["i"].as_i64().unwrap(),
            en: s(&l["en"]).to_string(),
        })
        .collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| s(x).to_string()).collect())
        .unwrap_or_default()
}

fn cfg_of(v: &Value) -> CommentaryConfig {
    CommentaryConfig {
        transcribe_mode: if s(&v["transcribeMode"]) == "embedded" {
            ServiceMode::Embedded
        } else {
            ServiceMode::Remote
        },
        translate_mode: if s(&v["translateMode"]) == "embedded" {
            ServiceMode::Embedded
        } else {
            ServiceMode::Remote
        },
        transcribe_url: s(&v["transcribeUrl"]).into(),
        transcribe_model: s(&v["transcribeModel"]).into(),
        translate_url: s(&v["translateUrl"]).into(),
        translate_model: s(&v["translateModel"]).into(),
        translate_engine: if s(&v["translateEngine"]) == "mt" {
            TranslateEngine::Mt
        } else {
            TranslateEngine::Chat
        },
        translate_provider: match s(&v["translateProvider"]) {
            "openai" => TranslateProvider::Openai,
            "minimax" => TranslateProvider::Minimax,
            _ => TranslateProvider::Ollama,
        },
        translate_api_key: s(&v["translateApiKey"]).into(),
        batch: v["batch"].as_u64().unwrap() as usize,
        parallel: v["parallel"].as_u64().unwrap() as usize,
        chunk_sec: v["chunkSec"].as_u64().unwrap() as u32,
        disabled_reason: v["disabledReason"].as_str().map(String::from),
    }
}

fn opt_str(o: Option<&str>) -> Value {
    o.map_or(Value::Null, Value::from)
}

fn tp_of(v: &Value) -> TimedPlay {
    TimedPlay {
        seq: num(&v["seq"]),
        period: num(&v["period"]),
        clock_sec: num(&v["clock_sec"]),
        wall: num(&v["wall"]),
    }
}

fn anchors_of(v: &Value) -> Vec<ResolvedAnchor> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|a| ResolvedAnchor {
            wall: num(&a["wall"]),
            video: num(&a["video"]),
            method: s(&a["method"]).into(),
            period: num(&a["period"]),
            clock_sec: num(&a["clock_sec"]),
        })
        .collect()
}

fn anchors_json(a: &[ResolvedAnchor]) -> Value {
    Value::Array(
        a.iter()
            .map(|a| json!({ "wall": js_num_value(a.wall), "video": js_num_value(a.video), "method": a.method, "period": js_num_value(a.period), "clock_sec": js_num_value(a.clock_sec) }))
            .collect(),
    )
}

fn obs_json(o: &[FrameObservation]) -> Value {
    Value::Array(
        o.iter()
            .map(|x| {
                let mut m = Map::new();
                m.insert("video_ts".into(), js_num_value(x.video_ts));
                m.insert("period".into(), x.period.map_or(Value::Null, js_num_value));
                m.insert("clock_sec".into(), js_num_value(x.clock_sec));
                if let Some(sc) = &x.scores {
                    m.insert(
                        "scores".into(),
                        Value::Array(sc.iter().map(|v| js_num_value(*v)).collect()),
                    );
                }
                Value::Object(m)
            })
            .collect(),
    )
}

fn reading_of(v: &Value) -> Option<ScoreboardReading> {
    if v.is_null() {
        return None;
    }
    Some(ScoreboardReading {
        period: v["period"].as_f64(),
        clock_sec: num(&v["clock_sec"]),
        scores: v["scores"]
            .as_array()
            .map(|a| a.iter().map(num).collect())
            .unwrap_or_default(),
    })
}

fn set_env(vars: &Map<String, Value>) {
    for (k, v) in vars {
        match v.as_str() {
            Some(x) => std::env::set_var(k, x),
            None => std::env::remove_var(k),
        }
    }
}

fn clear_env(vars: &Map<String, Value>) {
    for k in vars.keys() {
        std::env::remove_var(k);
    }
}

#[test]
fn fonctions_pures_comme_node() {
    let _g = ENV.blocking_lock();
    let mut n = 0;
    let mut last_pcm: Vec<u8> = Vec::new();
    let all = cases();
    let full_roster = |v: &Value| roster::roster_index(&strings(v));
    let main_roster = all
        .iter()
        .find(|c| c["fn"] == "rosterIndex")
        .map(|c| full_roster(&c["input"]))
        .unwrap();
    for c in &all {
        let input = &c["input"];
        let want = ok(c);
        let what = format!(
            "{} {}",
            s(&c["fn"]),
            input.to_string().chars().take(100).collect::<String>()
        );
        let got: Value = match s(&c["fn"]) {
            "parseVerboseJson" => cues::parse_verbose_json(input).to_json(),
            "normText" => Value::from(cues::norm_text(s(input))),
            "isRepetitionLoop" => Value::from(cues::is_repetition_loop(s(input))),
            "hallucinationReason" => {
                let seg = &segments_of(&json!([input["seg"]]))[0];
                opt_str(cues::hallucination_reason(seg, input["isolated"].as_bool().unwrap(), input["prompt"].as_str()))
            }
            "filterTranscript" => {
                let t = cues::parse_verbose_json(&input["transcript"]);
                let (kept, dropped) = cues::filter_transcript(&t, input["prompt"].as_str());
                json!({ "transcript": kept.to_json(), "dropped": dropped.iter().map(|d| d.to_json()).collect::<Vec<_>>() })
            }
            "shiftTranscript" => {
                let t = cues::parse_verbose_json(&input["t"]);
                let from = input["from"].as_f64().unwrap_or(f64::NEG_INFINITY);
                let to = input["to"].as_f64().unwrap_or(f64::INFINITY);
                cues::shift_transcript(&t, num(&input["offset"]), from, to).to_json()
            }
            "mergeTranscripts" => {
                // Entrées : sorties de shiftTranscript (déjà décalées), relues telles quelles.
                let list: Vec<Transcript> = input.as_array().unwrap().iter().map(|t| Transcript { segments: segments_of(&t["segments"]), words: words_of(&t["words"]) }).collect();
                cues::merge_transcripts(&list).to_json()
            }
            "punctuateWords" => words_json(&cues::punctuate_words(&words_of(&input["words"]), &segments_of(&input["segments"]))),
            "wordsFromTranscript" => words_json(&cues::words_from_transcript(&cues::parse_verbose_json(input))),
            "joinWords" => Value::from(cues::join_words(&words_of(input))),
            "buildCues" => Value::Array(cues::build_cues(&words_of(&input["words"]), &cue_opts(&input["opts"])).iter().map(|c| c.to_json()).collect()),
            "cueEmphasis" => Value::from(cues::cue_emphasis(&words_of(&input["words"]), s(&input["text"]))),
            "wrapTwoLines" => Value::from(cues::wrap_two_lines(s(&input["text"]), input["max"].as_u64().unwrap() as usize)),
            "rosterIndex" => {
                let r = full_roster(input);
                json!({ "surnames": r.surnames.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(), "full": r.full })
            }
            "nearestSurname" => opt_str(roster::nearest_surname(s(input), &main_roster).as_deref()),
            "fixRosterNames" => Value::from(roster::fix_roster_names(s(input), &main_roster)),
            "editDistance" => Value::from(roster::edit_distance(s(&input[0]), s(&input[1]), input[2].as_u64().unwrap() as usize)),
            "foldName" => Value::from(roster::fold_name(s(input))),
            "nameRendered" => json!([
                roster::name_rendered(s(&input[0]), s(&input[1]), Some(&main_roster)),
                roster::name_rendered(s(&input[0]), s(&input[1]), None)
            ]),
            "TRANSLATE_SYSTEM_PROMPT" => Value::from(ai::TRANSLATE_SYSTEM_PROMPT),
            "PLAIN_TRANSLATE_PROMPT" => Value::from(ai::plain_translate_prompt()),
            "buildUserMessage" | "buildPlainMessage" => {
                let lines = lines_of(&input["lines"]);
                let ctx = strings(&input["context"]);
                let r = (!input["roster"].is_null()).then(|| full_roster(&input["roster"]));
                let model = s(&input["model"]);
                if c["fn"] == "buildUserMessage" {
                    Value::from(ai::build_user_message(&lines, &ctx, model, r.as_ref(), input["match"].as_str()))
                } else {
                    Value::from(ai::build_plain_message(&lines[1].en, &ctx, model, r.as_ref(), input["match"].as_str()))
                }
            }
            "parseTranslation" => Value::Array(ai::parse_translation(s(input)).into_iter().map(|(k, v)| json!([k, v])).collect()),
            "parsePlainTranslation" => Value::from(ai::parse_plain_translation(s(input))),
            "validTranslation" => Value::from(ai::valid_translation(s(&input[0]), input[1].as_str())),
            "anchors" => {
                let a = ai::anchors(s(input));
                json!({ "numbers": a.numbers, "names": a.names })
            }
            "consistentTranslation" => json!([
                ai::consistent_translation(s(&input[0]), s(&input[1]), None),
                ai::consistent_translation(s(&input[0]), s(&input[1]), Some(&main_roster))
            ]),
            "whisperPrompt" => {
                let many: Vec<String> = (0..100).map(|i| format!("Player Number{i}")).collect();
                json!([
                    ai::whisper_prompt("Los Angeles Lakers", "Portland Trail Blazers", &["LeBron James", "Deni Avdija"]),
                    ai::whisper_prompt("A", "B", &many),
                    ai::whisper_prompt::<&str>("A", "B", &[]),
                ])
            }
            "groupSentences" => Value::Array(
                ai::group_sentences(&lines_of(input))
                    .iter()
                    .map(|g| Value::Array(g.iter().map(|l| json!({ "i": l.i, "en": l.en })).collect()))
                    .collect(),
            ),
            "splitProportional" => {
                let w: Vec<f64> = input[1].as_array().unwrap().iter().map(num).collect();
                ai::split_proportional(s(&input[0]), &w).map_or(Value::Null, |v| json!(v))
            }
            "modelTraits" => {
                let m = s(input);
                json!({
                    "raw": ai::needs_raw_gemma(m), "noThink": ai::needs_no_think(m), "schema": ai::schema_safe(m),
                    "engine": ai::engine_for(m, None).as_str(), "forced": ai::engine_for(m, Some(" MT ")).as_str(),
                    "mt": ai::mt_prompt(&format!("Bang {m}")), "base": ai::ollama_base(&format!("http://x:1/{m}/v1")),
                })
            }
            "gemmaRawPrompt" => Value::from(ai::gemma_raw_prompt("SYS\nligne", "USER \"é\"")),
            "chatCompletion" => {
                let cfg = cfg_of(&input["cfg"]);
                let body = ai::chat_body(s(&input["system"]), s(&input["user"]), &cfg, num(&input["temperature"]), input["json"].as_bool().unwrap());
                let mut headers = Map::new();
                if !cfg.translate_api_key.is_empty() {
                    headers.insert("authorization".into(), Value::from(format!("Bearer {}", cfg.translate_api_key)));
                }
                headers.insert("content-type".into(), Value::from("application/json"));
                json!({ "content": "ok", "request": { "url": ai::chat_url(&cfg), "method": "POST", "headers": headers, "body": body } })
            }
            "mtComplete" => {
                let cfg = cfg_of(&input["cfg"]);
                json!({ "fr": "ok", "request": { "url": format!("{}/api/generate", ai::ollama_base(&cfg.translate_url)), "method": "POST", "headers": { "content-type": "application/json" }, "body": ai::mt_body(s(&input["en"]), &cfg) } })
            }
            "toWav" => {
                let w = to_wav(hex_decode(s(&input["hex"])), 24_000);
                json!({ "hex": hex_encode(&w.wav), "duration": js_num_value(w.duration), "sampleRate": w.sample_rate })
            }
            "settingsView" => {
                let set = Settings::from_pairs(input["settings"].as_object().unwrap().iter().map(|(k, v)| (k.as_str(), s(v))));
                let env = input["env"].as_object().unwrap().clone();
                let fixed = input["fixedEnv"].as_object().unwrap().clone();
                set_env(&fixed);
                set_env(&env);
                let mc = minimax_config(&set);
                let vc = voice_config(&set);
                let mut vcj = json!({
                    "engine": vc.engine.as_str(), "model": vc.model, "device": vc.device,
                    "voicesDir": vc.voices_dir.to_string_lossy(), "python": vc.python, "modelsDir": vc.models_dir.to_string_lossy(),
                });
                if let Some(r) = &vc.disabled_reason {
                    vcj["disabledReason"] = Value::from(r.clone());
                }
                let out = json!({
                    "openai": st::openai_settings_view(&set),
                    "minimax": st::minimax_settings_view(&set),
                    "autoTranslate": st::auto_translate_enabled(&set),
                    "vfMode": st::vf_mode(&set),
                    "minimaxConfig": {
                        "url": mc.url, "key": mc.key, "model": mc.model,
                        "voices": mc.voices.iter().map(|(r, v)| (r.clone(), Value::from(v.clone()))).collect::<Map<_, _>>(),
                        "speed": js_num_value(mc.speed),
                    },
                    "commentaryConfig": ai::commentary_config(&set).to_json(),
                    "voiceConfig": vcj,
                    "voiceEngine": voice_engine_name(&set).as_str(),
                    "openAiConfig": ai::openai_config(&set).map_or(Value::Null, |(key, model)| json!({ "key": key, "model": model })),
                    "minimaxTranslateConfig": ai::minimax_translate_config(&set).map_or(Value::Null, |o| json!({ "url": o.url, "key": o.key, "model": o.model })),
                });
                clear_env(&env);
                clear_env(&fixed);
                out
            }
            "parseMinimaxVoices" => match st::parse_minimax_voices(input) {
                Ok(v) => json!({ "value": v }),
                Err(e) => json!({ "error": e }),
            },
            "keyErrors" => json!([opt_str(st::api_key_error(s(input))), opt_str(st::minimax_key_error(s(input))), st::mask_api_key(s(input))]),
            "modelErrors" => json!([opt_str(st::model_error(s(input))), opt_str(st::minimax_model_error(s(input))), opt_str(st::minimax_translate_model_error(s(input)))]),
            "listVoices" => Value::Array(
                list_voices(Some(Path::new(s(input))))
                    .iter()
                    .map(|v| json!({ "id": v.id, "role": v.role, "label": v.label, "gender": v.gender }))
                    .collect(),
            ),
            "minimaxEmotion" => opt_str(minimax_emotion(input.as_f64())),
            "envelope" => {
                last_pcm = base64::engine::general_purpose::STANDARD.decode(s(&input["pcm"])).unwrap();
                let env = envelope_from_pcm(&last_pcm, 8000.0, FRAME_SEC);
                let ws = words_of(&input["words"]);
                json!({
                    "frameSec": js_num_value(env.frame_sec),
                    "power": env.power.iter().map(|p| js_num_value(*p as f64)).collect::<Vec<_>>(),
                    "energy": words_json(&add_word_energy(&ws, &env, 0.0)),
                    "shifted": words_json(&add_word_energy(&ws, &env, 0.3)),
                })
            }
            "withEnergy" => {
                let env = envelope_from_pcm(&last_pcm, 8000.0, FRAME_SEC);
                let t = with_energy(&cues::parse_verbose_json(&input["transcript"]), &env);
                let j = t.to_json();
                json!({ "words": j["words"], "segments": j["segments"] })
            }
            "computeRmsDb" => {
                let samples: Vec<f64> = last_pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f64).collect();
                Value::Array(compute_rms_db(&samples, num(&input["sampleRate"]), 1.0).into_iter().map(js_num_value).collect())
            }
            "detectCuts" => {
                let p: Vec<f64> = input["profile"].as_array().unwrap().iter().map(num).collect();
                let o = &input["opts"];
                let opts = CutOptions {
                    drop_db: opt_f(&o["dropDb"]),
                    absolute_db: opt_f(&o["absoluteDb"]),
                    min_len: o["minLen"].as_u64().map(|x| x as usize),
                    merge_gap: o["mergeGap"].as_u64().map(|x| x as usize),
                    window_sec: opt_f(&o["windowSec"]),
                };
                Value::Array(
                    detect_cuts(&p, &opts)
                        .iter()
                        .map(|c| json!({ "start": js_num_value(c.start), "end": js_num_value(c.end), "meanDb": js_num_value(c.mean_db) }))
                        .collect(),
                )
            }
            "rmsAccumulator" => {
                let mut acc = RmsAccumulator::new(4.0, 1.0);
                acc.push_buffer(&[0x00, 0x40, 0x00]);
                acc.push_buffer(&[0x40, 0x00, 0x40, 0x00, 0x40, 0x01]);
                acc.push_buffer(&[0x80]);
                Value::Array(acc.finish().into_iter().map(js_num_value).collect())
            }
            "nightWindow" => {
                match input["spec"].as_str() {
                    Some(x) => std::env::set_var("COMMENTARY_NIGHT_WINDOW", x),
                    None => std::env::remove_var("COMMENTARY_NIGHT_WINDOW"),
                }
                let at = chrono::DateTime::parse_from_rfc3339(s(&input["at"])).unwrap().with_timezone(&chrono::Utc);
                let out = json!({ "open": in_schedule_window(at), "label": night_window_label() });
                std::env::remove_var("COMMENTARY_NIGHT_WINDOW");
                out
            }
            // Rejoués par les tests asynchrones ci-dessous.
            "transcribeAudio" | "minimaxSynth" | "planRefinement" | "scanInputs" | "scanVideo" => continue,
            other => panic!("cas inconnu : {other}"),
        };
        same(&got, want, &what);
        n += 1;
    }
    assert!(n > 400, "{n} cas seulement");
}

fn hex_decode(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn scan_inputs(all: &[Value]) -> (Vec<TimedPlay>, Vec<BreakInfo>, f64) {
    let c = all.iter().find(|c| c["fn"] == "scanInputs").unwrap();
    let o = ok(c);
    let tp = o["tp"].as_array().unwrap().iter().map(tp_of).collect();
    let breaks = o["breaks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| BreakInfo {
            interval: Interval {
                start: num(&b["interval"]["start"]),
                end: num(&b["interval"]["end"]),
            },
            before: tp_of(&b["before"]),
            after: tp_of(&b["after"]),
        })
        .collect();
    (tp, breaks, num(&o["duration"]))
}

fn observations_of(v: &Value) -> Vec<FrameObservation> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|o| FrameObservation {
            video_ts: num(&o["video_ts"]),
            period: o["period"].as_f64(),
            clock_sec: num(&o["clock_sec"]),
            scores: o
                .get("scores")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(num).collect()),
        })
        .collect()
}

#[test]
fn planification_du_balayage_comme_node() {
    let all = cases();
    let (tp, breaks, _) = scan_inputs(&all);
    let mut n = 0;
    for c in all.iter().filter(|c| c["fn"] == "planRefinement") {
        let i = &c["input"];
        let anchors = anchors_of(&i["anchors"]);
        let obs = observations_of(&i["observations"]);
        let scanned: Vec<f64> = i["scanned"].as_array().unwrap().iter().map(num).collect();
        let o = &i["opts"];
        let plan = scan::plan_refinement(
            &scan::RefinementInput {
                anchors: &anchors,
                observations: &obs,
                scanned: &scanned,
                duration: num(&i["duration"]),
                tp: &tp,
                breaks: &breaks,
            },
            &scan::RefinementOptions {
                fine_step: opt_f(&o["fineStep"]),
                per_window: o["perWindow"].as_u64().map(|x| x as usize),
                max_frames: o["maxFrames"].as_u64().map(|x| x as usize),
                max_gap: opt_f(&o["maxGap"]),
            },
        )
        .unwrap();
        same(
            &Value::Array(plan.into_iter().map(js_num_value).collect()),
            ok(c),
            "planRefinement",
        );
        n += 1;
    }
    assert_eq!(n, 5);
}

/// Balayage rejoué : lectures et choix des observations cohérentes enregistrés côté Node.
struct Replay<'a> {
    reads: &'a Map<String, Value>,
    locates: &'a Map<String, Value>,
    snapshots: &'a Map<String, Value>,
    stale: bool,
    fail_every: usize,
    grabs: RefCell<Vec<f64>>,
    n: RefCell<usize>,
}

fn key(t: f64) -> String {
    js_num_value(t).to_string()
}

impl ScanDeps for Replay<'_> {
    type Location = Value;

    async fn grab(&self, t: f64) -> Result<Vec<u8>, String> {
        self.grabs.borrow_mut().push(t);
        *self.n.borrow_mut() += 1;
        if self.fail_every > 0 && (*self.n.borrow()).is_multiple_of(self.fail_every) {
            return Err("segment indisponible".into());
        }
        Ok(key(t).into_bytes())
    }

    async fn read(
        &self,
        image: &[u8],
        location: Option<&Value>,
    ) -> Result<Option<ScoreboardReading>, String> {
        let k = String::from_utf8(image.to_vec()).unwrap();
        let real = self
            .reads
            .get(&k)
            .unwrap_or_else(|| panic!("lecture inattendue à {k}"));
        if self.stale && location.is_some_and(|l| l["core"]["x"].as_f64() == Some(0.05)) {
            return Ok(None);
        }
        Ok(reading_of(real))
    }

    async fn locate(
        &self,
        frames: &[Vec<u8>],
        _progress: &dyn Fn(usize, usize),
    ) -> Result<LocateResult<Value>, String> {
        let readings = frames
            .iter()
            .map(|f| {
                let k = String::from_utf8(f.clone()).unwrap();
                reading_of(
                    self.locates
                        .get(&k)
                        .unwrap_or_else(|| panic!("localisation inattendue à {k}")),
                )
            })
            .collect();
        Ok(LocateResult {
            location: Some(
                json!({ "rect": { "x": 0.4, "y": 0.85, "w": 0.2, "h": 0.06 }, "core": { "x": 0.45, "y": 0.86, "w": 0.1, "h": 0.03 }, "textH": 0.03, "frames": 8, "strongFrames": 8 }),
            ),
            readings,
        })
    }

    fn consistent(&self, observations: &[FrameObservation]) -> Vec<ResolvedAnchor> {
        let k = obs_json(observations).to_string();
        anchors_of(self.snapshots.get(&k).unwrap_or_else(|| {
            panic!(
                "observations jamais vues par Node ({} lectures)",
                observations.len()
            )
        }))
    }
}

#[tokio::test]
async fn balayage_video_comme_node() {
    let all = cases();
    let (tp, breaks, duration) = scan_inputs(&all);
    let mut n = 0;
    for c in all.iter().filter(|c| c["fn"] == "scanVideo") {
        let i = &c["input"];
        let deps = Replay {
            reads: i["reads"].as_object().unwrap(),
            locates: i["locates"].as_object().unwrap(),
            snapshots: i["snapshots"].as_object().unwrap(),
            stale: i["stale"].as_bool().unwrap_or(false),
            fail_every: i["failEvery"].as_u64().unwrap_or(0) as usize,
            grabs: RefCell::new(Vec::new()),
            n: RefCell::new(0),
        };
        let r = scan::scan_video(
            &deps,
            ScanOptions {
                duration,
                tp: &tp,
                breaks: &breaks,
                location: (!i["location"].is_null()).then(|| i["location"].clone()),
                step_sec: opt_f(&i["stepSec"]),
                sample_frames: opt_f(&i["sampleFrames"]),
                refine_rounds: None,
                on_progress: None,
            },
        )
        .await
        .unwrap();
        let got = json!({
            "grabs": deps.grabs.borrow().iter().map(|t| js_num_value(*t)).collect::<Vec<_>>(),
            "observations": obs_json(&r.observations),
            "anchors": anchors_json(&r.anchors),
            "framesRead": r.frames_read,
            "perPeriod": r.per_period.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect::<Map<_, _>>(),
            "cachedLocation": r.cached_location,
            "location": r.location,
        });
        same(&got, ok(c), &format!("scanVideo {}", s(&i["label"])));
        n += 1;
    }
    assert_eq!(n, 4);
}

// ---------------------------------------------------------------- requêtes réelles face à un faux serveur

mod fake {
    use axum::body::Bytes;
    use axum::http::HeaderMap;
    use axum::Router;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Debug)]
    pub struct Req {
        pub path: String,
        pub headers: HeaderMap,
        pub body: Bytes,
    }

    /// Faux serveur local : chaque requête POST est enregistrée, `reply(chemin)` donne le corps JSON.
    pub async fn serve(reply: fn(&str) -> String) -> (String, Arc<Mutex<Vec<Req>>>) {
        let log: Arc<Mutex<Vec<Req>>> = Arc::default();
        let l2 = log.clone();
        let app = Router::new().fallback(
            move |uri: axum::http::Uri, headers: HeaderMap, body: Bytes| {
                let l2 = l2.clone();
                async move {
                    let path = uri.path().to_string();
                    let out = reply(&path);
                    l2.lock().unwrap().push(Req {
                        path,
                        headers,
                        body,
                    });
                    out
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), log)
    }
}

/// Parties d'un corps multipart, dans l'ordre : (nom, valeur | {filename, type, size}).
fn multipart_parts(headers: &axum::http::HeaderMap, body: &[u8]) -> Value {
    let ct = headers.get("content-type").unwrap().to_str().unwrap();
    let boundary = format!("--{}", ct.split("boundary=").nth(1).unwrap());
    let text = String::from_utf8_lossy(body).into_owned();
    let mut out = Vec::new();
    for part in text.split(&boundary).skip(1) {
        if part.starts_with("--") {
            break;
        }
        let (head, content) = part.split_once("\r\n\r\n").unwrap();
        let content = content.strip_suffix("\r\n").unwrap_or(content);
        let name = head
            .split("name=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        match head.split("filename=\"").nth(1) {
            Some(f) => {
                let filename = f.split('"').next().unwrap();
                let ty = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("Content-Type: ")
                            .or_else(|| l.strip_prefix("content-type: "))
                    })
                    .unwrap();
                out.push(
                    json!([name, { "filename": filename, "type": ty, "size": content.len() }]),
                );
            }
            None => out.push(json!([name, content])),
        }
    }
    Value::Array(out)
}

static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn transcription_multipart_comme_node() {
    let _g = ENV.lock().await;
    let all = cases();
    let (base, log) =
        fake::serve(|_| r#"{"text":" x","segments":[{"start":0,"end":1,"text":" x"}]}"#.into())
            .await;
    let dir = tempfile::tempdir().unwrap();
    let mut n = 0;
    for c in all.iter().filter(|c| c["fn"] == "transcribeAudio") {
        let i = &c["input"];
        let file = dir.path().join(s(&i["name"]));
        std::fs::write(&file, [7u8; 32]).unwrap();
        std::env::set_var("TRANSCRIBE_API_KEY", s(&i["key"]));
        let mut cfg =
            cfg_of(&all.iter().find(|c| c["fn"] == "chatCompletion").unwrap()["input"]["cfg"]);
        cfg.transcribe_url = format!("{base}/v1");
        let o = ai::TranscribeOptions {
            prompt: i["prompt"].as_str().map(String::from),
            ..Default::default()
        };
        let t = ai::transcribe_audio(&file.to_string_lossy(), &cfg, &o)
            .await
            .unwrap();
        let want = ok(c);
        same(&t.to_json(), &want["transcript"], "transcription");
        let req = log.lock().unwrap().pop().unwrap();
        assert_eq!(req.path, "/v1/audio/transcriptions");
        same(
            &multipart_parts(&req.headers, &req.body),
            &want["request"]["body"],
            "multipart",
        );
        let auth = req
            .headers
            .get("authorization")
            .map(|v| v.to_str().unwrap().to_string());
        same(
            &opt_str(auth.as_deref()),
            &want["request"]["headers"]["authorization"],
            "Authorization",
        );
        n += 1;
    }
    std::env::remove_var("TRANSCRIBE_API_KEY");
    assert_eq!(n, 3);
}

#[tokio::test]
async fn requetes_minimax_comme_node() {
    let _g = ENV.lock().await;
    let all = cases();
    let (base, log) = fake::serve(|path| {
        if path.ends_with("/v1/get_voice") {
            let voices: Vec<Value> = ["French_Male_Speech_New", "French_MaleNarrator", "French_CasualMan", "French_FemaleAnchor"].iter().map(|v| json!({ "voice_id": v })).collect();
            json!({ "base_resp": { "status_code": 0 }, "system_voice": voices }).to_string()
        } else {
            let wav = to_wav(vec![0u8; 4800], 24_000).wav;
            json!({ "base_resp": { "status_code": 0 }, "data": { "audio": hex_encode(&wav) }, "extra_info": { "audio_sample_rate": 24000 } }).to_string()
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let mut n = 0;
    for c in all.iter().filter(|c| c["fn"] == "minimaxSynth") {
        let env = c["input"].as_object().unwrap().clone();
        set_env(&env);
        std::env::set_var("MINIMAX_API_URL", &base);
        std::env::set_var("MINIMAX_RETRY_MS", "0");
        log.lock().unwrap().clear();
        let set = Settings::default();
        let sess = basketland_server::media::voice_minimax::MinimaxVoiceSession::open(
            &set,
            None,
            |_| async { Err("pas de Python".to_string()) },
        )
        .await
        .unwrap();
        let mut results = Vec::new();
        for (text, voice, emphasis) in [
            ("  Quel contre   de Wembanyama !", "B4", None),
            ("Quel dunk !", "A", Some(2.0)),
            ("Belle passe.", "B1", Some(1.0)),
            ("Remise en jeu.", "A", Some(0.5)),
        ] {
            let out = dir.path().join("v.wav");
            let (d, sr) = sess
                .synth(text, voice, &out.to_string_lossy(), None, emphasis)
                .await
                .unwrap();
            results.push(json!({ "duration": js_num_value(d), "sampleRate": sr }));
        }
        let want = ok(c);
        same(&Value::Array(results), &want["results"], "résultats");
        same(&json!(sess.voices()), &want["voices"], "voix");
        let reqs = log.lock().unwrap().clone();
        let wreqs = want["requests"].as_array().unwrap();
        assert_eq!(reqs.len(), wreqs.len());
        for (r, w) in reqs.iter().zip(wreqs) {
            let wurl = s(&w["url"]);
            assert!(wurl.ends_with(&r.path), "{wurl} / {}", r.path);
            assert_eq!(
                String::from_utf8_lossy(&r.body),
                s(&w["body"]),
                "corps {}",
                r.path
            );
            assert_eq!(
                r.headers.get("authorization").unwrap().to_str().unwrap(),
                s(&w["headers"]["authorization"])
            );
            assert_eq!(
                r.headers.get("content-type").unwrap().to_str().unwrap(),
                "application/json"
            );
        }
        // Corps construits hors session : identiques aussi.
        let mc = minimax_config(&set);
        assert_eq!(
            synth_body(&mc, "French_CasualMan", "Belle passe.", Some(1.0)).to_string(),
            s(&wreqs[3]["body"])
        );
        clear_env(&env);
        std::env::remove_var("MINIMAX_API_URL");
        std::env::remove_var("MINIMAX_RETRY_MS");
        n += 1;
    }
    assert_eq!(n, 3);
}

#[tokio::test]
async fn requetes_de_traduction_envoyees_comme_node() {
    let _g = ENV.lock().await;
    let all = cases();
    let (base, log) = fake::serve(|_| {
        r#"{"choices":[{"message":{"content":"ok"}}],"message":{"content":"ok"},"response":"ok"}"#
            .into()
    })
    .await;
    let mut n = 0;
    for c in all.iter().filter(|c| c["fn"] == "chatCompletion") {
        let i = &c["input"];
        let mut cfg = cfg_of(&i["cfg"]);
        let want = &ok(c)["request"];
        let wurl = s(&want["url"]).to_string();
        // Même chemin, servi par le faux serveur.
        let path = url::Url::parse(&wurl).unwrap().path().to_string();
        let prefix = cfg.translate_url.clone();
        let local = url::Url::parse(&prefix).unwrap();
        cfg.translate_url = format!("{base}{}", local.path().trim_end_matches('/'));
        let content = ai::chat_completion(
            s(&i["system"]),
            s(&i["user"]),
            &cfg,
            &ai::TranslateContext::default(),
            num(&i["temperature"]),
            i["json"].as_bool().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(content, "ok");
        let r = log.lock().unwrap().pop().unwrap();
        assert_eq!(r.path, path);
        assert_eq!(String::from_utf8_lossy(&r.body), s(&want["body"]));
        assert_eq!(
            r.headers.get("content-type").unwrap().to_str().unwrap(),
            "application/json"
        );
        assert_eq!(
            r.headers
                .get("authorization")
                .map(|v| v.to_str().unwrap().to_string()),
            want["headers"]["authorization"].as_str().map(String::from)
        );
        n += 1;
    }
    assert_eq!(n, 32);
}
