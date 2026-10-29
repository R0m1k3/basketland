import { getMatch } from '@/lib/db';
import { error, parseId, type RouteCtx } from '@/lib/api';
import { servedCommentaryCues } from '@/lib/commentary';
import { wrapTwoLines } from '@/lib/commentaryCues';
import { toWebVtt } from '@/lib/vtt';

export const dynamic = 'force-dynamic';

/** Export WebVTT de la traduction des commentaires (les sous-titres déjà publiés, comme GET /subtitles). */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  const cues = servedCommentaryCues(id);
  const body = toWebVtt(
    cues.map((c) => ({ seq: c.seq, video_ts: c.start_ts, end_ts: c.end_ts, text_fr: wrapTwoLines(c.text_fr), speaker: '' })),
    `BasketLand VF — ${m.away_name} @ ${m.home_name}`,
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Disposition': `inline; filename="basketland-${id}-fr.vtt"`,
      'Cache-Control': 'no-store',
    },
  });
}
