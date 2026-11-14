/**
 * Mode TV (application Android sur Android TV, Google TV, Fire TV) :
 * classe `tv` sur `<html>` (styles de `globals.css`), navigation à la croix
 * (`spatialNav.ts`), focus de départ sur chaque page et focus retrouvé au
 * retour sur une page déjà visitée.
 */

import { isTvApp } from './appBridge';
import { focusables, focusEl, focusFirst, installSpatialNav, move } from './spatialNav';

const KEY = 'bl:tv-focus';

/** Dernier élément focalisé par page (index parmi les focalisables), pour le retour. */
function saved(): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function remember() {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return;
  const i = focusables(document.body).indexOf(a);
  if (i < 0) return;
  const all = saved();
  all[location.pathname + location.search] = i;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Stockage plein ou refusé : pas de retour au même endroit.
  }
}

let started = false;

/** À appeler une fois au chargement ; sans effet hors de l'appli TV. */
export function setupTv(): boolean {
  if (!isTvApp()) return false;
  if (started) return true;
  started = true;
  document.documentElement.classList.add('tv');
  installSpatialNav();
  // Mémorise la position avant de quitter la page (clic sur un lien ou Retour).
  document.addEventListener('focusin', remember);
  // Pour le banc de test de la navigation (playwright) : parcours sans appuyer sur les touches.
  (window as unknown as { __blNav?: unknown }).__blNav = { focusables, move };
  return true;
}

/**
 * Nouvelle page affichée : focus retrouvé (retour arrière) ou premier élément.
 * Les données arrivent après coup : on réessaie quelques instants.
 */
export function focusPage(path: string) {
  if (!started) return;
  const want = saved()[path];
  let tries = 0;
  const attempt = () => {
    const a = document.activeElement;
    if (a && a !== document.body && document.querySelector('main')?.contains(a)) return;
    const all = focusables(document.body);
    if (want !== undefined && all[want]) {
      focusEl(all[want]);
      return;
    }
    // Attendre que la page ait chargé ses données (au plus ~3 s).
    if (++tries < 12 && (want !== undefined || !document.querySelector('main a[href], main button'))) {
      setTimeout(attempt, 250);
      return;
    }
    focusFirst();
  };
  setTimeout(attempt, 150);
}
