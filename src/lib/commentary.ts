/**
 * Traduction française des commentaires des replays (Whisper local + Ollama
 * local, ou l'API OpenAI si une clé est configurée).
 *
 * TRADUCTION À LA DEMANDE, devant la tête de lecture :
 *   ouvrir un match → travail lancé tout de suite (un travail de fond est
 *   mis en pause) → tronçons d'1 min À PARTIR DE LA POSITION DU SPECTATEUR :
 *   audio (ffmpeg) → Whisper → filtre des hallucinations, sous-titres →
 *   traduction → publication du tronçon (`commentary_cues` +
 *   `commentary_chunks`) → tronçon suivant. Les premiers sous-titres
 *   arrivent ~20-30 s après l'ouverture, puis la traduction prend de
 *   l'avance sur la lecture. Un saut dans la vidéo réoriente le travail
 *   (la fiche envoie sa position à chaque interrogation, `touchViewer`).
 *   Quand tout le match est fait, la piste est marquée complète.
 *
 * Rien ne tourne pour rien : sans signe de vie du spectateur pendant 3 min,
 * le travail se met en pause et les modèles sont DÉCHARGÉS (sessions
 * fermées dès la fin d'un travail). En tâche de fond, seule la
 * PRÉ-TRADUCTION DE NUIT (2 h-6 h, heure de Paris, `inNightWindow`) traduit
 * les matchs récents ; elle se met en pause à la fin de la fenêtre.
 *
 * Les fichiers intermédiaires (tronçons audio, transcriptions, traductions
 * déjà faites) vivent dans `${dataDir()}/commentary/<okId>/` : un travail
 * interrompu reprend là où il s'était arrêté, et ce qui est publié reste
 * affiché. Le dossier est supprimé quand la piste est complète.
 *
 * File : un seul travail à la fois (GPU partagé). Backoff (même modèle que
 * `analysis.ts`, état dans `kv_cache`) : flux vidéo ou service injoignable →
 * nouvel essai rapide (15 min → 6 h), sans compter dans l'abandon ; autre
 * échec → 1 h, 4 h, 16 h, 24 h, puis abandon tant que la vidéo ne change pas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { analysisSources, analysisStatus, backoffMs, enqueueAnalysis, MAX_AUTO_FAILURES, networkBackoffMs, pickAudioSource } from './analysis';
import { ffmpegAvailable } from './audio';
import {
  commentaryConfig,
  ServiceError,
  transcribeAudio,
  translateBatch,
  whisperPrompt,
  CONTEXT_LINES,
  type CommentaryConfig,
  type TranslatedLine,
  type TranslateContext,
  type TranslateLine,
} from './commentaryAi';
import { buildCues, filterTranscript, shiftTranscript, wordsFromTranscript, type AsrWord, type Cue, type Transcript } from './commentaryCues';
import { BROWSER_UA } from './http';
import { OK_REFERER, resolveOkStream, type OkStream } from './okru';
import { addDays } from './time';
import { OllamaSession, WhisperSession } from './localAi';
import { inNightWindow } from './nightWindow';
import { lowerPriority } from './procPriority';

export { inNightWindow };

// ------------------------------------------------------------------ contrat de l'API

export type CommentaryStatusName = 'disabled' | 'none' | 'queued' | 'running' | 'ready' | 'failed';
export type CommentaryPhase = 'extraction' | 'preparation' | 'transcription' | 'traduction';

export interface CommentaryStatus {
  status: CommentaryStatusName;
  phase?: CommentaryPhase;
  /**
   * Avancement de la phase. Extraction, transcription, traduction : en
   * tronçons d'1 min (`done` = tronçons dont les sous-titres sont publiés) ;
   * préparation : téléchargement d'un modèle, en Mo (0/0 sinon).
   */
  progress?: { done: number; total: number };
  /**
   * Piste pas encore complète : fin des sous-titres prêts d'un seul tenant
   * à partir de la position du spectateur (« disponibles jusqu'à 34:10 »).
   */
  available_until?: number;
  /** Rang dans la file (1 = prochain travail). */
  position?: number;
  /** Piste partielle : plages de vidéo déjà traduites, [[début, fin], …] (s). */
  covered?: [number, number][];
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
    lowerPriority(ff);
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

