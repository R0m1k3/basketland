//! File de doublage (étape 6b, non branchée) : portage des cas de file de
//! `tests/dub.test.ts` et des cas du doublage de `tests/vf-mode.test.ts`
//! (moteur de voix, extraction et montage simulés comme dans les tests de
//! Node ; les cas des routes y sont rejoués par les appels que font ces
//! routes), la traduction et le doublage branchés l'un sur l'autre par
//! leurs crochets (GPU rendu à une traduction qui démarre, son complet gardé
//! pour le doublage), et le montage par le vrai ffmpeg. Les fonctions pures
//! et les travaux complets sont comparés à Node dans `tests/dub_node.rs`.
//!
//! Un seul fil par test (`current_thread`), comme la boucle d'événements de
//! Node : un appel synchrone de la file n'est jamais entrelacé avec la fin
//! d'un travail.

#[path = "helpers/dub_kit.rs"]
mod dkit;
#[path = "helpers/commentary_kit.rs"]
mod kit;

use basketland_server::commentary_db as cdb;
use basketland_server::db::Db;
use basketland_server::dub_db as ddb;
use basketland_server::ingest_db::{set_video, VideoUpdate};
use basketland_server::media::abort::AbortSignal;
use basketland_server::media::commentary::{
    self as cm, Commentary, CommentaryOptions, CommentaryOutcome, EnqueueOptions, Job,
    Runner as CommentaryRunner,
};
use basketland_server::media::dub::{
    self as dub, AssembleClip, Dub, DubEngine, DubEnqueueOptions, DubJob, DubOptions, DubOutcome,
    DubProgress, DubRunner, LocalAudioFn,
};
use basketland_server::media::viewers::Viewers;
use basketland_server::settings::{keys, setting_set};
use dkit::*;
use kit::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct T {
    _dir: tempfile::TempDir,
    db: Db,
    cm: Commentary,
    dub: Dub,
    clock: TestClock,
    logs: Logs,
    track: cdb::CommentaryTrackMeta,
}

/// Comme `beforeEach` de `tests/dub.test.ts` : traduction des commentaires
/// non configurée (une demande de doublage ne la lance pas), sauf avec [`gpu_env`].
fn setup() -> T {
    let dir = dub_env();
    unset_env("TRANSCRIBE_URL");
    unset_env("TRANSLATE_URL");
    let db = fresh_db(dir.path());
    insert_match(&db, M, Some(400.0));
    insert_match(&db, M2, Some(400.0));
    let (deps, _, _) = fake(FakeOpts::default());
    let (cm, dub, clock, logs) = services(&db, deps);
    let track = track_meta(&db, M);
    T {
        _dir: dir,
        db,
        cm,
        dub,
        clock,
        logs,
        track,
    }
}

impl T {
    fn publish(&self, id: i64, idx: usize, ls: &[Line]) {
        let t = if id == M {
            self.track.clone()
        } else {
            track_meta(&self.db, id)
        };
        publish(&self.db, id, idx, ls, &t);
    }
    fn chunks(&self, id: i64) -> Vec<i64> {
        self.db
            .with(|c| ddb::get_dub_chunks(c, id))
            .unwrap()
            .iter()
            .map(|c| c.idx)
            .collect()
    }
    /// `viaQueue(deps)` : la file lance `runDub` avec ces dépendances.
    fn via_queue(&self, deps: dub::DubDeps) {
        self.dub.set_runner(Some(self.dub.runner_with(deps)));
    }
}

/// Serveurs de transcription et de traduction « configurés » (traduction active).
fn gpu_env() {
    set_env("TRANSCRIBE_URL", "http://gpu.local:8000/v1");
    set_env("TRANSLATE_URL", "http://gpu.local:11434/v1");
}

fn explicit() -> DubEnqueueOptions {
    DubEnqueueOptions {
        priority: false,
        explicit: true,
    }
}

fn prio_explicit() -> DubEnqueueOptions {
    DubEnqueueOptions {
        priority: true,
        explicit: true,
    }
}

fn c_prio() -> EnqueueOptions {
    EnqueueOptions {
        priority: true,
        ..Default::default()
    }
}

fn c0() -> Vec<Line> {
    chunk_lines("CHUNK0")
}
fn c1() -> Vec<Line> {
    chunk_lines("CHUNK1")
}
fn c2() -> Vec<Line> {
    chunk_lines("CHUNK2")
}

/// Porte : un `Notify` avec mémoire (`open()` avant `wait()` : déjà ouverte).
#[derive(Clone, Default)]
struct Gate(Arc<(AtomicBool, tokio::sync::Notify)>);

impl Gate {
    fn open(&self) {
        self.0 .0.store(true, Ordering::SeqCst);
        self.0 .1.notify_waiters();
    }
    async fn wait(&self) {
        loop {
            let n = self.0 .1.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if self.0 .0.load(Ordering::SeqCst) {
                return;
            }
            n.await;
        }
    }
}

/// Traduction simulée : attend la porte, puis réussit.
fn commentary_gated(g: &Gate) -> CommentaryRunner {
    let g = g.clone();
    Arc::new(move |_job, _p, _s, _c| {
        let g = g.clone();
        Box::pin(async move {
            g.wait().await;
            Ok(CommentaryOutcome::ok("ok"))
        })
    })
}

fn has_ffmpeg() -> bool {
    ["ffmpeg", "ffprobe"].iter().all(|b| {
        std::process::Command::new(b)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    })
}

// ------------------------------------------------------------------ GPU partagé avec la traduction

