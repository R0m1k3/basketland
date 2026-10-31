//! Accès à la base SQLite PARTAGÉE avec l'application Node (même fichier,
//! mode WAL). Le schéma et ses migrations restent côté Node tant que toutes
//! les écritures n'ont pas été reprises : ici, on ne crée jamais la base.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OpenFlags, Row};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Emplacement de la base, comme `src/lib/db.ts` : `DB_PATH`, sinon `DATA_DIR`
/// (ou `/data` s'il existe, sinon `./data`) + `basketland.db`.
pub fn default_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("DB_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let dir = match std::env::var("DATA_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ if Path::new("/data").exists() => PathBuf::from("/data"),
        _ => std::env::current_dir().unwrap_or_default().join("data"),
    };
    dir.join("basketland.db")
}

#[derive(Clone)]
pub struct Db {
    path: PathBuf,
    conn: Arc<Mutex<Option<Connection>>>,
}

pub type DbResult<T> = Result<T, String>;

impl Db {
    pub fn new(path: PathBuf) -> Self {
        Db {
            path,
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// Exécute `f` sur la connexion (ouverte au premier besoin, sans créer le fichier).
    /// Appelé hors du runtime asynchrone (`spawn_blocking`).
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> DbResult<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let c = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|e| {
                format!(
                    "unable to open database file ({}): {e}",
                    self.path.display()
                )
            })?;
            c.busy_timeout(std::time::Duration::from_millis(5000))
                .map_err(|e| e.to_string())?;
            c.execute_batch("PRAGMA foreign_keys = ON;")
                .map_err(|e| e.to_string())?;
            *guard = Some(c);
        }
        let res = f(guard.as_ref().expect("connexion ouverte"));
        if let Err(rusqlite::Error::SqliteFailure(e, _)) = &res {
            // Fichier remplacé, disque… : on rouvrira au prochain appel.
            if matches!(
                e.code,
                rusqlite::ErrorCode::CannotOpen | rusqlite::ErrorCode::NotADatabase
            ) {
                *guard = None;
            }
        }
        res.map_err(|e| e.to_string())
    }

    /// Connexion à part, ouverte pour l'occasion : pour un travail long
    /// (scrypt…) qui ne doit pas bloquer la connexion partagée.
    pub async fn run_own<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> DbResult<T> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let own = Db::new(path);
            own.with(f)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// `with` depuis le code asynchrone.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> DbResult<T> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.with(f))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// Valeur SQLite → JSON (entier, réel, texte, NULL), comme la lirait `node:sqlite`.
pub fn sql_to_json(v: SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::from(i),
        SqlValue::Real(f) => crate::api::js_num_value(f),
        SqlValue::Text(s) => Value::from(s),
        SqlValue::Blob(_) => Value::Null,
    }
}

/// Colonne facultative (absente d'une base pas encore migrée) : NULL.
pub fn col(row: &Row, name: &str) -> SqlValue {
    row.get::<_, SqlValue>(name).unwrap_or(SqlValue::Null)
}

pub fn col_text(row: &Row, name: &str) -> Option<String> {
    match col(row, name) {
        SqlValue::Text(s) => Some(s),
        SqlValue::Integer(i) => Some(i.to_string()),
        SqlValue::Real(f) => Some(f.to_string()),
        _ => None,
    }
}

pub fn col_int(row: &Row, name: &str) -> Option<i64> {
    match col(row, name) {
        SqlValue::Integer(i) => Some(i),
        SqlValue::Real(f) => Some(f as i64),
        _ => None,
    }
}

// ---------------------------------------------------------------- journal

#[derive(Debug, Clone)]
pub struct IngestLog {
    pub task: String,
    pub finished_at: Option<String>,
    pub ok: bool,
    pub detail: Option<String>,
}

fn ingest_row(r: &Row) -> rusqlite::Result<IngestLog> {
    Ok(IngestLog {
        task: col_text(r, "task").unwrap_or_default(),
        finished_at: col_text(r, "finished_at"),
        ok: col_int(r, "ok").unwrap_or(0) != 0,
        detail: col_text(r, "detail"),
    })
}

