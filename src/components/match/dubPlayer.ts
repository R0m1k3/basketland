/**
 * VF doublée : lecture de la voix française de synthèse, calée sur le replay.
 *
 * Le serveur produit le doublage par tranches (~2 min, AAC mono 24 kHz en
 * .m4a), décrites par le manifeste GET /api/matches/[id]/dub. Les temps sont
 * des secondes VIDÉO absolues : le t = 0 d'une tranche correspond au temps
 * vidéo `start`, et elle couvre `start`..`end`.
 *
 * Ce module ne dépend ni de React ni du DOM réel : l'élément vidéo, le
 * contexte audio et `fetch` sont injectés, et toute la logique se teste avec
 * des faux (voir tests/dub-player.test.ts).
 *
 * Principe :
 * - on télécharge et décode la tranche à la position de lecture, puis la
 *   suivante (au plus 3 tranches décodées en mémoire, ~23 Mo chacune une
 *   fois rééchantillonnées à 48 kHz) ;
 * - on programme un AudioBufferSourceNode au bon décalage par rapport à
 *   `video.currentTime`, et la tranche suivante à la suite, sans blanc ;
 * - tout ce qui casse la correspondance (saut, pause, vitesse, attente de
 *   tampon) arrête puis reprogramme ; une vérification par seconde corrige
 *   une dérive de plus de 150 ms ;
 * - tranche absente (doublage en cours) : la VO joue, simplement ;
 * - vitesse ≠ ×1 : la VF se tait (Web Audio n'a pas de correction de
 *   hauteur : la voix accélérée monterait dans les aigus), la VO reste à
 *   plein ; retour à ×1 → resynchronisation et reprise ;
 * - pendant la parole française (`speech`), le son ORIGINAL baisse à 20 %
 *   du volume choisi (rampes de 150 ms) ; entre deux phrases, l'ambiance de
 *   la salle revient à plein. Pour cela l'élément vidéo passe par Web Audio
 *   (createMediaElementSource → GainNode) ; à défaut, on joue sur
 *   `video.volume`, toujours restauré ensuite ;
 * - le manifeste porte `?t=<position>` seulement quand la VF doublée est
 *   choisie ET que la vidéo joue : c'est un signe de vie du spectateur (le
 *   serveur met alors les tâches de fond en pause et double à partir de
 *   là). En pause, à la fin ou avant le lancement, on n'interroge que le
 *   statut ; la lecture relance aussitôt une interrogation avec `?t=`.
 */

export type DubStatus = 'none' | 'waiting' | 'running' | 'partial' | 'ready' | 'disabled' | 'failed';

/** Intervalle [début, fin] en secondes vidéo. */
export type Interval = [number, number];

export interface DubChunk {
  idx: number;
  /** Temps vidéo (s) correspondant au t = 0 de l'audio de la tranche. */
  start: number;
  end: number;
  url: string;
  /** Intervalles (temps vidéo) où la voix française parle : sert à baisser la VO. */
  speech: Interval[];
}

export interface DubManifest {
  status: DubStatus;
  reason?: string;
  /** Triées par `start`. */
  chunks: DubChunk[];
  voices: Record<string, string>;
}

/** État publié pour l'interface (menu ⚙, pastille). */
export interface DubState {
  /** null tant que le manifeste n'a pas répondu. */
  status: DubStatus | null;
  /** Le choix « VF doublée » a-t-il un sens (statut ni none, ni disabled) ? */
  available: boolean;
  enabled: boolean;
  /** Indication courte pour le menu (« en préparation… »), ou null. */
  hint: string | null;
  /** VF doublée choisie, une tranche existe à la position de lecture, vitesse ×1. */
  active: boolean;
}

export const IDLE_DUB_STATE: DubState = { status: null, available: false, enabled: false, hint: null, active: false };

// ---------------------------------------------------------------- interfaces minimales (faux en test)

export interface VideoLike {
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  readonly readyState: number;
  readonly currentSrc?: string;
  readonly crossOrigin?: string | null;
  readonly isConnected?: boolean;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  /** 'suspended' | 'running' | 'closed' (+ 'interrupted' sous Safari). */
  readonly state: string;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createBufferSource(): BufferSourceLike;
  createMediaElementSource(element: VideoLike): AudioNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  addEventListener?(type: 'statechange', cb: () => void): void;
  removeEventListener?(type: 'statechange', cb: () => void): void;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: RequestCache }) => Promise<FetchResponseLike>;

export interface DubPlayerOptions {
  video: VideoLike;
  /** URL du manifeste, sans `?t=` (ex. « /api/matches/12/dub »). */
  manifestUrl: string;
  /** Crée le contexte audio : appelé seulement sur un geste (activation, lecture). */
  createAudioContext: () => AudioContextLike;
  fetch: FetchLike;
  /** Niveau de la VO pendant la parole française (part du volume choisi). */
  duckLevel?: number;
}

