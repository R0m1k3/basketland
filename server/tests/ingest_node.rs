//! Portage de l'ingestion ESPN et de la VF comparé à Node : les fichiers
//! `tests/fixtures/*.expected.json` sont les sorties du code TypeScript
//! (`parseScoreboard`, `parseSummary`, `classifyPlay`, `translatePlay`,
//! `buildCommentary`, `regenerateSubtitles`, `ingestMatchDetails`) sur les
//! captures ESPN réelles de `tests/fixtures/` à la racine du dépôt.

use basketland_server::db::{get_match, sql_to_json};
use basketland_server::espn_events::{parse_event, parse_scoreboard, parse_summary, PlayRow};
use basketland_server::ingest::{regenerate_subtitles, store_match_details};
use basketland_server::ingest_db::{replace_plays, upsert_match, upsert_matches};
use basketland_server::vf::{build_commentary, classify_play, translate_play};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const ID: i64 = 401909880;

/// Schéma réel (`SCHEMA_SQL` + migrations de `src/lib/db.ts`) des tables utilisées.
const SCHEMA: &str = "
CREATE TABLE matches (
  id INTEGER PRIMARY KEY, espn_id TEXT UNIQUE NOT NULL, league TEXT NOT NULL DEFAULT 'nba', season INTEGER NOT NULL,
  season_type TEXT NOT NULL, date_utc TEXT NOT NULL, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, home_score INTEGER, away_score INTEGER, status TEXT NOT NULL,
  status_detail TEXT DEFAULT '', period INTEGER DEFAULT 0, clock_display TEXT DEFAULT '', venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '', slug TEXT, video_ok_id TEXT, video_duration INTEGER, video_available INTEGER DEFAULT 0,
  video_checked_at TEXT, stats_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, video_kind TEXT);
CREATE TABLE player_stats (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, team_abbr TEXT NOT NULL,
  player_id TEXT NOT NULL, player_name TEXT NOT NULL, position TEXT DEFAULT '', jersey TEXT DEFAULT '', starter INTEGER DEFAULT 0,
  stats_json TEXT NOT NULL, PRIMARY KEY (match_id, player_id));
CREATE TABLE team_stats (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, team_abbr TEXT NOT NULL,
  stats_json TEXT NOT NULL, PRIMARY KEY (match_id, team_abbr));
CREATE TABLE match_leaders (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, team_abbr TEXT NOT NULL,
  category TEXT NOT NULL, label TEXT NOT NULL, player TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (match_id, team_abbr, category));
CREATE TABLE plays (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, seq INTEGER NOT NULL, period INTEGER NOT NULL,
  clock_display TEXT NOT NULL, clock_sec INTEGER NOT NULL, wallclock TEXT NOT NULL, event_type TEXT NOT NULL, text_en TEXT NOT NULL,
  actor TEXT DEFAULT '', team_abbr TEXT DEFAULT '', home_score INTEGER, away_score INTEGER, scoring INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0, PRIMARY KEY (match_id, seq));
CREATE TABLE subtitles (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  video_ts REAL NOT NULL, end_ts REAL, text_fr TEXT NOT NULL, speaker TEXT DEFAULT '', kind TEXT DEFAULT 'action', PRIMARY KEY (match_id, seq));
CREATE TABLE sync_anchors (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, period INTEGER NOT NULL,
  clock_sec INTEGER NOT NULL, video_ts REAL NOT NULL, method TEXT DEFAULT 'manual', wallclock TEXT, PRIMARY KEY (match_id, period, clock_sec));
