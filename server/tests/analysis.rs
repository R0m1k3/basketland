//! File d'analyse vidéo et route de calage (étape 7, non branchées) :
//! portage de `tests/analysis.test.ts` et `tests/sync-route.test.ts`
//! (exécuteur simulé comme dans les tests de Node ; ffmpeg « présent »), plus
//! la pause d'une analyse de fond pendant une lecture, la fenêtre de nuit et
//! une analyse complète avec de fausses dépendances (moteur OCR rejouant
//! tesseract.js sur les vraies images, audio, play-by-play).

#[path = "helpers/commentary_kit.rs"]
mod kit;

use axum::http::{HeaderMap, HeaderValue};
use basketland_server::analysis_db::{self as adb, AnchorInput};
use basketland_server::db::{self, Db};
use basketland_server::espn_events::parse_summary;
use basketland_server::ingest_db::{replace_plays, set_video, upsert_match, VideoUpdate};
use basketland_server::media::analysis::{
    auto_retry_allowed, Analysis, AnalysisDeps, AnalysisFailureKind, AnalysisJob, AnalysisOptions,
    AnalysisOutcome, AnalysisProgress, AnalysisRecord, AnalysisStatus, EnqueueOptions, Runner,
};
use basketland_server::media::commentary::{
    analysis_sources, backoff_ms, network_backoff_ms, pick_analysis_source, pick_audio_source,
    StreamInfo, MAX_AUTO_FAILURES,
};
use basketland_server::media::viewers::Viewers;
use basketland_server::okru::{Mp4Source, Variant};
use basketland_server::sync_route;
use kit::{fresh_db, TestClock, LOCK};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ------------------------------------------------------------------ sources et backoff

fn v(key: &str, resolution: &str, bandwidth: f64) -> Variant {
    Variant {
        key: key.into(),
        resolution: resolution.into(),
        bandwidth,
        url: format!("https://vd.okcdn.ru/{key}.m3u8"),
    }
}

fn mp4(names: &[&str]) -> Vec<Mp4Source> {
    names
        .iter()
        .map(|n| Mp4Source {
            name: n.to_string(),
            url: format!("https://vd.okcdn.ru/{n}.mp4"),
        })
        .collect()
}

fn stream(variants: Vec<Variant>, mp4: Vec<Mp4Source>) -> StreamInfo {
    StreamInfo {
        dash_url: None,
        variants,
        mp4,
        duration: None,
    }
}

#[test]
fn choix_de_la_source() {
    let s = pick_analysis_source(&stream(
        vec![
            v("sd", "852x480", 1e6),
            v("hd", "1280x720", 2.5e6),
            v("full", "1920x1080", 5e6),
        ],
        vec![],
    ))
    .unwrap();
    assert_eq!((s.label.as_str(), s.height), ("hd", Some(720.0)));
    let s = pick_analysis_source(&stream(
        vec![v("low", "640x360", 6e5), v("full", "1920x1080", 5e6)],
        vec![],
    ))
    .unwrap();
    assert_eq!(s.label, "full");
    let s =
        pick_analysis_source(&stream(vec![v("sd", "", 1e6), v("hd", "", 2e6)], vec![])).unwrap();
    assert_eq!((s.label.as_str(), s.height), ("hd", Some(720.0)));
    let s = pick_analysis_source(&stream(
        vec![],
        mp4(&["mobile", "lowest", "low", "sd", "hd", "full"]),
    ))
    .unwrap();
    assert_eq!(
        (s.label.as_str(), s.url.as_str()),
        ("hd", "https://vd.okcdn.ru/hd.mp4")
    );
    assert_eq!(
        pick_analysis_source(&stream(vec![], mp4(&["full"])))
            .unwrap()
            .label,
        "full"
    );
    assert_eq!(
        pick_analysis_source(&stream(vec![v("sd", "852x480", 1e6)], mp4(&["hd"])))
            .unwrap()
            .url,
        "https://vd.okcdn.ru/sd.m3u8"
    );
    assert!(pick_analysis_source(&stream(vec![], vec![])).is_none());
    let list = analysis_sources(&stream(
        vec![v("sd", "852x480", 1e6), v("hd", "1280x720", 2.5e6)],
        mp4(&["mobile", "hd", "full"]),
    ));
    let labels: Vec<String> = list
        .iter()
        .map(|s| format!("{:?}:{}", s.kind, s.label))
        .collect();
    assert_eq!(labels, ["Hls:hd", "Hls:sd", "Mp4:hd", "Mp4:full"]);
    let only_mp4: Vec<String> = analysis_sources(&stream(vec![], mp4(&["sd", "hd"])))
        .into_iter()
        .map(|s| s.label)
        .collect();
    assert_eq!(only_mp4, ["hd", "sd"]);
    assert_eq!(
        pick_audio_source(&stream(
            vec![v("hd", "1280x720", 2.5e6), v("low", "640x360", 6e5)],
            vec![]
        ))
        .unwrap()
        .label,
        "low"
    );
    assert_eq!(
        pick_audio_source(&stream(vec![], mp4(&["hd", "mobile", "sd"])))
            .unwrap()
            .label,
        "mobile"
    );
}

fn now_ms() -> f64 {
    basketland_server::media::viewers::now_ms()
}

