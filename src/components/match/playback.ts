'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';

export interface Subtitle {
  seq: number;
  video_ts: number;
  end_ts: number | null;
  text: string;
  speaker: string;
  kind: string;
  /** Mise en relief (VF des commentaires) : 0 ton normal, 1 voix qui monte, 2 moment fort. */
  emphasis?: number;
}

export interface CueState {
  /** Dernière ligne commencée (sert au transcript), -1 avant la première. */
  index: number;
  /** La ligne est-elle encore à l'écran (sert à la surimpression) ? */
  visible: boolean;
}

/** Événement fenêtre « aller à l'action n° seq » (play-by-play → lecteur). */
export const SEEK_EVENT = 'bl:seek-seq';

type TickListener = (t: number, video: HTMLVideoElement) => void;

const NO_CUE: CueState = { index: -1, visible: false };

/**
 * Horloge de lecture partagée, HORS de l'état React.
 *
 * La position de lecture change 60 fois par seconde : la faire remonter dans
 * un state (comme avant via onTimeUpdate) re-rendait toute la fiche ~4 fois
 * par seconde, et ce travail sur le thread principal pouvait retarder
 * l'ajout des segments au MediaSource (micro-coupures).
 *
 * Ici, une boucle requestAnimationFrame (active seulement pendant la lecture)
 * lit `video.currentTime` et :
 * - notifie les « tick listeners » (barre de progression, chrono) qui
 *   écrivent directement dans le DOM, sans rendu React ;
 * - ne publie un nouvel état React (`CueState`) que lorsque la ligne de VF
 *   change, c'est-à-dire quelques fois par minute.
 * La position courante se lit à la demande (`currentTime`), au clic.
 */
export class Playback {
  private video: HTMLVideoElement | null = null;
  private subs: Subtitle[] = [];
  private cue: CueState = NO_CUE;
  private cueListeners = new Set<() => void>();
  private screen: number[] = NO_LINES;
  private screenListeners = new Set<() => void>();
  private tickListeners = new Set<TickListener>();
  private raf = 0;
  private lastT = -1;
  /** Retard d'affichage de la VF (s) : positif = le texte apparaît plus tard (réglage « Synchro VF »). */
  private subDelay = DEFAULT_SUB_DELAY;

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  get currentTime(): number {
    return this.video?.currentTime ?? 0;
  }