CREATE TABLE sync_settings (match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, global_offset REAL NOT NULL DEFAULT 0,
  quarter_offsets_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE audio_profiles (match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, ok_id TEXT NOT NULL,
  window_sec REAL NOT NULL DEFAULT 1, rms_db_json TEXT NOT NULL, cuts_json TEXT NOT NULL DEFAULT '[]', analyzed_at TEXT NOT NULL);
CREATE TABLE ingest_log (id INTEGER PRIMARY KEY, task TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER DEFAULT 0, detail TEXT DEFAULT '');
";

fn raw(name: &str) -> Value {
    let path = format!("{}/../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn expected(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Égalité champ à champ, avec le premier écart en clair.
fn same(got: &Value, want: &Value, what: &str) {
    if got == want {
        return;
    }
    if let (Value::Array(a), Value::Array(b)) = (got, want) {
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            assert_eq!(x, y, "{what} : écart à l'élément {i}");
        }
        assert_eq!(a.len(), b.len(), "{what} : nombre d'éléments");
    }
    assert_eq!(got, want, "{what}");
}

/// Texte JSON identique à `JSON.stringify` (ordre des clés et nombres compris).
fn same_text(got: &Value, want_file: &str) {
    let path = format!("{}/tests/fixtures/{want_file}", env!("CARGO_MANIFEST_DIR"));
    let want = std::fs::read_to_string(path).unwrap();
    let got = serde_json::to_string(got).unwrap();
    if got != want {
        let i = got
            .bytes()
            .zip(want.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        let lo = i.saturating_sub(120);
        panic!(
            "{want_file} : écart à l'octet {i}\n  rust : {}\n  node : {}",
            &got[lo..(i + 120).min(got.len())],
            &want[lo..(i + 120).min(want.len())]
        );
    }
}

fn parsed_summary() -> basketland_server::espn_events::ParsedSummary {
    parse_summary(&raw("espn-summary-401909880.json"), ID as f64, "nba")
}

#[test]
fn calendrier_espn_comme_node() {
    let got: Vec<Value> = parse_scoreboard(&raw("espn-scoreboard-20261027.json"), "nba")
        .iter()
        .map(|m| m.to_json())
        .collect();
    same_text(&Value::Array(got), "espn-scoreboard-20261027.expected.json");
}

#[test]
fn fiche_de_match_espn_comme_node() {
    same_text(
        &parsed_summary().to_json(),
        "espn-summary-401909880.expected.json",
    );
}

#[test]
fn variantes_de_champs_espn_comme_node() {
    for (i, case) in expected("espn-events-variants.expected.json")
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let got = parse_event(&case["input"], "nba")
            .map(|m| m.to_json())
            .unwrap_or(Value::Null);
        assert_eq!(got, case["output"], "variante {i}");
    }
}

fn from_db(plays: &[PlayRow]) -> Vec<PlayRow> {
    plays
        .iter()
        .map(|p| PlayRow {
            score_value: None,
            participants: None,
            ..p.clone()
        })
        .collect()
}

fn commentary(plays: &[PlayRow]) -> Value {
    Value::Array(
        build_commentary(plays, "LAL", "POR")
            .iter()
            .map(|l| l.to_json())
            .collect(),
    )
}

#[test]
fn vf_comme_node() {
    let want = expected("vf-401909880.expected.json");
    let plays = parsed_summary().plays;
    let cats: Vec<Value> = plays
        .iter()
        .map(|p| {
            classify_play(&p.event_type, &p.text_en, p.scoring != 0.0)
                .as_str()
                .into()
        })
        .collect();
    same(&Value::Array(cats), &want["categories"], "classifyPlay");
    let fr: Vec<Value> = plays.iter().map(|p| translate_play(p).into()).collect();
    same(&Value::Array(fr), &want["translations"], "translatePlay");
    let fr_db: Vec<Value> = from_db(&plays)
        .iter()
        .map(|p| translate_play(p).into())
        .collect();
    same(
        &Value::Array(fr_db),
        &want["translations_db"],
        "translatePlay (base)",
    );

    for (i, s) in want["synthetic"].as_array().unwrap().iter().enumerate() {
        let p = PlayRow {
            match_id: 1.0,
            seq: 1.0,
            period: s["period"].as_f64().unwrap(),
            clock_display: String::new(),
            clock_sec: 0.0,
            wallclock: String::new(),
            event_type: s["event_type"].as_str().unwrap().into(),
            text_en: s["text_en"].as_str().unwrap().into(),
            actor: String::new(),
            team_abbr: String::new(),
            home_score: None,
            away_score: None,
            scoring: s["scoring"].as_f64().unwrap(),
            is_key: 0.0,
            score_value: s["score_value"].as_f64(),
            participants: None,
        };
        let cat = classify_play(&p.event_type, &p.text_en, p.scoring != 0.0);
        assert_eq!(
            cat.as_str(),
            s["category"],
            "catégorie synthétique {i} : {s}"
        );
        assert_eq!(
            translate_play(&p),
            s["fr"],
            "traduction synthétique {i} : {s}"
        );
    }

    same(&commentary(&plays), &want["commentary"], "buildCommentary");
    same(
        &commentary(&from_db(&plays)),
        &want["commentary_db"],
        "buildCommentary (base)",
    );
    same(
        &commentary(&plays[..90]),
        &want["commentary_short"],
        "buildCommentary (court)",
    );
    let mut long = plays.clone();
    long.extend(plays.iter().map(|p| PlayRow {
        seq: p.seq + 5000.0,
        ..p.clone()
    }));
    same(
        &commentary(&long),
        &want["commentary_long"],
        "buildCommentary (long)",
    );
    let ft: Vec<PlayRow> = plays
        .iter()
        .filter(|p| {
            let t = p.text_en.to_lowercase();
            t.contains("free throw") || t.contains("enters the game") || t.contains("timeout")
        })
        .enumerate()
        .map(|(i, p)| PlayRow {
            actor: if i % 7 == 0 {
                String::new()
            } else {
                p.actor.clone()
            },
            ..p.clone()
        })
        .collect();
    same(
        &commentary(&ft),
        &want["commentary_ft"],
        "buildCommentary (lancers francs)",
    );
}

fn rows(c: &Connection, sql: &str) -> Value {
    let mut st = c.prepare(sql).unwrap();
    let names: Vec<String> = st.column_names().into_iter().map(str::to_string).collect();
    let out: Vec<Value> = st
        .query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), sql_to_json(r.get::<_, SqlValue>(i)?));
            }
            Ok(Value::Object(m))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    Value::Array(out)
}

