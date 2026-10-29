'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PAGE_REFRESH_MS } from '@/components/match/watch';

/**
 * Rafraîchit la page serveur toutes les 5 min quand l'onglet est visible
 * (et au retour sur un onglet resté caché plus longtemps) : nouveaux
 * replays, scores et badges apparaissent sans recharger. Invisible.
 */
export default function AutoRefresh({ everyMs = PAGE_REFRESH_MS }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.hidden || Date.now() - last < everyMs - 1000) return;
      last = Date.now();
      router.refresh();
    };
    const id = setInterval(refresh, everyMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [everyMs, router]);
  return null;
}
