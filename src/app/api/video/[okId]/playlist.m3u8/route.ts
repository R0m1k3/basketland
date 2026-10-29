import type { NextRequest } from 'next/server';
import { M3U8_HEADERS, proxiedMedia, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Playlist média d'une variante (?v=sd|hd|full|…) : segments réécrits vers /segment.ts. */
export async function GET(req: NextRequest, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    // Le paramètre `u` (URL absolue) a été supprimé : c'était une surface
    // SSRF. La variante est identifiée par sa clé QUALITY, résolue serveur.
    return new Response(await proxiedMedia(okId, sp.get('v')), { headers: M3U8_HEADERS });
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
