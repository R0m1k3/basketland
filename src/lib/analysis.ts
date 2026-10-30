/**
 * File d'attente des analyses vidéo (synchro automatique de la VF).
 *
 * Une analyse = balayage OCR du chrono du bandeau (`videoScan.ts`), puis, si
 * l'OCR n'a pas donné assez d'ancres, analyse de l'énergie audio (coupures).
 * C'est coûteux (plusieurs minutes de CPU) : les analyses passent par une FILE,
 * traitée une à une (`ANALYSIS_MAX_PARALLEL`, 1 par défaut).
 *
 * Alimentation :
 *  - le planificateur (`scheduler.ts`) met en file, toutes les 10 min, les
 *    matchs terminés depuis ≤ 10 jours qui ont un replay et pas encore d'ancres
 *    OCR (`enqueueRecentAnalyses`) ;
 *  - l'action « analyze » de l'API met le match en TÊTE de file.
 *
 * Garde-fous :
 *  - cooldown après un SUCCÈS (`ANALYSIS_MIN_INTERVAL_MS`, 15 min par défaut)
 *    pour une relance manuelle ;
 *  - backoff exponentiel après un échec pour la mise en file automatique
 *    (1 h, 4 h, 16 h, puis 24 h ; abandon après 4 échecs tant que la vidéo ne
 *    change pas) : on ne boucle jamais sur un match qui échoue. L'état est
 *    persisté dans `kv_cache` (survit aux redémarrages).
 */
import * as db from './db';
import { analyzeHlsAudio, detectCuts, ffmpegAvailable } from './audio';
import { BROWSER_UA } from './http';
import { ingestMatchDetails, regenerateSubtitles } from './ingest';
import { grabFrame, scoreTimeline } from './ocr';
import { OK_REFERER, resolveOkStream, type OkStream } from './okru';
import type { ScoreboardLocation } from './scoreboard';
import { findBreaks, toTimedPlays, type ResolvedAnchor } from './sync';
import { addDays } from './time';
import type { AnchorRow } from './types';
import { scanVideo, type ScanPhase } from './videoScan';
import { inNightWindow } from './nightWindow';

// ------------------------------------------------------------------ choix de la source média

export interface AnalysisSource {
  kind: 'hls' | 'mp4';
  url: string;
  /** Clé de variante HLS ou nom de qualité ok.ru (mobile, lowest, low, sd, hd, full). */
  label: string;
  /** Hauteur d'image connue ou déduite, sinon null. */
  height: number | null;
}

/** Hauteurs des qualités MP4 d'ok.ru. */
const OK_QUALITY_HEIGHT: Record<string, number> = { mobile: 144, lowest: 240, low: 360, sd: 480, hd: 720, full: 1080, quad: 1440, ultra: 2160 };

interface SourceCandidate extends AnalysisSource {
  bandwidth: number;
}

/** Variantes HLS et MP4 d'un flux, sous une forme commune (champ `mp4` lu de façon tolérante). */
function sourceCandidates(stream: Pick<OkStream, 'variants'>): { hls: SourceCandidate[]; mp4: SourceCandidate[] } {
  const hls: SourceCandidate[] = (stream.variants ?? [])
    .filter((v) => v && typeof v.url === 'string' && v.url)
    .map((v) => {
      const m = /x(\d{3,4})$/.exec(v.resolution ?? '');
      return {
        kind: 'hls' as const,
        url: v.url,
        label: v.key,
        height: m ? Number(m[1]) : (OK_QUALITY_HEIGHT[v.key] ?? null),
        bandwidth: v.bandwidth || 0,
      };
    });
  // `mp4` est ajouté à OkStream par ailleurs ; on ne suppose rien de sa forme.
  const raw = (stream as { mp4?: unknown }).mp4;
  const mp4: SourceCandidate[] = (Array.isArray(raw) ? raw : [])
    .filter((x): x is { name: string; url: string } => !!x && typeof x === 'object' && typeof x.url === 'string' && !!x.url)
    .map((x) => {
      const name = String(x.name ?? '').toLowerCase();
      return { kind: 'mp4' as const, url: x.url, label: name, height: OK_QUALITY_HEIGHT[name] ?? null, bandwidth: 0 };
    });
  return { hls, mp4 };
}

