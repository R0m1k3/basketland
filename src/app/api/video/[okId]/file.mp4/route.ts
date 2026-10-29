import type { NextRequest } from 'next/server';
import { proxiedMp4, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * MP4 progressif d'un replay qu'ok.ru n'a pas encore converti en HLS
 * (qualité « mobile » seule juste après la mise en ligne).
 *
 * Range relayé dans les deux sens (206 + Content-Range) pour le seeking ;
 * le signal de la requête coupe le téléchargement amont quand le
 * navigateur abandonne une plage (seek, fermeture de l'onglet).
 */
export async function GET(req: NextRequest, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    return await proxiedMp4(okId, req.headers.get('range'), req.signal);
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
