import { getMatch } from '@/lib/db';
import { allowedOrigins, error, isOriginAllowed, json, parseId, type RouteCtx } from '@/lib/api';
import { requestReplayCheck } from '@/lib/replayCheck';

export const dynamic = 'force-dynamic';

/**
 * POST /api/matches/[id]/replay — { action: 'check' }
 *
 * Cherche le replay tout de suite (fiche d'un match terminé sans replay, ou
 * avec un replay MP4 seul). Réponse : { video, checked, message } où `video`
 * est le bloc `video` du DTO de GET /api/matches/[id].
 * - 200 : recherche faite (ou inutile : replay déjà là) ;
 * - 202 : recherche lancée, encore en cours (`pending: true`) ;
 * - 409 : match pas encore terminé ;
 * - 429 : dernière recherche de ce match il y a moins de 2 min (`retry_after`).
 * Mêmes garde-fous que les autres routes d'écriture : origine contrôlée,
 * Content-Type JSON exigé (une requête « simple » text/plain n'est pas préflightée).
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const match = getMatch(id);
  if (!match) return error(404, 'match introuvable');
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée pour cette écriture');
  const essence = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (essence !== 'application/json') return error(415, 'Content-Type application/json requis');
  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return error(400, 'JSON invalide');
  }
  if (body?.action !== 'check') return error(400, "action invalide (attendu : 'check')");
  const r = await requestReplayCheck(match);
  const headers: Record<string, string> = r.body.retry_after ? { 'Retry-After': String(r.body.retry_after) } : {};
  return json(r.body, { status: r.status, headers });
}