/**
 * Meilleure entrée pour l'OCR : la plus haute ≤ 720p (le 480p est trop flou pour
 * le chrono, au-delà de 720p le coût de décodage grimpe pour rien) ; à défaut la
 * plus petite au-dessus ; les entrées de hauteur inconnue en dernier.
 */
function bestForOcr(list: SourceCandidate[]): SourceCandidate | undefined {
  const known = list.filter((c) => c.height !== null);
  const under = known.filter((c) => (c.height as number) <= 720).sort((a, b) => (b.height as number) - (a.height as number) || b.bandwidth - a.bandwidth);
  const over = known.filter((c) => (c.height as number) > 720).sort((a, b) => (a.height as number) - (b.height as number) || a.bandwidth - b.bandwidth);
  const unknown = list.filter((c) => c.height === null).sort((a, b) => b.bandwidth - a.bandwidth);
  if (under[0] && (under[0].height as number) >= 480) return under[0];
  return over[0] ?? under[0] ?? unknown[0];
}

const strip = (c: SourceCandidate | undefined): AnalysisSource | null =>
  c ? { kind: c.kind, url: c.url, label: c.label, height: c.height } : null;

/**
 * Source lue par ffmpeg pour l'OCR : flux HLS s'il a des variantes (≈ 720p de
 * préférence), sinon le meilleur MP4 progressif ≤ 720p, sinon le meilleur MP4.
 */
export function pickAnalysisSource(stream: Pick<OkStream, 'variants'>): AnalysisSource | null {
  const { hls, mp4 } = sourceCandidates(stream);
  if (hls.length) return strip(bestForOcr(hls));
  if (!mp4.length) return null;
  const under = mp4.filter((c) => c.height !== null && c.height <= 720).sort((a, b) => (b.height as number) - (a.height as number));
  if (under.length) return strip(under[0]);
  return strip([...mp4].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]);
}

/**
 * Toutes les sources exploitables pour l'OCR, de la meilleure à la moins
 * bonne : HLS (≈ 720p d'abord), puis MP4. Si la première ne livre aucune image
 * (403, segment indisponible), l'analyse essaie les suivantes.
 */
export function analysisSources(stream: Pick<OkStream, 'variants'>): AnalysisSource[] {
  const { hls, mp4 } = sourceCandidates(stream);
  const out: AnalysisSource[] = [];
  const first = pickAnalysisSource(stream);
  if (first) out.push(first);
  const rest = [...hls.filter((c) => (c.height ?? 0) <= 1080).sort((a, b) => Math.abs((a.height ?? 720) - 720) - Math.abs((b.height ?? 720) - 720)), ...mp4.filter((c) => (c.height ?? 0) <= 1080 && (c.height ?? 0) >= 360).sort((a, b) => Math.abs((a.height ?? 720) - 720) - Math.abs((b.height ?? 720) - 720))];
  for (const c of rest) if (!out.some((o) => o.url === c.url)) out.push(strip(c) as AnalysisSource);
  return out;
}

/** Source la plus légère pour l'analyse audio (l'image ne sert à rien). */
export function pickAudioSource(stream: Pick<OkStream, 'variants'>): AnalysisSource | null {
  const { hls, mp4 } = sourceCandidates(stream);
  if (hls.length) return strip([...hls].sort((a, b) => a.bandwidth - b.bandwidth || (a.height ?? 1e9) - (b.height ?? 1e9))[0]);
  return strip([...mp4].sort((a, b) => (a.height ?? 1e9) - (b.height ?? 1e9))[0]);
}

// ------------------------------------------------------------------ état persistant (kv_cache)

