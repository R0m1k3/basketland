/**
 * Traduction française des commentaires des replays, 100 % locale.
 *
 * Chaîne d'un match :
 *   audio du replay (ffmpeg, mono 16 kHz, Opus 24 kb/s, tronçons de 10 min)
 *   → transcription Whisper horodatée (speaches, GPU du NAS)
 *   → filtre des hallucinations, découpage en sous-titres lisibles
 *   → traduction EN→FR par lots (Ollama)
 *   → table `commentary_cues` (+ `commentary_tracks`) → API.
 *
 * Les fichiers intermédiaires (tronçons audio, transcriptions, traductions
 * déjà faites) vivent dans `${dataDir()}/commentary/<okId>/` : un travail
 * interrompu (serveur éteint, flux coupé, redémarrage) reprend là où il
 * s'était arrêté. Le dossier est supprimé après succès.
 *
 * File : un seul travail à la fois (le GPU est partagé entre Whisper et le
 * LLM, et avec le reste du NAS). Alimentation :
 *  - le planificateur met en file, toutes les 10 min, les matchs terminés
 *    depuis ≤ 10 jours qui ont un replay et pas de piste traduite pour la
 *    vidéo actuelle (`enqueueRecentCommentaries`) ;
 *  - ouvrir la fiche d'un match (GET des sous-titres) ou l'action « start »
 *    de l'API le met en TÊTE de file ; « retry » relance même après abandon.
 *
 * Backoff (même modèle que `analysis.ts`, état dans `kv_cache`) : flux vidéo
 * ou service local injoignable → nouvel essai rapide (15 min → 6 h), sans
 * compter dans l'abandon ; autre échec → 1 h, 4 h, 16 h, 24 h, puis abandon
 * tant que la vidéo ne change pas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { analysisSources, backoffMs, MAX_AUTO_FAILURES, networkBackoffMs, pickAudioSource } from './analysis';
import { ffmpegAvailable } from './audio';
import {
  commentaryConfig,
  ServiceError,
  transcribeAudio,
  translateBatch,
  whisperPrompt,
  type CommentaryConfig,
  type TranslatedLine,
  type TranslateContext,
  type TranslateLine,
} from './commentaryAi';
import { buildCues, filterTranscript, mergeTranscripts, shiftTranscript, wordsFromTranscript, type Cue, type Transcript } from './commentaryCues';
import { BROWSER_UA } from './http';
import { OK_REFERER, resolveOkStream, type OkStream } from './okru';
import { addDays } from './time';
import { OllamaSession, WhisperSession } from './localAi';

// ------------------------------------------------------------------ contrat de l'API

export type CommentaryStatusName = 'disabled' | 'none' | 'queued' | 'running' | 'ready' | 'failed';
export type CommentaryPhase = 'extraction' | 'preparation' | 'transcription' | 'traduction';

export interface CommentaryStatus {
  status: CommentaryStatusName;
  phase?: CommentaryPhase;
  progress?: { done: number; total: number };
  /** Rang dans la file (1 = prochain travail). */
  position?: number;
  reason?: string;
  models?: { transcribe: string; translate: string };
}

// ------------------------------------------------------------------ tronçons

/** Recouvrement entre deux tronçons (s) : un mot coupé à la frontière est entier dans l'un des deux. */
export const CHUNK_OVERLAP_SEC = 3;

export interface ChunkPlan {
  index: number;
  /** Début de l'extraction dans la vidéo (s). */
  start: number;
  /** Durée extraite (s). */
  length: number;
  /** Zone gardée de ce tronçon (milieu des mots dans [keepFrom, keepTo[). */
  keepFrom: number;
  keepTo: number;
}

/**
 * Découpe la vidéo en tronçons de `chunkSec`, chevauchant de
 * `overlap` secondes. Un reliquat de moins de 30 s est rattaché au tronçon
 * précédent ; le dernier tronçon est lu jusqu'à la fin du flux (la durée
 * annoncée par ok.ru est parfois un peu courte).
 */
