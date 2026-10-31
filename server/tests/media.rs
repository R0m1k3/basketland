//! Comportement des fondations médias (étape 6a), cas portés des tests
//! vitest : clients de transcription, de traduction et de voix face à de faux
//! serveurs locaux, processus Whisper / voix / Ollama remplacés par de faux
//! processus au même protocole (`tests/helpers/*.py`), extraction audio par
//! le vrai ffmpeg.

use basketland_server::media::abort::AbortSignal;
use basketland_server::media::audio::{
    cut_audio, extract_audio_chunk, extract_full_audio, ExtractOptions,
};
use basketland_server::media::audio_energy::audio_envelope;
use basketland_server::media::commentary_ai::{
    self as ai, CommentaryConfig, ServiceMode, TranslateContext, TranslateEngine, TranslateLine,
    TranslateProvider, TranslatedLine,
};
use basketland_server::media::local_ai::{OllamaSession, WhisperSession};
use basketland_server::media::voice_ai::{
    self, open_voice_session, prepare_voice_models, voice_models_download, VoiceSession,
};
use basketland_server::media::voice_minimax::{to_wav, MinimaxVoiceSession};
use basketland_server::settings::{keys, Settings};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---------------------------------------------------------------- outils

static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const ENV_KEYS: [&str; 47] = [
    "PARAKEET_PYTHON",
    "PARAKEET_WORKER",
    "WHISPER_BEAM_SIZE",
    "TRANSCRIBE_URL",
    "TRANSLATE_URL",
    "TRANSCRIBE_MODEL",
    "TRANSLATE_MODEL",
    "TRANSLATE_BATCH",
    "TRANSLATE_PARALLEL",
    "TRANSLATE_ENGINE",
    "TRANSLATE_API_KEY",
    "TRANSLATE_JSON_SCHEMA",
    "TRANSLATE_PROMPT_FILE",
    "COMMENTARY_DISABLED",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "MINIMAX_API_KEY",
    "MINIMAX_API_URL",
    "MINIMAX_TTS_MODEL",
    "MINIMAX_TTS_SPEED",
    "MINIMAX_TRANSLATE",
    "MINIMAX_TRANSLATE_MODEL",
    "MINIMAX_VOICE_A",
    "MINIMAX_VOICE_B4",
    "MINIMAX_VOICE_B1",
    "MINIMAX_VOICE_F",
    "MINIMAX_EMOTIONS",
    "MINIMAX_RETRY_MS",
    "WHISPER_PYTHON",
    "WHISPER_WORKER",
    "WHISPER_LOAD_TIMEOUT_MS",
    "OLLAMA_BIN",
    "OLLAMA_PORT",
    "TTS_ENGINE",
    "TTS_EMBED_DEVICE",
    "TTS_DEVICE",
    "TTS_PYTHON",
    "TTS_WORKER",
    "TTS_MODEL",
    "TTS_LOAD_TIMEOUT_MS",
    "VOICES_DIR",
    "MODELS_DIR",
    "DUB_DISABLED",
    "FAKE_LOG",
    "TRANSCRIBE_API_KEY",
    "TTS_EMBED_THREADS",
    "BACKGROUND_NICE",
];

/// Environnement propre le temps d'un test (variables lues à chaque appel, comme `process.env`).
struct EnvGuard(#[allow(dead_code)] tokio::sync::MutexGuard<'static, ()>);

async fn clean_env() -> EnvGuard {
    let g = ENV.lock().await;
    for k in ENV_KEYS {
        std::env::remove_var(k);
    }
    EnvGuard(g)
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for k in ENV_KEYS {
            std::env::remove_var(k);
        }
    }
}

fn set(k: &str, v: impl AsRef<std::ffi::OsStr>) {
    std::env::set_var(k, v);
}

fn helper(name: &str) -> String {
    format!("{}/tests/helpers/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn python() -> Option<String> {
    let ok = Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        eprintln!("python3 absent : test du protocole des processus Python sauté");
    }
    ok.then(|| "python3".to_string())
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0, simple test d'existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

async fn wait_dead(pid: u32) {
    for _ in 0..100 {
        if !pid_alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("processus {pid} toujours vivant");
}

type Handler = Arc<dyn Fn(&str, &Value) -> (u16, String) + Send + Sync>;

/// Lot demandé : identifiants des lignes, température.
type Asked = (Vec<i64>, f64);

#[derive(Clone, Debug)]
struct Req {
    path: String,
    headers: axum::http::HeaderMap,
    body: String,
}

/// Faux serveur local : `handler(chemin, corps JSON)` rend (statut, corps).
async fn serve(handler: Handler) -> (String, Arc<Mutex<Vec<Req>>>) {
    let log: Arc<Mutex<Vec<Req>>> = Arc::default();
    let l2 = log.clone();
    let app = axum::Router::new().fallback(
        move |uri: axum::http::Uri, headers: axum::http::HeaderMap, body: axum::body::Bytes| {
            let (l2, handler) = (l2.clone(), handler.clone());
            async move {
                let text = String::from_utf8_lossy(&body).into_owned();
                let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let (status, out) = handler(uri.path(), &v);
                l2.lock().unwrap().push(Req {
                    path: uri.path().into(),
                    headers,
                    body: text,
                });
                (axum::http::StatusCode::from_u16(status).unwrap(), out)
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), log)
}

fn chat_res(content: &str) -> (u16, String) {
    (
        200,
        json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] })
            .to_string(),
    )
}