fn rec(failures: f64, minutes_ago: f64, ok: bool) -> AnalysisRecord {
    AnalysisRecord {
        at: basketland_server::time::iso_utc(
            chrono::DateTime::from_timestamp_millis((now_ms() - minutes_ago * 60_000.0) as i64)
                .unwrap(),
        ),
        ok,
        failures: Some(failures),
        reason: String::new(),
        anchors: 0.0,
        ok_id: Some("A".into()),
        kind: None,
        net_failures: None,
    }
}

#[test]
fn backoff() {
    assert_eq!(backoff_ms(1), 3_600_000.0);
    assert_eq!(backoff_ms(2), 4.0 * 3_600_000.0);
    assert_eq!(backoff_ms(3), 16.0 * 3_600_000.0);
    assert_eq!(backoff_ms(4), 24.0 * 3_600_000.0);
    let now = now_ms();
    assert!(auto_retry_allowed(None, Some("A"), now));
    assert!(!auto_retry_allowed(
        Some(&rec(1.0, 30.0, false)),
        Some("A"),
        now
    ));
    assert!(auto_retry_allowed(
        Some(&rec(1.0, 61.0, false)),
        Some("A"),
        now
    ));
    assert!(!auto_retry_allowed(
        Some(&rec(2.0, 61.0, false)),
        Some("A"),
        now
    ));
    // Flux inaccessible (réseau) : backoff court, sans abandon.
    assert_eq!(network_backoff_ms(1), 15.0 * 60_000.0);
    assert_eq!(network_backoff_ms(2), 30.0 * 60_000.0);
    assert_eq!(network_backoff_ms(10), 6.0 * 3_600_000.0);
    let net = |n: f64, ago: f64| AnalysisRecord {
        kind: Some(AnalysisFailureKind::Reseau),
        net_failures: Some(n),
        ..rec(MAX_AUTO_FAILURES as f64, ago, false)
    };
    assert!(!auto_retry_allowed(Some(&net(1.0, 10.0)), Some("A"), now));
    assert!(auto_retry_allowed(Some(&net(1.0, 16.0)), Some("A"), now));
    assert!(auto_retry_allowed(Some(&net(3.0, 61.0)), Some("A"), now));
    // Abandon après MAX_AUTO_FAILURES échecs, sauf si la vidéo change ; jamais après un succès.
    assert!(!auto_retry_allowed(
        Some(&rec(MAX_AUTO_FAILURES as f64, 10.0 * 24.0 * 60.0, false)),
        Some("A"),
        now
    ));
    assert!(auto_retry_allowed(
        Some(&rec(MAX_AUTO_FAILURES as f64, 1.0, false)),
        Some("B"),
        now
    ));
    assert!(!auto_retry_allowed(
        Some(&rec(0.0, 10.0 * 24.0 * 60.0, true)),
        Some("A"),
        now
    ));
}

// ------------------------------------------------------------------ file

