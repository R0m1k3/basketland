'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Subtitle {
  seq: number;
  video_ts: number;
  end_ts: number | null;
  text: string;
  speaker: string;
  kind: string;
}

interface Props {
  masterUrl: string | null;
  subtitles: Subtitle[];
  /** Ajustement manuel du décalage, en secondes. */
  offset: number;
  onOffsetChange?: (offset: number) => void;
  /** Notifie la position de lecture courante (pour poser une ancre). */
  onTimeChange?: (seconds: number) => void;
}

/**
 * Lecteur HLS avec sous-titres français synchronisés.
 *
 * Le serveur a DÉJÀ appliqué le décalage global et les décalages par quart
 * dans `video_ts` (voir `timeLines` / `applyOffsets` dans `src/lib/sync.ts`).
 * Le client ne doit donc plus ré-appliquer l'offset : il affiche le
 * sous-titre dont l'intervalle contient `currentTime`.
 *
 * L'offset affiché ici est celui du serveur ; le bouton de réglage persiste
 * la nouvelle valeur puis recharge les sous-titres (M3).
 */
export default function VideoPlayer({
  masterUrl,
  subtitles,
  offset,
  onOffsetChange,
  onTimeChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chargement du flux HLS.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !masterUrl) return;
    let cancelled = false;

    (async () => {
      try {
        // HLS natif (Safari) ou hls.js sur les autres navigateurs.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = masterUrl;
          return;
        }
        const { default: Hls } = await import('hls.js');
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setError('La lecture HLS n’est pas supportée par ce navigateur.');
          return;
        }
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hlsRef.current = hls;
        hls.loadSource(masterUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            setError(
              data.type === Hls.ErrorTypes.NETWORK_ERROR
                ? 'Flux indisponible (la source distant a peut-être expiré).'
                : 'Erreur de lecture du flux.',
            );
          }
        });
      } catch (e) {
        setError(`Chargement du flux impossible : ${(e as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [masterUrl]);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(v.currentTime);
    onTimeChange?.(v.currentTime);
  }, [onTimeChange]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  // Sous-titre active : la dernière dont video_ts <= position.
  // L'offset est DÉJÀ appliqué par le serveur dans video_ts : ne pas le
  // ré-appliquer ici, sinon il s'annule (ou se double) au rechargement.
  const position = current;
  const activeIndex = (() => {
    let idx = -1;
    for (let i = 0; i < subtitles.length; i++) {
      if (subtitles[i].video_ts <= position + 0.05) idx = i;
      else break;
    }
    if (idx < 0) return -1;
    const sub = subtitles[idx];
    if (sub.end_ts !== null && position > sub.end_ts + 0.5) return -1;
    return idx;
  })();
  const active = activeIndex >= 0 ? subtitles[activeIndex] : null;

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  if (!masterUrl) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-xl border border-slate-800 bg-black text-sm text-slate-500">
        Replay non disponible pour ce match.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          className="aspect-video w-full"
          controls
          playsInline
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onError={() => setError('Erreur de lecture.')}
        />

        {/* Sous-titre français superposé */}
        {active && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
            <div className="subtitle-overlay max-w-3xl rounded bg-black/55 px-3 py-1.5 text-center text-base font-medium text-white sm:text-lg">
              {active.text}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-0 top-0 bg-red-900/80 px-4 py-2 text-center text-sm text-white">
            {error}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <button
          type="button"
          onClick={toggle}
          className="rounded-lg border border-slate-700 px-3 py-1.5 hover:border-slate-500"
        >
          {paused ? '▶ Lecture' : '⏸ Pause'}
        </button>
        <span className="tabular-nums">
          {fmt(current)} / {fmt(duration)}
        </span>
        <span className="tabular-nums">
          Sous-titres : {subtitles.length}
          {activeIndex >= 0 ? ` · #${activeIndex + 1}` : ''}
        </span>

        {onOffsetChange && (
          <div className="ml-auto flex items-center gap-2">
            <span>Décalage VF</span>
            {/* Un offset négatif retarde l'apparition des sous-titres,
                un offset positif les avance. Les libellés disent ce qui
                se voit à l'écran. */}
            <button
              type="button"
              onClick={() => onOffsetChange(offset - 0.5)}
              className="rounded border border-slate-700 px-2 py-1 hover:border-slate-500"
              aria-label="Retarder la VF de 0,5 seconde"
              title="Retarder la VF de 0,5 seconde"
            >
              −0,5 s
            </button>
            <span className="w-16 text-center tabular-nums text-slate-200">
              {offset > 0 ? '+' : ''}
              {offset.toFixed(1)} s
            </span>
            <button
              type="button"
              onClick={() => onOffsetChange(offset + 0.5)}
              className="rounded border border-slate-700 px-2 py-1 hover:border-slate-500"
              aria-label="Avancer la VF de 0,5 seconde"
              title="Avancer la VF de 0,5 seconde"
            >
              +0,5 s
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
