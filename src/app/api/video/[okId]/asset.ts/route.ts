import type { NextRequest } from 'next/server';
import { proxiedAsset, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Ressource HLS annexe : clé de déchiffrement (`#EXT-X-KEY`), segment
 * d'initialisation (`#EXT-X-MAP`).
 *
 * Ces fichiers ne sont pas des segments `.ts` : la route `segment.ts` les
 * refusait, et la playlist servait alors une URI qui pointait vers le
 * proxy au mauvais endroit (404 côté lecteur) — ou vers ok.ru en direct,
 * sans le `Referer` requis (403).
 */
export async function GET(req: NextRequest, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    return await proxiedAsset(okId, sp.get('v'), sp.get('a'));
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
