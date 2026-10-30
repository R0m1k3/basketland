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
}

export interface CommentaryTrackMeta {
  ok_id: string;
  transcribe_model: string;
  translate_model: string;
}

type CueInput = Omit<CommentaryCueRow, 'match_id'>;

function insertCues(matchId: number, cues: CueInput[]): void {
  const st = getDb().prepare(
    `INSERT OR REPLACE INTO commentary_cues (match_id, seq, start_ts, end_ts, text_en, text_fr, untranslated)
     VALUES ($m, $seq, $start, $end, $en, $fr, $u)`,
  );
  for (const c of cues)
    st.run({ m: matchId, seq: c.seq, start: c.start_ts, end: c.end_ts, en: c.text_en, fr: c.text_fr, u: c.untranslated ? 1 : 0 });
}

/** Métadonnées de la piste ; compteurs recalculés sur les sous-titres en base. */
function writeTrack(matchId: number, track: CommentaryTrackMeta, complete: boolean): void {
  run(
    `INSERT OR REPLACE INTO commentary_tracks (match_id, ok_id, transcribe_model, translate_model, cues, untranslated, created_at, complete)
     SELECT $m, $ok, $tm, $lm, COUNT(*), COALESCE(SUM(untranslated != 0), 0), $now, $c FROM commentary_cues WHERE match_id = $m`,
    { m: matchId, ok: track.ok_id, tm: track.transcribe_model, lm: track.translate_model, now: nowIso(), c: complete ? 1 : 0 },
  );
}

/** Remplace d'un bloc la piste traduite d'un match (sous-titres + métadonnées), marquée complète. */
export function replaceCommentary(matchId: number, track: CommentaryTrackMeta, cues: CueInput[]): void {
  tx(() => {
    run('DELETE FROM commentary_cues WHERE match_id = $id', { id: matchId });
    insertCues(matchId, cues);
    writeTrack(matchId, track, true);
  });
}

/**
 * Publication PARTIELLE (sous-titres progressifs) : les sous-titres `cues`
 * (seq consécutifs) remplacent tout ce qui était publié à partir du premier
 * d'entre eux, si bien que la piste publiée reste un préfixe continu du
 * match. Une piste d'une autre vidéo (ok_id) est d'abord effacée. La piste
 * reste incomplète jusqu'à `completeCommentary`.
 */
export function publishCommentaryCues(matchId: number, track: CommentaryTrackMeta, cues: CueInput[]): void {
  tx(() => {
    const prev = getCommentaryTrack(matchId);
    if (!prev || prev.ok_id !== track.ok_id) run('DELETE FROM commentary_cues WHERE match_id = $id', { id: matchId });
    else if (cues.length) {
      const from = cues.reduce((m, c) => Math.min(m, c.seq), Number.POSITIVE_INFINITY);
      run('DELETE FROM commentary_cues WHERE match_id = $id AND seq >= $from', { id: matchId, from });
    }
    insertCues(matchId, cues);
    writeTrack(matchId, track, false);
  });
}

/**
 * Fin du travail : la piste compte exactement les seq 1 à `total` (un
 * reliquat d'un essai précédent est retiré) et devient complète.
 */
export function completeCommentary(matchId: number, track: CommentaryTrackMeta, total: number): void {
  tx(() => {
    run('DELETE FROM commentary_cues WHERE match_id = $id AND seq > $n', { id: matchId, n: total });
    writeTrack(matchId, track, true);
  });
}

export function getCommentaryTrack(matchId: number): CommentaryTrackRow | undefined {
  return one<CommentaryTrackRow>('SELECT * FROM commentary_tracks WHERE match_id = $id', { id: matchId });
}

export function getCommentaryCues(matchId: number): CommentaryCueRow[] {
  return all<CommentaryCueRow>('SELECT * FROM commentary_cues WHERE match_id = $id ORDER BY start_ts, seq', { id: matchId });
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
