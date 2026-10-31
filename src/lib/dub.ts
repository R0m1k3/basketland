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
 * chaque réplique (ECAPA, hauteur de voix, probabilité « voix de femme ») →
 * regroupement en locuteurs (par match, en ligne) → voix attribuée à chaque
 * locuteur (F pour une femme), stable pour tout le match → synthèse de
 * chaque réplique → calage sur la durée de la réplique (accélération
 * limitée, `atempo`) → montage du tronçon (silence + répliques
 * à leur place) en AAC mono 24 kHz → `${dataDir()}/dub/<match>/chunk-<idx>.m4a`
 * (écrit en .part puis renommé) → publication en base (`dub_chunks`).
 *
 * GPU PARTAGÉ : le doublage ne tourne jamais en même temps qu'une
 * traduction ou une analyse vidéo. Si l'une démarre, le doublage ferme son
 * moteur de voix à la prochaine réplique (ou au prochain tronçon) et se
 * remet en file ; il reprend quand le GPU est libre. Avec la synthèse en
 * ligne (MiniMax, voir voiceMinimax.ts), le doublage n'utilise pas le GPU et
 * tourne en même temps que les traductions. Le téléchargement des
 * modèles de voix (premier usage, ~2,5 Go) n'a pas besoin du GPU : il part
 * dès la mise en file, avance pendant l'attente, et n'est jamais interrompu
 * quand le doublage cède la place. La fiche voit l'étape en cours (manifeste
 * `step`) et ce qui occupe le GPU.
 *
 * PAS DE DOUBLAGE AUTOMATIQUE : une traduction (automatique ou demandée),
 * l'ouverture d'un match ou le réglage « Version française » ne lancent
 * jamais le doublage. Seule la demande explicite le lance. PRIORITÉ À LA
 * LECTURE : le doublage demandé d'un match regardé passe en tête de file (à
 * partir de la position du spectateur) ; un doublage s'efface pendant qu'on
 * regarde un AUTRE match.
 *
 * DEMANDE EXPLICITE (« Doubler ce match », « Relancer le doublage » :
 * `requestDub`) : la traduction est mise en file si besoin, puis le doublage
 * en travail explicite, mené jusqu'au bout même fiche fermée, quels que
 * soient la traduction automatique, la fenêtre et le mode. Il attend ses
 * sous-titres (sans quitter la file), cède la place au GPU et à la lecture
 * d'un AUTRE match, et revient en file tant que la traduction peut encore
 * publier des tronçons.
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
import { analysisActivity } from './analysis';
import { ffmpegAvailable } from './audio';
import {
  audioSources,
  commentaryActivity,
  commentaryQueuePosition,
  commentaryReady,
  commentaryRunningMatchId,
  dropFullAudio,
  enqueueCommentary,
  extractAudioChunk,
  sliceFullAudio,
  type ExtractOptions,
} from './commentary';
import { BROWSER_UA } from './http';
import { OK_REFERER, resolveOkStream, type OkStream } from './okru';
import { lowerPriority } from './procPriority';
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
  /**
   * Synthèse d'une réplique dans un WAV mono. `emphasis` (0 à 2, moments
   * forts) : le moteur peut en tirer le ton (émotion MiniMax).
   */
  synth(text: string, voice: string, outFile: string, signal?: AbortSignal, o?: { emphasis?: number }): Promise<{ duration: number; sampleRate: number }>;
  /**
   * Empreintes ECAPA (192-d, normées), hauteur médiane (Hz) et probabilité
   * « voix de femme » (facultative) de chaque segment [début, fin] (s, dans le fichier).
   */
  embed(
    file: string,
    segments: [number, number][],
    signal?: AbortSignal,
  ): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[]; female?: (number | null)[] }>;
  close(): Promise<void>;
}

export interface VoiceEngine {
  config(): { disabledReason?: string };
  open(signal?: AbortSignal): Promise<VoiceSessionLike>;
  /**
   * Modèles mis en cache (téléchargés au premier usage) sans le GPU ; partagé,
   * jamais interrompu par un travail (voir `prepareVoiceModels`, voiceAi.ts).
   */
  prepare?(): Promise<void>;
  /** Téléchargement des modèles en cours (octets), sinon null. */
  download?(): { done: number; total: number } | null;
  /**
   * Le doublage occupe-t-il la carte graphique ? Non avec la synthèse en
   * ligne (MiniMax) : il ne cède alors plus la place aux traductions et
   * analyses. Absent : oui.
   */
  usesGpu?(): boolean;
}

interface VoiceAiModule {
  openVoiceSession(signal?: AbortSignal): Promise<VoiceSessionLike>;
  voiceConfig(): { disabledReason?: string };
  prepareVoiceModels(): Promise<void>;
  voiceModelsDownload(): { done: number; total: number } | null;
  voiceUsesGpu(): boolean;
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
      eng.engine = {
        config: () => m.voiceConfig(),
        open: (signal) => m.openVoiceSession(signal),
        prepare: () => m.prepareVoiceModels(),
        download: () => m.voiceModelsDownload(),
        usesGpu: () => m.voiceUsesGpu(),
      };
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

// ------------------------------------------------------------------ réglages

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : def;
}

