//! Schéma de la base et migrations (équivalents de `openDatabase` et
//! `migrate` de `src/lib/db.ts`) : depuis l'étape 8b, c'est le serveur Rust
//! qui crée et met à jour la base au démarrage, avant de lancer Node. Mêmes
//! instructions SQL, au caractère près : `sqlite_master` garde le texte des
//! `CREATE`, une base créée par Rust est donc identique à une base créée par
//! Node (vérifié par `tests/schema.rs` contre les bases des fixtures).
//!
//! Garder ces textes en phase avec `SCHEMA_SQL`, `AUTH_SCHEMA_SQL` et
//! `DUB_SCHEMA_SQL` de `db.ts` tant que Node les a encore.

use rusqlite::Connection;
use std::path::Path;

/// `SCHEMA_SQL` : matchs, stats, play-by-play, VF, calage, traduction, caches, journal.
pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  espn_id TEXT UNIQUE NOT NULL,
  league TEXT NOT NULL DEFAULT 'nba',
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  date_utc TEXT NOT NULL,
  home_abbr TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL,
  status_detail TEXT DEFAULT '',
  period INTEGER DEFAULT 0,
  clock_display TEXT DEFAULT '',
  venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '',
  slug TEXT,
  video_ok_id TEXT,
  video_duration INTEGER,
  video_available INTEGER DEFAULT 0,
  video_checked_at TEXT,
  stats_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date_utc);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_video ON matches(video_available);
CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league);