export function planChunks(duration: number, chunkSec: number, overlap = CHUNK_OVERLAP_SEC): ChunkPlan[] {
  const d = Math.max(0, duration);
  let n = Math.max(1, Math.ceil(d / chunkSec));
  if (n > 1 && d - (n - 1) * chunkSec < 30) n--;
  const out: ChunkPlan[] = [];
  for (let i = 0; i < n; i++) {
    const keepFrom = i * chunkSec;
    const last = i === n - 1;
    const keepTo = last ? Number.POSITIVE_INFINITY : (i + 1) * chunkSec;
    const start = Math.max(0, keepFrom - overlap);
    const end = last ? d + 60 : keepTo + overlap;
    out.push({ index: i, start, length: Math.round(end - start), keepFrom, keepTo });
  }
  return out;
}

// ------------------------------------------------------------------ extraction audio (ffmpeg)

export interface ExtractOptions {
  userAgent?: string;
  referer?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Extrait un tronçon audio : mono 16 kHz, Opus 24 kb/s en Ogg (~11 Mo pour
 * une heure, largement suffisant pour Whisper). Écrit dans `<out>.part` puis
 * renomme : un fichier présent est toujours complet.
 */
export function extractAudioChunk(sourceUrl: string, start: number, length: number, outFile: string, o: ExtractOptions = {}): Promise<void> {
  const part = `${outFile}.part`;
  const http = /^https?:\/\//i.test(sourceUrl);
  return new Promise((resolve, reject) => {
    const ff = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...(http && o.userAgent ? ['-user_agent', o.userAgent] : []),
        ...(http && o.referer ? ['-headers', `Referer: ${o.referer}\r\n`] : []),
        '-ss',
        String(start),
        '-i',
        sourceUrl,
        '-t',
        String(length),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libopus',
        '-b:a',
        '24k',
        '-application',
        'voip',
        '-f',
        'ogg',
        '-y',
        part,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    const kill = () => ff.kill('SIGKILL');
    const timer = setTimeout(kill, o.timeoutMs ?? 20 * 60_000);
    o.signal?.addEventListener('abort', kill);
    ff.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-600)));
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
    };
    ff.on('error', (e) => {
      done();
      reject(e);
    });
    ff.on('close', (code) => {
      done();
      let size = 0;
      try {
        size = fs.statSync(part).size;
      } catch {
        size = 0;
      }
      // Un en-tête Ogg seul pèse quelques centaines d'octets : en dessous de
      // 1 Ko, aucun son n'a été lu.
      if (code === 0 && size > 1024) {
        fs.renameSync(part, outFile);
        resolve();
      } else {
        fs.rmSync(part, { force: true });
        reject(new Error(`ffmpeg audio @${start}s code ${code}${size <= 1024 ? ', aucun son lu' : ''}: ${err.replace(/\s+/g, ' ').trim()}`));
      }
    });
  });
}

/** Sources audio d'un flux, de la plus légère à la plus lourde (l'image ne sert à rien). */
export function audioSources(stream: Pick<OkStream, 'variants'>): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const first = pickAudioSource(stream);
  if (first) out.push(first);
  for (const s of [...analysisSources(stream)].reverse()) if (!out.some((o) => o.url === s.url)) out.push(s);
  return out;
}

// ------------------------------------------------------------------ dossier de travail

export function workDir(okId: string): string {
  return path.join(db.dataDir(), 'commentary', okId.replace(/[^\w-]/g, '_'));
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const chunkAudio = (dir: string, i: number) => path.join(dir, `chunk-${String(i).padStart(3, '0')}.ogg`);
const chunkJson = (dir: string, i: number) => path.join(dir, `chunk-${String(i).padStart(3, '0')}.json`);

interface ChunkCache {
  model: string;
  transcript: Transcript;
}

interface TranslationCache {
  model: string;
  /** seq → traduction, valable si le texte anglais n'a pas changé. */
  lines: Record<string, { en: string; fr: string; untranslated: boolean }>;
}

/** Supprime les dossiers de travail abandonnés (non modifiés depuis `maxAgeMs`). */
export function pruneWorkDirs(maxAgeMs = 10 * 24 * 3600_000, keep: string[] = []): number {
  const root = path.join(db.dataDir(), 'commentary');
  let n = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (keep.includes(dir)) continue;
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) {
        fs.rmSync(dir, { recursive: true, force: true });
        n++;
      }
    } catch {
      /* dossier disparu entre-temps */
    }
  }
  return n;
}

