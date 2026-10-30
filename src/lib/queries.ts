/**
 * Requêtes de lecture dédiées aux pages (accueil, calendrier, équipes).
 *
 * Tout est en lecture seule et passe par `getDb()` ; les écritures restent
 * dans `db.ts`. Les « jours » sont des jours de Paris (clé 'YYYY-MM-DD'), et
 * une « nuit NBA » regroupe les matchs de midi (Paris) au lendemain midi :
 * un match à 01:30 le 30/10 appartient à la nuit du 29 au 30.
 */
import type { SQLInputValue } from 'node:sqlite';
import { commentaryProgressByIds, getDb, kvGet, listMatches } from './db';
import { commentaryRunningMatchId } from './commentary';
import type { StandingRow } from './espn';
import { toDto, type MatchDto } from './present';
import { addDays, parisDateKey, parisDayStartUtc } from './time';
import type { MatchRow } from './types';

type Params = Record<string, SQLInputValue>;

function all<T>(sql: string, params: Params = {}): T[] {
  return getDb().prepare(sql).all(params) as unknown as T[];
}
function one<T>(sql: string, params: Params = {}): T | undefined {
  return getDb().prepare(sql).get(params) as unknown as T | undefined;
}

const HOUR = 3600_000;
/** Un match « programmé » dont l'heure est passée depuis moins de ça est sans doute en cours. */
const IN_PROGRESS_GRACE = 3 * HOUR;

// ---------------------------------------------------------------- jours & nuits

export function todayKey(now = new Date()): string {
  return parisDateKey(now);
}