// Fichiers nommés par position dans la vidéo : un changement de découpage
// (COMMENTARY_CHUNK_SEC) n'en réutilise jamais un qui ne correspond pas.
const chunkName = (p: ChunkPlan) => `chunk-${String(Math.round(p.start)).padStart(5, '0')}-${p.length}`;
const chunkAudio = (dir: string, p: ChunkPlan) => path.join(dir, `${chunkName(p)}.ogg`);
const chunkJson = (dir: string, p: ChunkPlan) => path.join(dir, `${chunkName(p)}.json`);

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
  /**
   * Demandé par quelqu'un qui regarde la fiche (ouverture, « start », « retry ») :
   * passe devant un travail de fond, quitte à l'interrompre.
   */
  viewer?: boolean;
}

export interface CommentaryProgress {
  phase: CommentaryPhase;
  done: number;
  total: number;
  /** Secondes de vidéo couvertes par les sous-titres publiés jusqu'ici. */
  availableUntil?: number;
}

export interface CommentaryOutcome {
  ok: boolean;
  reason: string;
  kind?: CommentaryFailureKind;
  /** Mis en pause (plus de spectateur, fin de la fenêtre de nuit) : ni succès ni échec. */
  paused?: boolean;
}

export type CommentaryRunner = (
  job: Job,
  progress: (p: CommentaryProgress) => void,
  signal: AbortSignal,
  ctl: CommentaryControl,
) => Promise<CommentaryOutcome>;

// ------------------------------------------------------------------ spectateurs et fenêtre de nuit

/**
 * Spectateurs : chaque GET des sous-titres (la fiche ouverte les interroge
 * toutes les 12 s pendant la traduction) signale qu'un match est regardé,
 * et à quelle position. Sans signe de vie depuis `viewerIdleMs`, le travail
 * se met en pause et décharge les modèles.
 */
const viewers = ((globalThis as unknown as { __commentaryViewers?: Map<number, { at: number; t: number }> }).__commentaryViewers ??= new Map());

