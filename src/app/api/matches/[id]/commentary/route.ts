import { getMatch } from '@/lib/db';
import { allowedOrigins, error, isOriginAllowed, json, parseId, type RouteCtx } from '@/lib/api';
import { commentaryStatus, enqueueCommentary, touchViewer } from '@/lib/commentary';

export const dynamic = 'force-dynamic';

/** GET : statut seul (le même que `commentary` de GET /subtitles, sans effet de bord). */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  return json({ commentary: commentaryStatus(id) });
}

/**
 * POST /api/matches/[id]/commentary
 * - { action: 'start' } → traduction mise en TÊTE de file (sans effet si déjà prête) ;
 * - { action: 'retry' } → relance, même après abandon ou sur une piste prête.
 * Mêmes garde-fous que la route sync : origine contrôlée, Content-Type JSON
 * exigé (une requête « simple » text/plain n'est pas préflightée).
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée pour cette écriture');
  const essence = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (essence !== 'application/json') return error(415, 'Content-Type application/json requis');
  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return error(400, 'JSON invalide');
  }
  if (body?.action !== 'start' && body?.action !== 'retry') return error(400, "action invalide (attendu : 'start' ou 'retry')");
  touchViewer(id); // demandé depuis la fiche : quelqu'un regarde
  const r = enqueueCommentary(id, { priority: true, force: body.action === 'retry' });
  return json({ commentary: commentaryStatus(id), message: r.message }, { status: r.queued ? 202 : 200 });
}
