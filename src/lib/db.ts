/**
 * Couche d'accès SQLite.
 *
 * Choix technique : on utilise le module SQLite **intégré à Node** (`node:sqlite`,
 * non flaggé depuis Node 22.13) plutôt que better-sqlite3. Avantages : aucune
 * compilation native, aucune toolchain (python3/make/g++) dans l'image, API
 * synchrone équivalente. Voir README § « Choix techniques ».
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { ReplayRecheckWindow } from './replayCadence';
import type {
  AnchorRow,
  CutInterval,
  LeaderRow,
  MatchRow,
  MatchStatus,
  ParsedMatch,
  PlayRow,
  PlayerStatRow,
  SubtitleRow,
  SyncSettings,
  TeamStatRow,
} from './types';

type Params = Record<string, SQLInputValue>;

// `node:sqlite` est chargé via require au runtime : évite que le bundler tente
// de le résoudre et garde le warning « experimental » silencieux côté build.
const nodeRequire = createRequire(import.meta.url);

export const SCHEMA_SQL = `
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
`;

export function dataDir(): string {
  return process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
}

const g = globalThis as unknown as { __basketlandDb?: DatabaseSyncType };

export function openDatabase(file: string): DatabaseSyncType {
  const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
  if (file !== ':memory:') {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (e) {
      // Un volume Unraid monte sur /data remplace le répertoire de l'image :
      // le `chown node:node` du Dockerfile est alors perdu, et si le
      // dossier appartient à root, l'utilisateur `node` (uid 1000) ne peut
      // plus écrire. On explique le problème au lieu d'un crash opaque.
      throw new Error(
        `Impossible de créer le répertoire de la base (${path.dirname(file)}) : ${(e as Error).message}. ` +
          `Vérifiez que le volume est inscriptible par l'utilisateur du conteneur (uid 1000) : ` +
          `sur Unraid, chown -R 1000:1000 /mnt/user/appdata/basketland`,
      );
    }
  }
  let db: DatabaseSyncType;
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    // Le répertoire peut exister (volume monté) sans être inscriptible :
    // mkdirSync passe alors, et c'est SQLite qui échoue avec un
    // « unable to open database file » sans piste.
    throw new Error(
      `Impossible d'ouvrir la base SQLite (${file}) : ${(e as Error).message}. ` +
        `Vérifiez que le volume est inscriptible par l'utilisateur du conteneur (uid 1000) : ` +
        `sur Unraid, chown -R 1000:1000 /mnt/user/appdata/basketland`,
      { cause: e },
    );
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  db.exec(AUTH_SCHEMA_SQL); // utilisateurs, sessions, paramètres : bloc « authentification » en fin de fichier
  migrate(db);
  return db;
}

/**
 * Migrations de colonnes, idempotentes : `CREATE TABLE IF NOT EXISTS` ne
 * modifie pas une table existante, une base déjà en service n'aurait donc
 * jamais les nouvelles colonnes.
 */
