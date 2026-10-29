'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import type { ErrorData, HlsConfig } from 'hls.js';
import TeamLogo from '@/components/ui/TeamLogo';
import { usePlayback, useScreenLines, type Subtitle } from '@/components/match/playback';
import { stripScores, useNoSpoil } from '@/components/match/spoiler';
import { fmtTime } from '@/components/match/format';
import { teamInfo } from '@/lib/teams';

export type { Subtitle };

export interface Marker {
  t: number;
  label: string;
}

interface Props {
  kind: 'hls' | 'mp4' | null;
  src: string | null;
  subtitles: Subtitle[];
  /** Repères affichés sur la barre de progression (début de chaque quart). */
  markers?: Marker[];
  awayAbbr: string;
  homeAbbr: string;
  durationHint?: number | null;
}

type SubSize = 'S' | 'M' | 'L' | 'XL';
type Quality = 'auto' | number;
interface LevelOption {
  height: number;
  label: string;
}

const SUB_SCALE: Record<SubSize, number> = { S: 0.8, M: 1, L: 1.22, XL: 1.5 };
const SPEEDS = [1, 1.25, 1.5, 2];

/**
 * Réglages hls.js pour un VOD servi par notre proxy (et non un direct) :
 * - tampon généreux (60 s visés, jusqu'à 120 s / 120 Mo) pour absorber les
 *   à-coups du proxy, et 60 s conservés en arrière pour les retours rapides ;
 * - démarrage anticipé du premier segment (`startFragPrefetch`) ;
 * - ABR stable : estimation initiale élevée (5 Mb/s), montée en qualité
 *   prudente (`abrBandWidthUpFactor` 0,6) et moyennes lentes, pour éviter
 *   les changements de niveau intempestifs qui coupent le son ;
 * - qualité plafonnée à la taille du lecteur (inutile de charger du 1080p
 *   dans une vignette de 390 px) ;
 * - nouvelles tentatives avec backoff exponentiel sur segments et playlists.
 */
const HLS_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  lowLatencyMode: false,
  autoStartLoad: false,
  startFragPrefetch: true,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxBufferSize: 120 * 1000 * 1000,
  backBufferLength: 60,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 8,
  abrEwmaDefaultEstimate: 5_000_000,
  abrBandWidthFactor: 0.9,
  abrBandWidthUpFactor: 0.6,
  abrEwmaFastVoD: 4,
  abrEwmaSlowVoD: 15,
  capLevelToPlayerSize: true,
  testBandwidth: false,
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 60_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4_000, backoff: 'exponential' },
      errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000, backoff: 'exponential' },
    },
  },
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2_000 },
      errorRetry: { maxNumRetry: 2, retryDelayMs: 1_500, maxRetryDelayMs: 6_000, backoff: 'exponential' },
    },
  },
  playlistLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2_000 },
      errorRetry: { maxNumRetry: 3, retryDelayMs: 1_000, maxRetryDelayMs: 6_000, backoff: 'exponential' },
    },
  },
};

// --- préférences locales (try/catch : stockage parfois indisponible)
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* sans stockage, le réglage vaut pour la session */
  }
}

/** Index du niveau le plus proche (par le bas) d'une hauteur donnée. */
function levelForHeight(levels: { height: number }[], height: number): number {
  let best = -1;
  levels.forEach((l, i) => {
    if (l.height <= height && (best < 0 || l.height > levels[best].height)) best = i;
  });
  if (best < 0 && levels.length) {
    best = levels.reduce((acc, l, i) => (l.height < levels[acc].height ? i : acc), 0);
  }
  return best;
}

function errorMessage(data: ErrorData): string {
  const code = (data.response as { code?: number } | undefined)?.code;
  if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut') {
    if (code === 403) return 'La source vidéo refuse la connexion (403). Le lien a peut-être expiré : réessayez dans un instant.';
    if (code === 404) return 'Replay introuvable chez la source (404).';
    return `La source vidéo ne répond pas${code ? ` (erreur ${code})` : ''}.`;
  }
  if (data.type === 'networkError') return 'Connexion au flux perdue. Vérifiez votre réseau puis réessayez.';
  if (data.type === 'mediaError') return 'Le navigateur n’arrive pas à décoder ce flux.';
  return 'Erreur de lecture du flux.';
}