function viewerIdleMs(): number {
  const n = Number(process.env.COMMENTARY_VIEWER_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60_000;
}

/** Signe de vie d'un spectateur (position de lecture en secondes, si connue). */
export function touchViewer(matchId: number, t?: number | null): void {
  const prev = viewers.get(matchId);
  const pos = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : (prev?.t ?? 0);
  viewers.set(matchId, { at: Date.now(), t: pos });
}

export function viewerActive(matchId: number, now = Date.now()): boolean {
  const v = viewers.get(matchId);
  return !!v && now - v.at < viewerIdleMs();
}

/** Position du spectateur actif, sinon null. */
export function viewerPosition(matchId: number): number | null {
  return viewerActive(matchId) ? (viewers.get(matchId)?.t ?? 0) : null;
}

/** Pilotage d'un travail : continuer tant qu'on regarde le match (ou, pour un travail de fond, la nuit). */
function controlFor(job: Job): CommentaryControl {
  return {
    keepGoing: () => viewerActive(job.matchId) || (!job.viewer && inNightWindow()),
    target: () => viewerPosition(job.matchId) ?? 0,
    watching: () => viewerActive(job.matchId),
  };
}

interface QueueState {
  queue: Job[];
  running: {
    job: Job;
    progress: CommentaryProgress | null;
    okId: string | null;
    /** Interrompt le travail (préemption par un match regardé). */
    abort: () => void;
    /** Interrompu pour laisser passer un match regardé : remis en file, sans compter d'échec. */
    preempted: boolean;
  } | null;
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

/** Piste (complète ou partielle) produite pour le replay ACTUEL, sinon undefined. */
function currentTrack(matchId: number): db.CommentaryTrackRow | undefined {
  const m = db.getMatch(matchId);
  const t = db.getCommentaryTrack(matchId);
  return m?.video_ok_id && t && t.ok_id === m.video_ok_id && t.cues > 0 ? t : undefined;
}

/** La piste traduite correspond-elle au replay actuel, et est-elle complète ? */
export function commentaryReady(matchId: number): boolean {
  return currentTrack(matchId)?.complete === 1;
}

/**
 * Sous-titres à servir : ceux déjà publiés pour le replay actuel, même si la
 * piste est encore partielle (travail en cours, ou interrompu à mi-match).
 * Une piste d'un autre replay n'est jamais servie.
 */
export function servedCommentaryCues(matchId: number): db.CommentaryCueRow[] {
  return currentTrack(matchId) ? db.getCommentaryCues(matchId) : [];
}

/**
 * Piste partielle : fin (s) des sous-titres prêts d'un seul tenant à partir
 * de la position du spectateur (ou du début), d'après l'avancement du
 * travail ou, à défaut, les tronçons publiés en base.
 */
function availableUntil(matchId: number, progress: CommentaryProgress | null): number | undefined {
  if (progress?.availableUntil) return progress.availableUntil;
  const t = currentTrack(matchId);
  if (!t || t.complete) return undefined;
  const pos = viewerPosition(matchId) ?? 0;
  const ranges = db.commentaryCoverage(matchId);
  if (!ranges.length) return db.commentaryPublishedUntil(matchId) || undefined; // piste antérieure, en préfixe continu
  const r = ranges.find(([a, b]) => pos >= a - 0.5 && pos < b);
  return r ? r[1] : undefined;
}

/** Plages déjà traduites d'une piste partielle (la fiche les affiche sur la barre de lecture). */
function coveredRanges(matchId: number): [number, number][] | undefined {
  const t = currentTrack(matchId);
  if (!t || t.complete) return undefined;
  const r = db.commentaryCoverage(matchId);
  return r.length ? r : undefined;
}

/** Match en cours de traduction (badge « VF en cours » des listes), sinon null. */
export function commentaryRunningMatchId(): number | null {
  return st.running?.job.matchId ?? null;
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
  const job: Job = {
    matchId,
    force: !!opts.force || (existing >= 0 && st.queue[existing].force),
    viewer: !!opts.priority || (existing >= 0 && !!st.queue[existing].viewer),
  };
  if (existing >= 0) {
    if (opts.priority) {
      st.queue.splice(existing, 1);
      st.queue.unshift(job);
    } else st.queue[existing] = job;
  } else if (opts.priority) st.queue.unshift(job);
  else st.queue.push(job);
  if (opts.priority) preemptBackground();
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

/**
 * Un match regardé passe devant un travail de FOND en cours : celui-ci est
 * interrompu (ce qui est déjà transcrit ou traduit reste sur disque et en
 * base), puis remis en file juste derrière, sans compter comme un échec.
 * Un travail demandé par un autre spectateur n'est jamais interrompu.
 */
function preemptBackground(): void {
  const r = st.running;
  if (!r || r.job.viewer || r.preempted) return;
  r.preempted = true;
  console.log(`[commentaires] match ${r.job.matchId} mis en pause : le match ${st.queue[0]?.matchId} est regardé, il passe en premier`);
  r.abort();
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
  const ctrl = new AbortController();
  const state: NonNullable<QueueState['running']> = { job, progress: null, okId, abort: () => ctrl.abort(), preempted: false };
  st.running = state;
  const runner: CommentaryRunner = st.runner ?? ((j, p, sig, c) => runCommentary(j, p, sig, defaultDeps, c));
  const logId = db.logIngestStart(`commentaires-${job.matchId}`);
  const t0 = Date.now();
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
  void Promise.race([runner(job, (p) => (state.progress = { ...p }), ctrl.signal, controlFor(job)), timeout])
    .then(
      (res) => res,
      (e: unknown): CommentaryOutcome =>
        e instanceof ServiceError
          ? { ok: false, kind: 'service', reason: `${e.service === 'transcription' ? 'Transcription' : 'Traduction'} impossible : ${e.message}` }
          : { ok: false, kind: 'erreur', reason: `Traduction des commentaires impossible : ${(e as Error)?.message || String(e)}` },
    )
    .finally(() => clearTimeout(watchdog))
    .then((res) => {
      if (state.preempted) {
        // Pas un échec : reprise derrière le match regardé (le cache sur disque évite de tout refaire).
        try {
          db.logIngestEnd(logId, false, 'interrompu : un match regardé est passé devant');
        } catch {
          /* journal facultatif */
        }
        if (!st.queue.some((j) => j.matchId === job.matchId)) st.queue.splice(Math.min(1, st.queue.length), 0, { ...job, viewer: false });
        return;
      }
      if (res.paused) {
        // Ni succès ni échec : reprise à la prochaine ouverture du match (ou la nuit suivante).
        try {
          db.logIngestEnd(logId, true, res.reason);
        } catch {
          /* journal facultatif */
        }
        console.log(`[commentaires] match ${job.matchId} ${res.reason}`);
        return;
      }
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
      else {
        console.log(`[commentaires] match ${job.matchId} traduit en ${Math.max(1, Math.round((Date.now() - t0) / 60_000))} min : ${res.reason}`);
        // L'analyse vidéo (repères des quart-temps, « Revoir l'action ») ne
        // tourne plus à l'ouverture de la fiche, pour laisser la lecture et la
        // traduction démarrer vite : elle passe une fois la traduction finie.
        try {
          if (analysisStatus(job.matchId).status === 'none') enqueueAnalysis(job.matchId);
        } catch {
          /* analyse facultative */
        }
      }
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
    const until = availableUntil(matchId, p);
    const covered = coveredRanges(matchId);
    return {
      status: 'running',
      ...(p ? { phase: p.phase, progress: { done: p.done, total: p.total } } : {}),
      ...(until ? { available_until: until } : {}),
      ...(covered ? { covered } : {}),
      models: currentModels(),
    };
  }
  const position = commentaryQueuePosition(matchId);
  if (position) {
    const until = availableUntil(matchId, null);
    const covered = coveredRanges(matchId);
    return { status: 'queued', position, ...(until ? { available_until: until } : {}), ...(covered ? { covered } : {}), models: currentModels() };
  }
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
  const until = availableUntil(matchId, null);
  const extra = { ...(until ? { available_until: until } : {}), ...(coveredRanges(matchId) ? { covered: coveredRanges(matchId) } : {}) };
  if (rec && !rec.ok && (!rec.okId || rec.okId === okId)) return { status: 'failed', reason: rec.reason, ...extra };
  return { status: 'none', ...extra };
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
  for (const m of db.finalMatchesNeedingCommentary(since, limit, commentaryConfig().translateModel)) {
    if (st.running?.job.matchId === m.id || commentaryQueuePosition(m.id)) continue;
    if (!commentaryRetryAllowed(getCommentaryRecord(m.id), m.video_ok_id)) continue;
    // Piste complète d'un autre modèle de traduction : à refaire (sinon « déjà prête »).
    if (enqueueCommentary(m.id, { force: commentaryReady(m.id) }).queued) n++;
  }
  return n;
}

// ------------------------------------------------------------------ outils de test

/** Tests : remplace l'exécuteur, vide la file. */
export function __setCommentaryRunnerForTests(runner: CommentaryRunner | null): void {
  st.runner = runner;
  viewers.clear();
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
  /**
   * Flux ok.ru du replay. `force` : nouvelle résolution (URL signée expirée).
   * Sans `force`, le flux déjà résolu par le lecteur est réutilisé : le
   * re-résoudre au démarrage changerait les URL sous les pieds du proxy
   * vidéo en pleine lecture.
   */
  resolveStream: (okId: string, force?: boolean) => Promise<Pick<OkStream, 'variants' | 'duration'>>;
  extract: (sourceUrl: string, start: number, length: number, outFile: string, o: ExtractOptions) => Promise<void>;
  transcribe: (file: string, cfg: CommentaryConfig, o: { prompt?: string; signal?: AbortSignal }) => Promise<Transcript>;
  translate: (lines: TranslateLine[], context: string[], cfg: CommentaryConfig, o: TranslateContext) => Promise<TranslatedLine[]>;
  /**
   * Services embarqués (localAi.ts) : ouverts au premier besoin, fermés en
   * fin de travail (ou sur erreur / abandon). Par défaut les deux restent
   * ouverts ensemble ; en mode `gpuSequential`, Whisper est fermé avant
   * l'ouverture du traducteur. Absents (tests, serveurs externes) : on
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
  resolveStream: (okId, force) => resolveOkStream(okId, { force: !!force }),
  extract: extractAudioChunk,
  transcribe: transcribeAudio,
  translate: translateBatch,
  // Démarrage d'un service embarqué ou téléchargement d'un modèle en échec :
  // panne de SERVICE (nouvel essai rapide, sans compter d'échec), pas un
  // défaut du match — sinon toute la file échouerait match après match.
  openTranscriber: async (cfg) => {
    if (cfg.transcribeMode !== 'embedded') return remoteTranscriber(cfg, transcribeAudio);
    let s: WhisperSession;
    try {
      s = await WhisperSession.open(cfg.transcribeModel);
    } catch (e) {
      throw asServiceError(e, 'transcription');
    }
    return { transcribe: (file, prompt, signal) => s.transcribe(file, prompt, signal), close: () => s.close() };
  },
  openTranslator: async (cfg, signal, onProgress) => {
    if (cfg.translateMode !== 'embedded') return { close: async () => {} };
    let s: OllamaSession;
    try {
      s = await OllamaSession.open();
    } catch (e) {
      throw asServiceError(e, 'traduction');
    }
    try {
      await s.ensureModel(cfg.translateModel, onProgress, signal);
    } catch (e) {
      await s.close();
      throw asServiceError(e, 'traduction');
    }
    // Modèle chargé en mémoire GPU dès maintenant, pendant que Whisper travaille.
    await s.warm(cfg.translateModel, signal);
    return s;
  },
};

function asServiceError(e: unknown, service: 'transcription' | 'traduction'): ServiceError {
  return e instanceof ServiceError ? e : new ServiceError((e as Error)?.message || String(e), service);
}

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

/** Mots horodatés d'un tronçon : hallucinations retirées, remis à leur place dans la vidéo. */
export function chunkWords({ plan, transcript }: { plan: ChunkPlan; transcript: Transcript }, prompt?: string): AsrWord[] {
  // Chaque tronçon est lu SEUL (mots de niveau supérieur ou synthétiques,
  // ponctuation) : l'arrivée d'un tronçon ne change rien aux mots des autres.
  return wordsFromTranscript(shiftTranscript(filterTranscript(transcript, { prompt }).transcript, plan.start, plan.keepFrom, plan.keepTo));
}

/** Mots de plusieurs tronçons, dans l'ordre chronologique. */
export function wordsFromChunks(chunks: { plan: ChunkPlan; transcript: Transcript }[], prompt?: string): AsrWord[] {
  return chunks.flatMap((c) => chunkWords(c, prompt)).sort((a, b) => a.start - b.start);
}

/** Sous-titres (anglais) d'un match à partir des transcriptions de ses tronçons. */
export function cuesFromChunks(chunks: { plan: ChunkPlan; transcript: Transcript }[], prompt?: string): Cue[] {
  return buildCues(wordsFromChunks(chunks, prompt));
}

/**
 * Sous-titres d'UN tronçon, numérotés dans sa plage de seq
 * (`db.chunkSeqBase`) : les tronçons sont traduits et publiés dans le
 * désordre (position du spectateur d'abord), indépendamment les uns des
 * autres.
 */
export function chunkCues(plan: ChunkPlan, transcript: Transcript, prompt?: string): Cue[] {
  const base = db.chunkSeqBase(plan.index);
  return buildCues(chunkWords({ plan, transcript }, prompt)).map((c, k) => ({ ...c, seq: base + k + 1 }));
}

/** Index du tronçon qui contient la seconde `t`. */
export function chunkAt(plans: ChunkPlan[], t: number): number {
  const i = plans.findIndex((p) => t < p.keepTo);
  return i < 0 ? plans.length - 1 : i;
}

/**
 * Prochain tronçon à traduire : le premier pas encore fait à partir de la
 * position visée (celle du spectateur), puis, une fois la fin atteinte,
 * ceux d'avant. Undefined : tout est fait.
 */
export function nextChunk(plans: ChunkPlan[], done: Set<number>, target: number): ChunkPlan | undefined {
  if (!plans.length) return undefined;
  const at = Math.max(0, chunkAt(plans, Math.max(0, target)));
  for (let i = at; i < plans.length; i++) if (!done.has(i)) return plans[i];
  for (let i = 0; i < at; i++) if (!done.has(i)) return plans[i];
  return undefined;
}

/** Fin (s) des sous-titres prêts d'un seul tenant à partir de `t` (0 si le passage de `t` n'est pas traduit). */
export function coveredFrom(plans: ChunkPlan[], done: Set<number>, t: number, duration: number): number {
  let i = chunkAt(plans, Math.max(0, t));
  if (i < 0 || !done.has(i)) return 0;
  while (i + 1 < plans.length && done.has(i + 1)) i++;
  return Number.isFinite(plans[i].keepTo) ? plans[i].keepTo : duration;
}

/** Flux vidéo inaccessible pendant l'extraction d'un tronçon (échec « reseau »). */
class StreamUnavailable extends Error {}

/**
 * Pilotage d'un travail par la file :
 * - `keepGoing` : continuer ? (quelqu'un regarde le match, ou fenêtre de
 *   pré-traduction de nuit) — sinon le travail se met en pause après le
 *   tronçon en cours, et les modèles sont déchargés ;
 * - `target` : position (s) à traduire en priorité (celle du spectateur).
 */
export interface CommentaryControl {
  keepGoing(): boolean;
  target(): number;
  /**
   * Quelqu'un regarde : la traduction ne prend pas plus de
   * `COMMENTARY_MAX_LEAD_SEC` d'avance sur la lecture (elle attend), pour ne
   * pas télécharger le flux ok.ru en concurrence avec le lecteur sans besoin.
   */
  watching?(): boolean;
}

const RUN_TO_END: CommentaryControl = { keepGoing: () => true, target: () => 0 };

/** Avance maximale (s) de la traduction sur la lecture quand on regarde (5 min par défaut). */
function maxLeadSec(): number {
  const n = Number(process.env.COMMENTARY_MAX_LEAD_SEC);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Un travail : tronçon par tronçon (1 min), en commençant à la position du
 * spectateur, chaque tronçon publié dès qu'il est traduit. Les tronçons,
 * transcriptions et traductions déjà présents dans le dossier de travail
 * sont réutilisés ; les tronçons déjà publiés en base ne sont pas refaits.
 */
export async function runCommentary(
  job: Job,
  progress: (p: CommentaryProgress) => void,
  signal: AbortSignal,
  deps: CommentaryDeps = defaultDeps,
  ctl: CommentaryControl = RUN_TO_END,
): Promise<CommentaryOutcome> {
  const t0 = Date.now();
  const cfg = commentaryConfig();
  if (cfg.disabledReason) return { ok: false, kind: 'erreur', reason: `Traduction des commentaires inactive : ${cfg.disabledReason}` };
  const match = db.getMatch(job.matchId);
  if (!match?.video_ok_id) throw new Error('pas de replay');
  const okId = match.video_ok_id;
  const dir = workDir(okId);
  fs.mkdirSync(dir, { recursive: true });

  let stream: Pick<OkStream, 'variants' | 'duration'>;
  try {
    stream = await deps.resolveStream(okId);
  } catch (e) {
    return networkOutcome(`résolution du flux : ${short(e)}`, job.matchId);
  }
  const duration = match.video_duration ?? stream.duration ?? 0;
  if (!duration) throw new Error('durée de la vidéo inconnue');
  const plans = planChunks(duration, cfg.chunkSec);
  const total = plans.length;
  const headers = { userAgent: BROWSER_UA, referer: OK_REFERER };
  // Prompt Whisper (équipes + effectifs) seulement sur demande : mesuré, il
  // fait produire des segments de 30 s (voir `whisperPrompt`).
  const prompt =
    process.env.WHISPER_PROMPT === '1'
      ? whisperPrompt(match.home_name, match.away_name, [
          ...new Set(
            db
              .getPlayerStats(job.matchId)
              .map((p) => p.player_name)
              .filter(Boolean),
          ),
        ])
      : undefined;
  const track: db.CommentaryTrackMeta = {
    ok_id: okId,
    transcribe_model: cfg.transcribeModel,
    translate_model: cfg.translateModel,
    chunk_sec: cfg.chunkSec,
    chunks_total: total,
  };
  // Relance explicite d'une piste complète : on repart de zéro ; sinon reprise.
  const done = db.openCommentaryTrack(job.matchId, track, job.force && db.getCommentaryTrack(job.matchId)?.complete === 1);

  const cacheFile = path.join(dir, 'translation.json');
  const cache: TranslationCache = readJson<TranslationCache>(cacheFile) ?? { model: cfg.translateModel, lines: {} };
  if (cache.model !== cfg.translateModel) Object.assign(cache, { model: cfg.translateModel, lines: {} });

  const report = (phase: CommentaryPhase, d: number, tot = total) => {
    const until = coveredFrom(plans, done, ctl.target(), duration);
    progress({ phase, done: d, total: tot, ...(until > 0 ? { availableUntil: until } : {}) });
  };

  // Sessions ouvertes au premier besoin (une reprise dont tout est en cache
  // ne charge aucun modèle), fermées — modèles déchargés — dès la fin du
  // travail, sur erreur, pause ou abandon.
  let asr: Transcriber | null = null;
  // Traducteur : démarré EN PARALLÈLE de la première extraction et de
  // Whisper (Ollama + chargement du modèle prennent ~10-30 s), attendu au
  // moment de traduire.
  let mtPromise: Promise<{ close(): Promise<void> } | null> | null = null;
  const openMt = () => {
    if (!mtPromise) {
      mtPromise = deps.openTranslator ? deps.openTranslator(cfg, signal, (d, tot) => report('preparation', d, tot)) : Promise.resolve(null);
      mtPromise.catch(() => undefined); // l'erreur est remontée par l'attente dans translateAndPublish
    }
    return mtPromise;
  };
  const closeAsr = async () => {
    const s = asr;
    asr = null;
    await s?.close();
  };
  const closeMt = async () => {
    const p = mtPromise;
    mtPromise = null;
    const s = p ? await p.catch(() => null) : null;
    await s?.close();
  };
  // Extraction anticipée du tronçon suivant pendant que le GPU traite le
  // courant (réseau et GPU travaillent en même temps).
  const prefetched = new Map<number, Promise<void>>();

  /** Extrait l'audio d'un tronçon (toutes les sources, puis une re-résolution du flux). */
  const extract = async (plan: ChunkPlan, out: string) => {
    let lastErr = '';
    // URL signée expirée pendant un long travail : on re-résout une fois.
    for (let round = 0; round < 2; round++) {
      if (round === 1) {
        try {
          stream = await deps.resolveStream(okId, true);
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
          return;
        } catch (e) {
          lastErr = short(e);
        }
      }
    }
    throw new StreamUnavailable(`tronçon ${plan.index + 1}/${total} : ${lastErr}`);
  };

  /** Transcription d'un tronçon : cache, sinon extraction (si besoin) puis Whisper. */
  const transcribeChunk = async (plan: ChunkPlan): Promise<Transcript> => {
    const cacheJson = chunkJson(dir, plan);
    const cached = readJson<ChunkCache>(cacheJson);
    if (cached && cached.model === cfg.transcribeModel && cached.transcript) return cached.transcript;
    const audio = chunkAudio(dir, plan);
    const pending = prefetched.get(plan.index);
    if (pending) {
      prefetched.delete(plan.index);
      await pending.catch(() => undefined); // un échec est retenté ci-dessous
    }
    if (!fs.existsSync(audio)) {
      report('extraction', done.size);
      await extract(plan, audio);
    }
    checkAborted(signal);
    if (!asr) {
      report('preparation', 0, 0);
      asr = deps.openTranscriber ? await deps.openTranscriber(cfg, signal) : remoteTranscriber(cfg, deps.transcribe);
    }
    report('transcription', done.size);
    const transcript = await asr.transcribe(audio, prompt, signal);
    writeJson(cacheJson, { model: cfg.transcribeModel, transcript } satisfies ChunkCache);
    fs.rmSync(audio, { force: true }); // transcrit : l'audio ne sert plus
    return transcript;
  };

  let batches = 0;

  /** Traduit et publie les sous-titres d'un tronçon. */
  const translateAndPublish = async (plan: ChunkPlan, cues: Cue[]) => {
    const todoAll = cues.filter((c) => cache.lines[c.seq]?.en !== c.text);
    if (todoAll.length) await openMt();
    if (cues.length) report('traduction', done.size);
    // Contexte du premier lot : les sous-titres déjà publiés juste avant ce tronçon.
    const before = db.commentaryCuesBefore(job.matchId, plan.keepFrom, CONTEXT_LINES);
    const starts: number[] = [];
    for (let k = 0; k < cues.length; k += cfg.batch) starts.push(k);
    let nextBatch = 0;
    // Lots indépendants (le contexte est l'anglais des lignes précédentes) :
    // `cfg.parallel` lots partent en même temps.
    const worker = async () => {
      while (nextBatch < starts.length) {
        const k = starts[nextBatch++];
        checkAborted(signal);
        const batch = cues.slice(k, k + cfg.batch);
        batches++;
        const todo = batch.filter((c) => cache.lines[c.seq]?.en !== c.text);
        if (!todo.length) continue;
        const context = [...before, ...cues.slice(0, k).map((c) => c.text)].slice(-CONTEXT_LINES);
        const res = await deps.translate(
          todo.map((c) => ({ i: c.seq, en: c.text })),
          context,
          cfg,
          { signal },
        );
        for (const r of res) {
          const c = todo.find((x) => x.seq === r.i);
          if (c) cache.lines[c.seq] = { en: c.text, fr: r.fr, untranslated: r.untranslated };
        }
        writeJson(cacheFile, cache);
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.parallel, starts.length) }, worker));
    db.publishCommentaryChunk(
      job.matchId,
      track,
      { idx: plan.index, keepFrom: plan.keepFrom, keepTo: plan.keepTo },
      cues.map((c) => {
        const t = cache.lines[c.seq];
        const translated = t && t.en === c.text && !t.untranslated;
        return { seq: c.seq, start_ts: c.start, end_ts: c.end, text_en: c.text, text_fr: translated ? t.fr : c.text, untranslated: translated ? 0 : 1 };
      }),
    );
    done.add(plan.index);
    report('traduction', done.size);
  };

  let paused = false;
  try {
    for (;;) {
      checkAborted(signal);
      const plan = nextChunk(plans, done, ctl.target());
      if (!plan) break;
      if (!ctl.keepGoing()) {
        paused = true;
        break;
      }
      // Assez d'avance sur la lecture : on attend que le spectateur avance.
      const target = ctl.target();
      if (ctl.watching?.() && coveredFrom(plans, done, target, duration) - target >= maxLeadSec()) {
        await pause(Number(process.env.COMMENTARY_LEAD_POLL_MS) || 5_000, signal);
        continue;
      }
      void openMt();
      // Pendant ce tronçon, l'audio du suivant probable se télécharge.
      const next = nextChunk(plans, new Set([...done, plan.index]), ctl.target());
      if (next && !prefetched.has(next.index)) {
        const file = chunkAudio(dir, next);
        if (!fs.existsSync(file) && !fs.existsSync(chunkJson(dir, next))) prefetched.set(next.index, extract(next, file));
      }
      const transcript = await transcribeChunk(plan);
      await translateAndPublish(plan, chunkCues(plan, transcript, prompt));
    }
  } catch (e) {
    if (e instanceof StreamUnavailable) return networkOutcome(e.message, job.matchId);
    throw e;
  } finally {
    await Promise.all([...prefetched.values()].map((p) => p.catch(() => undefined)));
    await closeAsr();
    await closeMt();
  }

  const minutes = Math.max(1, Math.round((Date.now() - t0) / 60_000));
  if (paused) {
    return {
      ok: false,
      paused: true,
      reason: `en pause (${done.size}/${total} tronçons traduits) : plus personne ne regarde, ou hors de la fenêtre de pré-traduction`,
    };
  }
  const t = db.getCommentaryTrack(job.matchId);
  if (!t || !t.cues) {
    return { ok: false, kind: 'contenu', reason: 'Aucune parole détectée dans le replay (transcription vide après filtrage)' };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    ok: true,
    reason:
      `${t.cues} sous-titres traduits${t.untranslated ? ` (${t.untranslated} laissés en anglais)` : ''} ; ` +
      `${total} tronçon(s), ${batches} lot(s) ; ${cfg.transcribeModel} + ${cfg.translateModel} ; ${minutes} min`,
  };
}