CREATE TABLE IF NOT EXISTS player_stats (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_abbr TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  position TEXT DEFAULT '',
  jersey TEXT DEFAULT '',
  starter INTEGER DEFAULT 0,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS team_stats (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_abbr TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (match_id, team_abbr)
);

CREATE TABLE IF NOT EXISTS match_leaders (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_abbr TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  player TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (match_id, team_abbr, category)
);

CREATE TABLE IF NOT EXISTS plays (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  period INTEGER NOT NULL,
  clock_display TEXT NOT NULL,
  clock_sec INTEGER NOT NULL,
  wallclock TEXT NOT NULL,
  event_type TEXT NOT NULL,
  text_en TEXT NOT NULL,
  actor TEXT DEFAULT '',
  team_abbr TEXT DEFAULT '',
  home_score INTEGER,
  away_score INTEGER,
  scoring INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS subtitles (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  video_ts REAL NOT NULL,
  end_ts REAL,
  text_fr TEXT NOT NULL,
  speaker TEXT DEFAULT '',
  kind TEXT DEFAULT 'action',
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS sync_anchors (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  period INTEGER NOT NULL,
  clock_sec INTEGER NOT NULL,
  video_ts REAL NOT NULL,
  method TEXT DEFAULT 'manual',
  wallclock TEXT,
  PRIMARY KEY (match_id, period, clock_sec)
);

CREATE TABLE IF NOT EXISTS sync_settings (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  global_offset REAL NOT NULL DEFAULT 0,
  quarter_offsets_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_profiles (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  ok_id TEXT NOT NULL,
  window_sec REAL NOT NULL DEFAULT 1,
  rms_db_json TEXT NOT NULL,
  cuts_json TEXT NOT NULL DEFAULT '[]',
  analyzed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_clips (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  video_ts REAL NOT NULL,
  duration REAL,
  file_path TEXT,
  text_fr TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- Traduction des commentaires : sous-titres (anglais transcrit + français)
-- et piste produite (vidéo source, modèles). Une piste n'est valable que pour
-- l'ok_id qui l'a produite : si le replay change, elle est refaite. Les
-- sous-titres sont publiés par tranches pendant le travail : la colonne
-- « complete » (ajoutée par migrate) ne passe à 1 qu'une fois tout le match
-- traduit.
CREATE TABLE IF NOT EXISTS commentary_cues (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  start_ts REAL NOT NULL,
  end_ts REAL NOT NULL,
  text_en TEXT NOT NULL,
  text_fr TEXT NOT NULL,
  untranslated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS commentary_tracks (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  ok_id TEXT NOT NULL,
  transcribe_model TEXT NOT NULL,
  translate_model TEXT NOT NULL,
  cues INTEGER NOT NULL DEFAULT 0,
  untranslated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Tronçons de la vidéo dont les sous-titres traduits sont publiés (traduction
-- à la demande : les tronçons ne sont pas faits dans l'ordre).
CREATE TABLE IF NOT EXISTS commentary_chunks (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  keep_from REAL NOT NULL,
  keep_to REAL NOT NULL,
  PRIMARY KEY (match_id, idx)
);

CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER DEFAULT 0,
  detail TEXT DEFAULT ''
);
"#;

/// `AUTH_SCHEMA_SQL` : utilisateurs, sessions, paramètres.
pub const AUTH_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Seul le SHA-256 du jeton de session est stocké : une copie de la base ne
-- donne aucune session utilisable.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// `DUB_SCHEMA_SQL` : doublage français.
pub const DUB_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS dub_tracks (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  ok_id TEXT NOT NULL,
  commentary_key TEXT NOT NULL,
  -- Rôles de voix utilisés (JSON : ["A","B4",…]).
  voices TEXT NOT NULL DEFAULT '[]',
  -- Locuteurs reconnus et leur voix (JSON, voir dub.ts : SpeakerState).
  speakers TEXT NOT NULL DEFAULT '{}',
  complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dub_chunks (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ts REAL NOT NULL,
  end_ts REAL NOT NULL,
  file TEXT NOT NULL,
  -- Plages de parole française, en temps absolu de la vidéo (JSON [[s, e], …]).
  speech TEXT NOT NULL DEFAULT '[]',
  -- Empreinte des sous-titres doublés : un tronçon retraduit est redoublé.
  cues_sig TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, idx)
);
"#;

/// Conseil donné quand le dossier ou le fichier de la base n'est pas inscriptible.
const PERMISSION_HINT: &str = "Vérifiez que le volume est inscriptible par l'utilisateur du conteneur (uid 1000) : sur Unraid, chown -R 1000:1000 /mnt/user/appdata/basketland";

fn columns(c: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = st.query_map([], |r| r.get::<_, String>("name"))?;
    rows.collect()
}

/// `migrate` : migrations de colonnes, idempotentes (`CREATE TABLE IF NOT
/// EXISTS` ne modifie pas une table existante).
pub fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let cols = columns(c, "matches")?;
    // Type de flux du replay : 'hls' ou 'mp4' ; NULL sur les lignes antérieures.
    if !cols.iter().any(|n| n == "video_kind") {
        c.execute_batch("ALTER TABLE matches ADD COLUMN video_kind TEXT")?;
    }
    let track = columns(c, "commentary_tracks")?;
    // Piste complète (1) ou publication partielle (0) ; les pistes
    // antérieures, écrites d'un bloc, sont complètes.
    if !track.iter().any(|n| n == "complete") {
        c.execute_batch(
            "ALTER TABLE commentary_tracks ADD COLUMN complete INTEGER NOT NULL DEFAULT 0",
        )?;
        c.execute_batch("UPDATE commentary_tracks SET complete = 1")?;
    }
    // Découpage de la piste : durée d'un tronçon et nombre total.
    if !track.iter().any(|n| n == "chunk_sec") {
        c.execute_batch("ALTER TABLE commentary_tracks ADD COLUMN chunk_sec INTEGER")?;
    }
    if !track.iter().any(|n| n == "chunks_total") {
        c.execute_batch("ALTER TABLE commentary_tracks ADD COLUMN chunks_total INTEGER")?;
    }
    // Mise en relief d'un sous-titre (0 ton normal, 1 voix qui monte, 2 moment fort).
    if !columns(c, "commentary_cues")?
        .iter()
        .any(|n| n == "emphasis")
    {
        c.execute_batch(
            "ALTER TABLE commentary_cues ADD COLUMN emphasis INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    // Doublage français (tables nouvelles).
    c.execute_batch(DUB_SCHEMA_SQL)
}

/// Crée la base au besoin et applique schéma et migrations (`openDatabase`).
/// Erreurs : message de Node, avec le conseil sur les droits du volume.
pub fn ensure_schema(file: &Path) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            format!(
                "Impossible de créer le répertoire de la base ({}) : {e}. {PERMISSION_HINT}",
                dir.display()
            )
        })?;
    }
    let c = Connection::open(file).map_err(|e| {
        format!(
            "Impossible d'ouvrir la base SQLite ({}) : {e}. {PERMISSION_HINT}",
            file.display()
        )
    })?;
    let run = || -> rusqlite::Result<()> {
        c.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )?;
        c.execute_batch(SCHEMA_SQL)?;
        c.execute_batch(AUTH_SCHEMA_SQL)?;
        migrate(&c)
    };
    run().map_err(|e| format!("schéma de la base ({}) : {e}", file.display()))
}