// ------------------------------------------------------------------ état persistant (kv_cache)

/**
 * Nature d'un échec : 'reseau' (flux vidéo inaccessible) et 'service'
 * (speaches ou Ollama injoignable) — réessayés vite, sans compter dans
 * l'abandon ; 'contenu' (aucune parole) ou 'erreur' — backoff long.
 */
export type CommentaryFailureKind = 'reseau' | 'service' | 'contenu' | 'erreur';

export interface CommentaryRecord {
  at: string;
  ok: boolean;
  failures: number;
  netFailures?: number;
  kind?: CommentaryFailureKind;
  reason: string;
  okId: string | null;
}

const recordKey = (matchId: number) => `commentary:${matchId}`;

export function getCommentaryRecord(matchId: number): CommentaryRecord | undefined {
  try {
    return db.kvGet<CommentaryRecord>(recordKey(matchId), Number.POSITIVE_INFINITY);
  } catch {
    return undefined;
  }
}

const quickRetry = (k: CommentaryFailureKind | undefined) => k === 'reseau' || k === 'service';

/** Une mise en file AUTOMATIQUE est-elle permise maintenant ? */
export function commentaryRetryAllowed(rec: CommentaryRecord | undefined, okId: string | null, now = Date.now()): boolean {
  if (!rec || rec.ok) return true; // succès : seule l'absence de piste pour la vidéo actuelle compte
  if (okId && rec.okId && okId !== rec.okId) return true; // nouvelle vidéo : on repart de zéro
  if (quickRetry(rec.kind)) return now - Date.parse(rec.at) >= networkBackoffMs(rec.netFailures ?? 1);
  if (rec.failures >= MAX_AUTO_FAILURES) return false;
  return now - Date.parse(rec.at) >= backoffMs(rec.failures);
}

// ------------------------------------------------------------------ file

interface Job {
  matchId: number;
  /** Relance explicite (« retry ») : refait même une piste prête. */
  force: boolean;
}

export interface CommentaryProgress {
  phase: CommentaryPhase;
  done: number;
  total: number;
}

export interface CommentaryOutcome {
  ok: boolean;
  reason: string;
  kind?: CommentaryFailureKind;
}

export type CommentaryRunner = (job: Job, progress: (p: CommentaryProgress) => void, signal: AbortSignal) => Promise<CommentaryOutcome>;

interface QueueState {
  queue: Job[];
  running: { job: Job; progress: CommentaryProgress | null; okId: string | null } | null;
  runner: CommentaryRunner | null;
  idle: Promise<void>;
  idleResolve: (() => void) | null;
}

const g = globalThis as unknown as { __commentaryQueue?: QueueState };
const st: QueueState = (g.__commentaryQueue ??= { queue: [], running: null, runner: null, idle: Promise.resolve(), idleResolve: null });

