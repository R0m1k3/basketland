'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';

export interface Subtitle {
  seq: number;
  video_ts: number;
  end_ts: number | null;
  text: string;
  speaker: string;
  kind: string;
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
  private tickListeners = new Set<TickListener>();
  private raf = 0;
  private lastT = -1;

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  get currentTime(): number {
    return this.video?.currentTime ?? 0;
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
    const next = findCue(this.subs, t);
    if (next.index !== this.cue.index || next.visible !== this.cue.visible) {
      this.cue = next;
      for (const cb of this.cueListeners) cb();
    }
  }
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

/** Ligne de VF courante : ne re-rend qu'au changement de ligne. */
export function useCue(): CueState {
  const p = usePlayback();
  return useSyncExternalStore(p.subscribeCue, p.getCue, p.getServerCue);
}