pub fn last_ingests(c: &Connection, limit: i64) -> rusqlite::Result<Vec<IngestLog>> {
    let mut st = c.prepare("SELECT * FROM ingest_log ORDER BY id DESC LIMIT ?1")?;
    let rows = st.query_map([limit], ingest_row)?;
    rows.collect()
}

pub fn last_successful_ingest(c: &Connection) -> rusqlite::Result<Option<IngestLog>> {
    let mut st = c.prepare("SELECT * FROM ingest_log WHERE ok = 1 ORDER BY id DESC LIMIT 1")?;
    let mut rows = st.query_map([], ingest_row)?;
    rows.next().transpose()
}

pub fn count_all_matches(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT COUNT(*) FROM matches", [], |r| r.get(0))
}

// ---------------------------------------------------------------- matchs

/// Filtres de `listMatches` / `countMatches`.
#[derive(Debug, Default, Clone)]
pub struct MatchFilters {
    pub league: Option<String>,
    pub status: Option<String>,
    pub season: Option<f64>,
    pub team: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub video: Option<bool>,
    pub limit: i64,
    pub offset: i64,
    pub desc: bool,
}

fn where_for(f: &MatchFilters) -> (String, Vec<SqlValue>) {
    let mut clauses = vec!["league = ?".to_string()];
    let mut params = vec![SqlValue::Text(
        f.league.clone().unwrap_or_else(|| "nba".into()),
    )];
    if let Some(s) = &f.status {
        clauses.push("status = ?".into());
        params.push(SqlValue::Text(s.clone()));
    }
    if let Some(s) = f.season {
        clauses.push("season = ?".into());
        params.push(if s.fract() == 0.0 {
            SqlValue::Integer(s as i64)
        } else {
            SqlValue::Real(s)
        });
    }
    if let Some(t) = &f.team {
        clauses.push("(home_abbr = ? OR away_abbr = ?)".into());
        // `toUpperCase()` de JavaScript.
        let up = t.to_uppercase();
        params.push(SqlValue::Text(up.clone()));
        params.push(SqlValue::Text(up));
    }
    if let Some(v) = &f.from {
        clauses.push("date_utc >= ?".into());
        params.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &f.to {
        clauses.push("date_utc < ?".into());
        params.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = f.video {
        clauses.push("video_available = ?".into());
        params.push(SqlValue::Integer(v as i64));
    }
    (clauses.join(" AND "), params)
}

/// Replay connu du proxy vidéo : `listMatches({ videoOkId, video: true,
/// leagueAny: true, limit: 1 })` non vide (toutes ligues confondues).
pub fn video_ok_id_known(c: &Connection, ok_id: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM matches WHERE video_available = ?1 AND video_ok_id = ?2)",
        rusqlite::params![1, ok_id],
        |r| r.get(0),
    )
}

/// Ligne `matches` (colonnes utiles à l'API).
#[derive(Debug, Clone)]
pub struct MatchRow {
    pub id: i64,
    pub espn_id: String,
    pub league: String,
    pub season: SqlValue,
    pub season_type: String,
    pub date_utc: String,
    pub home_abbr: String,
    pub home_name: String,
    pub away_abbr: String,
    pub away_name: String,
    pub home_score: SqlValue,
    pub away_score: SqlValue,
    pub status: String,
    pub status_detail: Option<String>,
    pub period: SqlValue,
    pub clock_display: Option<String>,
    pub venue: Option<String>,
    pub broadcast: Option<String>,
    pub video_ok_id: Option<String>,
    pub video_duration: SqlValue,
    pub video_available: bool,
    pub video_checked_at: Option<String>,
    pub video_kind: Option<String>,
}

