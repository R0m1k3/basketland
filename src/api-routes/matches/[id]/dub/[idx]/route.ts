import fs from 'node:fs/promises';
import { error, parseId, type RouteCtx } from '@/lib/api';
import { dubChunkPath } from '@/lib/dub';

export const dynamic = 'force-dynamic';

/**
 * GET /api/matches/[id]/dub/[idx] — audio d'un tronçon doublé (AAC mono
 * dans un MP4 audio). L'URL du manifeste porte `?v=<date de création>` :
 * un tronçon refait change d'URL, la réponse peut donc rester en cache.
 * Range simple (`bytes=a-b`, `bytes=a-`, `bytes=-n`) pris en charge.
 */
export async function GET(req: Request, ctx: RouteCtx<{ id: string; idx: string }>) {
  const p = await ctx.params;
  const id = parseId(p.id);
  const idx = Number(p.idx);
  if (!id || !/^\d+$/.test(p.idx) || !Number.isSafeInteger(idx)) return error(400, 'paramètres invalides');
  const file = dubChunkPath(id, idx);
  if (!file) return error(404, 'tronçon doublé introuvable');
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch {
    return error(404, 'tronçon doublé introuvable');
  }
  const size = buf.length;
  const headers: Record<string, string> = {
    'Content-Type': 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
  };
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = -1;
    let end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(size - 1, Number(m[2]));
      } else start = Math.max(0, size - Number(m[2])); // suffixe : les n derniers octets
    }
    if (start < 0 || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const body = new Uint8Array(buf.subarray(start, end + 1));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(body.length) },
    });
  }
  return new Response(new Uint8Array(buf), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}