  /** Secondes déjà chargées devant la position de lecture. */
  bufferedAhead(): number {
    const v = this.video;
    if (!v) return 0;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (t >= v.buffered.start(i) - 0.5 && t <= v.buffered.end(i)) return v.buffered.end(i) - t;
    }
    return 0;
  }

  /** Branche l'élément vidéo ; renvoie la fonction de débranchement. */
  attach(video: HTMLVideoElement): () => void {
    this.video = video;
    const onPlay = () => this.loop();
    const onSettle = () => this.tick(true);
    video.addEventListener('playing', onPlay);
    video.addEventListener('play', onPlay);
    video.addEventListener('seeked', onSettle);
    video.addEventListener('seeking', onSettle);
    video.addEventListener('pause', onSettle);
    video.addEventListener('loadedmetadata', onSettle);
    video.addEventListener('durationchange', onSettle);
    // Filet de sécurité (onglet en arrière-plan : rAF suspendu).
    video.addEventListener('timeupdate', onSettle);
    this.tick(true);
    return () => {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      video.removeEventListener('playing', onPlay);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('seeked', onSettle);
      video.removeEventListener('seeking', onSettle);
      video.removeEventListener('pause', onSettle);
      video.removeEventListener('loadedmetadata', onSettle);
      video.removeEventListener('durationchange', onSettle);
      video.removeEventListener('timeupdate', onSettle);
      if (this.video === video) this.video = null;
    };
  }

  setSubtitles(subs: Subtitle[]) {
    this.subs = subs;
    this.tick(true);
  }

  /** Règle le retard d'affichage de la VF (s), appliqué tout de suite. */
  setSubtitleDelay(sec: number) {
    this.subDelay = Number.isFinite(sec) ? sec : 0;
    this.tick(true);
  }

  seek(t: number, play = false) {
    const v = this.video;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.max(0, Math.min(t, d - 0.5));
    if (play && v.paused) void v.play().catch(() => undefined);
    this.tick(true);
  }

  // --- état React : ligne de VF courante
  subscribeCue = (cb: () => void) => {
    this.cueListeners.add(cb);
    return () => this.cueListeners.delete(cb);
  };
  getCue = (): CueState => this.cue;
  getServerCue = (): CueState => NO_CUE;

  // --- état React : lignes affichées en surimpression (roll-up)
  subscribeScreen = (cb: () => void) => {
    this.screenListeners.add(cb);
    return () => this.screenListeners.delete(cb);
  };
  getScreen = (): number[] => this.screen;
  getServerScreen = (): number[] => NO_LINES;

  // --- abonnements hors React (écriture DOM directe)
  onTick(cb: TickListener): () => void {
    this.tickListeners.add(cb);
    if (this.video) cb(this.video.currentTime, this.video);
    return () => this.tickListeners.delete(cb);
  }

  private loop = () => {
    if (this.raf) return;
    const step = () => {
      const v = this.video;
      if (!v || v.paused || v.ended) {
        this.raf = 0;
        this.tick(true);
        return;
      }
      this.tick(false);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  private tick(force: boolean) {
    const v = this.video;
    if (!v) return;
    const t = v.currentTime;
    if (!force && t === this.lastT) return;
    this.lastT = t;
    for (const cb of this.tickListeners) cb(t, v);
    // La VF est lue à « t − retard » : avec un retard positif, chaque ligne apparaît plus tard.
    const st = t - this.subDelay;
    const next = findCue(this.subs, st);
    if (next.index !== this.cue.index || next.visible !== this.cue.visible) {
      this.cue = next;
      for (const cb of this.cueListeners) cb();
    }
    const lines = findOnScreen(this.subs, st);
    if (lines.length !== this.screen.length || lines.some((x, i) => x !== this.screen[i])) {
      this.screen = lines.length ? lines : NO_LINES;
      for (const cb of this.screenListeners) cb();
    }
  }
}

const NO_LINES: number[] = [];

/**
 * Retard par défaut de la VF (s). Les horodatages de Whisper placent le
 * début d'une ligne un peu avant la voix ; un léger retard recale le texte.
 * Réglable dans le lecteur (menu ⚙, « Synchro de la VF »).
 */
export const DEFAULT_SUB_DELAY = 0.5;

/** Lignes empilées au maximum en surimpression. */
export const MAX_ON_SCREEN = 2;

/**
 * Durée d'affichage d'une ligne en surimpression : le temps de la LIRE.
 *
 * Les durées issues du play-by-play descendent sous la seconde, et deux
 * actions peuvent tomber au même instant (panier + lancer franc) : la
 * première était alors remplacée avant d'avoir pu être lue. On garantit
 * ~2,5 s minimum, plus selon la longueur du texte (vitesse de lecture
 * confortable ≈ 15-18 caractères par seconde), plafonné à 7 s.
 */
export function readDuration(s: Subtitle): number {
  const reading = Math.min(7, Math.max(2.5, 1.2 + s.text.length * 0.06));
  const given = s.end_ts !== null ? s.end_ts - s.video_ts : 0;
  return Math.max(reading, Math.min(given, 7));
}

/**
 * Temps minimal pour LIRE une ligne (≈ 15 caractères par seconde, 1,5 s au
 * moins). Une ligne remplacée avant ce délai reste visible, en retrait.
 */
export function minReadTime(s: Subtitle): number {
  return Math.max(1.5, s.text.length / 15);
}

/** Durée maximale pendant laquelle une ligne remplacée reste en retrait (s). */
const LINGER_MAX = 2;

/**
 * Lignes à afficher à l'instant `t` (indices croissants, au plus
 * MAX_ON_SCREEN). La dernière ligne commencée reste à l'écran pendant sa
 * durée de lecture. La précédente ne reste (en retrait, au-dessus) que si
 * elle a été remplacée avant d'avoir pu être lue — les commentateurs
 * enchaînent vite — et jamais plus de 2 s après l'arrivée de la nouvelle.
 */
export function findOnScreen(subs: Subtitle[], t: number): number[] {
  const last = findCue(subs, t).index;
  if (last < 0) return NO_LINES;
  const cur = subs[last];
  if (t > cur.video_ts + readDuration(cur)) return NO_LINES;
  const prev = last > 0 ? subs[last - 1] : undefined;
  if (prev && MAX_ON_SCREEN > 1 && t < Math.min(prev.video_ts + minReadTime(prev), cur.video_ts + LINGER_MAX)) return [last - 1, last];
  return [last];
}

/** Recherche dichotomique de la dernière ligne commencée à l'instant `t`. */
export function findCue(subs: Subtitle[], t: number): CueState {
  let lo = 0;
  let hi = subs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (subs[mid].video_ts <= t + 0.05) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return NO_CUE;
  const s = subs[idx];
  const end = s.end_ts ?? s.video_ts + 4;
  return { index: idx, visible: t <= end + 0.5 };
}

export const PlaybackContext = createContext<Playback | null>(null);

export function usePlayback(): Playback {
  const p = useContext(PlaybackContext);
  if (!p) throw new Error('PlaybackContext manquant');
  return p;
}

/** Lignes affichées en surimpression : ne re-rend qu'à leur changement. */
export function useScreenLines(): number[] {
  const p = usePlayback();
  return useSyncExternalStore(p.subscribeScreen, p.getScreen, p.getServerScreen);
}

/** Ligne de VF courante : ne re-rend qu'au changement de ligne. */
export function useCue(): CueState {
  const p = usePlayback();
  return useSyncExternalStore(p.subscribeCue, p.getCue, p.getServerCue);
}