/// `insertMatch` de `tests/helpers/db.ts` (okId `None` : pas de replay ; date en heures).
fn insert(db: &Db, id: i64, ok_id: Option<&str>, hours_ago: i64, duration: Option<f64>) {
    let m = basketland_server::espn_events::ParsedMatch {
        id: id as f64,
        espn_id: id.to_string(),
        league: "nba".into(),
        season: 2026.0,
        season_type: "regular",
        date_utc: Some(basketland_server::time::iso_utc(
            chrono::Utc::now() - chrono::Duration::hours(hours_ago),
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
    let default_ok = format!("1665649{}", &s[s.len().saturating_sub(7)..]);
    db.with(|c| {
        upsert_match(c, &m)?;
        if let Some(ok) = ok_id.map(|o| {
            if o.is_empty() {
                default_ok.clone()
            } else {
                o.to_string()
            }
        }) {
            set_video(
                c,
                id,
                &VideoUpdate {
                    slug: None,
                    ok_id: Some(ok),
                    duration: Some(duration.unwrap_or(7480.0)),
                    available: true,
                    kind: None,
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Porte d'une analyse simulée : son résultat.
type Gate = tokio::sync::oneshot::Sender<Result<AnalysisOutcome, String>>;

/// Exécuteur simulé : chaque analyse attend sa « porte ».
#[derive(Clone, Default)]
struct Gated {
    started: Arc<Mutex<Vec<i64>>>,
    gates: Arc<Mutex<HashMap<i64, Gate>>>,
}

impl Gated {
    fn runner(&self) -> Runner {
        let me = self.clone();
        Arc::new(move |job: AnalysisJob, progress, _hooks| {
            me.started.lock().unwrap().push(job.match_id);
            progress(AnalysisProgress::new("lecture du chrono", 3.0, 10.0));
            let (tx, rx) = tokio::sync::oneshot::channel();
            me.gates.lock().unwrap().insert(job.match_id, tx);
            Box::pin(async move { rx.await.unwrap_or_else(|_| Err("abandon".into())) })
        })
    }

    fn started(&self) -> Vec<i64> {
        self.started.lock().unwrap().clone()
    }

    async fn finish(&self, id: i64, r: Result<AnalysisOutcome, String>) {
        let tx = self
            .gates
            .lock()
            .unwrap()
            .remove(&id)
            .expect("analyse en cours");
        let _ = tx.send(r);
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            if !self.gates.lock().unwrap().contains_key(&id) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn ok(n: f64, reason: &str) -> Result<AnalysisOutcome, String> {
    Ok(AnalysisOutcome::ok(n, reason))
}

fn deps_unused() -> AnalysisDeps {
    AnalysisDeps {
        resolve_stream: Arc::new(|_, _| Box::pin(async { Err("réseau coupé".to_string()) })),
        grab: Arc::new(|_, _, _| Box::pin(async { Err("réseau coupé".to_string()) })),
        ocr: Arc::new(|| Err("OCR indisponible".to_string())),
        analyze_audio: Arc::new(|_| Box::pin(async { Err("réseau coupé".to_string()) })),
        ingest_details: Arc::new(|_| Box::pin(async { Err("ESPN injoignable".to_string()) })),
    }
}

struct T {
    _dir: tempfile::TempDir,
    db: Db,
    svc: Analysis,
    viewers: &'static Viewers,
    clock: TestClock,
}

fn setup_with(deps: AnalysisDeps) -> T {
    for k in [
        "ANALYSIS_MAX_PARALLEL",
        "ANALYSIS_MIN_INTERVAL_MS",
        "ANALYSIS_TIMEOUT_MS",
        "SYNC_WRITE_ORIGINS",
        "COMMENTARY_NIGHT_WINDOW",
        "OCR_DISABLED",
        "OCR_STEP_SEC",
    ] {
        std::env::remove_var(k);
    }
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("DATA_DIR", dir.path());
    let db = fresh_db(dir.path());
    let clock = TestClock::default();
    let c2 = clock.clone();
    let viewers: &'static Viewers = Box::leak(Box::default());
    let svc = Analysis::with_options(
        db.clone(),
        deps,
        AnalysisOptions {
            viewers,
            clock: Arc::new(move || c2.now()),
            ffmpeg_available: Arc::new(|| true),
        },
    );
    T {
        _dir: dir,
        db,
        svc,
        viewers,
        clock,
    }
}

fn setup() -> (T, Gated) {
    let t = setup_with(deps_unused());
    for id in [1, 2, 3, 4] {
        insert(&t.db, id, Some(""), 24, None);
    }
    let g = Gated::default();
    t.svc.set_runner(Some(g.runner()));
    (t, g)
}

fn eo(priority: bool, manual: bool) -> EnqueueOptions {
    EnqueueOptions {
        priority,
        manual,
        ..Default::default()
    }
}

#[tokio::test]
async fn une_analyse_a_la_fois_dans_l_ordre() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    let r = t.svc.enqueue(1, Default::default());
    assert_eq!(
        (r.queued, r.started, r.message.as_str()),
        (true, true, "Analyse lancée")
    );
    let r = t.svc.enqueue(2, Default::default());
    assert_eq!(
        (r.queued, r.started, r.position, r.message.as_str()),
        (true, false, Some(1), "Analyse en file (position 1)")
    );
    let r = t.svc.enqueue(3, Default::default());
    assert_eq!(
        (r.position, r.message.as_str()),
        (Some(2), "Analyse en file (position 2)")
    );
    assert_eq!(g.started(), [1]);
    assert_eq!(
        t.svc.status(1).to_json(),
        json!({ "status": "running", "progress": { "phase": "lecture du chrono", "done": 3, "total": 10 } })
    );
    assert_eq!(
        t.svc.status(3).to_json(),
        json!({ "status": "queued", "position": 2 })
    );
    assert_eq!(
        t.svc.activity().to_json().to_string(),
        r#"{"running":[{"matchId":1,"phase":"lecture du chrono","done":3,"total":10}],"queued":[2,3]}"#
    );
    g.finish(1, ok(8.0, "ok")).await;
    assert_eq!(g.started(), [1, 2]);
    g.finish(2, ok(8.0, "ok")).await;
    g.finish(3, ok(8.0, "ok")).await;
    assert_eq!(g.started(), [1, 2, 3]);
    tokio::time::timeout(Duration::from_secs(5), t.svc.idle())
        .await
        .unwrap();
}

#[tokio::test]
async fn demande_explicite_en_tete() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    t.svc.enqueue(1, Default::default());
    t.svc.enqueue(2, Default::default());
    t.svc.enqueue(3, Default::default());
    let r = t.svc.enqueue(3, eo(true, true));
    assert_eq!(
        (r.position, r.message.as_str()),
        (Some(1), "Analyse en file (position 1)")
    );
    assert_eq!(t.svc.queue_position(2), Some(2));
    assert_eq!(t.svc.enqueue(4, eo(true, true)).position, Some(1));
    assert_eq!(t.svc.queue_position(3), Some(2));
    g.finish(1, ok(4.0, "ok")).await;
    assert_eq!(g.started(), [1, 4]);
}

#[tokio::test]
async fn pas_de_doublon() {
    let _l = LOCK.lock().await;
    let (t, _g) = setup();
    t.svc.enqueue(1, Default::default());
    let r = t.svc.enqueue(1, Default::default());
    assert_eq!(
        (r.queued, r.message.as_str()),
        (false, "Analyse déjà en cours")
    );
    t.svc.enqueue(2, Default::default());
    let r = t.svc.enqueue(2, Default::default());
    assert_eq!(
        (r.queued, r.position, r.message.as_str()),
        (true, Some(1), "Analyse déjà en file (position 1)")
    );
}

#[tokio::test]
async fn parallelisme() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    std::env::set_var("ANALYSIS_MAX_PARALLEL", "2");
    t.svc.enqueue(1, Default::default());
    t.svc.enqueue(2, Default::default());
    t.svc.enqueue(3, Default::default());
    std::env::remove_var("ANALYSIS_MAX_PARALLEL");
    assert_eq!(g.started(), [1, 2]);
    std::env::set_var("ANALYSIS_MAX_PARALLEL", "abc");
    g.finish(1, ok(4.0, "ok")).await;
    std::env::remove_var("ANALYSIS_MAX_PARALLEL");
    // Valeur non numérique : 1 (la limite n'est jamais désactivée) ; 2 encore en cours.
    assert_eq!(g.started(), [1, 2]);
}

#[tokio::test]
async fn match_sans_replay() {
    let _l = LOCK.lock().await;
    let (t, _g) = setup();
    insert(&t.db, 9, None, 24, None);
    let r = t.svc.enqueue(9, Default::default());
    assert_eq!(
        (r.queued, r.message.as_str()),
        (false, "Analyse impossible : pas de replay disponible")
    );
    assert_eq!(
        t.svc.status(9),
        AnalysisStatus::Unavailable("pas de replay disponible".into())
    );
    assert_eq!(
        t.svc.status(9).to_json().to_string(),
        r#"{"status":"unavailable","reason":"pas de replay disponible","anchors_auto":0}"#
    );
}

#[tokio::test]
async fn analyse_qui_plante() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    t.svc.enqueue(1, Default::default());
    g.finish(
        1,
        Err("OCR indisponible : script du worker tesseract.js absent".into()),
    )
    .await;
    assert_eq!(
        t.svc.status(1),
        AnalysisStatus::Failed(
            "Analyse impossible : OCR indisponible : script du worker tesseract.js absent".into()
        )
    );
    let r = t.svc.record(1).unwrap();
    assert_eq!(
        (r.ok, r.failures, r.kind),
        (false, Some(1.0), Some(AnalysisFailureKind::Erreur))
    );
    let log = t.db.with(|c| db::last_ingests(c, 1)).unwrap();
    assert_eq!((log[0].task.as_str(), log[0].ok), ("analyse-1", false));
}

#[tokio::test]
async fn delai_depasse() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    std::env::set_var("ANALYSIS_TIMEOUT_MS", "20");
    t.svc.enqueue(1, Default::default());
    t.svc.enqueue(2, Default::default());
    tokio::time::sleep(Duration::from_millis(120)).await;
    std::env::remove_var("ANALYSIS_TIMEOUT_MS");
    match t.svc.status(1) {
        AnalysisStatus::Failed(r) => assert!(r.contains("délai dépassé (1 min)"), "{r}"),
        s => panic!("{s:?}"),
    }
    assert_eq!(g.started(), [1, 2]);
}

#[tokio::test]
async fn cooldown_apres_succes() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    t.svc.enqueue(1, eo(false, true));
    g.finish(1, ok(6.0, "ok")).await;
    let r = t.svc.enqueue(1, eo(true, true));
    assert!(!r.queued);
    assert!(
        regex::Regex::new(r"^Analyse récente, réessayez dans ~\d+ min$")
            .unwrap()
            .is_match(&r.message),
        "{}",
        r.message
    );
    std::env::set_var("ANALYSIS_MIN_INTERVAL_MS", "0");
    let r = t.svc.enqueue(1, eo(true, true));
    std::env::remove_var("ANALYSIS_MIN_INTERVAL_MS");
    assert_eq!((r.queued, r.started), (true, true));
}

#[tokio::test]
async fn mise_en_file_automatique() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    insert(&t.db, 5, Some(""), 20 * 24, None); // trop ancien
    insert(&t.db, 6, None, 24, None); // pas de replay
    let anchor = |m: i64, p: f64, method: &str| AnchorInput {
        match_id: m,
        period: p,
        clock_sec: 600.0,
        video_ts: 500.0 * p,
        method: method.into(),
        wallclock: None,
    };
    t.db.with(|c| {
        adb::upsert_anchor(c, &anchor(4, 1.0, "auto"))?; // déjà analysé
        adb::upsert_anchor(c, &anchor(3, 1.0, "manual"))?;
        adb::upsert_anchor(c, &anchor(3, 2.0, "manual")) // calé à la main
    })
    .unwrap();
    let ok_id2 =
        t.db.with(|c| db::get_match(c, 2))
            .unwrap()
            .unwrap()
            .video_ok_id
            .unwrap();
    let rec = json!({ "at": basketland_server::time::iso_utc(chrono::Utc::now()), "ok": false, "failures": 1, "reason": "x", "anchors": 0, "okId": ok_id2 });
    t.db.with(|c| db::kv_set(c, "analysis:2", &rec)).unwrap();
    assert_eq!(t.svc.enqueue_recent(None, None), 1);
    assert_eq!(g.started(), [1]);
    // Un nouveau passage ne remet rien en file (1 en cours, 2 en backoff).
    assert_eq!(t.svc.enqueue_recent(None, None), 0);
    g.finish(
        1,
        Ok(AnalysisOutcome::failed(
            None,
            0.0,
            "Chrono du bandeau illisible",
        )),
    )
    .await;
    assert_eq!(
        t.svc.status(1),
        AnalysisStatus::Failed("Chrono du bandeau illisible".into())
    );
    assert_eq!(t.svc.enqueue_recent(None, None), 0); // backoff de 1 h
    t.clock.advance_ms(61 * 60_000);
    assert_eq!(t.svc.enqueue_recent(None, None), 2, "1 et 2 : backoff échu");
}

#[tokio::test]
async fn flux_inaccessible_distingue() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    t.svc.enqueue(1, Default::default());
    g.finish(
        1,
        Ok(AnalysisOutcome::failed(
            Some(AnalysisFailureKind::Reseau),
            0.0,
            "Flux vidéo inaccessible : aucune image…",
        )),
    )
    .await;
    let r = t.svc.record(1).unwrap();
    assert_eq!(
        (r.ok, r.kind, r.failures, r.net_failures),
        (
            false,
            Some(AnalysisFailureKind::Reseau),
            Some(0.0),
            Some(1.0)
        )
    );
    match t.svc.status(1) {
        AnalysisStatus::Failed(r) => assert!(r.contains("Flux vidéo inaccessible")),
        s => panic!("{s:?}"),
    }
    t.svc.enqueue(1, eo(false, true));
    g.finish(
        1,
        Ok(AnalysisOutcome::failed(
            Some(AnalysisFailureKind::Contenu),
            0.0,
            "Chrono du bandeau illisible",
        )),
    )
    .await;
    let r = t.svc.record(1).unwrap();
    assert_eq!(
        (r.kind, r.failures, r.net_failures),
        (Some(AnalysisFailureKind::Contenu), Some(1.0), None)
    );
}

#[tokio::test]
async fn statut_done_et_estime() {
    let _l = LOCK.lock().await;
    let (t, _g) = setup();
    let a = |m: i64, p: f64, method: &str| AnchorInput {
        match_id: m,
        period: p,
        clock_sec: 600.0,
        video_ts: 500.0 + 1400.0 * (p - 1.0),
        method: method.into(),
        wallclock: None,
    };
    t.db.with(|c| {
        adb::upsert_anchor(c, &a(1, 1.0, "auto"))?;
        adb::upsert_anchor(c, &a(1, 2.0, "auto"))?;
        adb::upsert_anchor(c, &a(3, 1.0, "audio"))
    })
    .unwrap();
    assert_eq!(
        t.svc.status(1).to_json().to_string(),
        r#"{"status":"done","anchors_auto":2}"#
    );
    assert_eq!(
        t.svc.status(2).to_json().to_string(),
        r#"{"status":"none","anchors_auto":0}"#
    );
    assert_eq!(
        t.svc.status(3).to_json().to_string(),
        r#"{"status":"estimated","reason":"calage approximatif (coupures audio), chrono non lu","anchors_auto":0}"#
    );
}

#[tokio::test]
async fn analyse_de_fond_en_pause_et_fenetre_de_nuit() {
    let _l = LOCK.lock().await;
    let (t, g) = setup();
    // Quelqu'un regarde : l'analyse de fond attend, une demande explicite part.
    t.viewers.touch_at(4, Some(10.0), t.clock.now());
    let r = t.svc.enqueue(
        1,
        EnqueueOptions {
            background: true,
            ..Default::default()
        },
    );
    assert_eq!((r.queued, r.started, r.position), (true, false, Some(1)));
    assert!(g.started().is_empty());
    let r = t.svc.enqueue(2, eo(true, true));
    assert!(r.started);
    assert_eq!(g.started(), [2]);
    // Hors de la fenêtre de nuit : les analyses de fond en attente sont abandonnées.
    std::env::set_var("COMMENTARY_NIGHT_WINDOW", "off");
    t.viewers.clear();
    g.finish(2, ok(3.0, "ok")).await;
    std::env::remove_var("COMMENTARY_NIGHT_WINDOW");
    assert_eq!(g.started(), [2]);
    assert_eq!(t.svc.queue_position(1), None);
    assert_eq!(
        t.svc.activity().to_json().to_string(),
        r#"{"running":[],"queued":[]}"#
    );
}

// ------------------------------------------------------------------ route de calage

const ID: i64 = 401909880;

fn plays_fixture() -> Vec<basketland_server::espn_events::PlayRow> {
    let raw: Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../tests/fixtures/espn-summary-401909880.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    parse_summary(&raw, ID as f64, "nba").plays
}

fn route_setup() -> T {
    let t = setup_with(deps_unused());
    insert(&t.db, ID, Some(""), 24, Some(8033.0));
    let plays = plays_fixture();
    t.db.with(|c| replace_plays(c, ID, &plays)).unwrap();
    // Analyse « en cours » indéfiniment.
    t.svc
        .set_runner(Some(Arc::new(|_, _, _| Box::pin(std::future::pending()))));
    t
}

fn headers(origin: &str, ctype: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("content-type", HeaderValue::from_str(ctype).unwrap());
    h.insert("origin", HeaderValue::from_str(origin).unwrap());
    h.insert("host", HeaderValue::from_static("nas.local:3012"));
    h
}

async fn body_of(r: axum::response::Response) -> (u16, Value) {
    let status = r.status().as_u16();
    let b = axum::body::to_bytes(r.into_body(), 1 << 24).await.unwrap();
    (status, serde_json::from_slice(&b).unwrap())
}

async fn post(t: &T, body: Value) -> (u16, Value) {
    post_with(t, body, "http://nas.local:3012", "application/json").await
}

async fn post_with(t: &T, body: Value, origin: &str, ctype: &str) -> (u16, Value) {
    body_of(sync_route::post(
        &t.db,
        &t.svc,
        &ID.to_string(),
        &headers(origin, ctype),
        body.to_string().as_bytes(),
    ))
    .await
}

fn manual_anchors(t: &T) -> Vec<Value> {
    t.db.with(|c| adb::anchors_json(c, ID))
        .unwrap()
        .into_iter()
        .filter(|a| a["method"] == "manual")
        .collect()
}

#[tokio::test]
async fn route_get_statut() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let (s, d) = body_of(sync_route::get(&t.db, &t.svc, &ID.to_string())).await;
    assert_eq!(s, 200);
    assert_eq!(
        d["analysis"],
        json!({ "status": "none", "anchors_auto": 0 })
    );
    assert_eq!(d["audio"]["status"], "none");
    assert_eq!(body_of(sync_route::get(&t.db, &t.svc, "abc")).await.0, 400);
    assert_eq!(body_of(sync_route::get(&t.db, &t.svc, "12")).await.0, 404);
}

#[tokio::test]
async fn route_ancre_chrono() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let (s, d) = post(
        &t,
        json!({ "action": "clock", "video_ts": 3600, "period": 2, "clock_sec": 84 }),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(d["message"], "ancre posée (2e période, 1:24)");
    assert!(d["subtitles"].as_u64().unwrap() > 0);
    let a = d["anchors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["method"] == "manual")
        .unwrap()
        .clone();
    assert_eq!(
        (
            a["period"].clone(),
            a["clock_sec"].clone(),
            a["video_ts"].clone()
        ),
        (json!(2), json!(84), json!(3600))
    );
    let play = plays_fixture()
        .into_iter()
        .find(|p| p.period == 2.0 && p.clock_sec == 84.0)
        .unwrap();
    let want = basketland_server::time::iso_utc(
        basketland_server::time::parse_instant(&play.wallclock).unwrap(),
    );
    assert_eq!(a["wallclock"], want);
}

#[tokio::test]
async fn route_ancre_sans_les_offsets() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let mut q = serde_json::Map::new();
    q.insert("2".into(), json!(2));
    t.db.with(|c| adb::save_sync_settings(c, ID, 5.0, &q))
        .unwrap();
    post(
        &t,
        json!({ "action": "clock", "video_ts": 3600, "period": 2, "clock_sec": 84 }),
    )
    .await;
    assert_eq!(manual_anchors(&t)[0]["video_ts"], json!(3593));
}

#[tokio::test]
async fn route_ancre_dixiemes_arrondis() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let (_, d) = post(
        &t,
        json!({ "action": "clock", "video_ts": 7000, "period": 4, "clock_sec": 42.8 }),
    )
    .await;
    assert_eq!(d["message"], "ancre posée (4e période, 0:43)");
    assert_eq!(manual_anchors(&t)[0]["clock_sec"], json!(43));
}

#[tokio::test]
async fn route_ancre_validee_strictement() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let cases = [
        (
            json!({ "video_ts": 3600, "period": 2.5, "clock_sec": 84 }),
            400,
        ),
        (
            json!({ "video_ts": 3600, "period": 0, "clock_sec": 84 }),
            400,
        ),
        (
            json!({ "video_ts": 3600, "period": 11, "clock_sec": 84 }),
            400,
        ),
        (
            json!({ "video_ts": 3600, "period": "2", "clock_sec": 84 }),
            400,
        ),
        (
            json!({ "video_ts": 3600, "period": 2, "clock_sec": 721 }),
            400,
        ),
        (
            json!({ "video_ts": 3600, "period": 2, "clock_sec": -1 }),
            400,
        ),
        (json!({ "video_ts": -1, "period": 2, "clock_sec": 84 }), 400),
        (
            json!({ "video_ts": 99999, "period": 2, "clock_sec": 84 }),
            400,
        ),
        (json!({ "period": 2, "clock_sec": 84 }), 400),
        (
            json!({ "video_ts": 100, "period": 5, "clock_sec": 301 }),
            400,
        ),
        (
            json!({ "video_ts": 100, "period": 6, "clock_sec": 200 }),
            422,
        ),
    ];
    for (mut body, status) in cases {
        body["action"] = json!("clock");
        assert_eq!(post(&t, body.clone()).await.0, status, "{body}");
        assert!(t.db.with(|c| adb::anchors_json(c, ID)).unwrap().is_empty());
    }
    let (_, d) = post(
        &t,
        json!({ "action": "clock", "video_ts": 100, "period": 6, "clock_sec": 200 }),
    )
    .await;
    assert_eq!(d["error"], "prolongation 2 absente du play-by-play");
}

