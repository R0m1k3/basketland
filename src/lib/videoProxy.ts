/** Logique commune aux 3 routes du proxy vidéo. */
import { fetchWithRetry } from './http';
import { isAllowedMediaHost, isValidOkId, OK_HEADERS, pickVariant, resolveOkStream, type OkStream, type Variant } from './okru';
import { isValidPlaylist, resolveSegmentUrl, rewriteMasterPlaylist, rewriteMediaPlaylist } from './hls';

export const M3U8_HEADERS = {
  'Content-Type': 'application/vnd.apple.mpegurl',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

export class ProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertOkId(okId: string): void {
  if (!isValidOkId(okId)) throw new ProxyError(400, 'okId invalide');
}

/** Master : ré-résolution systématique de l'embed (URL signée fraîche), réécriture des variantes. */
export async function proxiedMaster(okId: string): Promise<string> {
  assertOkId(okId);
  const stream = await resolveOkStream(okId, { force: true });
  if (!isValidPlaylist(stream.masterText)) throw new ProxyError(502, 'playlist maître invalide');
  return rewriteMasterPlaylist(stream.masterText, stream.masterUrl, okId);
}

async function variantFor(okId: string, key: string | null, force = false): Promise<{ stream: OkStream; variant: Variant }> {
  const stream = await resolveOkStream(okId, { force });
  const variant = pickVariant(stream, key);
  if (!variant) throw new ProxyError(404, `variante inconnue: ${key}`);
  return { stream, variant };
}

/** Playlist média : réécrit les segments vers /segment.ts. Retente une fois si la signature a expiré. */
export async function proxiedMedia(okId: string, key: string | null, absUrl: string | null): Promise<string> {
  assertOkId(okId);
  if (absUrl) {
    if (!isAllowedMediaHost(absUrl)) throw new ProxyError(400, 'hôte non autorisé');
    const r = await fetchWithRetry(absUrl, { headers: OK_HEADERS });
    if (!r.ok) throw new ProxyError(502, `amont HTTP ${r.status}`);
    return rewriteMediaPlaylist(await r.text(), r.url || absUrl, okId, key ?? 'u');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const { variant } = await variantFor(okId, key, attempt > 0);
    const r = await fetchWithRetry(variant.url, { headers: OK_HEADERS });
    if (r.ok) {
      const text = await r.text();
      if (!isValidPlaylist(text)) throw new ProxyError(502, 'playlist média invalide');
      return rewriteMediaPlaylist(text, r.url || variant.url, okId, variant.key);
    }
    if (![400, 403, 404, 410].includes(r.status) || attempt > 0) throw new ProxyError(502, `amont HTTP ${r.status}`);
  }
  throw new ProxyError(502, 'playlist indisponible');
}

/** Segment .ts : stream binaire avec support Range ; ré-résolution si 4xx (expiration). */
export async function proxiedSegment(okId: string, key: string | null, s: string | null, range: string | null): Promise<Response> {
  assertOkId(okId);
  if (!s) throw new ProxyError(400, 'paramètre s manquant');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { variant } = await variantFor(okId, key, attempt > 0);
    const url = resolveSegmentUrl(s, variant.url);
    if (!isAllowedMediaHost(url)) throw new ProxyError(400, 'hôte non autorisé');
    const headers: Record<string, string> = { ...OK_HEADERS };
    if (range) headers.Range = range;
    const r = await fetchWithRetry(url, { headers, timeoutMs: 60_000, retries: 1 });
    if (r.ok || r.status === 206) {
      const out = new Headers({
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      for (const h of ['content-length', 'content-range']) {
        const v = r.headers.get(h);
        if (v) out.set(h, v);
      }
      return new Response(r.body, { status: r.status, headers: out });
    }
    if (r.status === 416) return new Response(null, { status: 416, headers: { 'Content-Range': r.headers.get('content-range') ?? '' } });
    if (![400, 403, 404, 410].includes(r.status) || attempt > 0) throw new ProxyError(502, `amont HTTP ${r.status}`);
  }
  throw new ProxyError(502, 'segment indisponible');
}

export function proxyErrorResponse(e: unknown): Response {
  const status = e instanceof ProxyError ? e.status : 502;
  return new Response(JSON.stringify({ error: (e as Error).message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
