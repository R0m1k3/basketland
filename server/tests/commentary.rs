//! File de traduction des commentaires (étape 6b, non branchée) : portage de
//! `tests/commentary-queue.test.ts` et `tests/commentary-ondemand.test.ts`
//! (exécuteurs et dépendances simulés comme dans les tests de Node ; les
//! cas des routes y sont rejoués par les appels que font ces routes), plus
//! les crochets du doublage, le garde-fou de durée et le son complet découpé
//! par le vrai ffmpeg. Les extractions ffmpeg de `commentary-extract.test.ts`
//! sont déjà couvertes par `tests/media.rs` (étape 6a).

#[path = "helpers/commentary_kit.rs"]
mod kit;

use basketland_server::commentary_db as cdb;
use basketland_server::db::Db;
use basketland_server::ingest_db::{set_video, VideoUpdate};
use basketland_server::media::abort::AbortSignal;
use basketland_server::media::commentary::{
    self as cm, Commentary, CommentaryControl, CommentaryDeps, CommentaryError, CommentaryOutcome,
    CommentaryPhase, CommentaryProgress, EnqueueOptions, FailureKind, Job, ProgressFn, Runner,
    TranscribeFn, MAX_AUTO_FAILURES,
};
use basketland_server::media::commentary_ai::{
    Service, ServiceError, TranslatedLine, DEFAULT_TRANSLATE_MODEL,
};
use basketland_server::media::commentary_cues::{AsrSegment, AsrWord, Transcript};
use kit::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const A: i64 = 401000001;
const B: i64 = 401000002;
const C: i64 = 401000003;
const WHISPER: &str = "deepdml/faster-whisper-large-v3-turbo-ct2";

fn opts(priority: bool, force: bool, explicit: bool) -> EnqueueOptions {
    EnqueueOptions {
        priority,
        force,
        explicit,
    }
}

fn ok(reason: &str) -> CommentaryOutcome {
    CommentaryOutcome::ok(reason)
}

/// Exécuteur simulé : chaque travail attend sa « porte » (ou l'interruption,
/// qui le fait échouer comme `signal.addEventListener('abort', …)`).
#[derive(Clone, Default)]
struct Gated {
    started: Arc<Mutex<Vec<i64>>>,
    gates: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<CommentaryOutcome>>>>,
    opened: Arc<Mutex<usize>>,
}

impl Gated {
    fn runner(&self, reject_on_abort: bool, progress_now: Option<CommentaryProgress>) -> Runner {
        let me = self.clone();
        Arc::new(
            move |job: Job, progress: ProgressFn, signal: AbortSignal, _ctl| {
                me.started.lock().unwrap().push(job.match_id);
                if let Some(p) = progress_now {
                    progress(p);
                }
                let (tx, rx) = tokio::sync::oneshot::channel();
                me.gates.lock().unwrap().insert(job.match_id, tx);
                *me.opened.lock().unwrap() += 1;
                Box::pin(async move {
                    if reject_on_abort {
                        tokio::select! {
                            r = rx => Ok(r.unwrap_or_else(|_| ok("abandon"))),
                            _ = signal.aborted() => Err(CommentaryError::Other("travail interrompu".into())),
                        }
                    } else {
                        Ok(rx.await.unwrap_or_else(|_| ok("abandon")))
                    }
                })
            },
        )
    }

    fn started(&self) -> Vec<i64> {
        self.started.lock().unwrap().clone()
    }

    fn resolve(&self, id: i64, o: CommentaryOutcome) {
        let tx = self
            .gates
            .lock()
            .unwrap()
            .remove(&id)
            .expect("travail en cours");
        let _ = tx.send(o);
    }
}

/// Exécuteur qui ne rend jamais la main (`() => new Promise(() => {})`).
fn pending_runner() -> Runner {
    Arc::new(|_, _, _, _| Box::pin(std::future::pending()))
}

struct T {
    _dir: tempfile::TempDir,
    db: Db,
    svc: Commentary,
    clock: TestClock,
}

fn setup(ids: &[i64]) -> T {
    let dir = env_setup();
    let db = fresh_db(dir.path());
    for id in ids {
        insert_match(&db, *id, Some(DURATION));
    }
    let (deps, _) = fake_deps(Fake::default());
    let (svc, clock) = service(&db, deps);
    T {
        _dir: dir,
        db,
        svc,
        clock,
    }
}