#[tokio::test]
async fn route_origine_et_content_type() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let b = json!({ "action": "clock", "video_ts": 3600, "period": 2, "clock_sec": 84 });
    assert_eq!(
        post_with(&t, b.clone(), "https://evil.example", "application/json")
            .await
            .0,
        403
    );
    assert_eq!(
        post_with(&t, b.clone(), "http://nas.local:3012", "text/plain")
            .await
            .0,
        415
    );
    assert_eq!(
        post_with(
            &t,
            b,
            "http://nas.local:3012",
            "text/plain;charset=application/json"
        )
        .await
        .0,
        415
    );
    assert!(t.db.with(|c| adb::anchors_json(c, ID)).unwrap().is_empty());
}

#[tokio::test]
async fn route_sans_play_by_play() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    t.db.with(|c| replace_plays(c, ID, &[])).unwrap();
    assert_eq!(
        post(
            &t,
            json!({ "action": "clock", "video_ts": 3600, "period": 2, "clock_sec": 84 })
        )
        .await
        .0,
        409
    );
}

#[tokio::test]
async fn route_analyse_lancee_puis_deja_en_cours() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    let (s, d) = post(&t, json!({ "action": "analyze" })).await;
    assert_eq!(s, 202);
    assert_eq!(
        (
            d["started"].clone(),
            d["queued"].clone(),
            d["message"].clone()
        ),
        (json!(true), json!(true), json!("Analyse lancée"))
    );
    assert_eq!(d["analysis"]["status"], "running");
    let (s, again) = post(&t, json!({ "action": "analyze" })).await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            again["started"].clone(),
            again["queued"].clone(),
            again["message"].clone()
        ),
        (json!(false), json!(false), json!("Analyse déjà en cours"))
    );
}