export interface AnalysisRecord {
  at: string;
  ok: boolean;
  /** Échecs consécutifs (remis à 0 au premier succès ou si la vidéo change). */
  failures: number;
  reason: string;
  anchors: number;
  okId: string | null;
  /**
   * Nature du dernier échec : 'reseau' (flux vidéo inaccessible, aucune image
   * extraite) — réessayé vite, sans compter dans l'abandon ; 'contenu'
   * (chrono illisible) ou 'erreur' — backoff long.
   */
  kind?: AnalysisFailureKind;
  /** Échecs réseau consécutifs. */
  netFailures?: number;
}

export type AnalysisFailureKind = 'reseau' | 'contenu' | 'erreur';

/** Backoff court d'un échec réseau : 15 min, 30 min, 1 h… jusqu'à 6 h. */
export function networkBackoffMs(netFailures: number): number {
  if (netFailures <= 0) return 0;
  return Math.min(6 * 3600_000, 15 * 60_000 * 2 ** (netFailures - 1));
}

const recordKey = (matchId: number) => `analysis:${matchId}`;
const locationKey = (okId: string) => `scoreboard:${okId}`;

export function getAnalysisRecord(matchId: number): AnalysisRecord | undefined {
  try {
    return db.kvGet<AnalysisRecord>(recordKey(matchId), Number.POSITIVE_INFINITY);
  } catch {
    return undefined;
  }
}

function saveRecord(matchId: number, r: AnalysisRecord): void {
  db.kvSet(recordKey(matchId), r);
}

/** Échecs automatiques au-delà desquels on n'essaie plus (tant que la vidéo ne change pas). */
export const MAX_AUTO_FAILURES = 4;

/** Délai avant une nouvelle tentative AUTOMATIQUE après `failures` échecs consécutifs. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(24 * 3600_000, 3600_000 * 4 ** (failures - 1));
}

/** Une mise en file automatique est-elle permise maintenant ? */
export function autoRetryAllowed(rec: AnalysisRecord | undefined, okId: string | null, now = Date.now()): boolean {
  if (!rec) return true;
  if (rec.ok) return false; // déjà réussie : seule une demande explicite relance
  if (okId && rec.okId && okId !== rec.okId) return true; // nouvelle vidéo : on repart de zéro
  // Flux inaccessible : problème réseau passager, pas de contenu — on réessaie vite.
  if (rec.kind === 'reseau') return now - Date.parse(rec.at) >= networkBackoffMs(rec.netFailures ?? 1);
  if (rec.failures >= MAX_AUTO_FAILURES) return false;
  return now - Date.parse(rec.at) >= backoffMs(rec.failures);
}

// ------------------------------------------------------------------ file

export type AnalysisStatusName = 'none' | 'queued' | 'running' | 'done' | 'estimated' | 'unavailable' | 'failed';

export interface AnalysisProgress {
  phase: string;
  done: number;
  total: number;
}

export interface AnalysisStatus {
  status: AnalysisStatusName;
  progress?: AnalysisProgress;
  reason?: string;
  /** Rang dans la file (1 = prochaine analyse). */
  position?: number;
  anchors_auto?: number;
}

interface Job {
  matchId: number;
  withAudio: boolean;
  manual: boolean;
  /** Mise en file par le job de nuit : abandonnée si elle n'a pas démarré avant la fin de la fenêtre. */
  background?: boolean;
}

interface RunState extends AnalysisProgress {
  startedAt: string;
}

/** Exécuteur d'une analyse (remplaçable dans les tests). */
export interface AnalysisOutcome {
  ok: boolean;
  anchors: number;
  reason: string;
  kind?: AnalysisFailureKind;
}

export type AnalysisRunner = (job: Job, progress: (p: AnalysisProgress) => void) => Promise<AnalysisOutcome>;

interface QueueState {
  queue: Job[];
  running: Map<number, RunState>;
  /** Fin du dernier SUCCÈS, par match (cooldown des relances manuelles). */
  lastSuccess: Map<number, number>;
  runner: AnalysisRunner | null;
  idle: Promise<void>;
  idleResolve: (() => void) | null;
}

