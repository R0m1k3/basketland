/**
 * Jobs d'ingestion. Chaque job est isolé (ses erreurs ne bloquent pas les autres)
 * et journalisé dans `ingest_log`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { fetchScoreboard, fetchSummary } from './espn';
import { findReplay } from './bv';
import { classifyPlay } from './vf';
import { analyzeHlsAudio, detectCuts, ffmpegAvailable } from './audio';
import { lightestVariant, OK_REFERER, resolveOkStream } from './okru';
import { BROWSER_UA } from './http';
import { buildCommentary } from './vf';
import { alignWithCuts, buildMapping, findBreaks, resolveAnchorWall, timeLines, toTimedPlays, type ResolvedAnchor } from './sync';
import { scanVideoClock, selectConsistentObservations } from './ocr';
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
    const range = `${espnDate(addDays(now, -daysBack))}-${espnDate(addDays(now, daysAhead))}`;
    const matches = await fetchScoreboard(range, league, 1000);
    db.upsertMatches(matches);
    return `${matches.length} matchs (${range})`;
  });
}

/**
 * Saison complète (année de début, ex. 2026 pour 2026-27), mois par mois de
 * septembre à juin pour ne pas buter sur la limite de 1000 matchs par requête.
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
        const matches = await fetchScoreboard(`${espnDate(from)}-${espnDate(to)}`, league, 1000);
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

export function syncVideos(limit = 20) {
  return runLogged('sync-videos', async () => {
    const since = addDays(new Date(), -21).toISOString();
    const recheckBefore = new Date(Date.now() - 2 * 3600_000).toISOString();
    const todo = db.finalMatchesNeedingVideo(since, recheckBefore, limit);
    const out: string[] = [];
    for (const m of todo) {
      try {
        const r = await findReplay(m);
        if (r.okId || r.slug) db.setVideo(m.id, { slug: r.slug, okId: r.okId, duration: r.duration, available: r.available });
        else db.markVideoChecked(m.id);
        out.push(`${m.away_abbr}@${m.home_abbr}: ${r.available ? `ok.ru/${r.okId} (${r.duration}s)` : r.reason}`);
        if (r.available) regenerateSubtitles(m.id);
      } catch (e) {
        db.markVideoChecked(m.id);
        out.push(`${m.id}: ${(e as Error).message}`);
      }
    }
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

// ------------------------------------------------------------------ analyse vidéo (OCR + audio)

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

interface AnalysisState {
  phase: 'ocr' | 'audio';
  done: number;
  total: number;
  startedAt: string;
}
const g = globalThis as unknown as { __analysis?: Map<number, AnalysisState> };
const analysis = (g.__analysis ??= new Map());

/**
 * Date du dernier lancement d'analyse, par match.
 *
 * Un scan OCR complet extrait ~130 images et lance ~130 passes tesseract :
 * environ 5 à 8 minutes de CPU. Sans garde, un appel non authentifié
 * (`POST /api/matches/[id]/sync` est accessible depuis l'UI, donc sans
 * jeton) permettrait de saturer le NAS en boucle. Le cooldown borne la
 * fréquence, `ANALYSIS_MIN_INTERVAL_MS` la rend configurable.
 */
const gLast = globalThis as unknown as { __analysisLast?: Map<number, number> };
const analysisLast = (gLast.__analysisLast ??= new Map());

export function analysisStatus(matchId: number): {
  status: 'none' | 'running' | 'done' | 'unavailable';
  progress?: AnalysisState;
} {
  const st = analysis.get(matchId);
  if (st) return { status: 'running', progress: st };
  if (db.getAnchors(matchId).some((a) => a.method === 'auto') || db.getAudioProfile(matchId)) return { status: 'done' };
  return { status: ffmpegAvailable() ? 'none' : 'unavailable' };
}

/** Variante utilisée pour l'OCR : 720p si dispo (le 480p est trop flou pour le chrono). */
function ocrVariant(stream: Awaited<ReturnType<typeof resolveOkStream>>) {
  return (
    stream.variants.find((v) => v.key === 'hd') ??
    [...stream.variants].filter((v) => /x(7\d\d|8\d\d)$/.test(v.resolution)).sort((a, b) => b.bandwidth - a.bandwidth)[0] ??
    [...stream.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0]
  );
}

/**
 * Lance l'analyse automatique de synchro en tâche de fond :
 * Phase A — OCR du chrono à l'écran → ancres 'auto' cohérentes ;
 * Phase B — énergie audio (coupures) si l'OCR n'a pas donné assez d'ancres
 *           (ou si `withAudio` est demandé explicitement).
 */
