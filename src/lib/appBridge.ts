/**
 * Pont avec l'application Android (dossier `android/`).
 *
 * L'appli charge le site dans un WebView et se signale dans le User-Agent :
 * `BasketLandApp/<version>` (et `; TV` sur Android TV / Fire TV). Elle expose
 * `window.BasketLandApp` (état du lecteur → notification, écran verrouillé,
 * Alexa) et appelle en retour :
 * - `window.__blMedia(action, arg)` : touches média de la télécommande,
 *   commandes de la notification ou vocales ;
 * - `window.__blBack()` : touche Retour ; `true` si le site l'a traitée
 *   (menu fermé…), sinon l'appli revient en arrière dans l'historique.
 *
 * Dans un navigateur, tout ceci est inerte.
 */

export type MediaAction =
  | 'playpause'
  | 'play'
  | 'pause'
  | 'forward'
  | 'rewind'
  | 'next'
  | 'previous'
  | 'seekto'
  | 'menu';

export interface MediaState {
  playing: boolean;
  title: string;
  subtitle: string;
  /** Secondes. */
  position: number;
  /** Secondes (0 si inconnue). */
  duration: number;
}

interface NativeBridge {
  isTv(): boolean;
  version(): string;
  deviceName(): string;
  mediaState(json: string): void;
  mediaClear(): void;
}

declare global {
  interface Window {
    BasketLandApp?: NativeBridge;
    __blMedia?: (action: MediaAction, arg: number | null) => void;
    __blBack?: () => boolean;
  }
}

const UA_APP = /\bBasketLandApp\/[\w.-]+/;
const UA_TV = /\bBasketLandApp\/[\w.-]+; TV\b/;

function ua(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** Le site tourne dans l'application Android. */
export function isApp(userAgent: string = ua()): boolean {
  return UA_APP.test(userAgent);
}

/** Le site tourne dans l'application, sur un téléviseur (Android TV, Google TV, Fire TV). */
export function isTvApp(userAgent: string = ua()): boolean {
  return UA_TV.test(userAgent);
}

function native(): NativeBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.BasketLandApp;
}

/** Nom de l'appareil (« Fire TV », « TCL Smart TV »…), affiché à la validation du code. */
export function deviceName(): string {
  try {
    const n = native()?.deviceName();
    if (n) return n;
  } catch {
    // Pont absent : nom générique.
  }
  return isTvApp() ? 'TV' : 'Navigateur';
}

// --- commandes média : un seul lecteur actif à la fois (le dernier monté).

type MediaHandler = (action: MediaAction, arg: number | null) => void;
const mediaHandlers: MediaHandler[] = [];

function installMediaEntry() {
  if (typeof window === 'undefined' || window.__blMedia) return;
  window.__blMedia = (action, arg) => mediaHandlers[mediaHandlers.length - 1]?.(action, arg);
}

/** Branche un lecteur sur les commandes de l'appli ; renvoie la fonction de débranchement. */
export function onMediaAction(handler: MediaHandler): () => void {
  installMediaEntry();
  mediaHandlers.push(handler);
  return () => {
    const i = mediaHandlers.lastIndexOf(handler);
    if (i >= 0) mediaHandlers.splice(i, 1);
    if (mediaHandlers.length === 0) native()?.mediaClear();
  };
}

/** Envoie l'état du lecteur à l'appli (sans effet dans un navigateur). */
export function reportMediaState(state: MediaState): void {
  const n = native();
  if (!n) return;
  try {
    n.mediaState(JSON.stringify(state));
  } catch {
    // Pont absent ou appel refusé : rien à faire.
  }
}

// --- touche Retour : pile de gestionnaires, le plus récent d'abord.

type BackHandler = () => boolean;
const backHandlers: BackHandler[] = [];

function installBackEntry() {
  if (typeof window === 'undefined' || window.__blBack) return;
  window.__blBack = () => {
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      if (backHandlers[i]()) return true;
    }
    return false;
  };
}

/**
 * Gestionnaire de la touche Retour (fermer un menu, quitter le plein écran…) :
 * il renvoie `true` s'il a consommé la touche. Renvoie la fonction de retrait.
 */
export function onBack(handler: BackHandler): () => void {
  installBackEntry();
  backHandlers.push(handler);
  return () => {
    const i = backHandlers.lastIndexOf(handler);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}
