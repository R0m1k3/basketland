/**
 * Doublage français des commentaires : les sous-titres traduits
 * (commentary.ts) sont dits par des voix de synthèse (moteur voiceAi.ts),
 * tronçon par tronçon, et servis au lecteur comme pistes audio
 * (GET /api/matches/[id]/dub).
 *
 * QUAND : un match est doublé une fois ses sous-titres français publiés —
 * les tronçons présents dans `commentary_chunks` pour la piste traduite du
 * replay actuel, complète ou partielle. Si la piste traduite change (autre
 * vidéo, autres modèles, autre découpage), le doublage est effacé et refait.
 *
 * PAR TRONÇON : audio du tronçon réextrait (ffmpeg) → empreinte vocale de
 * chaque réplique (ECAPA, hauteur de voix) → regroupement en locuteurs (par
 * match, en ligne) → voix attribuée à chaque locuteur, stable pour tout le
 * match → synthèse de chaque réplique → calage sur la durée de la réplique
 * (accélération limitée, `atempo`) → montage du tronçon (silence + répliques
 * à leur place) en AAC mono 24 kHz → `${dataDir()}/dub/<match>/chunk-<idx>.m4a`
 * (écrit en .part puis renommé) → publication en base (`dub_chunks`).
 *
 * GPU PARTAGÉ : le doublage ne tourne jamais en même temps qu'une
 * traduction ou une analyse vidéo. Si l'une démarre, le doublage ferme son
 * moteur de voix à la prochaine réplique (ou au prochain tronçon) et se
 * remet en file ; il reprend quand le GPU est libre.
 *
 * PRIORITÉ À LA LECTURE (même règle que la traduction) : un doublage de
 * fond s'efface pendant qu'on regarde un AUTRE match ; le doublage du match
 * regardé passe en premier (à partir de la position du spectateur), mais
 * seulement si ses sous-titres existent et qu'aucune traduction ne tourne.
 * En tâche de fond (fenêtre `COMMENTARY_NIGHT_WINDOW`, paramètre
 * `auto_translate`), les matchs récents traduits sont doublés.
 *
 * File : un seul doublage à la fois. Échecs (état dans `kv_cache`) : moteur
 * de voix qui ne démarre pas ou flux vidéo inaccessible → nouvel essai
 * rapide (15 min, puis de plus en plus espacé), sans compter dans l'abandon ;
 * autre échec → 1 h, 4 h, 16 h, 24 h, puis abandon tant que la piste
 * traduite ne change pas. Une réplique qui échoue est sautée (journalisée),
 * pas tout le tronçon — sauf si toutes échouent (moteur en panne).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { analysisActivity, backoffMs, MAX_AUTO_FAILURES, networkBackoffMs } from './analysis';
import { ffmpegAvailable } from './audio';
import { audioSources, commentaryActivity, commentaryQueuePosition, extractAudioChunk, type ExtractOptions } from './commentary';
import { BROWSER_UA } from './http';
import { inNightWindow } from './nightWindow';
import { OK_REFERER, resolveOkStream, type OkStream } from './okru';
import { lowerPriority } from './procPriority';
import { getSetting } from './settings';
import { addDays } from './time';
import { someoneWatching, viewerActive, viewerPosition } from './viewers';

// ------------------------------------------------------------------ moteur de voix (contrat de voiceAi.ts)

/** Voix du moteur : A commentateur principal, B4 consultant, B1 troisième voix, F voix féminine (facultative). */
export type VoiceRole = 'A' | 'B4' | 'B1' | 'F';

export const ROLE_LABELS: Record<VoiceRole, string> = {
  A: 'Commentateur',
  B4: 'Consultant',
  B1: 'Troisième voix',
  F: 'Voix féminine',
};

const ROLE_ORDER: VoiceRole[] = ['A', 'B4', 'B1', 'F'];

/** Session du moteur de voix (structure de `VoiceSession`, voiceAi.ts). */
export interface VoiceSessionLike {
  /** Voix présentes : 'A', 'B4', 'B1' et peut-être 'F'. */
  readonly voices: string[];
  /** Synthèse d'une réplique dans un WAV mono. */
  synth(text: string, voice: string, outFile: string, signal?: AbortSignal): Promise<{ duration: number; sampleRate: number }>;
  /** Empreintes ECAPA (192-d, normées) et hauteur médiane (Hz) de chaque segment [début, fin] (s, dans le fichier). */
  embed(file: string, segments: [number, number][], signal?: AbortSignal): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[] }>;
  close(): Promise<void>;
}

export interface VoiceEngine {
  config(): { disabledReason?: string };
  open(signal?: AbortSignal): Promise<VoiceSessionLike>;
}

interface VoiceAiModule {
  VoiceSession: { open(signal?: AbortSignal): Promise<VoiceSessionLike> };
  voiceConfig(): { disabledReason?: string };
}

interface EngineState {
  engine: VoiceEngine | null;
  loading: Promise<VoiceEngine | null> | null;
  loadError: string | null;
  override: VoiceEngine | null;
}

const ge = globalThis as unknown as { __dubEngine?: EngineState };
const eng: EngineState = (ge.__dubEngine ??= { engine: null, loading: null, loadError: null, override: null });

/**
 * Moteur de voix, chargé au premier besoin : rien n'est importé (ni lancé)
 * tant qu'aucun doublage n'est demandé. Null si le module ne se charge pas.
 */
async function loadEngine(): Promise<VoiceEngine | null> {
  if (eng.override) return eng.override;
  if (eng.engine) return eng.engine;
  eng.loading ??= (async () => {
    try {
      // Import différé (rien n'est chargé tant qu'aucun doublage n'est demandé) ;
      // l'annotation vérifie le contrat de voiceAi.ts à la compilation.
      const m: VoiceAiModule = await import('./voiceAi');
      eng.engine = { config: () => m.voiceConfig(), open: (signal) => m.VoiceSession.open(signal) };
      eng.loadError = null;
      return eng.engine;
    } catch (e) {
      eng.loadError = short(e);
      return null;
    } finally {
      eng.loading = null;
    }
  })();
  return eng.loading;
}

/**
 * Doublage inactif : la raison, sinon null. Synchrone : tant que le moteur
 * n'est pas chargé, seuls DUB_DISABLED et ffmpeg sont vérifiés (voir
 * `dubDisabledReason` pour la réponse complète).
 */
export function dubDisabledReasonSync(): string | null {
  if (process.env.DUB_DISABLED === '1') return 'doublage désactivé (DUB_DISABLED=1)';
  const e = eng.override ?? eng.engine;
  if (e) {
    try {
      const r = e.config().disabledReason;
      if (r) return r;
    } catch (err) {
      return `moteur de voix mal configuré : ${short(err)}`;
    }
  } else if (eng.loadError) return `moteur de voix indisponible : ${eng.loadError}`;
  if (!ffmpegAvailable()) return 'ffmpeg absent du serveur';
  return null;
}