function migrate(db: DatabaseSyncType): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(matches)').all() as { name: string }[]).map((c) => c.name),
  );
  // Type de flux du replay : 'hls' (traitement ok.ru terminé) ou 'mp4'
  // (qualité « mobile » seule, en attendant le HLS). NULL sur les lignes
  // antérieures : un replay disponible sans type est considéré HLS.
  if (!cols.has('video_kind')) db.exec('ALTER TABLE matches ADD COLUMN video_kind TEXT');
  const trackCols = new Set(
    (db.prepare('PRAGMA table_info(commentary_tracks)').all() as { name: string }[]).map((c) => c.name),
  );
  // Piste complète (1) ou publication partielle (0, sous-titres progressifs).
  // Les pistes antérieures étaient écrites d'un bloc à la fin du travail :
  // elles sont complètes.
  if (!trackCols.has('complete')) {
    db.exec('ALTER TABLE commentary_tracks ADD COLUMN complete INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE commentary_tracks SET complete = 1');
  }
  // Découpage de la piste (traduction à la demande, tronçons publiés dans le
  // désordre) : durée d'un tronçon et nombre total. NULL : piste antérieure,
  // publiée d'un bloc ou en préfixe continu.
  if (!trackCols.has('chunk_sec')) db.exec('ALTER TABLE commentary_tracks ADD COLUMN chunk_sec INTEGER');
  if (!trackCols.has('chunks_total')) db.exec('ALTER TABLE commentary_tracks ADD COLUMN chunks_total INTEGER');
  // Mise en relief d'un sous-titre (0 ton normal, 1 voix qui monte, 2 moment
  // fort), tirée de l'intensité de la voix des commentateurs.
  const cueCols = new Set(
    (db.prepare('PRAGMA table_info(commentary_cues)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cueCols.has('emphasis')) db.exec('ALTER TABLE commentary_cues ADD COLUMN emphasis INTEGER NOT NULL DEFAULT 0');
  // Doublage français (tables nouvelles, voir DUB_SCHEMA_SQL).
  db.exec(DUB_SCHEMA_SQL);
}

export function getDb(): DatabaseSyncType {
  if (!g.__basketlandDb) {
    g.__basketlandDb = openDatabase(process.env.DB_PATH || path.join(dataDir(), 'basketland.db'));
  }
  return g.__basketlandDb;
}

/** Permet aux tests d'injecter une base en mémoire. */
export function setDbForTests(db: DatabaseSyncType | undefined): void {
  g.__basketlandDb = db;
}

const nowIso = () => new Date().toISOString();

function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function all<T>(sql: string, params: Params = {}): T[] {
  return getDb().prepare(sql).all(params) as unknown as T[];
}
function one<T>(sql: string, params: Params = {}): T | undefined {
  return getDb().prepare(sql).get(params) as unknown as T | undefined;
}
function run(sql: string, params: Params = {}) {
  return getDb().prepare(sql).run(params);
}

// ---------------------------------------------------------------- matches

export function upsertMatch(m: ParsedMatch): void {
  const now = nowIso();
  run(
    `INSERT INTO matches (id, espn_id, league, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name,
       home_score, away_score, status, status_detail, period, clock_display, venue, broadcast, created_at, updated_at)
     VALUES ($id, $espn_id, $league, $season, $season_type, $date_utc, $home_abbr, $home_name, $away_abbr, $away_name,
       $home_score, $away_score, $status, $status_detail, $period, $clock_display, $venue, $broadcast, $now, $now)
     ON CONFLICT(id) DO UPDATE SET
       season = excluded.season, season_type = excluded.season_type, date_utc = excluded.date_utc,
       home_abbr = excluded.home_abbr, home_name = excluded.home_name,
       away_abbr = excluded.away_abbr, away_name = excluded.away_name,
       home_score = excluded.home_score, away_score = excluded.away_score,
       status = excluded.status, status_detail = excluded.status_detail,
       period = excluded.period, clock_display = excluded.clock_display,
       venue = CASE WHEN excluded.venue <> '' THEN excluded.venue ELSE matches.venue END,
       broadcast = CASE WHEN excluded.broadcast <> '' THEN excluded.broadcast ELSE matches.broadcast END,
       updated_at = excluded.updated_at`,
    { ...m, now } as unknown as Params,
  );
}

export function upsertMatches(list: ParsedMatch[]): number {
  tx(() => list.forEach(upsertMatch));
  return list.length;
}

export function getMatch(id: number): MatchRow | undefined {
  return one<MatchRow>('SELECT * FROM matches WHERE id = $id', { id });
}

export interface MatchFilters {
  status?: MatchStatus;
  season?: number;
  team?: string;
  league?: string;
  from?: string; // ISO UTC inclusif
  to?: string; // ISO UTC exclusif
  video?: boolean;
  /** Restreint aux matchs portant cet identifiant de flux ok.ru. */
  videoOkId?: string;
  /**
   * Ne filtre pas sur la ligue.
   *
   * Utilisé par le proxy vidéo, qui doit servir n'importe quel replay
   * connu en base : un filtre `league = 'nba'` refuserait par exemple un
   * replay WNBA alors que l'identifiant est valide.
   */
  leagueAny?: boolean;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

function whereFor(f: MatchFilters): { sql: string; params: Params } {
  const clauses: string[] = [];
  const params: Params = {};
  // La clause sur la ligue n'est imposée que si le filtre en demande une
  // (ou si `leagueAny` n'est pas positionné) : une recherche par
  // identifiant de flux doit pouvoir porter sur n'importe quelle ligue,
  // sinon un replay hors NBA serait refusé par le proxy.
  if (f.leagueAny) {
    // pas de filtre de ligue
  } else {
    clauses.push('league = $league');
    params.league = f.league ?? 'nba';
  }
  if (f.status) {
    clauses.push('status = $status');
    params.status = f.status;
  }
  if (f.season) {
    clauses.push('season = $season');
    params.season = f.season;
  }
  if (f.team) {
    clauses.push('(home_abbr = $team OR away_abbr = $team)');
    params.team = f.team.toUpperCase();
  }
  if (f.from) {
    clauses.push('date_utc >= $from');
    params.from = f.from;
  }
  if (f.to) {
    clauses.push('date_utc < $to');
    params.to = f.to;
  }
  if (f.video !== undefined) {
    clauses.push('video_available = $video');
    params.video = f.video ? 1 : 0;
  }
  if (f.videoOkId) {
    clauses.push('video_ok_id = $videoOkId');
    params.videoOkId = f.videoOkId;
  }
  return { sql: clauses.join(' AND '), params };
}

export function listMatches(f: MatchFilters = {}): MatchRow[] {
  const { sql, params } = whereFor(f);
  const order = f.order === 'desc' ? 'DESC' : 'ASC';
  // `whereFor` peut ne produire AUCUNE clause (ex. `leagueAny` sans autre
  // filtre) : un `WHERE` vide donne une erreur SQL. On n'écrit `WHERE` que
  // s'il y a quelque chose à filtrer.
  const where = sql ? `WHERE ${sql}` : '';
  return all<MatchRow>(`SELECT * FROM matches ${where} ORDER BY date_utc ${order}, id ${order} LIMIT $limit OFFSET $offset`, {
    ...params,
    limit: Math.min(Math.max(f.limit ?? 50, 1), 1000),
    offset: Math.max(f.offset ?? 0, 0),
  });
}

export function countMatches(f: MatchFilters = {}): number {
  const { sql, params } = whereFor(f);
  const where = sql ? `WHERE ${sql}` : '';
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM matches ${where}`, params)?.n ?? 0;
}

export function listTeams(league = 'nba'): { abbr: string; name: string }[] {
  return all<{ abbr: string; name: string }>(
    `SELECT abbr, name FROM (
       SELECT home_abbr AS abbr, home_name AS name FROM matches WHERE league = $league
       UNION SELECT away_abbr, away_name FROM matches WHERE league = $league)
     GROUP BY abbr ORDER BY name`,
    { league },
  );
}

export function listSeasons(league = 'nba'): number[] {
  return all<{ season: number }>('SELECT DISTINCT season FROM matches WHERE league = $league ORDER BY season DESC', { league }).map(
    (r) => r.season,
  );
}

export function finalMatchesNeedingStats(limit = 20): MatchRow[] {
  return all<MatchRow>(
    `SELECT * FROM matches WHERE status = 'final' AND stats_synced_at IS NULL ORDER BY date_utc DESC LIMIT $limit`,
    { limit },
  );
}

export function liveMatches(): MatchRow[] {
  return all<MatchRow>(`SELECT * FROM matches WHERE status = 'live' ORDER BY date_utc`);
}

export type VideoKind = 'hls' | 'mp4';

/**
 * Matchs terminés dont le replay est à (re)chercher : sans replay, OU
 * trouvé en MP4 seul (pour passer en HLS dès qu'ok.ru a fini le
 * traitement).
 *
 * Cadence (voir `replayCadence.ts`) : un match sans replay terminé depuis
 * moins de 12 h (`date_utc >= recentSince`) est revérifié dès que sa
 * dernière vérification est antérieure à `recentRecheckBefore` (≈ 20 min) ;
 * les autres, MP4 compris, à `recheckBefore` (≈ 2 h). Les plus récents
 * d'abord : ce sont ceux qu'on attend.
 */
export function finalMatchesNeedingVideo(w: ReplayRecheckWindow, limit = 30): (MatchRow & { video_kind: string | null })[] {
  return all<MatchRow & { video_kind: string | null }>(
    `SELECT * FROM matches WHERE status = 'final' AND (video_available = 0 OR video_kind = 'mp4') AND date_utc >= $since
       AND (video_checked_at IS NULL OR video_checked_at < $recheck
            OR (video_available = 0 AND date_utc >= $recentSince AND video_checked_at < $recentRecheck))
     ORDER BY date_utc DESC LIMIT $limit`,
    { since: w.since, recheck: w.recheckBefore, recentSince: w.recentSince, recentRecheck: w.recentRecheckBefore, limit },
  );
}

/**
 * Matchs terminés depuis `sinceIso`, avec replay, sans ancre OCR ('auto') :
 * candidats à l'analyse automatique (les plus récents d'abord).
 */
/**
 * Matchs à analyser automatiquement.
 *
 * Un replay encore en MP4 seul (`video_kind = 'mp4'`) est exclu : ok.ru n'a
 * alors que la qualité « mobile », trop petite pour lire le chrono. Chaque
 * tentative échouerait et consommerait le backoff ; le match revient ici dès
 * que `syncVideos` le fait passer en HLS.
 */
export function finalMatchesNeedingAnalysis(sinceIso: string, limit = 30): MatchRow[] {
  return all<MatchRow>(
    `SELECT * FROM matches m WHERE m.status = 'final' AND m.video_available = 1 AND m.video_ok_id IS NOT NULL
       AND COALESCE(m.video_kind, 'hls') = 'hls'
       AND m.date_utc >= $since
       AND NOT EXISTS (SELECT 1 FROM sync_anchors a WHERE a.match_id = m.id AND a.method = 'auto')
     ORDER BY m.date_utc DESC LIMIT $limit`,
    { since: sinceIso, limit },
  );
}

export function setVideo(
  matchId: number,
  v: { slug: string | null; okId: string | null; duration: number | null; available: boolean; kind?: VideoKind | null },
): void {
  run(
    `UPDATE matches SET slug = $slug, video_ok_id = $okId, video_duration = $duration, video_available = $available,
       video_kind = $kind, video_checked_at = $now, updated_at = $now WHERE id = $id`,
    {
      id: matchId,
      slug: v.slug,
      okId: v.okId,
      duration: v.duration,
      available: v.available ? 1 : 0,
      // Pas de type sans replay lisible.
      kind: v.available ? (v.kind ?? 'hls') : null,
      now: nowIso(),
    },
  );
}

export function markVideoChecked(matchId: number): void {
  run('UPDATE matches SET video_checked_at = $now WHERE id = $id', { id: matchId, now: nowIso() });
}

export function markStatsSynced(matchId: number): void {
  run('UPDATE matches SET stats_synced_at = $now WHERE id = $id', { id: matchId, now: nowIso() });
}

// ---------------------------------------------------------------- stats

export function replaceStats(matchId: number, teams: TeamStatRow[], players: PlayerStatRow[], leaders: LeaderRow[]): void {
  tx(() => {
    run('DELETE FROM team_stats WHERE match_id = $id', { id: matchId });
    run('DELETE FROM player_stats WHERE match_id = $id', { id: matchId });
    run('DELETE FROM match_leaders WHERE match_id = $id', { id: matchId });
    const ts = getDb().prepare('INSERT INTO team_stats (match_id, team_abbr, stats_json) VALUES ($m, $t, $s)');
    for (const t of teams) ts.run({ m: matchId, t: t.team_abbr, s: JSON.stringify(t.stats) });
    const ps = getDb().prepare(
      `INSERT OR REPLACE INTO player_stats (match_id, team_abbr, player_id, player_name, position, jersey, starter, stats_json)
       VALUES ($m, $t, $pid, $name, $pos, $jersey, $starter, $s)`,
    );
    for (const p of players)
      ps.run({
        m: matchId,
        t: p.team_abbr,
        pid: p.player_id,
        name: p.player_name,
        pos: p.position,
        jersey: p.jersey,
        starter: p.starter,
        s: JSON.stringify(p.stats),
      });
    const ls = getDb().prepare(
      `INSERT OR REPLACE INTO match_leaders (match_id, team_abbr, category, label, player, value) VALUES ($m, $t, $c, $l, $p, $v)`,
    );
    for (const l of leaders) ls.run({ m: matchId, t: l.team_abbr, c: l.category, l: l.label, p: l.player, v: l.value });
  });
}

export function getTeamStats(matchId: number): TeamStatRow[] {
  return all<{ match_id: number; team_abbr: string; stats_json: string }>(
    'SELECT * FROM team_stats WHERE match_id = $id ORDER BY team_abbr',
    { id: matchId },
  ).map((r) => ({ match_id: r.match_id, team_abbr: r.team_abbr, stats: JSON.parse(r.stats_json) }));
}

export function getPlayerStats(matchId: number): PlayerStatRow[] {
  return all<{
    match_id: number;
    team_abbr: string;
    player_id: string;
    player_name: string;
    position: string;
    jersey: string;
    starter: number;
    stats_json: string;
  }>('SELECT * FROM player_stats WHERE match_id = $id ORDER BY team_abbr, starter DESC, rowid', { id: matchId }).map((r) => ({
    match_id: r.match_id,
    team_abbr: r.team_abbr,
    player_id: r.player_id,
    player_name: r.player_name,
    position: r.position,
    jersey: r.jersey,
    starter: r.starter,
    stats: JSON.parse(r.stats_json),
  }));
}

export function getLeaders(matchId: number): LeaderRow[] {
  return all<LeaderRow>('SELECT team_abbr, category, label, player, value FROM match_leaders WHERE match_id = $id', { id: matchId });
}

// ---------------------------------------------------------------- plays

export function replacePlays(matchId: number, plays: PlayRow[]): void {
  tx(() => {
    run('DELETE FROM plays WHERE match_id = $id', { id: matchId });
    const st = getDb().prepare(
      `INSERT INTO plays (match_id, seq, period, clock_display, clock_sec, wallclock, event_type, text_en, actor, team_abbr,
         home_score, away_score, scoring, is_key)
       VALUES ($match_id, $seq, $period, $clock_display, $clock_sec, $wallclock, $event_type, $text_en, $actor, $team_abbr,
         $home_score, $away_score, $scoring, $is_key)`,
    );
    for (const p of plays) {
      st.run({
        match_id: matchId,
        seq: p.seq,
        period: p.period,
        clock_display: p.clock_display,
        clock_sec: p.clock_sec,
        wallclock: p.wallclock,
        event_type: p.event_type,
        text_en: p.text_en,
        actor: p.actor,
        team_abbr: p.team_abbr,
        home_score: p.home_score,
        away_score: p.away_score,
        scoring: p.scoring,
        is_key: p.is_key,
      });
    }
  });
}

export function getPlays(matchId: number): PlayRow[] {
  return all<PlayRow>('SELECT * FROM plays WHERE match_id = $id ORDER BY seq', { id: matchId });
}

// ---------------------------------------------------------------- subtitles

export function replaceSubtitles(matchId: number, subs: Omit<SubtitleRow, 'match_id'>[]): void {
  tx(() => {
    run('DELETE FROM subtitles WHERE match_id = $id', { id: matchId });
    const st = getDb().prepare(
      `INSERT INTO subtitles (match_id, seq, video_ts, end_ts, text_fr, speaker, kind) VALUES ($m, $seq, $ts, $end, $text, $speaker, $kind)`,
    );
    for (const s of subs)
      st.run({ m: matchId, seq: s.seq, ts: s.video_ts, end: s.end_ts, text: s.text_fr, speaker: s.speaker, kind: s.kind });
  });
}

export function getSubtitles(matchId: number): SubtitleRow[] {
  return all<SubtitleRow>('SELECT * FROM subtitles WHERE match_id = $id ORDER BY video_ts, seq', { id: matchId });
}

// ---------------------------------------------------------------- sync

export function getAnchors(matchId: number): AnchorRow[] {
  return all<AnchorRow>('SELECT * FROM sync_anchors WHERE match_id = $id ORDER BY video_ts', { id: matchId });
}

export function upsertAnchor(a: AnchorRow): void {
  run(
    `INSERT INTO sync_anchors (match_id, period, clock_sec, video_ts, method, wallclock) VALUES ($match_id, $period, $clock_sec, $video_ts, $method, $wallclock)
     ON CONFLICT(match_id, period, clock_sec) DO UPDATE SET video_ts = excluded.video_ts, method = excluded.method, wallclock = excluded.wallclock`,
    a as unknown as Params,
  );
}

export function deleteAnchor(matchId: number, period: number, clockSec: number): void {
  run('DELETE FROM sync_anchors WHERE match_id = $m AND period = $p AND clock_sec = $c', { m: matchId, p: period, c: clockSec });
}

export function clearAnchors(matchId: number, methods: string[]): void {
  for (const method of methods) run('DELETE FROM sync_anchors WHERE match_id = $m AND method = $method', { m: matchId, method });
}

/** Remplace les ancres d'une méthode donnée (jamais les manuelles, sauf demande explicite). */
export function replaceAnchorsByMethod(matchId: number, method: 'auto' | 'audio', anchors: AnchorRow[]): void {
  tx(() => {
    run('DELETE FROM sync_anchors WHERE match_id = $m AND method = $method', { m: matchId, method });
    const st = getDb().prepare(
      `INSERT OR IGNORE INTO sync_anchors (match_id, period, clock_sec, video_ts, method, wallclock) VALUES ($match_id, $period, $clock_sec, $video_ts, $method, $wallclock)`,
    );
    for (const a of anchors) st.run({ ...a, match_id: matchId, method } as unknown as Params);
  });
}

export function getSyncSettings(matchId: number): SyncSettings {
  const r = one<{ match_id: number; global_offset: number; quarter_offsets_json: string; updated_at: string }>(
    'SELECT * FROM sync_settings WHERE match_id = $id',
    { id: matchId },
  );
  if (!r) return { match_id: matchId, global_offset: 0, quarter_offsets: {}, updated_at: '' };
  let q: Record<string, number> = {};
  try {
    q = JSON.parse(r.quarter_offsets_json) ?? {};
  } catch {
    q = {};
  }
  return { match_id: matchId, global_offset: r.global_offset, quarter_offsets: q, updated_at: r.updated_at };
}

export function saveSyncSettings(matchId: number, globalOffset: number, quarterOffsets: Record<string, number>): SyncSettings {
  const now = nowIso();
  run(
    `INSERT INTO sync_settings (match_id, global_offset, quarter_offsets_json, updated_at) VALUES ($m, $g, $q, $now)
     ON CONFLICT(match_id) DO UPDATE SET global_offset = excluded.global_offset, quarter_offsets_json = excluded.quarter_offsets_json, updated_at = excluded.updated_at`,
    { m: matchId, g: globalOffset, q: JSON.stringify(quarterOffsets), now },
  );
  return { match_id: matchId, global_offset: globalOffset, quarter_offsets: quarterOffsets, updated_at: now };
}

// ---------------------------------------------------------------- audio

export interface AudioProfile {
  match_id: number;
  ok_id: string;
  window_sec: number;
  rms_db: number[];
  cuts: CutInterval[];
  analyzed_at: string;
}

export function getAudioProfile(matchId: number): AudioProfile | undefined {
  const r = one<{ match_id: number; ok_id: string; window_sec: number; rms_db_json: string; cuts_json: string; analyzed_at: string }>(
    'SELECT * FROM audio_profiles WHERE match_id = $id',
    { id: matchId },
  );
  if (!r) return undefined;
  return {
    match_id: r.match_id,
    ok_id: r.ok_id,
    window_sec: r.window_sec,
    rms_db: JSON.parse(r.rms_db_json),
    cuts: JSON.parse(r.cuts_json),
    analyzed_at: r.analyzed_at,
  };
}

export function saveAudioProfile(p: Omit<AudioProfile, 'analyzed_at'>): void {
  run(
    `INSERT OR REPLACE INTO audio_profiles (match_id, ok_id, window_sec, rms_db_json, cuts_json, analyzed_at) VALUES ($m, $ok, $w, $rms, $cuts, $now)`,
    { m: p.match_id, ok: p.ok_id, w: p.window_sec, rms: JSON.stringify(p.rms_db), cuts: JSON.stringify(p.cuts), now: nowIso() },
  );
}

// ---------------------------------------------------------------- traduction des commentaires

export interface CommentaryCueRow {
  match_id: number;
  seq: number;
  start_ts: number;
  end_ts: number;
  text_en: string;
  text_fr: string;
  untranslated: number;
  /** 0 ton normal, 1 voix qui monte, 2 moment fort. */
  emphasis?: number;
}

export interface CommentaryTrackRow {
  match_id: number;
  ok_id: string;
  transcribe_model: string;
  translate_model: string;
  cues: number;
  untranslated: number;
  created_at: string;
  /** 1 : tout le match est traduit ; 0 : publication partielle (travail en cours ou interrompu). */
  complete: number;
  /** Durée d'un tronçon (s) ; null pour une piste antérieure à la traduction à la demande. */
  chunk_sec: number | null;
  chunks_total: number | null;
}

export interface CommentaryTrackMeta {
  ok_id: string;
  transcribe_model: string;
  translate_model: string;
  chunk_sec?: number | null;
  chunks_total?: number | null;
}

type CueInput = Omit<CommentaryCueRow, 'match_id'>;

function insertCues(matchId: number, cues: CueInput[]): void {
  const st = getDb().prepare(
    `INSERT OR REPLACE INTO commentary_cues (match_id, seq, start_ts, end_ts, text_en, text_fr, untranslated, emphasis)
     VALUES ($m, $seq, $start, $end, $en, $fr, $u, $e)`,
  );
  for (const c of cues)
    st.run({
      m: matchId,
      seq: c.seq,
      start: c.start_ts,
      end: c.end_ts,
      en: c.text_en,
      fr: c.text_fr,
      u: c.untranslated ? 1 : 0,
      e: Math.max(0, Math.min(2, Math.round(c.emphasis ?? 0))),
    });
}

/** Métadonnées de la piste ; compteurs recalculés sur les sous-titres en base. */
function writeTrack(matchId: number, track: CommentaryTrackMeta, complete: boolean): void {
  run(
    `INSERT OR REPLACE INTO commentary_tracks (match_id, ok_id, transcribe_model, translate_model, cues, untranslated, created_at, complete, chunk_sec, chunks_total)
     SELECT $m, $ok, $tm, $lm, COUNT(*), COALESCE(SUM(untranslated != 0), 0), $now, $c, $cs, $ct FROM commentary_cues WHERE match_id = $m`,
    {
      m: matchId,
      ok: track.ok_id,
      tm: track.transcribe_model,
      lm: track.translate_model,
      now: nowIso(),
      c: complete ? 1 : 0,
      cs: track.chunk_sec ?? null,
      ct: track.chunks_total ?? null,
    },
  );
}

// ---------------------------------------------------------------- traduction à la demande (tronçons)

/** Premier seq des sous-titres du tronçon `idx` (les tronçons sont publiés dans le désordre). */
export const chunkSeqBase = (idx: number) => (idx + 1) * 100_000;

/**
 * Ouvre (ou reprend) la piste d'un match pour un travail. Si la piste en
 * base vient d'une autre vidéo, d'autres modèles ou d'un autre découpage —
 * ou si `fresh` (relance explicite d'une piste complète) — elle est effacée :
 * on repart de zéro. Rend les index des tronçons déjà publiés.
 */
export function openCommentaryTrack(matchId: number, track: CommentaryTrackMeta, fresh = false): Set<number> {
  return tx(() => {
    const prev = getCommentaryTrack(matchId);
    const same =
      !!prev &&
      prev.ok_id === track.ok_id &&
      prev.transcribe_model === track.transcribe_model &&
      prev.translate_model === track.translate_model &&
      prev.chunk_sec === (track.chunk_sec ?? null) &&
      prev.chunks_total === (track.chunks_total ?? null);
    if (!same || fresh) {
      run('DELETE FROM commentary_cues WHERE match_id = $id', { id: matchId });
      run('DELETE FROM commentary_chunks WHERE match_id = $id', { id: matchId });
      run('DELETE FROM commentary_tracks WHERE match_id = $id', { id: matchId });
      // Sous-titres refaits de zéro : le doublage qui les disait n'est plus valable.
      run('DELETE FROM dub_chunks WHERE match_id = $id', { id: matchId });
      run('UPDATE dub_tracks SET complete = 0 WHERE match_id = $id', { id: matchId });
      return new Set<number>();
    }
    return new Set(all<{ idx: number }>('SELECT idx FROM commentary_chunks WHERE match_id = $id', { id: matchId }).map((r) => r.idx));
  });
}

/**
 * Publie les sous-titres traduits d'UN tronçon (remplace ceux qu'il avait
 * déjà), le marque fait, et marque la piste complète quand tous les
 * tronçons le sont.
 */
export function publishCommentaryChunk(
  matchId: number,
  track: CommentaryTrackMeta,
  chunk: { idx: number; keepFrom: number; keepTo: number },
  cues: CueInput[],
): { done: number; complete: boolean } {
  return tx(() => {
    const base = chunkSeqBase(chunk.idx);
    run('DELETE FROM commentary_cues WHERE match_id = $id AND seq >= $a AND seq < $b', { id: matchId, a: base, b: base + 100_000 });
    insertCues(matchId, cues);
    // Tronçon (re)traduit : son doublage éventuel disait les anciens sous-titres, il sera refait.
    run('DELETE FROM dub_chunks WHERE match_id = $id AND idx = $i', { id: matchId, i: chunk.idx });
    run('UPDATE dub_tracks SET complete = 0 WHERE match_id = $id', { id: matchId });
    run('INSERT OR REPLACE INTO commentary_chunks (match_id, idx, keep_from, keep_to) VALUES ($id, $i, $f, $t)', {
      id: matchId,
      i: chunk.idx,
      f: chunk.keepFrom,
      t: Number.isFinite(chunk.keepTo) ? chunk.keepTo : 1e9,
    });
    const done = one<{ n: number }>('SELECT COUNT(*) AS n FROM commentary_chunks WHERE match_id = $id', { id: matchId })?.n ?? 0;
    const complete = !!track.chunks_total && done >= track.chunks_total;
    writeTrack(matchId, track, complete);
    return { done, complete };
  });
}

/** Plages de vidéo couvertes par des tronçons publiés, fusionnées : [[début, fin], …]. */
export function commentaryCoverage(matchId: number): [number, number][] {
  const rows = all<{ keep_from: number; keep_to: number }>('SELECT keep_from, keep_to FROM commentary_chunks WHERE match_id = $id ORDER BY keep_from', {
    id: matchId,
  });
  const out: [number, number][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.keep_from <= last[1] + 0.5) last[1] = Math.max(last[1], r.keep_to);
    else out.push([r.keep_from, r.keep_to]);
  }
  return out;
}

/**
 * Sous-titres anglais qui précèdent `t` de moins de `window` secondes
 * (contexte de traduction d'un tronçon : seulement si le tronçon d'avant est
 * déjà traduit, pas un passage lointain).
 */
export function commentaryCuesBefore(matchId: number, t: number, limit: number, window = 30): string[] {
  return all<{ text_en: string }>(
    'SELECT text_en FROM commentary_cues WHERE match_id = $id AND start_ts < $t AND start_ts >= $from ORDER BY start_ts DESC LIMIT $n',
    { id: matchId, t, from: t - window, n: limit },
  )
    .map((r) => r.text_en)
    .reverse();
}

/**
 * État de la VF des matchs `ids` pour les badges des listes : complète, ou
 * part traduite (tronçons publiés / total) d'une piste partielle — pour le
 * replay ACTUEL seulement.
 */
export function commentaryProgressByIds(ids: number[]): Map<number, { complete: boolean; done: number; total: number }> {
  const list = [...new Set(ids.filter((n) => Number.isInteger(n)))];
  const out = new Map<number, { complete: boolean; done: number; total: number }>();
  if (!list.length) return out;
  for (const r of all<{ match_id: number; complete: number; chunks_total: number | null; done: number }>(
    `SELECT t.match_id, t.complete, t.chunks_total, (SELECT COUNT(*) FROM commentary_chunks c WHERE c.match_id = t.match_id) AS done
       FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
      WHERE t.ok_id = m.video_ok_id AND t.cues > 0 AND t.match_id IN (SELECT value FROM json_each($ids))`,
    { ids: JSON.stringify(list) },
  )) {
    out.set(r.match_id, { complete: r.complete === 1, done: r.done, total: r.chunks_total ?? 0 });
  }
  return out;
}

/** Remplace d'un bloc la piste traduite d'un match (sous-titres + métadonnées), marquée complète. */
export function replaceCommentary(matchId: number, track: CommentaryTrackMeta, cues: CueInput[]): void {
  tx(() => {
    run('DELETE FROM commentary_cues WHERE match_id = $id', { id: matchId });
    run('DELETE FROM commentary_chunks WHERE match_id = $id', { id: matchId });
    insertCues(matchId, cues);
    writeTrack(matchId, track, true);
  });
}

export function getCommentaryTrack(matchId: number): CommentaryTrackRow | undefined {
  return one<CommentaryTrackRow>('SELECT * FROM commentary_tracks WHERE match_id = $id', { id: matchId });
}

export function getCommentaryCues(matchId: number): CommentaryCueRow[] {
  return all<CommentaryCueRow>('SELECT * FROM commentary_cues WHERE match_id = $id ORDER BY start_ts, seq', { id: matchId });
}

/** Sous-titres publiés restés en anglais (traduction impossible), dans l'ordre de la vidéo. */
export function untranslatedCommentaryCues(matchId: number): CommentaryCueRow[] {
  return all<CommentaryCueRow>('SELECT * FROM commentary_cues WHERE match_id = $id AND untranslated != 0 ORDER BY start_ts, seq', { id: matchId });
}

/**
 * Traduction enfin trouvée pour un sous-titre resté en anglais. Le compte
 * de la piste suit ; le doublage du tronçon sera refait (l'empreinte de ses
 * sous-titres change, voir dub.ts `cuesSignature`).
 */
export function setCommentaryCueTranslation(matchId: number, seq: number, textFr: string): void {
  tx(() => {
    run('UPDATE commentary_cues SET text_fr = $fr, untranslated = 0 WHERE match_id = $id AND seq = $seq', { id: matchId, seq, fr: textFr });
    run(
      'UPDATE commentary_tracks SET untranslated = (SELECT COUNT(*) FROM commentary_cues WHERE match_id = $id AND untranslated != 0) WHERE match_id = $id',
      { id: matchId },
    );
    run('UPDATE dub_tracks SET complete = 0 WHERE match_id = $id', { id: matchId });
  });
}

/** Fin (s) du dernier sous-titre en base, 0 s'il n'y en a pas. */
export function commentaryPublishedUntil(matchId: number): number {
  return one<{ t: number | null }>('SELECT MAX(end_ts) AS t FROM commentary_cues WHERE match_id = $id', { id: matchId })?.t ?? 0;
}

/**
 * Matchs (parmi `ids`) dont la traduction des commentaires est prête pour le
 * replay ACTUEL (badge « VF » des listes). Une piste produite pour un autre
 * ok_id ne compte pas, une piste partielle (publication en cours ou
 * interrompue) non plus.
 */
export function commentaryReadyIds(ids: number[]): Set<number> {
  const list = [...new Set(ids.filter((n) => Number.isInteger(n)))];
  if (!list.length) return new Set();
  return new Set(
    all<{ match_id: number }>(
      `SELECT t.match_id FROM commentary_tracks t JOIN matches m ON m.id = t.match_id
       WHERE t.ok_id = m.video_ok_id AND t.cues > 0 AND t.complete = 1 AND t.match_id IN (SELECT value FROM json_each($ids))`,
      { ids: JSON.stringify(list) },
    ).map((r) => r.match_id),
  );
}

/**
 * Matchs terminés depuis `sinceIso`, avec replay (HLS ou MP4 : l'audio du
 * MP4 « mobile » suffit), sans piste traduite COMPLÈTE pour la vidéo
 * actuelle (une piste partielle, laissée par un travail interrompu, est à
 * reprendre). Avec `translateModel`, une piste complète faite par un AUTRE
 * modèle de traduction est aussi à refaire (changement de modèle).
 */
export function finalMatchesNeedingCommentary(sinceIso: string, limit = 30, translateModel?: string): MatchRow[] {
  return all<MatchRow>(
    `SELECT * FROM matches m WHERE m.status = 'final' AND m.video_available = 1 AND m.video_ok_id IS NOT NULL
       AND m.date_utc >= $since
       AND NOT EXISTS (SELECT 1 FROM commentary_tracks t WHERE t.match_id = m.id AND t.ok_id = m.video_ok_id AND t.complete = 1
                         AND ($model IS NULL OR t.translate_model = $model))
     ORDER BY m.date_utc DESC LIMIT $limit`,
    { since: sinceIso, limit, model: translateModel ?? null },
  );
}

/** Matchs terminés récents dont la piste complète du replay actuel a des lignes restées en anglais. */
export function finalMatchesWithUntranslatedCues(sinceIso: string, limit = 30): MatchRow[] {
  return all<MatchRow>(
    `SELECT m.* FROM matches m JOIN commentary_tracks t ON t.match_id = m.id
     WHERE m.status = 'final' AND m.video_available = 1 AND m.date_utc >= $since
       AND t.ok_id = m.video_ok_id AND t.complete = 1 AND t.untranslated > 0
     ORDER BY m.date_utc DESC LIMIT $limit`,
    { since: sinceIso, limit },
  );
}

// ---------------------------------------------------------------- doublage français (voix de synthèse)

/**
 * Doublage : une piste par match, produite pour UNE piste traduite précise
 * (`commentary_key` : vidéo, modèles, découpage — voir `commentaryKey`). Si
 * la piste traduite change, le doublage est effacé et refait. Les tronçons
 * sont ceux de la traduction (`commentary_chunks.idx`), chacun un fichier
 * audio `chunk-<idx>.m4a` dans `${dataDir()}/dub/<match>/`.
 */
export const DUB_SCHEMA_SQL = `
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
`;

export interface DubTrackRow {
  match_id: number;
  ok_id: string;
  commentary_key: string;
  voices: string;
  speakers: string;
  complete: number;
  updated_at: string;
}

export interface DubChunkRow {
  match_id: number;
  idx: number;
  start_ts: number;
  end_ts: number;
  file: string;
  speech: string;
  cues_sig: string;
  created_at: string;
}

/** Tronçon publié de la traduction (keep_to = 1e9 pour le dernier tronçon). */
export interface CommentaryChunkRow {
  idx: number;
  keep_from: number;
  keep_to: number;
}

// Même clé en TypeScript et en SQL (finalMatchesNeedingDub) : garder les deux en phase.
const COMMENTARY_KEY_SQL = `t.ok_id || '|' || t.transcribe_model || '|' || t.translate_model || '|' || COALESCE(t.chunk_sec, '')`;

/** Identité d'une piste traduite : un doublage fait pour une autre clé est à refaire. */
export function commentaryKey(t: Pick<CommentaryTrackRow, 'ok_id' | 'transcribe_model' | 'translate_model' | 'chunk_sec'>): string {
  return `${t.ok_id}|${t.transcribe_model}|${t.translate_model}|${t.chunk_sec ?? ''}`;
}

export function getCommentaryChunks(matchId: number): CommentaryChunkRow[] {
  return all<CommentaryChunkRow>('SELECT idx, keep_from, keep_to FROM commentary_chunks WHERE match_id = $id ORDER BY keep_from', { id: matchId });
}

export function getDubTrack(matchId: number): DubTrackRow | undefined {
  return one<DubTrackRow>('SELECT * FROM dub_tracks WHERE match_id = $id', { id: matchId });
}

export function getDubChunks(matchId: number): DubChunkRow[] {
  return all<DubChunkRow>('SELECT * FROM dub_chunks WHERE match_id = $id ORDER BY start_ts', { id: matchId });
}

export function getDubChunk(matchId: number, idx: number): DubChunkRow | undefined {
  return one<DubChunkRow>('SELECT * FROM dub_chunks WHERE match_id = $id AND idx = $idx', { id: matchId, idx });
}

/**
 * Ouvre (ou reprend) le doublage d'un match pour la piste traduite `key`.
 * Un doublage fait pour une autre piste (autre vidéo, autres modèles) est
 * effacé : `reset` vaut alors true (l'appelant supprime les fichiers).
 */
export function openDubTrack(matchId: number, okId: string, key: string): { reset: boolean; track: DubTrackRow } {
  return tx(() => {
    const prev = getDubTrack(matchId);
    if (prev && prev.commentary_key === key && prev.ok_id === okId) return { reset: false, track: prev };
    run('DELETE FROM dub_chunks WHERE match_id = $id', { id: matchId });
    run(
      `INSERT OR REPLACE INTO dub_tracks (match_id, ok_id, commentary_key, voices, speakers, complete, updated_at)
       VALUES ($id, $ok, $key, '[]', '{}', 0, $now)`,
      { id: matchId, ok: okId, key, now: nowIso() },
    );
    return { reset: !!prev, track: getDubTrack(matchId) as DubTrackRow };
  });
}

/** Publie un tronçon doublé (remplace le précédent) et l'état des voix du match, d'un bloc. */
export function publishDubChunk(
  matchId: number,
  chunk: { idx: number; start: number; end: number; file: string; speech: [number, number][]; cuesSig: string },
  state: { voices: string[]; speakers: unknown },
): void {
  tx(() => {
    run(
      `INSERT OR REPLACE INTO dub_chunks (match_id, idx, start_ts, end_ts, file, speech, cues_sig, created_at)
       VALUES ($id, $idx, $s, $e, $f, $sp, $sig, $now)`,
      {
        id: matchId,
        idx: chunk.idx,
        s: chunk.start,
        e: chunk.end,
        f: chunk.file,
        sp: JSON.stringify(chunk.speech),
        sig: chunk.cuesSig,
        now: nowIso(),
      },
    );
    run('UPDATE dub_tracks SET voices = $v, speakers = $sp, updated_at = $now WHERE match_id = $id', {
      id: matchId,
      v: JSON.stringify(state.voices),
      sp: JSON.stringify(state.speakers),
      now: nowIso(),
    });
  });
}

export function setDubComplete(matchId: number, complete: boolean): void {
  run('UPDATE dub_tracks SET complete = $c, updated_at = $now WHERE match_id = $id', { id: matchId, c: complete ? 1 : 0, now: nowIso() });
}

/** Efface le doublage d'un match (lignes seulement : les fichiers sont supprimés par dub.ts). */
export function deleteDub(matchId: number): void {
  tx(() => {
    run('DELETE FROM dub_chunks WHERE match_id = $id', { id: matchId });
    run('DELETE FROM dub_tracks WHERE match_id = $id', { id: matchId });
  });
}

/**
 * Nombre de tronçons traduits pas encore doublés pour la piste traduite
 * actuelle `key` (tous si le doublage en base a été fait pour une autre).
 */
export function dubPendingChunks(matchId: number, key: string): number {
  const d = getDubTrack(matchId);
  const total = one<{ n: number }>('SELECT COUNT(*) AS n FROM commentary_chunks WHERE match_id = $id', { id: matchId })?.n ?? 0;
  if (!d || d.commentary_key !== key) return total;
  return (
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commentary_chunks c
        WHERE c.match_id = $id AND NOT EXISTS (SELECT 1 FROM dub_chunks x WHERE x.match_id = c.match_id AND x.idx = c.idx)`,
      { id: matchId },
    )?.n ?? 0
  );
}

/**
 * Matchs terminés depuis `sinceIso`, avec replay et une piste traduite
 * (complète ou partielle) pour la vidéo actuelle, dont le doublage est à
 * faire : absent, fait pour une autre piste traduite, ou avec des tronçons
 * traduits pas encore doublés.
 */
export function finalMatchesNeedingDub(sinceIso: string, limit = 30): MatchRow[] {
  return all<MatchRow>(
    `SELECT m.* FROM matches m JOIN commentary_tracks t ON t.match_id = m.id
      WHERE m.status = 'final' AND m.video_available = 1 AND m.video_ok_id IS NOT NULL AND m.date_utc >= $since
        AND t.ok_id = m.video_ok_id AND t.cues > 0
        AND (
          NOT EXISTS (SELECT 1 FROM dub_tracks d WHERE d.match_id = m.id AND d.commentary_key = ${COMMENTARY_KEY_SQL})
          OR EXISTS (SELECT 1 FROM commentary_chunks c WHERE c.match_id = m.id
                       AND NOT EXISTS (SELECT 1 FROM dub_chunks x WHERE x.match_id = m.id AND x.idx = c.idx))
        )
      ORDER BY m.date_utc DESC LIMIT $limit`,
    { since: sinceIso, limit },
  );
}

// ---------------------------------------------------------------- clips (hors périmètre v1)

export function listClips(matchId: number): unknown[] {
  return all('SELECT id, match_id, video_ts, duration, text_fr, created_at FROM user_clips WHERE match_id = $id ORDER BY video_ts', {
    id: matchId,
  });
}

// ---------------------------------------------------------------- cache / journal

export function kvGet<T>(key: string, maxAgeMs: number): T | undefined {
  const r = one<{ value: string; updated_at: string }>('SELECT value, updated_at FROM kv_cache WHERE key = $key', { key });
  if (!r) return undefined;
  if (Date.now() - Date.parse(r.updated_at) > maxAgeMs) return undefined;
  return JSON.parse(r.value) as T;
}

export function kvSet(key: string, value: unknown): void {
  run('INSERT OR REPLACE INTO kv_cache (key, value, updated_at) VALUES ($key, $value, $now)', {
    key,
    value: JSON.stringify(value),
    now: nowIso(),
  });
}

export function logIngestStart(task: string): number {
  const r = run('INSERT INTO ingest_log (task, started_at) VALUES ($task, $now)', { task, now: nowIso() });
  return Number(r.lastInsertRowid);
}

export function logIngestEnd(id: number, ok: boolean, detail: string): void {
  run('UPDATE ingest_log SET finished_at = $now, ok = $ok, detail = $detail WHERE id = $id', {
    id,
    now: nowIso(),
    ok: ok ? 1 : 0,
    detail: detail.slice(0, 2000),
  });
}

export interface IngestLogRow {
  id: number;
  task: string;
  started_at: string;
  finished_at: string | null;
  ok: number;
  detail: string;
}

export function lastIngests(limit = 10): IngestLogRow[] {
  return all<IngestLogRow>('SELECT * FROM ingest_log ORDER BY id DESC LIMIT $limit', { limit });
}

export function lastSuccessfulIngest(task?: string): IngestLogRow | undefined {
  return task
    ? one<IngestLogRow>('SELECT * FROM ingest_log WHERE ok = 1 AND task = $task ORDER BY id DESC LIMIT 1', { task })
    : one<IngestLogRow>('SELECT * FROM ingest_log WHERE ok = 1 ORDER BY id DESC LIMIT 1');
}

export function dbHealth(): { ok: boolean; matches: number; error?: string } {
  try {
    const n = one<{ n: number }>('SELECT COUNT(*) AS n FROM matches')?.n ?? 0;
    return { ok: true, matches: n };
  } catch (e) {
    return { ok: false, matches: 0, error: (e as Error).message };
  }
}

// ==================================================================
// AUTHENTIFICATION, UTILISATEURS ET PARAMÈTRES
// Bloc autonome (tables + accès SQL). La logique (hachage, règles, limitation
// des tentatives) est dans src/lib/auth.ts, les paramètres dans
// src/lib/settings.ts. Le script scripts/reset-password.mjs recrée les
// tables `users` et `sessions` à l'identique : garder les deux en phase.
// ==================================================================

export const AUTH_SCHEMA_SQL = `
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
`;

export type UserRole = 'admin' | 'user';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
  last_login_at: string | null;
}

