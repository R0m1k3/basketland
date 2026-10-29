'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { WATCH_POLL_MS, statusWatchStep } from './watch';

/**
 * Match en direct ou à venir : quand son statut change (coup d'envoi, puis
 * coup de sifflet final), `router.refresh()` pour que la page serveur passe
 * à l'écran suivant (compte à rebours → en cours → recherche du replay).
 * Interroge GET /api/matches/[id] toutes les 60 s, seulement en direct ou à
 * moins de 30 min du coup d'envoi, et jamais quand l'onglet est caché.
 * Invisible.
 */
export default function StatusWatcher({ matchId, status, dateUtc }: { matchId: number; status: string; dateUtc: string }) {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (stopped || busy || document.hidden) return;
      const step = statusWatchStep({ renderedStatus: status, status, dateUtc, now: Date.now() });
      if (step === 'stop') {
        stopped = true;
        clearInterval(id);
        return;
      }
      if (step !== 'poll') return;
      busy = true;
      try {
        const r = await fetch(`/api/matches/${matchId}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = (await r.json()) as { status?: string };
        if (d.status && statusWatchStep({ renderedStatus: status, status: d.status, dateUtc, now: Date.now() }) === 'refresh') {
          stopped = true;
          clearInterval(id);
          router.refresh();
        }
      } catch {
        /* réseau momentanément coupé : prochain tick */
      } finally {
        busy = false;
      }
    };
    const id = setInterval(() => void tick(), WATCH_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [matchId, status, dateUtc, router]);

  return null;
}