fn temp_db() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let c = Connection::open(dir.path().join("basketland.db")).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    (dir, c)
}

#[test]
fn sous_titres_regeneres_comme_node() {
    let want = expected("subtitles-401909880.expected.json");
    let summary = parsed_summary();
    for s in want["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let (_dir, c) = temp_db();
        upsert_match(&c, summary.game.as_ref().unwrap()).unwrap();
        let ok_id = s["video"]["okId"].as_str();
        c.execute(
            "UPDATE matches SET video_ok_id = ?1, video_duration = ?2, video_available = ?3 WHERE id = ?4",
            params![ok_id, s["video"]["duration"].as_f64(), ok_id.is_some() as i64, ID],
        )
        .unwrap();
        let blank = s["blankWallclock"].as_u64().unwrap_or(0) as usize;
        let plays: Vec<PlayRow> = summary
            .plays
            .iter()
            .enumerate()
            .map(|(i, p)| PlayRow {
                wallclock: if i < blank {
                    String::new()
                } else {
                    p.wallclock.clone()
                },
                ..p.clone()
            })
            .collect();
        replace_plays(&c, ID, &plays).unwrap();
        for a in s["anchors"].as_array().unwrap() {
            c.execute(
                "INSERT INTO sync_anchors (match_id, period, clock_sec, video_ts, method, wallclock) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(match_id, period, clock_sec) DO UPDATE SET video_ts = excluded.video_ts, method = excluded.method, wallclock = excluded.wallclock",
                params![ID, a["period"].as_f64(), a["clock_sec"].as_f64(), a["video_ts"].as_f64(), a["method"].as_str(), a["wallclock"].as_str()],
            )
            .unwrap();
        }
        if let Some(set) = s.get("settings") {
            c.execute(
                "INSERT INTO sync_settings (match_id, global_offset, quarter_offsets_json, updated_at) VALUES (?1, ?2, ?3, 'x')",
                params![ID, set["global_offset"].as_f64(), set["quarter_offsets"].to_string()],
            )
            .unwrap();
        }
        if let Some(p) = s.get("profile") {
            c.execute(
                "INSERT INTO audio_profiles (match_id, ok_id, window_sec, rms_db_json, cuts_json, analyzed_at) VALUES (?1, ?2, 1, '[-20,-21.5]', ?3, 'x')",
                params![ID, p["ok_id"].as_str(), p["cuts"].to_string()],
            )
            .unwrap();
        }
        let input = s["parsedPlays"]
            .as_bool()
            .unwrap_or(false)
            .then(|| plays.clone());
        let r = regenerate_subtitles(&c, ID, input).unwrap();
        let (count, error) = match r {
            Ok(n) => (json!(n), Value::Null),
            Err(e) => (Value::Null, json!(e)),
        };
        assert_eq!(count, s["count"], "{name} : nombre de lignes");
        assert_eq!(error, s["error"], "{name} : erreur");
        same(
            &rows(
                &c,
                &format!("SELECT * FROM subtitles WHERE match_id = {ID} ORDER BY seq"),
            ),
            &s["subtitles"],
            &format!("{name} : sous-titres"),
        );
        same(
            &rows(
                &c,
                &format!("SELECT * FROM sync_anchors WHERE match_id = {ID} ORDER BY period, clock_sec, method"),
            ),
            &s["anchors"],
            &format!("{name} : ancres"),
        );
    }
}