/** Doublage inactif : la raison (configuration du moteur comprise), sinon null. */
export async function dubDisabledReason(): Promise<string | null> {
  if (process.env.DUB_DISABLED !== '1') await loadEngine();
  return dubDisabledReasonSync();
}

/** Pré-traduction et doublage automatiques permis (paramètre de /parametres) ? */
const autoDubEnabled = () => getSetting('auto_translate') !== '0';

// ------------------------------------------------------------------ réglages

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : def;
}

/** Similarité cosinus minimale pour rattacher une réplique à un locuteur connu. */
export const speakerSimThreshold = () => envNum('DUB_SPEAKER_SIM', 0.6);
/** Hauteur de voix médiane (Hz) à partir de laquelle un locuteur prend la voix féminine. */
export const femaleF0Hz = () => envNum('DUB_FEMALE_F0', 165);
/** Une réplique plus courte (s) ne crée jamais de nouveau locuteur (empreinte trop peu fiable). */
const minNewSpeakerSec = () => envNum('DUB_MIN_NEW_SPEAKER_SEC', 1);

/** Accélération maximale d'une réplique trop longue pour sa place. */
export const MAX_TEMPO = 1.35;
/** Une réplique peut déborder de 0,6 s après la fin du sous-titre (si le suivant n'a pas commencé). */
export const SLOT_TAIL_SEC = 0.6;
/** Écart minimal entre deux répliques doublées (s). */
const CLIP_GAP_SEC = 0.05;
/** Fréquence d'échantillonnage des pistes doublées. */
export const DUB_SAMPLE_RATE = 24_000;

// ------------------------------------------------------------------ locuteurs (fonctions pures)

export interface Speaker {
  id: number;
  /** Moyenne courante des empreintes (non normée). */
  centroid: number[];
  n: number;
  /** Temps de parole cumulé (s). */
  talk: number;
  /** Hauteurs de voix des dernières répliques (Hz). */
  f0: number[];
  /** Voix attribuée, définitive pour tout le match. */
  role?: VoiceRole;
}

export interface SpeakerState {
  nextId: number;
  speakers: Speaker[];
}

export const emptySpeakers = (): SpeakerState => ({ nextId: 0, speakers: [] });

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : -1;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Regroupement en ligne des répliques d'un tronçon (modifie `state`) :
 * chaque empreinte rejoint le locuteur dont la moyenne est la plus proche si
 * la similarité cosinus atteint `threshold` (moyenne mise à jour), sinon crée
 * un nouveau locuteur — sauf réplique trop courte, rattachée au plus proche.
 * Une réplique sans empreinte prend le locuteur de la précédente (à défaut,
 * de la suivante). Rend l'id du locuteur de chaque réplique (null : aucun
 * locuteur connu, la voix principale sera utilisée).
 */
export function assignSpeakers(
  state: SpeakerState,
  durations: readonly number[],
  embeddings: readonly (readonly number[] | null)[],
  f0: readonly (number | null)[],
  o: { threshold?: number; minNewSec?: number } = {},
): (number | null)[] {
  const threshold = o.threshold ?? speakerSimThreshold();
  const minNewSec = o.minNewSec ?? minNewSpeakerSec();
  const ids: (number | null)[] = [];
  for (let i = 0; i < durations.length; i++) {
    const e = embeddings[i];
    if (!e || !e.length) {
      ids.push(null);
      continue;
    }
    let best: Speaker | null = null;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (const s of state.speakers) {
      const sim = cosine(e, s.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = s;
      }
    }
    if (best && bestSim >= threshold) {
      const b = best;
      b.centroid = b.centroid.map((x, k) => (x * b.n + e[k]) / (b.n + 1));
      b.n++;
      ids.push(b.id);
    } else if (best && bestSim > -1 && durations[i] < minNewSec) {
      ids.push(best.id);
    } else {
      const s: Speaker = { id: state.nextId++, centroid: [...e], n: 1, talk: 0, f0: [] };
      state.speakers.push(s);
      ids.push(s.id);
    }
  }
  // Répliques sans empreinte : locuteur de la précédente, sinon de la suivante.
  let prev: number | null = null;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === null) ids[i] = prev;
    else prev = ids[i];
  }
  let next: number | null = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === null) ids[i] = next;
    else next = ids[i];
  }
  for (let i = 0; i < ids.length; i++) {
    const s = state.speakers.find((x) => x.id === ids[i]);
    if (!s) continue;
    s.talk += Math.max(0, durations[i]);
    const hz = f0[i];
    if (typeof hz === 'number' && Number.isFinite(hz) && hz > 0) {
      s.f0.push(Math.round(hz * 10) / 10);
      if (s.f0.length > 200) s.f0.shift();
    }
  }
  return ids;
}

/**
 * Voix des locuteurs qui n'en ont pas encore (modifie `state`). Par temps de
 * parole décroissant : le 1er prend A (commentateur), le 2e B4 (consultant),
 * les suivants B1 ; un locuteur à la voix aiguë (hauteur médiane ≥
 * `femaleHz`) prend F si cette voix existe, sinon B1. Une voix attribuée ne
 * change plus ; un nouveau locuteur prend la prochaine voix libre.
 */
export function assignRoles(state: SpeakerState, voices: readonly string[], femaleHz = femaleF0Hz()): void {
  const used = new Set<VoiceRole>(state.speakers.flatMap((s) => (s.role ? [s.role] : [])));
  const fresh = state.speakers.filter((s) => !s.role).sort((a, b) => b.talk - a.talk || a.id - b.id);
  for (const s of fresh) {
    const hz = median(s.f0);
    const role: VoiceRole =
      hz !== null && hz >= femaleHz ? (voices.includes('F') ? 'F' : 'B1') : ((['A', 'B4'] as const).find((r) => !used.has(r)) ?? 'B1');
    s.role = role;
    used.add(role);
  }
}

/** Voix réellement disponible pour un rôle (repli si le moteur ne l'a pas). */
export function voiceFor(role: VoiceRole, voices: readonly string[]): string {
  const chain: Record<VoiceRole, VoiceRole[]> = { A: ['A', 'B4', 'B1'], B4: ['B4', 'B1', 'A'], B1: ['B1', 'B4', 'A'], F: ['F', 'B1', 'B4', 'A'] };
  return chain[role].find((v) => voices.includes(v)) ?? voices[0] ?? role;
}

/** Rôles utilisés, dans l'ordre canonique. */
export function rolesUsed(state: SpeakerState): VoiceRole[] {
  const set = new Set(state.speakers.map((s) => s.role));
  return ROLE_ORDER.filter((r) => set.has(r));
}

