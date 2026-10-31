//! Schéma et migrations de la base (étape 8b) : une base créée par Rust est
//! identique à celle que crée Node (texte des `CREATE` de `sqlite_master`,
//! relevé par les scripts de fixtures sur une base neuve de `db.ts`), et une
//! base ancienne reçoit les colonnes ajoutées depuis, comme `migrate`.

use basketland_server::schema::{ensure_schema, migrate, SCHEMA_SQL};
use rusqlite::Connection;
use serde_json::Value;

fn master(c: &Connection) -> Vec<String> {
    let mut st = c
        .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
        .unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn node_schema(fixture: &str) -> Vec<String> {
    let fx: Value = serde_json::from_str(fixture).unwrap();
    fx["schema"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn base_neuve_identique_a_celle_de_node() {
    let dir = tempfile::tempdir().unwrap();
    // Dossier absent : créé, comme `fs.mkdirSync(..., { recursive: true })`.
    let file = dir
        .path()
        .join("sous")
        .join("dossier")
        .join("basketland.db");
    ensure_schema(&file).unwrap();
    let c = Connection::open(&file).unwrap();
    let rust = master(&c);
    for fixture in [
        include_str!("fixtures/commentary.expected.json"),
        include_str!("fixtures/pages.expected.json"),
    ] {
        assert_eq!(rust, node_schema(fixture));
    }
    let mode: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    // Idempotent : une seconde ouverture ne change rien.
    drop(c);
    ensure_schema(&file).unwrap();
    assert_eq!(master(&Connection::open(&file).unwrap()), rust);
}

#[test]
fn ancienne_base_migree_comme_node() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("basketland.db");
    let c = Connection::open(&file).unwrap();
    // Base d'avant les migrations de colonnes (`SCHEMA_SQL` seul : ni
    // `video_kind`, ni `complete`…), avec une piste déjà écrite.
    c.execute_batch(SCHEMA_SQL).unwrap();
    c.execute_batch(
        "INSERT INTO matches (id, espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status, created_at, updated_at)
           VALUES (1, 'e1', 2026, 'regular', 'd', 'H', 'Home', 'A', 'Away', 'final', 'x', 'x');
         INSERT INTO commentary_tracks (match_id, ok_id, transcribe_model, translate_model, cues, created_at)
           VALUES (1, 'ok', 'w', 'l', 3, 'x');",
    )
    .unwrap();
    drop(c);
    ensure_schema(&file).unwrap();
    let c = Connection::open(&file).unwrap();
    let cols = |t: &str| -> Vec<String> {
        let mut st = c.prepare(&format!("PRAGMA table_info({t})")).unwrap();
        st.query_map([], |r| r.get::<_, String>("name"))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert!(cols("matches").contains(&"video_kind".to_string()));
    assert!(cols("commentary_tracks").ends_with(&[
        "complete".to_string(),
        "chunk_sec".to_string(),
        "chunks_total".to_string()
    ]));
    assert!(cols("commentary_cues").contains(&"emphasis".to_string()));
    // Pistes antérieures, écrites d'un bloc : complètes.
    let complete: i64 = c
        .query_row(
            "SELECT complete FROM commentary_tracks WHERE match_id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(complete, 1);
    for t in [
        "dub_tracks",
        "dub_chunks",
        "users",
        "sessions",
        "settings",
        "ingest_log",
    ] {
        assert!(!cols(t).is_empty(), "{t}");
    }
    // Rejouée : rien ne change (la piste reste complète, pas de colonne en double).
    let n = cols("commentary_tracks").len();
    migrate(&c).unwrap();
    assert_eq!(cols("commentary_tracks").len(), n);
}

#[test]
fn dossier_non_inscriptible_message_explicite() {
    let dir = tempfile::tempdir().unwrap();
    // Un fichier à la place du dossier : création impossible, même message que Node.
    let blocker = dir.path().join("data");
    std::fs::write(&blocker, b"x").unwrap();
    let e = ensure_schema(&blocker.join("basketland.db")).unwrap_err();
    assert!(
        e.starts_with("Impossible de créer le répertoire de la base ("),
        "{e}"
    );
    assert!(
        e.ends_with("sur Unraid, chown -R 1000:1000 /mnt/user/appdata/basketland"),
        "{e}"
    );
}
