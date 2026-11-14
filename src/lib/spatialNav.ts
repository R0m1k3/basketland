/**
 * Navigation à la croix directionnelle (télécommande TV), sans dépendance.
 *
 * Sur ←↑→↓, le focus passe à l'élément focalisable le plus proche dans la
 * direction, dans la « portée » courante : l'élément en plein écran, sinon la
 * boîte de dialogue qui contient le focus (menu du lecteur), sinon la page.
 * OK (Entrée) active l'élément comme un clic, par le comportement normal du
 * navigateur.
 *
 * Exceptions, laissées au comportement normal :
 * - élément marqué `data-nav="manual"` (le lecteur gère ses touches) ;
 * - ←/→ dans un champ de saisie ou sur un curseur (`role="slider"`, `input[type=range]`) ;
 * - touche déjà traitée (`defaultPrevented`).
 *
 * Installé seulement dans l'application TV (voir `src/lib/tv.ts`).
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="slider"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * Score d'un candidat `b` depuis `a` dans la direction `dir` (plus petit = meilleur),
 * `null` s'il n'est pas dans cette direction. Distance sur l'axe du déplacement,
 * plus le double de l'écart sur l'autre axe (rester dans la même colonne ou ligne),
 * plus un léger départage par l'alignement des centres.
 */
export function score(a: Box, b: Box, dir: Direction): number | null {
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  let primary: number;
  let gap: number;
  let offset: number;
  switch (dir) {
    case 'down':
      if (bcy <= acy + 1 || b.top < a.top + 1) return null;
      primary = Math.max(0, b.top - a.bottom);
      gap = Math.max(0, b.left - a.right, a.left - b.right);
      offset = Math.abs(bcx - acx);
      break;
    case 'up':
      if (bcy >= acy - 1 || b.bottom > a.bottom - 1) return null;
      primary = Math.max(0, a.top - b.bottom);
      gap = Math.max(0, b.left - a.right, a.left - b.right);
      offset = Math.abs(bcx - acx);
      break;
    case 'right':
      if (bcx <= acx + 1 || b.left < a.left + 1) return null;
      primary = Math.max(0, b.left - a.right);
      gap = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      offset = Math.abs(bcy - acy);
      break;
    case 'left':
      if (bcx >= acx - 1 || b.right > a.right - 1) return null;
      primary = Math.max(0, a.left - b.right);
      gap = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      offset = Math.abs(bcy - acy);
      break;
  }
  return primary + 2 * gap + 0.05 * offset;
}

/** Index du meilleur candidat (`-1` : aucun dans cette direction). */
export function pick(from: Box, candidates: Box[], dir: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    const s = score(from, c, dir);
    if (s !== null && s < bestScore) {
      best = i;
      bestScore = s;
    }
  });
  return best;
}

function usable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  // Barre du lecteur masquée : `pointer-events: none` + opacité nulle.
  return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && !el.closest('[inert],[aria-hidden="true"]');
}

/** Portée de la navigation : plein écran, sinon dialogue contenant le focus, sinon la page. */
export function scope(): ParentNode {
  const fs = document.fullscreenElement;
  if (fs) {
    const dialog = document.activeElement?.closest('[role="dialog"]');
    return dialog && fs.contains(dialog) ? dialog : fs;
  }
  return document.activeElement?.closest('[role="dialog"]') ?? document.body;
}

/** Éléments focalisables et visibles de la portée, dans l'ordre du document. */
export function focusables(root: ParentNode = scope()): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
}

const HEADER_GUARD = 72; // en-tête collant (h-16) + marge

/** Focus sans défilement brusque, puis défilement juste ce qu'il faut. */
export function focusEl(el: HTMLElement) {
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  if (r.top < HEADER_GUARD || r.bottom > window.innerHeight) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  } else {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** Premier élément utile à l'écran (ou marqué `data-tv-autofocus`). */
export function focusFirst(): boolean {
  const marked = document.querySelector<HTMLElement>('[data-tv-autofocus]');
  if (marked && usable(marked)) {
    focusEl(marked);
    return true;
  }
  // Jamais un champ de saisie : le clavier de la TV s'ouvrirait tout seul.
  const all = focusables().filter((el) => !isTextField(el));
  const main = document.querySelector('main');
  const inView = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.bottom > HEADER_GUARD && r.top < window.innerHeight;
  };
  const target = all.find((el) => main?.contains(el) && inView(el)) ?? all.find(inView) ?? all[0];
  if (!target) return false;
  focusEl(target);
  return true;
}

function isTextField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(el.type);
}

function isSlider(el: Element): boolean {
  return el.getAttribute('role') === 'slider' || (el instanceof HTMLInputElement && el.type === 'range');
}

/** Déplace le focus dans une direction ; `false` si rien à faire (bord de l'écran). */
export function move(dir: Direction): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || !document.contains(active)) return focusFirst();
  const all = focusables().filter((el) => el !== active && !active.contains(el));
  const i = pick(active.getBoundingClientRect(), all.map((el) => el.getBoundingClientRect()), dir);
  if (i < 0) {
    // Rien plus bas ou plus haut : on fait défiler la page (texte long, bas de page).
    if (dir === 'down' || dir === 'up') window.scrollBy({ top: (dir === 'down' ? 1 : -1) * window.innerHeight * 0.4 });
    return false;
  }
  focusEl(all[i]);
  return true;
}

function onKey(e: KeyboardEvent) {
  const dir = KEYS[e.key];
  if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = document.activeElement;
  if (t instanceof HTMLElement) {
    if (t.dataset.nav === 'manual') return;
    if ((dir === 'left' || dir === 'right') && (isTextField(t) || isSlider(t))) return;
    if (isTextField(t) && t instanceof HTMLSelectElement) return;
  }
  e.preventDefault();
  move(dir);
}

let installed = false;

/** Branche la navigation à la croix (une seule fois). */
export function installSpatialNav() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKey);
}