const g = globalThis as unknown as { __analysisQueue?: QueueState };
const st: QueueState = (g.__analysisQueue ??= {
  queue: [],
  running: new Map(),
  lastSuccess: new Map(),
  runner: null,
  idle: Promise.resolve(),
  idleResolve: null,
});

function maxParallel(): number {
  // Une valeur non numérique donnerait NaN, et toute comparaison avec NaN
  // est fausse : la limite serait silencieusement désactivée.
  return Math.max(1, Math.trunc(Number(process.env.ANALYSIS_MAX_PARALLEL) || 1));
}

function minIntervalMs(): number {
  // `ANALYSIS_MIN_INTERVAL_MS=0` doit pouvoir DÉSACTIVER le cooldown.
  const raw = process.env.ANALYSIS_MIN_INTERVAL_MS;
  return raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Math.trunc(Number(raw))) : 15 * 60_000;
}

/** Durée maximale d'une analyse (`ANALYSIS_TIMEOUT_MS`, 90 min par défaut : l'audio seul peut prendre 45 min). */
function analysisTimeoutMs(): number {
  const n = Number(process.env.ANALYSIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 90 * 60_000;
}

/** Le match peut-il être analysé (replay + ffmpeg) ? Sinon, la raison. */
function unavailableReason(matchId: number): string | null {
  const match = db.getMatch(matchId);
  if (!match) return 'match introuvable';
  if (!match.video_ok_id || !match.video_available) return 'pas de replay disponible';
  if (!ffmpegAvailable()) return 'ffmpeg absent du serveur';
  return null;
}

export function queuePosition(matchId: number): number | null {
  const i = st.queue.findIndex((j) => j.matchId === matchId);
  return i < 0 ? null : i + 1;
}

export interface EnqueueResult {
  queued: boolean;
  started: boolean;
  position?: number;
  reason?: string;
  message: string;
}

/**
 * Met un match en file. `priority` le place en tête (demande explicite de
 * l'utilisateur) ; un match déjà en file est alors remonté.
 */
export function enqueueAnalysis(
  matchId: number,
  opts: { priority?: boolean; withAudio?: boolean; manual?: boolean; background?: boolean } = {},
): EnqueueResult {
  const reason = unavailableReason(matchId);
  if (reason) return { queued: false, started: false, reason, message: `Analyse impossible : ${reason}` };
  if (st.running.has(matchId)) return { queued: false, started: false, reason: 'déjà en cours', message: 'Analyse déjà en cours' };
  if (opts.manual) {
    const last = st.lastSuccess.get(matchId) ?? 0;
    const since = Date.now() - last;
    const minInterval = minIntervalMs();
    if (last && since < minInterval) {
      const wait = Math.ceil((minInterval - since) / 60_000);
      return { queued: false, started: false, reason: 'analyse récente', message: `Analyse récente, réessayez dans ~${wait} min` };
    }
  }
  const existing = st.queue.findIndex((j) => j.matchId === matchId);
  const job: Job = { matchId, withAudio: !!opts.withAudio, manual: !!opts.manual, background: !!opts.background && !opts.priority };
  if (existing >= 0) {
    const prev = st.queue[existing];
    job.withAudio ||= prev.withAudio;
    job.manual ||= prev.manual;
    job.background = job.background && !!prev.background;
    if (opts.priority) {
      st.queue.splice(existing, 1);
      st.queue.unshift(job);
    } else st.queue[existing] = job;
  } else if (opts.priority) st.queue.unshift(job);
  else st.queue.push(job);
  pump();
  if (st.running.has(matchId)) return { queued: true, started: true, message: 'Analyse lancée' };
  const position = queuePosition(matchId) ?? undefined;
  return {
    queued: true,
    started: false,
    position,
    message: existing >= 0 && !opts.priority ? `Analyse déjà en file (position ${position})` : `Analyse en file (position ${position})`,
  };
}

/** Démarre les analyses en attente tant que la limite de parallélisme le permet. */
function pump(): void {
  while (st.running.size < maxParallel() && st.queue.length) {
    const job = st.queue.shift() as Job;
    if (st.running.has(job.matchId) || unavailableReason(job.matchId)) continue;
    // Analyse de fond pas encore démarrée à la fin de la fenêtre de nuit : abandonnée.
    if (job.background && !inNightWindow()) continue;
    start(job);
  }
  if (!st.running.size && !st.queue.length && st.idleResolve) {
    st.idleResolve();
    st.idleResolve = null;
  }
}

function start(job: Job): void {
  if (!st.idleResolve) st.idle = new Promise((r) => (st.idleResolve = r));
  const state: RunState = { phase: 'préparation', done: 0, total: 0, startedAt: new Date().toISOString() };
  st.running.set(job.matchId, state);
  const runner = st.runner ?? runAnalysis;
  const okId = db.getMatch(job.matchId)?.video_ok_id ?? null;
  const logId = db.logIngestStart(`analyse-${job.matchId}`);
  // Garde-fou : une analyse qui ne rend jamais la main (worker bloqué…) passe
  // en échec au lieu de rester « en cours » et de bloquer la file.
  let watchdog: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error(`délai dépassé (${Math.max(1, Math.round(analysisTimeoutMs() / 60_000))} min)`)), analysisTimeoutMs());
    watchdog.unref?.();
  });
  void Promise.race([runner(job, (p) => Object.assign(state, p)), timeout])
    .then(
      (res) => res,
      (e: unknown): AnalysisOutcome => ({ ok: false, anchors: 0, kind: 'erreur', reason: `Analyse impossible : ${(e as Error)?.message || String(e)}` }),
    )
    .finally(() => clearTimeout(watchdog))
    .then((res) => {
      const prev = getAnalysisRecord(job.matchId);
      const sameVideo = !prev?.okId || prev.okId === okId;
      const kind: AnalysisFailureKind | undefined = res.ok ? undefined : (res.kind ?? 'contenu');
      // Un échec réseau ne compte pas dans l'abandon (le contenu n'est pas en cause).
      const failures = res.ok ? 0 : (sameVideo ? (prev?.failures ?? 0) : 0) + (kind === 'reseau' ? 0 : 1);
      const netFailures = kind === 'reseau' ? (sameVideo && prev?.kind === 'reseau' ? (prev.netFailures ?? 0) : 0) + 1 : 0;
      try {
        saveRecord(job.matchId, {
          at: new Date().toISOString(),
          ok: res.ok,
          failures,
          reason: res.reason,
          anchors: res.anchors,
          okId,
          ...(kind ? { kind } : {}),
          ...(netFailures ? { netFailures } : {}),
        });
        db.logIngestEnd(logId, res.ok, res.reason);
      } catch (e) {
        console.error('[analyse] journalisation impossible :', (e as Error).message);
      }
      // Le cooldown n'est consommé qu'en cas de SUCCÈS, et compté depuis la FIN.
      if (res.ok) st.lastSuccess.set(job.matchId, Date.now());
      else console.error(`[analyse] match ${job.matchId} : ${res.reason}`);
    })
    .finally(() => {
      st.running.delete(job.matchId);
      pump();
    });
}

