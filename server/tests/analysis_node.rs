//! Route de calage et file d'analyse (étape 7, non branchées) comparées au
//! code TypeScript : réponses de `server/tests/node-fixtures-analysis.mts`
//! (`fixtures/analysis.expected.json`) — statut, corps (ordre des clés
//! compris) et lignes `sync_anchors` / `sync_settings` après chaque requête.

#[path = "helpers/commentary_kit.rs"]
mod kit;

use axum::http::{HeaderMap, HeaderValue};
use basketland_server::analysis_db as adb;
use basketland_server::espn_events::parse_summary;
use basketland_server::ingest_db::replace_plays;
use basketland_server::jsval::js_normalize;
use basketland_server::media::analysis::{Analysis, AnalysisOptions, EnqueueOptions};
use basketland_server::media::viewers::Viewers;
use basketland_server::sync_route;
use kit::{fresh_db, insert_match, LOCK};
use serde_json::Value;
use std::sync::Arc;

fn fixture() -> Value {
    let p = format!(
        "{}/tests/fixtures/analysis.expected.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// Dates de mise à jour retirées (comme `strip` côté Node).
fn strip(v: Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.into_iter().map(strip).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .filter(|(k, _)| k != "updated_at")
                .map(|(k, x)| (k, strip(x)))
                .collect(),
        ),
        x => x,
    }
}

#[tokio::test]
async fn route_de_calage_comme_node() {
    let _l = LOCK.lock().await;
    std::env::remove_var("SYNC_WRITE_ORIGINS");
    for k in [
        "ANALYSIS_MAX_PARALLEL",
        "ANALYSIS_MIN_INTERVAL_MS",
        "ANALYSIS_TIMEOUT_MS",
        "COMMENTARY_NIGHT_WINDOW",
    ] {
        std::env::remove_var(k);
    }
    let f = fixture();
    let id = f["id"].as_i64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("DATA_DIR", dir.path());
    let db = fresh_db(dir.path());
    insert_match(&db, id, Some(8033.0));
    insert_match(&db, 1, Some(7480.0));
    let raw: Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../tests/fixtures/espn-summary-401909880.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let plays = parse_summary(&raw, id as f64, "nba").plays;
    db.with(|c| replace_plays(c, id, &plays)).unwrap();
    let viewers: &'static Viewers = Box::leak(Box::default());
    let svc = Analysis::with_options(
        db.clone(),
        basketland_server::media::analysis::AnalysisDeps::defaults(
            db.clone(),
            basketland_server::video::Video::new(),
        ),
        AnalysisOptions {
            viewers,
            clock: Arc::new(basketland_server::media::viewers::now_ms),
            ffmpeg_available: Arc::new(|| true),
        },
    );
    svc.set_runner(Some(Arc::new(|_, _, _| Box::pin(std::future::pending()))));
    let steps = f["steps"].as_array().unwrap();
    for s in steps {
        let label = s["label"].as_str().unwrap();
        if label == "analyse en file" {
            svc.enqueue(
                1,
                EnqueueOptions {
                    priority: true,
                    ..Default::default()
                },
            );
        }
        let res = match s["body"].as_str() {
            None => sync_route::get(&db, &svc, &id.to_string()),
            Some(body) => {
                let mut h = HeaderMap::new();
                h.insert("content-type", HeaderValue::from_static("application/json"));
                h.insert("origin", HeaderValue::from_static("http://nas.local:3012"));
                h.insert("host", HeaderValue::from_static("nas.local:3012"));
                for (k, v) in s["headers"].as_object().unwrap() {
                    h.insert(
                        axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                        HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
                    );
                }
                sync_route::post(&db, &svc, &id.to_string(), &h, body.as_bytes())
            }
        };
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 24)
            .await
            .unwrap();
        let got = strip(serde_json::from_slice::<Value>(&bytes).unwrap());
        assert_eq!(
            status,
            s["status"].as_u64().unwrap() as u16,
            "{label} : statut"
        );
        assert_eq!(
            js_normalize(got).to_string(),
            js_normalize(s["response"].clone()).to_string(),
            "{label} : réponse"
        );
        let anchors = Value::Array(db.with(|c| adb::anchors_json(c, id)).unwrap());
        let settings = strip(db.with(|c| adb::sync_settings_json(c, id)).unwrap());
        assert_eq!(
            js_normalize(anchors).to_string(),
            js_normalize(s["rows"]["anchors"].clone()).to_string(),
            "{label} : ancres"
        );
        assert_eq!(
            js_normalize(settings).to_string(),
            js_normalize(s["rows"]["settings"].clone()).to_string(),
            "{label} : réglages"
        );
    }
    assert_eq!(steps.len(), 35);
}