pub fn match_row(r: &Row) -> rusqlite::Result<MatchRow> {
    Ok(MatchRow {
        id: r.get("id")?,
        espn_id: col_text(r, "espn_id").unwrap_or_default(),
        league: col_text(r, "league").unwrap_or_default(),
        season: col(r, "season"),
        season_type: col_text(r, "season_type").unwrap_or_default(),
        date_utc: col_text(r, "date_utc").unwrap_or_default(),
        home_abbr: col_text(r, "home_abbr").unwrap_or_default(),
        home_name: col_text(r, "home_name").unwrap_or_default(),
        away_abbr: col_text(r, "away_abbr").unwrap_or_default(),
        away_name: col_text(r, "away_name").unwrap_or_default(),
        home_score: col(r, "home_score"),
        away_score: col(r, "away_score"),
        status: col_text(r, "status").unwrap_or_default(),
        status_detail: col_text(r, "status_detail"),
        period: col(r, "period"),
        clock_display: col_text(r, "clock_display"),
        venue: col_text(r, "venue"),
        broadcast: col_text(r, "broadcast"),
        video_ok_id: col_text(r, "video_ok_id"),
        video_duration: col(r, "video_duration"),
        video_available: col_int(r, "video_available").unwrap_or(0) != 0,
        video_checked_at: col_text(r, "video_checked_at"),
        video_kind: col_text(r, "video_kind"),
    })
}

pub fn list_matches(c: &Connection, f: &MatchFilters) -> rusqlite::Result<Vec<MatchRow>> {
    let (w, mut params) = where_for(f);
    let order = if f.desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT * FROM matches WHERE {w} ORDER BY date_utc {order}, id {order} LIMIT ? OFFSET ?"
    );
    params.push(SqlValue::Integer(f.limit.clamp(1, 1000)));
    params.push(SqlValue::Integer(f.offset.max(0)));
    let mut st = c.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(params), match_row)?;
    rows.collect()
}

pub fn count_matches(c: &Connection, f: &MatchFilters) -> rusqlite::Result<i64> {
    let (w, params) = where_for(f);
    c.query_row(
        &format!("SELECT COUNT(*) FROM matches WHERE {w}"),
        params_from_iter(params),
        |r| r.get(0),
    )
}

// ---------------------------------------------------------------- sessions

#[derive(Debug, Clone)]
pub struct SessionWithUser {
    pub user_id: i64,
    pub username: String,
    pub role: String,
    pub expires_at: String,
}

pub fn session_with_user(
    c: &Connection,
    token_hash: &str,
) -> rusqlite::Result<Option<SessionWithUser>> {
    let mut st = c.prepare(
        "SELECT s.user_id, s.expires_at, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1",
    )?;
    let mut rows = st.query_map([token_hash], |r| {
        Ok(SessionWithUser {
            user_id: r.get("user_id")?,
            expires_at: col_text(r, "expires_at").unwrap_or_default(),
            username: col_text(r, "username").unwrap_or_default(),
            role: col_text(r, "role").unwrap_or_default(),
        })
    })?;
    rows.next().transpose()
}

pub fn extend_session(c: &Connection, token_hash: &str, expires_at: &str) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2",
        [expires_at, token_hash],
    )
    .map(|_| ())
}

pub fn delete_session(c: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    c.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])
        .map(|_| ())
}

// ---------------------------------------------------------------- fiche d'un match

pub fn get_match(c: &Connection, id: i64) -> rusqlite::Result<Option<MatchRow>> {
    let mut st = c.prepare("SELECT * FROM matches WHERE id = ?1")?;
    let mut rows = st.query_map([id], match_row)?;
    rows.next().transpose()
}

/// Match terminé dont les statistiques ont déjà été récupérées.
pub fn stats_synced(c: &Connection, id: i64) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT stats_synced_at IS NOT NULL FROM matches WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
}

fn parsed(s: Option<String>) -> Value {
    s.and_then(|s| crate::jsval::js_parse(&s))
        .unwrap_or(Value::Null)
}

/// `getTeamStats` : (équipe, stats).
pub fn team_stats(c: &Connection, id: i64) -> rusqlite::Result<Vec<(String, Value)>> {
    let mut st = c.prepare("SELECT * FROM team_stats WHERE match_id = ?1 ORDER BY team_abbr")?;
    let rows = st.query_map([id], |r| {
        Ok((
            col_text(r, "team_abbr").unwrap_or_default(),
            parsed(col_text(r, "stats_json")),
        ))
    })?;
    rows.collect()
}