/** Similarité cosinus minimale pour rattacher une réplique à un locuteur connu. */
export const speakerSimThreshold = () => envNum('DUB_SPEAKER_SIM', 0.6);
/**
 * Probabilité « voix de femme » moyenne (classifieur du moteur de voix,
 * scripts/voice_gender.py, pondérée par la durée des répliques) à partir de
 * laquelle un locuteur prend la voix féminine F. Une valeur > 1 désactive la
 * détection. Mesuré (voir le README) : commentateurs NBA, même emballés,
 * ≤ 0,1 en moyenne sur toute fenêtre de 6 s, reporter réelle 0,996 ; sur des
 * livres audio, le pire lecteur (noyé dans un bruit de salle à 5 dB) atteint
 * 0,83 sur 10 s, une lectrice à la voix grave descend à 0,65 sur 30 s.
 */
export const femaleProbMin = () => envNum('DUB_FEMALE_PROB', 0.85);
/**
 * Parole classée homme/femme (s) nécessaire avant de donner F à un locuteur.
 * 6 s ne suffisent pas : un lecteur qui imite une femme (fausset) atteint
 * 0,97 sur 6 s (0,72 sur 10 s).
 */
export const FEMALE_MIN_SEC = 10;
/**
 * Seules les répliques des 30 premières secondes de parole d'un locuteur
 * comptent pour son genre : la décision, et donc l'éventuelle bascule vers F,
 * ne peut venir qu'au début (voir `assignRoles`).
 */
export const FEMALE_WINDOW_SEC = 30;
/**
 * Hauteur de voix médiane (Hz) à partir de laquelle un NOUVEAU locuteur prend
 * la voix féminine quand le classifieur ne l'a pas assez entendu (moteur sans
 * classifieur, répliques trop courtes). DÉSACTIVÉ par défaut : sur le son
 * diffusé, un commentateur qui s'emballe parle à 230-250 Hz, autant qu'une
 * voix de femme (mesuré) — il prendrait la voix féminine. À régler
 * (`DUB_FEMALE_F0`) seulement si besoin.
 */
export const femaleF0Hz = () => envNum('DUB_FEMALE_F0', Number.POSITIVE_INFINITY);
/**
 * Une réplique plus courte (s) ne crée jamais de nouveau locuteur (empreinte
 * trop peu fiable) : 2 s. À 1 s, le son d'un match (public, musique) faisait
 * naître des dizaines de « locuteurs » par tronçon, tous en troisième voix.
 */
const minNewSpeakerSec = () => envNum('DUB_MIN_NEW_SPEAKER_SEC', 2);
/**
 * Locuteurs au plus par match (commentateur, consultant, troisième voix,
 * reporter) : au-delà, une réplique rejoint le locuteur le plus proche.
 */
export const maxSpeakers = () => Math.max(1, Math.trunc(envNum('DUB_MAX_SPEAKERS', 4)));

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
  /** Parole classée homme/femme (s) pendant les `FEMALE_WINDOW_SEC` premières secondes du locuteur. */
  femaleSec?: number;
  /** Probabilité « voix de femme » moyenne de cette parole (pondérée par la durée des répliques). */
  femaleP?: number;
  /** Voix attribuée, stable pour tout le match (sauf bascule unique vers F, voir `assignRoles`). */
  role?: VoiceRole;
  /** Voix portée avant la bascule vers F (premières répliques du locuteur). */
  roleBefore?: VoiceRole;
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
 * un nouveau locuteur — sauf réplique trop courte, ou `maxSpeakers` déjà
 * atteint : rattachée au plus proche.
 * Une réplique sans empreinte prend le locuteur de la précédente (à défaut,
 * de la suivante). Chaque locuteur cumule son temps de parole, ses hauteurs
 * de voix et, sur ses `FEMALE_WINDOW_SEC` premières secondes de parole, la
 * probabilité « voix de femme » de ses répliques rattachées par empreinte
 * (`female`, peut être vide).
 * Rend l'id du locuteur de chaque réplique (null : aucun locuteur connu, la
 * voix principale sera utilisée).
 */
export function assignSpeakers(
  state: SpeakerState,
  durations: readonly number[],
  embeddings: readonly (readonly number[] | null)[],
  f0: readonly (number | null)[],
  female: readonly (number | null)[] = [],
  o: { threshold?: number; minNewSec?: number; maxSpeakers?: number } = {},
): (number | null)[] {
  const threshold = o.threshold ?? speakerSimThreshold();
  const minNewSec = o.minNewSec ?? minNewSpeakerSec();
  const maxCount = o.maxSpeakers ?? maxSpeakers();
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
    } else if (best && bestSim > -1 && (durations[i] < minNewSec || state.speakers.length >= maxCount)) {
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
    const d = Math.max(0, durations[i]);
    // Preuve du genre : seulement une réplique rattachée par son empreinte (pas par voisinage).
    const p = embeddings[i]?.length ? female[i] : null;
    if (typeof p === 'number' && p >= 0 && p <= 1 && d > 0 && s.talk < FEMALE_WINDOW_SEC) {
      const sec = s.femaleSec ?? 0;
      s.femaleP = ((s.femaleP ?? 0) * sec + p * d) / (sec + d);
      s.femaleSec = sec + d;
    }
    s.talk += d;
    const hz = f0[i];
    if (typeof hz === 'number' && Number.isFinite(hz) && hz > 0) {
      s.f0.push(Math.round(hz * 10) / 10);
      if (s.f0.length > 200) s.f0.shift();
    }
  }
  return ids;
}