function parseSpeakers(raw: string | null | undefined): SpeakerState {
  try {
    const v = JSON.parse(raw || '{}') as Partial<SpeakerState>;
    if (Array.isArray(v.speakers)) {
      const speakers = v.speakers.filter((s) => s && Number.isInteger(s.id) && Array.isArray(s.centroid) && Array.isArray(s.f0));
      const nextId = Math.max(Number(v.nextId) || 0, ...speakers.map((s) => s.id + 1));
      return { nextId, speakers };
    }
  } catch {
    /* état illisible : on repart de zéro */
  }
  return emptySpeakers();
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const serializeSpeakers = (s: SpeakerState): SpeakerState => ({
  nextId: s.nextId,
  speakers: s.speakers.map((x) => ({ ...x, centroid: x.centroid.map(r5), talk: Math.round(x.talk * 100) / 100 })),
});

// ------------------------------------------------------------------ texte et calage (fonctions pures)

/**
 * Moment fort (emphasis 2) : l'intonation de la voix suit la ponctuation.
 * Une réplique qui ne finit pas par « ! », « ? » ou « … » finit par « ! »
 * (un point, une virgule ou deux-points final est remplacé).
 */
export function emphasize(text: string, emphasis: number | undefined): string {
  const t = text.trim();
  if (emphasis !== 2 || !t) return t;
  if (/(?:[!?…]|\.\.\.)[\s"'»”’)\]]*$/.test(t)) return t;
  const m = /[.,;:]+([\s"'»”’)\]]*)$/.exec(t);
  if (m) return `${t.slice(0, m.index)} !${m[1]}`.trimEnd();
  return `${t} !`;
}

export interface CueFit {
  /** Place disponible (s) à partir du début du sous-titre. */
  slot: number;
  /** Accélération appliquée (1 = aucune). */
  tempo: number;
  /** Durée après accélération (s). */
  fitted: number;
  /** Encore trop long après accélération maximale : déborde. */
  overrun: boolean;
}

/**
 * Place d'une réplique : jusqu'au début du sous-titre suivant, au plus
 * 0,6 s après la fin du sien. Trop longue : accélérée (au plus ×1,35) ;
 * au-delà, elle déborde (comptée).
 */
export function fitCue(duration: number, start: number, end: number, nextStart?: number | null): CueFit {
  const limit = Math.min(typeof nextStart === 'number' && nextStart > start ? nextStart : Number.POSITIVE_INFINITY, end + SLOT_TAIL_SEC);
  const slot = Math.max(0.2, Math.round((limit - start) * 1000) / 1000);
  const tempo = duration > slot ? Math.min(duration / slot, MAX_TEMPO) : 1;
  const t = Math.round(tempo * 1000) / 1000;
  const fitted = duration / t;
  return { slot, tempo: t, fitted, overrun: fitted > slot + 0.01 };
}

/**
 * Position de chaque réplique (s) : au début de son sous-titre, ou juste
 * après la précédente si celle-ci déborde (jamais deux voix en même temps).
 */
export function placeClips(clips: readonly { start: number; fitted: number }[], gap = CLIP_GAP_SEC): number[] {
  let prevEnd = Number.NEGATIVE_INFINITY;
  return clips.map((c) => {
    const at = Math.round(Math.max(c.start, prevEnd + gap) * 1000) / 1000;
    prevEnd = at + c.fitted;
    return at;
  });
}

/** Plages de parole fusionnées (écart ≤ `gap`), arrondies au centième. */
export function speechRanges(ranges: readonly [number, number][], gap = 0.25): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return out.map(([a, b]) => [r2(a), r2(b)]);
}

/** Empreinte des sous-titres d'un tronçon : un tronçon retraduit est redoublé. */
export function cuesSignature(cues: readonly db.CommentaryCueRow[]): string {
  const h = createHash('sha1');
  for (const c of cues) h.update(JSON.stringify([c.seq, c.start_ts, c.end_ts, c.text_fr, c.untranslated, c.emphasis ?? 0]));
  return h.digest('hex').slice(0, 16);
}

/** Prochain tronçon à doubler : celui de la position visée (spectateur) ou le suivant, sinon le premier. */
export function nextDubChunk<T extends { keepFrom: number; keepTo: number }>(todo: readonly T[], target: number): T | undefined {
  return todo.find((c) => c.keepTo > target) ?? todo[0];
}

// ------------------------------------------------------------------ montage (ffmpeg)

export interface AssembleClip {
  /** WAV de la réplique. */
  file: string;
  /** Position dans le tronçon (s, 0 = début du tronçon). */
  at: number;
  /** Accélération (`atempo`), 1 = aucune. */
  tempo: number;
}

/**
 * Monte un tronçon : `duration` secondes de silence, chaque réplique posée à
 * sa place (accélérée si besoin), en AAC mono 24 kHz ~48 kb/s dans un MP4
 * audio (.m4a, lisible partout par WebAudio, Safari compris). Écrit
 * `outFile` tel quel (l'appelant écrit dans un .part puis renomme).
 */
export function assembleChunk(clips: readonly AssembleClip[], duration: number, outFile: string, signal?: AbortSignal): Promise<void> {
  const sr = DUB_SAMPLE_RATE;
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', Math.max(0.1, duration).toFixed(3), '-i', `anullsrc=r=${sr}:cl=mono`];
  for (const c of clips) args.push('-i', c.file);
  if (clips.length) {
    const chains = clips.map((c, k) => {
      const tempo = c.tempo > 1.001 ? `,atempo=${c.tempo.toFixed(3)}` : '';
      const delay = Math.max(0, Math.round(c.at * sr));
      return `[${k + 1}:a]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=mono${tempo},adelay=delays=${delay}S:all=1[c${k}]`;
    });
    // Répliques sans chevauchement : simple somme (normalize=0), longueur fixée par le silence.
    const mix = `[0:a]${clips.map((_, k) => `[c${k}]`).join('')}amix=inputs=${clips.length + 1}:duration=first:dropout_transition=0:normalize=0[out]`;
    args.push('-filter_complex', `${chains.join(';')};${mix}`, '-map', '[out]');
  } else args.push('-map', '0:a');
  args.push('-ac', '1', '-ar', String(sr), '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', '-f', 'mp4', '-y', outFile);
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    lowerPriority(ff);
    let err = '';
    const kill = () => ff.kill('SIGKILL');
    const timer = setTimeout(kill, 5 * 60_000);
    signal?.addEventListener('abort', kill);
    ff.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-600)));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    };
    ff.on('error', (e) => {
      done();
      reject(e);
    });
    ff.on('close', (code) => {
      done();
      let size = 0;
      try {
        size = fs.statSync(outFile).size;
      } catch {
        size = 0;
      }
      if (code === 0 && size > 0) resolve();
      else reject(new Error(`ffmpeg montage code ${code}: ${err.replace(/\s+/g, ' ').trim()}`));
    });
  });
}

