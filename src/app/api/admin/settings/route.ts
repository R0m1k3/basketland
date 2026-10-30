import { error, json } from '@/lib/api';
import { readJsonWrite, requireAdmin } from '@/lib/authHttp';
import { apiKeyError, modelError, openAiSettingsView, setSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** GET /api/admin/settings — configuration OpenAI, clé MASQUÉE. Administrateurs seulement. */
export async function GET(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return json({ openai: openAiSettingsView() });
}

/**
 * POST /api/admin/settings — administrateurs seulement.
 * { openaiApiKey?: string | null, openaiModel?: string | null }
 * Champ absent = inchangé ; null ou chaîne vide = supprimé. La clé n'est
 * jamais renvoyée en clair : la réponse ne contient que sa forme masquée.
 */
export async function POST(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;

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
  for (const [key, value] of updates) setSetting(key, value);
  return json({ ok: true, openai: openAiSettingsView() });
}