#[test]
fn ingestion_d_un_match_comme_node() {
    let want = expected("ingest-401909880.expected.json");
    let (_dir, c) = temp_db();
    upsert_matches(
        &c,
        &parse_scoreboard(&raw("espn-scoreboard-20261027.json"), "nba"),
    )
    .unwrap();
    let m = get_match(&c, ID).unwrap().unwrap();
    let line = store_match_details(&c, &m, &parsed_summary())
        .unwrap()
        .unwrap();
    assert_eq!(line, want["line"]);
    for (table, sql) in [
        ("matches", "SELECT id, espn_id, league, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, home_score, away_score, status, status_detail, period, clock_display, venue, broadcast, stats_synced_at IS NOT NULL AS synced FROM matches ORDER BY id"),
        ("team_stats", "SELECT * FROM team_stats ORDER BY rowid"),
        ("player_stats", "SELECT * FROM player_stats ORDER BY rowid"),
        ("match_leaders", "SELECT * FROM match_leaders ORDER BY rowid"),
        ("plays", "SELECT * FROM plays ORDER BY match_id, seq"),
        ("subtitles", "SELECT * FROM subtitles ORDER BY match_id, seq"),
    ] {
        same(&rows(&c, sql), &want[table], table);
    }
}

// ---------------------------------------------------------------- POST /api/ingest

mod route {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use basketland_server::{app, db, ingest, proxy, state};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN: &str = "jeton-ingest";

    fn router(path: &std::path::Path) -> axum::Router {
        std::env::set_var("INGEST_TOKEN", TOKEN);
        // Node injoignable (port fermé) : `sync-videos` relayé échoue proprement.
        app(state::AppState {
            db: db::Db::new(path.to_path_buf()),
            upstream: proxy::Upstream::new("http://127.0.0.1:9"),
            video: basketland_server::video::Video::new(),
        })
    }