/** Statut d'analyse d'un match (contrat de l'API GET /api/matches/[id]/sync). */
export function analysisStatus(matchId: number): AnalysisStatus {
  const run = st.running.get(matchId);
  if (run) return { status: 'running', progress: { phase: run.phase, done: run.done, total: run.total } };
  const position = queuePosition(matchId);
  if (position) return { status: 'queued', position };
  const anchors = db.getAnchors(matchId);
  const auto = anchors.filter((a) => a.method === 'auto').length;
  const rec = getAnalysisRecord(matchId);
  if (auto > 0) return { status: 'done', anchors_auto: auto, ...(rec?.reason ? { reason: rec.reason } : {}) };
  const unavailable = unavailableReason(matchId);
  if (unavailable) return { status: 'unavailable', reason: unavailable, anchors_auto: 0 };
  if (rec && !rec.ok) return { status: 'failed', reason: rec.reason, anchors_auto: 0 };
  // Calage sur les coupures audio seulement : approximatif, on le dit.
  if (anchors.some((a) => a.method === 'audio' || a.method === 'est')) {
    return { status: 'estimated', reason: 'calage approximatif (coupures audio), chrono non lu', anchors_auto: 0 };
  }
  return { status: 'none', anchors_auto: 0 };
}

/** Compatibilité : lance (met en tête de file) une analyse. */
export function startVideoAnalysis(matchId: number, opts: { withAudio?: boolean } = {}): { started: boolean; reason?: string } {
  const r = enqueueAnalysis(matchId, { priority: true, withAudio: opts.withAudio, manual: true });
  return { started: r.started, reason: r.started ? undefined : (r.reason ?? r.message) };
}