/** Utilisateur sans son empreinte de mot de passe : seule forme qui sort du serveur. */
export type PublicUser = Omit<UserRow, 'password_hash'>;

export function countUsers(): number {
  return one<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

export function countAdmins(): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0;
}

export function listUsers(): PublicUser[] {
  // Copie en objets ordinaires : les lignes de node:sqlite ont un prototype
  // nul, que React refuse de transmettre à un composant client.
  return all<PublicUser>('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY username').map((u) => ({ ...u }));
}

export function getUserById(id: number): UserRow | undefined {
  return one<UserRow>('SELECT * FROM users WHERE id = $id', { id });
}

export function getUserByUsername(username: string): UserRow | undefined {
  return one<UserRow>('SELECT * FROM users WHERE username = $username', { username });
}

export function insertUser(username: string, passwordHash: string, role: UserRole): number {
  const r = run('INSERT INTO users (username, password_hash, role, created_at) VALUES ($username, $hash, $role, $now)', {
    username,
    hash: passwordHash,
    role,
    now: nowIso(),
  });
  return Number(r.lastInsertRowid);
}

/**
 * Crée le premier compte administrateur, seulement si aucun utilisateur
 * n'existe : vérification et insertion dans la même transaction.
 * Renvoie l'id créé, ou null si un compte existe déjà.
 */