// ------------------------------------------------------------------ fichiers

export function dubDir(matchId: number): string {
  return path.join(db.dataDir(), 'dub', String(Math.trunc(matchId)));
}

/** Fichier audio d'un tronçon doublé publié, sinon null. */
export function dubChunkPath(matchId: number, idx: number): string | null {
  const row = db.getDubChunk(matchId, idx);
  return row ? path.join(dubDir(matchId), path.basename(row.file)) : null;
}

// ------------------------------------------------------------------ piste traduite à doubler

/** Piste traduite (complète ou partielle) du replay ACTUEL, sinon undefined. */
function currentCommentaryTrack(matchId: number): db.CommentaryTrackRow | undefined {
  const m = db.getMatch(matchId);
  const t = db.getCommentaryTrack(matchId);
  return m?.video_ok_id && t && t.ok_id === m.video_ok_id && t.cues > 0 ? t : undefined;
}

/** Reste-t-il des tronçons traduits à doubler (hors tronçons retraduits, vus au travail) ? */
function hasDubWork(matchId: number): boolean {
  const t = currentCommentaryTrack(matchId);
  return !!t && db.dubPendingChunks(matchId, db.commentaryKey(t)) > 0;
}

interface PlannedChunk {
  idx: number;
  keepFrom: number;
  /** Fin de la zone du tronçon ; +∞ pour le dernier. */
  keepTo: number;
  cues: db.CommentaryCueRow[];
  sig: string;
  done: boolean;
}

/** Tronçons traduits publiés, leurs sous-titres, et s'ils sont déjà doublés (à jour). */
function planDub(matchId: number): { chunks: PlannedChunk[]; cues: db.CommentaryCueRow[] } {
  const cues = db.getCommentaryCues(matchId);
  const byChunk = new Map<number, db.CommentaryCueRow[]>();
  for (const c of cues) {
    const idx = Math.floor(c.seq / 100_000) - 1; // voir db.chunkSeqBase
    let list = byChunk.get(idx);
    if (!list) byChunk.set(idx, (list = []));
    list.push(c);
  }
  const dubbed = new Map(db.getDubChunks(matchId).map((d) => [d.idx, d.cues_sig]));
  const chunks = db.getCommentaryChunks(matchId).map((r) => {
    const list = (byChunk.get(r.idx) ?? []).sort((a, b) => a.start_ts - b.start_ts || a.seq - b.seq);
    const sig = cuesSignature(list);
    return { idx: r.idx, keepFrom: r.keep_from, keepTo: r.keep_to >= 1e8 ? Number.POSITIVE_INFINITY : r.keep_to, cues: list, sig, done: dubbed.get(r.idx) === sig };
  });
  return { chunks, cues };
}

// ------------------------------------------------------------------ état persistant (kv_cache)

/** 'reseau' (flux vidéo) et 'service' (moteur de voix) : réessayés vite, sans compter dans l'abandon. */
export type DubFailureKind = 'reseau' | 'service' | 'erreur';

export interface DubRecord {
  at: string;
  ok: boolean;
  failures: number;
  netFailures?: number;
  kind?: DubFailureKind;
  reason: string;
  /** Piste traduite doublée (db.commentaryKey). */
  key: string | null;
}

const recordKey = (matchId: number) => `dub:${matchId}`;
const quickRetry = (k: DubFailureKind | undefined) => k === 'reseau' || k === 'service';

export function getDubRecord(matchId: number): DubRecord | undefined {
  try {
    return db.kvGet<DubRecord>(recordKey(matchId), Number.POSITIVE_INFINITY);
  } catch {
    return undefined;
  }
}

/** Une mise en file AUTOMATIQUE est-elle permise maintenant ? */
export function dubRetryAllowed(rec: DubRecord | undefined, key: string | null, now = Date.now()): boolean {
  if (!rec || rec.ok) return true;
  if (key && rec.key && key !== rec.key) return true; // nouvelle piste traduite : on repart de zéro
  if (quickRetry(rec.kind)) return now - Date.parse(rec.at) >= networkBackoffMs(rec.netFailures ?? 1);
  if (rec.failures >= MAX_AUTO_FAILURES) return false;
  return now - Date.parse(rec.at) >= backoffMs(rec.failures);
}

// ------------------------------------------------------------------ exécution d'un travail

interface Job {
  matchId: number;
  /** Demandé par quelqu'un qui regarde le match : passe devant un doublage de fond. */
  viewer?: boolean;
}

/** Pourquoi un doublage cède la place : GPU pris, lecture d'un autre match, hors fenêtre de fond. */
export type DubYield = 'gpu' | 'viewer' | 'window';

export interface DubProgress {
  /** Tronçons doublés (à jour) sur `total` tronçons traduits publiés. */
  done: number;
  total: number;
  /** Tronçon en cours (idx). */
  chunk?: number;
}

export interface DubOutcome {
  ok: boolean;
  reason: string;
  kind?: DubFailureKind;
  /** A cédé la place (ni succès ni échec). */
  yielded?: DubYield;
}

/**
 * Pilotage d'un travail par la file, vérifié avant chaque tronçon et chaque
 * réplique : `yieldReason` (céder la place ?) et `target` (position à
 * doubler en priorité, celle du spectateur).
 */
export interface DubControl {
  yieldReason(): DubYield | null;
  target(): number;
}

/** Dépendances externes d'un travail (remplaçables dans les tests). */
export interface DubDeps {
  resolveStream: (okId: string, force?: boolean) => Promise<Pick<OkStream, 'variants' | 'duration'>>;
  extract: (sourceUrl: string, start: number, length: number, outFile: string, o: ExtractOptions) => Promise<void>;
  openVoice: (signal: AbortSignal) => Promise<VoiceSessionLike>;
  assemble: (clips: AssembleClip[], duration: number, outFile: string, signal: AbortSignal) => Promise<void>;
}

const defaultDeps: DubDeps = {
  // Sans `force`, le flux déjà résolu par le lecteur est réutilisé (voir commentary.ts).
  resolveStream: (okId, force) => resolveOkStream(okId, { force: !!force }),
  extract: extractAudioChunk,
  openVoice: async (signal) => {
    const e = await loadEngine();
    if (!e) throw new Error(`moteur de voix indisponible : ${eng.loadError ?? 'module absent'}`);
    return e.open(signal);
  },
  assemble: (clips, duration, outFile, signal) => assembleChunk(clips, duration, outFile, signal),
};

const RUN_TO_END: DubControl = { yieldReason: () => null, target: () => 0 };

class StreamUnavailable extends Error {}
class VoiceUnavailable extends Error {}
class Yielded extends Error {
  constructor(public why: DubYield) {
    super(`cède la place (${why})`);
  }
}

