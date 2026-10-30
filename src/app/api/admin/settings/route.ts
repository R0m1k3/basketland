import { error, json } from '@/lib/api';
import { readJsonWrite, requireAdmin } from '@/lib/authHttp';
import { apiKeyError, autoTranslateEnabled, modelError, openAiSettingsView, setAutoTranslate, setSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** Ce que les routes renvoient des paramètres (clé OpenAI MASQUÉE). */
function settingsView() {
  return { openai: openAiSettingsView(), autoTranslate: autoTranslateEnabled() };
}

/** GET /api/admin/settings — configuration OpenAI (clé MASQUÉE) et traduction automatique. Administrateurs seulement. */
export async function GET(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return json(settingsView());
}

/**
 * POST /api/admin/settings — administrateurs seulement.
 * { openaiApiKey?: string | null, openaiModel?: string | null, autoTranslate?: boolean }
 * Champ absent = inchangé ; null ou chaîne vide = supprimé. La clé n'est
 * jamais renvoyée en clair : la réponse ne contient que sa forme masquée.
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

  for (const [key, value] of updates) setSetting(key, value);
  if (typeof body.autoTranslate === 'boolean') setAutoTranslate(body.autoTranslate);
  return json({ ok: true, ...settingsView() });
}