export function insertFirstAdmin(username: string, passwordHash: string): number | null {
  return tx(() => (countUsers() > 0 ? null : insertUser(username, passwordHash, 'admin')));
}

export function updateUserPassword(id: number, passwordHash: string): void {
  run('UPDATE users SET password_hash = $hash WHERE id = $id', { id, hash: passwordHash });
}

export function updateUserRole(id: number, role: UserRole): void {
  run('UPDATE users SET role = $role WHERE id = $id', { id, role });
}

export function touchUserLogin(id: number): void {
  run('UPDATE users SET last_login_at = $now WHERE id = $id', { id, now: nowIso() });
}

/** Supprime un utilisateur et toutes ses sessions. */
export function deleteUserRow(id: number): void {
  tx(() => {
    run('DELETE FROM sessions WHERE user_id = $id', { id });
    run('DELETE FROM users WHERE id = $id', { id });
  });
}

export interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export function insertSession(tokenHash: string, userId: number, expiresAt: string): void {
  const now = nowIso();
  // Ménage opportuniste des sessions expirées à chaque nouvelle session.
  run('DELETE FROM sessions WHERE expires_at <= $now', { now });
  run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($h, $u, $now, $exp)', {
    h: tokenHash,
    u: userId,
    now,
    exp: expiresAt,
  });
}

