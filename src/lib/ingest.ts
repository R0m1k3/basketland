/**
 * Jobs d'ingestion. Chaque job est isolé (ses erreurs ne bloquent pas les autres)
 * et journalisé dans `ingest_log`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { fetchScoreboard, fetchScoreboardRange, fetchSummary } from './espn';
import { findReplay, type ReplayLookup } from './bv';
import { replayRecheckWindow } from './replayCadence';
import { classifyPlay } from './vf';
import { buildCommentary } from './vf';
import { alignWithCuts, buildMapping, findBreaks, resolveAnchorWall, timeLines, toTimedPlays, type ResolvedAnchor } from './sync';
import { addDays, currentSeason, espnDate } from './time';
import type { AnchorRow, MatchRow } from './types';

export type JobName = 'sync-schedule' | 'sync-stats' | 'sync-videos' | 'sync-subtitles' | 'sync-season';

const running = new Set<string>();

async function runLogged(task: string, fn: () => Promise<string>): Promise<{ ok: boolean; detail: string }> {
  if (running.has(task)) return { ok: false, detail: 'déjà en cours' };
  running.add(task);
  const id = db.logIngestStart(task);
  try {
    const detail = await fn();
    db.logIngestEnd(id, true, detail);
    return { ok: true, detail };
  } catch (e) {
    const detail = (e as Error).message || String(e);
    db.logIngestEnd(id, false, detail);
    console.error(`[ingest] ${task} échoué:`, detail);
    return { ok: false, detail };
  } finally {
    running.delete(task);
  }
}

/** Calendrier : 7 jours passés + 7 jours à venir (+ live). */
export function syncSchedule(league = 'nba', daysBack = 7, daysAhead = 7) {
  return runLogged('sync-schedule', async () => {
    const now = new Date();
    const from = addDays(now, -daysBack);
    const to = addDays(now, daysAhead);
    // ESPN refuse les plages de dates (HTTP 400) : on itère jour par jour.
    const matches = await fetchScoreboardRange(from, to, league, 1000);
    db.upsertMatches(matches);
    return `${matches.length} matchs (${espnDate(from)}→${espnDate(to)})`;
  });
}

/**
 * Saison complète (année de début, ex. 2026 pour 2026-27), mois par mois de
 * septembre à juin pour ne pas buter sur la limite de 1 000 matchs par requête.
 */
export function syncSeason(season: number, league = 'nba') {
  return runLogged('sync-season', async () => {
    let total = 0;
    const errors: string[] = [];
    for (let i = 0; i < 10; i++) {
      const month = (8 + i) % 12; // 8 = septembre
      const year = season + (8 + i >= 12 ? 1 : 0);
      const from = new Date(Date.UTC(year, month, 1));
      const to = new Date(Date.UTC(year, month + 1, 0));
      try {
        const matches = await fetchScoreboardRange(from, to, league, 1000);
        db.upsertMatches(matches);
        total += matches.length;
      } catch (e) {
        errors.push(`${year}-${month + 1}: ${(e as Error).message}`);
      }
    }
    if (errors.length && !total) throw new Error(errors.join(' | '));
    return `${total} matchs (saison ${season})${errors.length ? ` — erreurs: ${errors.join(' | ')}` : ''}`;
  });
}

/** Stats + play-by-play d'un match terminé, puis génération de la VF. */
export async function ingestMatchDetails(match: MatchRow): Promise<string> {
  const s = await fetchSummary(match.id, match.league);
  if (s.match) db.upsertMatch(s.match);
  db.replaceStats(match.id, s.teams, s.players, s.leaders);
  db.replacePlays(match.id, s.plays);
  const fresh = db.getMatch(match.id);
  // On ne marque le match comme synchronisé que si les données sont
  // complètes : sinon ESPN les republiera plus tard et le match ne serait
  // jamais réanalysé (stats et VF figées à un état partiel).
  //
  // Le test de fin de match passe par `classifyPlay` : ESPN écrit
  // `event_type = "End Game"` (et non "end of game"). Une recherche directe
  // sur la chaîne rendait la condition TOUJOURS fausse, et les 15 matchs
  // `final` les plus récents étaient alors retéléchargés à chaque tick du
  // planificateur (des milliers d'appels ESPN par jour).
  const complete =
    s.players.length > 0 && s.plays.some((p) => classifyPlay(p.event_type, p.text_en, !!p.scoring) === 'game_end');
  if (fresh?.status === 'final' && complete) db.markStatsSynced(match.id);
  const subs = regenerateSubtitles(match.id, s.plays);
  return `${match.away_abbr}@${match.home_abbr}: ${s.players.length} joueurs, ${s.plays.length} actions, ${subs} sous-titres`;
}