/** Durée maximale d'un travail (`COMMENTARY_TIMEOUT_MS`, 6 h par défaut : CPU seul, c'est long). */
function jobTimeoutMs(): number {
  const n = Number(process.env.COMMENTARY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 3600_000;
}

/** Fonctionnalité inactive (configuration, ffmpeg) : la raison, sinon null. */
export function commentaryDisabledReason(): string | null {
  const cfg = commentaryConfig();
  if (cfg.disabledReason) return cfg.disabledReason;
  if (!ffmpegAvailable()) return 'ffmpeg absent du serveur';
  return null;
}

/** Le match a-t-il un replay exploitable ? Sinon la raison. */
function unavailableReason(matchId: number): string | null {
  const m = db.getMatch(matchId);
  if (!m) return 'match introuvable';
  if (!m.video_ok_id || !m.video_available) return 'pas de replay disponible';
  return null;
}

/** La piste traduite correspond-elle au replay actuel ? */
export function commentaryReady(matchId: number): boolean {
  const m = db.getMatch(matchId);
  const t = db.getCommentaryTrack(matchId);
  return !!(m?.video_ok_id && t && t.ok_id === m.video_ok_id && t.cues > 0);
}

export function commentaryQueuePosition(matchId: number): number | null {
  const i = st.queue.findIndex((j) => j.matchId === matchId);
  return i < 0 ? null : i + 1;
}

export interface CommentaryEnqueueResult {
  queued: boolean;
  started: boolean;
  position?: number;
  message: string;
}

/**
 * Met un match en file. `priority` : en tête (demande de l'utilisateur) ;
 * `force` : refait même une piste déjà prête.
 */
export function enqueueCommentary(matchId: number, opts: { priority?: boolean; force?: boolean } = {}): CommentaryEnqueueResult {
  const disabled = commentaryDisabledReason();
  if (disabled) return { queued: false, started: false, message: `Traduction des commentaires inactive : ${disabled}` };
  const unavailable = unavailableReason(matchId);
  if (unavailable) return { queued: false, started: false, message: `Traduction impossible : ${unavailable}` };
  if (st.running?.job.matchId === matchId) return { queued: false, started: true, message: 'Traduction déjà en cours' };
  if (!opts.force && commentaryReady(matchId)) return { queued: false, started: false, message: 'Traduction des commentaires déjà prête' };
  const existing = st.queue.findIndex((j) => j.matchId === matchId);
  const job: Job = { matchId, force: !!opts.force || (existing >= 0 && st.queue[existing].force) };
  if (existing >= 0) {
    if (opts.priority) {
      st.queue.splice(existing, 1);
      st.queue.unshift(job);
    } else st.queue[existing] = job;
  } else if (opts.priority) st.queue.unshift(job);
  else st.queue.push(job);
  pump();
  if (st.running?.job.matchId === matchId) return { queued: true, started: true, message: 'Traduction des commentaires lancée' };
  const position = commentaryQueuePosition(matchId) ?? undefined;
  return {
    queued: true,
    started: false,
    position,
    message: existing >= 0 && !opts.priority ? `Traduction déjà en file (position ${position})` : `Traduction en file (position ${position})`,
  };
}

function pump(): void {
  while (!st.running && st.queue.length) {
    const job = st.queue.shift() as Job;
    if (commentaryDisabledReason() || unavailableReason(job.matchId)) continue;
    if (!job.force && commentaryReady(job.matchId)) continue;
    start(job);
  }
  if (!st.running && !st.queue.length && st.idleResolve) {
    st.idleResolve();
    st.idleResolve = null;
  }
}

function start(job: Job): void {
  if (!st.idleResolve) st.idle = new Promise((r) => (st.idleResolve = r));
  const okId = db.getMatch(job.matchId)?.video_ok_id ?? null;
  const state: NonNullable<QueueState['running']> = { job, progress: null, okId };
  st.running = state;
  const runner = st.runner ?? runCommentary;
  const logId = db.logIngestStart(`commentaires-${job.matchId}`);
  const ctrl = new AbortController();
  // Garde-fou : un travail qui ne rend jamais la main (serveur figé…) est
  // interrompu au lieu de bloquer la file pour toujours.
  let watchdog: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`délai dépassé (${Math.max(1, Math.round(jobTimeoutMs() / 60_000))} min)`));
    }, jobTimeoutMs());
    watchdog.unref?.();
  });
  void Promise.race([runner(job, (p) => (state.progress = { ...p }), ctrl.signal), timeout])
    .then(
      (res) => res,
      (e: unknown): CommentaryOutcome =>
        e instanceof ServiceError
          ? { ok: false, kind: 'service', reason: `${e.service === 'transcription' ? 'Transcription' : 'Traduction'} impossible : ${e.message}` }
          : { ok: false, kind: 'erreur', reason: `Traduction des commentaires impossible : ${(e as Error)?.message || String(e)}` },
    )
    .finally(() => clearTimeout(watchdog))
    .then((res) => {
      const prev = getCommentaryRecord(job.matchId);
      const sameVideo = !prev?.okId || prev.okId === okId;
      const kind = res.ok ? undefined : (res.kind ?? 'erreur');
      const failures = res.ok ? 0 : (sameVideo ? (prev?.failures ?? 0) : 0) + (quickRetry(kind) ? 0 : 1);
      const netFailures = quickRetry(kind) ? (sameVideo && quickRetry(prev?.kind) ? (prev?.netFailures ?? 0) : 0) + 1 : 0;
      try {
        db.kvSet(recordKey(job.matchId), {
          at: new Date().toISOString(),
          ok: res.ok,
          failures,
          reason: res.reason,
          okId,
          ...(kind ? { kind } : {}),
          ...(netFailures ? { netFailures } : {}),
        } satisfies CommentaryRecord);
        db.logIngestEnd(logId, res.ok, res.reason);
      } catch (e) {
        console.error('[commentaires] journalisation impossible :', (e as Error).message);
      }
      if (!res.ok) console.error(`[commentaires] match ${job.matchId} : ${res.reason}`);
    })
    .finally(() => {
      st.running = null;
      pump();
    });
}

