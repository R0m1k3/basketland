/**
 * Paramètres de l'application modifiables depuis /parametres (table
 * `settings`). Lus côté serveur uniquement : la clé OpenAI ne doit jamais
 * repartir vers le navigateur (voir `openAiSettingsView`).
 */
import { settingGet, settingSet } from './db';
import {
  MINIMAX_DEFAULT_MODEL,
  MINIMAX_DEFAULT_TEXT_MODEL,
  MINIMAX_DEFAULT_VOICES,
  MINIMAX_FRENCH_VOICES,
  MINIMAX_MODELS,
  MINIMAX_ROLES,
  MINIMAX_TEXT_MODELS,
  type MinimaxRole,
} from './minimaxCatalog';

/** Clés connues. */
export const SETTING_KEYS = {
  openaiApiKey: 'openai_api_key',
  openaiModel: 'openai_model',
  /** « Traduction automatique » : '1' (activée) ou '0' (désactivée). */
  autoTranslate: 'auto_translate',
  /** « Version française » : 'sous-titres' (défaut) ou 'doublage'. */
  vfMode: 'vf_mode',
  /** Voix du doublage par MiniMax : clé API, modèle, voix par rôle (JSON { A, B4, B1, F }). */
  minimaxApiKey: 'minimax_api_key',
  minimaxModel: 'minimax_tts_model',
  minimaxVoices: 'minimax_voices',
  /** Traduction des commentaires par MiniMax : '1' (activée) ; modèle texte. */
  minimaxTranslate: 'minimax_translate',
  minimaxTranslateModel: 'minimax_translate_model',
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
 *   commentaires sont traduits et affichés en sous-titres ;
 * - 'doublage' : « Doubler ce match » est mis en avant sur la fiche et le
 *   lecteur part en « VF doublée » tant que l'utilisateur n'a rien choisi.
 *   Une traduction ne lance jamais le doublage, dans aucun mode : seul
 *   « Doubler ce match » le lance (avec la traduction s'il le faut).
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

// ------------------------------------------------------------------ MiniMax (voix du doublage)

/** Voix MiniMax enregistrées (rôles absents : valeur par défaut ou variable d'environnement). */
export function savedMinimaxVoices(): Partial<Record<MinimaxRole, string>> {
  try {
    const v = JSON.parse(getSetting(SETTING_KEYS.minimaxVoices) || '{}') as Record<string, unknown>;
    const out: Partial<Record<MinimaxRole, string>> = {};
    for (const r of MINIMAX_ROLES) if (typeof v[r] === 'string' && v[r]) out[r] = v[r] as string;
    return out;
  } catch {
    return {};
  }
}

export interface MinimaxSettingsView {
  /** Une clé est enregistrée dans la page Paramètres. */
  keySet: boolean;
  /** Forme masquée de la clé enregistrée, ou null. */
  keyMasked: string | null;
  /** Une clé est donnée par la variable MINIMAX_API_KEY (utilisée faute de clé enregistrée). */
  envKey: boolean;
  /** Modèle en service (enregistré, sinon MINIMAX_TTS_MODEL, sinon défaut). */
  model: string;
  /** Voix en service par rôle (enregistrée, sinon MINIMAX_VOICE_<rôle>, sinon défaut). */
  voices: Record<MinimaxRole, string>;
  /** Traduction des commentaires par MiniMax demandée (sert dès qu'une clé est là). */
  translate: boolean;
  /** Modèle texte de la traduction. */
  translateModel: string;
}

/** Ce que l'interface peut afficher de la configuration MiniMax (jamais la clé complète). */
export function minimaxSettingsView(): MinimaxSettingsView {
  const key = getSetting(SETTING_KEYS.minimaxApiKey);
  const saved = savedMinimaxVoices();
  const voices = {} as Record<MinimaxRole, string>;
  for (const r of MINIMAX_ROLES) voices[r] = saved[r] ?? (process.env[`MINIMAX_VOICE_${r}`]?.trim() || MINIMAX_DEFAULT_VOICES[r]);
  return {
    keySet: !!key,
    keyMasked: key ? maskApiKey(key) : null,
    envKey: !!process.env.MINIMAX_API_KEY?.trim(),
    model: getSetting(SETTING_KEYS.minimaxModel) || process.env.MINIMAX_TTS_MODEL?.trim() || MINIMAX_DEFAULT_MODEL,
    voices,
    translate: minimaxTranslateWanted(),
    translateModel: minimaxTranslateModel(),
  };
}

/** Clé MiniMax saisie (plus longue qu'une clé OpenAI : jusqu'à ~1 000 caractères). */
export function minimaxKeyError(key: string): string | null {
  if (key.length < 20 || key.length > 2000) return 'La clé API semble invalide (longueur inattendue).';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'La clé API ne doit contenir ni espace ni caractère accentué.';
  return null;
}

/** Traduction par MiniMax demandée : réglage de la page, sinon variable `MINIMAX_TRANSLATE=1`. */
export function minimaxTranslateWanted(): boolean {
  const v = getSetting(SETTING_KEYS.minimaxTranslate);
  return v === null ? process.env.MINIMAX_TRANSLATE?.trim() === '1' : v === '1';
}

/** Modèle texte MiniMax de la traduction : réglage, sinon `MINIMAX_TRANSLATE_MODEL`, sinon défaut. */
export function minimaxTranslateModel(): string {
  return getSetting(SETTING_KEYS.minimaxTranslateModel) || process.env.MINIMAX_TRANSLATE_MODEL?.trim() || MINIMAX_DEFAULT_TEXT_MODEL;
}

export function minimaxTranslateModelError(model: string): string | null {
  return MINIMAX_TEXT_MODELS.some((m) => m.id === model) ? null : 'Modèle de traduction MiniMax inconnu.';
}

export function minimaxModelError(model: string): string | null {
  return MINIMAX_MODELS.some((m) => m.id === model) ? null : 'Modèle MiniMax inconnu.';
}

/** Voix par rôle saisies : rend la valeur à enregistrer (JSON), ou un message d'erreur. */
export function parseMinimaxVoices(raw: unknown): { value: string | null } | { error: string } {
  if (raw === null) return { value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'minimaxVoices invalide' };
  const out: Partial<Record<MinimaxRole, string>> = {};
  for (const [role, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MINIMAX_ROLES as readonly string[]).includes(role)) return { error: `Rôle de voix inconnu : ${role}` };
    // Catalogue, ou identifiant de voix MiniMax plausible (voix venue d'une variable d'environnement).
    const plausible = typeof id === 'string' && (MINIMAX_FRENCH_VOICES.some((v) => v.id === id) || /^[A-Za-z0-9_ ().-]{1,100}$/.test(id));
    if (!plausible) return { error: `Voix MiniMax invalide pour ${role}` };
    out[role as MinimaxRole] = id;
  }
  return { value: Object.keys(out).length ? JSON.stringify(out) : null };
}
