import { M3U8_HEADERS, proxiedMaster, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Playlist maître : flux ok.ru résolu gardé en cache tant que sa signature
 * est valable (rafraîchi en arrière-plan avant expiration), variantes
 * réécrites vers le proxy.
 */
export async function GET(_req: Request, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    return new Response(await proxiedMaster(okId), { headers: M3U8_HEADERS });
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