/**
 * Job périodique : met en file les matchs terminés récents (≤ `days` jours) avec
 * replay, sans ancre OCR, non calibrés à la main, et dont le backoff est échu.
 */
export function enqueueRecentAnalyses(days = 10, limit = 30): number {
  if (!ffmpegAvailable()) return 0;
  const since = addDays(new Date(), -days).toISOString();
  let n = 0;
  for (const m of db.finalMatchesNeedingAnalysis(since, limit)) {
    if (st.running.has(m.id) || queuePosition(m.id)) continue;
    if (db.getAnchors(m.id).filter((a) => a.method === 'manual').length >= 2) continue;
    if (!autoRetryAllowed(getAnalysisRecord(m.id), m.video_ok_id)) continue;
    const r = enqueueAnalysis(m.id, { background: true });
    if (r.queued) n++;
  }
  return n;
}

// ------------------------------------------------------------------ outils de test

/** Tests : remplace l'exécuteur, vide la file. */
export function __setAnalysisRunnerForTests(runner: AnalysisRunner | null): void {
  st.runner = runner;
  st.queue.length = 0;
  st.running.clear();
  st.lastSuccess.clear();
  st.idleResolve?.();
  st.idleResolve = null;
  st.idle = Promise.resolve();
}

/** Tests : attend que la file soit vide. */
export function __analysisIdle(): Promise<void> {
  return st.idle;
}

// ------------------------------------------------------------------ exécution d'une analyse

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

const PHASE_LABEL: Record<ScanPhase, string> = { localisation: 'localisation du bandeau', balayage: 'lecture du chrono', affinage: 'affinage' };

/**
 * Analyse complète d'un match :
 * Phase A — OCR du chrono (localisation du bandeau, balayage grossier, affinage) ;
 * Phase B — énergie audio si l'OCR n'a pas donné assez d'ancres (ou sur demande).
 */
/** Message d'un flux vidéo inaccessible (aucune image extraite par ffmpeg). */
function networkOutcome(detail: string, netFailures: number): AnalysisOutcome {
  const wait = Math.round(networkBackoffMs(netFailures + 1) / 60_000);
  return {
    ok: false,
    anchors: 0,
    kind: 'reseau',
    reason: `Flux vidéo inaccessible : aucune image n'a pu être extraite (${detail}). Problème réseau, pas de contenu : nouvel essai automatique dans ~${wait} min.`,
  };
}