/**
 * Le classifieur du moteur entend-il une femme ? Au moins `FEMALE_MIN_SEC`
 * de parole classée et une probabilité moyenne ≥ `minProb`.
 */
export function heardFemale(s: Pick<Speaker, 'femaleSec' | 'femaleP'>, minProb = femaleProbMin()): boolean {
  return (s.femaleSec ?? 0) >= FEMALE_MIN_SEC && (s.femaleP ?? 0) >= minProb;
}

/**
 * Voix des locuteurs (modifie `state`) ; rend les locuteurs qui viennent de
 * basculer vers F.
 *
 * Nouveaux locuteurs, par temps de parole décroissant : une femme
 * (`heardFemale` ; ou, si ce réglage est actif et que le classifieur n'a pas
 * assez entendu le locuteur, hauteur médiane ≥ `femaleHz`) prend F si le
 * moteur a cette voix, sinon B1 ; les autres prennent A
 * (commentateur), puis B4 (consultant), puis B1. Une voix attribuée ne
 * change plus, à UNE exception : un locuteur vu d'abord trop brièvement pour
 * être classé reçoit une voix d'homme provisoire ; si les preuves arrivent
 * ensuite (ses répliques des `FEMALE_WINDOW_SEC` premières secondes de
 * parole, les seules qui comptent), il bascule une fois vers F et n'en
 * change plus. Après ces 30 s, son genre est figé : jamais de bascule tardive
 * en plein match. La hauteur de voix ne décide jamais d'une bascule.
 */
export function assignRoles(
  state: SpeakerState,
  voices: readonly string[],
  femaleHz = femaleF0Hz(),
  minProb = femaleProbMin(),
): Speaker[] {
  const hasF = voices.includes('F');
  const switched: Speaker[] = [];
  for (const s of state.speakers) {
    if (s.role && s.role !== 'F' && hasF && heardFemale(s, minProb)) {
      s.roleBefore = s.role;
      s.role = 'F';
      switched.push(s);
    }
  }
  const used = new Set<VoiceRole>(state.speakers.flatMap((s) => (s.role ? [s.role] : [])));
  const fresh = state.speakers.filter((s) => !s.role).sort((a, b) => b.talk - a.talk || a.id - b.id);
  for (const s of fresh) {
    // Hauteur de voix : seulement faute de parole classée (classifieur absent), jamais contre lui.
    const hz = (s.femaleSec ?? 0) < FEMALE_MIN_SEC ? median(s.f0) : null;
    const female = heardFemale(s, minProb) || (hz !== null && hz >= femaleHz);
    const role: VoiceRole = female ? (hasF ? 'F' : 'B1') : ((['A', 'B4'] as const).find((r) => !used.has(r)) ?? 'B1');
    s.role = role;
    used.add(role);
  }
  return switched;
}

/** Voix réellement disponible pour un rôle (repli si le moteur ne l'a pas). */
export function voiceFor(role: VoiceRole, voices: readonly string[]): string {
  const chain: Record<VoiceRole, VoiceRole[]> = { A: ['A', 'B4', 'B1'], B4: ['B4', 'B1', 'A'], B1: ['B1', 'B4', 'A'], F: ['F', 'B1', 'B4', 'A'] };
  return chain[role].find((v) => voices.includes(v)) ?? voices[0] ?? role;
}