function currentModels(): { transcribe: string; translate: string } {
  const cfg = commentaryConfig();
  return { transcribe: cfg.transcribeModel, translate: cfg.translateModel };
}

/** Statut de la traduction des commentaires d'un match (contrat de l'API). */
export function commentaryStatus(matchId: number): CommentaryStatus {
  if (st.running?.job.matchId === matchId) {
    const p = st.running.progress;
    return {
      status: 'running',
      ...(p ? { phase: p.phase, progress: { done: p.done, total: p.total } } : {}),
      models: currentModels(),
    };
  }
  const position = commentaryQueuePosition(matchId);
  if (position) return { status: 'queued', position, models: currentModels() };
  if (commentaryReady(matchId)) {
    const t = db.getCommentaryTrack(matchId) as db.CommentaryTrackRow;
    return {
      status: 'ready',
      models: { transcribe: t.transcribe_model, translate: t.translate_model },
      ...(t.untranslated ? { reason: `${t.untranslated} ligne(s) laissée(s) en anglais (traduction impossible)` } : {}),
    };
  }
  const disabled = commentaryDisabledReason();
  if (disabled) return { status: 'disabled', reason: disabled };
  const unavailable = unavailableReason(matchId);
  if (unavailable) return { status: 'none', reason: unavailable };
  const rec = getCommentaryRecord(matchId);
  const okId = db.getMatch(matchId)?.video_ok_id ?? null;
  if (rec && !rec.ok && (!rec.okId || rec.okId === okId)) return { status: 'failed', reason: rec.reason };
  return { status: 'none' };
}

/**
 * Ouverture de la fiche : met le match en tête de file s'il est terminé, a
 * un replay, n'a pas de piste à jour, et que le backoff le permet (un match
 * en échec n'est pas relancé à chaque affichage : « retry » est là pour ça).
 */
export function prioritizeOnView(matchId: number): void {
  const m = db.getMatch(matchId);
  if (!m || m.status !== 'final' || !m.video_ok_id || !m.video_available) return;
  if (st.running?.job.matchId === matchId || commentaryQueuePosition(matchId) === 1) return;
  if (commentaryDisabledReason() || commentaryReady(matchId)) return;
  if (!commentaryRetryAllowed(getCommentaryRecord(matchId), m.video_ok_id)) return;
  enqueueCommentary(matchId, { priority: true });
}