async function runAnalysis(job: Job, progress: (p: AnalysisProgress) => void): Promise<AnalysisOutcome> {
  const matchId = job.matchId;
  const match = db.getMatch(matchId);
  if (!match?.video_ok_id) throw new Error('pas de replay');
  const okId = match.video_ok_id;
  let plays = db.getPlays(matchId);
  if (!plays.length) {
    await ingestMatchDetails(match);
    plays = db.getPlays(matchId);
  }
  if (!plays.length) throw new Error('play-by-play ESPN indisponible');
  const tp = toTimedPlays(plays);
  const breaks = findBreaks(tp);
  const stream = await resolveOkStream(okId, { force: true });
  const duration = match.video_duration ?? stream.duration ?? 0;
  if (!duration) throw new Error('durée de la vidéo inconnue');
  const headers = { userAgent: BROWSER_UA, referer: OK_REFERER };
  const report: string[] = [];

  let ocrAnchors = 0;
  if (process.env.OCR_DISABLED !== '1') {
    const sources = analysisSources(stream);
    if (!sources.length) throw new Error('aucune source vidéo exploitable (ni HLS ni MP4)');
    // Sonde : une image au milieu de la vidéo, source après source. Aucune
    // image = flux inaccessible (403 réseau…), à distinguer d'un chrono illisible.
    progress({ phase: 'accès au flux vidéo', done: 0, total: Math.min(4, sources.length) });
    let src: (typeof sources)[number] | null = null;
    let lastErr = '';
    for (const [i, s] of sources.slice(0, 4).entries()) {
      try {
        await grabFrame(s.url, Math.round(duration / 2), headers, 45_000);
        src = s;
        break;
      } catch (e) {
        lastErr = ((e as Error).message || String(e)).replace(/\s+/g, ' ').slice(0, 160);
      }
      progress({ phase: 'accès au flux vidéo', done: i + 1, total: Math.min(4, sources.length) });
    }
    if (!src) return networkOutcome(lastErr || 'ffmpeg', getAnalysisRecord(matchId)?.netFailures ?? 0);
    const source = src;
    let cached: ScoreboardLocation | null = null;
    try {
      cached = db.kvGet<ScoreboardLocation>(locationKey(okId), 30 * 24 * 3600_000) ?? null;
    } catch {
      cached = null;
    }
    const scan = await scanVideo({
      duration,
      tp,
      breaks,
      scores: scoreTimeline(plays),
      grab: (t) => grabFrame(source.url, t, headers),
      location: cached,
      stepSec: Number(process.env.OCR_STEP_SEC ?? 105),
      onProgress: (phase, done, total) => progress({ phase: PHASE_LABEL[phase], done, total }),
    });
    if (!scan.framesRead) return networkOutcome('flux coupé pendant le balayage', getAnalysisRecord(matchId)?.netFailures ?? 0);
    if (scan.location) db.kvSet(locationKey(okId), scan.location);
    db.replaceAnchorsByMethod(matchId, 'auto', scan.anchors.map((a) => anchorRow(matchId, a)));
    ocrAnchors = scan.anchors.length;
    const quarters = Object.keys(scan.perPeriod).length;
    report.push(
      `OCR (${source.kind} ${source.label}) : bandeau ${scan.location ? (scan.cachedLocation ? 'connu' : 'localisé') : 'non localisé'}, ` +
        `${scan.framesRead} images, ${scan.observations.length} lectures, ${ocrAnchors} ancres sur ${quarters} période(s), ` +
        `${Math.round(scan.elapsedMs / 1000)} s`,
    );
  }

  if (job.withAudio || ocrAnchors < 3) {
    progress({ phase: 'analyse audio', done: 0, total: 1 });
    const fresh = await resolveOkStream(okId, { force: true });
    const src = pickAudioSource(fresh);
    if (!src) throw new Error('aucune source audio exploitable');
    const profile = await analyzeHlsAudio(src.url, headers);
    const cuts = detectCuts(profile);
    db.saveAudioProfile({ match_id: matchId, ok_id: okId, window_sec: 1, rms_db: profile, cuts });
    report.push(`audio : ${profile.length} s, ${cuts.length} coupures`);
    progress({ phase: 'analyse audio', done: 1, total: 1 });
  }
  const n = regenerateSubtitles(matchId);
  report.push(`${n} sous-titres recalés`);
  // OCR désactivé volontairement : l'analyse audio seule est le résultat attendu.
  if (process.env.OCR_DISABLED === '1') return { ok: true, anchors: 0, reason: report.join(' ; ') };
  if (ocrAnchors < 2) {
    return { ok: false, anchors: ocrAnchors, kind: 'contenu', reason: `Chrono du bandeau illisible : synchro approximative (${report.join(' ; ')})` };
  }
  return { ok: true, anchors: ocrAnchors, reason: report.join(' ; ') };
}
