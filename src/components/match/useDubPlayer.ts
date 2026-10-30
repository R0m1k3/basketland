'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { DubPlayer, IDLE_DUB_STATE, type AudioContextLike, type DubState } from './dubPlayer';

function createAudioContext(): AudioContextLike {
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio indisponible');
  return new Ctor() as unknown as AudioContextLike;
}

const noSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_DUB_STATE;

export interface DubControls {
  state: DubState;
  /**
   * À appeler DANS un gestionnaire de geste (clic sur lecture, choix « VF
   * doublée ») : les navigateurs n'autorisent le son Web Audio qu'ainsi.
   * Sans `force`, sans effet tant que la VF doublée n'est pas choisie.
   */
  unlock: (force?: boolean) => void;
}

/**
 * VF doublée du match, jouée par-dessus l'élément vidéo (voir dubPlayer.ts).
 * Le manifeste est interrogé même VF doublée non choisie (sans `?t=`), pour
 * savoir s'il faut proposer le choix dans le menu.
 */
export function useDubPlayer(videoRef: RefObject<HTMLVideoElement | null>, matchId: number | null, enabled: boolean): DubControls {
  const [player, setPlayer] = useState<DubPlayer | null>(null);
  const playerRef = useRef<DubPlayer | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || matchId === null) return;
    const p = new DubPlayer({
      video,
      manifestUrl: `/api/matches/${matchId}/dub`,
      createAudioContext,
      fetch: (url, init) => fetch(url, init),
    });
    playerRef.current = p;
    setPlayer(p);
    return () => {
      p.destroy();
      if (playerRef.current === p) playerRef.current = null;
      setPlayer(null);
    };
  }, [videoRef, matchId]);

  useEffect(() => {
    player?.setEnabled(enabled);
  }, [player, enabled]);

  const state = useSyncExternalStore(player ? player.subscribe : noSubscribe, player ? player.getSnapshot : idleSnapshot, idleSnapshot);
  const unlock = useCallback((force?: boolean) => playerRef.current?.unlock(force), []);
  return { state, unlock };
}
