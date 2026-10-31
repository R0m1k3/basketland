import { error, json } from '@/lib/api';
import { readJsonWrite, requireAdmin } from '@/lib/authHttp';
import {
  apiKeyError,
  autoTranslateEnabled,
  isVfMode,
  minimaxKeyError,
  minimaxModelError,
  minimaxSettingsView,
  modelError,
  openAiSettingsView,
  parseMinimaxVoices,
  setAutoTranslate,
  setSetting,
  setVfMode,
  SETTING_KEYS,
  vfMode,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** Ce que les routes renvoient des paramètres (clés OpenAI et MiniMax MASQUÉES). */
function settingsView() {
  return { openai: openAiSettingsView(), minimax: minimaxSettingsView(), autoTranslate: autoTranslateEnabled(), vfMode: vfMode() };
}

/** GET /api/admin/settings — configuration OpenAI et MiniMax (clés MASQUÉES), traduction automatique, version française. Administrateurs seulement. */
export async function GET(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return json(settingsView());
}

/**
 * POST /api/admin/settings — administrateurs seulement.
 * { openaiApiKey?: string | null, openaiModel?: string | null, autoTranslate?: boolean,
 *   vfMode?: 'sous-titres' | 'doublage', minimaxApiKey?: string | null,
 *   minimaxModel?: string | null, minimaxVoices?: { A?, B4?, B1?, F? } | null }
 * Champ absent = inchangé ; null ou chaîne vide = supprimé. Les clés ne sont
 * jamais renvoyées en clair : la réponse ne contient que leur forme masquée.
 */
export async function POST(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;

  // Tout est validé avant la première écriture : une requête invalide ne change rien.
  const updates: [string, string | null][] = [];
  for (const [field, key, check] of [
    ['openaiApiKey', SETTING_KEYS.openaiApiKey, apiKeyError],
    ['openaiModel', SETTING_KEYS.openaiModel, modelError],
    ['minimaxApiKey', SETTING_KEYS.minimaxApiKey, minimaxKeyError],
    ['minimaxModel', SETTING_KEYS.minimaxModel, minimaxModelError],
  ] as const) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw !== null && typeof raw !== 'string') return error(400, `${field} invalide`);
    const value = raw?.trim() || null;
    const err = value ? check(value) : null;
    if (err) return error(400, err);
    updates.push([key, value]);
  }
  if ('autoTranslate' in body && typeof body.autoTranslate !== 'boolean') return error(400, 'autoTranslate invalide (attendu : true ou false)');
  if ('vfMode' in body && !isVfMode(body.vfMode)) return error(400, "vfMode invalide (attendu : 'sous-titres' ou 'doublage')");
  if ('minimaxVoices' in body) {
    const v = parseMinimaxVoices(body.minimaxVoices);
    if ('error' in v) return error(400, v.error);
    updates.push([SETTING_KEYS.minimaxVoices, v.value]);
  }

  for (const [key, value] of updates) setSetting(key, value);
  if (typeof body.autoTranslate === 'boolean') setAutoTranslate(body.autoTranslate);
  if (isVfMode(body.vfMode)) setVfMode(body.vfMode);
  return json({ ok: true, ...settingsView() });
}