// ---------------------------------------------------------------- réglages

/** Délai (s) entre la programmation d'une source et son démarrage. */
export const LEAD = 0.05;
/** Écart toléré (s) entre la voix et l'image avant de reprogrammer. */
export const DRIFT_MAX = 0.15;
export const DRIFT_CHECK_MS = 1000;
/** Manifeste : toutes les 30 s quand la VF doublée est choisie (avec `?t=` pendant la lecture seulement)… */
export const REFRESH_MS = 30_000;
/** …toutes les 60 s sinon (sans `?t=` : on ne fait que guetter la disponibilité). */
export const IDLE_REFRESH_MS = 60_000;
/** Après un saut, le manifeste repart (avec la nouvelle position) au bout de… */
export const SEEK_REFRESH_MS = 1000;
/** Tranches décodées gardées en mémoire, au plus. */
export const MAX_DECODED = 3;
/** VO à 20 % du volume choisi pendant la parole française. */
export const DUCK_LEVEL = 0.2;
/** Durée des rampes de baisse / remontée de la VO (s). */
export const DUCK_RAMP = 0.15;
/** Deux phrases séparées de moins de 0,5 s : la VO reste baissée entre les deux (pas de « pompage »). */
export const DUCK_MERGE_GAP = 0.5;
/** La tranche suivante est programmée si elle commence dans moins de… (s). */
export const QUEUE_HORIZON = 150;
/** Fondu d'entrée / de sortie d'une source (évite les clics). */
const FADE = 0.02;
/** Une tranche en échec n'est pas redemandée avant… */
const RETRY_MS = 20_000;
/** Repli sans Web Audio : fréquence d'ajustement de `video.volume`. */
const FALLBACK_DUCK_MS = 50;
/** HTMLMediaElement.HAVE_FUTURE_DATA */
const HAVE_FUTURE_DATA = 3;

const STATUSES: readonly DubStatus[] = ['none', 'waiting', 'running', 'partial', 'ready', 'disabled', 'failed'];

// ---------------------------------------------------------------- fonctions pures

/** Indication du menu quand la vidéo n'est pas à vitesse normale. */
export const NORMAL_RATE_HINT = 'VF doublée à vitesse normale seulement';

/** La VF ne joue qu'à vitesse normale (×1). */
export function isNormalRate(rate: number): boolean {
  return Math.abs(rate - 1) < 1e-3;
}

export function isDubAvailable(status: DubStatus | null | undefined): boolean {
  return !!status && status !== 'none' && status !== 'disabled';
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Valide la réponse du serveur (champs absents ou faux → ignorés). */
export function parseManifest(raw: unknown): DubManifest {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const status = STATUSES.includes(o.status as DubStatus) ? (o.status as DubStatus) : 'none';
  const chunks: DubChunk[] = [];
  if (Array.isArray(o.chunks)) {
    for (const item of o.chunks as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      if (!finite(c.start) || !finite(c.end) || c.end <= c.start || typeof c.url !== 'string' || !c.url) continue;
      const speech: Interval[] = [];
      if (Array.isArray(c.speech)) {
        for (const s of c.speech as unknown[]) {
          if (Array.isArray(s) && finite(s[0]) && finite(s[1]) && s[1] > s[0]) speech.push([s[0], s[1]]);
        }
      }
      chunks.push({ idx: finite(c.idx) ? c.idx : chunks.length, start: c.start, end: c.end, url: c.url, speech });
    }
  }
  chunks.sort((a, b) => a.start - b.start);
  const voices: Record<string, string> = {};
  if (o.voices && typeof o.voices === 'object') {
    for (const [k, v] of Object.entries(o.voices as Record<string, unknown>)) if (typeof v === 'string') voices[k] = v;
  }
  return { status, reason: typeof o.reason === 'string' ? o.reason : undefined, chunks, voices };
}

/** Tranche couvrant l'instant `t` (start ≤ t < end), ou null. */
export function chunkAt(chunks: readonly DubChunk[], t: number): DubChunk | null {
  let lo = 0;
  let hi = chunks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const c = chunks[found];
  return t < c.end ? c : null;
}

/** Première tranche qui commence strictement après `t`. */
export function nextChunk(chunks: readonly DubChunk[], t: number): DubChunk | null {
  for (const c of chunks) if (c.start > t) return c;
  return null;
}

/** Trie et fusionne les intervalles de parole séparés de moins de `gap` secondes. */
export function mergeSpeech(intervals: readonly Interval[], gap = DUCK_MERGE_GAP): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] < gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Gain de la VO à l'instant `t` (1 = volume choisi) : rampe descendante sur
 * les `ramp` secondes AVANT chaque phrase, `level` pendant, rampe montante
 * sur les `ramp` secondes APRÈS. `merged` : sortie de mergeSpeech.
 */
