import { M3U8_HEADERS, proxiedMaster, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Playlist maître : l'embed ok.ru est ré-résolu à chaque requête (signatures expirantes). */
export async function GET(_req: Request, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    return new Response(await proxiedMaster(okId), { headers: M3U8_HEADERS });
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
