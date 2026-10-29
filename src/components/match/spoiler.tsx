'use client';

import { useSyncExternalStore } from 'react';
import { FICHE_ROOT_ID } from './format';

/**
 * Mode « scores masqués » vu des composants client de la fiche match.
 *
 * Le mode commun du site (ui/SpoilerToggle, cookie `bl_spoilers` +
 * localStorage `bl:spoilers`) se traduit par l'attribut `data-spoilers` du
 * conteneur de page, rendu par le serveur selon le cookie ; un clic sur
 * « Afficher » pose `data-revealed` sur #fiche-match (le `data-scope`).
 * Les parties statiques sont masquées en CSS (.spoil-show / .spoil-only) ;
 * ce hook sert aux parties dynamiques (VF, transcript, statistiques).
 */

function read(): boolean {
  const scope = document.getElementById(FICHE_ROOT_ID);
  const mode = scope?.closest('[data-spoilers]')?.getAttribute('data-spoilers');
  return mode === 'hide' && !scope?.hasAttribute('data-revealed');
}

function subscribe(cb: () => void) {
  const host = document.getElementById(FICHE_ROOT_ID)?.closest('[data-spoilers]');
  if (!host) return () => undefined;
  const mo = new MutationObserver(cb);
  mo.observe(host, { attributes: true, subtree: true, attributeFilter: ['data-spoilers', 'data-revealed'] });
  return () => mo.disconnect();
}

/** `true` si les scores de ce match doivent rester cachés. */
export function useNoSpoil(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Retire le score des lignes de VF « Fin du 1er quart · NY 33 – 28 CHI ». */
export function stripScores(text: string): string {
  return text.replace(/\s*·\s*[A-Z]{2,4}\s+\d+\s*[–-]\s*\d+\s+[A-Z]{2,4}\s*$/, '');
}