export function duckGainAt(t: number, merged: readonly Interval[], level = DUCK_LEVEL, ramp = DUCK_RAMP): number {
  let g = 1;
  for (const [a, b] of merged) {
    if (a - ramp > t) break;
    let v = 1;
    if (t < a) v = 1 - ((1 - level) * (t - (a - ramp))) / ramp;
    else if (t <= b) v = level;
    else if (t < b + ramp) v = level + ((1 - level) * (t - b)) / ramp;
    g = Math.min(g, v);
  }
  return g;
}

/** Points de passage du gain de la VO (rampes linéaires entre deux points). */
export function duckPoints(merged: readonly Interval[], level = DUCK_LEVEL, ramp = DUCK_RAMP): { t: number; gain: number }[] {
  return merged.flatMap(([a, b]) => [
    { t: a - ramp, gain: 1 },
    { t: a, gain: level },
    { t: b, gain: level },
    { t: b + ramp, gain: 1 },
  ]);
}

/**
 * Indication du menu « Voix » à la position `t` :
 * - rien n'est encore doublé (en file, ou en cours sans tranche) → « en préparation… » ;
 * - d'autres passages sont prêts, pas celui-ci → « bientôt disponible ici » ;
 * - doublage en échec et passage absent → « indisponible ici » ;
 * - vitesse ≠ ×1 (prioritaire) → « VF doublée à vitesse normale seulement ».
 */
export function dubHint(m: DubManifest | null, t: number, rate = 1): string | null {
  if (!m || !isDubAvailable(m.status)) return null;
  if (!isNormalRate(rate)) return NORMAL_RATE_HINT;
  if (chunkAt(m.chunks, t)) return null;
  if (m.status === 'waiting' || (m.status === 'running' && !m.chunks.length)) return 'en préparation…';
  if (m.status === 'failed') return 'indisponible ici';
  if (m.status === 'ready') return null; // passage sans voix française : la VO suffit
  return 'bientôt disponible ici';
}

/**
 * Router l'élément vidéo dans Web Audio n'est sûr qu'en même origine : une
 * source d'une autre origine (sans CORS) y sortirait en SILENCE, sans erreur.
 * Les flux de l'app passent par le proxy (/api/video/…) ou un blob MSE.
 * HLS lu nativement (Safari iOS ancien, sans MSE) : WebKit sort aussi du
 * silence dans ce cas ; on s'en tient alors au repli.
 */