const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('travail interrompu');
}

const YIELD_TEXT: Record<DubYield, string> = {
  gpu: 'le GPU passe à la traduction ou à l’analyse vidéo',
  viewer: 'un autre match est regardé',
  window: 'hors de la fenêtre des tâches de fond',
};

/**
 * Un travail : les tronçons traduits pas encore doublés (ou retraduits
 * depuis), à partir de la position du spectateur, chacun publié dès qu'il
 * est monté. Le moteur de voix est ouvert au premier besoin et fermé à la
 * fin, sur erreur ou quand le travail cède la place.
 */
export async function runDub(
  job: Job,
  progress: (p: DubProgress) => void,
  signal: AbortSignal,
  deps: DubDeps = defaultDeps,
  ctl: DubControl = RUN_TO_END,
): Promise<DubOutcome> {
  const t0 = Date.now();
  const match = db.getMatch(job.matchId);
  if (!match?.video_ok_id) return { ok: false, kind: 'erreur', reason: 'Doublage impossible : pas de replay' };
  const okId = match.video_ok_id;
  const track = currentCommentaryTrack(job.matchId);
  if (!track) return { ok: true, reason: 'aucun sous-titre français à doubler' };
  const key = db.commentaryKey(track);
  const opened = db.openDubTrack(job.matchId, okId, key);
  const dir = dubDir(job.matchId);
  if (opened.reset) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[doublage] match ${job.matchId} : la piste traduite a changé, doublage effacé et refait`);
  }
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const state = parseSpeakers(opened.track.speakers);

  let session: VoiceSessionLike | null = null;
  let stream: Pick<OkStream, 'variants' | 'duration'> | null = null;
  const closeSession = async () => {
    const s = session;
    session = null;
    await s?.close().catch(() => undefined);
  };
  const openSession = async (): Promise<VoiceSessionLike> => {
    if (session) return session;
    try {
      session = await deps.openVoice(signal);
    } catch (e) {
      checkAborted(signal);
      throw new VoiceUnavailable(short(e));
    }
    console.log(`[doublage] match ${job.matchId} : moteur de voix prêt (voix ${session.voices.join(', ')})`);
    return session;
  };
  const yieldCheck = () => {
    const why = ctl.yieldReason();
    if (why) throw new Yielded(why);
  };

  /** Audio d'une plage de la vidéo (toutes les sources, puis une re-résolution du flux). */
  const extract = async (start: number, length: number, out: string) => {
    let lastErr = '';
    for (let round = 0; round < 2; round++) {
      if (!stream || round === 1) {
        try {
          stream = await deps.resolveStream(okId, round === 1);
        } catch (e) {
          lastErr = `résolution du flux : ${short(e)}`;
          continue;
        }
      }
      const sources = audioSources(stream);
      if (!sources.length) lastErr = 'aucune source audio (ni HLS ni MP4)';
      for (const s of sources.slice(0, 3)) {
        checkAborted(signal);
        try {
          await deps.extract(s.url, start, length, out, { userAgent: BROWSER_UA, referer: OK_REFERER, signal });
          return;
        } catch (e) {
          lastErr = short(e);
        }
      }
    }
    throw new StreamUnavailable(lastErr);
  };

  let dubbed = 0;
  let overruns = 0;
  let failedCues = 0;
  let total = 0;

  /** Double un tronçon et le publie. */
  const dubChunk = async (ch: PlannedChunk, allCues: db.CommentaryCueRow[], rank: number) => {
    const chunkFiles: string[] = [];
    try {
      const cues = ch.cues;
      const clips: { file: string; start: number; slotEnd: number; fitted: number; tempo: number; overrun: boolean }[] = [];
      const talk = new Map<number, number>();
      let failed = 0;
      let lastErr = '';
      if (cues.length) {
        // 1. Audio d'origine du tronçon (empreintes vocales).
        const exStart = Math.max(0, Math.min(ch.keepFrom, cues[0].start_ts) - 0.5);
        const exEnd = Math.max(Number.isFinite(ch.keepTo) ? ch.keepTo : 0, ...cues.map((c) => c.end_ts)) + 0.5;
        const audio = path.join(tmp, `source-${ch.idx}.ogg`);
        chunkFiles.push(audio);
        await extract(exStart, Math.ceil((exEnd - exStart) * 10) / 10, audio);
        yieldCheck();
        const voice = await openSession();
        // 2. Empreinte de chaque réplique ; en échec, voix de la précédente.
        let embeddings: (number[] | null)[] = cues.map(() => null);
        let f0: (number | null)[] = cues.map(() => null);
        try {
          const r = await voice.embed(
            audio,
            cues.map((c) => [Math.max(0, c.start_ts - exStart), Math.max(0, c.end_ts - exStart)] as [number, number]),
            signal,
          );
          embeddings = cues.map((_, i) => r.embeddings[i] ?? null);
          f0 = cues.map((_, i) => r.f0[i] ?? null);
        } catch (e) {
          checkAborted(signal);
          console.error(`[doublage] match ${job.matchId} : empreintes vocales impossibles (tronçon ${ch.idx}) : ${short(e)}`);
        }
        fs.rmSync(audio, { force: true });
        // 3. Locuteurs et voix (stables pour tout le match).
        const speakers = assignSpeakers(
          state,
          cues.map((c) => c.end_ts - c.start_ts),
          embeddings,
          f0,
        );
        assignRoles(state, voice.voices);
        // 4-5. Synthèse et calage de chaque réplique traduite.
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          if (c.untranslated || !c.text_fr.trim()) continue;
          yieldCheck();
          checkAborted(signal);
          const sp = state.speakers.find((s) => s.id === speakers[i]);
          const role: VoiceRole = sp?.role ?? 'A';
          const out = path.join(tmp, `cue-${c.seq}.wav`);
          chunkFiles.push(out);
          let r: { duration: number };
          try {
            r = await voice.synth(emphasize(c.text_fr, c.emphasis), voiceFor(role, voice.voices), out, signal);
            if (!(r.duration > 0)) throw new Error('synthèse vide');
          } catch (e) {
            checkAborted(signal);
            failed++;
            lastErr = short(e);
            console.error(`[doublage] match ${job.matchId} : réplique ${c.seq} ignorée (${clock(c.start_ts)}) : ${lastErr}`);
            continue;
          }
          const k = allCues.findIndex((x) => x.seq === c.seq);
          const nextStart = k >= 0 && k + 1 < allCues.length ? allCues[k + 1].start_ts : null;
          const fit = fitCue(r.duration, c.start_ts, c.end_ts, nextStart);
          clips.push({ file: out, start: c.start_ts, slotEnd: c.start_ts + fit.slot, fitted: fit.fitted, tempo: fit.tempo, overrun: fit.overrun });
          if (sp) talk.set(sp.id, (talk.get(sp.id) ?? 0) + (c.end_ts - c.start_ts));
        }
        const speakable = cues.filter((c) => !c.untranslated && c.text_fr.trim()).length;
        if (speakable && !clips.length) throw new Error(`synthèse impossible pour tout le tronçon ${ch.idx} (${failed} réplique(s)) : ${lastErr}`);
      }
      // 6. Montage : silence + répliques à leur place, sur toute la zone du
      // tronçon (un peu plus si la première réplique commence juste avant, ou
      // si la dernière déborde).
      const at = placeClips(clips);
      const start = clips.length ? Math.floor(Math.min(ch.keepFrom, at[0]) * 1000) / 1000 : ch.keepFrom;
      const lastCueEnd = cues.length ? cues[cues.length - 1].end_ts + SLOT_TAIL_SEC : ch.keepFrom + 1;
      const lastClipEnd = clips.length ? Math.max(...clips.map((c, i) => at[i] + c.fitted)) : 0;
      const end = Math.round(Math.max(Number.isFinite(ch.keepTo) ? ch.keepTo : lastCueEnd, lastClipEnd) * 1000) / 1000;
      const file = `chunk-${ch.idx}.m4a`;
      const out = path.join(dir, file);
      const part = `${out}.part`;
      chunkFiles.push(part);
      checkAborted(signal);
      await deps.assemble(
        clips.map((c, i) => ({ file: c.file, at: at[i] - start, tempo: c.tempo })),
        end - start,
        part,
        signal,
      );
      if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new Error(`montage vide (tronçon ${ch.idx})`);
      fs.renameSync(part, out);
      // 7. Publication.
      const n = clips.filter((c, i) => c.overrun || at[i] + c.fitted > c.slotEnd + 0.01).length;
      overruns += n;
      failedCues += failed;
      db.publishDubChunk(
        job.matchId,
        {
          idx: ch.idx,
          start,
          end,
          file,
          speech: speechRanges(clips.map((c, i) => [at[i], at[i] + c.fitted])),
          cuesSig: ch.sig,
        },
        { voices: rolesUsed(state), speakers: serializeSpeakers(state) },
      );
      dubbed++;
      const who = [...talk.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, s]) => `#${id}→${state.speakers.find((x) => x.id === id)?.role ?? '?'} ${Math.round(s)} s`)
        .join(', ');
      console.log(
        `[doublage] match ${job.matchId} : tronçon ${rank}/${total} (${clock(ch.keepFrom)}) : ${clips.length} réplique(s)` +
          `${who ? `, locuteurs ${who}` : ''}${n ? ` ; ${n} dépassement(s)` : ''}${failed ? ` ; ${failed} réplique(s) en échec` : ''}`,
      );
    } finally {
      for (const f of chunkFiles) fs.rmSync(f, { force: true });
    }
  };

  let first = true;
  try {
    for (;;) {
      checkAborted(signal);
      const { chunks, cues } = planDub(job.matchId);
      const todo = chunks.filter((c) => !c.done);
      total = Math.max(track.chunks_total ?? 0, chunks.length);
      if (!todo.length) break;
      yieldCheck();
      const ch = nextDubChunk(todo, ctl.target()) as PlannedChunk;
      if (first) {
        first = false;
        console.log(`[doublage] match ${job.matchId} : démarrage (${todo.length} tronçon(s) à doubler sur ${chunks.length} traduit(s))`);
      }
      progress({ done: chunks.length - todo.length, total, chunk: ch.idx });
      await dubChunk(ch, cues, chunks.length - todo.length + 1);
    }
  } catch (e) {
    if (e instanceof Yielded) {
      return { ok: false, yielded: e.why, reason: `en pause (${dubbed} tronçon(s) doublé(s)) : ${YIELD_TEXT[e.why]}` };
    }
    if (e instanceof StreamUnavailable) {
      return { ok: false, kind: 'reseau', reason: `Flux vidéo inaccessible pour le doublage (${e.message}) : nouvel essai automatique` };
    }
    if (e instanceof VoiceUnavailable) {
      return { ok: false, kind: 'service', reason: `Moteur de voix indisponible : ${e.message} (nouvel essai automatique)` };
    }
    throw e;
  } finally {
    await closeSession();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Doublage complet : piste traduite complète et tous ses tronçons doublés.
  const complete = currentCommentaryTrack(job.matchId)?.complete === 1 && planDub(job.matchId).chunks.every((c) => c.done);
  db.setDubComplete(job.matchId, complete);
  const minutes = Math.max(1, Math.round((Date.now() - t0) / 60_000));
  return {
    ok: true,
    reason:
      `${dubbed} tronçon(s) doublé(s)${complete ? ', doublage complet' : ''} ; voix ${rolesUsed(state).join(', ') || '—'}` +
      `${overruns ? ` ; ${overruns} dépassement(s)` : ''}${failedCues ? ` ; ${failedCues} réplique(s) en échec` : ''} ; ${minutes} min`,
  };
}