export function syncStats(limit = 15) {
  return runLogged('sync-stats', async () => {
    const todo = [...db.finalMatchesNeedingStats(limit), ...db.liveMatches()];
    const done: string[] = [];
    for (const m of todo) {
      try {
        done.push(await ingestMatchDetails(m));
      } catch (e) {
        done.push(`${m.id}: ${(e as Error).message}`);
      }
    }
    return done.length ? done.join(' | ') : 'rien à faire';
  });
}

/** Résultat d'une recherche de replay pour un match (job ou demande). */
export interface ReplaySearchResult {
  /** null si la recherche a levé une erreur (réseau…). */
  lookup: ReplayLookup | null;
  /** Replay lisible après la recherche (nouveau ou déjà connu). */
  available: boolean;
  /** Un replay vient d'apparaître ou a changé (autre vidéo, MP4 → HLS…). */
  changed: boolean;
  /** Ligne de journal (`ingest_log`). */
  line: string;
}

/** Ligne de match avec la colonne `video_kind` (absente de `MatchRow`). */
type VideoMatchRow = MatchRow & { video_kind?: string | null };

/**
 * Recherches en cours, par match : le job périodique et une recherche à la
 * demande sur le même match partagent la même promesse au lieu de scraper
 * deux fois en parallèle.
 */
const replaySearches = new Map<number, Promise<ReplaySearchResult>>();

export function replaySearchInProgress(matchId: number): boolean {
  return replaySearches.has(matchId);
}

/**
 * Cherche le replay d'un match et enregistre le résultat (setVideo /
 * markVideoChecked, `video_kind`). Ne lève jamais : une erreur est
 * journalisée et le match marqué vérifié (pas de nouvel essai immédiat).
 * `fresh` : relit la 1re page de liste malgré le cache (recherche à la demande).
 */
export function searchReplay(m: VideoMatchRow, opts: { fresh?: boolean } = {}): Promise<ReplaySearchResult> {
  const current = replaySearches.get(m.id);
  if (current) return current;
  const p = runReplaySearch(m, opts).finally(() => replaySearches.delete(m.id));
  replaySearches.set(m.id, p);
  return p;
}

async function runReplaySearch(m: VideoMatchRow, opts: { fresh?: boolean }): Promise<ReplaySearchResult> {
  const wasAvailable = !!m.video_available && !!m.video_ok_id;
  try {
    const r = await findReplay(m, opts);
    // Un replay déjà trouvé (en MP4, revérifié pour passer en HLS) n'est
    // jamais rétrogradé par une recherche qui échoue : page ou embed
    // momentanément illisible ne doivent pas faire disparaître le replay.
    if (wasAvailable && !r.available) db.markVideoChecked(m.id);
    else if (r.okId || r.slug)
      db.setVideo(m.id, { slug: r.slug, okId: r.okId, duration: r.duration, available: r.available, kind: r.kind });
    else db.markVideoChecked(m.id);
    const line = `${m.away_abbr}@${m.home_abbr}: ${r.available ? `ok.ru/${r.okId} ${r.kind} (${r.duration}s)` : r.reason}`;
    // Passage MP4 → HLS sur la même vidéo : mêmes timecodes, rien à recaler.
    const sameVideo = wasAvailable && r.okId === m.video_ok_id && r.duration === m.video_duration;
    if (r.available && !sameVideo) regenerateSubtitles(m.id);
    const prevKind = m.video_kind === 'mp4' ? 'mp4' : 'hls';
    const changed = r.available && (!sameVideo || (r.kind ?? 'hls') !== prevKind);
    return { lookup: r, available: wasAvailable || r.available, changed, line };
  } catch (e) {
    db.markVideoChecked(m.id);
    return { lookup: null, available: wasAvailable, changed: false, line: `${m.id}: ${(e as Error).message}` };
  }
}

/**
 * Job vidéo (toutes les 20 min) : cadence de revérification selon l'âge du
 * match, voir `replayCadence.ts` et `finalMatchesNeedingVideo`.
 */
