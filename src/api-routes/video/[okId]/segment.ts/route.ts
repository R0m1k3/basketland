import type { NextRequest } from 'next/server';
import { proxiedSegment, proxyErrorResponse } from '@/lib/videoProxy';
import type { RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Segment MPEG-TS (Referer ok.ru, support Range pour le seeking). */
export async function GET(req: NextRequest, ctx: RouteCtx<{ okId: string }>) {
  try {
    const { okId } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    return await proxiedSegment(okId, sp.get('v'), sp.get('s'), req.headers.get('range'));
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
