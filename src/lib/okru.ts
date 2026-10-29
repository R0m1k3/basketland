/**
 * Résolution des flux ok.ru.
 *
 * GET https://ok.ru/videoembed/<id> → attribut `data-options` (JSON échappé HTML) →
 * flashvars.metadata (objet ou chaîne JSON) → `hlsManifestUrl` signée (expires=…, srcAg=CHROME).
 * L'URL expire : on ne la stocke jamais, on la ré-résout à la demande (cache mémoire court).
 */
import { BROWSER_UA, decodeHtmlEntities, fetchText, fetchWithRetry, HttpError } from './http';

export const OK_REFERER = 'https://ok.ru/';
export const OK_HEADERS = { Referer: OK_REFERER, 'User-Agent': BROWSER_UA, Origin: 'https://ok.ru' };

export interface OkEmbedInfo {
  okId: string;
  title: string;
  duration: number | null;
  poster: string | null;
  hlsManifestUrl: string | null;
  status: string;
}

export function isValidOkId(id: string): boolean {
  return /^\d{5,25}$/.test(id);
}

export function parseOkEmbed(html: string, okId: string): OkEmbedInfo {
  const info: OkEmbedInfo = { okId, title: '', duration: null, poster: null, hlsManifestUrl: null, status: '' };
  const m = html.match(/data-options="([^"]+)"/) ?? html.match(/data-options='([^']+)'/);
  if (m) {
    try {
      const opts = JSON.parse(decodeHtmlEntities(m[1]));
      const raw = opts?.flashvars?.metadata;
      const md = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (md) {
        info.hlsManifestUrl = md.hlsManifestUrl ?? md.hlsMasterPlaylistUrl ?? null;
        info.duration = md.movie?.duration ? Number(md.movie.duration) : null;
        info.poster = md.movie?.poster ?? opts?.poster ?? null;
        info.title = String(md.movie?.title ?? '');
        info.status = String(md.movie?.status ?? '');
      }
    } catch {
      /* repli regex ci-dessous */
    }
  }
  if (!info.hlsManifestUrl) {
    const u = decodeHtmlEntities(html).match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
    if (u) info.hlsManifestUrl = u[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  }
  if (info.duration === null) {
    const d = decodeHtmlEntities(html).match(/"duration"\s*:\s*"?(\d+)"?/);
    if (d) info.duration = Number(d[1]);
  }
  return info;
}

/** Timestamp d'expiration (ms) contenu dans une URL signée, si présent. */
export function signedUrlExpiry(url: string): number | null {
  const m = url.match(/[?&/]expires[=/](\d{10,13})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n < 1e12 ? n * 1000 : n;
}

export async function fetchOkEmbed(okId: string): Promise<OkEmbedInfo> {
  if (!isValidOkId(okId)) throw new Error(`okId invalide: ${okId}`);
  const html = await fetchText(`https://ok.ru/videoembed/${okId}`, { headers: { Referer: 'https://basketball-video.com/' } });
  return parseOkEmbed(html, okId);
}

// ------------------------------------------------------------------ cache de résolution

export interface Variant {
  key: string; // QUALITY (sd, hd, …) ou index
  bandwidth: number;
  resolution: string;
  url: string; // URL absolue signée (jamais exposée au client)
}

export interface OkStream {
  okId: string;
  masterUrl: string;
  masterText: string;
  expiresAt: number;
  fetchedAt: number;
  variants: Variant[];
  duration: number | null;
  poster: string | null;
}

export const STREAM_CACHE_TTL_MS = 45_000;
const g = globalThis as unknown as { __okCache?: Map<string, Promise<OkStream>>; __okCacheAt?: Map<string, number> };
const cache = (g.__okCache ??= new Map());
const cacheAt = (g.__okCacheAt ??= new Map());

/** Parse la playlist maître : variantes avec QUALITY/BANDWIDTH/RESOLUTION. */
export function parseMasterVariants(text: string, baseUrl: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const out: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
    if (j >= lines.length) break;
    const uri = lines[j].trim();
    const q = l.match(/QUALITY=([^,]+)/)?.[1];
    out.push({
      key: (q ?? `v${out.length}`).replace(/[^a-zA-Z0-9_-]/g, ''),
      bandwidth: Number(l.match(/[^-]BANDWIDTH=(\d+)/)?.[1] ?? 0),
      resolution: l.match(/RESOLUTION=([^,]+)/)?.[1] ?? '',
      url: new URL(uri, baseUrl).toString(),
    });
    i = j;
  }
  return out;
}

async function doResolve(okId: string): Promise<OkStream> {
  const embed = await fetchOkEmbed(okId);
  if (!embed.hlsManifestUrl) throw new Error(`Pas de flux HLS pour ok.ru/${okId} (statut: ${embed.status || 'inconnu'})`);
  const res = await fetchWithRetry(embed.hlsManifestUrl, { headers: OK_HEADERS });
  if (!res.ok) throw new HttpError(res.status, 'master.m3u8');
  const masterText = await res.text();
  const masterUrl = res.url || embed.hlsManifestUrl;
  return {
    okId,
    masterUrl,
    masterText,
    expiresAt: signedUrlExpiry(embed.hlsManifestUrl) ?? Date.now() + 3600_000,
    fetchedAt: Date.now(),
    variants: parseMasterVariants(masterText, masterUrl),
    duration: embed.duration,
    poster: embed.poster,
  };
}

/**
 * Résout (ou ré-résout) le flux signé. Cache court (45 s) pour ne pas re-résoudre
 * à chaque segment ; `force` contourne le cache (ex. segment en 403 après expiration).
 */
export async function resolveOkStream(okId: string, opts: { force?: boolean } = {}): Promise<OkStream> {
  const at = cacheAt.get(okId) ?? 0;
  const cached = cache.get(okId);
  if (!opts.force && cached && Date.now() - at < STREAM_CACHE_TTL_MS) {
    const s = await cached.catch(() => null);
    if (s && s.expiresAt - Date.now() > 60_000) return s;
  }
  const p = doResolve(okId);
  cache.set(okId, p);
  cacheAt.set(okId, Date.now());
  p.catch(() => {
    if (cache.get(okId) === p) cache.delete(okId);
  });
  return p;
}

export function pickVariant(stream: OkStream, key: string | null | undefined): Variant | undefined {
  if (key) {
    const v = stream.variants.find((x) => x.key === key);
    if (v) return v;
  }
  return undefined;
}

/** Variante la plus légère (utilisée pour l'analyse audio). */
export function lightestVariant(stream: OkStream): Variant | undefined {
  return [...stream.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
}

/**
 * Hôtes autorisés pour les segments (anti-SSRF).
 *
 * Le schéma `https` est exigé : `http:` permettrait de viser un service
 * interne en clair. La liste est volontairement restreinte aux hôtes de
 * média réellement servis par ok.ru.
 */
export function isAllowedMediaHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)(vkuser\.net|okcdn\.ru|mycdn\.me|ok\.ru|vk\.com|userapi\.com|vkuseraudio\.net|vkuservideo\.net)$/.test(
      u.hostname,
    );
  } catch {
    return false;
  }
}