#[tokio::test]
async fn route_analyse_en_file_derriere_une_autre() {
    let _l = LOCK.lock().await;
    let t = route_setup();
    insert(&t.db, 1, Some(""), 24, None);
    t.svc.enqueue(1, Default::default());
    let (_, d) = post(&t, json!({ "action": "analyze" })).await;
    assert_eq!(
        (
            d["started"].clone(),
            d["queued"].clone(),
            d["position"].clone(),
            d["message"].clone()
        ),
        (
            json!(false),
            json!(true),
            json!(1),
            json!("Analyse en file (position 1)")
        )
    );
    assert_eq!(d["analysis"], json!({ "status": "queued", "position": 1 }));
}

// ------------------------------------------------------------------ analyse complète (fausses dépendances)

fn stream_ok() -> StreamInfo {
    StreamInfo {
        dash_url: None,
        variants: vec![v("hd", "1280x720", 2.5e6), v("low", "640x360", 6e5)],
        mp4: vec![],
        duration: Some(8000.0),
    }
}

fn deps_with(
    grab_err: Option<&'static str>,
    ocr_err: Option<&'static str>,
    calls: Arc<Mutex<Vec<String>>>,
) -> AnalysisDeps {
    let (c1, c2, c3) = (calls.clone(), calls.clone(), calls);
    AnalysisDeps {
        resolve_stream: Arc::new(move |ok, force| {
            c1.lock().unwrap().push(format!("flux {ok} {force}"));
            Box::pin(async { Ok(stream_ok()) })
        }),
        grab: Arc::new(move |url, t, timeout| {
            c2.lock()
                .unwrap()
                .push(format!("image {url} @{t} {timeout:?}"));
            Box::pin(async move {
                match grab_err {
                    Some(e) => Err(e.to_string()),
                    None => Ok(vec![0u8; 8]),
                }
            })
        }),
        ocr: Arc::new(move || Err(ocr_err.unwrap_or("OCR indisponible : test").to_string())),
        analyze_audio: Arc::new(move |url| {
            c3.lock().unwrap().push(format!("audio {url}"));
            Box::pin(async {
                let mut p = vec![-20.0; 1200];
                for x in p.iter_mut().skip(300).take(40) {
                    *x = -85.0;
                }
                Ok(p)
            })
        }),
        ingest_details: Arc::new(|_| Box::pin(async { Err("ESPN injoignable".to_string()) })),
    }
}