/// Lignes du lot demandées dans le message utilisateur.
fn requested_lines(body: &Value) -> Vec<(i64, String)> {
    let user = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_string();
    let start = user.find("\n{").unwrap() + 1;
    let end = user[start..]
        .find("}\n")
        .map_or(user.len(), |e| start + e + 1);
    let j: Value = serde_json::from_str(&user[start..end]).unwrap();
    j["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["i"].as_i64().unwrap(),
                l["en"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn is_plain(body: &Value) -> bool {
    body["messages"][0]["content"].as_str() == Some(ai::plain_translate_prompt())
}

fn remote_cfg(base: &str) -> CommentaryConfig {
    set("TRANSCRIBE_URL", format!("{base}/v1/"));
    set("TRANSLATE_URL", format!("{base}/v1"));
    set("TRANSLATE_MODEL", "mistral-nemo:12b");
    ai::commentary_config(&Settings::default())
}

fn lines(v: &[(i64, &str)]) -> Vec<TranslateLine> {
    v.iter()
        .map(|(i, en)| TranslateLine {
            i: *i,
            en: en.to_string(),
        })
        .collect()
}

fn ok_line(i: i64, fr: &str) -> TranslatedLine {
    TranslatedLine {
        i,
        fr: fr.into(),
        untranslated: false,
    }
}

fn ctx() -> TranslateContext {
    TranslateContext {
        retry_delay: Some(Duration::ZERO),
        ..Default::default()
    }
}

// ---------------------------------------------------------------- configuration

#[tokio::test]
async fn configuration_des_services() {
    let _g = clean_env().await;
    let s = Settings::default();
    set("WHISPER_PYTHON", "/nexiste/pas/python");
    set("OLLAMA_BIN", "/nexiste/pas/ollama");
    assert!(ai::commentary_config(&s)
        .disabled_reason
        .unwrap()
        .contains("TRANSCRIBE_URL, TRANSLATE_URL"));
    set("TRANSCRIBE_URL", "http://x:8000/v1");
    assert_eq!(
        ai::commentary_config(&s).disabled_reason.as_deref(),
        Some("serveur de traduction non configuré (TRANSLATE_URL)")
    );
    set("TRANSLATE_URL", "http://x:11434/v1");
    assert_eq!(ai::commentary_config(&s).disabled_reason, None);
    set("COMMENTARY_DISABLED", "1");
    assert!(ai::commentary_config(&s)
        .disabled_reason
        .unwrap()
        .contains("COMMENTARY_DISABLED=1"));
    std::env::remove_var("COMMENTARY_DISABLED");
    std::env::remove_var("TRANSCRIBE_URL");
    std::env::remove_var("TRANSLATE_URL");
    // Binaires présents : mode embarqué, Ollama sur 127.0.0.1 ; une URL externe prend le pas.
    set("WHISPER_PYTHON", "/bin/sh");
    set("WHISPER_WORKER", helper("fake_whisper_worker.py"));
    set("OLLAMA_BIN", helper("fake_ollama.py"));
    let c = ai::commentary_config(&s);
    assert_eq!(
        (
            c.transcribe_mode,
            c.translate_mode,
            c.translate_url.as_str(),
            c.disabled_reason
        ),
        (
            ServiceMode::Embedded,
            ServiceMode::Embedded,
            "http://127.0.0.1:11434/v1",
            None
        )
    );
    set("TRANSLATE_URL", "http://gpu.local:11434/v1");
    let c = ai::commentary_config(&s);
    assert_eq!(
        (
            c.transcribe_mode,
            c.translate_mode,
            c.translate_url.as_str()
        ),
        (
            ServiceMode::Embedded,
            ServiceMode::Remote,
            "http://gpu.local:11434/v1"
        )
    );
    // Clé OpenAI de la page Paramètres, puis MiniMax devant OpenAI.
    let s = Settings::from_pairs([(keys::OPENAI_API_KEY, "sk-test-0123456789abcd")]);
    let c = ai::commentary_config(&s);
    assert_eq!(
        (
            c.translate_provider,
            c.translate_url.as_str(),
            c.translate_model.as_str(),
            c.parallel
        ),
        (
            TranslateProvider::Openai,
            "https://api.openai.com/v1",
            "gpt-5.4-mini",
            8
        )
    );
    let s = Settings::from_pairs([
        (keys::OPENAI_API_KEY, "sk"),
        (keys::MINIMAX_TRANSLATE, "1"),
        (keys::MINIMAX_API_KEY, "mm-key"),
    ]);
    let c = ai::commentary_config(&s);
    assert_eq!(
        (
            c.translate_provider,
            c.translate_url.as_str(),
            c.translate_api_key.as_str()
        ),
        (
            TranslateProvider::Minimax,
            "https://api.minimax.io/v1",
            "mm-key"
        )
    );
    // Base illisible : pas de MiniMax, même demandé par variable.
    set("MINIMAX_TRANSLATE", "1");
    set("MINIMAX_API_KEY", "mm-env");
    assert_eq!(
        ai::commentary_config(&Settings::default()).translate_provider,
        TranslateProvider::Minimax
    );
    assert_eq!(
        ai::commentary_config(&Settings::unreadable()).translate_provider,
        TranslateProvider::Ollama
    );
}

#[tokio::test]
async fn prompt_systeme_remplacable_par_un_fichier() {
    let _g = clean_env().await;
    assert_eq!(ai::translate_system_prompt(), ai::TRANSLATE_SYSTEM_PROMPT);
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("prompt.txt");
    std::fs::write(&f, "  Traduis, point.\n").unwrap();
    set("TRANSLATE_PROMPT_FILE", &f);
    assert_eq!(ai::translate_system_prompt(), "Traduis, point.");
    set("TRANSLATE_PROMPT_FILE", "/nexiste/pas");
    assert_eq!(ai::translate_system_prompt(), ai::TRANSLATE_SYSTEM_PROMPT);
}

// ---------------------------------------------------------------- transcription

#[tokio::test]
async fn transcription_et_erreurs_du_serveur() {
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("chunk-000.ogg");
    std::fs::write(&file, [1u8; 2048]).unwrap();
    let file = file.to_string_lossy().into_owned();
    let (base, log) = serve(Arc::new(|_, _| (200, json!({ "text": " Timeout.", "segments": [{ "id": 0, "start": 1, "end": 1.8, "text": " Timeout.", "avg_logprob": -0.3, "compression_ratio": 0.9, "no_speech_prob": 0.1 }] }).to_string()))).await;
    let cfg = remote_cfg(&base);
    assert_eq!(cfg.transcribe_url, format!("{base}/v1"));
    let t = ai::transcribe_audio(&file, &cfg, &Default::default())
        .await
        .unwrap();
    assert!(t.words.is_empty());
    assert_eq!(t.segments.len(), 1);
    assert_eq!(log.lock().unwrap()[0].path, "/v1/audio/transcriptions");

    // 4xx : pas de nouvel essai.
    let (base, log) = serve(Arc::new(|_, _| {
        (404, r#"{"detail":"Model not found"}"#.into())
    }))
    .await;
    let cfg = remote_cfg(&base);
    let e = ai::transcribe_audio(&file, &cfg, &Default::default())
        .await
        .unwrap_err();
    assert_eq!(
        e.message(),
        r#"serveur de transcription : HTTP 404 — {"detail":"Model not found"}"#
    );
    assert!(matches!(e, ai::AiError::Service(_)));
    assert_eq!(log.lock().unwrap().len(), 1);

    // 5xx : un nouvel essai, puis ServiceError.
    let (base, log) = serve(Arc::new(|_, _| (503, "  occupé \n ".into()))).await;
    let cfg = remote_cfg(&base);
    let o = ai::TranscribeOptions {
        retry_delay: Some(Duration::ZERO),
        ..Default::default()
    };
    let e = ai::transcribe_audio(&file, &cfg, &o).await.unwrap_err();
    assert_eq!(
        e.message(),
        "serveur de transcription : HTTP 503 —  occupé "
    );
    assert_eq!(log.lock().unwrap().len(), 2);

    // Réponses inattendues.
    let (base, _) = serve(Arc::new(|_, _| (200, "[1]".into()))).await;
    let e = ai::transcribe_audio(&file, &remote_cfg(&base), &o)
        .await
        .unwrap_err();
    assert_eq!(
        e.message(),
        "réponse de transcription inattendue (ni segments ni texte)"
    );
    let (base, _) = serve(Arc::new(|_, _| (200, "pas du JSON".into()))).await;
    let e = ai::transcribe_audio(&file, &remote_cfg(&base), &o)
        .await
        .unwrap_err();
    assert!(e
        .message()
        .starts_with("réponse de transcription illisible"));

    // Serveur injoignable : ECONNREFUSED après un nouvel essai.
    let port = {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    let cfg = remote_cfg(&format!("http://127.0.0.1:{port}"));
    let e = ai::transcribe_audio(&file, &cfg, &o).await.unwrap_err();
    assert_eq!(
        e.message(),
        format!("serveur de transcription injoignable (http://127.0.0.1:{port}/v1) : ECONNREFUSED")
    );
    // Fichier absent : erreur ordinaire, pas une panne du service.
    let e = ai::transcribe_audio("/nexiste/pas.ogg", &cfg, &o)
        .await
        .unwrap_err();
    assert_eq!(
        e,
        ai::AiError::Other("ENOENT: no such file or directory, open '/nexiste/pas.ogg'".into())
    );
}

// ---------------------------------------------------------------- traduction par lots

const FR: [(i64, &str); 3] = [
    (1, "Il déclenche de loin."),
    (2, "Dedans !"),
    (3, "Temps mort Portland."),
];

fn fr_of(i: i64) -> &'static str {
    FR.iter().find(|(k, _)| *k == i).map_or("", |(_, v)| v)
}

const LINES: [(i64, &str); 3] = [
    (1, "He pulls up from deep."),
    (2, "Bang!"),
    (3, "Timeout Portland."),
];

#[tokio::test]
async fn lot_valide_une_seule_requete() {
    let _g = clean_env().await;
    let (base, log) = serve(Arc::new(|_, b| {
        let t: Vec<Value> = requested_lines(b)
            .iter()
            .map(|(i, _)| json!({ "i": i, "fr": fr_of(*i) }))
            .collect();
        chat_res(&json!({ "t": t }).to_string())
    }))
    .await;
    let cfg = remote_cfg(&base);
    let out = ai::translate_batch(
        &lines(&LINES),
        &["Jokic with the ball.".into()],
        &cfg,
        &ctx(),
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        LINES
            .iter()
            .map(|(i, _)| ok_line(*i, fr_of(*i)))
            .collect::<Vec<_>>()
    );
    let reqs = log.lock().unwrap().clone();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path, "/v1/chat/completions");
    let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
    assert_eq!(
        (
            body["model"].as_str(),
            body["temperature"].as_f64(),
            body["response_format"]["type"].as_str()
        ),
        (Some("mistral-nemo:12b"), Some(0.2), Some("json_object"))
    );
    assert_eq!(
        body["messages"][0]["content"].as_str(),
        Some(ai::TRANSLATE_SYSTEM_PROMPT)
    );
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains(r#""context":["Jokic with the ball."]"#));
}

#[tokio::test]
async fn ollama_embarque_api_native() {
    let _g = clean_env().await;
    let (base, log) = serve(Arc::new(|_, b| {
        let t: Vec<Value> = requested_lines(b)
            .iter()
            .map(|(i, _)| json!({ "i": i, "fr": fr_of(*i) }))
            .collect();
        (
            200,
            json!({ "message": { "role": "assistant", "content": json!({ "t": t }).to_string() } })
                .to_string(),
        )
    }))
    .await;
    let mut cfg = remote_cfg(&base);
    cfg.translate_mode = ServiceMode::Embedded;
    cfg.translate_model = "gemma4:e4b".into();
    let out = ai::translate_batch(&lines(&LINES), &[], &cfg, &ctx())
        .await
        .unwrap();
    assert!(out.iter().all(|l| !l.untranslated));
    cfg.translate_model = "gemma4:12b".into();
    ai::translate_batch(&lines(&LINES), &[], &cfg, &ctx())
        .await
        .unwrap();
    let reqs = log.lock().unwrap().clone();
    assert_eq!(reqs[0].path, "/api/chat");
    let b0: Value = serde_json::from_str(&reqs[0].body).unwrap();
    assert_eq!(
        b0["options"],
        json!({ "temperature": 0.2, "top_p": 0.9, "num_ctx": 4096, "num_predict": 1200 })
    );
    assert_eq!(b0["format"]["required"], json!(["t"]));
    let b1: Value = serde_json::from_str(&reqs[1].body).unwrap();
    assert!(b1.get("format").is_none());
}

#[tokio::test]
async fn lot_decale_nouvel_essai_puis_moities() {
    let _g = clean_env().await;
    const OK: [(i64, &str); 4] = [
        (1, "Brunson marque à trois points."),
        (2, "Tatum au cercle."),
        (3, "Les Knicks mènent 19-16."),
        (4, "Temps mort Boston."),
    ];
    let ok_of = |i: i64| OK.iter().find(|(k, _)| *k == i).unwrap().1;
    let asked: Arc<Mutex<Vec<Asked>>> = Arc::default();
    let a2 = asked.clone();
    let (base, _) = serve(Arc::new(move |_, b| {
        let req = requested_lines(b);
        a2.lock().unwrap().push((req.iter().map(|l| l.0).collect(), b["temperature"].as_f64().unwrap()));
        let t: Vec<Value> = if req.len() == 4 {
            req.iter().enumerate().map(|(k, (i, _))| json!({ "i": i, "fr": if k == 0 { "Et voilà." } else { ok_of(req[k - 1].0) } })).collect()
        } else {
            req.iter().map(|(i, _)| json!({ "i": i, "fr": ok_of(*i) })).collect()
        };
        chat_res(&json!({ "t": t }).to_string())
    }))
    .await;
    let cfg = remote_cfg(&base);
    let input = lines(&[
        (1, "Brunson got a three."),
        (2, "Tatum to the rim."),
        (3, "Knicks up 19-16."),
        (4, "Timeout Boston."),
    ]);
    let out = ai::translate_batch(&input, &[], &cfg, &ctx())
        .await
        .unwrap();
    assert_eq!(
        out,
        OK.iter().map(|(i, f)| ok_line(*i, f)).collect::<Vec<_>>()
    );
    assert_eq!(
        *asked.lock().unwrap(),
        vec![
            (vec![1, 2, 3, 4], 0.2),
            (vec![1, 2, 3, 4], 0.0),
            (vec![1, 2], 0.2),
            (vec![3, 4], 0.2)
        ]
    );
}

#[tokio::test]
async fn lot_incomplet_jusqu_a_l_anglais_marque() {
    let _g = clean_env().await;
    let asked: Arc<Mutex<Vec<Vec<i64>>>> = Arc::default();
    let plain: Arc<Mutex<Vec<f64>>> = Arc::default();
    let (a2, p2) = (asked.clone(), plain.clone());
    let (base, _) = serve(Arc::new(move |_, b| {
        if is_plain(b) {
            p2.lock().unwrap().push(b["temperature"].as_f64().unwrap());
            return chat_res("");
        }
        let req = requested_lines(b);
        a2.lock().unwrap().push(req.iter().map(|l| l.0).collect());
        if req.len() > 1 || req[0].0 == 1 {
            let t: Vec<Value> = req
                .iter()
                .filter(|l| l.0 == 1)
                .map(|(i, _)| json!({ "i": i, "fr": fr_of(*i) }))
                .collect();
            return chat_res(&json!({ "t": t }).to_string());
        }
        if req[0].0 == 2 {
            return chat_res(r#"{"t":[{"i":2,"fr":"Dedans !"}]}"#);
        }
        chat_res(r#"{"t":[{"i":3,"fr":""}]}"#)
    }))
    .await;
    let cfg = remote_cfg(&base);
    let out = ai::translate_batch(&lines(&LINES), &[], &cfg, &ctx())
        .await
        .unwrap();
    assert_eq!(
        out,
        vec![
            ok_line(1, fr_of(1)),
            ok_line(2, "Dedans !"),
            TranslatedLine {
                i: 3,
                fr: "Timeout Portland.".into(),
                untranslated: true
            }
        ]
    );
    assert_eq!(
        *asked.lock().unwrap(),
        vec![
            vec![1, 2, 3],
            vec![1, 2, 3],
            vec![1, 2],
            vec![1, 2],
            vec![1],
            vec![2],
            vec![3],
            vec![3]
        ]
    );
    assert_eq!(*plain.lock().unwrap(), vec![0.2, 0.0]);
}

#[tokio::test]
async fn ligne_rebelle_rattrapee_en_texte_brut() {
    let _g = clean_env().await;
    let en = "Now Kamara from beyond the arc. And Edie with the board.";
    let (base, log) = serve(Arc::new(move |_, b| {
        if !is_plain(b) {
            return chat_res(&json!({ "t": [{ "i": 7, "fr": en }] }).to_string());
        }
        chat_res("Traduction : « Maintenant Kamara derrière l’arc. Et Edey au rebond. »")
    }))
    .await;
    let cfg = remote_cfg(&base);
    let o = TranslateContext {
        match_label: Some("Memphis Grizzlies @ Portland Trail Blazers".into()),
        ..ctx()
    };
    let out = ai::translate_batch(
        &lines(&[(7, en)]),
        &["Portland brings it up.".into()],
        &cfg,
        &o,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        vec![ok_line(
            7,
            "Maintenant Kamara derrière l’arc. Et Edey au rebond."
        )]
    );
    let reqs = log.lock().unwrap().clone();
    assert_eq!(reqs.len(), 3);
    let body: Value = serde_json::from_str(&reqs[2].body).unwrap();
    assert!(body.get("response_format").is_none());
    let sys = body["messages"][0]["content"].as_str().unwrap();
    assert!(sys.contains("« board » = rebond") && !sys.contains("{\"t\""));
    let user = body["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("match : Memphis Grizzlies @ Portland Trail Blazers"));
    assert!(user.contains("context (à ne pas traduire) :\nPortland brings it up."));
    assert!(user.contains(&format!("ligne :\n{en}")));
}

#[tokio::test]
async fn reponse_illisible_et_modele_absent() {
    let _g = clean_env().await;
    let (base, _) = serve(Arc::new(|_, _| chat_res("Désolé, je ne peux pas."))).await;
    let out = ai::translate_batch(&lines(&LINES[..1]), &[], &remote_cfg(&base), &ctx())
        .await
        .unwrap();
    assert_eq!(
        out,
        vec![TranslatedLine {
            i: 1,
            fr: "He pulls up from deep.".into(),
            untranslated: true
        }]
    );
    let (base, _) = serve(Arc::new(|_, _| {
        (
            404,
            r#"{"error":{"message":"model \"mistral-nemo:12b\" not found, try pulling it first"}}"#
                .into(),
        )
    }))
    .await;
    let e = ai::translate_batch(&lines(&LINES), &[], &remote_cfg(&base), &ctx())
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "modèle de traduction « mistral-nemo:12b » absent d'Ollama (ollama pull mistral-nemo:12b)"
    );
}

#[tokio::test]
async fn api_openai_et_minimax() {
    let _g = clean_env().await;
    let (base, log) = serve(Arc::new(|_, b| {
        let t: Vec<Value> = requested_lines(b)
            .iter()
            .map(|(i, _)| json!({ "i": i, "fr": "Dedans !" }))
            .collect();
        chat_res(&json!({ "t": t }).to_string())
    }))
    .await;
    let mut cfg = ai::commentary_config(&Settings::from_pairs([(
        keys::OPENAI_API_KEY,
        "sk-test-0123456789abcd",
    )]));
    cfg.translate_url = format!("{base}/v1");
    let out = ai::translate_batch(&lines(&[(1, "Bang!")]), &[], &cfg, &ctx())
        .await
        .unwrap();
    assert_eq!(out, vec![ok_line(1, "Dedans !")]);
    let r = log.lock().unwrap()[0].clone();
    assert_eq!(r.headers["authorization"], "Bearer sk-test-0123456789abcd");
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        (
            body["reasoning_effort"].as_str(),
            body.get("temperature"),
            body.get("top_p")
        ),
        (Some("low"), None, None)
    );

    let (base, _) = serve(Arc::new(|_, _| {
        (401, r#"{"error":{"message":"Incorrect API key"}}"#.into())
    }))
    .await;
    cfg.translate_url = format!("{base}/v1");
    let e = ai::translate_batch(&lines(&[(1, "Bang!")]), &[], &cfg, &ctx())
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "API OpenAI : clé refusée (vérifier la clé dans les paramètres)"
    );

    let s = Settings::from_pairs([
        (keys::MINIMAX_API_KEY, "mm-key-0123456789abcdef"),
        (keys::MINIMAX_TRANSLATE, "1"),
    ]);
    let mut cfg = ai::commentary_config(&s);
    assert_eq!(
        (cfg.translate_provider, cfg.translate_model.as_str()),
        (TranslateProvider::Minimax, "MiniMax-M3.1-Flash")
    );
    let (base, _) = serve(Arc::new(|_, _| {
        (
            200,
            json!({ "base_resp": { "status_code": 1008, "status_msg": "insufficient balance" } })
                .to_string(),
        )
    }))
    .await;
    cfg.translate_url = format!("{base}/v1");
    let e = ai::translate_batch(&lines(&[(1, "Bang!")]), &[], &cfg, &ctx())
        .await
        .unwrap_err();
    assert_eq!(e.message, "API MiniMax : crédit épuisé");
    let (base, _) = serve(Arc::new(|_, _| (401, "{}".into()))).await;
    cfg.translate_url = format!("{base}/v1");
    let e = ai::translate_batch(&lines(&[(1, "Bang!")]), &[], &cfg, &ctx())
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        "API MiniMax : clé refusée (vérifier la clé dans les paramètres)"
    );
    // Débit dépassé (1002) : une pause, un nouvel essai, puis le message.
    let (base, log) = serve(Arc::new(|_, _| {
        (
            200,
            json!({ "base_resp": { "status_code": 1002, "status_msg": "rate limit" } }).to_string(),
        )
    }))
    .await;
    cfg.translate_url = format!("{base}/v1");
    let e = ai::translate_batch(&lines(&[(1, "Bang!")]), &[], &cfg, &ctx())
        .await
        .unwrap_err();
    assert_eq!(e.message, "API MiniMax : rate limit (code 1002)");
    assert_eq!(log.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn modele_de_traduction_pur() {
    let _g = clean_env().await;
    let prompts: Arc<Mutex<Vec<String>>> = Arc::default();
    let p2 = prompts.clone();
    let (base, log) = serve(Arc::new(move |path, b| {
        assert_eq!(path, "/api/generate");
        let prompt = b["prompt"].as_str().unwrap().to_string();
        p2.lock().unwrap().push(prompt.clone());
        let en = prompt
            .split("English: ")
            .nth(1)
            .unwrap()
            .split("\nFrench:")
            .next()
            .unwrap()
            .to_string();
        let fr = if en == "Curry brings it up, looks for the screen." {
            " Curry remonte la balle, cherche l’écran."
        } else {
            " Dedans !"
        };
        (200, json!({ "response": fr, "done": true }).to_string())
    }))
    .await;
    let mut cfg = remote_cfg(&base);
    cfg.translate_engine = TranslateEngine::Mt;
    cfg.translate_model = ai::DEFAULT_TRANSLATE_MODEL.into();
    let out = ai::translate_batch(
        &lines(&[
            (1, "Curry brings it up,"),
            (2, "looks for the screen."),
            (3, "Bang!"),
        ]),
        &[],
        &cfg,
        &ctx(),
    )
    .await
    .unwrap();
    assert_eq!(prompts.lock().unwrap().len(), 2);
    assert!(out.iter().all(|l| !l.untranslated));
    assert_eq!(
        format!("{} {}", out[0].fr, out[1].fr),
        "Curry remonte la balle, cherche l’écran."
    );
    assert_eq!(out[2].fr, "Dedans !");
    let body: Value = serde_json::from_str(&log.lock().unwrap()[0].body).unwrap();
    assert_eq!(
        (
            body["raw"].as_bool(),
            body["options"]["top_k"].as_i64(),
            body["options"]["stop"].clone()
        ),
        (Some(true), Some(1), json!(["\n"]))
    );

    let (base, _) = serve(Arc::new(|_, _| (200, r#"{"response":""}"#.into()))).await;
    let mut cfg = remote_cfg(&base);
    cfg.translate_engine = TranslateEngine::Mt;
    let out = ai::translate_batch_mt(&lines(&[(1, "Timeout Portland.")]), &cfg, &ctx())
        .await
        .unwrap();
    assert_eq!(
        out,
        vec![TranslatedLine {
            i: 1,
            fr: "Timeout Portland.".into(),
            untranslated: true
        }]
    );
}

#[tokio::test]
async fn interruption_d_une_traduction() {
    let _g = clean_env().await;
    // Serveur qui accepte la connexion et ne répond jamais.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            held.push(sock);
        }
    });
    let cfg = remote_cfg(&base);
    let signal = AbortSignal::new();
    let s2 = signal.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        s2.abort();
    });
    let o = TranslateContext {
        signal: Some(signal),
        ..ctx()
    };
    let e = ai::chat_completion("s", "u", &cfg, &o, 0.2, true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        format!("serveur de traduction injoignable ({base}/v1) : interrompu")
    );
    // Délai dépassé.
    let o = TranslateContext {
        timeout: Some(Duration::from_millis(100)),
        ..ctx()
    };
    let e = ai::chat_completion("s", "u", &cfg, &o, 0.2, true)
        .await
        .unwrap_err();
    assert_eq!(
        e.message,
        format!("serveur de traduction injoignable ({base}/v1) : délai dépassé")
    );
}

// ---------------------------------------------------------------- Whisper embarqué (faux processus)

/// Moteur « NVIDIA » : même protocole, autre processus (`PARAKEET_PYTHON`,
/// `PARAKEET_WORKER`), sans largeur de faisceau ; `WHISPER_BEAM_SIZE` borné.
#[tokio::test]
async fn parakeet_embarque_protocole() {
    let Some(py) = python() else { return };
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    // Whisper introuvable : seul le processus Parakeet peut répondre.
    set("WHISPER_PYTHON", "/introuvable/python");
    set("PARAKEET_PYTHON", &py);
    set("PARAKEET_WORKER", helper("fake_whisper_worker.py"));
    set("MODELS_DIR", dir.path().join("models"));
    let log = dir.path().join("req.log");
    set("FAKE_LOG", &log);
    let model = basketland_server::media::local_ai::PARAKEET_MODEL;
    let s = WhisperSession::open(model, None).await.unwrap();
    let a = s
        .transcribe("/tmp/chunk-000.ogg", None, None, None)
        .await
        .unwrap();
    assert_eq!(a.segments.len(), 1);
    let env: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{}.env", log.display())).unwrap())
            .unwrap();
    let argv: Vec<&str> = env["argv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(argv[..2], ["--model", "nemo-parakeet-tdt-0.6b-v2"]);
    assert!(!argv.contains(&"--beam-size"), "{argv:?}");
    s.close().await;
    // Processus absent : message au nom du moteur.
    set("PARAKEET_PYTHON", "/introuvable/python");
    let e = WhisperSession::open(model, None).await.err().unwrap();
    assert!(e.starts_with("Parakeet ne démarre pas"), "{e}");
    use basketland_server::media::local_ai::whisper_beam_size;
    for (v, want) in [
        (None, 1),
        (Some("5"), 5),
        (Some("0"), 1),
        (Some("x"), 1),
        (Some("11"), 1),
    ] {
        match v {
            Some(v) => set("WHISPER_BEAM_SIZE", v),
            None => std::env::remove_var("WHISPER_BEAM_SIZE"),
        }
        assert_eq!(whisper_beam_size(), want, "{v:?}");
    }
}

#[tokio::test]
async fn whisper_embarque_protocole() {
    let Some(py) = python() else { return };
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    set("WHISPER_PYTHON", &py);
    set("WHISPER_WORKER", helper("fake_whisper_worker.py"));
    set("MODELS_DIR", dir.path().join("models"));
    let log = dir.path().join("req.log");
    set("FAKE_LOG", &log);
    let s = WhisperSession::open("distil-large-v3", None).await.unwrap();
    let a = s
        .transcribe("/tmp/chunk-000.ogg", Some("NBA"), None, None)
        .await
        .unwrap();
    let b = s
        .transcribe(
            "/tmp/chunk-001.ogg",
            None,
            None,
            Some("Zach Edey, Ja Morant"),
        )
        .await
        .unwrap();
    assert_eq!(a.segments.len(), 1);
    assert_eq!(
        a.words.iter().map(|w| w.word.trim()).collect::<Vec<_>>(),
        ["Curry", "pulls", "up.", "Bang!"]
    );
    assert_eq!(b.segments[0].text.trim(), "Curry pulls up. Bang!");
    // Protocole exact : une ligne JSON par requête, champs dans l'ordre de Node.
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "{\"id\":1,\"file\":\"/tmp/chunk-000.ogg\",\"language\":\"en\",\"prompt\":\"NBA\"}\n{\"id\":2,\"file\":\"/tmp/chunk-001.ogg\",\"language\":\"en\",\"hotwords\":\"Zach Edey, Ja Morant\"}\n"
    );
    let env: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{}.env", log.display())).unwrap())
            .unwrap();
    assert_eq!(
        env["HF_HOME"],
        json!(dir.path().join("models/hf").to_string_lossy())
    );
    assert_eq!(env["PYTHONUNBUFFERED"], "1");
    assert_eq!(
        env["argv"].as_array().unwrap()[..],
        json!([
            "--model",
            "distil-large-v3",
            "--device",
            "auto",
            "--compute-type",
            "auto",
            "--download-root",
            dir.path().join("models/whisper").to_string_lossy(),
            // Décodage glouton par défaut (`WHISPER_BEAM_SIZE`).
            "--beam-size",
            "1"
        ])
        .as_array()
        .unwrap()[..]
    );
    // Erreur de transcription remontée, la session reste utilisable.
    assert_eq!(
        s.transcribe("/tmp/erreur.ogg", None, None, None)
            .await
            .unwrap_err(),
        "Whisper : fichier illisible"
    );
    assert_eq!(
        s.transcribe("/tmp/ok.ogg", None, None, None)
            .await
            .unwrap()
            .segments
            .len(),
        1
    );
    let pid = s.pid().unwrap();
    s.close().await;
    wait_dead(pid).await;
    assert_eq!(
        s.transcribe("/tmp/x.ogg", None, None, None)
            .await
            .unwrap_err(),
        "session Whisper fermée"
    );
}

#[tokio::test]
async fn whisper_chargement_et_interruption() {
    let Some(py) = python() else { return };
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    set("WHISPER_PYTHON", &py);
    set("WHISPER_WORKER", helper("fake_whisper_worker.py"));
    set("MODELS_DIR", dir.path().join("models"));
    assert_eq!(
        WhisperSession::open("casse", None).await.err().unwrap(),
        "modèle introuvable"
    );
    assert_eq!(
        WhisperSession::open("meurt", None).await.err().unwrap(),
        "Whisper s'est arrêté (code 3) : trace 1 | trace 2"
    );
    set("WHISPER_PYTHON", "/nexiste/pas/python");
    assert_eq!(
        WhisperSession::open("x", None).await.err().unwrap(),
        "Whisper ne démarre pas : spawn /nexiste/pas/python ENOENT"
    );
    // Interruption : requête rejetée, processus arrêté.
    set("WHISPER_PYTHON", &py);
    let s = WhisperSession::open("x", None).await.unwrap();
    let pid = s.pid().unwrap();
    let sig = AbortSignal::new();
    let s2 = sig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        s2.abort();
    });
    assert_eq!(
        s.transcribe("/tmp/lent.ogg", None, Some(&sig), None)
            .await
            .unwrap_err(),
        "transcription interrompue"
    );
    wait_dead(pid).await;
}

#[test]
fn bibliotheques_cuda_dans_le_seul_whisper() {
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(venv.join("lib/python3.12/site-packages/nvidia/cudnn/lib")).unwrap();
    std::fs::create_dir_all(venv.join("lib/python3.11/site-packages/nvidia/cublas/lib")).unwrap();
    std::fs::create_dir_all(venv.join("lib/autre")).unwrap();
    let lib = basketland_server::media::local_ai::whisper_library_path(
        &venv.join("bin/python").to_string_lossy(),
    );
    assert_eq!(
        lib,
        format!("{0}/lib/python3.11/site-packages/nvidia/cublas/lib:{0}/lib/python3.12/site-packages/nvidia/cudnn/lib", venv.display())
    );
}

// ---------------------------------------------------------------- Ollama embarqué (faux binaire)

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn ollama_embarque_cycle_de_vie() {
    if python().is_none() {
        return;
    }
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    set("OLLAMA_BIN", helper("fake_ollama.py"));
    set("OLLAMA_PORT", free_port().to_string());
    set("MODELS_DIR", dir.path().join("models"));
    set("TRANSLATE_PARALLEL", "3.7");
    let s = OllamaSession::open(Some(Duration::from_secs(20)))
        .await
        .unwrap();
    let v: Value = reqwest::get(format!("{}/api/version", s.base))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // HOME dans le volume des modèles (clé ~/.ollama accessible), modèles, parallélisme, contexte.
    let home = dir.path().join("models/ollama-home");
    assert_eq!(v["home"], json!(home.to_string_lossy()));
    assert!(home.exists());
    assert_eq!(
        (
            v["parallel"].as_str(),
            v["context"].as_str(),
            v["keep"].as_str()
        ),
        (Some("3"), Some("4096"), Some("10m"))
    );
    assert_eq!(
        v["models"],
        json!(dir.path().join("models/ollama").to_string_lossy())
    );
    // Téléchargement refusé : erreur Ollama explicite.
    assert_eq!(
        s.ensure_model("inconnu", None, None).await.unwrap_err(),
        "Ollama : pull model manifest: file does not exist"
    );
    let steps: Arc<Mutex<Vec<(f64, f64)>>> = Arc::default();
    let s2 = steps.clone();
    let progress = move |d: f64, t: f64| s2.lock().unwrap().push((d, t));
    s.ensure_model(
        "hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0",
        Some(&progress),
        None,
    )
    .await
    .unwrap();
    assert_eq!(*steps.lock().unwrap(), vec![(2.0, 4.0), (4.0, 4.0)]);
    s.ensure_model("hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0", None, None)
        .await
        .unwrap();
    s.warm("x", None).await;
    let base = s.base.clone();
    s.close().await;
    let r = reqwest::Client::new()
        .get(format!("{base}/api/version"))
        .timeout(Duration::from_secs(1))
        .send()
        .await;
    assert!(r.is_err());
}

// ---------------------------------------------------------------- voix (faux moteur)

fn add_voice(dir: &Path, id: &str, meta: Option<&str>, files: &[&str]) {
    let d = dir.join(id);
    std::fs::create_dir_all(&d).unwrap();
    for f in files {
        std::fs::write(
            d.join(f),
            if f.ends_with(".txt") {
                "Bonsoir à tous."
            } else {
                "RIFF"
            },
        )
        .unwrap();
    }
    if let Some(m) = meta {
        std::fs::write(d.join("voice.json"), m).unwrap();
    }
}

const REF: [&str; 2] = ["reference.wav", "reference.txt"];

#[tokio::test]
async fn liste_des_voix_et_configuration() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("voices");
    add_voice(
        &dir,
        "F",
        Some(r#"{"id":"F","role":"voix_feminine","label_fr":"Voix féminine","gender":"f"}"#),
        &REF,
    );
    add_voice(
        &dir,
        "B1",
        Some(r#"{"id":"B1","role":"troisieme_voix","label_fr":"Troisième voix","gender":"m"}"#),
        &REF,
    );
    add_voice(
        &dir,
        "A",
        Some(
            r#"{"id":"A","role":"commentateur","label_fr":"Commentateur","gender":"m","creation":{"model":"x"}}"#,
        ),
        &REF,
    );
    add_voice(&dir, "B4", Some("{ cassé"), &REF);
    add_voice(&dir, "Z", None, &REF);
    add_voice(
        &dir,
        "Y",
        Some(r#"{"label_fr":"Sans transcription"}"#),
        &["reference.wav"],
    );
    std::fs::write(dir.join("LISEZMOI.txt"), "pas une voix").unwrap();
    let got: Vec<(String, String, String, String)> = voice_ai::list_voices(Some(&dir))
        .into_iter()
        .map(|v| (v.id, v.role, v.label, v.gender))
        .collect();
    let t = |a: &str, b: &str, c: &str, d: &str| {
        (a.to_string(), b.to_string(), c.to_string(), d.to_string())
    };
    assert_eq!(
        got,
        vec![
            t("A", "commentateur", "Commentateur", "m"),
            t("B4", "consultant", "Consultant", "m"),
            t("B1", "troisieme_voix", "Troisième voix", "m"),
            t("F", "voix_feminine", "Voix féminine", "f"),
            t("Z", "", "Z", "m")
        ]
    );
    assert!(voice_ai::list_voices(Some(&tmp.path().join("nexiste"))).is_empty());
    // Voix livrées dans assets/voices.
    let shipped = PathBuf::from(format!("{}/../assets/voices", env!("CARGO_MANIFEST_DIR")));
    assert_eq!(
        voice_ai::list_voices(Some(&shipped))
            .iter()
            .map(|v| v.id.as_str())
            .collect::<Vec<_>>(),
        ["A", "B4", "B1", "F"]
    );

    set("VOICES_DIR", &shipped);
    set("MODELS_DIR", tmp.path().join("models"));
    set("TTS_WORKER", helper("fake_voice_worker.py"));
    let s = Settings::default();
    let c = voice_ai::voice_config(&s);
    assert_eq!(
        (
            c.model.as_str(),
            c.device.as_str(),
            c.disabled_reason.as_deref()
        ),
        (voice_ai::DEFAULT_TTS_MODEL, "auto", None)
    );
    set("DUB_DISABLED", "1");
    assert_eq!(
        voice_ai::voice_config(&s).disabled_reason.as_deref(),
        Some("doublage désactivé (DUB_DISABLED=1)")
    );
    std::env::remove_var("DUB_DISABLED");
    set("VOICES_DIR", tmp.path().join("vide"));
    assert!(voice_ai::voice_config(&s)
        .disabled_reason
        .unwrap()
        .starts_with("aucune voix dans"));
    // MiniMax dès qu'une clé est donnée ; TTS_ENGINE l'emporte.
    assert_eq!(
        voice_ai::voice_engine_name(&s),
        voice_ai::VoiceEngineName::Local
    );
    assert!(voice_ai::voice_uses_gpu(&s));
    set("MINIMAX_API_KEY", "cle");
    let c = voice_ai::voice_config(&s);
    assert_eq!(
        (c.engine, c.device.as_str(), c.disabled_reason),
        (voice_ai::VoiceEngineName::Minimax, "cpu", None)
    );
    assert!(!voice_ai::voice_uses_gpu(&s));
    set("TTS_ENGINE", "minimax");
    std::env::remove_var("MINIMAX_API_KEY");
    assert_eq!(
        voice_ai::voice_config(&s).disabled_reason.as_deref(),
        Some("clé MiniMax absente (MINIMAX_API_KEY)")
    );
    assert_eq!(
        voice_ai::voice_engine_name(&Settings::from_pairs([(keys::MINIMAX_API_KEY, "cle-page")])),
        voice_ai::VoiceEngineName::Minimax
    );
}

async fn voice_env(tmp: &Path) -> Option<PathBuf> {
    let py = python()?;
    let voices = tmp.join("voices");
    for id in ["B1", "A", "B4"] {
        add_voice(&voices, id, Some(&format!(r#"{{"id":"{id}"}}"#)), &REF);
    }
    set("TTS_PYTHON", py);
    set("TTS_WORKER", helper("fake_voice_worker.py"));
    set("VOICES_DIR", &voices);
    set("MODELS_DIR", tmp.join("models"));
    Some(voices)
}

#[tokio::test]
async fn voix_synthese_empreintes_et_protocole() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    let Some(_) = voice_env(tmp.path()).await else {
        return;
    };
    let log = tmp.path().join("req.log");
    set("FAKE_LOG", &log);
    let s = Settings::default();
    let v = VoiceSession::open(&s, None, false).await.unwrap();
    assert_eq!(v.voices(), ["A", "B4", "B1"]);
    assert_eq!(v.device(), "cpu");
    let env: Value =
        serde_json::from_str(&std::fs::read_to_string(tmp.path().join("worker.env")).unwrap())
            .unwrap();
    assert_eq!(
        env["HF_HOME"],
        json!(tmp.path().join("models/hf").to_string_lossy())
    );
    assert_eq!(env["OMP_NUM_THREADS"], Value::Null);
    let out = tmp.path().join("out/l1.wav");
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    assert_eq!(
        v.synth(
            "Quel contre de Wembanyama !",
            "B4",
            &out.to_string_lossy(),
            None
        )
        .await
        .unwrap(),
        (1.8, 24000)
    );
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        "RIFF B4 French Quel contre de Wembanyama !"
    );
    let e = v
        .embed(
            &out.to_string_lossy(),
            &[(0.0, 2.5), (3.0, 3.2), (4.0, 4.3), (5.0, 10.0)],
            None,
        )
        .await
        .unwrap();
    assert_eq!(e.embeddings.len(), 4);
    assert_eq!(e.embeddings[0].as_ref().unwrap().len(), 192);
    assert_eq!(e.embeddings[1], None);
    assert_eq!(e.f0, vec![Some(118.5), None, Some(118.5), Some(118.5)]);
    assert_eq!(e.female, Some(vec![Some(0.03), None, None, Some(0.97)]));
    // Protocole exact (chemins absolus, champs dans l'ordre de Node).
    let lines: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(lines[0], format!("{{\"id\":1,\"op\":\"synth\",\"text\":\"Quel contre de Wembanyama !\",\"voice\":\"B4\",\"out\":\"{}\",\"language\":\"French\"}}", out.display()));
    assert_eq!(lines[1], format!("{{\"id\":2,\"op\":\"embed\",\"file\":\"{}\",\"segments\":[[0,2.5],[3,3.2],[4,4.3],[5,10]]}}", out.display()));
    // Erreurs du moteur remontées, la session reste utilisable.
    let x = tmp.path().join("x.wav").to_string_lossy().into_owned();
    assert_eq!(
        v.synth("une erreur", "A", &x, None).await.unwrap_err(),
        "voix : synthèse ratée après 2 essais : plafond de 60 trames atteint"
    );
    assert_eq!(
        v.synth("Bonsoir", "Q", &x, None).await.unwrap_err(),
        "voix : voix inconnue : Q"
    );
    assert!(v
        .embed("/nexiste/absent.ogg", &[(0.0, 1.0)], None)
        .await
        .unwrap_err()
        .starts_with("voix : fichier audio introuvable"));
    assert_eq!(v.synth("Bonsoir", "A", &x, None).await.unwrap().1, 24000);
    let pid = v.pid().unwrap();
    v.close().await;
    wait_dead(pid).await;
    assert_eq!(
        v.synth("Encore", "A", &x, None).await.unwrap_err(),
        "session de voix fermée"
    );

    // Ancien moteur sans détection du genre.
    set("TTS_MODEL", "ancien");
    let v = VoiceSession::open(&s, None, false).await.unwrap();
    std::fs::write(&x, "RIFF").unwrap();
    assert_eq!(v.embed(&x, &[(0.0, 6.0)], None).await.unwrap().female, None);
    v.close().await;
}

#[tokio::test]
async fn voix_chargement_delais_et_interruptions() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    let Some(_) = voice_env(tmp.path()).await else {
        return;
    };
    let s = Settings::default();
    // Interruption : requête rejetée, moteur arrêté.
    let v = VoiceSession::open(&s, None, false).await.unwrap();
    let pid: u32 = std::fs::read_to_string(tmp.path().join("worker.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(pid_alive(pid));
    let sig = AbortSignal::new();
    let s2 = sig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        s2.abort();
    });
    let out = tmp.path().join("lent.wav").to_string_lossy().into_owned();
    assert_eq!(
        v.synth("lent", "A", &out, Some(&sig)).await.unwrap_err(),
        "synthèse vocale interrompue"
    );
    wait_dead(pid).await;
    assert_eq!(
        v.synth("Bonsoir", "A", &out, None).await.unwrap_err(),
        "session de voix fermée"
    );
    let done = AbortSignal::new();
    done.abort();
    assert_eq!(
        VoiceSession::open(&s, Some(&done), false)
            .await
            .err()
            .unwrap(),
        "chargement des voix interrompu"
    );

    set("TTS_MODEL", "casse");
    assert_eq!(
        VoiceSession::open(&s, None, false).await.err().unwrap(),
        "voix : modèle introuvable"
    );
    set("TTS_MODEL", "muet");
    set("TTS_LOAD_TIMEOUT_MS", "300");
    assert_eq!(
        VoiceSession::open(&s, None, false).await.err().unwrap(),
        "voix : modèle muet pas prêt (aucune nouvelle depuis 0 min)"
    );
    let pid: u32 = std::fs::read_to_string(tmp.path().join("worker.pid"))
        .unwrap()
        .parse()
        .unwrap();
    wait_dead(pid).await;
    set("TTS_LOAD_TIMEOUT_MS", "60000");
    let sig = AbortSignal::new();
    let s2 = sig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        s2.abort();
    });
    assert_eq!(
        VoiceSession::open(&s, Some(&sig), false)
            .await
            .err()
            .unwrap(),
        "chargement des voix interrompu"
    );
    // 600 ms de « téléchargement », une ligne toutes les 100 ms : jamais 300 ms de silence.
    set("TTS_MODEL", "lent-mais-vivant");
    set("TTS_LOAD_TIMEOUT_MS", "300");
    let v = VoiceSession::open(&s, None, false).await.unwrap();
    assert_eq!(v.voices(), ["A", "B4", "B1"]);
    v.close().await;
    // Python introuvable.
    set("TTS_PYTHON", tmp.path().join("nexiste/python"));
    let e = VoiceSession::open(&s, None, false).await.err().unwrap();
    assert!(
        e.starts_with("moteur de voix : démarrage impossible (spawn "),
        "{e}"
    );
    set("DUB_DISABLED", "1");
    assert_eq!(
        VoiceSession::open(&s, None, false).await.err().unwrap(),
        "doublage désactivé (DUB_DISABLED=1)"
    );
}

#[tokio::test]
async fn telechargement_des_modeles_partage() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    let Some(_) = voice_env(tmp.path()).await else {
        return;
    };
    voice_ai::reset_voice_models_for_tests();
    let s = Settings::default();
    let a = tokio::spawn(async { prepare_voice_models(&Settings::default()).await });
    let b = tokio::spawn(async { prepare_voice_models(&Settings::default()).await });
    let hf = tmp.path().join("models/hf");
    for _ in 0..200 {
        if voice_models_download() == Some((1e9, 2.5e9)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(voice_models_download(), Some((1e9, 2.5e9)));
    std::fs::write(hf.join("go"), "").unwrap();
    let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
    assert_eq!((ra, rb), (Ok(()), Ok(())));
    assert_eq!(voice_models_download(), None);
    // Déjà en cache pour ce processus : rien à faire.
    std::fs::remove_file(hf.join("go")).unwrap();
    assert_eq!(prepare_voice_models(&s).await, Ok(()));

    // Échec : rejet avec la raison du moteur, l'appel suivant réessaie.
    voice_ai::reset_voice_models_for_tests();
    set("TTS_MODEL", "casse");
    assert_eq!(
        prepare_voice_models(&s).await,
        Err("téléchargement des modèles de voix impossible : réseau coupé".into())
    );
    assert_eq!(voice_models_download(), None);
    std::env::remove_var("TTS_MODEL");
    let p = tokio::spawn(async { prepare_voice_models(&Settings::default()).await });
    for _ in 0..200 {
        if voice_models_download().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    std::fs::write(hf.join("go"), "").unwrap();
    assert_eq!(p.await.unwrap(), Ok(()));
    voice_ai::reset_voice_models_for_tests();
}

// ---------------------------------------------------------------- MiniMax (API simulée)

fn wav_hex(sec: f64) -> String {
    let w = to_wav(vec![0u8; (sec * 24_000.0).round() as usize * 2], 24_000).wav;
    w.iter().map(|b| format!("{b:02x}")).collect()
}

fn catalog() -> String {
    let voices: Vec<Value> = [
        "French_Male_Speech_New",
        "French_MaleNarrator",
        "French_CasualMan",
        "French_FemaleAnchor",
    ]
    .iter()
    .map(|v| json!({ "voice_id": v }))
    .collect();
    json!({ "base_resp": { "status_code": 0, "status_msg": "success" }, "system_voice": voices })
        .to_string()
}

fn speech(sec: f64) -> String {
    json!({ "base_resp": { "status_code": 0 }, "data": { "audio": wav_hex(sec), "status": 2 }, "extra_info": { "audio_length": sec * 1000.0, "audio_sample_rate": 24000 } }).to_string()
}

async fn no_embedder(_: Option<AbortSignal>) -> Result<VoiceSession, String> {
    Err("pas de Python en test".into())
}

#[tokio::test]
async fn minimax_ouverture_synthese_et_erreurs() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    set("MINIMAX_API_KEY", "cle-secrete");
    set("MINIMAX_RETRY_MS", "0,0,0");
    let s = Settings::default();
    let (base, log) = serve(Arc::new(|p, _| {
        (
            200,
            if p == "/v1/get_voice" {
                catalog()
            } else {
                speech(1.5)
            },
        )
    }))
    .await;
    set("MINIMAX_API_URL", &base);
    let v = MinimaxVoiceSession::open(&s, None, no_embedder)
        .await
        .unwrap();
    assert_eq!(v.voices(), ["A", "B4", "B1", "F"]);
    let out = tmp.path().join("l1.wav").to_string_lossy().into_owned();
    assert_eq!(
        v.synth("  Quel contre   de Wembanyama !", "B4", &out, None, None)
            .await
            .unwrap(),
        (1.5, 24000)
    );
    assert_eq!(&std::fs::read(&out).unwrap()[..4], b"RIFF");
    let reqs = log.lock().unwrap().clone();
    assert_eq!(
        reqs.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        ["/v1/get_voice", "/v1/t2a_v2"]
    );
    assert_eq!(reqs[1].headers["authorization"], "Bearer cle-secrete");
    assert_eq!(
        v.synth("x", "Z", &out, None, None).await.unwrap_err(),
        "voix inconnue : Z"
    );
    assert_eq!(
        v.embed(&out, &[(0.0, 1.0)], None).await.unwrap_err(),
        "analyse des voix indisponible"
    );
    // Moments forts : ton imposé ; MINIMAX_EMOTIONS=0 désactive.
    log.lock().unwrap().clear();
    v.synth("Quel dunk !", "A", &out, None, Some(2.0))
        .await
        .unwrap();
    v.synth("Belle passe.", "A", &out, None, Some(1.0))
        .await
        .unwrap();
    v.synth("Remise en jeu.", "A", &out, None, None)
        .await
        .unwrap();
    set("MINIMAX_EMOTIONS", "0");
    v.synth("Quel dunk !", "A", &out, None, Some(2.0))
        .await
        .unwrap();
    std::env::remove_var("MINIMAX_EMOTIONS");
    let emotions: Vec<Value> = log
        .lock()
        .unwrap()
        .iter()
        .map(|r| {
            serde_json::from_str::<Value>(&r.body).unwrap()["voice_setting"]["emotion"].clone()
        })
        .collect();
    assert_eq!(
        emotions,
        vec![json!("surprised"), json!("happy"), Value::Null, Value::Null]
    );
    v.close().await;
    assert_eq!(
        v.synth("Bonsoir.", "A", &out, None, None)
            .await
            .unwrap_err(),
        "session de voix fermée"
    );

    // PCM brut : en-tête WAV ajouté ; débit dépassé (1002) puis succès : retenté.
    let calls = Arc::new(Mutex::new(0));
    let c2 = calls.clone();
    let (base, _) = serve(Arc::new(move |p, _| {
        if p == "/v1/get_voice" {
            return (200, catalog());
        }
        *c2.lock().unwrap() += 1;
        if *c2.lock().unwrap() == 1 {
            return (200, json!({ "base_resp": { "status_code": 1002, "status_msg": "rate limit" } }).to_string());
        }
        (200, json!({ "base_resp": { "status_code": 0 }, "data": { "audio": "00".repeat(48_000) }, "extra_info": { "audio_sample_rate": 24000 } }).to_string())
    }))
    .await;
    set("MINIMAX_API_URL", &base);
    let v = MinimaxVoiceSession::open(&s, None, no_embedder)
        .await
        .unwrap();
    let pcm = tmp.path().join("pcm.wav").to_string_lossy().into_owned();
    assert_eq!(
        v.synth("Bonsoir.", "A", &pcm, None, None).await.unwrap(),
        (1.0, 24000)
    );
    assert_eq!(*calls.lock().unwrap(), 2);
    assert_eq!(std::fs::read(&pcm).unwrap().len(), 48_044);

    // Clé refusée : l'ouverture échoue ; catalogue illisible : on continue ; crédit épuisé à la synthèse.
    let (base, _) = serve(Arc::new(|_, _| {
        (
            200,
            json!({ "base_resp": { "status_code": 1004, "status_msg": "login fail" } }).to_string(),
        )
    }))
    .await;
    set("MINIMAX_API_URL", &base);
    assert_eq!(
        MinimaxVoiceSession::open(&s, None, no_embedder)
            .await
            .err()
            .unwrap(),
        "MiniMax : clé refusée (code 1004 : login fail)"
    );
    let (base, _) = serve(Arc::new(|_, _| (401, "{}".into()))).await;
    set("MINIMAX_API_URL", &base);
    assert_eq!(
        MinimaxVoiceSession::open(&s, None, no_embedder)
            .await
            .err()
            .unwrap(),
        "MiniMax : clé refusée (HTTP 401)"
    );
    let (base, _) = serve(Arc::new(|p, _| if p == "/v1/get_voice" { (404, "{}".into()) } else { (200, json!({ "base_resp": { "status_code": 1008, "status_msg": "insufficient balance" } }).to_string()) })).await;
    set("MINIMAX_API_URL", &base);
    let v = MinimaxVoiceSession::open(&s, None, no_embedder)
        .await
        .unwrap();
    assert_eq!(v.voices().len(), 4);
    assert_eq!(
        v.synth("Bonsoir.", "A", &pcm, None, None)
            .await
            .unwrap_err(),
        "MiniMax : crédit épuisé (code 1008 : insufficient balance)"
    );
    // Sans clé.
    std::env::remove_var("MINIMAX_API_KEY");
    assert_eq!(
        MinimaxVoiceSession::open(&s, None, no_embedder)
            .await
            .err()
            .unwrap(),
        "clé MiniMax absente (MINIMAX_API_KEY)"
    );
}

#[tokio::test]
async fn minimax_de_bout_en_bout_avec_analyse_locale() {
    let _g = clean_env().await;
    let tmp = tempfile::tempdir().unwrap();
    let Some(_) = voice_env(tmp.path()).await else {
        return;
    };
    set("MINIMAX_API_KEY", "cle-secrete");
    set("MINIMAX_RETRY_MS", "0");
    let (base, _) = serve(Arc::new(|p, _| {
        (
            200,
            if p == "/v1/get_voice" {
                catalog()
            } else {
                speech(2.0)
            },
        )
    }))
    .await;
    set("MINIMAX_API_URL", &base);
    let s = Settings::default();
    let v = open_voice_session(&s, None).await.unwrap();
    assert!(matches!(v, voice_ai::VoiceEngine::Minimax(_)));
    assert_eq!(v.voices(), ["A", "B4", "B1", "F"]);
    let env: Value =
        serde_json::from_str(&std::fs::read_to_string(tmp.path().join("worker.env")).unwrap())
            .unwrap();
    assert!(env["argv"]
        .as_array()
        .unwrap()
        .contains(&json!("--embed-only")));
    assert_eq!(
        (
            env["OMP_NUM_THREADS"].as_str(),
            env["MKL_NUM_THREADS"].as_str()
        ),
        (Some("2"), Some("2"))
    );
    let audio = tmp.path().join("src.ogg");
    std::fs::write(&audio, "x").unwrap();
    let e = v
        .embed(&audio.to_string_lossy(), &[(0.0, 2.0)], None)
        .await
        .unwrap();
    assert_eq!(e.embeddings[0].as_ref().unwrap().len(), 192);
    assert_eq!(
        v.synth(
            "Bonsoir.",
            "F",
            &tmp.path().join("f.wav").to_string_lossy(),
            None,
            None
        )
        .await
        .unwrap(),
        (2.0, 24000)
    );
    v.close().await;
}

// ---------------------------------------------------------------- extraction audio (vrai ffmpeg)

fn has_opus() -> bool {
    let ok = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("libopus")
        })
        && Command::new("ffprobe")
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success());
    if !ok {
        eprintln!("ffmpeg (libopus) ou ffprobe absent : extraction audio non testée");
    }
    ok
}

