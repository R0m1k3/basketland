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

/**
 * Suit une redirection en validant la destination AVANT de l'émettre.
 *
 * `fetch` avec `redirect: 'follow'` atteint l'hôte de destination avant
 * qu'on puisse le refuser : pour un segment de 1,4 Mo, le trafic
 * indésirable a déjà eu lieu. On suit donc la redirection à la main, en
 * vérifiant l'hôte et le schéma à chaque étape.
 */
async function followManual(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 60_000,
): Promise<Response> {
  let resp = await fetchWithRetry(url, { headers, timeoutMs, retries: 1, redirect: 'manual' });
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location');
    if (!loc) throw new ProxyError(502, 'redirection sans cible');
    const next = new URL(loc, url).toString();
    if (!isAllowedMediaHost(next)) throw new ProxyError(502, 'redirection refusée');
    // Le corps de la réponse 3xx n'est pas utilisé : on l'annule pour ne pas
    // laisser une connexion ouverte.
    await resp.body?.cancel().catch(() => undefined);
    resp = await fetchWithRetry(next, { headers, timeoutMs, retries: 0, redirect: 'manual' });
    // Un second 3xx n'est pas suivi : on refuse (une chaîne de
    // redirections est un vecteur classique de contournement).
    if (resp.status >= 300 && resp.status < 400) throw new ProxyError(502, 'redirection refusée');
  }
  const finalUrl = resp.url || url;
  if (!isAllowedMediaHost(finalUrl)) throw new ProxyError(502, 'redirection refusée');
  return resp;
}

/**
 * Ressource HLS annexe : clé de déchiffrement (`#EXT-X-KEY`), segment
 * d'initialisation (`#EXT-X-MAP`), ou tout autre fichier cité par une
 * balise média.
 *
 * Ces fichiers ne sont pas des segments `.ts` : ils ont leur propre
 * extension et leur propre dossier. On les relaie donc par une route
 * dédiée, avec les mêmes garanties (https, hôte autorisé, redirection
 * validée avant d'être suivie).
 */
export async function proxiedAsset(okId: string, key: string | null, asset: string | null): Promise<Response> {
  assertOkId(okId);
  assertKnownOkId(okId);
  if (!asset) throw new ProxyError(400, 'paramètre a manquant');
  // Un nom de fichier simple, extension comprise. Pas de chemin, pas de
  // traversée : le dossier est celui de la variante, résolu côté serveur.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(asset)) {
    throw new ProxyError(400, 'nom de ressource invalide');
  }
  const { variant } = await variantFor(okId, key, false);
  const base = variant.url;
  // Le dossier de la variante : même convention que pour les segments.
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  const url = `${dir}${asset}`;
  if (!isAllowedMediaHost(url)) throw new ProxyError(400, 'hôte non autorisé');
  const resp = await followManual(url, { ...OK_HEADERS });
  if (!resp.ok) throw new ProxyError(502, `amont HTTP ${resp.status}`);
  // ok.ru renvoie la playlist pour un nom de fichier inconnu dans ce
  // dossier : on ne doit pas le relayer comme si c'était la ressource.
  const ctype = resp.headers.get('content-type') ?? '';
  if (ctype.includes('mpegurl') || ctype.includes('m3u8')) {
    throw new ProxyError(404, 'ressource introuvable');
  }
  const out = new Headers({
    'Content-Type': ctype || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
  const len = resp.headers.get('content-length');
  if (len) out.set('content-length', len);
  return new Response(resp.body, { status: resp.status, headers: out });
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
    const resp = await followManual(url, headers);
    if (resp.ok || resp.status === 206) {
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
    // Les statuts se lisent sur la réponse FINALE (`resp`), pas sur la
    // réponse 3xx (`r`) : sinon une erreur amont après redirection était
    // rapportée comme « amont HTTP 302 » et la re-résolution prévue
    // (403 = signature expirée) n'était jamais tentée.
    if (resp.status === 416) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': resp.headers.get('content-range') ?? '' },
      });
    }
    if (![400, 403, 404, 410].includes(resp.status) || attempt > 0) {
      throw new ProxyError(502, `amont HTTP ${resp.status}`);
    }
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