fn no_video(db: &Db, id: i64) {
    db.with(|c| {
        set_video(
            c,
            id,
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
}

fn full_track(db: &Db, id: i64, model: &str) {
    let meta = cdb::CommentaryTrackMeta {
        ok_id: ok_id(db, id),
        transcribe_model: "w".into(),
        translate_model: model.into(),
        chunk_sec: None,
        chunks_total: None,
    };
    let cue = cdb::CueInput {
        seq: 1,
        start_ts: 1.0,
        end_ts: 2.0,
        text_en: "Hi".into(),
        text_fr: "Salut".into(),
        untranslated: false,
        emphasis: 0.0,
    };
    db.with(|c| cdb::replace_commentary(c, id, &meta, &[cue]))
        .unwrap();
}

// ------------------------------------------------------------------ file des traductions

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_seul_travail_a_la_fois_dans_l_ordre() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    let g = Gated::default();
    t.svc.set_runner(Some(g.runner(
        false,
        Some(CommentaryProgress {
            phase: CommentaryPhase::Transcription,
            done: 2.0,
            total: 3.0,
            available_until: None,
        }),
    )));
    let r = t.svc.enqueue(A, EnqueueOptions::default());
    assert!(r.queued && r.started);
    let r = t.svc.enqueue(B, EnqueueOptions::default());
    assert!(r.queued && !r.started);
    assert_eq!(r.position, Some(1));
    assert_eq!(g.started(), vec![A]);
    assert_eq!(
        t.svc.status(A).to_json(),
        json!({ "status": "running", "phase": "transcription", "progress": { "done": 2, "total": 3 },
                "models": { "transcribe": WHISPER, "translate": DEFAULT_TRANSLATE_MODEL } })
    );
    let s = t.svc.status(B);
    assert_eq!((s.status, s.position), ("queued", Some(1)));
    g.resolve(A, ok("ok"));
    wait_for("B démarre", || g.started() == vec![A, B]).await;
    g.resolve(B, ok("ok"));
    t.svc.idle().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn priorite_la_fiche_ouverte_passe_en_tete() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    t.svc.set_runner(Some(pending_runner()));
    t.svc.enqueue(A, EnqueueOptions::default());
    t.svc.enqueue(B, EnqueueOptions::default());
    t.svc.enqueue(C, EnqueueOptions::default());
    assert_eq!(t.svc.queue_position(C), Some(2));
    assert_eq!(t.svc.enqueue(C, opts(true, false, false)).position, Some(1));
    assert_eq!(t.svc.queue_position(B), Some(2));
    let r = t.svc.enqueue(A, EnqueueOptions::default());
    assert!(r.started);
    assert_eq!(r.message, "Traduction déjà en cours");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_match_regarde_interrompt_le_travail_de_fond() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    let g = Gated::default();
    t.svc.set_runner(Some(g.runner(true, None)));
    t.svc.enqueue(A, EnqueueOptions::default()); // fond
    t.svc.enqueue(B, EnqueueOptions::default()); // fond
    assert_eq!(g.started(), vec![A]);
    t.svc.enqueue(C, opts(true, false, false)); // fiche ouverte
    wait_for("C démarre", || g.started() == vec![A, C]).await;
    assert_eq!(t.svc.status(C).status, "running");
    // A reprend juste derrière C, devant B ; aucun échec enregistré.
    assert_eq!(t.svc.queue_position(A), Some(1));
    assert_eq!(t.svc.queue_position(B), Some(2));
    assert!(t.svc.record(A).is_none());
    // Un autre match regardé n'interrompt pas C (demandé par un spectateur).
    t.svc.enqueue(B, opts(true, false, false));
    assert_eq!(t.svc.status(C).status, "running");
    assert_eq!(t.svc.queue_position(B), Some(1));
    g.resolve(C, ok("ok"));
    wait_for("B démarre", || g.started() == vec![A, C, B]).await;
    g.resolve(B, ok("ok"));
    wait_for("A reprend", || g.started() == vec![A, C, B, A]).await;
    g.resolve(A, ok("ok"));
    t.svc.idle().await;
    assert!(t.svc.record(A).unwrap().ok);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fiche_quittee_le_travail_cede_la_place_sans_attendre() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    let g = Gated::default();
    t.svc.set_runner(Some(g.runner(true, None)));
    set_env("COMMENTARY_VIEWER_GONE_MS", "30");
    // A ouvert et lancé, puis B ouvert pendant que la fiche de A est encore ouverte : B attend.
    t.svc.touch_viewer(A, Some(0.0));
    t.svc.enqueue(A, opts(true, false, false));
    t.svc.touch_viewer(B, Some(0.0));
    t.svc.enqueue(B, opts(true, false, false));
    assert_eq!(g.started(), vec![A]);
    assert_eq!(t.svc.queue_position(B), Some(1));
    // La fiche de A n'envoie plus rien : la prochaine interrogation de B le fait passer.
    tokio::time::sleep(Duration::from_millis(50)).await;
    t.svc.touch_viewer(B, Some(0.0));
    t.svc.nudge(B);
    wait_for("B démarre", || g.started() == vec![A, B]).await;
    assert!(t.svc.record(A).is_none()); // pas un échec
    g.resolve(B, ok("ok"));
    wait_for("A reprend", || *g.opened.lock().unwrap() == 3).await;
    unset_env("COMMENTARY_VIEWER_GONE_MS");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_sans_configuration() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    unset_env("TRANSLATE_URL");
    let r = t.svc.enqueue(A, EnqueueOptions::default());
    assert!(!r.queued);
    assert!(r.message.contains("TRANSLATE_URL"), "{}", r.message);
    assert_eq!(
        t.svc.status(A).to_json(),
        json!({ "status": "disabled", "reason": "serveur de traduction non configuré (TRANSLATE_URL)" })
    );
    assert_eq!(t.svc.enqueue_recent(None, None), 0);
}

fn parse_ms(at: &str) -> f64 {
    basketland_server::time::parse_instant(at)
        .unwrap()
        .timestamp_millis() as f64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echec_backoff_et_abandon() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    let outcome = Arc::new(Mutex::new(CommentaryOutcome::failed(
        FailureKind::Erreur,
        "boum",
    )));
    let o2 = outcome.clone();
    t.svc.set_runner(Some(Arc::new(move |_, _, _, _| {
        let o = o2.lock().unwrap().clone();
        Box::pin(async move { Ok(o) })
    })));
    t.svc.enqueue(A, EnqueueOptions::default());
    t.svc.idle().await;
    let rec = t.svc.record(A).unwrap();
    assert_eq!(
        (rec.ok, rec.failures, rec.kind, rec.reason.as_str()),
        (false, Some(1.0), Some(FailureKind::Erreur), "boum")
    );
    assert_eq!(
        t.svc.status(A).to_json(),
        json!({ "status": "failed", "reason": "boum" })
    );
    let ok_a = ok_id(&t.db, A);
    let at = parse_ms(&rec.at);
    assert!(!cm::commentary_retry_allowed(
        Some(&rec),
        Some(&ok_a),
        at + 30.0 * 60_000.0
    ));
    assert!(cm::commentary_retry_allowed(
        Some(&rec),
        Some(&ok_a),
        at + 3_600_000.0
    ));
    let mut maxed = rec.clone();
    maxed.failures = Some(MAX_AUTO_FAILURES as f64);
    assert!(!cm::commentary_retry_allowed(
        Some(&maxed),
        Some(&ok_a),
        at + 30.0 * 24.0 * 3_600_000.0
    ));
    // Nouvelle vidéo : on repart de zéro.
    assert!(cm::commentary_retry_allowed(
        Some(&maxed),
        Some("autre-video"),
        at
    ));

    *outcome.lock().unwrap() = CommentaryOutcome::failed(FailureKind::Service, "Ollama éteint");
    t.svc.enqueue(A, EnqueueOptions::default());
    t.svc.idle().await;
    let rec2 = t.svc.record(A).unwrap();
    assert_eq!(
        (rec2.failures, rec2.net_failures, rec2.kind),
        (Some(1.0), Some(1.0), Some(FailureKind::Service))
    );
    assert!(cm::commentary_retry_allowed(
        Some(&rec2),
        Some(&ok_a),
        parse_ms(&rec2.at) + 16.0 * 60_000.0
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn une_erreur_de_service_devient_un_echec_service() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    t.svc.set_runner(Some(Arc::new(|_, _, _, _| {
        Box::pin(async {
            Err(CommentaryError::Service(ServiceError {
                message:
                    "serveur de traduction injoignable (http://gpu.local:11434/v1) : ECONNREFUSED"
                        .into(),
                service: Service::Traduction,
            }))
        })
    })));
    t.svc.enqueue(A, EnqueueOptions::default());
    t.svc.idle().await;
    let rec = t.svc.record(A).unwrap();
    assert_eq!(rec.kind, Some(FailureKind::Service));
    assert_eq!(
        rec.reason,
        "Traduction impossible : serveur de traduction injoignable (http://gpu.local:11434/v1) : ECONNREFUSED"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_periodique_matchs_recents_sans_piste_a_jour() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    t.svc.set_runner(Some(pending_runner()));
    full_track(&t.db, A, DEFAULT_TRANSLATE_MODEL);
    no_video(&t.db, C);
    assert_eq!(t.svc.enqueue_recent(None, None), 1); // B seulement (A prête, C sans replay)
    assert_eq!(t.svc.status(B).status, "running");
    // Le replay de A change : la piste n'est plus valable, A repasse en file.
    t.db.with(|c| {
        set_video(
            c,
            A,
            &VideoUpdate {
                slug: None,
                ok_id: Some("999888777".into()),
                duration: Some(DURATION),
                available: true,
                kind: None,
            },
        )
    })
    .unwrap();
    assert_eq!(t.svc.status(A).status, "none");
    assert_eq!(t.svc.enqueue_recent(None, None), 1);
    let s = t.svc.status(A);
    assert_eq!((s.status, s.position), ("queued", Some(1)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_periodique_piste_d_un_ancien_modele_refaite() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    t.svc.set_runner(Some(pending_runner()));
    no_video(&t.db, C);
    full_track(&t.db, B, DEFAULT_TRANSLATE_MODEL);
    full_track(&t.db, A, "ancien-modele");
    assert_eq!(t.svc.enqueue_recent(None, None), 1); // A seulement (B à jour)
    assert_eq!(t.svc.status(A).status, "running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ouverture_de_la_fiche_et_backoff() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    t.svc.set_runner(Some(Arc::new(|_, _, _, _| {
        Box::pin(async { Ok(CommentaryOutcome::failed(FailureKind::Erreur, "boum")) })
    })));
    t.svc.prioritize_on_view(A);
    t.svc.idle().await;
    assert_eq!(t.svc.record(A).unwrap().failures, Some(1.0));
    // Échec récent : pas relancé à chaque affichage.
    t.svc.prioritize_on_view(A);
    assert_eq!(t.svc.status(A).status, "failed");
    // Match sans replay, ou prêt : rien.
    no_video(&t.db, B);
    t.svc.prioritize_on_view(B);
    full_track(&t.db, C, DEFAULT_TRANSLATE_MODEL);
    t.svc.prioritize_on_view(C);
    assert_eq!(t.svc.activity().queued, Vec::<i64>::new());
    assert_eq!(t.svc.running_match_id(), None);
}

// ------------------------------------------------------------------ crochets du doublage, garde-fou

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crochet_gpu_le_travail_attend_la_liberation() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    let g = Gated::default();
    t.svc.set_runner(Some(g.runner(false, None)));
    let released = Arc::new(tokio::sync::Notify::new());
    let gate_calls = Arc::new(Mutex::new(0));
    let (r2, c2) = (released.clone(), gate_calls.clone());
    t.svc.set_gpu_gate(Some(Arc::new(move || {
        *c2.lock().unwrap() += 1;
        let r = r2.clone();
        Some(Box::pin(async move { r.notified().await }))
    })));
    t.svc.enqueue(A, EnqueueOptions::default());
    assert_eq!(*gate_calls.lock().unwrap(), 1); // appelé tout de suite, de façon synchrone
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(g.started().is_empty()); // le GPU n'est pas encore libéré
    assert_eq!(t.svc.status(A).status, "running");
    released.notify_one();
    wait_for("A démarre", || g.started() == vec![A]).await;
    // Rien à libérer : le travail part aussitôt.
    t.svc.set_gpu_gate(Some(Arc::new(|| None)));
    g.resolve(A, ok("ok"));
    t.svc.idle().await;
    t.svc.enqueue(B, EnqueueOptions::default());
    assert_eq!(g.started(), vec![A, B]);
    g.resolve(B, ok("ok"));
    t.svc.idle().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn garde_fou_un_travail_fige_est_interrompu() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_TIMEOUT_MS", "50");
    let aborted = Arc::new(Mutex::new(false));
    let a2 = aborted.clone();
    t.svc
        .set_runner(Some(Arc::new(move |_, _, signal: AbortSignal, _| {
            let a = a2.clone();
            Box::pin(async move {
                signal.aborted().await;
                *a.lock().unwrap() = true;
                std::future::pending().await
            })
        })));
    t.svc.enqueue(A, EnqueueOptions::default());
    t.svc.idle().await;
    unset_env("COMMENTARY_TIMEOUT_MS");
    let rec = t.svc.record(A).unwrap();
    assert_eq!(rec.kind, Some(FailureKind::Erreur));
    assert_eq!(
        rec.reason,
        "Traduction des commentaires impossible : délai dépassé (1 min)"
    );
    wait_for("signal levé", || *aborted.lock().unwrap()).await;
}

// ------------------------------------------------------------------ runCommentary (tests/commentary-queue.test.ts)

#[derive(Default, Debug, Clone)]
struct QCalls {
    extract: Vec<f64>,
    transcribe: Vec<String>,
    translate: usize,
}

/// `fakeDeps` de `tests/commentary-queue.test.ts` : une phrase par tronçon, 10 s après son début.
fn queue_fake(fail_extract: bool, fail_translate: bool) -> (CommentaryDeps, Arc<Mutex<QCalls>>) {
    let (mut deps, _) = fake_deps(Fake::default());
    let calls: Arc<Mutex<QCalls>> = Arc::default();
    let c1 = calls.clone();
    deps.extract = Arc::new(move |r| {
        c1.lock().unwrap().extract.push(r.start);
        Box::pin(async move {
            if fail_extract {
                return Err("ffmpeg audio @0s code 1: HTTP error 403 Forbidden".into());
            }
            std::fs::write(&r.out_file, vec![0u8; 4096]).map_err(|e| e.to_string())
        })
    });
    let c2 = calls.clone();
    let transcribe: TranscribeFn = Arc::new(move |file, _, _| {
        let name = std::path::Path::new(&file)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        c2.lock().unwrap().transcribe.push(name);
        let start: f64 = Regex::new(r"chunk-(\d+)-")
            .unwrap()
            .captures(&file)
            .unwrap()[1]
            .parse()
            .unwrap();
        let idx = [0.0, 597.0, 1197.0]
            .iter()
            .position(|s| *s == start)
            .map_or(-1, |i| i as i64);
        let text = format!("Play number {} is good.", idx + 1);
        let words: Vec<AsrWord> = text
            .split(' ')
            .enumerate()
            .map(|(i, w)| {
                AsrWord::new(
                    &format!(" {w}"),
                    10.0 + i as f64 * 0.3,
                    10.25 + i as f64 * 0.3,
                )
            })
            .collect();
        let seg = AsrSegment {
            avg_logprob: Some(-0.2),
            no_speech_prob: Some(0.02),
            compression_ratio: Some(1.1),
            ..AsrSegment::new(10.0, 12.0, &format!(" {text}"))
        };
        Box::pin(async move {
            Ok(Transcript {
                segments: vec![seg],
                words,
            })
        })
    });
    deps.transcribe = transcribe;
    let c3 = calls.clone();
    deps.translate = Arc::new(move |lines, _, _, _| {
        c3.lock().unwrap().translate += 1;
        let re = Regex::new(r"Play number (\d+) is good\.").unwrap();
        let res: Vec<TranslatedLine> = lines
            .iter()
            .map(|l| TranslatedLine {
                i: l.i,
                fr: re.replace(&l.en, "Action $1 réussie.").into_owned(),
                untranslated: false,
            })
            .collect();
        Box::pin(async move {
            if fail_translate {
                return Err(CommentaryError::Service(ServiceError {
                    message: "serveur de traduction injoignable".into(),
                    service: Service::Traduction,
                }));
            }
            Ok(res)
        })
    });
    deps.open_transcriber = None;
    deps.open_translator = None;
    (deps, calls)
}

async fn run(
    svc: &Commentary,
    id: i64,
    force: bool,
    deps: &CommentaryDeps,
    ctl: CommentaryControl,
) -> (
    Result<CommentaryOutcome, CommentaryError>,
    Vec<CommentaryProgress>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let e2 = events.clone();
    let r = svc
        .run_commentary(
            &Job::new(id, force),
            Arc::new(move |p| e2.lock().unwrap().push(p)),
            AbortSignal::new(),
            deps,
            &ctl,
        )
        .await;
    let ev = events.lock().unwrap().clone();
    (r, ev)
}

fn start_of(f: &str) -> f64 {
    Regex::new(r"chunk-(\d+)-").unwrap().captures(f).unwrap()[1]
        .parse()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extrait_transcrit_traduit_et_stocke() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (deps, calls) = queue_fake(false, false);
    let (r, events) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    let mut ex = calls.lock().unwrap().extract.clone();
    ex.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(ex, vec![0.0, 597.0, 1197.0]);
    let cues: Vec<(f64, String, String)> =
        t.db.with(|c| cdb::get_commentary_cues(c, A))
            .unwrap()
            .into_iter()
            .map(|c| (c.start_ts, c.text_en, c.text_fr))
            .collect();
    assert_eq!(
        cues,
        vec![
            (
                10.0,
                "Play number 1 is good.".into(),
                "Action 1 réussie.".into()
            ),
            (
                607.0,
                "Play number 2 is good.".into(),
                "Action 2 réussie.".into()
            ),
            (
                1207.0,
                "Play number 3 is good.".into(),
                "Action 3 réussie.".into()
            ),
        ]
    );
    let phases: Vec<String> = events
        .iter()
        .filter(|p| {
            matches!(
                p.phase,
                CommentaryPhase::Transcription | CommentaryPhase::Traduction
            )
        })
        .map(|p| format!("{} {}/{}", p.phase.as_str(), p.done, p.total))
        .collect();
    assert_eq!(
        phases,
        [
            "transcription 0/3",
            "traduction 0/3",
            "traduction 1/3",
            "transcription 1/3",
            "traduction 1/3",
            "traduction 2/3",
            "transcription 2/3",
            "traduction 2/3",
            "traduction 3/3"
        ]
    );
    assert!(!cm::work_dir(&ok_id(&t.db, A)).exists());
    assert_eq!(
        t.svc.status(A).to_json(),
        json!({ "status": "ready", "models": { "transcribe": WHISPER, "translate": DEFAULT_TRANSLATE_MODEL } })
    );
    let ready =
        t.db.with(|c| cdb::commentary_ready_ids(c, &[A, B, 12345]))
            .unwrap();
    assert_eq!(ready.into_iter().collect::<Vec<_>>(), vec![A]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reprise_apres_une_panne_de_traduction() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (first, c1) = queue_fake(false, true);
    let (r, _) = run(&t.svc, A, false, &first, CommentaryControl::run_to_end()).await;
    assert!(matches!(r, Err(CommentaryError::Service(_))));
    // Le tronçon 1 a été transcrit, sa traduction a échoué : rien n'est publié.
    let starts: Vec<f64> = c1
        .lock()
        .unwrap()
        .transcribe
        .iter()
        .map(|f| start_of(f))
        .collect();
    assert_eq!(starts, vec![0.0]);
    assert!(t
        .db
        .with(|c| cdb::get_commentary_cues(c, A))
        .unwrap()
        .is_empty());
    let (second, c2) = queue_fake(false, false);
    let (r, _) = run(&t.svc, A, false, &second, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    assert_eq!(c2.lock().unwrap().extract, vec![1197.0]); // tronçon 2 déjà téléchargé par anticipation
    let starts: Vec<f64> = c2
        .lock()
        .unwrap()
        .transcribe
        .iter()
        .map(|f| start_of(f))
        .collect();
    assert_eq!(starts, vec![597.0, 1197.0]);
    assert_eq!(
        t.db.with(|c| cdb::get_commentary_cues(c, A)).unwrap().len(),
        3
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flux_inaccessible_echec_reseau() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (deps, _) = queue_fake(true, false);
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    let o = r.unwrap();
    assert_eq!((o.ok, o.kind), (false, Some(FailureKind::Reseau)));
    let re = Regex::new(r"^Flux vidéo inaccessible : l'audio n'a pas pu être extrait \(tronçon 1/3 : .*403.*\)\..*~15 min\.$").unwrap();
    assert!(re.is_match(&o.reason), "{}", o.reason);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn noms_du_match_effectifs_entraineurs_et_parametres() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    t.db.with(|c| {
        basketland_server::settings::setting_set(
            c,
            "extra_names",
            Some("Kevin Ray\nEddie Johnson, Joker"),
        )
    })
    .unwrap();
    let (mut deps, _) = queue_fake(false, false);
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let a = asked.clone();
    deps.team_people = Some(Arc::new(move |abbr: String| {
        a.lock().unwrap().push(abbr.clone());
        Box::pin(async move {
            Ok(match abbr.as_str() {
                "LAL" => vec!["Khaman Maluach".to_string(), "Jordan Ott".to_string()],
                _ => vec!["David Adelman".to_string()],
            })
        })
    }));
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (inner, s2) = (deps.translate.clone(), seen.clone());
    deps.translate = Arc::new(move |lines, ctx, cfg, o| {
        if let Some(r) = &o.roster {
            *s2.lock().unwrap() = r.full.clone();
        }
        inner(lines, ctx, cfg, o)
    });
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    let names = seen.lock().unwrap().clone();
    for n in [
        "Khaman Maluach",
        "Jordan Ott",
        "David Adelman",
        "Kevin Ray",
        "Eddie Johnson",
        "Joker",
    ] {
        assert!(names.iter().any(|x| x == n), "{n} absent de {names:?}");
    }
    let first = asked.lock().unwrap().len();
    assert_eq!(first, 2);

    // Effectifs gardés en cache : pas de nouvel appel à ESPN pour une relance.
    let (r, _) = run(&t.svc, A, true, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.is_ok());
    assert_eq!(asked.lock().unwrap().len(), first);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn video_supprimee_echec_contenu() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (mut deps, calls) = queue_fake(false, false);
    deps.resolve_stream = Arc::new(|id, _| {
        Box::pin(async move {
            Err(format!(
                "{} (ok.ru/{id})",
                basketland_server::okru::DELETED_MSG
            ))
        })
    });
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    let o = r.unwrap();
    // Pas un problème réseau : pas de nouvel essai toutes les 15 min.
    assert_eq!((o.ok, o.kind), (false, Some(FailureKind::Contenu)));
    assert!(
        o.reason
            .starts_with("Vidéo supprimée ou introuvable sur ok.ru"),
        "{}",
        o.reason
    );
    assert!(calls.lock().unwrap().extract.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aucune_parole_echec_contenu() {
    let _g = LOCK.lock().await;
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (mut deps, _) = queue_fake(false, false);
    deps.transcribe = Arc::new(|_, _, _| {
        let mut seg = AsrSegment::new(1.0, 2.0, " Thank you.");
        seg.no_speech_prob = Some(0.9);
        seg.avg_logprob = Some(-1.5);
        Box::pin(async move {
            Ok(Transcript {
                segments: vec![seg],
                words: vec![],
            })
        })
    });
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    let o = r.unwrap();
    assert_eq!((o.ok, o.kind), (false, Some(FailureKind::Contenu)));
}

// ------------------------------------------------------------------ à la demande (tests/commentary-ondemand.test.ts)

const D: i64 = 402000001;
const OTHER: i64 = 402000002;

fn ondemand() -> T {
    let t = setup(&[D]);
    set_env("COMMENTARY_CHUNK_SEC", &CHUNK.to_string());
    t
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lecture_en_pause_pas_de_plafond_d_avance() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    let (deps, calls) = fake_deps(Fake::default());
    let ctl = CommentaryControl {
        keep_going: Arc::new(|| true),
        target: Arc::new(|| 0.0),
        watching: Some(Arc::new(|| true)),
        playing: Some(Arc::new(|| false)),
    };
    let (r, _) = run(&t.svc, D, false, &deps, ctl).await;
    assert!(r.unwrap().ok);
    assert_eq!(calls.lock().unwrap().transcribe, vec![0, 1, 2]);
    assert!(t.svc.ready(D));
}

/// Flux avec manifeste DASH (son seul) et `extract_dash` factice : réussit
/// (écrit le tronçon) ou échoue toujours ; rend les URL demandées.
fn with_dash(deps: &mut CommentaryDeps, ok: bool) -> Arc<Mutex<Vec<String>>> {
    let inner = deps.resolve_stream.clone();
    deps.resolve_stream = Arc::new(move |id, force| {
        let f = inner(id, force);
        Box::pin(async move {
            let mut s = f.await?;
            s.dash_url = Some("https://vd.okcdn.ru/?type=mpd".into());
            Ok(s)
        })
    });
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let a = asked.clone();
    deps.extract_dash = Some(Arc::new(move |r: cm::ExtractRequest| {
        a.lock().unwrap().push(r.source_url.clone());
        // Tronçon 0 servi un peu plus tard : l'audio du tronçon 1, préchargé en
        // parallèle, peut arriver avant lui (comme sur une machine lente).
        let slow = r.start == 0.0;
        Box::pin(async move {
            if slow {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            if !ok {
                return Err("aucune piste audio seule dans le manifeste".into());
            }
            std::fs::write(&r.out_file, vec![0u8; 4096]).map_err(|e| e.to_string())
        })
    }));
    asked
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn son_seul_dash_avant_le_flux_hls() {
    let _g = LOCK.lock().await;
    // Manifeste DASH annoncé : chaque tronçon vient du son seul, jamais du HLS.
    let t = ondemand();
    let (mut deps, calls) = fake_deps(Fake::default());
    let asked = with_dash(&mut deps, true);
    let (r, _) = run(&t.svc, D, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    assert!(calls.lock().unwrap().extract.is_empty());
    assert_eq!(asked.lock().unwrap().len(), 3);
    assert!(asked
        .lock()
        .unwrap()
        .iter()
        .all(|u| u.ends_with("type=mpd")));
    assert!(t.svc.ready(D));

    // Son seul en échec : flux HLS à la place, et plus d'essai après deux échecs.
    let t = ondemand();
    let (mut deps, calls) = fake_deps(Fake::default());
    let asked = with_dash(&mut deps, false);
    let (r, _) = run(&t.svc, D, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    // Chaque tronçon extrait une fois par le HLS ; l'ordre dépend du préchargement.
    let mut extracted = calls.lock().unwrap().extract.clone();
    extracted.sort_unstable();
    assert_eq!(extracted, vec![0, 1, 2]);
    // Deux échecs (tronçon 0 et tronçon 1 préchargé en même temps), puis plus d'essai.
    assert_eq!(asked.lock().unwrap().len(), 2);
    assert!(t.svc.ready(D));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn piste_complete_d_avant_rattrapage_par_la_file() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    let (deps, _) = fake_deps(Fake {
        untranslatable: Some(Regex::new("^Timeout").unwrap()),
        ..Default::default()
    });
    let (r, _) = run(&t.svc, D, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    // Piste publiée avant le rattrapage : aucune trace d'essai.
    t.db.with(|c| {
        basketland_server::db::kv_set(
            c,
            &format!("commentary-leftovers:{D}"),
            &json!({ "okId": "ancien", "model": "ancien" }),
        )
    })
    .unwrap();
    assert!(t.svc.leftovers_pending(D));

    let (mut fix, calls) = fake_deps(Fake::default());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (g2, inner) = (gate.clone(), fix.translate.clone());
    fix.translate = Arc::new(move |lines, ctx, cfg, o| {
        let (g, inner) = (g2.clone(), inner.clone());
        Box::pin(async move {
            let _p = g.acquire().await.unwrap();
            inner(lines, ctx, cfg, o).await
        })
    });
    t.svc.set_runner(Some(t.svc.runner_with(fix)));
    assert!(t.svc.enqueue(D, EnqueueOptions::default()).queued);
    assert_eq!(t.svc.status(D).status, "ready");
    gate.add_permits(10);
    t.svc.idle().await;
    let c = calls.lock().unwrap().clone();
    assert!(c.extract.is_empty());
    assert!(c.transcribe.is_empty());
    assert_eq!(c.events, ["ollama ouvert", "traduction 1", "ollama fermé"]);
    let tr =
        t.db.with(|c| cdb::get_commentary_track(c, D))
            .unwrap()
            .unwrap();
    assert_eq!((tr.complete, tr.untranslated), (1, 0));
    assert!(!t.svc.leftovers_pending(D));
    assert_eq!(
        t.svc.enqueue(D, EnqueueOptions::default()).message,
        "Traduction des commentaires déjà prête"
    );
    assert_eq!(t.svc.served_cues(D).len(), 6);
}

fn on_chunk(f: impl Fn(i64) + Send + Sync + 'static) -> Fake {
    Fake {
        after_chunk: Some(Arc::new(f)),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn match_regarde_depuis_la_position_pause_quand_la_fiche_se_ferme() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_NIGHT_WINDOW", "off");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    let clock = t.clock.clone();
    // La fiche se ferme : dernier signe de vie très ancien.
    let (deps, calls) = fake_deps(on_chunk(move |_| clock.advance_ms(10 * 60_000)));
    t.svc.set_runner(Some(t.svc.runner_with(deps)));
    // GET /subtitles?t=700 (touchViewer + nudge), puis POST /commentary { action: 'start' }.
    t.svc.touch_viewer(D, Some(700.0));
    t.svc.nudge(D);
    t.svc.touch_viewer(D, None);
    t.svc.prioritize_on_view(D);
    assert_eq!(t.svc.status(D).status, "running");
    t.svc.idle().await;
    assert_eq!(calls.lock().unwrap().transcribe, vec![1]);
    assert!(t.svc.record(D).is_none()); // ni échec ni succès
    let st = t.svc.status(D);
    assert_eq!(st.status, "none");
    assert_eq!(st.covered, Some(vec![[600.0, 1200.0]]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn travail_de_fond_cede_la_place_a_une_lecture_puis_reprend() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_NIGHT_WINDOW", "always");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    set_env("COMMENTARY_REPUMP_MS", "20");
    insert_match(&t.db, OTHER, Some(7480.0));
    let svc = t.svc.clone();
    let watched = Arc::new(Mutex::new(false));
    let (deps, calls) = fake_deps(on_chunk(move |idx| {
        // Pendant le 1er tronçon, quelqu'un se met à regarder un autre match.
        let mut w = watched.lock().unwrap();
        if idx == 0 && !*w {
            *w = true;
            svc.touch_viewer(OTHER, Some(10.0));
        }
    }));
    t.svc.set_runner(Some(t.svc.runner_with(deps)));
    t.svc.enqueue(D, EnqueueOptions::default()); // travail de fond
    wait_for("1er tronçon", || {
        calls.lock().unwrap().transcribe == vec![0]
    })
    .await;
    // En pause, remis en file : il attend la fin de la lecture.
    wait_for("en file", || t.svc.status(D).status == "queued").await;
    assert!(t.svc.record(D).is_none());
    // La lecture s'arrête (plus de signe de vie) : le travail reprend là où il s'était arrêté.
    t.clock.advance_ms(10 * 60_000);
    t.svc.idle().await;
    assert_eq!(calls.lock().unwrap().transcribe, vec![0, 1, 2]);
    assert_eq!(t.svc.status(D).status, "ready");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn demande_explicite_jusqu_au_bout_fiche_fermee_et_hors_fenetre() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_NIGHT_WINDOW", "off");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    set_env("COMMENTARY_REPUMP_MS", "20");
    set_env("COMMENTARY_MAX_LEAD_SEC", "99999");
    insert_match(&t.db, OTHER, Some(7480.0));
    let svc = t.svc.clone();
    let watched = Arc::new(Mutex::new(false));
    let (deps, calls) = fake_deps(on_chunk(move |idx| {
        let mut w = watched.lock().unwrap();
        if idx == 0 && !*w {
            *w = true;
            svc.touch_viewer(OTHER, Some(10.0));
        }
    }));
    t.svc.set_runner(Some(t.svc.runner_with(deps)));
    t.svc.enqueue(D, opts(true, false, true)); // personne ne regarde la fiche de D
    wait_for("1er tronçon", || {
        calls.lock().unwrap().transcribe == vec![0]
    })
    .await;
    // Cède la place à la lecture de l'autre match : remis en file, pas abandonné.
    wait_for("en file", || t.svc.status(D).status == "queued").await;
    t.clock.advance_ms(10 * 60_000);
    t.svc.idle().await;
    assert_eq!(calls.lock().unwrap().transcribe, vec![0, 1, 2]);
    assert_eq!(t.svc.status(D).status, "ready");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn travail_de_fond_hors_fenetre_rien_n_est_fait() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_NIGHT_WINDOW", "off");
    let (deps, calls) = fake_deps(Fake::default());
    t.svc.set_runner(Some(t.svc.runner_with(deps)));
    t.svc.enqueue(D, EnqueueOptions::default());
    t.svc.idle().await;
    assert!(calls.lock().unwrap().transcribe.is_empty());
    assert!(t.svc.record(D).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn travail_de_fond_dans_la_fenetre_tout_le_match() {
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_NIGHT_WINDOW", "always");
    set_env("COMMENTARY_MAX_LEAD_SEC", "99999");
    let (deps, calls) = fake_deps(Fake::default());
    t.svc.set_runner(Some(t.svc.runner_with(deps)));
    t.svc.touch_viewer(D, Some(0.0));
    t.svc.enqueue(D, EnqueueOptions::default());
    t.svc.idle().await;
    assert_eq!(calls.lock().unwrap().transcribe, vec![0, 1, 2]);
    assert_eq!(t.svc.status(D).status, "ready");
    // Réglage « Traduction automatique » désactivé : la fenêtre est fermée.
    t.db.with(|c| basketland_server::settings::setting_set(c, "auto_translate", Some("0")))
        .unwrap();
    assert!(!t.svc.in_night_window());
}

// ------------------------------------------------------------------ son complet (ffmpeg réel)

fn has_ffmpeg() -> bool {
    let ok = |b: &str| {
        std::process::Command::new(b)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    };
    ok("ffmpeg") && ok("ffprobe")
}

fn probe(f: &std::path::Path) -> f64 {
    let o = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(f)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn son_complet_reel_decoupe_pour_le_doublage_puis_efface() {
    if !has_ffmpeg() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let _g = LOCK.lock().await;
    let t = ondemand();
    let okd = ok_id(&t.db, D);
    // Pas encore de son complet : le doublage lira le flux.
    let out = t._dir.path().join("cut.ogg");
    assert!(
        !t.svc
            .slice_full_audio(&okd, 5.0, 8.0, &out.to_string_lossy(), None)
            .await
    );
    let src = t._dir.path().join("match.wav");
    let st = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=20:sample_rate=16000",
            "-ac",
            "1",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let full = cm::full_audio_file(&okd);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    basketland_server::media::audio::extract_full_audio(
        &src.to_string_lossy(),
        &full.to_string_lossy(),
        &Default::default(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        t.svc
            .slice_full_audio(&okd, 5.0, 8.0, &out.to_string_lossy(), None)
            .await
    );
    assert!((probe(&out) - 8.0).abs() < 0.5);
    assert!(t.svc.full_audio_state(&okd).unwrap().complete);
    t.svc.drop_full_audio(&okd);
    assert!(!full.exists());
    assert!(t.svc.full_audio_state(&okd).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn son_complet_reel_pendant_un_travail() {
    if !has_ffmpeg() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let _g = LOCK.lock().await;
    let t = ondemand();
    set_env("COMMENTARY_FULL_AUDIO_POLL_MS", "5");
    // Son complet : la voie sans téléchargement parallèle des segments.
    set_env("COMMENTARY_PARALLEL_FETCH", "0");
    set_env("COMMENTARY_CHUNK_SEC", "120"); // premier tronçon à moins de 10 min de l'extraction : on l'attend
    let src = t._dir.path().join("match.wav");
    let st = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=1300:sample_rate=16000",
            "-ac",
            "1",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    // Vraies extraction complète et découpe (ffmpeg), sur le fichier local.
    let video = basketland_server::video::Video::new();
    let real = CommentaryDeps::defaults(video);
    let (mut deps, calls) = fake_deps(Fake::default());
    let src_s = src.to_string_lossy().into_owned();
    deps.resolve_stream = Arc::new(move |_, _| {
        let url = src_s.clone();
        Box::pin(async move {
            Ok(cm::StreamInfo {
                dash_url: None,
                variants: vec![basketland_server::okru::Variant {
                    key: "low".into(),
                    bandwidth: 1.0,
                    resolution: String::new(),
                    url,
                }],
                mp4: vec![],
                duration: Some(DURATION),
            })
        })
    });
    deps.extract_full = real.extract_full.clone();
    deps.cut = real.cut.clone();
    t.svc.set_dub_wants_audio(Some(Arc::new(|_| true)));
    let (r, _) = run(&t.svc, D, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    assert!(calls.lock().unwrap().extract.is_empty()); // aucun tronçon lu dans le flux
    let dir = cm::work_dir(&ok_id(&t.db, D));
    let files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, vec!["full.ogg"]); // gardé pour le doublage
    assert!((probe(&dir.join("full.ogg")) - 1300.0).abs() < 1.0);
}

#[test]
fn appels_attendus_des_routes() {
    // Contrat public dont dépendent les routes et le doublage (compile seulement).
    fn _api(c: &Commentary) {
        let _: cm::CommentaryStatus = c.status(1);
        let _: Vec<cdb::CommentaryCueRow> = c.served_cues(1);
        let _: Value = c.activity().to_json();
        let _: Option<i64> = c.running_match_id();
        let _: Option<String> = c.disabled_reason();
        c.touch_viewer(1, Some(3.0));
        c.nudge(1);
        c.prioritize_on_view(1);
        let _: usize = c.enqueue_recent(None, None);
        let _: bool = c.ready(1);
        let _: Option<usize> = c.queue_position(1);
    }
    let _ = _api;
}

#[tokio::test]
async fn dossiers_de_travail_abandonnes_supprimes() {
    let _g = LOCK.lock().await;
    let _dir = env_setup();
    let (a, b) = (cm::work_dir("111"), cm::work_dir("222"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.parent().unwrap().join("fichier"), b"x").unwrap();
    // Récents : gardés (10 jours par défaut).
    assert_eq!(cm::prune_work_dirs(None, &[]), 0);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(cm::prune_work_dirs(Some(5.0), std::slice::from_ref(&b)), 1);
    assert!(!a.exists() && b.exists());
}

/// Garde-fou (la fenêtre de concurrence est trop courte pour être reproduite
/// à coup sûr ; le correctif se vérifie à la lecture d'`enqueue`).
/// Demandes concurrentes du même match (fils tokio en parallèle) : un seul
/// travail démarre, jamais de doublon en file derrière celui qui tourne —
/// même avec `force`, qui passe le contrôle « déjà prête ».
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn demandes_concurrentes_dedoublonnees() {
    let _g = LOCK.lock().await;
    for _ in 0..20 {
        let t = setup(&[A]);
        let g = Gated::default();
        t.svc.set_runner(Some(g.runner(false, None)));
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let svc = t.svc.clone();
                let b = barrier.clone();
                tokio::task::spawn_blocking(move || {
                    b.wait();
                    svc.enqueue(A, opts(true, true, false))
                })
            })
            .collect();
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(g.started(), vec![A], "un seul démarrage");
        assert_eq!(t.svc.queue_position(A), None, "aucun doublon en file");
        g.resolve(A, ok("ok"));
        t.svc.idle().await;
    }
}

// ------------------------------------------------------------------ recouvrement transcription / traduction

/// Faux transcripteur et traducteur lent, journal partagé des débuts et fins.
fn timed_fake(translate_ms: u64) -> (CommentaryDeps, Arc<Mutex<Vec<String>>>) {
    let (mut deps, _) = queue_fake(false, false);
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let (inner_t, l1) = (deps.transcribe.clone(), log.clone());
    deps.transcribe = Arc::new(move |file, prompt, signal| {
        l1.lock()
            .unwrap()
            .push(format!("transcription {}", start_of(&file)));
        inner_t(file, prompt, signal)
    });
    let (inner_m, l2) = (deps.translate.clone(), log.clone());
    deps.translate = Arc::new(move |lines, context, cfg, o| {
        let what = lines.first().map(|l| l.en.clone()).unwrap_or_default();
        l2.lock().unwrap().push(format!("début {what}"));
        let fut = inner_m(lines, context, cfg, o);
        let l = l2.clone();
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(translate_ms)).await;
            let r = fut.await;
            l.lock().unwrap().push(format!("fin {what}"));
            r
        })
    });
    (deps, log)
}

fn published(db: &Db) -> Vec<(f64, String, String)> {
    db.with(|c| cdb::get_commentary_cues(c, A))
        .unwrap()
        .into_iter()
        .map(|c| (c.start_ts, c.text_en, c.text_fr))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recouvrement_transcription_pendant_la_traduction() {
    let _g = LOCK.lock().await;
    // Référence : ordre de Node, un tronçon après l'autre.
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (deps, log) = timed_fake(150);
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    let sequential = published(&t.db);
    assert_eq!(
        log.lock().unwrap()[..4],
        [
            "transcription 0",
            "début Play number 1 is good.",
            "fin Play number 1 is good.",
            "transcription 597"
        ]
    );

    // Recouvrement : le tronçon suivant se transcrit pendant la traduction.
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    set_env("COMMENTARY_OVERLAP", "1");
    set_env("COMMENTARY_TRANSLATE_AHEAD", "1");
    let (deps, log) = timed_fake(150);
    let t0 = std::time::Instant::now();
    let (r, events) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    let elapsed = t0.elapsed();
    set_env("COMMENTARY_OVERLAP", "0");
    unset_env("COMMENTARY_TRANSLATE_AHEAD");
    assert!(r.unwrap().ok);
    let log = log.lock().unwrap().clone();
    let pos = |s: &str| {
        log.iter()
            .position(|x| x == s)
            .unwrap_or_else(|| panic!("{s} : {log:?}"))
    };
    assert!(
        pos("transcription 597") < pos("fin Play number 1 is good."),
        "{log:?}"
    );
    assert!(
        pos("transcription 1197") < pos("fin Play number 2 is good."),
        "{log:?}"
    );
    // Traductions toujours l'une après l'autre, dans l'ordre des tronçons.
    assert!(
        pos("fin Play number 1 is good.") < pos("début Play number 2 is good."),
        "{log:?}"
    );
    assert!(
        pos("fin Play number 2 is good.") < pos("début Play number 3 is good."),
        "{log:?}"
    );
    // Mêmes sous-titres publiés, piste complète, avancement jusqu'au bout.
    assert_eq!(published(&t.db), sequential);
    assert_eq!(t.svc.status(A).to_json()["status"], "ready");
    let last = events
        .iter()
        .rev()
        .find(|p| p.phase == CommentaryPhase::Traduction)
        .unwrap();
    assert_eq!((last.done, last.total), (3.0, 3.0));
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recouvrement_plusieurs_traductions_en_meme_temps() {
    let _g = LOCK.lock().await;
    // Référence : un tronçon après l'autre.
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    let (deps, _) = timed_fake(300);
    let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    assert!(r.unwrap().ok);
    let sequential = published(&t.db);

    // Trois tronçons traduits à la fois (défaut) : la traduction du tronçon 2
    // commence avant la fin de celle du tronçon 1, et ainsi de suite.
    let t = setup(&[A, B, C]);
    set_env("COMMENTARY_CHUNK_SEC", "600");
    set_env("COMMENTARY_OVERLAP", "1");
    let (deps, log) = timed_fake(300);
    let t0 = std::time::Instant::now();
    let (r, events) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
    let elapsed = t0.elapsed();
    set_env("COMMENTARY_OVERLAP", "0");
    assert!(r.unwrap().ok);
    let log = log.lock().unwrap().clone();
    let pos = |s: &str| {
        log.iter()
            .position(|x| x == s)
            .unwrap_or_else(|| panic!("{s} : {log:?}"))
    };
    assert!(
        pos("début Play number 2 is good.") < pos("fin Play number 1 is good."),
        "{log:?}"
    );
    assert!(
        pos("début Play number 3 is good.") < pos("fin Play number 2 is good."),
        "{log:?}"
    );
    // Mêmes sous-titres publiés, piste complète, avancement jusqu'au bout.
    assert_eq!(published(&t.db), sequential);
    assert_eq!(t.svc.status(A).to_json()["status"], "ready");
    let last = events
        .iter()
        .rev()
        .find(|p| p.phase == CommentaryPhase::Traduction)
        .unwrap();
    assert_eq!((last.done, last.total), (3.0, 3.0));
    // Le chevauchement est prouvé par l'ordre des débuts et fins ci-dessus ; la
    // durée n'est qu'indicative (une machine lente ne doit pas faire échouer).
    eprintln!("trois traductions de 300 ms en {elapsed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recouvrement_echec_de_traduction() {
    let _g = LOCK.lock().await;
    // Un tronçon traduit à la fois, puis trois (défaut).
    for (ahead, max_transcribed) in [("1", 2), ("3", 3)] {
        let t = setup(&[A, B, C]);
        set_env("COMMENTARY_CHUNK_SEC", "600");
        set_env("COMMENTARY_OVERLAP", "1");
        set_env("COMMENTARY_TRANSLATE_AHEAD", ahead);
        let (deps, calls) = queue_fake(false, true);
        let (r, _) = run(&t.svc, A, false, &deps, CommentaryControl::run_to_end()).await;
        set_env("COMMENTARY_OVERLAP", "0");
        unset_env("COMMENTARY_TRANSLATE_AHEAD");
        // L'échec de la traduction arrête le travail : rien de publié, au plus
        // les tronçons transcrits d'avance (leur résultat reste en cache).
        assert!(matches!(r, Err(CommentaryError::Service(_))), "{ahead}");
        assert!(published(&t.db).is_empty(), "{ahead}");
        let n = calls.lock().unwrap().transcribe.len();
        assert!((1..=max_transcribed).contains(&n), "{ahead} : {n}");
        assert_eq!(t.svc.status(A).to_json()["status"], "none");
    }
}
