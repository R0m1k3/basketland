import { getMatch, getSubtitles } from '@/lib/db';
import { error, parseId, type RouteCtx } from '@/lib/api';
import { toWebVtt } from '@/lib/vtt';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  const body = toWebVtt(getSubtitles(id), `BasketLand VF — ${m.away_name} @ ${m.home_name}`);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Disposition': `inline; filename="basketland-${id}-fr.vtt"`,
      'Cache-Control': 'no-store',
    },
  });
}
