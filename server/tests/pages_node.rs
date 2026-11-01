//! Données des pages (`GET /api/pages/…`, étape 8a) comparées à l'octet près
//! (ordre des clés compris) à celles du code TypeScript :
//! `fixtures/pages.expected.json`, produit par `node-fixtures-pages.mts` —
//! même base (schéma réel et lignes écrites par Node), même instant figé,
//! mêmes variables d'environnement et réglages, même session, et l'état des
//! files de Node tel que Node l'aurait renvoyé à `POST /api/internal/page-state`.

use basketland_server::{auth, db, pages, routes_pages, settings};
use rusqlite::Connection;
use serde_json::Value;

const ENV_KEYS: [&str; 6] = [
    "COMMENTARY_NIGHT_WINDOW",
    "APP_COMMIT",
    "APP_BUILT_AT",
    "MINIMAX_API_KEY",
    "MINIMAX_TTS_MODEL",
    "MINIMAX_TRANSLATE",
];

fn media_state(v: &Value) -> pages::MediaState {
    pages::MediaState {
        running_match_id: v["running_match_id"].as_i64(),
        activity: v["activity"].clone(),
        commentary_disabled_reason: v["commentary_disabled_reason"].as_str().map(str::to_string),
        dub_disabled_reason: v["dub_disabled_reason"].as_str().map(str::to_string),
    }
}

fn first_diff(a: &str, b: &str) -> String {
    let i = a
        .bytes()
        .zip(b.bytes())
        .position(|(x, y)| x != y)
        .unwrap_or(a.len().min(b.len()));
    let around = |s: &str| {
        let lo = s.floor_char_boundary(i.saturating_sub(120));
        let hi = s.ceil_char_boundary((i + 160).min(s.len()));
        s[lo..hi].to_string()
    };
    format!(
        "écart à l'octet {i}\n  rust : {}\n  node : {}",
        around(a),
        around(b)
    )
}

#[tokio::test]
async fn pages_comme_node() {
    let fx: Value =
        serde_json::from_str(include_str!("fixtures/pages.expected.json")).expect("fixture");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("basketland.db");
    let c = Connection::open(&path).unwrap();
    for s in fx["schema"].as_array().unwrap() {
        c.execute_batch(s.as_str().unwrap()).unwrap();
    }
    for s in fx["inserts"].as_array().unwrap() {
        c.execute(s.as_str().unwrap(), []).unwrap();
    }
    let shared = db::Db::new(path.clone());
    for k in ENV_KEYS {
        std::env::remove_var(k);
    }

    let scenarios = fx["scenarios"].as_array().unwrap();
    let mut failures = Vec::new();
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        for (k, v) in sc["env"].as_object().unwrap() {
            std::env::set_var(k, v.as_str().unwrap());
        }
        let mut saved = Vec::new();
        for (k, v) in sc["settings"].as_object().unwrap() {
            saved.push((k.clone(), settings::setting_get(&c, k).unwrap()));
            settings::setting_set(&c, k, v.as_str()).unwrap();
        }
        let now = basketland_server::time::parse_instant(sc["now"].as_str().unwrap()).unwrap();
        let node = media_state(&sc["node"]);
        let session = auth::validate_session_opts(&c, sc["token"].as_str(), now, false).unwrap();
        let spoilers = if sc["spoilers"] == "hide" {
            "hide"
        } else {
            "show"
        };
        let ctx = pages::PageCtx {
            now,
            spoilers,
            session: session.as_ref(),
            media: &node,
        };
        let p = &sc["params"];
        let param = |k: &str| p.get(k).and_then(Value::as_str);
        let ok = |v: Value| (200, v);
        let paged = |r: Result<Value, pages::NotFound>| match r {
            Ok(v) => (200, v),
            Err(nf) => (404, nf.0),
        };
        let (status, body) = match sc["page"].as_str().unwrap() {
            "session" => ok(pages::session(&c, session.as_ref(), param("next")).unwrap()),
            "home" => ok(pages::home(&c, &ctx).unwrap()),
            "matchs" => ok(pages::matchs(&c, &ctx, param("team"), param("d")).unwrap()),
            "match" => paged(pages::match_page(&c, &ctx, param("id").unwrap()).unwrap()),
            "equipes" => ok(pages::equipes(&c, &ctx).unwrap()),
            "equipe" => paged(pages::equipe(&c, &ctx, param("abbr").unwrap()).unwrap()),
            "classement" => {
                let v = routes_pages::load_standings(&shared, now, || async {
                    Err::<Value, String>("hors ligne (fixture)".into())
                })
                .await
                .unwrap();
                ok(pages::classement(v))
            }
            "parametres" => match &session {
                Some(s) => {
                    let mut v = pages::parametres(&c, s, &node).unwrap();
                    // Réglage ajouté après le retrait de Node (moteur de
                    // transcription) : absent de la référence TypeScript.
                    if let Some(a) = v.get_mut("admin_data").and_then(Value::as_object_mut) {
                        let e = a.shift_remove("transcribe_engine");
                        a.shift_remove("transcribe_engine_override");
                        a.shift_remove("fetch_parallel");
                        a.shift_remove("translate_repair_model");
                        a.shift_remove("extra_names");
                        let q = a.shift_remove("voice_quality");
                        a.shift_remove("voice_quality_override");
                        a.shift_remove("voice_engine");
                        a.shift_remove("minimax_key_set");
                        a.shift_remove("voxtral");
                        a.shift_remove("translate");
                        assert!(
                            matches!(q.as_ref().and_then(Value::as_str), Some("standard" | "hd")),
                            "{q:?}"
                        );
                        assert!(
                            matches!(
                                e.as_ref().and_then(Value::as_str),
                                Some("whisper" | "whisper-large" | "nvidia")
                            ),
                            "{e:?}"
                        );
                    }
                    ok(v)
                }
                None => (401, serde_json::json!({ "error": "non connecté" })),
            },
            other => panic!("page inconnue {other}"),
        };
        for (k, v) in saved {
            settings::setting_set(&c, &k, v.as_deref()).unwrap();
        }
        for k in sc["env"].as_object().unwrap().keys() {
            std::env::remove_var(k);
        }
        let got = serde_json::to_string(&body).unwrap();
        let want = sc["body"].as_str().unwrap();
        if status != sc["status"].as_i64().unwrap() || got != want {
            failures.push(format!(
                "{name} (statut {status}, attendu {}) : {}",
                sc["status"],
                first_diff(&got, want)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} scénario(s) sur {} différents de Node :\n{}",
        failures.len(),
        scenarios.len(),
        failures.join("\n\n")
    );
    assert!(scenarios.len() >= 50);
}