/** Session et son utilisateur (jointure), ou undefined si le jeton est inconnu. */
export function getSessionWithUser(tokenHash: string): (SessionRow & { username: string; role: UserRole }) | undefined {
  return one(
    `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, u.username, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $h`,
    { h: tokenHash },
  );
}

export function extendSession(tokenHash: string, expiresAt: string): void {
  run('UPDATE sessions SET expires_at = $exp WHERE token_hash = $h', { h: tokenHash, exp: expiresAt });
}

export function deleteSession(tokenHash: string): void {
  run('DELETE FROM sessions WHERE token_hash = $h', { h: tokenHash });
}

/** Révoque toutes les sessions d'un utilisateur, sauf éventuellement une (la session courante). */
export function deleteUserSessions(userId: number, exceptTokenHash?: string): void {
  run('DELETE FROM sessions WHERE user_id = $u AND token_hash <> $keep', { u: userId, keep: exceptTokenHash ?? '' });
}

export function settingGet(key: string): string | null {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = $key', { key })?.value ?? null;
}

/** Écrit un paramètre ; null le supprime. */
export function settingSet(key: string, value: string | null): void {
  if (value === null) {
    run('DELETE FROM settings WHERE key = $key', { key });
    return;
  }
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $now)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, now: nowIso() },
  );
}

// ============================================================ fin du bloc authentification