/**
 * Lecteur « mode cinéma » : HLS (hls.js, ou natif sans MSE) ou MP4
 * progressif, contrôles maison, sous-titres français superposés.
 *
 * Les contrôles maison sont nécessaires : le plein écran natif de <video>
 * masquerait la VF superposée. Ici le plein écran porte sur le conteneur.
 *
 * Aucune donnée temporelle ne passe par l'état React de ce composant : la
 * barre de progression et le chrono s'abonnent à l'horloge `Playback`.
 */
export default function VideoPlayer({ kind, src, subtitles, markers = [], awayAbbr, homeAbbr, durationHint }: Props) {
  const playback = usePlayback();
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const wantLoadRef = useRef(false);
  const startLoadRef = useRef<() => void>(() => undefined);

  const [reloadKey, setReloadKey] = useState(0);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<LevelOption[]>([]);
  const [quality, setQuality] = useState<Quality>('auto');
  const [activeHeight, setActiveHeight] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [vfOn, setVfOn] = useState(true);
  const [subSize, setSubSize] = useState<SubSize>('M');
  const [resumeAt, setResumeAt] = useState<number | null>(null);

  const posKey = src ? `bl:pos:${src}` : null;

  // Préférences mémorisées.
  useEffect(() => {
    const s = readPref('bl:subsize');
    if (s === 'S' || s === 'M' || s === 'L' || s === 'XL') setSubSize(s);
    if (readPref('bl:vf') === '0') setVfOn(false);
    const q = readPref('bl:quality');
    if (q && q !== 'auto' && Number.isFinite(Number(q))) setQuality(Number(q));
    if (posKey) {
      const p = Number(readPref(posKey));
      if (Number.isFinite(p) && p > 30) setResumeAt(p);
    }
  }, [posKey]);

  // Branche l'horloge partagée sur l'élément vidéo.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    return playback.attach(v);
  }, [playback]);

  useEffect(() => {
    playback.setSubtitles(subtitles);
  }, [playback, subtitles]);

  /**
   * Chargement du flux. Dépendances : la source (et le bouton « Réessayer »)
   * UNIQUEMENT — un re-rendu ne doit jamais détruire l'instance hls.js.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !kind) return;
    let disposed = false;
    setError(null);
    setLevels([]);

    if (kind === 'mp4') {
      video.preload = 'metadata';
      video.src = src;
      startLoadRef.current = () => undefined;
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }

    let netRetries = 0;
    let mediaRecoveries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      const { default: Hls } = await import('hls.js');
      if (disposed) return;
      if (!Hls.isSupported()) {
        // iOS ancien : HLS natif.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.preload = 'metadata';
          video.src = src;
        } else setError('Ce navigateur ne sait pas lire ce flux vidéo.');
        return;
      }
      const hls = new Hls(HLS_CONFIG);
      hlsRef.current = hls;
      let loading = false;
      startLoadRef.current = () => {
        if (loading || !hls.levels.length) return;
        loading = true;
        hls.startLoad(-1);
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const opts = [...new Set(hls.levels.map((l) => l.height).filter((h) => h > 0))]
          .sort((a, b) => b - a)
          .map((h) => ({ height: h, label: `${h}p` }));
        setLevels(opts);
        const pref = readPref('bl:quality');
        const manual = pref && pref !== 'auto' ? levelForHeight(hls.levels, Number(pref)) : -1;
        if (manual >= 0) {
          hls.startLevel = manual;
          hls.currentLevel = manual;
        } else {
          // Départ vers 720p : net d'emblée sans trop attendre le 1er segment.
          hls.startLevel = levelForHeight(hls.levels, 720);
        }
        if (wantLoadRef.current) startLoadRef.current();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
        setActiveHeight(hls.levels[d.level]?.height ?? null);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        netRetries = 0;
        mediaRecoveries = 0;
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        const manifest = data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut' || data.details === 'manifestParsingError';
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !manifest && netRetries < 5) {
          // Coupure réseau / proxy : on relance le chargement avec backoff.
          const delay = Math.min(8000, 1000 * 2 ** netRetries++);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => !disposed && hls.startLoad(), delay);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          // 1re fois : récupération simple ; 2e : bascule du codec audio.
          if (mediaRecoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }
        setError(errorMessage(data));
        hls.destroy();
        hlsRef.current = null;
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    })().catch((e: unknown) => {
      if (!disposed) setError(`Chargement du lecteur impossible : ${(e as Error).message}`);
    });

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      startLoadRef.current = () => undefined;
    };
  }, [src, kind, reloadKey]);

  /** Intention de lecture (survol, focus, clic) : on commence à charger. */
  const warmUp = useCallback(() => {
    wantLoadRef.current = true;
    startLoadRef.current();
  }, []);

  // Événements de l'élément vidéo + surveillance des blocages de tampon.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSave = 0;

    const clearStall = () => clearTimeout(stallTimer);
    const onWaiting = () => {
      setWaiting(true);
      clearStall();
      // Relance si l'attente se prolonge : saut d'un trou de tampon, puis
      // relance du chargement.
      stallTimer = setTimeout(() => {
        if (v.paused || v.readyState >= 3) return;
        const t = v.currentTime;
        for (let i = 0; i < v.buffered.length; i++) {
          const start = v.buffered.start(i);
          if (start > t && start - t < 2) {
            v.currentTime = start + 0.05;
            return;
          }
        }
        hlsRef.current?.startLoad(t);
      }, 4000);
    };
    const onPlaying = () => {
      clearStall();
      setWaiting(false);
      setStarted(true);
      setEnded(false);
      setError(null);
    };
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onEnded = () => setEnded(true);
    const onVolume = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };
    const onError = () => {
      const code = v.error?.code;
      if (!code) return;
      setError(code === 4 ? 'Format vidéo non pris en charge ou source indisponible.' : 'Erreur de lecture du flux.');
    };
    const onTimeUpdate = () => {
      // Mémorise la position (reprise à la prochaine visite), au plus toutes les 10 s.
      if (!posKey) return;
      const now = Date.now();
      if (now - lastSave < 10_000) return;
      lastSave = now;
      const d = v.duration;
      if (v.currentTime > 30 && (!Number.isFinite(d) || v.currentTime < d - 60)) writePref(posKey, String(Math.floor(v.currentTime)));
      else if (Number.isFinite(d) && v.currentTime >= d - 60) writePref(posKey, null);
    };
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', clearStall);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('volumechange', onVolume);
    v.addEventListener('error', onError);
    v.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      clearStall();
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', clearStall);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('volumechange', onVolume);
      v.removeEventListener('error', onError);
      v.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [posKey]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // --- actions
  const play = useCallback(
    (from?: number) => {
      const v = videoRef.current;
      if (!v) return;
      warmUp();
      setStarted(true);
      if (from !== undefined) playback.seek(from);
      void v.play().catch(() => undefined);
    },
    [playback, warmUp],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) play();
    else v.pause();
  }, [play]);

  const skip = useCallback(
    (delta: number) => {
      warmUp();
      playback.seek(playback.currentTime + delta);
    },
    [playback, warmUp],
  );

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (shell.requestFullscreen) void shell.requestFullscreen().catch(() => undefined);
    else v?.webkitEnterFullscreen?.(); // iOS : plein écran natif (sans VF superposée)
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  const toggleVf = useCallback(() => {
    setVfOn((on) => {
      writePref('bl:vf', on ? '0' : '1');
      return !on;
    });
  }, []);

  const chooseQuality = useCallback((q: Quality) => {
    setQuality(q);
    writePref('bl:quality', String(q));
    const hls = hlsRef.current;
    if (!hls) return;
    // `nextLevel` bascule au prochain segment : pas de vidage brutal du tampon.
    hls.nextLevel = q === 'auto' ? -1 : levelForHeight(hls.levels, q);
  }, []);

  const chooseSize = useCallback((s: SubSize) => {
    setSubSize(s);
    writePref('bl:subsize', s);
  }, []);

  const chooseSpeed = useCallback((s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }, []);

  // --- masquage automatique des contrôles pendant la lecture
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const poke = useCallback(() => {
    setControlsShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused) setControlsShown(false);
    }, 2800);
  }, []);
  useEffect(() => {
    if (paused) {
      clearTimeout(hideTimer.current);
      setControlsShown(true);
    } else poke();
  }, [paused, poke]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // --- raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const inPlayer = !!t && !!shellRef.current?.contains(t);
      // Raccourcis actifs seulement si le lecteur est visible (ou a le focus).
      const r = shellRef.current?.getBoundingClientRect();
      const visible = !!r && r.bottom > 0 && r.top < window.innerHeight;
      if (!inPlayer && !visible && !document.fullscreenElement) return;
      const onControl = !!t && /^(BUTTON|A)$/.test(t.tagName);
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          if (onControl && e.key === ' ') return; // laisse le bouton s'activer
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          if (t?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          skip(-10);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          if (t?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          skip(10);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'c':
        case 'C':
          toggleVf();
          break;
        case 'Escape':
          if (inPlayer) setMenuOpen(false);
          return;
        default:
          return;
      }
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip, toggleFullscreen, toggleMute, toggleVf, poke]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const retry = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const showControls = controlsShown || paused || menuOpen;
  const qualityLabel =
    quality === 'auto' ? `Auto${activeHeight ? ` · ${activeHeight}p` : ''}` : `${quality}p`;

  return (
    <div
      ref={shellRef}
      className={`player group/player relative isolate aspect-video w-full overflow-hidden bg-black sm:rounded-2xl ${
        fullscreen ? '' : 'shadow-card ring-1 ring-ink-700/80'
      } ${showControls ? '' : 'cursor-none'}`}
      style={{ '--sub-scale': SUB_SCALE[subSize] } as React.CSSProperties}
      onPointerMove={poke}
      onPointerEnter={warmUp}
      onFocusCapture={warmUp}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full"
        playsInline
        preload="none"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        aria-label="Replay du match"
      />

      {vfOn && started && <SubtitleOverlay subs={subtitles} lifted={showControls} />}

      {/* Affiche avant la première lecture */}
      {!started && !error && (
        <Poster
          awayAbbr={awayAbbr}
          homeAbbr={homeAbbr}
          duration={durationHint ?? null}
          cues={subtitles.length}
          resumeAt={resumeAt}
          lowQuality={kind === 'mp4'}
          onPlay={play}
        />
      )}

      {started && waiting && !error && !paused && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
          <span className="h-14 w-14 animate-spin rounded-full border-[3px] border-white/15 border-t-flame" />
        </div>
      )}

      {started && paused && !waiting && !error && !ended && (
        <button
          type="button"
          onClick={() => play()}
          className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:scale-105 hover:bg-flame focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
          aria-label="Reprendre la lecture"
        >
          <Icon name="play" size={28} />
        </button>
      )}

      {ended && !error && (
        <div className="absolute inset-0 grid place-items-center bg-black/60 text-center">
          <div>
            <p className="font-display text-2xl font-bold uppercase tracking-wide">Fin du replay</p>
            <button type="button" className="btn-primary mt-4" onClick={() => play(0)}>
              <Icon name="replay" size={16} /> Revoir depuis le début
            </button>
          </div>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={retry} />}

      {/* Barre de contrôles */}
      {started && (
        <div
          className={`player-controls absolute inset-x-0 bottom-0 z-10 px-3 pb-2 pt-10 transition-opacity duration-300 sm:px-4 sm:pb-3 ${
            showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <Scrubber markers={markers} onSeekStart={warmUp} />
          <div className="mt-1.5 flex items-center gap-0.5 sm:gap-1.5">
            <CtrlButton label={paused ? 'Lecture (espace)' : 'Pause (espace)'} onClick={togglePlay}>
              <Icon name={paused ? 'play' : 'pause'} size={22} />
            </CtrlButton>
            <CtrlButton label="Reculer de 10 s (←)" onClick={() => skip(-10)}>
              <Icon name="back10" size={22} />
            </CtrlButton>
            <CtrlButton label="Avancer de 10 s (→)" onClick={() => skip(10)}>
              <Icon name="fwd10" size={22} />
            </CtrlButton>
            <div className="group/vol flex items-center">
              <CtrlButton label={muted ? 'Activer le son (M)' : 'Couper le son (M)'} onClick={toggleMute}>
                <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={20} />
              </CtrlButton>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = videoRef.current;
                  if (!v) return;
                  v.volume = Number(e.target.value);
                  v.muted = v.volume === 0;
                }}
                className="player-volume hidden w-0 opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 focus-visible:w-20 focus-visible:opacity-100 sm:block"
                aria-label="Volume"
              />
            </div>
            <TimeText />
            <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
              <CtrlButton label={vfOn ? 'Masquer la VF (C)' : 'Afficher la VF (C)'} onClick={toggleVf} pressed={vfOn}>
                <span
                  className={`rounded-[5px] border-2 px-1 font-display text-[13px] font-bold leading-[14px] ${
                    vfOn ? 'border-flame bg-flame text-ink-950' : 'border-current'
                  }`}
                >
                  VF
                </span>
              </CtrlButton>
              <div data-menu-toggle>
                <CtrlButton label="Réglages" onClick={() => setMenuOpen((o) => !o)} pressed={menuOpen}>
                  <Icon name="gear" size={20} />
                </CtrlButton>
              </div>
              <CtrlButton label={fullscreen ? 'Quitter le plein écran (F)' : 'Plein écran (F)'} onClick={toggleFullscreen}>
                <Icon name={fullscreen ? 'shrink' : 'expand'} size={20} />
              </CtrlButton>
            </div>
          </div>
        </div>
      )}

      {menuOpen && started && (
        <SettingsMenu
          levels={levels}
          quality={quality}
          qualityLabel={qualityLabel}
          onQuality={chooseQuality}
          subSize={subSize}
          onSubSize={chooseSize}
          speed={speed}
          onSpeed={chooseSpeed}
          onClose={closeMenu}
        />
      )}

      {kind === 'mp4' && started && (
        <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-warn backdrop-blur">
          Qualité réduite — la HD arrive
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sous-composants

/**
 * VF écrite sur l'image, en « roll-up » : la nouvelle ligne arrive par le
 * bas, la précédente remonte et s'estompe au lieu de disparaître d'un coup.
 * Seul composant re-rendu au changement de ligne.
 */
const SubtitleOverlay = memo(function SubtitleOverlay({ subs, lifted }: { subs: Subtitle[]; lifted: boolean }) {
  const lines = useScreenLines();
  const noSpoil = useNoSpoil();
  if (!lines.length) return null;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-[5] flex flex-col items-center gap-1.5 px-[4%] transition-[bottom] duration-300 ${
        lifted ? 'bottom-[88px] sm:bottom-[100px]' : 'bottom-[6%]'
      }`}
      aria-live="polite"
    >
      {lines.map((i, pos) => {
        const s = subs[i];
        if (!s) return null;
        const text = noSpoil ? stripScores(s.text) : s.text;
        const banner = s.kind === 'score' || s.kind === 'banniere';
        const accent = s.speaker ? teamInfo(s.speaker).accent : null;
        const older = pos < lines.length - 1;
        return (
          <div
            key={s.seq}
            className={`subtitle-box subtitle-roll ${older ? 'subtitle-older' : ''} ${banner ? 'subtitle-banner' : ''}`}
          >
            {accent && !banner && <span className="subtitle-team" style={{ background: accent }} aria-hidden="true" />}
            <span className="subtitle-overlay subtitle-text">{text}</span>
          </div>
        );
      })}
    </div>
  );
});

/** Chrono « 12:34 / 2:15:07 », écrit directement dans le DOM. */
function TimeText() {
  const playback = usePlayback();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let last = '';
    return playback.onTick((t, v) => {
      const txt = `${fmtTime(t)} / ${fmtTime(v.duration)}`;
      if (txt !== last && ref.current) {
        ref.current.textContent = txt;
        last = txt;
      }
    });
  }, [playback]);
  return <span ref={ref} className="num ml-1 whitespace-nowrap text-[15px] text-white/85 sm:text-base" aria-hidden="true" />;
}