#[tokio::test(flavor = "current_thread")]
async fn une_traduction_qui_demarre_fait_ceder_le_doublage_qui_reprend_apres() {
    let _g = LOCK.lock().await;
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "10");
    t.publish(M, 0, &c0());
    t.publish(M, 1, &c1());
    let gate = Gate::default();
    t.cm.set_runner(Some(commentary_gated(&gate)));
    let cm2 = t.cm.clone();
    let started = Arc::new(AtomicBool::new(false));
    let (deps, calls, _) = fake(FakeOpts {
        // Pendant la 2e réplique, quelqu'un lance la traduction d'un autre match.
        on_synth: Some(Arc::new(move |k, _| {
            if k == 2 && !started.swap(true, Ordering::SeqCst) {
                cm2.enqueue(M2, c_prio());
            }
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    assert!(t.dub.enqueue(M, explicit()).started);
    wait_for("en attente du GPU", || {
        let m = t.dub.manifest(M);
        m.status == "waiting" && m.reason.as_deref().is_some_and(|r| r.contains("GPU"))
    })
    .await;
    assert_eq!(calls.lock().unwrap().closed, 1);
    assert_eq!(calls.lock().unwrap().synth.len(), 2);
    assert!(t.chunks(M).is_empty());
    assert!(t.dub.activity().waiting_for_gpu);
    assert_eq!(t.dub.record(M), None); // ni échec ni succès
    gate.open();
    wait_for("2 tronçons doublés", || t.chunks(M).len() == 2).await;
    t.dub.idle().await;
    assert_eq!(calls.lock().unwrap().opened, 2);
    assert!(t.dub.record(M).unwrap().ok);
    let logs = t.logs.lock().unwrap().clone();
    assert!(logs.iter().any(|(_, l)| l
        == &format!("[doublage] match {M} en pause : une traduction a besoin de la carte graphique ; reprise ensuite")));
}

#[tokio::test(flavor = "current_thread")]
async fn une_traduction_ne_demarre_qu_une_fois_la_carte_rendue() {
    let _g = LOCK.lock().await;
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "20");
    t.publish(M, 0, &c0());
    let runs = Arc::new(AtomicUsize::new(0));
    let aborted = Arc::new(AtomicBool::new(false));
    let (r2, a2) = (runs.clone(), aborted.clone());
    let runner: DubRunner = Arc::new(move |_job, _p, signal: AbortSignal, _c| {
        let (r, a) = (r2.clone(), a2.clone());
        Box::pin(async move {
            if r.fetch_add(1, Ordering::SeqCst) > 0 {
                return Ok(DubOutcome::ok("repris"));
            }
            // Réplique en cours de synthèse : ne rend la main que sur interruption.
            signal.aborted().await;
            a.store(true, Ordering::SeqCst);
            Ok(DubOutcome::failed(
                dub::DubFailureKind::Erreur,
                "interrompu",
            ))
        })
    });
    t.dub.set_runner(Some(runner));
    assert!(t.dub.release_gpu_for_translation(None).is_none()); // rien ne tourne : pas d'attente
    t.dub.enqueue(M, explicit());
    let seen: Arc<Mutex<Option<bool>>> = Arc::default();
    let (s2, a3) = (seen.clone(), aborted.clone());
    t.cm.set_runner(Some(Arc::new(move |_j, _p, _s, _c| {
        *s2.lock().unwrap() = Some(a3.load(Ordering::SeqCst));
        Box::pin(async { Ok(CommentaryOutcome::ok("ok")) })
    })));
    t.cm.enqueue(M, c_prio());
    wait_for("traduction démarrée", || seen.lock().unwrap().is_some()).await;
    // La traduction n'a démarré qu'une fois le doublage interrompu (carte libérée).
    assert_eq!(*seen.lock().unwrap(), Some(true));
    assert_eq!(t.dub.record(M), None); // ni échec ni succès compté
    wait_for("repris après la traduction", || {
        runs.load(Ordering::SeqCst) == 2
    })
    .await;
    t.dub.idle().await;
    assert_eq!(t.dub.queue_position(M), None);
}

#[tokio::test(flavor = "current_thread")]
async fn synthese_en_ligne_le_doublage_tourne_pendant_une_traduction() {
    let _g = LOCK.lock().await;
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "10");
    t.publish(M, 0, &c0());
    let gate = Gate::default();
    t.cm.set_runner(Some(commentary_gated(&gate)));
    t.dub.set_engine(Some(DubEngine {
        uses_gpu: Some(Arc::new(|| false)),
        ..fake_engine(None)
    }));
    let released = Arc::new(Mutex::new(Vec::<bool>::new()));
    let (r2, d2) = (released.clone(), t.dub.clone());
    let (deps, calls, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |_, _| {
            r2.lock()
                .unwrap()
                .push(d2.release_gpu_for_translation(None).is_none())
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    t.cm.enqueue(M2, c_prio()); // la traduction d'un autre match tient le GPU
    assert!(t.dub.enqueue(M, explicit()).started);
    t.dub.idle().await;
    assert_eq!(t.chunks(M), vec![0]);
    assert_eq!(calls.lock().unwrap().closed, 1);
    let r = released.lock().unwrap().clone();
    assert!(!r.is_empty() && r.iter().all(|x| *x)); // rien à rendre : la traduction démarre aussitôt
    gate.open();
    t.cm.idle().await;
}

#[tokio::test(flavor = "current_thread")]
async fn synthese_en_ligne_le_doublage_suit_la_traduction_troncon_par_troncon() {
    let _g = LOCK.lock().await;
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "10");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    t.cm.touch_viewer(M, Some(0.0)); // on regarde le match depuis le début
    let (g1, g2) = (Gate::default(), Gate::default());
    let (db, tr) = (t.db.clone(), t.track.clone());
    let (h1, h2) = (g1.clone(), g2.clone());
    // La traduction du match publie ses tronçons au fil de l'eau.
    t.cm.set_runner(Some(Arc::new(move |_j, _p, _s, _c| {
        let (db, tr, h1, h2) = (db.clone(), tr.clone(), h1.clone(), h2.clone());
        Box::pin(async move {
            publish(&db, M, 0, &c0(), &tr);
            h1.wait().await;
            publish(&db, M, 1, &c1(), &tr);
            h2.wait().await;
            publish(&db, M, 2, &c2(), &tr);
            Ok(CommentaryOutcome::ok("ok"))
        })
    })));
    t.dub.set_engine(Some(DubEngine {
        uses_gpu: Some(Arc::new(|| false)),
        ..fake_engine(None)
    }));
    let (deps, _, _) = fake(FakeOpts::default());
    t.via_queue(deps);
    t.cm.enqueue(
        M,
        EnqueueOptions {
            priority: true,
            explicit: true,
            force: false,
        },
    );
    wait_for("1er tronçon traduit", || {
        t.db.with(|c| cdb::get_commentary_chunks(c, M))
            .unwrap()
            .len()
            == 1
    })
    .await;
    t.dub.enqueue(M, prio_explicit()); // « Doubler ce match » pendant la traduction
    wait_for("début doublé", || t.chunks(M) == vec![0]).await;
    assert_eq!(t.dub.manifest(M).chunks.len(), 1);
    g1.open();
    wait_for("2 tronçons", || t.chunks(M) == vec![0, 1]).await;
    g2.open();
    wait_for("3 tronçons", || t.chunks(M).len() == 3).await;
    t.dub.idle().await;
}

#[tokio::test(flavor = "current_thread")]
async fn gpu_pris_le_telechargement_des_voix_part_quand_meme() {
    let _g = LOCK.lock().await;
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "10");
    t.publish(M, 0, &c0());
    let gate = Gate::default();
    t.cm.set_runner(Some(commentary_gated(&gate)));
    let prepared = Arc::new(AtomicUsize::new(0));
    let downloading: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(Some((1.1e9, 2.5e9))));
    let (p2, d2) = (prepared.clone(), downloading.clone());
    let (_, _, session) = fake(FakeOpts::default());
    t.dub.set_engine(Some(DubEngine {
        prepare: Some(Arc::new(move || {
            p2.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        })),
        download: Some(Arc::new(move || *d2.lock().unwrap())),
        ..fake_engine(Some(session))
    }));
    let (deps, _, _) = fake(FakeOpts::default());
    t.via_queue(deps);
    t.cm.enqueue(M2, c_prio());
    t.dub.enqueue(M, explicit());
    assert_eq!(prepared.load(Ordering::SeqCst), 0); // chargement différé du moteur
    wait_for("téléchargement lancé", || {
        prepared.load(Ordering::SeqCst) == 1
    })
    .await;
    let m = t.dub.manifest(M);
    assert_eq!(m.status, "waiting");
    assert_eq!(
        m.reason.as_deref(),
        Some("en attente du GPU : la traduction d’un autre match passe d’abord, le doublage reprend ensuite")
    );
    assert_eq!(
        m.step.as_deref(),
        Some("téléchargement des voix (premier usage, une seule fois) : 44 % · 1,1 / 2,5 Go")
    );
    *downloading.lock().unwrap() = None;
    assert_eq!(t.dub.manifest(M).step, None);
    gate.open();
    wait_for("doublé", || t.chunks(M).len() == 1).await;
    t.dub.idle().await;
}

// ------------------------------------------------------------------ priorité à la lecture

#[tokio::test(flavor = "current_thread")]
async fn doublage_demande_s_efface_quand_un_autre_match_est_regarde() {
    let _g = LOCK.lock().await;
    let t = setup();
    set_env("DUB_REPUMP_MS", "10");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    t.publish(M, 0, &c0());
    t.publish(M, 1, &c1());
    let cm2 = t.cm.clone();
    let (deps, calls, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |k, _| {
            if k == 2 {
                cm2.touch_viewer(M2, Some(10.0));
            }
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    t.dub.enqueue(M, explicit());
    wait_for("en attente", || t.dub.manifest(M).status == "waiting").await;
    assert_eq!(calls.lock().unwrap().closed, 1);
    assert!(t.chunks(M).is_empty());
    t.clock.advance_ms(10 * 60_000); // la lecture s'arrête
    t.dub.idle().await;
    assert_eq!(t.chunks(M).len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn match_regarde_passe_devant_depuis_la_position_du_spectateur() {
    let _g = LOCK.lock().await;
    let t = setup();
    set_env("DUB_REPUMP_MS", "10");
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    t.publish(M, 0, &c0());
    t.publish(M2, 0, &c0());
    t.publish(M2, 1, &c1());
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let opened = Arc::new(AtomicBool::new(false));
    let (o2, cm2, d2) = (order.clone(), t.cm.clone(), t.dub.clone());
    let (deps, _, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |_, text| {
            o2.lock().unwrap().push(text.to_string());
            if !opened.swap(true, Ordering::SeqCst) {
                cm2.touch_viewer(M2, Some(130.0));
                d2.enqueue(M2, prio_explicit()); // « Doubler ce match » sur la fiche regardée
            }
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    t.dub.enqueue(M, explicit());
    wait_for("M2 doublé", || t.chunks(M2).len() == 2).await;
    // M2 depuis la position du spectateur (tronçon 1), puis le tronçon 0.
    assert_eq!(order.lock().unwrap()[1], "Retour au jeu.");
    assert!(t.chunks(M).is_empty());
    assert_eq!(t.dub.manifest(M).status, "waiting"); // attend la fin de la lecture
    t.clock.advance_ms(10 * 60_000);
    t.dub.idle().await;
    assert_eq!(t.chunks(M).len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn pas_de_doublage_de_fond_ni_demande_ni_regarde() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    let (deps, _, _) = fake(FakeOpts::default());
    t.via_queue(deps);
    let r = t.dub.enqueue(M, DubEnqueueOptions::default());
    assert!(!r.queued);
    assert_eq!(r.message, "Doublage abandonné : ni demandé ni regardé");
    t.dub.prioritize_on_view(M); // pas demandé : regarder le match ne le lance pas
    t.dub.idle().await;
    assert!(t.chunks(M).is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn activite_le_doublage_en_cours_et_son_avancement() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    let gate = Gate::default();
    let g2 = gate.clone();
    t.dub.set_runner(Some(Arc::new(
        move |_job, progress: dub::DubProgressFn, _s, _c| {
            progress(DubProgress {
                done: 1.0,
                total: 3.0,
                chunk: Some(1),
                step: None,
            });
            let g = g2.clone();
            Box::pin(async move {
                g.wait().await;
                Ok(DubOutcome::ok("ok"))
            })
        },
    )));
    t.dub.enqueue(M, explicit());
    // Panneau d'activité (activity.ts, porté avec les routes) : « Doublage en français », 33 %.
    let a = t.dub.activity();
    let r = a.running.unwrap();
    assert_eq!(
        (r.match_id, r.done, r.total, r.watched),
        (M, 1.0, 3.0, false)
    );
    assert_eq!(kit_round(r.done / r.total * 100.0), 33.0);
    gate.open();
    t.dub.idle().await;
}

fn kit_round(x: f64) -> f64 {
    basketland_server::js::round(x)
}

#[tokio::test(flavor = "current_thread")]
async fn pendant_le_travail_l_etape_en_cours_est_dans_le_manifeste() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    let steps = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let (s2, d2) = (steps.clone(), t.dub.clone());
    let (deps, _, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |_, _| {
            s2.lock().unwrap().push(d2.manifest(M).step)
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    t.dub.enqueue(M, explicit());
    t.dub.idle().await;
    let s = steps.lock().unwrap().clone();
    let n = s.len();
    assert_eq!(
        s[0].as_deref(),
        Some(&*format!("synthèse des répliques : 1 / {n}"))
    );
    assert_eq!(
        s[n - 1].as_deref(),
        Some(&*format!("synthèse des répliques : {n} / {n}"))
    );
    assert_eq!(t.chunks(M).len(), 1);
}

// ------------------------------------------------------------------ base

#[tokio::test(flavor = "current_thread")]
async fn un_troncon_retraduit_perd_son_doublage() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    let tr =
        t.db.with(|c| cdb::get_commentary_track(c, M))
            .unwrap()
            .unwrap();
    t.db.with(|c| ddb::open_dub_track(c, M, "ok1", &cdb::commentary_key(&tr)))
        .unwrap();
    let input = ddb::DubChunkInput {
        idx: 0,
        start: 0.0,
        end: 120.0,
        file: "chunk-0.m4a".into(),
        speech_json: "[]".into(),
        cues_sig: "a".into(),
    };
    t.db.with(|c| ddb::publish_dub_chunk(c, M, &input, "[\"A\"]", "{}"))
        .unwrap();
    t.db.with(|c| ddb::set_dub_complete(c, M, true)).unwrap();
    assert_eq!(t.chunks(M).len(), 1);
    t.publish(M, 0, &c0()); // retraduit (« Relancer la traduction »)
    assert!(t.chunks(M).is_empty());
    assert_eq!(t.dub.chunk_path(M, 0), None);
    let d = t.db.with(|c| ddb::get_dub_track(c, M)).unwrap().unwrap();
    assert_eq!(d.complete, 0);
}

// ------------------------------------------------------------------ arrêt

#[tokio::test(flavor = "current_thread")]
async fn arret_pendant_le_doublage_ce_qui_est_double_reste_puis_reprise() {
    let _g = LOCK.lock().await;
    let t = setup();
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    t.publish(M, 0, &c0());
    t.publish(M, 1, &c1());
    // Arrêt au milieu du 2e tronçon (le 1er est déjà publié).
    let stop = Arc::new(Mutex::new(None));
    let (s2, d2) = (stop.clone(), t.dub.clone());
    let n0 = c0().len();
    let (deps, _, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |k, _| {
            if k == n0 + 1 {
                *s2.lock().unwrap() = Some(d2.stop(M));
            }
        })),
        ..Default::default()
    });
    t.via_queue(deps);
    t.cm.touch_viewer(M, Some(0.0));
    assert!(t.dub.request(M, false).started);
    t.dub.idle().await;
    let s = stop.lock().unwrap().clone().unwrap();
    assert!(s.stopped && s.message.contains("arrêté"));
    assert_eq!(t.chunks(M).len(), 1);
    let m = t.dub.manifest(M);
    assert_eq!(
        (m.status, m.reason.as_deref(), m.stopped),
        ("partial", Some("doublage arrêté"), true)
    );
    let rec = t.dub.record(M).unwrap();
    assert!(rec.ok && rec.failures == Some(0.0) && rec.stopped);
    assert_eq!(t.dub.activity().running, None);
    // Regarder le match ne le relance pas.
    t.dub.prioritize_on_view(M);
    assert_eq!(t.dub.queue_position(M), None);
    assert_eq!(t.dub.manifest(M).status, "partial");
    // « Reprendre le doublage » : il repart et finit.
    assert!(t.dub.request(M, false).started);
    assert!(!t.dub.record(M).unwrap().stopped);
    t.dub.idle().await;
    assert_eq!(t.chunks(M).len(), 2);
    assert_ne!(t.dub.manifest(M).status, "running");
    assert!(!t.dub.manifest(M).stopped);
}

#[tokio::test(flavor = "current_thread")]
async fn arret_en_file_retire_de_la_file_rien_a_arreter_sans_effet() {
    let _g = LOCK.lock().await;
    let t = setup();
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    t.publish(M, 0, &c0());
    t.publish(M2, 0, &c0());
    let gate = Gate::default();
    let g2 = gate.clone();
    t.dub.set_runner(Some(Arc::new(move |_j, _p, _s, _c| {
        let g = g2.clone();
        Box::pin(async move {
            g.wait().await;
            Ok(DubOutcome::ok("ok"))
        })
    })));
    let r = t.dub.stop(M2);
    assert!(!r.stopped);
    assert_eq!(r.message, "Aucun doublage en cours pour ce match");
    t.dub.enqueue(M, explicit());
    t.dub.enqueue(M2, explicit());
    assert_eq!(t.dub.queue_position(M2), Some(1));
    assert!(t.dub.stop(M2).stopped);
    assert_eq!(t.dub.queue_position(M2), None);
    let m = t.dub.manifest(M2);
    assert_eq!((m.status, m.stopped), ("none", true));
    assert_eq!(t.dub.manifest(M).status, "running"); // l'autre match continue
    gate.open();
    t.dub.idle().await;
    assert!(t.dub.record(M).unwrap().ok);
}

#[tokio::test(flavor = "current_thread")]
async fn arret_d_un_travail_en_cours_ni_succes_ni_echec() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    let gate = Gate::default();
    let g2 = gate.clone();
    t.dub
        .set_runner(Some(Arc::new(move |_j, _p, signal: AbortSignal, _c| {
            let g = g2.clone();
            Box::pin(async move {
                tokio::select! { _ = g.wait() => {}, _ = signal.aborted() => {} }
                Ok(DubOutcome::ok("ok"))
            })
        })));
    t.dub.enqueue(M, explicit());
    // Ce que fait POST /dub { action: 'stop' } : arrêt, puis manifeste et message.
    let r = t.dub.stop(M);
    let m = t.dub.manifest(M);
    assert_eq!((m.status, m.stopped), ("none", true));
    assert!(r.message.contains("arrêté"));
    gate.open();
    t.dub.idle().await;
    let rec = t.dub.record(M).unwrap();
    assert!(rec.ok && rec.stopped); // l'arrêt n'est pas compté comme un succès ou un échec
}

// ------------------------------------------------------------------ manifeste

#[tokio::test(flavor = "current_thread")]
async fn manifeste_inactif_puis_echec_sans_troncon() {
    let _g = LOCK.lock().await;
    let t = setup();
    set_env("DUB_DISABLED", "1");
    t.publish(M, 0, &c0());
    let m = t.dub.manifest(M).to_json();
    assert_eq!(
        m.to_string(),
        r#"{"status":"disabled","reason":"doublage désactivé (DUB_DISABLED=1)","chunks":[],"voices":{}}"#
    );
    assert_eq!(t.dub.activity().running, None);
    unset_env("DUB_DISABLED");
    let (deps, _, _) = fake(FakeOpts {
        fail_open: true,
        ..Default::default()
    });
    t.via_queue(deps);
    t.dub.enqueue(M, explicit());
    t.dub.idle().await;
    let m = t.dub.manifest(M);
    assert_eq!(m.status, "failed");
    assert!(m.reason.unwrap().contains("Moteur de voix indisponible"));
    let rec = t.dub.record(M).unwrap();
    assert_eq!(
        (rec.kind.as_deref(), rec.failures, rec.net_failures),
        (Some("service"), Some(0.0), Some(1.0))
    );
    // Moteur mal configuré : la raison est dite.
    t.dub.set_engine(Some(DubEngine {
        config: Arc::new(|| Err("TTS_DEVICE\ninconnu".into())),
        ..fake_engine(None)
    }));
    assert_eq!(
        t.dub.disabled_reason().as_deref(),
        Some("moteur de voix mal configuré : TTS_DEVICE inconnu")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn manifeste_audio_servi_depuis_le_dossier_du_doublage() {
    let _g = LOCK.lock().await;
    let t = setup();
    t.publish(M, 0, &c0());
    t.publish(M, 1, &c1());
    let (deps, _, _) = fake(FakeOpts::default());
    t.via_queue(deps);
    // Sans demande, pas d'effet de bord (GET sans ?t=) ; avec ?t=, regarder ne lance pas le doublage.
    assert_eq!(t.dub.manifest(M).status, "none");
    t.cm.touch_viewer(M, Some(10.0));
    t.dub.prioritize_on_view(M);
    assert_eq!(t.dub.manifest(M).status, "none");
    assert!(t.dub.enqueue(M, explicit()).started);
    t.dub.idle().await;
    let m = t.dub.manifest(M);
    assert_eq!(m.status, "partial");
    let j = m.to_json();
    assert_eq!(
        j["voices"].to_string(),
        r#"{"A":"Commentateur","B4":"Consultant","B1":"Troisième voix"}"#
    );
    let keys: Vec<&String> = j.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["status", "chunks", "voices"]);
    let re = regex::Regex::new(&format!(r"^/api/matches/{M}/dub/0\?v=\d+$")).unwrap();
    assert!(re.is_match(&m.chunks[0].url), "{}", m.chunks[0].url);
    let file = t.dub.chunk_path(M, 0).unwrap();
    assert_eq!(file, dub::dub_dir(M).join("chunk-0.m4a"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "m4a:6:120.00");
    assert_eq!(t.dub.chunk_path(M, 5), None);
}

// ------------------------------------------------------------------ son complet partagé

#[tokio::test(flavor = "current_thread")]
async fn son_complet_garde_pour_le_doublage_puis_efface_par_lui() {
    let _g = LOCK.lock().await;
    let dir = dub_env();
    set_env("COMMENTARY_CHUNK_SEC", "600");
    set_env("COMMENTARY_FULL_AUDIO_POLL_MS", "5");
    set_env("DUB_REPUMP_MS", "10");
    let db = fresh_db(dir.path());
    insert_match(&db, M, Some(DURATION));
    // Traduction : vraie `run_commentary` par la file, avec les faux
    // transcripteur et traducteur de ses tests, son complet « extrait » d'un coup.
    let (mut cdeps, _) = fake_deps(Fake::default());
    cdeps.extract_full = Some(Arc::new(|_url, out, _o, progress| {
        std::fs::write(&out, vec![0u8; 4096]).unwrap();
        Box::pin(async move {
            progress(DURATION);
            Ok(())
        })
    }));
    let cuts = Arc::new(Mutex::new(Vec::<f64>::new()));
    let c2 = cuts.clone();
    cdeps.cut = Some(Arc::new(move |file, start, _len, out, _sig| {
        if !std::path::Path::new(&file).exists() {
            return Box::pin(async move { Err(format!("{file} absent")) });
        }
        c2.lock().unwrap().push(start);
        Box::pin(async move { std::fs::write(&out, vec![0u8; 4096]).map_err(|e| e.to_string()) })
    }));
    let clock = TestClock::default();
    let ck = clock.clone();
    let viewers: &'static Viewers = Box::leak(Box::default());
    let c = Commentary::with_options(
        db.clone(),
        cdeps.clone(),
        CommentaryOptions {
            viewers,
            clock: Arc::new(move || ck.now()),
            ffmpeg_available: Arc::new(|| true),
        },
    );
    c.set_runner(Some(c.runner_with(cdeps)));
    let full = cm::full_audio_file(&ok_id(&db, M));
    // Doublage branché sur cette traduction ; son audio d'origine est découpé
    // dans le son complet par la traduction (`sliceFullAudio`).
    let kept = Arc::new(Mutex::new(Vec::<bool>::new()));
    let (k2, f2) = (kept.clone(), full.clone());
    let (mut deps, calls, _) = fake(FakeOpts {
        on_synth: Some(Arc::new(move |_, _| k2.lock().unwrap().push(f2.exists()))),
        ..Default::default()
    });
    let c3 = c.clone();
    let local: LocalAudioFn = Arc::new(move |ok, start, length, out, signal| {
        let c = c3.clone();
        Box::pin(async move {
            c.slice_full_audio(&ok, start, length, &out, Some(signal))
                .await
        })
    });
    deps.local_audio = Some(local);
    let d = Dub::with_options(
        c.clone(),
        deps.clone(),
        DubOptions {
            ffmpeg_available: Arc::new(|| true),
            log: Arc::new(|_, _| {}),
        },
    );
    d.set_engine(Some(fake_engine(None)));
    d.set_runner(Some(d.runner_with(deps)));
    // « Doubler ce match » : traduction d'abord, le doublage attend ses sous-titres.
    let r = d.request(M, false);
    assert_eq!(
        r.translation.as_deref(),
        Some("Traduction des commentaires lancée")
    );
    assert!(r.queued && !r.started);
    assert!(d.wants_audio(M));
    assert_eq!(
        d.manifest(M).reason.as_deref(),
        Some("traduction des commentaires en cours : le doublage suivra")
    );
    c.idle().await;
    assert!(c.ready(M));
    assert!(full.exists()); // gardé : le doublage est en file
    let translation_cuts = cuts.lock().unwrap().len();
    d.idle().await;
    // La traduction a gardé `full.ogg` pour le doublage, qui l'a découpé sans
    // relire le flux, puis effacé une fois le doublage complet.
    assert!(!kept.lock().unwrap().is_empty());
    assert!(kept.lock().unwrap().iter().all(|k| *k));
    assert!(calls.lock().unwrap().extract.is_empty());
    // Une découpe par tronçon pour le doublage.
    assert_eq!(cuts.lock().unwrap().len(), translation_cuts + 3);
    let dt = db.with(|x| ddb::get_dub_track(x, M)).unwrap().unwrap();
    assert_eq!(dt.complete, 1);
    assert!(!full.exists());
    assert_eq!(d.manifest(M).status, "ready");
    drop(dir);
}

// ------------------------------------------------------------------ réglage « Version française » et demande explicite

/// Doublage simulé de `tests/vf-mode.test.ts` : chaque tronçon traduit pas
/// encore doublé est publié ; complet quand la piste traduite l'est.
#[derive(Clone, Default)]
struct Runs(Arc<Mutex<Vec<Run>>>);

/// Un passage : match, tronçons doublés, demande explicite.
type Run = (i64, Vec<i64>, bool);

impl Runs {
    fn get(&self) -> Vec<Run> {
        self.0.lock().unwrap().clone()
    }
}

fn fake_dub(
    db: &Db,
    during: Option<Arc<dyn Fn(i64) -> Option<Gate> + Send + Sync>>,
) -> (DubRunner, Runs) {
    let runs = Runs::default();
    let (db, r2) = (db.clone(), runs.clone());
    let runner: DubRunner = Arc::new(move |job: DubJob, _p, _s, _c| {
        let (db, runs) = (db.clone(), r2.clone());
        let wait = during.as_ref().and_then(|f| f(job.match_id));
        Box::pin(async move {
            if let Some(g) = wait {
                g.wait().await;
            }
            let id = job.match_id;
            let track = db
                .with(|c| cdb::get_commentary_track(c, id))
                .unwrap()
                .unwrap();
            db.with(|c| ddb::open_dub_track(c, id, &track.ok_id, &cdb::commentary_key(&track)))
                .unwrap();
            let todo: Vec<cdb::CommentaryChunkRow> = db
                .with(|c| cdb::get_commentary_chunks(c, id))
                .unwrap()
                .into_iter()
                .filter(|c| {
                    db.with(|x| ddb::get_dub_chunk(x, id, c.idx))
                        .unwrap()
                        .is_none()
                })
                .collect();
            for c in &todo {
                let input = ddb::DubChunkInput {
                    idx: c.idx,
                    start: c.keep_from,
                    end: c.keep_to,
                    file: format!("chunk-{}.m4a", c.idx),
                    speech_json: "[]".into(),
                    cues_sig: "x".into(),
                };
                db.with(|x| ddb::publish_dub_chunk(x, id, &input, "[\"A\"]", "{}"))
                    .unwrap();
            }
            let complete = db
                .with(|c| cdb::get_commentary_track(c, id))
                .unwrap()
                .unwrap()
                .complete
                == 1;
            db.with(|c| ddb::set_dub_complete(c, id, complete)).unwrap();
            runs.0
                .lock()
                .unwrap()
                .push((id, todo.iter().map(|c| c.idx).collect(), job.explicit()));
            Ok(DubOutcome::ok(format!(
                "{} tronçon(s) doublé(s)",
                todo.len()
            )))
        })
    });
    (runner, runs)
}

/// Piste de 2 tronçons de `tests/vf-mode.test.ts` (le 2e la rend complète).
fn vf_track(db: &Db, id: i64) -> cdb::CommentaryTrackMeta {
    cdb::CommentaryTrackMeta {
        chunks_total: Some(2.0),
        ..track_meta(db, id)
    }
}

fn vf_publish(db: &Db, id: i64, idx: usize) {
    let cue = cdb::CueInput {
        seq: cdb::chunk_seq_base(idx) + 1,
        start_ts: idx as f64 * 120.0 + 5.0,
        end_ts: idx as f64 * 120.0 + 8.0,
        text_en: "Bang!".into(),
        text_fr: "Dedans !".into(),
        untranslated: false,
        emphasis: 0.0,
    };
    let chunk = cdb::PublishedChunk {
        idx,
        keep_from: idx as f64 * 120.0,
        keep_to: if idx == 1 { f64::INFINITY } else { 120.0 },
    };
    let track = vf_track(db, id);
    db.with(|c| cdb::publish_commentary_chunk(c, id, &track, chunk, &[cue]))
        .unwrap();
}

fn vf_setup() -> T {
    let t = setup();
    gpu_env();
    set_env("DUB_REPUMP_MS", "10");
    set_env("COMMENTARY_REPUMP_MS", "10");
    // Exécuteur de traduction qui ne rend jamais la main.
    t.cm.set_runner(Some(Arc::new(
        |_, _, _, _| Box::pin(std::future::pending()),
    )));
    t
}

#[tokio::test(flavor = "current_thread")]
async fn une_traduction_ne_lance_jamais_le_doublage() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    let (runner, runs) = fake_dub(&t.db, None);
    t.dub.set_runner(Some(runner));
    for mode in ["sous-titres", "doublage"] {
        t.db.with(|c| setting_set(c, keys::VF_MODE, Some(mode)))
            .unwrap();
        t.cm.enqueue(
            M,
            EnqueueOptions {
                priority: true,
                explicit: true,
                force: false,
            },
        );
        assert_eq!(t.cm.running_match_id(), Some(M));
        assert_eq!(t.dub.manifest(M).status, "none"); // pas de « le doublage suivra »
    }
    t.cm.set_runner(None);
    vf_publish(&t.db, M, 0);
    vf_publish(&t.db, M, 1);
    for mode in ["sous-titres", "doublage"] {
        t.db.with(|c| setting_set(c, keys::VF_MODE, Some(mode)))
            .unwrap();
        t.cm.touch_viewer(M, Some(10.0));
        t.dub.prioritize_on_view(M); // le match est regardé, VF doublée choisie dans le lecteur
        assert_eq!(t.dub.queue_position(M), None);
        t.dub.idle().await;
        assert!(runs.get().is_empty());
        assert_eq!(t.dub.manifest(M).status, "none");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn match_regarde_un_doublage_demande_passe_en_tete() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    for id in [M, M2] {
        vf_publish(&t.db, id, 0);
        vf_publish(&t.db, id, 1);
    }
    let g = Gate::default();
    let g2 = g.clone();
    let (runner, _) = fake_dub(&t.db, Some(Arc::new(move |_| Some(g2.clone()))));
    t.dub.set_runner(Some(runner));
    assert!(t.dub.request(M2, false).started);
    t.cm.touch_viewer(M, Some(10.0));
    t.dub.prioritize_on_view(M); // pas demandé : rien
    assert_eq!(t.dub.queue_position(M), None);
    assert!(t.dub.request(M, false).queued);
    assert_eq!(t.dub.queue_position(M), Some(1));
    g.open();
    wait_for("M doublé", || t.dub.manifest(M).status == "ready").await;
    assert_eq!(t.dub.manifest(M2).status, "waiting"); // interrompu, il reprendra après la lecture de M
}

#[tokio::test(flavor = "current_thread")]
async fn doubler_ce_match_la_traduction_d_abord_puis_le_doublage() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    t.db.with(|c| setting_set(c, keys::AUTO_TRANSLATE, Some("0")))
        .unwrap();
    set_env("COMMENTARY_NIGHT_WINDOW", "off");
    let (first, second) = (Gate::default(), Gate::default());
    let (db, f2, s2) = (t.db.clone(), first.clone(), second.clone());
    t.cm.set_runner(Some(Arc::new(move |job: Job, _p, _s, _c| {
        let (db, f, s) = (db.clone(), f2.clone(), s2.clone());
        Box::pin(async move {
            let id = job.match_id;
            let tr = vf_track(&db, id);
            db.with(|c| cdb::open_commentary_track(c, id, &tr, false))
                .unwrap();
            f.wait().await;
            vf_publish(&db, id, 0);
            s.wait().await;
            vf_publish(&db, id, 1);
            Ok(CommentaryOutcome::ok("traduit"))
        })
    })));
    let (runner, runs) = fake_dub(&t.db, None);
    t.dub.set_runner(Some(runner));
    let r = t.dub.request(M, false); // personne ne regarde la fiche de M
    assert_eq!(
        (r.queued, r.started, r.message.as_str()),
        (
            true,
            false,
            "Doublage demandé : la traduction des commentaires passe d’abord"
        )
    );
    assert_eq!(
        r.translation.as_deref(),
        Some("Traduction des commentaires lancée")
    );
    assert_eq!(t.cm.running_match_id(), Some(M));
    assert_eq!(t.dub.queue_position(M), Some(1));
    let m = t.dub.manifest(M);
    assert_eq!(
        (m.status, m.reason.as_deref()),
        (
            "waiting",
            Some("traduction des commentaires en cours : le doublage suivra")
        )
    );
    assert_eq!(t.dub.activity().queued, vec![M]);
    // Pas de sous-titres pendant un moment : le doublage reste en file.
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(t.dub.queue_position(M), Some(1));
    first.open();
    wait_for("1er tronçon", || {
        t.db.with(|c| cdb::get_commentary_chunks(c, M))
            .unwrap()
            .len()
            == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(runs.get().is_empty()); // la traduction tourne : le GPU est pris
    assert!(t.dub.manifest(M).reason.unwrap().contains("GPU"));
    second.open();
    t.cm.idle().await;
    wait_for("doublé", || runs.get().len() == 1).await;
    t.dub.idle().await;
    assert_eq!(runs.get(), vec![(M, vec![0, 1], true)]);
    assert_eq!(t.dub.manifest(M).status, "ready");
    assert!(t.dub.record(M).unwrap().ok);
}

#[tokio::test(flavor = "current_thread")]
async fn revient_en_file_tant_que_la_traduction_publie() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    set_env("COMMENTARY_NIGHT_WINDOW", "off");
    let tr = vf_track(&t.db, M);
    t.db.with(|c| cdb::open_commentary_track(c, M, &tr, false))
        .unwrap();
    vf_publish(&t.db, M, 0); // piste partielle, traduction arrêtée
    let translating = Gate::default();
    let (db, g2) = (t.db.clone(), translating.clone());
    t.cm.set_runner(Some(Arc::new(move |job: Job, _p, _s, _c| {
        let (db, g) = (db.clone(), g2.clone());
        Box::pin(async move {
            g.wait().await;
            vf_publish(&db, job.match_id, 1);
            Ok(CommentaryOutcome::ok("traduit"))
        })
    })));
    // Pendant le 1er doublage, la traduction du match reprend (et prend le GPU).
    let cm2 = t.cm.clone();
    let (runner, runs) = fake_dub(
        &t.db,
        Some(Arc::new(move |id| {
            if cm2.running_match_id().is_none() {
                cm2.enqueue(
                    id,
                    EnqueueOptions {
                        priority: true,
                        explicit: true,
                        force: false,
                    },
                );
            }
            None
        })),
    );
    t.dub.set_runner(Some(runner));
    t.dub.enqueue(M, prio_explicit());
    wait_for("1er doublage", || runs.get().len() == 1).await;
    assert_eq!(runs.get()[0], (M, vec![0], true));
    wait_for("remis en file", || t.dub.queue_position(M) == Some(1)).await;
    assert_eq!(t.dub.manifest(M).status, "waiting");
    translating.open();
    t.cm.idle().await;
    wait_for("2e doublage", || runs.get().len() == 2).await;
    t.dub.idle().await;
    assert_eq!(runs.get()[1], (M, vec![1], true));
    assert_eq!(t.dub.queue_position(M), None);
    assert_eq!(t.dub.manifest(M).status, "ready");
}

#[tokio::test(flavor = "current_thread")]
async fn demande_explicite_cede_la_place_a_la_lecture_d_un_autre_match() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    set_env("COMMENTARY_VIEWER_IDLE_MS", "60000");
    vf_publish(&t.db, M, 0);
    vf_publish(&t.db, M, 1);
    let (runner, runs) = fake_dub(&t.db, None);
    t.dub.set_runner(Some(runner));
    t.cm.touch_viewer(M2, Some(10.0)); // quelqu'un regarde un autre match
    let r = t.dub.request(M, false);
    assert!(r.queued && !r.started);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(runs.get().is_empty());
    assert_eq!(t.dub.manifest(M).status, "waiting");
    t.clock.advance_ms(10 * 60_000); // la lecture s'arrête
    wait_for("doublé", || runs.get().len() == 1).await;
    t.dub.idle().await;
    assert_eq!((runs.get()[0].0, runs.get()[0].2), (M, true));
}

#[tokio::test(flavor = "current_thread")]
async fn deja_double_inactif_pas_de_replay() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    vf_publish(&t.db, M, 0);
    vf_publish(&t.db, M, 1);
    let (runner, runs) = fake_dub(&t.db, None);
    t.dub.set_runner(Some(runner));
    t.dub.request(M, false);
    t.dub.idle().await;
    assert_eq!(runs.get().len(), 1);
    let r = t.dub.request(M, false);
    assert_eq!(
        (r.queued, r.message.as_str()),
        (false, "Ce match est déjà doublé")
    );
    t.db.with(|c| {
        set_video(
            c,
            M2,
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
    let r = t.dub.request(M2, false);
    assert_eq!(
        (r.queued, r.message.as_str()),
        (false, "Traduction impossible : pas de replay disponible")
    );
    set_env("DUB_DISABLED", "1");
    let r = t.dub.request(M, true);
    assert!(!r.queued && r.message.contains("Doublage inactif"));
    assert_eq!(t.chunks(M).len(), 2); // rien d'effacé
}

#[tokio::test(flavor = "current_thread")]
async fn relance_efface_le_doublage_et_le_refait_refusee_pendant_le_doublage() {
    let _g = LOCK.lock().await;
    let t = vf_setup();
    vf_publish(&t.db, M, 0);
    vf_publish(&t.db, M, 1);
    let (runner, runs) = fake_dub(&t.db, None);
    t.dub.set_runner(Some(runner));
    t.cm.touch_viewer(M, None); // POST « start » : quelqu'un regarde
    assert!(t.dub.request(M, false).queued);
    t.dub.idle().await;
    assert_eq!(t.chunks(M).len(), 2);
    std::fs::create_dir_all(dub::dub_dir(M)).unwrap();
    std::fs::write(dub::dub_dir(M).join("chunk-0.m4a"), "m4a").unwrap();
    assert_eq!(t.dub.request(M, false).message, "Ce match est déjà doublé");
    assert_eq!(t.chunks(M).len(), 2); // intact
    let g = Gate::default();
    let g2 = g.clone();
    let (runner, runs2) = fake_dub(&t.db, Some(Arc::new(move |_| Some(g2.clone()))));
    t.dub.set_runner(Some(runner));
    let r = t.dub.request(M, true);
    assert!(r.queued && r.started);
    assert_eq!(t.dub.manifest(M).status, "running");
    assert!(!dub::dub_dir(M).exists()); // fichiers effacés
    assert!(t.chunks(M).is_empty());
    let busy = t.dub.request(M, true);
    assert_eq!(
        (busy.queued, busy.started, busy.message.as_str()),
        (
            false,
            true,
            "Doublage en cours : relance possible une fois terminé"
        )
    );
    g.open();
    t.dub.idle().await;
    assert_eq!(runs.get().len(), 1);
    assert_eq!(runs2.get(), vec![(M, vec![0, 1], true)]);
    assert_eq!(t.dub.manifest(M).status, "ready");
}

// ------------------------------------------------------------------ montage réel (ffmpeg)

/// Énergie RMS des échantillons 16 bits entre deux instants (s, 24 kHz).
fn rms(samples: &[i16], from: f64, to: f64) -> f64 {
    let (a, b) = ((from * 24000.0) as usize, (to * 24000.0) as usize);
    let s: f64 = samples[a..b]
        .iter()
        .map(|x| (*x as f64) * (*x as f64))
        .sum();
    (s / (b - a) as f64).sqrt()
}

#[tokio::test(flavor = "current_thread")]
async fn montage_reel_silence_et_repliques_a_leur_place() {
    if !has_ffmpeg() {
        eprintln!("ffmpeg absent : test sauté");
        return;
    }
    let _g = LOCK.lock().await;
    let dir = dub_env();
    let (a, b) = (dir.path().join("a.wav"), dir.path().join("b.wav"));
    for (f, src) in [
        (&a, "sine=frequency=440:duration=0.5:sample_rate=22050"),
        (&b, "sine=frequency=660:duration=0.4:sample_rate=24000"),
    ] {
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", src, "-ac", "1"])
            .arg(f)
            .status()
            .unwrap()
            .success());
    }
    let out = dir.path().join("chunk.m4a.part");
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
        &out.to_string_lossy(),
        None,
    )
    .await
    .unwrap();
    let pcm = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&out)
        .args(["-f", "s16le", "-ac", "1", "-ar", "24000", "-"])
        .output()
        .unwrap()
        .stdout;
    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    // Silence, réplique 1 (1-1,5 s), silence, réplique 2 (2,5-2,82 s), silence.
    assert!(rms(&samples, 0.1, 0.9) < 50.0);
    assert!(rms(&samples, 1.1, 1.4) > 1000.0);
    assert!(rms(&samples, 1.7, 2.4) < 50.0);
    assert!(rms(&samples, 2.55, 2.75) > 1000.0);
    assert!(rms(&samples, 2.95, 3.9) < 50.0);
    // Sans réplique : silence seul ; interrompu : arrêté net.
    let silent = dir.path().join("silence.m4a");
    dub::assemble_chunk(&[], 2.0, &silent.to_string_lossy(), None)
        .await
        .unwrap();
    assert!(std::fs::metadata(&silent).unwrap().len() > 0);
    let s = AbortSignal::new();
    s.abort();
    let err = dub::assemble_chunk(
        &[],
        2.0,
        &dir.path().join("x.m4a").to_string_lossy(),
        Some(&s),
    )
    .await
    .unwrap_err();
    assert!(err.starts_with("ffmpeg montage code "), "{err}");
}