/** Rôles utilisés (voix d'avant une bascule vers F comprises), dans l'ordre canonique. */
export function rolesUsed(state: SpeakerState): VoiceRole[] {
  const set = new Set(state.speakers.flatMap((s) => [s.role, s.roleBefore]));
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
  speakers: s.speakers.map((x) => ({
    ...x,
    centroid: x.centroid.map(r5),
    talk: Math.round(x.talk * 100) / 100,
    ...(x.femaleSec === undefined ? {} : { femaleSec: Math.round(x.femaleSec * 100) / 100 }),
    ...(x.femaleP === undefined ? {} : { femaleP: Math.round(x.femaleP * 1e4) / 1e4 }),
  })),
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

export interface CueGroup {
  /** Indices (dans le tronçon) des sous-titres dits d'une traite. */
  idx: number[];
  text: string;
  start: number;
  end: number;
  /** Emphase la plus forte du groupe. */
  emphasis: number;
}

/** Fin de phrase : ponctuation finale (guillemets ou parenthèse fermants permis après). */
const SENTENCE_END = /[.!?…:;]["'»”’)\]\s]*$/;

/**
 * Répliques dites d'une seule traite : les sous-titres sont courts (≤ 5 s,
 * coupés sur les respirations) et une phrase en couvre souvent plusieurs.
 * Synthétiser chaque morceau à part casse l'intonation (le ton retombe en
 * fin de morceau, au milieu de la phrase). Les morceaux consécutifs d'une
 * même phrase — même locuteur, pas de ponctuation finale, écart ≤ `maxGap`
 * s — sont donc réunis, jusqu'à `maxSec` s. Sous-titres non traduits ou
 * vides : ignorés (et ils coupent le groupe).
 */
export function groupCues(
  cues: readonly Pick<db.CommentaryCueRow, 'text_fr' | 'untranslated' | 'start_ts' | 'end_ts' | 'emphasis'>[],
  speakers: readonly (number | null)[],
  maxSec = 12,
  maxGap = 0.8,
): CueGroup[] {
  const groups: CueGroup[] = [];
  let cur: CueGroup | null = null;
  let curSpeaker: number | null = null;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const text = c.text_fr.trim();
    if (c.untranslated || !text) {
      cur = null;
      continue;
    }
    const joinable =
      cur &&
      speakers[i] === curSpeaker &&
      !SENTENCE_END.test(cur.text) &&
      c.start_ts - cur.end <= maxGap &&
      c.end_ts - cur.start <= maxSec;
    if (cur && joinable) {
      cur.idx.push(i);
      cur.text = `${cur.text} ${text}`;
      cur.end = c.end_ts;
      cur.emphasis = Math.max(cur.emphasis, c.emphasis ?? 0);
    } else {
      cur = { idx: [i], text, start: c.start_ts, end: c.end_ts, emphasis: c.emphasis ?? 0 };
      curSpeaker = speakers[i] ?? null;
      groups.push(cur);
    }
  }
  return groups;
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
  /**
   * Arrêté à la demande (« Arrêter le doublage ») : la fiche propose
   * « Reprendre le doublage » (`requestDub`, qui efface la marque).
   */
  stopped?: boolean;
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

// ------------------------------------------------------------------ exécution d'un travail

interface Job {
  matchId: number;
  /** Demandé par quelqu'un qui regarde le match : passe devant un doublage de fond. */
  viewer?: boolean;
  /**
   * Demande EXPLICITE (« Doubler ce match », « Relancer le doublage ») : le
   * match est doublé jusqu'au bout, même si plus personne ne regarde la
   * fiche, même hors fenêtre, traduction automatique désactivée ou mode
   * « sous-titres ». Il attend ses sous-titres et cède quand même la place
   * au GPU et à la lecture d'un AUTRE match.
   */
  explicit?: boolean;
}

/** Pourquoi un doublage cède la place : GPU pris, lecture d'un autre match, hors fenêtre de fond. */
export type DubYield = 'gpu' | 'viewer' | 'window';

export interface DubProgress {
  /** Tronçons doublés (à jour) sur `total` tronçons traduits publiés. */
  done: number;
  total: number;
  /** Tronçon en cours (idx). */
  chunk?: number;
  /** Étape en cours, en clair (« synthèse des répliques : 12 / 30 »…), affichée sur la fiche. */
  step?: string;
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
  /**
   * Découpe la plage dans le son complet du match extrait par la traduction
   * (pas de nouvelle lecture du flux ok.ru) ; false s'il n'est pas là ou ne
   * couvre pas encore la plage (l'audio est alors lu dans le flux).
   */
  localAudio?: (okId: string, start: number, length: number, outFile: string, signal: AbortSignal) => Promise<boolean>;
}

const defaultDeps: DubDeps = {
  // Sans `force`, le flux déjà résolu par le lecteur est réutilisé (voir commentary.ts).
  resolveStream: (okId, force) => resolveOkStream(okId, { force: !!force }),
  extract: extractAudioChunk,
  openVoice: async (signal) => {
    const e = await loadEngine();
    if (!e) throw new Error(`moteur de voix indisponible : ${eng.loadError ?? 'module absent'}`);
    // Modèles d'abord en cache, sans le GPU : si le travail cède la place
    // pendant le téléchargement, seule l'attente s'arrête (pas le téléchargement).
    if (e.prepare) await untilAborted(e.prepare(), signal, 'téléchargement des voix');
    return e.open(signal);
  },
  assemble: (clips, duration, outFile, signal) => assembleChunk(clips, duration, outFile, signal),
  localAudio: sliceFullAudio,
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

/** Attend `p`, ou rejette dès l'interruption (sans arrêter ce que `p` représente). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${what} : attente interrompue`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${what} : attente interrompue`));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Téléchargement des modèles de voix, en clair (« 42 % · 1,1 / 2,5 Go »). */
export function downloadText(p: { done: number; total: number }): string {
  const go = (b: number) => (b / 1e9).toFixed(1).replace('.', ',');
  const amount = p.total > 0 ? `${Math.min(99, Math.floor((p.done * 100) / p.total))} % · ${go(p.done)} / ${go(p.total)} Go` : `${go(p.done)} Go`;
  return `téléchargement des voix (premier usage, une seule fois) : ${amount}`;
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
  let current: DubProgress = { done: 0, total: 0 };
  const report = (p: DubProgress) => {
    current = p;
    progress(p);
  };
  const step = (text: string) => report({ ...current, step: text });

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
        // 1. Audio d'origine du tronçon (empreintes vocales) : découpé dans le
        // son complet du match extrait par la traduction, sinon lu dans le flux.
        const exStart = Math.max(0, Math.min(ch.keepFrom, cues[0].start_ts) - 0.5);
        const exEnd = Math.max(Number.isFinite(ch.keepTo) ? ch.keepTo : 0, ...cues.map((c) => c.end_ts)) + 0.5;
        const exLen = Math.ceil((exEnd - exStart) * 10) / 10;
        const audio = path.join(tmp, `source-${ch.idx}.ogg`);
        chunkFiles.push(audio);
        if (!(await deps.localAudio?.(okId, exStart, exLen, audio, signal))) {
          step('extraction du son d’origine');
          await extract(exStart, exLen, audio);
        }
        yieldCheck();
        if (!session) step('démarrage du moteur de voix');
        const voice = await openSession();
        step('reconnaissance des voix des commentateurs');
        // 2. Empreinte de chaque réplique ; en échec, voix de la précédente.
        let embeddings: (number[] | null)[] = cues.map(() => null);
        let f0: (number | null)[] = cues.map(() => null);
        let female: (number | null)[] = [];
        try {
          const r = await voice.embed(
            audio,
            cues.map((c) => [Math.max(0, c.start_ts - exStart), Math.max(0, c.end_ts - exStart)] as [number, number]),
            signal,
          );
          embeddings = cues.map((_, i) => r.embeddings[i] ?? null);
          f0 = cues.map((_, i) => r.f0[i] ?? null);
          female = r.female ? cues.map((_, i) => r.female?.[i] ?? null) : [];
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
          female,
        );
        for (const s of assignRoles(state, voice.voices)) {
          console.log(
            `[doublage] match ${job.matchId} : locuteur #${s.id} reconnu comme une femme ` +
              `(P(femme) ${(s.femaleP ?? 0).toFixed(2).replace('.', ',')} sur ${Math.round(s.femaleSec ?? 0)} s) : voix ${s.roleBefore} → F`,
          );
        }
        // 4-5. Synthèse et calage : les morceaux d'une même phrase d'une seule traite (intonation).
        const groups = groupCues(cues, speakers);
        const toSay = groups.length;
        let said = 0;
        for (const g of groups) {
          const first = cues[g.idx[0]];
          const lastCue = cues[g.idx[g.idx.length - 1]];
          step(`synthèse des répliques : ${++said} / ${toSay}`);
          yieldCheck();
          checkAborted(signal);
          const sp = state.speakers.find((s) => s.id === speakers[g.idx[0]]);
          const role: VoiceRole = sp?.role ?? 'A';
          const out = path.join(tmp, `cue-${first.seq}.wav`);
          chunkFiles.push(out);
          let r: { duration: number };
          try {
            r = await voice.synth(emphasize(g.text, g.emphasis), voiceFor(role, voice.voices), out, signal, { emphasis: g.emphasis });
            if (!(r.duration > 0)) throw new Error('synthèse vide');
          } catch (e) {
            checkAborted(signal);
            failed += g.idx.length;
            lastErr = short(e);
            console.error(`[doublage] match ${job.matchId} : réplique ${first.seq} ignorée (${clock(first.start_ts)}) : ${lastErr}`);
            continue;
          }
          const k = allCues.findIndex((x) => x.seq === lastCue.seq);
          const nextStart = k >= 0 && k + 1 < allCues.length ? allCues[k + 1].start_ts : null;
          const fit = fitCue(r.duration, g.start, g.end, nextStart);
          clips.push({ file: out, start: g.start, slotEnd: g.start + fit.slot, fitted: fit.fitted, tempo: fit.tempo, overrun: fit.overrun });
          if (sp) talk.set(sp.id, (talk.get(sp.id) ?? 0) + (g.end - g.start));
        }
        if (toSay && !clips.length) throw new Error(`synthèse impossible pour tout le tronçon ${ch.idx} (${failed} réplique(s)) : ${lastErr}`);
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
      step('montage de la piste');
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
      report({ done: chunks.length - todo.length, total, chunk: ch.idx });
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
  if (complete && deps.localAudio) dropFullAudio(okId); // son complet gardé pour le doublage : il ne sert plus
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
    /** Interrompu pour rendre la carte graphique à une traduction : remis en tête de file. */
    gpuYield?: boolean;
    /** Arrêté à la demande (`stopDub`) : ni remis en file, ni compté comme échec. */
    stopped?: boolean;
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
  return gpuHolder(0) !== null;
}

/** Le moteur de voix utilise-t-il la carte graphique ? (Moteur pas encore chargé : oui, par prudence.) */
function dubUsesGpu(): boolean {
  const e = eng.override ?? eng.engine;
  try {
    return e?.usesGpu?.() ?? true;
  } catch {
    return true;
  }
}

/** Le doublage doit-il attendre la carte graphique ? Seulement si son moteur s'en sert et qu'elle est prise. */
const gpuBlocksDub = () => dubUsesGpu() && gpuBusy();

/** Ce qui occupe le GPU, en clair et vu depuis le match `matchId` (« la traduction de ce match »…), sinon null. */
function gpuHolder(matchId: number): string | null {
  const c = commentaryActivity().running;
  if (c) return c.matchId === matchId ? 'la traduction de ce match' : 'la traduction d’un autre match';
  const a = analysisActivity().running.filter((r) => r.phase !== 'en pause pendant la lecture');
  if (!a.length) return null;
  return a.some((r) => r.matchId === matchId) ? 'l’analyse vidéo de ce match' : 'l’analyse vidéo d’un autre match';
}

/**
 * Téléchargement des modèles de voix lancé tout de suite (premier usage,
 * ~2,5 Go), sans attendre le GPU : il avance pendant que le doublage attend
 * en file. Sans effet si les modèles sont déjà là ou en cours de téléchargement.
 */
function prefetchVoiceModels(): void {
  void loadEngine()
    .then((e) => e?.prepare?.())
    .catch((err) => console.error(`[doublage] modèles de voix : ${short(err)} (nouvel essai au prochain doublage)`));
}

/** Téléchargement des modèles de voix en cours, en clair, sinon undefined. */
function downloadStep(): string | undefined {
  const d = (eng.override ?? eng.engine)?.download?.();
  return d ? downloadText(d) : undefined;
}

/**
 * Pas de doublage de fond : un travail ni demandé (« Doubler ce match ») ni
 * regardé est abandonné. Une traduction ne lance jamais le doublage.
 */
const unwanted = (job: Job) => !job.viewer && !job.explicit && !viewerActive(job.matchId);
/** Travail de fond (ou explicite, fiche fermée) qui doit attendre : quelqu'un regarde un autre match. */
const mustWait = (job: Job) => (!job.viewer || !!job.explicit) && !viewerActive(job.matchId) && someoneWatching(job.matchId);
/** La traduction de ce match tourne ou est en file : d'autres tronçons de sous-titres vont arriver. */
const translationPending = (matchId: number) => commentaryRunningMatchId() === matchId || commentaryQueuePosition(matchId) !== null;
/** Travail explicite qui attend ses sous-titres : il reste en file sans partir. */
const waitsForSubtitles = (job: Job) => !!job.explicit && !hasDubWork(job.matchId) && translationPending(job.matchId);

function controlFor(job: Job): DubControl {
  return {
    yieldReason: () => {
      if (gpuBlocksDub()) return 'gpu';
      if (viewerActive(job.matchId)) return null;
      // Le spectateur est parti : un autre match est regardé, ou plus personne.
      if (someoneWatching(job.matchId)) return 'viewer';
      if (job.explicit) return null; // demande explicite : jusqu'au bout
      return 'window'; // pas de doublage de fond

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

/**
 * Met un match en file de doublage. `priority` : en tête (match regardé),
 * quitte à interrompre un doublage de fond ; `explicit` : demande explicite
 * (voir `Job`), mise en file même si la traduction n'a encore rien publié
 * pourvu qu'elle tourne ou soit en file.
 */
export function enqueueDub(matchId: number, opts: { priority?: boolean; explicit?: boolean } = {}): DubEnqueueResult {
  const disabled = dubDisabledReasonSync();
  if (disabled) return { queued: false, started: false, message: `Doublage inactif : ${disabled}` };
  const running = st.running?.stopped ? undefined : st.running?.job; // un doublage qui s'arrête ne compte plus
  if (running?.matchId === matchId) {
    if (opts.explicit) running.explicit = true; // le travail en cours devient explicite : il ira jusqu'au bout
    return { queued: false, started: true, message: 'Doublage déjà en cours' };
  }
  if (!hasDubWork(matchId) && !(opts.explicit && translationPending(matchId))) {
    return { queued: false, started: false, message: 'Rien à doubler (sous-titres absents ou déjà doublés)' };
  }
  const existing = st.queue.findIndex((j) => j.matchId === matchId);
  const job: Job = {
    matchId,
    viewer: !!opts.priority || (existing >= 0 && !!st.queue[existing].viewer),
    explicit: !!opts.explicit || (existing >= 0 && !!st.queue[existing].explicit),
  };
  if (existing >= 0) {
    if (opts.priority) {
      st.queue.splice(existing, 1);
      st.queue.unshift(job);
    } else st.queue[existing] = job;
  } else if (opts.priority) st.queue.unshift(job);
  else st.queue.push(job);
  if (opts.priority) preemptBackground();
  prefetchVoiceModels();
  pump();
  if (st.running?.job.matchId === matchId) return { queued: true, started: true, message: 'Doublage lancé' };
  const position = dubQueuePosition(matchId);
  if (!position) return { queued: false, started: false, message: 'Doublage abandonné : ni demandé ni regardé' };
  if (waitsForSubtitles(job)) return { queued: true, started: false, position, message: 'Doublage en file : il commencera dès les premiers sous-titres français' };
  return { queued: true, started: false, position, message: `Doublage en file (position ${position})` };
}

/**
 * Un match regardé passe devant un doublage de FOND en cours : celui-ci est
 * interrompu, puis remis en file juste derrière. Un doublage explicite dont
 * la fiche n'est plus regardée cède aussi la place.
 */
function preemptBackground(): void {
  const r = st.running;
  if (!r || r.preempted || r.job.matchId === st.queue[0]?.matchId) return;
  if (r.job.viewer && !(r.job.explicit && !viewerActive(r.job.matchId))) return;
  r.preempted = true;
  console.log(`[doublage] match ${r.job.matchId} mis en pause : le match ${st.queue[0]?.matchId} est regardé, il passe en premier`);
  r.abort();
}

let repumpTimer: NodeJS.Timeout | undefined;

/**
 * Une traduction va démarrer : le doublage en cours rend la carte graphique
 * TOUT DE SUITE (le travail est interrompu, la session de voix fermée) au
 * lieu d'attendre la fin de sa réplique — sinon Whisper et le traducteur se
 * chargeraient par-dessus Qwen3-TTS. Il est remis en tête de file et reprend
 * quand la carte est libre. Appelé par commentary.ts avant chaque travail.
 */
export function releaseGpuForTranslation(maxWaitMs = 20_000): Promise<void> | null {
  const r = st.running;
  if (!r) return null; // rien à libérer : la traduction démarre aussitôt
  if (!dubUsesGpu()) return null; // synthèse en ligne (MiniMax) : les deux tournent ensemble
  r.gpuYield = true;
  r.abort();
  return (async () => {
    const t0 = Date.now();
    while (st.running === r && Date.now() - t0 < maxWaitMs) await new Promise((res) => setTimeout(res, 50));
  })();
}
// Branché sur la file des traductions (via globalThis : pas d'import circulaire, et un seul
// point d'entrée même si le module est chargé par plusieurs bundles).
(globalThis as { __commentaryGpuGate?: () => Promise<void> | null }).__commentaryGpuGate = () => releaseGpuForTranslation();
/**
 * La traduction garde le son complet du match quand il va être doublé
 * (doublage en cours ou en file) : le doublage le
 * découpe au lieu de relire le flux ok.ru en concurrence avec le lecteur,
 * puis l'efface une fois le doublage complet.
 */
(globalThis as { __dubWantsAudio?: (id: number) => boolean }).__dubWantsAudio = (id) =>
  st.running?.job.matchId === id || dubQueuePosition(id) !== null;

function scheduleRepump(): void {
  clearTimeout(repumpTimer);
  repumpTimer = setTimeout(pump, Number(process.env.DUB_REPUMP_MS) || 20_000);
  repumpTimer.unref?.();
}

function pump(): void {
  clearTimeout(repumpTimer);
  if (!st.running && st.queue.length) {
    if (dubDisabledReasonSync()) st.queue.length = 0;
    st.queue = st.queue.filter((j) => !unwanted(j));
    if (st.queue.length && gpuBlocksDub()) scheduleRepump(); // GPU pris : on attend sa libération
    else {
      while (!st.running && st.queue.length) {
        // Premier travail qui peut partir : ceux des spectateurs toujours, ceux de fond quand personne ne regarde ;
        // un travail explicite qui attend ses sous-titres reste en file.
        const i = st.queue.findIndex((j) => !mustWait(j) && !waitsForSubtitles(j));
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
      if (state.stopped) {
        endLog(true, 'arrêté à la demande');
        console.log(`[doublage] match ${job.matchId} arrêté à la demande ; ce qui est doublé reste disponible`);
        return;
      }
      if (state.gpuYield) {
        endLog(true, 'interrompu : une traduction a besoin de la carte graphique');
        if (!st.queue.some((j) => j.matchId === job.matchId)) st.queue.unshift({ ...job });
        console.log(`[doublage] match ${job.matchId} en pause : une traduction a besoin de la carte graphique ; reprise ensuite`);
        return;
      }
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
      // Demande explicite : tant que la traduction peut publier d'autres tronçons, le doublage revient en file.
      if (res.ok && job.explicit && translationPending(job.matchId) && !st.queue.some((j) => j.matchId === job.matchId)) {
        st.queue.push({ ...job, viewer: false });
        console.log(`[doublage] match ${job.matchId} : la traduction continue, la suite sera doublée ensuite`);
      }
    })
    .finally(() => {
      st.running = null;
      pump();
    });
}

/**
 * Le match est regardé : son doublage, s'il a été demandé (« Doubler ce
 * match ») et attend en file, passe en tête (il démarre quand le GPU est
 * libre : la traduction passe d'abord). Regarder un match ne lance jamais
 * son doublage, pas plus qu'une traduction.
 */
export function prioritizeDubOnView(matchId: number): void {
  const pos = dubQueuePosition(matchId);
  if (pos === null || pos === 1 || st.running?.job.matchId === matchId) return;
  if (dubDisabledReasonSync() || !hasDubWork(matchId)) return;
  enqueueDub(matchId, { priority: true });
}

export interface DubStopResult {
  stopped: boolean;
  message: string;
}

/**
 * « Arrêter le doublage » (tout utilisateur, depuis la fiche) : le doublage
 * de ce match quitte la file, ou s'interrompt s'il tourne ; les tronçons
 * déjà doublés restent jouables ; « Reprendre le doublage » (`requestDub`)
 * le relance. La traduction des commentaires n'est pas touchée.
 */
export function stopDub(matchId: number): DubStopResult {
  const r = st.running?.job.matchId === matchId && !st.running.stopped ? st.running : null;
  const queued = dubQueuePosition(matchId) !== null;
  if (!r && !queued) return { stopped: false, message: 'Aucun doublage en cours pour ce match' };
  st.queue = st.queue.filter((j) => j.matchId !== matchId);
  const t = currentCommentaryTrack(matchId);
  db.kvSet(recordKey(matchId), {
    at: new Date().toISOString(),
    ok: true,
    failures: 0,
    reason: 'doublage arrêté',
    key: t ? db.commentaryKey(t) : null,
    stopped: true,
  } satisfies DubRecord);
  console.log(`[doublage] match ${matchId} : arrêt demandé`);
  if (r) {
    r.stopped = true;
    r.abort();
  }
  pump();
  return { stopped: true, message: 'Doublage arrêté. Les passages déjà doublés restent disponibles.' };
}

/** Doublage complet et à jour (piste traduite complète, tous ses tronçons doublés) ? */
function dubComplete(matchId: number): boolean {
  const t = currentCommentaryTrack(matchId);
  const d = db.getDubTrack(matchId);
  return !!t && !!d && d.commentary_key === db.commentaryKey(t) && d.complete === 1;
}

export interface DubRequestResult extends DubEnqueueResult {
  /** Message de la mise en file de la traduction, quand les sous-titres n'étaient pas complets. */
  translation?: string;
}

/**
 * Demande EXPLICITE depuis la fiche : « Doubler ce match » (tout
 * utilisateur) ou, avec `reset`, « Relancer le doublage » (administrateurs :
 * le doublage existant est effacé puis refait). Sous-titres incomplets : la
 * traduction est d'abord mise en file, explicite elle aussi ; puis le
 * doublage, en travail explicite (voir `Job`), qui suit la traduction
 * tronçon par tronçon jusqu'au doublage complet.
 */
export function requestDub(matchId: number, opts: { reset?: boolean } = {}): DubRequestResult {
  const disabled = dubDisabledReasonSync();
  if (disabled) return { queued: false, started: false, message: `Doublage inactif : ${disabled}` };
  const rec = getDubRecord(matchId);
  if (rec?.stopped) {
    // Repris après un arrêt : les mises en file automatiques redeviennent permises.
    const { stopped: _stopped, ...rest } = rec;
    db.kvSet(recordKey(matchId), { ...rest, at: new Date().toISOString(), reason: 'doublage repris' } satisfies DubRecord);
  }
  if (opts.reset) {
    if (st.running?.job.matchId === matchId) return { queued: false, started: true, message: 'Doublage en cours : relance possible une fois terminé' };
    db.deleteDub(matchId);
    fs.rmSync(dubDir(matchId), { recursive: true, force: true });
    // Échecs passés oubliés : la relance repart de zéro.
    if (getDubRecord(matchId)) db.kvSet(recordKey(matchId), { at: new Date().toISOString(), ok: true, failures: 0, reason: 'doublage relancé', key: null } satisfies DubRecord);
    console.log(`[doublage] match ${matchId} : doublage effacé, relancé par un administrateur`);
  } else if (dubComplete(matchId)) {
    return { queued: false, started: false, message: 'Ce match est déjà doublé' };
  }
  let translation: string | undefined;
  if (!commentaryReady(matchId)) {
    const c = enqueueCommentary(matchId, { priority: true, explicit: true });
    translation = c.message;
    if (!c.queued && !c.started && !hasDubWork(matchId)) return { queued: false, started: false, message: c.message, translation };
  }
  const r = enqueueDub(matchId, { priority: true, explicit: true });
  const message = r.queued && !r.started && translation ? 'Doublage demandé : la traduction des commentaires passe d’abord' : r.message;
  return { ...r, message, ...(translation ? { translation } : {}) };
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
  const r = st.running?.stopped ? null : st.running;
  return {
    running: r ? { matchId: r.job.matchId, done: r.progress?.done ?? 0, total: r.progress?.total ?? 0, watched: viewerActive(r.job.matchId) } : null,
    queued: st.queue.map((j) => j.matchId),
    waitingForGpu: !r && st.queue.length > 0 && gpuBlocksDub(),
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

/** Contrat de GET /api/matches/[id]/dub (lecteur, bandeau de la fiche). */
export interface DubManifest {
  status: DubStatusName;
  reason?: string;
  /** Pendant le travail (`running`) : tronçons doublés sur tronçons traduits publiés. */
  progress?: { done: number; total: number };
  /** Étape en cours (`running`) ou téléchargement des voix qui avance pendant l'attente (`waiting`), en clair. */
  step?: string;
  /** Arrêté à la demande (`none` ou `partial`) : « Reprendre le doublage » le relance. */
  stopped?: true;
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
  const download = downloadStep();
  if (st.running?.job.matchId === matchId && !st.running.stopped) {
    const p = st.running.progress;
    const step = download ?? p?.step;
    return { status: 'running', ...(p && p.total ? { progress: { done: p.done, total: p.total } } : {}), ...(step ? { step } : {}), ...base };
  }
  const position = dubQueuePosition(matchId);
  if (position) {
    const job = st.queue[position - 1];
    const holder = dubUsesGpu() ? gpuHolder(matchId) : null;
    const reason = waitsForSubtitles(job)
      ? 'traduction des commentaires en cours : le doublage suivra'
      : holder
        ? `en attente du GPU : ${holder} passe d’abord, le doublage reprend ensuite`
        : st.running
          ? `en file (position ${position}) : un autre match est en cours de doublage`
          : `en file (position ${position})`;
    return { status: 'waiting', reason, ...(download ? { step: download } : {}), ...base };
  }
  if (valid && dub.complete === 1) return { status: 'ready', ...base };
  const rec = getDubRecord(matchId);
  if (rec?.stopped) return { status: chunks.length ? 'partial' : 'none', reason: 'doublage arrêté', stopped: true, ...base };
  if (!track) return { status: 'none', reason: 'pas encore de sous-titres français', ...base };
  const failed = rec && !rec.ok && (!rec.key || rec.key === db.commentaryKey(track)) ? rec.reason : undefined;
  if (chunks.length) {
    return { status: 'partial', ...(failed ? { reason: failed } : {}), ...base };
  }
  if (failed) return { status: 'failed', reason: failed, ...base };
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