fn run_setup(deps: AnalysisDeps) -> T {
    let t = setup_with(deps);
    insert(&t.db, ID, Some(""), 24, Some(8033.0));
    let plays = plays_fixture();
    t.db.with(|c| replace_plays(c, ID, &plays)).unwrap();
    t
}

async fn run_to_end(t: &T, opts: EnqueueOptions) -> AnalysisRecord {
    assert!(t.svc.enqueue(ID, opts).started);
    tokio::time::timeout(Duration::from_secs(20), t.svc.idle())
        .await
        .expect("analyse terminée");
    t.svc.record(ID).expect("enregistrement")
}

#[tokio::test]
async fn analyse_audio_seule_ocr_desactive() {
    let _l = LOCK.lock().await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let t = run_setup(deps_with(None, None, calls.clone()));
    std::env::set_var("OCR_DISABLED", "1");
    let r = run_to_end(&t, eo(true, true)).await;
    std::env::remove_var("OCR_DISABLED");
    assert!(r.ok, "{}", r.reason);
    assert!(
        regex::Regex::new(r"^audio : 1200 s, 1 coupures ; \d+ sous-titres recalés$")
            .unwrap()
            .is_match(&r.reason),
        "{}",
        r.reason
    );
    let ok_id =
        t.db.with(|c| db::get_match(c, ID))
            .unwrap()
            .unwrap()
            .video_ok_id
            .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        [
            format!("flux {ok_id} true"),
            format!("flux {ok_id} true"),
            "audio https://vd.okcdn.ru/low.m3u8".to_string()
        ]
    );
    let (_, d) = body_of(sync_route::get(&t.db, &t.svc, &ID.to_string())).await;
    assert_eq!(d["audio"]["seconds"], json!(1200));
    assert_eq!(
        d["audio"]["cuts"],
        json!([{ "start": 300, "end": 340, "meanDb": -85 }])
    );
    assert_eq!(
        d["analysis"],
        json!({ "status": "none", "anchors_auto": 0 })
    );
    let log = t.db.with(|c| db::last_ingests(c, 1)).unwrap();
    assert_eq!(
        (log[0].task.as_str(), log[0].ok),
        ("analyse-401909880", true)
    );
}