function canRoute(video: VideoLike): boolean {
  const src = video.currentSrc || '';
  if (/\.m3u8(\?|#|$)/i.test(src)) return false;
  if (!src || src.startsWith('blob:') || src.startsWith('data:') || video.crossOrigin) return true;
  if (typeof location === 'undefined') return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return true;
  }
}

function disconnect(node: AudioNodeLike | null | undefined) {
  try {
    node?.disconnect();
  } catch {
    /* déjà débranché */
  }
}

// ---------------------------------------------------------------- lecteur

interface BufferEntry {
  url: string;
  buffer: AudioBufferLike | null;
  pending: boolean;
  /** Échec : pas de nouvelle tentative avant cet instant (Date.now()). */
  retryAt: number;
  /** Horloge d'usage (éviction de la moins récemment utilisée). */
  used: number;
}

interface Scheduled {
  chunk: DubChunk;
  source: BufferSourceLike;
  fade: GainNodeLike;
  /** Instant (contexte audio) de démarrage. */
  when: number;
  /** Décalage dans l'audio de la tranche au démarrage (s). */
  offset: number;
  /** Temps vidéo où la source est coupée (tranche suivante enchaînée), sinon null. */
  stopAt: number | null;
}

/** Correspondance horloge audio ↔ temps vidéo, valable jusqu'au prochain arrêt. */
interface Mapping {
  ctx0: number;
  video0: number;
  rate: number;
}

/**
 * Contexte audio et routage, partagés par élément vidéo : un élément ne peut
 * passer qu'UNE fois par createMediaElementSource, et un lecteur recréé
 * (double montage en mode strict, changement de match) doit les retrouver.
 */
interface SharedGraph {
  ctx: AudioContextLike;
  users: number;
  route: { source: AudioNodeLike; gain: GainNodeLike } | null;
  routeFailed: boolean;
}

const graphs = new WeakMap<object, SharedGraph>();

export class DubPlayer {
  private readonly video: VideoLike;
  private readonly manifestUrl: string;
  private readonly createAudioContext: () => AudioContextLike;
  private readonly fetchFn: FetchLike;
  private readonly duckLevel: number;
  private readonly events: [string, () => void][];

  private manifest: DubManifest | null = null;
  private enabled = false;
  private destroyed = false;
  private graph: SharedGraph | null = null;
  private dubGain: GainNodeLike | null = null;
  private dubVolumeApplied = -1;
  private buffers = new Map<string, BufferEntry>();
  private scheduled: Scheduled[] = [];
  private mapping: Mapping | null = null;
  /** Intervalles de parole (fusionnés) des sources programmées. */
  private duckIntervals: Interval[] = [];
  /** Une automatisation de baisse de la VO est-elle posée ? */
  private duckDirty = false;
  private stalled = false;
  private lastTickT = -1;
  /** Volume choisi par l'utilisateur (jamais modifié durablement). */
  private userVolume: number;
  /** Dernier `video.volume` écrit par NOUS (repli sans Web Audio), sinon null. */
  private ownVolume: number | null = null;
  private useClock = 0;
  private manifestSeq = 0;
  private abort: AbortController | null = null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private duckTimer: ReturnType<typeof setInterval> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private seekRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private state: DubState = IDLE_DUB_STATE;

  constructor(opts: DubPlayerOptions) {
    this.video = opts.video;
    this.manifestUrl = opts.manifestUrl;
    this.createAudioContext = opts.createAudioContext;
    this.fetchFn = opts.fetch;
    this.duckLevel = opts.duckLevel ?? DUCK_LEVEL;
    this.userVolume = opts.video.volume;
    this.events = [
      ['seeking', this.onSeeking],
      ['seeked', this.onSeeked],
      ['pause', this.onPause],
      ['play', this.onPlay],
      ['playing', this.onPlaying],
      ['waiting', this.onWaiting],
      ['stalled', this.onStalled],
      ['ratechange', this.onRateChange],
      ['ended', this.onStop],
      ['emptied', this.onStop],
      ['volumechange', this.onVolumeChange],
      ['timeupdate', this.onTimeUpdate],
    ];
    for (const [type, fn] of this.events) this.video.addEventListener(type, fn);
    void this.refresh();
  }

  // --- interface publique

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): DubState => this.state;

  /** URL des tranches actuellement décodées en mémoire. */
  decodedChunks(): string[] {
    return [...this.buffers.values()].filter((e) => e.buffer).map((e) => e.url);
  }

  /**
   * À appeler sur un GESTE de l'utilisateur (activation de la VF doublée,
   * clic sur lecture) : crée ou relance le contexte audio, que les
   * navigateurs bloquent sans geste. Sans `force`, ne fait rien tant que la
   * VF doublée n'est pas choisie.
   */
  unlock(force = false) {
    if (this.destroyed || (!this.enabled && !force)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      try {
        ctx.resume().then(this.onCtxState, () => undefined);
      } catch {
        /* relance refusée : on réessaiera au prochain geste */
      }
    }
    this.onCtxState();
  }

  setEnabled(on: boolean) {
    if (this.destroyed || on === this.enabled) return;
    this.enabled = on;
    if (on) {
      if (this.ownVolume === null) this.userVolume = this.video.volume;
      this.stalled = false;
      this.lastTickT = -1;
      this.tickTimer = setInterval(this.tick, DRIFT_CHECK_MS);
      // Contexte déjà créé (geste antérieur) : on reprend tout de suite.
      if (this.graph) this.unlock();
      void this.refresh();
    } else {
      this.stopAll();
      this.resetDuck(true);
      this.restoreVolume();
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
      this.stopDuckLoop();
      clearTimeout(this.seekRefreshTimer);
      this.abort?.abort();
      this.abort = null;
      this.buffers.clear();
      const g = this.graph;
      // Sans routage de la vidéo, le contexte ne sert plus : on le met en veille.
      // Avec routage, il doit tourner : la VO le traverse (gain remis à 1).
      if (g && !g.route && g.users <= 1 && g.ctx.state === 'running') g.ctx.suspend().catch(() => undefined);
      this.planRefresh();
    }
    this.publish();
  }

  /**
   * Recharge le manifeste. `?t=` (signe de vie du spectateur) seulement
   * quand la VF doublée est choisie et que la vidéo JOUE : un onglet en
   * pause ne doit pas bloquer les tâches de fond du serveur.
   */
  refresh(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    clearTimeout(this.refreshTimer);
    const my = ++this.manifestSeq;
    const sep = this.manifestUrl.includes('?') ? '&' : '?';
    const watching = this.enabled && !this.video.paused && !this.video.ended;
    const url = watching ? `${this.manifestUrl}${sep}t=${Math.max(0, Math.floor(this.video.currentTime))}` : this.manifestUrl;
    return this.fetchFn(url, { cache: 'no-store' })
      .then((r) => (r.status === 404 ? { status: 'none' } : r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (raw) => {
          if (my === this.manifestSeq && !this.destroyed) this.setManifest(parseManifest(raw));
        },
        () => undefined, // on garde le manifeste précédent
      )
      .finally(() => {
        if (my === this.manifestSeq) this.planRefresh();
      });
  }

  /** Arrête tout et rend la main : volume et son d'origine restaurés. */
  destroy() {
    if (this.destroyed) return;
    this.setEnabled(false);
    this.destroyed = true;
    this.manifestSeq++;
    for (const [type, fn] of this.events) this.video.removeEventListener(type, fn);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.seekRefreshTimer);
    clearInterval(this.tickTimer);
    this.stopDuckLoop();
    disconnect(this.dubGain);
    this.dubGain = null;
    const g = this.graph;
    this.graph = null;
    if (g) {
      g.ctx.removeEventListener?.('statechange', this.onCtxState);
      g.users--;
      // Une vidéo routée ne sort plus que par ce contexte : on ne le ferme que
      // si l'élément a quitté la page (sinon elle deviendrait muette).
      if (g.users <= 0 && (!g.route || this.video.isConnected !== true)) {
        graphs.delete(this.video);
        try {
          g.ctx.close().catch(() => undefined);
        } catch {
          /* déjà fermé */
        }
      }
    }
    this.listeners.clear();
  }

  // --- événements de l'élément vidéo

  private onSeeking = () => {
    this.lastTickT = -1;
    this.stopAll();
  };

  private onSeeked = () => {
    this.lastTickT = -1;
    this.stalled = false;
    this.sync();
    this.publish();
    if (this.enabled) {
      // Nouvelle position : le serveur double en priorité à partir de là.
      clearTimeout(this.seekRefreshTimer);
      this.seekRefreshTimer = setTimeout(() => void this.refresh(), SEEK_REFRESH_MS);
    }
  };

  private onPause = () => {
    this.lastTickT = -1;
    this.stopAll();
  };

  private onPlay = () => {
    this.lastTickT = -1;
    // Filet de sécurité si l'appel direct à unlock() a manqué ; et une VO
    // routée dont le contexte a été suspendu serait muette : on le relance.
    if (this.enabled || this.graph?.route) this.unlock(true);
    // Lecture (re)lancée : le signe de vie `?t=` repart tout de suite.
    if (this.enabled) void this.refresh();
  };

  private onPlaying = () => {
    this.lastTickT = -1;
    this.stalled = false;
    this.sync();
  };

  private onWaiting = () => {
    this.stalled = true;
    this.stopAll();
  };

  /** « stalled » signale un réseau lent, pas forcément une image figée. */
  private onStalled = () => {
    if (this.video.readyState < HAVE_FUTURE_DATA) this.onWaiting();
  };

  /** Vitesse ≠ ×1 : silence (et VO à plein) ; retour à ×1 : reprogrammation. */
  private onRateChange = () => {
    this.lastTickT = -1;
    this.stopAll();
    this.sync();
    this.publish();
  };

  private onStop = () => this.stopAll();

  private onVolumeChange = () => {
    const v = this.video;
    if (this.ownVolume === null || Math.abs(v.volume - this.ownVolume) > 1e-6) {
      // Changement venu de l'utilisateur (curseur, touche M) : c'est la référence.
      this.userVolume = v.volume;
      this.ownVolume = null;
    }
    this.applyDubVolume();
    if (this.graph && !this.graph.route) this.fallbackDuck();
  };

  private onTimeUpdate = () => this.publish();

  private onCtxState = () => {
    if (this.destroyed || !this.graph || !this.enabled) return;
    if (this.graph.ctx.state === 'running') this.prepareGraph();
    this.sync();
    this.publish();
  };

  /** Vérification périodique : dérive, image figée sans événement, chargements. */
  private tick = () => {
    const v = this.video;
    const t = v.currentTime;
    if (!v.paused && !v.seeking && !v.ended && this.lastTickT >= 0) {
      const moved = Math.abs(t - this.lastTickT) > 0.05;
      if (!moved && !this.stalled) {
        this.stalled = true;
        this.stopAll();
      } else if (moved && this.stalled) this.stalled = false;
    }
    this.lastTickT = t;
    this.sync(true);
    this.publish();
  };

  // --- contexte audio et routage

  private ensureContext(): AudioContextLike | null {
    if (this.graph) return this.graph.ctx;
    let g = graphs.get(this.video);
    if (!g || g.ctx.state === 'closed') {
      let ctx: AudioContextLike;
      try {
        ctx = this.createAudioContext();
      } catch {
        return null; // pas de Web Audio : la VO reste seule
      }
      g = { ctx, users: 0, route: null, routeFailed: false };
      graphs.set(this.video, g);
    }
    g.users++;
    this.graph = g;
    g.ctx.addEventListener?.('statechange', this.onCtxState);
    return g.ctx;
  }

  /**
   * Branche la sortie de la VF et, une fois le contexte ACTIF seulement, la
   * VO : routée dans un contexte suspendu, la vidéo serait muette.
   */
  private prepareGraph() {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    if (!this.dubGain) {
      const gain = ctx.createGain();
      gain.gain.value = this.dubVolume();
      this.dubVolumeApplied = this.dubVolume();
      gain.connect(ctx.destination);
      this.dubGain = gain;
    }
    if (!g.route && !g.routeFailed) {
      if (!canRoute(this.video)) g.routeFailed = true;
      else {
        try {
          const gain = ctx.createGain();
          gain.connect(ctx.destination);
          const source = ctx.createMediaElementSource(this.video);
          source.connect(gain);
          g.route = { source, gain };
        } catch {
          g.routeFailed = true; // repli : baisse de la VO par video.volume
        }
      }
    }
    if (!g.route && !this.duckTimer) this.duckTimer = setInterval(this.fallbackDuck, FALLBACK_DUCK_MS);
  }

  private stopDuckLoop() {
    clearInterval(this.duckTimer);
    this.duckTimer = undefined;
  }

  // --- volume

  private dubVolume(): number {
    return this.video.muted ? 0 : this.userVolume;
  }

  private applyDubVolume() {
    const target = this.dubVolume();
    if (!this.dubGain || !this.graph || target === this.dubVolumeApplied) return;
    this.dubVolumeApplied = target;
    this.dubGain.gain.setTargetAtTime(target, this.graph.ctx.currentTime, 0.02);
  }

  /** Repli sans Web Audio : la VO baisse par `video.volume` (le volume choisi est mémorisé). */
  private fallbackDuck = () => {
    const g = this.graph;
    if (!g || g.route || !this.enabled) return;
    const v = this.video;
    const gain = this.duckIntervals.length ? duckGainAt(v.currentTime, this.duckIntervals, this.duckLevel, DUCK_RAMP) : 1;
    if (gain === 1 && this.ownVolume === null) return;
    const target = this.userVolume * gain;
    if (Math.abs(v.volume - target) < 0.002) return;
    this.ownVolume = target;
    v.volume = target;
  };

  private restoreVolume() {
    if (this.ownVolume === null) return;
    this.ownVolume = null;
    this.video.volume = this.userVolume;
  }

  // --- programmation

  private canPlay(): boolean {
    const v = this.video;
    const g = this.graph;
    return (
      this.enabled &&
      !this.destroyed &&
      !!g &&
      g.ctx.state === 'running' &&
      !!this.dubGain &&
      !v.paused &&
      !v.ended &&
      !v.seeking &&
      !this.stalled &&
      v.readyState >= HAVE_FUTURE_DATA &&
      isNormalRate(v.playbackRate)
    );
  }

  /** Réconcilie ce qui est programmé avec la position de lecture. */
  private sync(checkDrift = false) {
    if (!this.canPlay()) {
      this.stopAll();
      this.ensureLoads();
      return;
    }
    const ctx = this.graph!.ctx;
    const t = this.video.currentTime;
    const cur = chunkAt(this.manifest?.chunks ?? [], t);
    const head = cur ? this.scheduled.find((s) => s.chunk.url === cur.url) : undefined;
    if (cur && !head && this.playable(cur, t)) return this.schedule();
    if (checkDrift && this.mapping && this.scheduled.length) {
      const expected = this.videoAt(ctx.currentTime);
      if (Math.abs(expected - t) > DRIFT_MAX) return this.schedule();
    }
    if (!this.mapping) this.mapping = this.newMapping();
    this.queueNext();
    this.ensureLoads();
  }

  private newMapping(): Mapping {
    const rate = this.video.playbackRate;
    return { ctx0: this.graph!.ctx.currentTime + LEAD, video0: this.video.currentTime + LEAD * rate, rate };
  }

  private videoAt(ctxTime: number): number {
    const m = this.mapping!;
    return m.video0 + (ctxTime - m.ctx0) * m.rate;
  }

  private ctxAt(videoTime: number): number {
    const m = this.mapping!;
    return m.ctx0 + (videoTime - m.video0) / m.rate;
  }

  /** La tranche est décodée et son audio couvre encore l'instant `t`. */
  private playable(c: DubChunk, t: number): boolean {
    const b = this.buffers.get(c.url)?.buffer;
    return !!b && t >= c.start && t - c.start < b.duration - 0.05;
  }

  /** Arrête tout, puis programme la tranche à la position et la suivante. */
  private schedule() {
    this.stopSources();
    const m = (this.mapping = this.newMapping());
    const cur = chunkAt(this.manifest?.chunks ?? [], m.video0);
    if (cur && this.playable(cur, m.video0)) this.startSource(cur, m.ctx0, m.video0 - cur.start, true);
    this.queueNext();
    this.applyDuck();
    this.ensureLoads();
  }

  /** Programme, à la suite de la dernière source, la tranche suivante (si décodée). */
  private queueNext() {
    const g = this.graph;
    if (!g || !this.mapping || this.scheduled.length >= 2) return;
    const chunks = this.manifest?.chunks ?? [];
    const last = this.scheduled[this.scheduled.length - 1];
    const now = g.ctx.currentTime;
    const vNow = this.videoAt(now);
    const next = last ? nextChunk(chunks, last.chunk.start) : nextChunk(chunks, vNow);
    if (!next || this.scheduled.some((s) => s.chunk.url === next.url)) return;
    if (!this.buffers.get(next.url)?.buffer || next.start - vNow > QUEUE_HORIZON) return;
    const when = this.ctxAt(next.start);
    if (when < now + 0.01) return; // trop tard : la prochaine synchro reprogrammera
    let contiguous = false;
    if (last) {
      const lastEnd = this.audioEnd(last);
      contiguous = next.start <= lastEnd + 0.05;
      if (next.start < lastEnd) {
        // La source précédente s'arrête pile où la suivante commence.
        last.source.stop(when);
        last.stopAt = next.start;
      }
    }
    this.startSource(next, when, 0, !contiguous);
    this.applyDuck();
  }

  private audioEnd(s: Scheduled): number {
    return s.chunk.start + (s.source.buffer?.duration ?? 0);
  }

  private startSource(chunk: DubChunk, when: number, offset: number, fadeIn: boolean) {
    const g = this.graph!;
    const entry = this.buffers.get(chunk.url)!;
    entry.used = ++this.useClock;
    const source = g.ctx.createBufferSource();
    source.buffer = entry.buffer;
    source.playbackRate.value = this.mapping!.rate;
    const fade = g.ctx.createGain();
    source.connect(fade);
    fade.connect(this.dubGain!);
    if (fadeIn) {
      fade.gain.setValueAtTime(0, when);
      fade.gain.linearRampToValueAtTime(1, when + FADE);
    } else fade.gain.value = 1;
    source.start(when, offset);
    const s: Scheduled = { chunk, source, fade, when, offset, stopAt: null };
    source.onended = () => {
      source.onended = null;
      disconnect(source);
      disconnect(fade);
      const i = this.scheduled.indexOf(s);
      if (i < 0) return;
      // Fin naturelle (ou passage à la tranche suivante) : on enchaîne.
      this.scheduled.splice(i, 1);
      this.sync();
    };
    this.scheduled.push(s);
  }

  /** Coupe les sources programmées (fondu court), sans toucher à la VO. */
  private stopSources() {
    if (!this.scheduled.length) return;
    const now = this.graph?.ctx.currentTime ?? 0;
    for (const s of this.scheduled) {
      s.source.onended = () => {
        s.source.onended = null;
        disconnect(s.source);
        disconnect(s.fade);
      };
      try {
        if (s.when > now) s.source.stop();
        else {
          s.fade.gain.cancelScheduledValues(now);
          s.fade.gain.setValueAtTime(1, now);
          s.fade.gain.linearRampToValueAtTime(0, now + FADE);
          s.source.stop(now + FADE);
        }
      } catch {
        /* source déjà arrêtée */
      }
    }
    this.scheduled = [];
  }

  /** Arrête la VF : sources coupées, VO remontée à plein. */
  private stopAll() {
    this.resetDuck();
    this.stopSources();
    this.mapping = null;
  }

  // --- baisse de la VO pendant la parole française

  /** Pose l'automatisation du gain de la VO d'après les sources programmées. */
  private applyDuck() {
    const g = this.graph;
    if (!g || !this.mapping) return;
    const intervals: Interval[] = [];
    for (const s of this.scheduled) {
      // Bornes : l'audio réellement disponible (et la coupure si la suivante enchaîne).
      const to = Math.min(this.audioEnd(s), s.stopAt ?? Infinity);
      for (const [a, b] of s.chunk.speech) {
        const lo = Math.max(a, s.chunk.start);
        const hi = Math.min(b, to);
        if (hi > lo) intervals.push([lo, hi]);
      }
    }
    this.duckIntervals = mergeSpeech(intervals);
    if (!g.route) {
      this.fallbackDuck();
      return;
    }
    const param = g.route.gain.gain;
    const now = g.ctx.currentTime;
    const vNow = this.videoAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(duckGainAt(vNow, this.duckIntervals, this.duckLevel, DUCK_RAMP), now);
    for (const p of duckPoints(this.duckIntervals, this.duckLevel, DUCK_RAMP)) {
      if (p.t > vNow) param.linearRampToValueAtTime(p.gain, this.ctxAt(p.t));
    }
    this.duckDirty = this.duckIntervals.length > 0;
  }

  /** VO ramenée à plein (rampe courte), depuis sa valeur du moment. */
  private resetDuck(force = false) {
    const g = this.graph;
    const prev = this.duckIntervals;
    this.duckIntervals = [];
    if (!g) return;
    if (!g.route) {
      this.fallbackDuck();
      return;
    }
    if (!this.duckDirty && !force) return;
    this.duckDirty = false;
    const param = g.route.gain.gain;
    const now = g.ctx.currentTime;
    const current = this.mapping && prev.length ? duckGainAt(this.videoAt(now), prev, this.duckLevel, DUCK_RAMP) : param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
    param.linearRampToValueAtTime(1, now + DUCK_RAMP);
  }

  // --- téléchargement et décodage des tranches

  /** Charge la tranche à la position puis la suivante, une à la fois, dans l'ordre. */
  private ensureLoads() {
    if (!this.enabled || !this.graph || !this.manifest || this.destroyed) return;
    const chunks = this.manifest.chunks;
    const t = this.video.currentTime;
    const cur = chunkAt(chunks, t);
    const next = nextChunk(chunks, cur ? cur.start : t);
    const wanted: DubChunk[] = [];
    if (cur) wanted.push(cur);
    if (next && next.start - t <= QUEUE_HORIZON) wanted.push(next);
    for (const c of wanted) {
      const e = this.buffers.get(c.url);
      if (e?.buffer) continue;
      if (e?.pending) return;
      if (e && Date.now() < e.retryAt) continue;
      this.load(c);
      return;
    }
  }

  private load(c: DubChunk) {
    const g = this.graph!;
    const entry: BufferEntry = { url: c.url, buffer: null, pending: true, retryAt: 0, used: ++this.useClock };
    this.buffers.set(c.url, entry);
    if (!this.abort && typeof AbortController !== 'undefined') this.abort = new AbortController();
    this.fetchFn(c.url, { signal: this.abort?.signal })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => g.ctx.decodeAudioData(data))
      .then(
        (buffer) => {
          if (this.destroyed || this.buffers.get(c.url) !== entry) return; // désactivé ou remplacé entre-temps
          entry.buffer = buffer;
          entry.pending = false;
          this.evict();
          this.sync();
          this.publish();
        },
        () => {
          if (this.destroyed || this.buffers.get(c.url) !== entry) return;
          // Tranche illisible ou absente : VO à cet endroit, nouvel essai plus tard.
          entry.pending = false;
          entry.retryAt = Date.now() + RETRY_MS;
          this.ensureLoads();
        },
      );
  }

  /** Garde au plus MAX_DECODED tranches décodées (jamais celle qui joue ni la suivante). */
  private evict() {
    const chunks = this.manifest?.chunks ?? [];
    const t = this.video.currentTime;
    const keep = new Set(this.scheduled.map((s) => s.chunk.url));
    const cur = chunkAt(chunks, t);
    const next = nextChunk(chunks, cur ? cur.start : t);
    if (cur) keep.add(cur.url);
    if (next) keep.add(next.url);
    const decoded = [...this.buffers.values()].filter((e) => e.buffer);
    let count = decoded.length;
    for (const e of decoded.sort((a, b) => a.used - b.used)) {
      if (count <= MAX_DECODED) break;
      if (keep.has(e.url)) continue;
      this.buffers.delete(e.url);
      count--;
    }
  }

  // --- manifeste

  private setManifest(m: DubManifest) {
    this.manifest = m;
    // Tranches disparues ou régénérées (nouvelle URL ?v=) : on oublie l'ancienne version.
    const urls = new Set(m.chunks.map((c) => c.url));
    for (const url of [...this.buffers.keys()]) {
      if (!urls.has(url) && !this.scheduled.some((s) => s.chunk.url === url)) this.buffers.delete(url);
    }
    this.sync();
    this.publish();
  }

  private planRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.destroyed) return;
    // VF doublée non choisie et statut définitif : plus rien à guetter.
    const settled = this.manifest && ['ready', 'disabled', 'failed'].includes(this.manifest.status);
    if (!this.enabled && settled) return;
    this.refreshTimer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) this.planRefresh();
      else void this.refresh();
    }, this.enabled ? REFRESH_MS : IDLE_REFRESH_MS);
  }

  // --- état publié

  private publish() {
    const m = this.manifest;
    const t = this.video.currentTime;
    const status = m?.status ?? null;
    const available = isDubAvailable(status);
    const rate = this.video.playbackRate;
    const covered = !!m && !!chunkAt(m.chunks, t) && isNormalRate(rate);
    const next: DubState = {
      status,
      available,
      enabled: this.enabled,
      hint: available ? dubHint(m, t, rate) : null,
      active: this.enabled && available && covered,
    };
    const p = this.state;
    if (p.status === next.status && p.available === next.available && p.enabled === next.enabled && p.hint === next.hint && p.active === next.active) return;
    this.state = next;
    for (const cb of this.listeners) cb();
  }
}
