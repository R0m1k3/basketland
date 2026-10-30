/**
 * Paramètres de l'application modifiables depuis /parametres (table
 * `settings`). Lus côté serveur uniquement : la clé OpenAI ne doit jamais
 * repartir vers le navigateur (voir `openAiSettingsView`).
 */
import { settingGet, settingSet } from './db';

/** Clés connues. */
export const SETTING_KEYS = {
  openaiApiKey: 'openai_api_key',
  openaiModel: 'openai_model',
  /** « Traduction automatique » : '1' (activée) ou '0' (désactivée). */
  autoTranslate: 'auto_translate',
  /** « Version française » : 'sous-titres' (défaut) ou 'doublage'. */
  vfMode: 'vf_mode',
} as const;

/** Modèle OpenAI proposé quand aucun n'est saisi (placeholder du formulaire). */
export const OPENAI_MODEL_PLACEHOLDER = 'gpt-5.4-mini';

export function getSetting(key: string): string | null {
  return settingGet(key);
}

/** Écrit un paramètre ; `null` le supprime. */
export function setSetting(key: string, value: string | null): void {
  settingSet(key, value);
}

/**
 * « Traduction automatique » (réglage administrateur, ACTIVÉE par défaut) :
 * - activée : chaque replay est traduit (et analysé) dès qu'il est
 *   disponible, en pause pendant qu'une vidéo est regardée ;
 * - désactivée : rien ne part tout seul (ni jobs du cron, ni lancement à
 *   l'ouverture de la fiche, ni replay tout juste trouvé) et les travaux de
 *   fond déjà en file sont abandonnés (`inNightWindow`, nightWindow.ts) ;
 *   un match n'est traduit que sur un clic « Sous-titrer ce match » (ou
 *   « Doubler ce match »).
 * Seule la valeur '0' désactive : clé absente ou autre valeur = activée.
 */
export function autoTranslateEnabled(): boolean {
  return getSetting(SETTING_KEYS.autoTranslate) !== '0';
}

export function setAutoTranslate(enabled: boolean): void {
  setSetting(SETTING_KEYS.autoTranslate, enabled ? '1' : '0');
}

/**
 * « Version française » (réglage administrateur) :
 * - 'sous-titres' (DÉFAUT, clé absente ou valeur inconnue) : les
 *   commentaires sont traduits et affichés en sous-titres ; aucun doublage
 *   de fond (un match se double seulement sur un clic « Doubler ce match ») ;
 * - 'doublage' : les commentaires sont traduits puis dits par des voix
 *   françaises — avec la traduction automatique, chaque replay traduit est
 *   aussi doublé en tâche de fond, et le lecteur part en « VF doublée » tant
 *   que l'utilisateur n'a rien choisi.
 * Le doublage part toujours des sous-titres : la traduction est faite dans
 * les deux modes.
 */
export type VfMode = 'sous-titres' | 'doublage';

export const VF_MODES: readonly VfMode[] = ['sous-titres', 'doublage'];

export function isVfMode(v: unknown): v is VfMode {
  return typeof v === 'string' && (VF_MODES as readonly string[]).includes(v);
}

export function vfMode(): VfMode {
  return getSetting(SETTING_KEYS.vfMode) === 'doublage' ? 'doublage' : 'sous-titres';
}

export function setVfMode(mode: VfMode): void {
  setSetting(SETTING_KEYS.vfMode, mode);
}

/** Doublage AUTOMATIQUE (tâches de fond, match regardé) : traduction automatique activée ET mode « doublage ». */
export function autoDubEnabled(): boolean {
  return autoTranslateEnabled() && vfMode() === 'doublage';
}

/**
 * Forme masquée d'une clé API : préfixe + 4 derniers caractères
 * (`sk-…abcd`). Une clé trop courte pour être masquée sans se dévoiler
 * n'affiche que des puces.
 */
export function maskApiKey(key: string): string {
  if (key.length < 12) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export interface OpenAiSettingsView {
  /** Une clé est enregistrée. */
  keySet: boolean;
  /** Forme masquée de la clé (jamais la clé complète), ou null. */
  keyMasked: string | null;
  /** Modèle saisi, ou null (valeur par défaut côté traduction). */
  model: string | null;
}

/** Ce que l'interface peut afficher de la configuration OpenAI. */
export function openAiSettingsView(): OpenAiSettingsView {
  const key = getSetting(SETTING_KEYS.openaiApiKey);
  return { keySet: !!key, keyMasked: key ? maskApiKey(key) : null, model: getSetting(SETTING_KEYS.openaiModel) };
}

/**
 * Valide une clé API saisie : un seul « mot » de caractères ASCII visibles.
 * Renvoie un message d'erreur en français, ou null si la clé est acceptable.
 */
export function apiKeyError(key: string): string | null {
  if (key.length < 20 || key.length > 400) return 'La clé API semble invalide (longueur inattendue).';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'La clé API ne doit contenir ni espace ni caractère accentué.';
  return null;
}

/** Valide un nom de modèle (ex. `gpt-5.4-mini`). */
export function modelError(model: string): string | null {
  if (model.length > 100 || !/^[A-Za-z0-9._:/-]+$/.test(model)) return 'Nom de modèle invalide.';
  return null;
}