/** Barre de progression : tampon, repères de quart, aperçu au survol, glisser. */
const Scrubber = memo(function Scrubber({ markers, onSeekStart }: { markers: Marker[]; onSeekStart: () => void }) {
  const playback = usePlayback();
  const trackRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);

  const paint = useCallback((frac: number) => {
    const f = Math.max(0, Math.min(1, frac));
    if (playedRef.current) playedRef.current.style.transform = `scaleX(${f})`;
    if (thumbRef.current) thumbRef.current.style.left = `${f * 100}%`;
  }, []);

  useEffect(() => {
    let lastValue = -1;
    const off = playback.onTick((t, v) => {
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) {
        if (!dragging.current) paint(t / d);
        if (Math.abs(durationRef.current - d) > 1) {
          durationRef.current = d;
          setDuration(d);
        }
        const sec = Math.floor(t);
        if (sec !== lastValue && trackRef.current) {
          lastValue = sec;
          trackRef.current.setAttribute('aria-valuenow', String(sec));
          trackRef.current.setAttribute('aria-valuetext', fmtTime(t));
        }
      }
    });
    const v = playback.element;
    const onProgress = () => {
      if (!v || !bufferRef.current || !Number.isFinite(v.duration)) return;
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
      }
      bufferRef.current.style.transform = `scaleX(${Math.min(1, end / v.duration)})`;
    };
    v?.addEventListener('progress', onProgress);
    v?.addEventListener('seeked', onProgress);
    return () => {
      off();
      v?.removeEventListener('progress', onProgress);
      v?.removeEventListener('seeked', onProgress);
    };
  }, [playback, paint]);

  const fracAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    onSeekStart();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    paint(fracAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = fracAt(e.clientX);
    if (hoverRef.current && duration) {
      hoverRef.current.style.left = `${f * 100}%`;
      hoverRef.current.textContent = fmtTime(f * duration);
    }
    if (dragging.current) paint(f);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    playback.seek(fracAt(e.clientX) * duration);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') playback.seek(playback.currentTime - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') playback.seek(playback.currentTime + step);
    else if (e.key === 'Home') playback.seek(0);
    else if (e.key === 'End') playback.seek(duration);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Position dans le replay"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      className="scrubber group/scrub relative h-5 cursor-pointer touch-none select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/70"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (dragging.current = false)}
      onKeyDown={onKeyDown}
    >
      <div className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/scrub:h-[6px]">
        <div ref={bufferRef} className="absolute inset-0 origin-left scale-x-0 bg-white/30" />
        <div ref={playedRef} className="absolute inset-0 origin-left scale-x-0 bg-flame" />
      </div>
      {duration > 0 &&
        markers.map((m) => (
          <span
            key={m.label}
            className="pointer-events-none absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 rounded bg-white/70"
            style={{ left: `${(m.t / duration) * 100}%` }}
            title={m.label}
          >
            <span className="absolute -top-4 left-1/2 hidden -translate-x-1/2 font-display text-[10px] font-semibold uppercase tracking-wider text-white/70 group-hover/scrub:block">
              {m.label}
            </span>
          </span>
        ))}
      <div
        ref={thumbRef}
        className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-flame shadow-glow transition-transform group-hover/scrub:scale-100 group-focus-visible/scrub:scale-100"
      />
      <div
        ref={hoverRef}
        className="num pointer-events-none absolute -top-7 hidden -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white group-hover/scrub:block"
      />
    </div>
  );
});