// ------------------------------------------------------------------ file

export type DubRunner = (job: Job, progress: (p: DubProgress) => void, signal: AbortSignal, ctl: DubControl) => Promise<DubOutcome>;

interface QueueState {
  queue: Job[];
  running: {
    job: Job;
    progress: DubProgress | null;
    abort: () => void;
    /** Interrompu pour laisser passer un match regardé : remis en file, sans compter d'échec. */
    preempted: boolean;
  } | null;
  runner: DubRunner | null;
  idle: Promise<void>;
  idleResolve: (() => void) | null;
}

const g = globalThis as unknown as { __dubQueue?: QueueState };
const st: QueueState = (g.__dubQueue ??= { queue: [], running: null, runner: null, idle: Promise.resolve(), idleResolve: null });

/** Durée maximale d'un travail (`DUB_TIMEOUT_MS`, 6 h par défaut comme la traduction ; ce qui est publié reste). */
function jobTimeoutMs(): number {
  const n = Number(process.env.DUB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 3600_000;
}

/** Le GPU est-il pris par une traduction ou une analyse vidéo (une analyse en pause pendant la lecture ne compte pas) ? */
export function gpuBusy(): boolean {
  if (commentaryActivity().running) return true;
  return analysisActivity().running.some((r) => r.phase !== 'en pause pendant la lecture');
}

/** Travail de fond hors de la fenêtre autorisée (et personne ne regarde ce match). */
const outsideWindow = (job: Job) => !job.viewer && !viewerActive(job.matchId) && (!inNightWindow() || !autoDubEnabled());
/** Travail de fond qui doit attendre : quelqu'un regarde un autre match. */
const mustWait = (job: Job) => !job.viewer && !viewerActive(job.matchId) && someoneWatching(job.matchId);

function controlFor(job: Job): DubControl {
  return {
    yieldReason: () => {
      if (gpuBusy()) return 'gpu';
      if (viewerActive(job.matchId)) return null;
      // Le spectateur est parti (ou travail de fond) : on continue seulement en tâche de fond permise.
      if (someoneWatching(job.matchId)) return 'viewer';
      if (!inNightWindow() || !autoDubEnabled()) return 'window';
      return null;
    },
    target: () => viewerPosition(job.matchId) ?? 0,
  };
}

export function dubQueuePosition(matchId: number): number | null {
  const i = st.queue.findIndex((j) => j.matchId === matchId);
  return i < 0 ? null : i + 1;
}

export interface DubEnqueueResult {
  queued: boolean;
  started: boolean;
  position?: number;
  message: string;
}

/** Met un match en file de doublage. `priority` : en tête (match regardé), quitte à interrompre un doublage de fond. */
export function enqueueDub(matchId: number, opts: { priority?: boolean } = {}): DubEnqueueResult {
  const disabled = dubDisabledReasonSync();
  if (disabled) return { queued: false, started: false, message: `Doublage inactif : ${disabled}` };
  if (st.running?.job.matchId === matchId) return { queued: false, started: true, message: 'Doublage déjà en cours' };
  if (!hasDubWork(matchId)) return { queued: false, started: false, message: 'Rien à doubler (sous-titres absents ou déjà doublés)' };
  const existing = st.queue.findIndex((j) => j.matchId === matchId);
  const job: Job = { matchId, viewer: !!opts.priority || (existing >= 0 && !!st.queue[existing].viewer) };
  if (existing >= 0) {
    if (opts.priority) {
      st.queue.splice(existing, 1);
      st.queue.unshift(job);
    } else st.queue[existing] = job;
  } else if (opts.priority) st.queue.unshift(job);
  else st.queue.push(job);
  if (opts.priority) preemptBackground();
  pump();
  if (st.running?.job.matchId === matchId) return { queued: true, started: true, message: 'Doublage lancé' };
  const position = dubQueuePosition(matchId);
  if (!position) return { queued: false, started: false, message: 'Doublage de fond hors de la fenêtre autorisée' };
  return { queued: true, started: false, position, message: `Doublage en file (position ${position})` };
}

/** Un match regardé passe devant un doublage de FOND en cours : celui-ci est interrompu, puis remis en file juste derrière. */
function preemptBackground(): void {
  const r = st.running;
  if (!r || r.job.viewer || r.preempted || r.job.matchId === st.queue[0]?.matchId) return;
  r.preempted = true;
  console.log(`[doublage] match ${r.job.matchId} mis en pause : le match ${st.queue[0]?.matchId} est regardé, il passe en premier`);
  r.abort();
}

let repumpTimer: NodeJS.Timeout | undefined;

function scheduleRepump(): void {
  clearTimeout(repumpTimer);
  repumpTimer = setTimeout(pump, Number(process.env.DUB_REPUMP_MS) || 20_000);
  repumpTimer.unref?.();
}

function pump(): void {
  clearTimeout(repumpTimer);
  if (!st.running && st.queue.length) {
    if (dubDisabledReasonSync()) st.queue.length = 0;
    st.queue = st.queue.filter((j) => !outsideWindow(j));
    if (st.queue.length && gpuBusy()) scheduleRepump(); // GPU pris : on attend sa libération
    else {
      while (!st.running && st.queue.length) {
        // Premier travail qui peut partir : ceux des spectateurs toujours, ceux de fond quand personne ne regarde.
        const i = st.queue.findIndex((j) => !mustWait(j));
        if (i < 0) {
          scheduleRepump();
          break;
        }
        const [job] = st.queue.splice(i, 1);
        if (!hasDubWork(job.matchId)) continue;
        start(job);
      }
    }
  }
  if (!st.running && !st.queue.length && st.idleResolve) {
    st.idleResolve();
    st.idleResolve = null;
  }
}

function start(job: Job): void {
  if (!st.idleResolve) st.idle = new Promise((r) => (st.idleResolve = r));
  const ctrl = new AbortController();
  const state: NonNullable<QueueState['running']> = { job, progress: null, abort: () => ctrl.abort(), preempted: false };
  st.running = state;
  const t = currentCommentaryTrack(job.matchId);
  const key = t ? db.commentaryKey(t) : null;
  const runner: DubRunner = st.runner ?? ((j, p, sig, c) => runDub(j, p, sig, defaultDeps, c));
  const logId = db.logIngestStart(`doublage-${job.matchId}`);
  let watchdog: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`délai dépassé (${Math.max(1, Math.round(jobTimeoutMs() / 60_000))} min)`));
    }, jobTimeoutMs());
    watchdog.unref?.();
  });
  const endLog = (ok: boolean, detail: string) => {
    try {
      db.logIngestEnd(logId, ok, detail);
    } catch {
      /* journal facultatif */
    }
  };
  void Promise.race([runner(job, (p) => (state.progress = { ...p }), ctrl.signal, controlFor(job)), timeout])
    .then(
      (res) => res,
      (e: unknown): DubOutcome => ({ ok: false, kind: 'erreur', reason: `Doublage impossible : ${short(e)}` }),
    )
    .finally(() => clearTimeout(watchdog))
    .then((res) => {
      if (state.preempted) {
        endLog(false, 'interrompu : un match regardé est passé devant');
        if (!st.queue.some((j) => j.matchId === job.matchId)) st.queue.splice(Math.min(1, st.queue.length), 0, { ...job, viewer: false });
        return;
      }
      if (res.yielded) {
        // Ni succès ni échec : reprise quand le GPU sera libre, ou après la lecture.
        endLog(true, res.reason);
        if (!st.queue.some((j) => j.matchId === job.matchId)) {
          if (res.yielded === 'gpu') st.queue.unshift({ ...job });
          else if (res.yielded === 'viewer') st.queue.push({ ...job, viewer: false });
        }
        console.log(`[doublage] match ${job.matchId} ${res.reason}${res.yielded === 'window' ? '' : ' ; reprise ensuite'}`);
        return;
      }
      const prev = getDubRecord(job.matchId);
      const sameKey = !prev?.key || prev.key === key;
      const kind = res.ok ? undefined : (res.kind ?? 'erreur');
      const failures = res.ok ? 0 : (sameKey ? (prev?.failures ?? 0) : 0) + (quickRetry(kind) ? 0 : 1);
      const netFailures = quickRetry(kind) ? (sameKey && quickRetry(prev?.kind) ? (prev?.netFailures ?? 0) : 0) + 1 : 0;
      try {
        db.kvSet(recordKey(job.matchId), {
          at: new Date().toISOString(),
          ok: res.ok,
          failures,
          reason: res.reason,
          key,
          ...(kind ? { kind } : {}),
          ...(netFailures ? { netFailures } : {}),
        } satisfies DubRecord);
      } catch (e) {
        console.error('[doublage] journalisation impossible :', (e as Error).message);
      }
      endLog(res.ok, res.reason);
      if (res.ok) console.log(`[doublage] match ${job.matchId} terminé : ${res.reason}`);
      else console.error(`[doublage] match ${job.matchId} : ${res.reason}`);
    })
    .finally(() => {
      st.running = null;
      pump();
    });
}