#[derive(Debug, Clone)]
pub struct PlayerStat {
    pub team_abbr: String,
    pub player_id: Value,
    pub player_name: Value,
    pub position: Value,
    pub jersey: Value,
    pub starter: bool,
    pub stats: Value,
}

pub fn player_stats(c: &Connection, id: i64) -> rusqlite::Result<Vec<PlayerStat>> {
    let mut st = c.prepare(
        "SELECT * FROM player_stats WHERE match_id = ?1 ORDER BY team_abbr, starter DESC, rowid",
    )?;
    let rows = st.query_map([id], |r| {
        Ok(PlayerStat {
            team_abbr: col_text(r, "team_abbr").unwrap_or_default(),
            player_id: sql_to_json(col(r, "player_id")),
            player_name: sql_to_json(col(r, "player_name")),
            position: sql_to_json(col(r, "position")),
            jersey: sql_to_json(col(r, "jersey")),
            starter: match col(r, "starter") {
                SqlValue::Integer(i) => i != 0,
                SqlValue::Real(f) => f != 0.0,
                SqlValue::Text(s) => !s.is_empty(),
                _ => false,
            },
            stats: parsed(col_text(r, "stats_json")),
        })
    })?;
    rows.collect()
}

/// Lignes d'une requête, colonnes dans l'ordre du SELECT (comme `all()` de node:sqlite).
fn rows_as_objects(c: &Connection, sql: &str, id: i64) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare(sql)?;
    let names: Vec<String> = st.column_names().into_iter().map(str::to_string).collect();
    let rows = st.query_map([id], |r| {
        let mut m = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_to_json(r.get::<_, SqlValue>(i)?));
        }
        Ok(Value::Object(m))
    })?;
    rows.collect()
}

pub fn leaders(c: &Connection, id: i64) -> rusqlite::Result<Vec<Value>> {
    rows_as_objects(
        c,
        "SELECT team_abbr, category, label, player, value FROM match_leaders WHERE match_id = ?1",
        id,
    )
}

pub fn clips(c: &Connection, id: i64) -> rusqlite::Result<Vec<Value>> {
    rows_as_objects(
        c,
        "SELECT id, match_id, video_ts, duration, text_fr, created_at FROM user_clips WHERE match_id = ?1 ORDER BY video_ts",
        id,
    )
}

// ---------------------------------------------------------------- cache clé/valeur

/// `kvGet` : valeur en cache si plus récente que `max_age_ms` (`None` : sans limite).
pub fn kv_get(
    c: &Connection,
    key: &str,
    max_age_ms: Option<i64>,
) -> rusqlite::Result<Option<Value>> {
    kv_get_at(c, key, max_age_ms, chrono::Utc::now())
}

/// `kv_get` à un instant donné (pages, tests).
pub fn kv_get_at(
    c: &Connection,
    key: &str,
    max_age_ms: Option<i64>,
    now: chrono::DateTime<chrono::Utc>,
) -> rusqlite::Result<Option<Value>> {
    let mut st = c.prepare("SELECT value, updated_at FROM kv_cache WHERE key = ?1")?;
    let mut rows = st.query_map([key], |r| {
        Ok((
            col_text(r, "value").unwrap_or_default(),
            col_text(r, "updated_at").unwrap_or_default(),
        ))
    })?;
    let Some((value, updated)) = rows.next().transpose()? else {
        return Ok(None);
    };
    if let Some(max) = max_age_ms {
        // Date illisible : Date.parse → NaN, la comparaison échoue et la valeur est servie.
        if let Some(at) = crate::time::parse_instant(&updated) {
            if (now - at).num_milliseconds() > max {
                return Ok(None);
            }
        }
    }
    Ok(crate::jsval::js_parse(&value))
}

pub fn kv_set(c: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR REPLACE INTO kv_cache (key, value, updated_at) VALUES (?1, ?2, ?3)",
        [
            key,
            &value.to_string(),
            &crate::time::iso_utc(chrono::Utc::now()),
        ],
    )
    .map(|_| ())
}
