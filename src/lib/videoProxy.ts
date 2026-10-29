/** Logique commune aux 3 routes du proxy vidéo. */
import { fetchWithRetry } from './http';
import * as db from './db';
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

/**
 * Vérifie qu'un `okId` correspond bien à un match connu de la base.
 *
 * Sans cette vérification, le proxy sert de relais pour N'IMPORTE QUEL flux
 * ok.ru : un appelant pourrait faire consommer la bande passante du NAS
 * pour des vidéos sans rapport avec le site.
 */
function assertKnownOkId(okId: string): void {
  // `leagueAny` : le proxy doit servir tout replay connu en base, quelle que
  // soit la ligue. Sans ce drapeau, `listMatches` imposerait `league = 'nba'`
  // et refuserait un replay WNBA parfaitement valide.
  const rows = db.listMatches({ videoOkId: okId, video: true, leagueAny: true, limit: 1 });
  if (!rows.length) throw new ProxyError(404, 'replay inconnu');
}

export function assertOkId(okId: string): void {
  if (!isValidOkId(okId)) throw new ProxyError(400, 'okId invalide');
}

/** Master : ré-résolution systématique de l'embed (URL signée fraîche), réécriture des variantes. */
export async function proxiedMaster(okId: string): Promise<string> {
  assertOkId(okId);
  assertKnownOkId(okId);
  // On réutilise le cache quand la signature est encore valable : forcer la
  // re-résolution à chaque requête amplifie les appels vers ok.ru et
  // augmente le risque de bannissement d'IP.
  const stream = await resolveOkStream(okId, { force: false });
  if (!isValidPlaylist(stream.masterText)) throw new ProxyError(502, 'playlist maître invalide');
  return rewriteMasterPlaylist(stream.masterText, stream.masterUrl, okId);
}

async function variantFor(okId: string, key: string | null, force = false): Promise<{ stream: OkStream; variant: Variant }> {
  const stream = await resolveOkStream(okId, { force });
  const variant = pickVariant(stream, key);
  if (!variant) throw new ProxyError(404, `variante inconnue: ${key}`);
  return { stream, variant };
}

/**
 * Playlist média : réécrit les segments vers /segment.ts. Retente une fois si la signature a expiré.
 *
 * Le paramètre `absUrl` a été supprimé : il permettait à l'appelant de
 * faire lire par le proxy une playlist arbitraire d'un hôte autorisé, via
 * notamment une redirection ouverte. La variante est toujours retrouvée
 * depuis sa clé (QUALITY), côté serveur.
 */
export async function proxiedMedia(okId: string, key: string | null): Promise<string> {
  assertOkId(okId);
  assertKnownOkId(okId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { variant } = await variantFor(okId, key, attempt > 0);
    // `redirect: 'manual'` : la redirection est examinée AVANT d'être
    // suivie. En 'follow', le trafic atteint déjà l'hôte de destination
    // avant qu'on puisse le refuser — la revalidation arrive trop tard.
    const r = await fetchWithRetry(variant.url, { headers: OK_HEADERS, redirect: 'manual' });
    const finalUrl = r.url || variant.url;
    if (!isAllowedMediaHost(finalUrl)) throw new ProxyError(502, 'redirection refusée');
    if (r.ok) {
      const text = await r.text();
      if (!isValidPlaylist(text)) throw new ProxyError(502, 'playlist média invalide');
      return rewriteMediaPlaylist(text, finalUrl, okId, variant.key);
    }
    // 3xx : on ne suit la redirection que si sa destination est autorisée.
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new ProxyError(502, 'redirection sans cible');
      const next = new URL(loc, variant.url).toString();
      if (!isAllowedMediaHost(next)) throw new ProxyError(502, 'redirection refusée');
      const r2 = await fetchWithRetry(next, { headers: OK_HEADERS, redirect: 'manual' });
      const final2 = r2.url || next;
      if (!isAllowedMediaHost(final2)) throw new ProxyError(502, 'redirection refusée');
      if (!r2.ok) throw new ProxyError(502, `amont HTTP ${r2.status}`);
      const text2 = await r2.text();
      if (!isValidPlaylist(text2)) throw new ProxyError(502, 'playlist média invalide');
      return rewriteMediaPlaylist(text2, final2, okId, variant.key);
    }
    if (![400, 403, 404, 410].includes(r.status) || attempt > 0) throw new ProxyError(502, `amont HTTP ${r.status}`);
  }
  throw new ProxyError(502, 'playlist indisponible');
}

/** Segment .ts : stream binaire avec support Range ; ré-résolution si 4xx (expiration). */
export async function proxiedSegment(okId: string, key: string | null, s: string | null, range: string | null): Promise<Response> {
  assertOkId(okId);
  assertKnownOkId(okId);
  if (!s) throw new ProxyError(400, 'paramètre s manquant');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { variant } = await variantFor(okId, key, attempt > 0);
    // `resolveSegmentUrl` lève une Error simple : on la traduit en 400
    // (erreur du client) plutôt qu'en 502 (erreur de la passerelle), pour
    // que le refus soit explicite sur le statut HTTP.
    let url: string;
    try {
      url = resolveSegmentUrl(s, variant.url);
    } catch (e) {
      throw new ProxyError(400, (e as Error).message);
    }
    if (!isAllowedMediaHost(url)) throw new ProxyError(400, 'hôte non autorisé');
    const headers: Record<string, string> = { ...OK_HEADERS };
    if (range) headers.Range = range;
    // Redirection manuelle : on examine la destination AVANT de la suivre,
    // sinon le segment (1,4 Mo) est déjà téléchargé depuis l'hôte non
    // autorisé au moment où on décide de le refuser.
    const r = await fetchWithRetry(url, { headers, timeoutMs: 60_000, retries: 1, redirect: 'manual' });
    let resp = r;
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new ProxyError(502, 'redirection sans cible');
      const next = new URL(loc, url).toString();
      if (!isAllowedMediaHost(next)) throw new ProxyError(502, 'redirection refusée');
      resp = await fetchWithRetry(next, { headers, timeoutMs: 60_000, retries: 0, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400) throw new ProxyError(502, 'redirection refusée');
    }
    if (resp.ok || resp.status === 206) {
      // La réponse peut avoir été redirigée : on revalide la destination
      // effective avant de la relayer au client (anti-SSRF).
      const finalUrl = resp.url || url;
      if (!isAllowedMediaHost(finalUrl)) throw new ProxyError(502, 'redirection refusée');
      const out = new Headers({
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      for (const h of ['content-length', 'content-range']) {
        const v = resp.headers.get(h);
        if (v) out.set(h, v);
      }
      return new Response(resp.body, { status: resp.status, headers: out });
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