/**
 * Le match est regardé : son doublage passe en tête de file s'il a des
 * sous-titres français pas encore doublés et que le backoff le permet.
 * (Il ne démarre qu'une fois le GPU libre : la traduction passe d'abord.)
 */
export function prioritizeDubOnView(matchId: number): void {
  const m = db.getMatch(matchId);
  if (!m || m.status !== 'final' || !m.video_ok_id || !m.video_available) return;
  if (st.running?.job.matchId === matchId || dubQueuePosition(matchId) === 1) return;
  if (dubDisabledReasonSync()) return;
  const t = currentCommentaryTrack(matchId);
  if (!t || !hasDubWork(matchId)) return;
  if (!dubRetryAllowed(getDubRecord(matchId), db.commentaryKey(t))) return;
  enqueueDub(matchId, { priority: true });
}

/**
 * Job périodique (fenêtre de fond, paramètre `auto_translate`) : matchs
 * terminés depuis ≤ `days` jours, traduits (piste complète ou partielle),
 * dont le doublage est incomplet, backoff échu.
 */
export async function enqueueRecentDubs(days = 10, limit = 30): Promise<number> {
  if (!inNightWindow() || !autoDubEnabled()) return 0;
  if (await dubDisabledReason()) return 0;
  const since = addDays(new Date(), -days).toISOString();
  let n = 0;
  for (const m of db.finalMatchesNeedingDub(since, limit)) {
    if (st.running?.job.matchId === m.id || dubQueuePosition(m.id)) continue;
    const t = currentCommentaryTrack(m.id);
    if (!t || !dubRetryAllowed(getDubRecord(m.id), db.commentaryKey(t))) continue;
    if (enqueueDub(m.id).queued) n++;
  }
  return n;
}

