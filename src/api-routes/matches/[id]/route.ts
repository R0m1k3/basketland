import { getMatch } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { toDto } from '@/lib/present';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  return json(toDto(m));
}
