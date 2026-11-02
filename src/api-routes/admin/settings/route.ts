import { error, json } from '@/lib/api';
import { readJsonWrite, requireAdmin } from '@/lib/authHttp';
import {
  apiKeyError,
  autoTranslateEnabled,
  minimaxKeyError,
  minimaxSettingsView,
  minimaxTranslateModelError,
  modelError,
  openAiSettingsView,
  setAutoTranslate,
  setSetting,
  SETTING_KEYS,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** Ce que les routes renvoient des paramètres (clés OpenAI et MiniMax MASQUÉES). */
function settingsView() {
  return { openai: openAiSettingsView(), minimax: minimaxSettingsView(), autoTranslate: autoTranslateEnabled() };
}

/** GET /api/admin/settings — configuration OpenAI et MiniMax (clés MASQUÉES), traduction automatique. Administrateurs seulement. */
export async function GET(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return json(settingsView());
}

/**
 * POST /api/admin/settings — administrateurs seulement.
 * { openaiApiKey?: string | null, openaiModel?: string | null, autoTranslate?: boolean,
 *   minimaxApiKey?: string | null, minimaxTranslate?: boolean,
 *   minimaxTranslateModel?: string | null }
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
    ['minimaxTranslateModel', SETTING_KEYS.minimaxTranslateModel, minimaxTranslateModelError],
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
  if ('minimaxTranslate' in body) {
    if (typeof body.minimaxTranslate !== 'boolean') return error(400, 'minimaxTranslate invalide (attendu : true ou false)');
    updates.push([SETTING_KEYS.minimaxTranslate, body.minimaxTranslate ? '1' : '0']);
  }

  for (const [key, value] of updates) setSetting(key, value);
  if (typeof body.autoTranslate === 'boolean') setAutoTranslate(body.autoTranslate);
  return json({ ok: true, ...settingsView() });
}