export function syncVideos(limit = 20) {
  return runLogged('sync-videos', async () => {
    const todo = db.finalMatchesNeedingVideo(replayRecheckWindow(), limit);
    const out: string[] = [];
    for (const m of todo) out.push((await searchReplay(m)).line);
    return out.length ? out.join(' | ') : 'rien à faire';
  });
}

/**
 * (Re)génère la VF d'un match : sélection/traduction des actions puis calcul des
 * video_ts (ancres manuelles + audio/auto, interpolation, offsets manuels).
 */
export function regenerateSubtitles(matchId: number, playsIn?: ReturnType<typeof db.getPlays>): number {
  const match = db.getMatch(matchId);
  if (!match) return 0;
  const plays = playsIn ?? db.getPlays(matchId);
  if (!plays.length) return 0;
  const lines = buildCommentary(plays, { homeAbbr: match.home_abbr, awayAbbr: match.away_abbr });
  const tp = toTimedPlays(plays);
  const breaks = findBreaks(tp);
  const duration = match.video_duration ?? null;

  // Ancres : manuelles + OCR ('auto') en base ; audio seulement en repli (< 2 ancres fiables).
  const resolved: ResolvedAnchor[] = [];
  for (const a of db.getAnchors(matchId)) {
    if (a.method === 'audio') continue;
    const w = resolveAnchorWall(a, tp);
    if (w !== null) resolved.push({ wall: w, video: a.video_ts, method: a.method, period: a.period, clock_sec: a.clock_sec });
  }
  const profile = db.getAudioProfile(matchId);
  if (resolved.length < 2 && profile && duration && profile.ok_id === match.video_ok_id) {
    const aligned = alignWithCuts(tp, breaks, profile.cuts, duration);
    if (aligned) {
      db.replaceAnchorsByMethod(matchId, 'audio', aligned.anchors.map((a) => anchorRow(matchId, a)));
      resolved.push(...aligned.anchors);
    }
  }
  // Sans ancre : estimation par la durée de la vidéo (non persistée, recalculée à chaque fois).
  const mapping = buildMapping(tp, breaks, resolved, { videoDuration: duration });

  const settings = db.getSyncSettings(matchId);
  const timed = timeLines(lines, mapping, settings, duration);
  db.replaceSubtitles(
    matchId,
    timed.map((l) => ({ seq: l.seq, video_ts: l.video_ts, end_ts: l.end_ts, text_fr: l.text_fr, speaker: l.speaker, kind: l.kind })),
  );
  return timed.length;
}

export function syncSubtitles(limit = 50) {
  return runLogged('sync-subtitles', async () => {
    const recent = db.listMatches({ status: 'final', from: addDays(new Date(), -21).toISOString(), limit, order: 'desc' });
    let n = 0;
    for (const m of recent) if (regenerateSubtitles(m.id) > 0) n++;
    return `${n} matchs`;
  });
}

// ------------------------------------------------------------------ ancres

function anchorRow(matchId: number, a: ResolvedAnchor): AnchorRow {
  return {
    match_id: matchId,
    period: a.period,
    clock_sec: a.clock_sec,
    video_ts: Math.round(a.video * 100) / 100,
    method: a.method,
    wallclock: new Date(a.wall * 1000).toISOString(),
  };
}

// L'analyse vidéo (OCR du chrono + audio) et sa file d'attente sont dans
// `analysis.ts` (startVideoAnalysis, analysisStatus, enqueueAnalysis).

// ------------------------------------------------------------------ jeton /api/ingest

export function ingestToken(): string {
  if (process.env.INGEST_TOKEN) return process.env.INGEST_TOKEN;
  const file = path.join(db.dataDir(), 'ingest_token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }
}

export function checkIngestAuth(header: string | null): boolean {
  const expected = ingestToken();
  const got = (header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!got) return false;
  // Comparaison sur des HACHAGES de taille fixe : `Buffer.from` encode en
  // UTF-8, dont la longueur en octets diffère de la longueur en unités
  // UTF-16. Un jeton contenant un caractère non-ASCII faisait donc lever
  // une RangeError dans timingSafeEqual (500 au lieu de 401).
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function runJob(name: JobName, arg?: number) {
  switch (name) {
    case 'sync-schedule':
      return syncSchedule();
    case 'sync-season':
      return syncSeason(arg ?? currentSeason());
    case 'sync-stats':
      return syncStats();
    case 'sync-videos':
      return syncVideos();
    case 'sync-subtitles':
      return syncSubtitles();
  }
}
