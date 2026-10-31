'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReloadPage } from '@/components/page/pageData';
import { WATCH_POLL_MS, manualCheckWaitMs, replayStatusLine, replayWatchStep } from './watch';

interface VideoState {
  available: boolean;
  kind: 'hls' | 'mp4' | null;
  checked_at: string | null;
}

/**
 * Match terminé sans replay : lance une recherche à l'ouverture, puis
 * surveille l'état (GET /api/matches/[id] toutes les 60 s, en pause quand
 * l'onglet est caché, arrêt au bout de 3 h). Dès que le replay est là,
 * les données de la page sont relues : elle affiche le lecteur, sans
 * rechargement.
 */
export default function ReplayWatcher({ matchId, dateUtc, checkedAt }: { matchId: number; dateUtc: string; checkedAt: string | null }) {
  const reload = useReloadPage();
  const [video, setVideo] = useState<VideoState>({ available: false, kind: null, checked_at: checkedAt });
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastRequestAt, setLastRequestAt] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef(Date.now());
  const refreshed = useRef(false);

  const apply = useCallback(
    (v: VideoState | undefined) => {
      if (!v) return;
      setVideo(v);
      if (replayWatchStep({ available: v.available, startedAt: startedAt.current, now: Date.now() }) === 'refresh' && !refreshed.current) {
        refreshed.current = true;
        reload();
      }
    },
    [reload],
  );

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/matches/${matchId}`, { cache: 'no-store' });
      if (r.ok) apply(((await r.json()) as { video?: VideoState }).video);
    } catch {
      /* réseau momentanément coupé : prochain tick */
    }
    setNow(Date.now());
  }, [matchId, apply]);

  const check = useCallback(async () => {
    setSearching(true);
    setLastRequestAt(Date.now());
    try {
      const r = await fetch(`/api/matches/${matchId}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'check' }),
      });
      const d = (await r.json().catch(() => ({}))) as { video?: VideoState; message?: string; pending?: boolean; error?: string };
      apply(d.video);
      // 429 (recherche très récente) n'est pas une erreur : la ligne d'état dit déjà quand.
      setMessage(r.status === 429 ? null : (d.message ?? d.error ?? null));
      // Recherche encore en cours côté serveur : un coup d'œil un peu plus tôt.
      if (d.pending) setTimeout(() => void poll(), 20_000);
    } catch {
      setMessage('Recherche impossible : connexion au serveur perdue.');
    } finally {
      setSearching(false);
      setNow(Date.now());
    }
  }, [matchId, apply, poll]);

  // Une recherche à l'ouverture (garde contre le double montage du mode strict).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    void check();
  }, [check]);

  // Surveillance : 60 s, rien quand l'onglet est caché, coup d'œil au retour.
  useEffect(() => {
    if (stopped) return;
    const tick = () => {
      if (document.hidden) return;
      if (replayWatchStep({ available: false, startedAt: startedAt.current, now: Date.now() }) === 'stop') {
        setStopped(true);
        return;
      }
      void poll();
    };
    const id = setInterval(tick, WATCH_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, stopped]);

  // Horloge des libellés relatifs (« il y a 3 min »).
  useEffect(() => {
    const id = setInterval(() => !document.hidden && setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const wait = manualCheckWaitMs({ checkedAt: video.checked_at, lastRequestAt, now });
  const line = stopped
    ? 'Mise à jour automatique en pause : rechargez la page pour la reprendre.'
    : replayStatusLine({ searching, checkedAt: video.checked_at, dateUtc, kind: video.kind, now });

  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 sm:justify-start">
        <span className="inline-flex items-center gap-2 text-xs text-paper-dim" suppressHydrationWarning>
          {searching ? (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-flame border-t-transparent" aria-hidden="true" />
          ) : (
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stopped ? 'bg-paper-faint' : 'animate-pulse bg-flame'}`} aria-hidden="true" />
          )}
          {line}
        </span>
        <button
          type="button"
          onClick={() => void check()}
          disabled={searching || wait > 0}
          title={wait > 0 ? `Nouvelle recherche possible dans ${Math.ceil(wait / 1000)} s` : undefined}
          className="btn !py-1.5 text-xs"
        >
          Chercher maintenant
        </button>
      </div>
      <p className="min-h-[1rem] text-xs text-paper-faint" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
