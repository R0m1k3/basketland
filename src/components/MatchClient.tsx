'use client';

import { useCallback, useEffect, useState } from 'react';
import VideoPlayer, { type Subtitle } from '@/components/VideoPlayer';

interface Props {
  matchId: number;
  masterUrl: string | null;
  initialOffset: number;
}

/**
 * Conteneur client du lecteur : charge les sous-titres, gère le décalage
 * persistant (offset global) et affiche le bouton « Statistiques ».
 */
export default function MatchClient({ matchId, masterUrl, initialOffset }: Props) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [offset, setOffset] = useState(initialOffset);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matches/${matchId}/subtitles`)
      .then((r) => r.json())
      .then((d: { subtitles?: Subtitle[]; settings?: { global_offset?: number } }) => {
        if (cancelled) return;
        setSubtitles(d.subtitles ?? []);
        if (typeof d.settings?.global_offset === 'number') setOffset(d.settings.global_offset);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  // Persiste le décalage côté serveur (recharge la VF sans tout recalculer).
  const changeOffset = useCallback(
    (next: number) => {
      setOffset(next);
      void fetch(`/api/matches/${matchId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_offset: next }),
      }).catch(() => undefined);
    },
    [matchId],
  );

  return (
    <>
      <VideoPlayer
        masterUrl={masterUrl}
        subtitles={subtitles}
        offset={offset}
        onOffsetChange={changeOffset}
      />
      {subtitles.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Sous-titres français générés à partir du play-by-play, calés sur le commentaire original
          de la diffusion. Ajustez le décalage si nécessaire — la valeur est conservée.
        </p>
      )}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowStats((v) => !v)}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {showStats ? 'Masquer les statistiques' : 'Statistiques du match'}
        </button>
      </div>
    </>
  );
}