#[tokio::test]
async fn analyse_flux_inaccessible() {
    let _l = LOCK.lock().await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let t = run_setup(deps_with(
        Some("ffmpeg frame @4017s code 1: Server returned 403\n  Forbidden"),
        None,
        calls.clone(),
    ));
    let r = run_to_end(&t, eo(true, true)).await;
    assert_eq!(
        r.reason,
        "Flux vidéo inaccessible : aucune image n'a pu être extraite (ffmpeg frame @4017s code 1: Server returned 403 Forbidden). Problème réseau, pas de contenu : nouvel essai automatique dans ~15 min."
    );
    assert_eq!(
        (r.kind, r.failures, r.net_failures),
        (Some(AnalysisFailureKind::Reseau), Some(0.0), Some(1.0))
    );
    // Sonde au milieu de la vidéo (durée en base : 8033 s), sur les deux sources HLS.
    let grabs: Vec<String> = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.starts_with("image"))
        .cloned()
        .collect();
    assert_eq!(
        grabs,
        [
            "image https://vd.okcdn.ru/hd.m3u8 @4017 Some(45s)",
            "image https://vd.okcdn.ru/low.m3u8 @4017 Some(45s)"
        ]
    );
    // Deuxième échec réseau : 30 min.
    let r = run_to_end(&t, eo(true, false)).await;
    assert!(r.reason.ends_with("dans ~30 min."), "{}", r.reason);
    assert_eq!(r.net_failures, Some(2.0));
}