/** Job périodique : matchs terminés récents avec replay, sans piste à jour, backoff échu. */
export function enqueueRecentCommentaries(days = 10, limit = 30): number {
  if (commentaryDisabledReason()) return 0;
  pruneWorkDirs(10 * 24 * 3600_000, st.running?.okId ? [workDir(st.running.okId)] : []);
  const since = addDays(new Date(), -days).toISOString();
  let n = 0;
  for (const m of db.finalMatchesNeedingCommentary(since, limit)) {
    if (st.running?.job.matchId === m.id || commentaryQueuePosition(m.id)) continue;
    if (!commentaryRetryAllowed(getCommentaryRecord(m.id), m.video_ok_id)) continue;
    if (enqueueCommentary(m.id).queued) n++;
  }
  return n;
}

// ------------------------------------------------------------------ outils de test

/** Tests : remplace l'exécuteur, vide la file. */
export function __setCommentaryRunnerForTests(runner: CommentaryRunner | null): void {
  st.runner = runner;
  st.queue.length = 0;
  st.running = null;
  st.idleResolve?.();
  st.idleResolve = null;
  st.idle = Promise.resolve();
}

/** Tests : attend que la file soit vide. */
export function __commentaryIdle(): Promise<void> {
  return st.idle;
}

// ------------------------------------------------------------------ exécution d'un travail

/** Dépendances externes d'un travail (remplaçables dans les tests). */
export interface CommentaryDeps {
  resolveStream: (okId: string) => Promise<Pick<OkStream, 'variants' | 'duration'>>;
  extract: (sourceUrl: string, start: number, length: number, outFile: string, o: ExtractOptions) => Promise<void>;
  transcribe: (file: string, cfg: CommentaryConfig, o: { prompt?: string; signal?: AbortSignal }) => Promise<Transcript>;
  translate: (lines: TranslateLine[], context: string[], cfg: CommentaryConfig, o: TranslateContext) => Promise<TranslatedLine[]>;
  /**
   * Services embarqués (localAi.ts) : démarrés juste avant leur phase,
   * arrêtés juste après — Whisper et le modèle de traduction ne sont jamais
   * en mémoire GPU en même temps. Absents (tests, serveurs externes) : on
   * appelle `transcribe` / `translate` directement.
   */
  openTranscriber?: (cfg: CommentaryConfig, signal: AbortSignal) => Promise<Transcriber>;
  openTranslator?: (cfg: CommentaryConfig, signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<{ close(): Promise<void> }>;
}

export interface Transcriber {
  transcribe(file: string, prompt: string | undefined, signal: AbortSignal): Promise<Transcript>;
  close(): Promise<void>;
}

const defaultDeps: CommentaryDeps = {
  resolveStream: (okId) => resolveOkStream(okId, { force: true }),
  extract: extractAudioChunk,
  transcribe: transcribeAudio,
  translate: translateBatch,
  openTranscriber: async (cfg) => {
    if (cfg.transcribeMode !== 'embedded') return remoteTranscriber(cfg, transcribeAudio);
    const s = await WhisperSession.open(cfg.transcribeModel);
    return { transcribe: (file, prompt, signal) => s.transcribe(file, prompt, signal), close: () => s.close() };
  },
  openTranslator: async (cfg, signal, onProgress) => {
    if (cfg.translateMode !== 'embedded') return { close: async () => {} };
    const s = await OllamaSession.open();
    try {
      await s.ensureModel(cfg.translateModel, onProgress, signal);
    } catch (e) {
      await s.close();
      throw e;
    }
    return s;
  },
};

function remoteTranscriber(cfg: CommentaryConfig, transcribe: CommentaryDeps['transcribe']): Transcriber {
  return { transcribe: (file, prompt, signal) => transcribe(file, cfg, { prompt, signal }), close: async () => {} };
}

/** Message d'un flux vidéo inaccessible (aucun son extrait). */
function networkOutcome(detail: string, matchId: number): CommentaryOutcome {
  const rec = getCommentaryRecord(matchId);
  const wait = Math.round(networkBackoffMs((quickRetry(rec?.kind) ? (rec?.netFailures ?? 0) : 0) + 1) / 60_000);
  return {
    ok: false,
    kind: 'reseau',
    reason: `Flux vidéo inaccessible : l'audio n'a pas pu être extrait (${detail}). Problème réseau, pas de contenu : nouvel essai automatique dans ~${wait} min.`,
  };
}

const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, ' ').slice(0, 160);

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('travail interrompu');
}