    async fn post(r: axum::Router, auth: Option<&str>, body: &str) -> (StatusCode, Value) {
        let mut b = Request::post("/api/ingest").header(header::CONTENT_TYPE, "application/json");
        if let Some(a) = auth {
            b = b.header(header::AUTHORIZATION, a);
        }
        let res = r
            .oneshot(b.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Base avec le match de la fixture, terminé hier (fenêtre de 21 jours de sync-subtitles).
    fn seeded() -> (tempfile::TempDir, std::path::PathBuf) {
        let (dir, c) = temp_db();
        let mut g = parsed_summary().game.unwrap();
        g.date_utc = Some(basketland_server::time::iso_utc(
            chrono::Utc::now() - chrono::Duration::days(1),
        ));
        upsert_match(&c, &g).unwrap();
        replace_plays(&c, ID, &parsed_summary().plays).unwrap();
        let p = dir.path().join("basketland.db");
        (dir, p)
    }

    #[tokio::test]
    async fn jeton_exige() {
        let (_d, p) = seeded();
        let (s, v) = post(router(&p), None, "{}").await;
        assert_eq!(
            (s, v),
            (
                StatusCode::UNAUTHORIZED,
                json!({ "error": "jeton invalide" })
            )
        );
        let (s, _) = post(router(&p), Some("Bearer faux"), "{}").await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn jobs_inconnus() {
        let (_d, p) = seeded();
        let (s, v) = post(
            router(&p),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"jobs":["sync-stats","x",null,3]}"#,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert_eq!(
            v,
            json!({ "error": "jobs inconnus: x, , 3 (attendus: sync-schedule, sync-season, sync-stats, sync-videos, sync-subtitles)" })
        );
    }

    #[tokio::test]
    async fn vf_en_rust_videos_relayees_a_node() {
        let (_d, p) = seeded();
        let (s, v) = post(
            router(&p),
            Some(&format!("bearer   {TOKEN} ")),
            r#"{"jobs":["sync-subtitles","sync-videos","sync-subtitles"]}"#,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(
            v,
            json!({
                "ok": false,
                "results": {
                    "sync-subtitles": { "ok": true, "detail": "1 matchs" },
                    "sync-videos": { "ok": false, "detail": "application Node injoignable (démarrage en cours ?)" },
                }
            })
        );
        let c = Connection::open(&p).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM subtitles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 171);
        // Journal : un passage par job lancé (deux sync-subtitles), terminés et réussis.
        assert_eq!(
            rows(
                &c,
                "SELECT task, ok, detail, finished_at IS NOT NULL AS fini FROM ingest_log ORDER BY id"
            ),
            json!([
                { "task": "sync-subtitles", "ok": 1, "detail": "1 matchs", "fini": 1 },
                { "task": "sync-subtitles", "ok": 1, "detail": "1 matchs", "fini": 1 },
            ])
        );
    }

    #[tokio::test]
    async fn job_deja_en_cours() {
        let (_d, p) = seeded();
        let db = db::Db::new(p.clone());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let d2 = db.clone();
        let first = tokio::spawn(async move {
            ingest::run_logged(&d2, "job-test", || async move {
                let _ = rx.await;
                Err::<String, _>("raté".into())
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let second = ingest::run_logged(&db, "job-test", || async { Ok("jamais".into()) }).await;
        assert_eq!(
            second,
            ingest::JobResult {
                ok: false,
                detail: "déjà en cours".into()
            }
        );
        tx.send(()).unwrap();
        assert_eq!(
            first.await.unwrap(),
            ingest::JobResult {
                ok: false,
                detail: "raté".into()
            }
        );
        let third = ingest::run_logged(&db, "job-test", || async { Ok("fini".into()) }).await;
        assert!(third.ok);
        let c = Connection::open(&p).unwrap();
        assert_eq!(
            rows(&c, "SELECT task, ok, detail FROM ingest_log ORDER BY id"),
            json!([{ "task": "job-test", "ok": 0, "detail": "raté" }, { "task": "job-test", "ok": 1, "detail": "fini" }])
        );
    }
}