export function startVideoAnalysis(matchId: number, opts: { withAudio?: boolean } = {}): { started: boolean; reason?: string } {
  const match = db.getMatch(matchId);
  if (!match?.video_ok_id || !match.video_available) return { started: false, reason: 'pas de replay' };
  if (!ffmpegAvailable()) return { started: false, reason: 'ffmpeg absent' };
  if (analysis.has(matchId)) return { started: false, reason: 'déjà en cours' };
  // Une valeur non numérique donnerait NaN, et toute comparaison avec NaN
  // est fausse : la limite serait silencieusement désactivée.
  const maxParallel = Math.max(1, Math.trunc(Number(process.env.ANALYSIS_MAX_PARALLEL) || 1));
  if (analysis.size >= maxParallel) return { started: false, reason: 'une analyse est déjà en cours' };
  // Cooldown : une analyse coûte 5 à 8 min de CPU, on borne la fréquence.
  // `??` et non `||` : `ANALYSIS_MIN_INTERVAL_MS=0` doit pouvoir DÉSACTIVER
  // le cooldown (0 est une valeur intentionnelle, pas une valeur absente).
  const minIntervalRaw = process.env.ANALYSIS_MIN_INTERVAL_MS;
  const minInterval = Number.isFinite(Number(minIntervalRaw))
    ? Math.max(0, Math.trunc(Number(minIntervalRaw)))
    : 15 * 60_000;
  const last = analysisLast.get(matchId) ?? 0;
  const since = Date.now() - last;
  if (last && since < minInterval) {
    const waitMin = Math.ceil((minInterval - since) / 60_000);
    return { started: false, reason: `analyse récente, réessayez dans ~${waitMin} min` };
  }
  const okId = match.video_ok_id;
  const state: AnalysisState = { phase: 'ocr', done: 0, total: 0, startedAt: new Date().toISOString() };
  analysis.set(matchId, state);
  void runLogged(`analyse-${matchId}`, async () => {
    const report: string[] = [];
    let plays = db.getPlays(matchId);
    if (!plays.length) {
      await ingestMatchDetails(match);
      plays = db.getPlays(matchId);
    }
    const tp = toTimedPlays(plays);
    const breaks = findBreaks(tp);
    const stream = await resolveOkStream(okId, { force: true });
    const duration = match.video_duration ?? stream.duration ?? 0;

    // Phase A : OCR du chrono
    let ocrAnchors = 0;
    if (process.env.OCR_DISABLED !== '1') {
      const v = ocrVariant(stream);
      if (v) {
        const obs = await scanVideoClock(v.url, {
          userAgent: BROWSER_UA,
          referer: OK_REFERER,
          duration,
          stepSec: Number(process.env.OCR_STEP_SEC ?? 60),
          onProgress: (done, total) => Object.assign(state, { done, total }),
        });
        const anchors = selectConsistentObservations(obs, tp, breaks);
        db.replaceAnchorsByMethod(matchId, 'auto', anchors.map((a) => anchorRow(matchId, a)));
        ocrAnchors = anchors.length;
        report.push(`OCR: ${obs.length} lectures, ${anchors.length} ancres cohérentes`);
      }
    }

    // Phase B : énergie audio
    if (opts.withAudio || ocrAnchors < 3) {
      Object.assign(state, { phase: 'audio', done: 0, total: 1 });
      const fresh = await resolveOkStream(okId, { force: true });
      const v = lightestVariant(fresh);
      if (!v) throw new Error('aucune variante');
      const profile = await analyzeHlsAudio(v.url, { userAgent: BROWSER_UA, referer: OK_REFERER });
      const cuts = detectCuts(profile);
      db.saveAudioProfile({ match_id: matchId, ok_id: okId, window_sec: 1, rms_db: profile, cuts });
      report.push(`audio: ${profile.length} s, ${cuts.length} coupures`);
    }
    const n = regenerateSubtitles(matchId);
    report.push(`${n} sous-titres recalés`);
    return report.join(' ; ');
  })
    .then(() => {
      // Le cooldown n'est consommé qu'en cas de SUCCÈS : une analyse qui
      // échoue en 2 s (ok.ru indisponible) ne doit pas bloquer toute
      // nouvelle tentative pendant 15 min. Le cooldown est aussi compté
      // depuis la FIN, pas depuis le début : une analyse de plus de 15 min
      // ne peut ainsi pas être relancée immédiatement après sa fin.
      analysisLast.set(matchId, Date.now());
    })
    .finally(() => analysis.delete(matchId));
  return { started: true };
}

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