/** Décale une clé de jour de `n` jours (midi UTC : insensible aux changements d'heure). */
export function shiftKey(key: string, n: number): string {
  return parisDateKey(addDays(new Date(`${key}T12:00:00Z`), n));
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateKey(v: string | undefined | null): v is string {
  if (!v || !KEY_RE.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && shiftKey(v, 0) === v;
}

/** Nuit NBA d'un match : jour de Paris de (début − 12 h). */
export function nightKeyOf(dateUtc: string): string {
  return parisDateKey(Date.parse(dateUtc) - 12 * HOUR);
}

/** Bornes UTC [début, fin) de la nuit `key` : de midi à midi, heure de Paris. */
function nightBounds(key: string): { from: string; to: string } {
  const from = new Date(Date.parse(parisDayStartUtc(key)) + 12 * HOUR).toISOString();
  const to = new Date(Date.parse(parisDayStartUtc(shiftKey(key, 1))) + 12 * HOUR).toISOString();
  return { from, to };
}

function dayBounds(key: string): { from: string; to: string } {
  return { from: parisDayStartUtc(key), to: parisDayStartUtc(shiftKey(key, 1)) };
}

// ---------------------------------------------------------------- vue enrichie

export interface GameView extends MatchDto {
  /** Fiche de stats joueurs disponible en base. */
  hasStats: boolean;
  /** Replay vidéo disponible. */
  hasReplay: boolean;
  /** Commentaires traduits en français disponibles (piste prête pour la vidéo actuelle). */
  hasVf: boolean;
  /**
   * État de la VF (replays seulement) : prête, en cours de traduction, en
   * partie traduite (`pct` = part du match), ou pas encore commencée.
   */
  vf: VfState;
}

export type VfState = { state: 'ready' } | { state: 'running'; pct: number } | { state: 'partial'; pct: number } | { state: 'none' };

/** Ensemble des identifiants de matchs qui ont des stats joueurs en base. */
function idsWithStats(ids: number[]): Set<number> {
  const clean = ids.filter((n) => Number.isInteger(n));
  if (!clean.length) return new Set();
  const rows = all<{ match_id: number }>(
    `SELECT DISTINCT match_id FROM player_stats WHERE match_id IN (${clean.join(',')})`,
  );
  return new Set(rows.map((r) => r.match_id));
}

export function toViews(rows: MatchRow[]): GameView[] {
  const finals = rows.filter((r) => r.status === 'final').map((r) => r.id);
  const stats = idsWithStats(finals);
  const progress = commentaryProgressByIds(finals);
  const running = commentaryRunningMatchId();
  return rows.map((r) => {
    const dto = toDto(r);
    const p = dto.video.available ? progress.get(r.id) : undefined;
    const pct = p && p.total ? Math.min(99, Math.round((p.done / p.total) * 100)) : 0;
    const vf: VfState = !dto.video.available
      ? { state: 'none' }
      : p?.complete
        ? { state: 'ready' }
        : running === r.id
          ? { state: 'running', pct }
          : p && p.done > 0
            ? { state: 'partial', pct }
            : { state: 'none' };
    return {
      ...dto,
      hasStats: stats.has(r.id),
      hasReplay: dto.video.available,
      hasVf: vf.state === 'ready',
      vf,
    };
  });
}

// ---------------------------------------------------------------- accueil

/** Derniers matchs terminés avec un replay, du plus récent au plus ancien. */
export function latestReplays(limit = 12): GameView[] {
  return toViews(listMatches({ status: 'final', video: true, order: 'desc', limit }));
}

export function liveGames(): GameView[] {
  return toViews(listMatches({ status: 'live', limit: 20 }));
}

/**
 * Prochaine nuit NBA à suivre : celle d'un match en cours, sinon celle du
 * prochain match programmé (on tolère un match « programmé » commencé depuis
 * peu, son statut pouvant être en retard).
 */
export function nextNightKey(now = new Date()): string | undefined {
  const r = one<{ date_utc: string }>(
    `SELECT date_utc FROM matches
      WHERE league = 'nba'
        AND (status = 'live' OR (status = 'scheduled' AND date_utc >= $since))
      ORDER BY (status = 'live') DESC, date_utc ASC LIMIT 1`,
    { since: new Date(now.getTime() - IN_PROGRESS_GRACE).toISOString() },
  );
  return r ? nightKeyOf(r.date_utc) : undefined;
}

export function gamesOfNight(key: string): GameView[] {
  const { from, to } = nightBounds(key);
  return toViews(listMatches({ from, to, limit: 40 }));
}

/**
 * Prochains jours (Paris) avec des matchs à venir, à partir de `fromKey`.
 * Uniquement des matchs programmés dont le début est dans le futur.
 */
export function upcomingDays(fromKey: string, maxDays = 4, now = new Date()): { key: string; games: GameView[] }[] {
  const start = parisDayStartUtc(fromKey);
  const since = start > now.toISOString() ? start : now.toISOString();
  const rows = all<MatchRow>(
    `SELECT * FROM matches
      WHERE league = 'nba' AND status = 'scheduled' AND date_utc >= $since
      ORDER BY date_utc ASC, id ASC LIMIT 120`,
    { since },
  );
  const out: { key: string; rows: MatchRow[] }[] = [];
  for (const r of rows) {
    const k = parisDateKey(r.date_utc);
    let g = out[out.length - 1];
    if (!g || g.key !== k) {
      if (out.length >= maxDays) break;
      g = { key: k, rows: [] };
      out.push(g);
    }
    g.rows.push(r);
  }
  return out.map((g) => ({ key: g.key, games: toViews(g.rows) }));
}

// ---------------------------------------------------------------- calendrier

export interface DayCount {
  total: number;
  final: number;
  live: number;
  replays: number;
}

/** Nombre de matchs par jour de Paris sur [fromKey, toKey] (inclus). */
export function dayCounts(fromKey: string, toKey: string): Map<string, DayCount> {
  const rows = all<{ date_utc: string; status: string; video_available: number }>(
    `SELECT date_utc, status, video_available FROM matches
      WHERE league = 'nba' AND date_utc >= $from AND date_utc < $to`,
    { from: parisDayStartUtc(fromKey), to: parisDayStartUtc(shiftKey(toKey, 1)) },
  );
  const map = new Map<string, DayCount>();
  for (const r of rows) {
    const k = parisDateKey(r.date_utc);
    const c = map.get(k) ?? { total: 0, final: 0, live: 0, replays: 0 };
    c.total++;
    if (r.status === 'final') c.final++;
    if (r.status === 'live') c.live++;
    if (r.video_available) c.replays++;
    map.set(k, c);
  }
  return map;
}

export function gamesOfDay(key: string): GameView[] {
  const { from, to } = dayBounds(key);
  return toViews(listMatches({ from, to, limit: 40 }));
}

/** Premier jour (Paris) ≥ `key` (ou > si `strict`) ayant au moins un match. */
export function nextDayWithGames(key: string, strict = false): string | undefined {
  const from = parisDayStartUtc(strict ? shiftKey(key, 1) : key);
  const r = one<{ date_utc: string }>(
    `SELECT date_utc FROM matches WHERE league = 'nba' AND date_utc >= $from ORDER BY date_utc ASC LIMIT 1`,
    { from },
  );
  return r ? parisDateKey(r.date_utc) : undefined;
}

/** Dernier jour (Paris) < `key` ayant au moins un match. */
export function prevDayWithGames(key: string): string | undefined {
  const r = one<{ date_utc: string }>(
    `SELECT date_utc FROM matches WHERE league = 'nba' AND date_utc < $to ORDER BY date_utc DESC LIMIT 1`,
    { to: parisDayStartUtc(key) },
  );
  return r ? parisDateKey(r.date_utc) : undefined;
}

/**
 * Jour affiché par défaut dans le calendrier : aujourd'hui s'il reste des
 * matchs à jouer, ou le matin (résultats de la nuit) ; sinon le prochain jour
 * avec des matchs.
 */
export function defaultCalendarDay(now = new Date()): string {
  const today = todayKey(now);
  const c = dayCounts(today, today).get(today);
  const parisHour = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(now));
  if (c && (c.final < c.total || parisHour < 14)) return today;
  return nextDayWithGames(today, true) ?? today;
}

// ---------------------------------------------------------------- équipes

/** Saison la plus récente présente en base (année de début). */
export function latestSeason(): number | undefined {
  return one<{ s: number | null }>(`SELECT MAX(season) AS s FROM matches WHERE league = 'nba'`)?.s ?? undefined;
}

export interface TeamRecord {
  wins: number;
  losses: number;
}

/** Bilan V-D de la saison régulière `season` pour toutes les équipes. */
export function seasonRecords(season = latestSeason()): Map<string, TeamRecord> {
  const map = new Map<string, TeamRecord>();
  if (season === undefined) return map;
  const rows = all<{ abbr: string; w: number; l: number }>(
    `SELECT abbr, SUM(win) AS w, SUM(1 - win) AS l FROM (
        SELECT home_abbr AS abbr, (home_score > away_score) AS win FROM matches
         WHERE league = 'nba' AND season = $season AND season_type = 'regular' AND status = 'final'
           AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score
        UNION ALL
        SELECT away_abbr, (away_score > home_score) FROM matches
         WHERE league = 'nba' AND season = $season AND season_type = 'regular' AND status = 'final'
           AND home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score
      ) GROUP BY abbr`,
    { season },
  );
  for (const r of rows) map.set(r.abbr, { wins: Number(r.w), losses: Number(r.l) });
  return map;
}

/** Prochain match (programmé et futur, ou en cours) de chaque équipe. */
export function nextGameByTeam(now = new Date()): Map<string, GameView> {
  const rows = all<MatchRow>(
    `SELECT * FROM matches
      WHERE league = 'nba' AND (status = 'live' OR (status = 'scheduled' AND date_utc > $now))
      ORDER BY date_utc ASC LIMIT 300`,
    { now: now.toISOString() },
  );
  const pick = new Map<string, MatchRow>();
  for (const r of rows) {
    if (!pick.has(r.home_abbr)) pick.set(r.home_abbr, r);
    if (!pick.has(r.away_abbr)) pick.set(r.away_abbr, r);
  }
  const views = toViews([...new Set(pick.values())]);
  const byId = new Map(views.map((v) => [v.id, v]));
  const out = new Map<string, GameView>();
  for (const [abbr, r] of pick) out.set(abbr, byId.get(r.id)!);
  return out;
}

/** Tous les matchs d'une équipe (toutes saisons en base), chronologiques. */
export function teamGames(abbr: string): GameView[] {
  return toViews(listMatches({ team: abbr, limit: 400, order: 'asc' }));
}

/** Un match est « à venir » s'il est programmé dans le futur, ou en cours. */
export function isUpcoming(g: { status: string; date_utc: string }, now = new Date()): boolean {
  return g.status === 'live' || (g.status === 'scheduled' && Date.parse(g.date_utc) > now.getTime());
}

// ---------------------------------------------------------------- classement

export type Standings = { conference: string; rows: StandingRow[] }[];

/** Classement ESPN tel qu'il est en cache (aucun appel réseau). */
export function cachedStandings(): Standings | undefined {
  return kvGet<Standings>('standings:nba', Infinity);
}

/** Rang de conférence par équipe, depuis le cache du classement. */
export function conferenceSeeds(): Map<string, number> {
  const map = new Map<string, number>();
  for (const conf of cachedStandings() ?? []) {
    conf.rows.forEach((r, i) => map.set(r.abbr, r.seed || i + 1));
  }
  return map;
}
