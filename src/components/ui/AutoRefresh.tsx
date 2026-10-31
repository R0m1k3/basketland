'use client';

import { useEffect } from 'react';
import { useReloadPage } from '@/components/page/pageData';
import { PAGE_REFRESH_MS } from '@/components/match/watch';

/**
 * Relit les données de la page toutes les 5 min quand l'onglet est visible
 * (et au retour sur un onglet resté caché plus longtemps) : nouveaux
 * replays, scores et badges apparaissent sans recharger. Invisible.
 */
export default function AutoRefresh({ everyMs = PAGE_REFRESH_MS }: { everyMs?: number }) {
  const reload = useReloadPage();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.hidden || Date.now() - last < everyMs - 1000) return;
      last = Date.now();
      reload();
    };
    const id = setInterval(refresh, everyMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [everyMs, reload]);
  return null;
}
