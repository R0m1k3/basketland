import { allowedOrigins, error, isOriginAllowed, parseId, type RouteCtx } from '@/lib/api';
import { touchViewer } from '@/lib/viewers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/matches/[id]/watching — signe de vie du lecteur pendant la
 * lecture ({ t: position en s }), toutes les 20 s. Tant qu'il arrive, les
 * tâches de fond (traduction d'autres matchs, analyse vidéo) s'effacent.
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée');
  let t: number | null = null;
  try {
    const d = JSON.parse((await req.text()).slice(0, 500)) as { t?: unknown };
    if (typeof d.t === 'number' && Number.isFinite(d.t)) t = d.t;
  } catch {
    /* corps facultatif */
  }
  touchViewer(id, t);
  return new Response(null, { status: 204 });
}