fn probe(file: &Path) -> (f64, u64, u64, String) {
    let o = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=duration",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .unwrap();
    let j: Value = serde_json::from_slice(&o.stdout).unwrap();
    (
        j["format"]["duration"].as_str().unwrap().parse().unwrap(),
        j["streams"][0]["sample_rate"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        j["streams"][0]["channels"].as_u64().unwrap(),
        j["streams"][0]["codec_name"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn extraction_audio_ffmpeg_reel() {
    if !has_opus() {
        return;
    }
    let _g = clean_env().await;
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("source.mp4");
    let st = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=30:sample_rate=44100",
            "-ac",
            "2",
            "-c:a",
            "aac",
            "-y",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let src_s = src.to_string_lossy().into_owned();
    let o = ExtractOptions::default();

    // [10 s, 18 s] en Opus mono 16 kHz.
    let out = dir.path().join("chunk-000.ogg");
    extract_audio_chunk(&src_s, 10.0, 8.0, &out.to_string_lossy(), &o)
        .await
        .unwrap();
    assert!(!dir.path().join("chunk-000.ogg.part").exists());
    let (d, rate, ch, codec) = probe(&out);
    assert_eq!((codec.as_str(), ch), ("opus", 1));
    assert!([16000, 48000].contains(&rate));
    assert!((d - 8.0).abs() < 0.5, "{d}");

    // Dernier tronçon demandé au-delà de la fin : s'arrête à la fin du flux.
    let out1 = dir.path().join("chunk-001.ogg");
    extract_audio_chunk(&src_s, 25.0, 60.0, &out1.to_string_lossy(), &o)
        .await
        .unwrap();
    assert!((probe(&out1).0 - 5.0).abs() < 0.5);

    // Source illisible : erreur, aucun fichier laissé.
    let out2 = dir.path().join("chunk-002.ogg");
    let e = extract_audio_chunk(
        &dir.path().join("absent.mp4").to_string_lossy(),
        0.0,
        10.0,
        &out2.to_string_lossy(),
        &o,
    )
    .await
    .unwrap_err();
    assert!(
        e.starts_with("ffmpeg audio @0s code ")
            && e.contains(", aucun son lu: ")
            && e.contains("absent.mp4"),
        "{e}"
    );
    assert!(!out2.exists() && !dir.path().join("chunk-002.ogg.part").exists());

    // Découpe du son local, puis son complet avec progression.
    let cut = dir.path().join("cut.ogg");
    cut_audio(
        &out.to_string_lossy(),
        2.0,
        3.5,
        &cut.to_string_lossy(),
        None,
    )
    .await
    .unwrap();
    assert!((probe(&cut).0 - 3.5).abs() < 0.5);
    let full = dir.path().join("full.ogg");
    let seen = Arc::new(Mutex::new(0.0f64));
    let s2 = seen.clone();
    let progress = move |s: f64| {
        let mut m = s2.lock().unwrap();
        *m = m.max(s);
    };
    extract_full_audio(&src_s, &full.to_string_lossy(), &o, Some(&progress), None)
        .await
        .unwrap();
    assert!((probe(&full).0 - 30.0).abs() < 0.5);
    assert!(
        *seen.lock().unwrap() > 25.0,
        "progression {}",
        seen.lock().unwrap()
    );
    let e = extract_full_audio(
        &dir.path().join("absent.mp4").to_string_lossy(),
        &dir.path().join("f2.ogg").to_string_lossy(),
        &o,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(
        e.starts_with("ffmpeg son complet code ") && e.contains(", aucun son lu: "),
        "{e}"
    );

    // Interruption : ffmpeg arrêté, rien de laissé.
    let sig = AbortSignal::new();
    sig.abort();
    let o2 = ExtractOptions {
        signal: Some(sig),
        ..Default::default()
    };
    let out3 = dir.path().join("chunk-003.ogg");
    assert!(
        extract_audio_chunk(&src_s, 0.0, 20.0, &out3.to_string_lossy(), &o2)
            .await
            .is_err()
    );
    assert!(!out3.exists() && !dir.path().join("chunk-003.ogg.part").exists());

    // Enveloppe d'un vrai fichier : 50 ms par trame ; décodage impossible : None.
    let env = audio_envelope(&out.to_string_lossy(), None, None)
        .await
        .unwrap();
    assert!(
        (env.power.len() as f64 - 8.0 / 0.05).abs() <= 2.0,
        "{}",
        env.power.len()
    );
    assert!(env.power.iter().all(|p| *p > 0.0));
    assert_eq!(
        audio_envelope("/nonexistent/chunk.ogg", None, None).await,
        None
    );
    // ffmpeg introuvable : erreur de lancement comme Node.
    set("FFMPEG_PATH", "/nexiste/ffmpeg");
    let e = extract_audio_chunk(&src_s, 0.0, 1.0, &out.to_string_lossy(), &o)
        .await
        .unwrap_err();
    std::env::remove_var("FFMPEG_PATH");
    assert_eq!(e, "spawn /nexiste/ffmpeg ENOENT");
}

/// Régression : les tronçons sont découpés PENDANT l'extraction du son
/// complet, dès que la progression les couvre. ffmpeg n'écrivait le fichier
/// que par blocs de 512 Ko : la découpe sortait tronquée (105 s au lieu de
/// 120 s), sans erreur — trous de sous-titres en fin de tronçon.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decoupe_pendant_l_extraction_du_son_complet() {
    if !has_opus() {
        return;
    }
    let _g = clean_env().await;
    set("COMMENTARY_AUDIO_READRATE", "20");
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("match.wav");
    let st = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=d=420:c=pink:r=16000:a=0.3",
            "-ac",
            "1",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let full = dir
        .path()
        .join("full.ogg.part")
        .to_string_lossy()
        .into_owned();
    let done = Arc::new(Mutex::new(0.0f64));
    let d2 = done.clone();
    let src_s = src.to_string_lossy().into_owned();
    let full2 = full.clone();
    let extraction = tokio::spawn(async move {
        let progress = move |s: f64| {
            let mut m = d2.lock().unwrap();
            *m = m.max(s);
        };
        extract_full_audio(
            &src_s,
            &full2,
            &ExtractOptions::default(),
            Some(&progress),
            None,
        )
        .await
    });
    for (start, length) in [(0.0, 120.0), (120.0, 120.0)] {
        while *done.lock().unwrap() < start + length + 2.0 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let cut = dir.path().join(format!("cut-{start}.ogg"));
        cut_audio(&full, start, length, &cut.to_string_lossy(), None)
            .await
            .unwrap();
        let d = probe(&cut).0;
        assert!(
            d > length - 1.0,
            "tronçon {start} : {d} s au lieu de {length} s"
        );
    }
    extraction.await.unwrap().unwrap();
}