function SettingsMenu({
  levels,
  quality,
  qualityLabel,
  onQuality,
  subSize,
  onSubSize,
  speed,
  onSpeed,
  onClose,
}: {
  levels: LevelOption[];
  quality: Quality;
  qualityLabel: string;
  onQuality: (q: Quality) => void;
  subSize: SubSize;
  onSubSize: (s: SubSize) => void;
  speed: number;
  onSpeed: (s: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!ref.current?.contains(target) && !target.closest?.('[data-menu-toggle]')) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Réglages du lecteur"
      className="absolute bottom-[58px] right-2 z-20 max-h-[calc(100%-66px)] w-[248px] max-w-[80vw] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-ink-900/95 p-3 text-sm shadow-card backdrop-blur-xl sm:bottom-[68px] sm:right-4 sm:max-h-[calc(100%-80px)]"
    >
      {levels.length > 0 && (
        <MenuGroup title="Qualité" hint={qualityLabel}>
          <Seg active={quality === 'auto'} onClick={() => onQuality('auto')}>
            Auto
          </Seg>
          {levels.map((l) => (
            <Seg key={l.height} active={quality === l.height} onClick={() => onQuality(l.height)}>
              {l.label}
              {l.height >= 720 && <sup className="ml-0.5 text-[8px] text-flame-hot">HD</sup>}
            </Seg>
          ))}
        </MenuGroup>
      )}
      <MenuGroup title="Taille de la VF">
        {(['S', 'M', 'L', 'XL'] as SubSize[]).map((s) => (
          <Seg key={s} active={subSize === s} onClick={() => onSubSize(s)}>
            {s}
          </Seg>
        ))}
      </MenuGroup>
      <MenuGroup title="Vitesse">
        {SPEEDS.map((s) => (
          <Seg key={s} active={speed === s} onClick={() => onSpeed(s)}>
            {s === 1 ? 'Normale' : `×${String(s).replace('.', ',')}`}
          </Seg>
        ))}
      </MenuGroup>
    </div>
  );
}

function MenuGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="kicker !text-[11px]">{title}</span>
        {hint && <span className="text-[11px] text-paper-faint">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
        active ? 'bg-flame text-ink-950' : 'bg-white/5 text-paper-dim hover:bg-white/10 hover:text-paper'
      }`}
    >
      {children}
    </button>
  );
}

function CtrlButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className="grid h-9 w-9 place-items-center rounded-full text-white/90 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/70 sm:h-10 sm:w-10"
    >
      {children}
    </button>
  );
}

function Poster({
  awayAbbr,
  homeAbbr,
  duration,
  cues,
  resumeAt,
  lowQuality,
  onPlay,
}: {
  awayAbbr: string;
  homeAbbr: string;
  duration: number | null;
  cues: number;
  resumeAt: number | null;
  lowQuality: boolean;
  onPlay: (from?: number) => void;
}) {
  const a = teamInfo(awayAbbr);
  const h = teamInfo(homeAbbr);
  return (
    <div
      className="poster absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-4 text-center sm:gap-6"
      style={{ '--team-a-deep': a.primary, '--team-b-deep': h.primary } as React.CSSProperties}
    >
      <div className="flex items-center gap-4 sm:gap-8" aria-hidden="true">
        <TeamLogo abbr={awayAbbr} size={64} className="sm:hidden" />
        <TeamLogo abbr={awayAbbr} size={104} className="hidden sm:inline-flex" />
        <span className="font-display text-lg font-bold uppercase tracking-[0.2em] text-white/40 sm:text-2xl">vs</span>
        <TeamLogo abbr={homeAbbr} size={64} className="sm:hidden" />
        <TeamLogo abbr={homeAbbr} size={104} className="hidden sm:inline-flex" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={() => onPlay(resumeAt ? 0 : undefined)} className="btn-primary !px-5 !py-2.5 !text-[15px] shadow-glow">
          <Icon name="play" size={18} />
          {resumeAt ? 'Depuis le début' : 'Lancer le replay'}
        </button>
        {resumeAt && (
          <button type="button" onClick={() => onPlay(resumeAt)} className="btn !px-5 !py-2.5 !text-[15px] !bg-black/40 backdrop-blur">
            <Icon name="replay" size={16} />
            Reprendre à {fmtTime(resumeAt)}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-white/60">
        {duration ? <span className="num text-sm">{fmtTime(duration)}</span> : null}
        {cues > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-flame" /> VF synchronisée · {cues} commentaires
          </span>
        )}
        {lowQuality && <span className="text-warn">Qualité réduite — la HD arrive</span>}
        <span className="hidden sm:inline">Espace : lecture · ← → : ±10 s · F : plein écran · C : VF</span>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-ink-950/90 p-6 text-center backdrop-blur-sm" role="alert">
      <div className="max-w-md">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-loss/15 text-loss">
          <Icon name="alert" size={24} />
        </span>
        <p className="font-display text-xl font-bold uppercase tracking-wide text-paper">Lecture impossible</p>
        <p className="mt-1.5 text-sm text-paper-dim">{message}</p>
        <button type="button" onClick={onRetry} className="btn-primary mt-4">
          <Icon name="replay" size={16} /> Réessayer
        </button>
        <p className="mt-3 text-xs text-paper-faint">La VF reste consultable dans le panneau « VF en direct ».</p>
      </div>
    </div>
  );
}

const PATHS: Record<string, React.ReactNode> = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  back10: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
      <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>
  ),
  fwd10: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4h-4" />
      <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" fill="currentColor" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" fill="currentColor" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  shrink: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  replay: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