// ------------------------------------------------------------------ activité et manifeste

export interface DubActivity {
  running: { matchId: number; done: number; total: number; watched: boolean } | null;
  /** Matchs en attente, dans l'ordre. */
  queued: number[];
  /** Des doublages attendent que le GPU se libère (traduction ou analyse en cours). */
  waitingForGpu: boolean;
}

export function dubActivity(): DubActivity {
  const r = st.running;
  return {
    running: r ? { matchId: r.job.matchId, done: r.progress?.done ?? 0, total: r.progress?.total ?? 0, watched: viewerActive(r.job.matchId) } : null,
    queued: st.queue.map((j) => j.matchId),
    waitingForGpu: !r && st.queue.length > 0 && gpuBusy(),
  };
}

export type DubStatusName = 'none' | 'waiting' | 'running' | 'partial' | 'ready' | 'disabled' | 'failed';

export interface DubManifestChunk {
  idx: number;
  /** Début du tronçon dans la vidéo (s) : t = 0 de l'audio. */
  start: number;
  end: number;
  url: string;
  /** Plages de parole française (s, temps absolu de la vidéo). */
  speech: [number, number][];
}

/** Contrat de GET /api/matches/[id]/dub (lecteur). */
export interface DubManifest {
  status: DubStatusName;
  reason?: string;
  chunks: DubManifestChunk[];
  voices: Partial<Record<VoiceRole, string>>;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Manifeste du doublage d'un match : statut, tronçons prêts (URL de l'audio), voix utilisées. */
export function dubManifest(matchId: number): DubManifest {
  const disabled = dubDisabledReasonSync();
  if (disabled) return { status: 'disabled', reason: disabled, chunks: [], voices: {} };
  const track = currentCommentaryTrack(matchId);
  const dub = db.getDubTrack(matchId);
  const valid = !!track && !!dub && dub.commentary_key === db.commentaryKey(track);
  const chunks: DubManifestChunk[] = valid
    ? db.getDubChunks(matchId).map((c) => ({
        idx: c.idx,
        start: c.start_ts,
        end: c.end_ts,
        url: `/api/matches/${matchId}/dub/${c.idx}?v=${Date.parse(c.created_at) || 0}`,
        speech: parseJson<[number, number][]>(c.speech, []),
      }))
    : [];
  const voices: DubManifest['voices'] = {};
  if (valid) for (const r of parseJson<string[]>(dub.voices, [])) if (r in ROLE_LABELS) voices[r as VoiceRole] = ROLE_LABELS[r as VoiceRole];
  const base = { chunks, voices };
  if (st.running?.job.matchId === matchId) return { status: 'running', ...base };
  const position = dubQueuePosition(matchId);
  if (position) {
    const reason = gpuBusy() ? 'en attente du GPU : la traduction ou l’analyse vidéo passe d’abord' : `en file (position ${position})`;
    return { status: 'waiting', reason, ...base };
  }
  if (valid && dub.complete === 1) return { status: 'ready', ...base };
  const translating = commentaryActivity().running?.matchId === matchId || commentaryQueuePosition(matchId) !== null;
  if (!track) {
    return translating
      ? { status: 'waiting', reason: 'traduction des commentaires en cours : le doublage suivra', ...base }
      : { status: 'none', reason: 'pas encore de sous-titres français', ...base };
  }
  const rec = getDubRecord(matchId);
  const failed = rec && !rec.ok && (!rec.key || rec.key === db.commentaryKey(track)) ? rec.reason : undefined;
  if (chunks.length) {
    const reason = failed ?? (translating ? 'la suite sera doublée après la traduction' : undefined);
    return { status: 'partial', ...(reason ? { reason } : {}), ...base };
  }
  if (failed) return { status: 'failed', reason: failed, ...base };
  if (translating) return { status: 'waiting', reason: 'traduction des commentaires en cours : le doublage suivra', ...base };
  return { status: 'none', ...base };
}

// ------------------------------------------------------------------ outils de test

/** Tests : remplace l'exécuteur, vide la file. */
export function __setDubRunnerForTests(runner: DubRunner | null): void {
  st.runner = runner;
  clearTimeout(repumpTimer);
  st.queue.length = 0;
  st.running = null;
  st.idleResolve?.();
  st.idleResolve = null;
  st.idle = Promise.resolve();
}

/** Tests : moteur de voix simulé (null : le vrai, chargé au premier besoin). */
export function __setDubEngineForTests(engine: VoiceEngine | null): void {
  eng.override = engine;
  eng.loadError = null;
}

/** Tests : attend que la file soit vide. */
export function __dubIdle(): Promise<void> {
  return st.idle;
}