/** Sous-titres (anglais) d'un match à partir des transcriptions de ses tronçons. */
export function cuesFromChunks(chunks: { plan: ChunkPlan; transcript: Transcript }[], prompt?: string): Cue[] {
  const placed = chunks.map(({ plan, transcript }) =>
    shiftTranscript(filterTranscript(transcript, { prompt }).transcript, plan.start, plan.keepFrom, plan.keepTo),
  );
  return buildCues(wordsFromTranscript(mergeTranscripts(placed)));
}

/**
 * Un travail complet. Les tronçons et transcriptions déjà présents dans le
 * dossier de travail sont réutilisés (reprise après échec).
 */
export async function runCommentary(
  job: Job,
  progress: (p: CommentaryProgress) => void,
  signal: AbortSignal,
  deps: CommentaryDeps = defaultDeps,
): Promise<CommentaryOutcome> {
  const t0 = Date.now();
  const cfg = commentaryConfig();
  if (cfg.disabledReason) return { ok: false, kind: 'erreur', reason: `Traduction des commentaires inactive : ${cfg.disabledReason}` };
  const match = db.getMatch(job.matchId);
  if (!match?.video_ok_id) throw new Error('pas de replay');
  const okId = match.video_ok_id;
  const dir = workDir(okId);
  fs.mkdirSync(dir, { recursive: true });

  // --- extraction
  let stream: Pick<OkStream, 'variants' | 'duration'>;
  try {
    stream = await deps.resolveStream(okId);
  } catch (e) {
    return networkOutcome(`résolution du flux : ${short(e)}`, job.matchId);
  }
  const duration = match.video_duration ?? stream.duration ?? 0;
  if (!duration) throw new Error('durée de la vidéo inconnue');
  const plans = planChunks(duration, cfg.chunkSec);
  const headers = { userAgent: BROWSER_UA, referer: OK_REFERER };
  let done = plans.filter((p) => fs.existsSync(chunkAudio(dir, p.index))).length;
  progress({ phase: 'extraction', done, total: plans.length });
  for (const plan of plans) {
    checkAborted(signal);
    const out = chunkAudio(dir, plan.index);
    if (fs.existsSync(out)) continue;
    let ok = false;
    let lastErr = '';
    // Toutes les sources du flux, puis une seconde fois après re-résolution
    // (URL signée expirée pendant un long travail).
    for (let round = 0; round < 2 && !ok; round++) {
      if (round === 1) {
        try {
          stream = await deps.resolveStream(okId);
        } catch (e) {
          lastErr = `résolution du flux : ${short(e)}`;
          break;
        }
      }
      const sources = audioSources(stream);
      if (!sources.length) {
        lastErr = 'aucune source audio (ni HLS ni MP4)';
        continue;
      }
      for (const s of sources.slice(0, 3)) {
        checkAborted(signal);
        try {
          await deps.extract(s.url, plan.start, plan.length, out, { ...headers, signal });
          ok = true;
          break;
        } catch (e) {
          lastErr = short(e);
        }
      }
    }
    if (!ok) return networkOutcome(`tronçon ${plan.index + 1}/${plans.length} : ${lastErr}`, job.matchId);
    progress({ phase: 'extraction', done: ++done, total: plans.length });
  }

  // --- transcription
  const roster = [
    ...new Set(
      db
        .getPlayerStats(job.matchId)
        .map((p) => p.player_name)
        .filter(Boolean),
    ),
  ];
  const prompt = whisperPrompt(match.home_name, match.away_name, roster);
  const chunks: { plan: ChunkPlan; transcript: Transcript }[] = [];
  // Le transcripteur n'est ouvert qu'au premier tronçon à transcrire : une
  // reprise dont tout est déjà en cache ne charge pas le modèle.
  let asr: Transcriber | null = null;
  try {
    for (const plan of plans) {
      checkAborted(signal);
      const cacheFile = chunkJson(dir, plan.index);
      const cached = readJson<ChunkCache>(cacheFile);
      let transcript: Transcript;
      if (cached && cached.model === cfg.transcribeModel && cached.transcript) transcript = cached.transcript;
      else {
        if (!asr) {
          progress({ phase: 'preparation', done: 0, total: 0 });
          asr = deps.openTranscriber ? await deps.openTranscriber(cfg, signal) : remoteTranscriber(cfg, deps.transcribe);
          progress({ phase: 'transcription', done: chunks.length, total: plans.length });
        }
        transcript = await asr.transcribe(chunkAudio(dir, plan.index), prompt, signal);
        writeJson(cacheFile, { model: cfg.transcribeModel, transcript } satisfies ChunkCache);
      }
      chunks.push({ plan, transcript });
      progress({ phase: 'transcription', done: chunks.length, total: plans.length });
    }
  } finally {
    await asr?.close();
  }
  const cues = cuesFromChunks(chunks, prompt);
  if (!cues.length) {
    return { ok: false, kind: 'contenu', reason: 'Aucune parole détectée dans le replay (transcription vide après filtrage)' };
  }

  // --- traduction
  const cacheFile = path.join(dir, 'translation.json');
  const cache: TranslationCache = readJson<TranslationCache>(cacheFile) ?? { model: cfg.translateModel, lines: {} };
  if (cache.model !== cfg.translateModel) Object.assign(cache, { model: cfg.translateModel, lines: {} });
  const names = [match.away_name, match.home_name, ...roster].join(', ');
  const batches: Cue[][] = [];
  for (let i = 0; i < cues.length; i += cfg.batch) batches.push(cues.slice(i, i + cfg.batch));
  let mt: { close(): Promise<void> } | null = null;
  try {
    if (batches.some((batch) => batch.some((c) => cache.lines[c.seq]?.en !== c.text))) {
      progress({ phase: 'preparation', done: 0, total: 0 });
      mt = deps.openTranslator ? await deps.openTranslator(cfg, signal, (done, total) => progress({ phase: 'preparation', done, total })) : null;
    }
    progress({ phase: 'traduction', done: 0, total: batches.length });
    for (const [b, batch] of batches.entries()) {
      checkAborted(signal);
      const todo = batch.filter((c) => cache.lines[c.seq]?.en !== c.text);
      if (todo.length) {
        const first = cues.indexOf(batch[0]);
        const context = cues.slice(Math.max(0, first - 4), first).map((c) => c.text);
        const res = await deps.translate(
          todo.map((c) => ({ i: c.seq, en: c.text })),
          context,
          cfg,
          { names, signal },
        );
        for (const r of res) {
          const c = todo.find((x) => x.seq === r.i);
          if (c) cache.lines[c.seq] = { en: c.text, fr: r.fr, untranslated: r.untranslated };
        }
        writeJson(cacheFile, cache);
      }
      progress({ phase: 'traduction', done: b + 1, total: batches.length });
    }
  } finally {
    await mt?.close();
  }

  const rows = cues.map((c) => {
    const t = cache.lines[c.seq];
    const translated = t && t.en === c.text && !t.untranslated;
    return { seq: c.seq, start_ts: c.start, end_ts: c.end, text_en: c.text, text_fr: translated ? t.fr : c.text, untranslated: translated ? 0 : 1 };
  });
  db.replaceCommentary(job.matchId, { ok_id: okId, transcribe_model: cfg.transcribeModel, translate_model: cfg.translateModel }, rows);
  fs.rmSync(dir, { recursive: true, force: true });
  const untranslated = rows.filter((r) => r.untranslated).length;
  return {
    ok: true,
    reason:
      `${rows.length} sous-titres traduits${untranslated ? ` (${untranslated} laissés en anglais)` : ''} ; ` +
      `${plans.length} tronçon(s), ${batches.length} lot(s) ; ${cfg.transcribeModel} + ${cfg.translateModel} ; ${Math.round((Date.now() - t0) / 1000)} s`,
  };
}