#[tokio::test]
async fn analyse_sans_moteur_ocr() {
    let _l = LOCK.lock().await;
    let t = run_setup(deps_with(
        None,
        Some("OCR indisponible : serveur compilé sans Tesseract (fonction cargo « ocr »)"),
        Arc::default(),
    ));
    let r = run_to_end(&t, eo(true, true)).await;
    assert_eq!(r.reason, "Analyse impossible : OCR indisponible : serveur compilé sans Tesseract (fonction cargo « ocr »)");
    assert_eq!(
        (r.kind, r.failures),
        (Some(AnalysisFailureKind::Erreur), Some(1.0))
    );
}

#[tokio::test]
async fn analyse_sans_play_by_play() {
    let _l = LOCK.lock().await;
    let t = run_setup(deps_with(None, None, Arc::default()));
    t.db.with(|c| replace_plays(c, ID, &[])).unwrap();
    let r = run_to_end(&t, eo(true, true)).await;
    assert_eq!(r.reason, "Analyse impossible : ESPN injoignable");
}

#[tokio::test]
async fn analyse_de_fond_en_pause_pendant_une_lecture() {
    let _l = LOCK.lock().await;
    let t = setup_with(deps_unused());
    insert(&t.db, 1, Some(""), 24, None);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let rx = Arc::new(Mutex::new(Some(rx)));
    t.svc
        .set_runner(Some(Arc::new(move |_job, progress, hooks| {
            let rx = rx.lock().unwrap().take().unwrap();
            Box::pin(async move {
                progress(AnalysisProgress::new("lecture du chrono", 4.0, 9.0));
                let _ = rx.await;
                (hooks.gate)().await;
                Ok(AnalysisOutcome::ok(5.0, "ok"))
            })
        })));
    assert!(
        t.svc
            .enqueue(
                1,
                EnqueueOptions {
                    background: true,
                    ..Default::default()
                }
            )
            .started
    );
    t.viewers.touch_at(7, Some(10.0), t.clock.now());
    tx.send(()).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        t.svc.activity().running[0].phase,
        "en pause pendant la lecture"
    );
    t.viewers.clear();
    tokio::time::timeout(Duration::from_secs(10), t.svc.idle())
        .await
        .unwrap();
    assert!(t.svc.record(1).unwrap().ok);
    assert_eq!(
        t.svc.activity().to_json().to_string(),
        r#"{"running":[],"queued":[]}"#
    );
}
