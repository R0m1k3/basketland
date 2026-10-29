/**
 * Résolution des flux ok.ru.
 *
 * GET https://ok.ru/videoembed/<id> → attribut `data-options` (JSON échappé HTML) →
 * flashvars.metadata (objet ou chaîne JSON) → `hlsManifestUrl` signée (expires=…, srcAg=CHROME)
 * et `videos` (MP4 progressifs par qualité).
 *
 * Tant qu'ok.ru n'a pas fini de traiter une vidéo, l'embed n'a PAS de
 * `hlsManifestUrl` : seule la qualité « mobile » existe, en MP4 progressif
 * (`videos: [{ name: 'mobile', url: 'https://…okcdn.ru/?expires=…&type=4…' }]`).
 * Ce MP4 est lisible : on le relaie plutôt que de déclarer le replay absent.
 *
 * Les URL signées vivent ~24 h (`expires`) : on ne les stocke jamais en base,
 * on les garde en mémoire jusqu'à peu avant l'expiration (voir `resolveOkStream`).
 */
import { BROWSER_UA, decodeHtmlEntities, fetchText, fetchWithRetry, HttpError } from './http';
import { parseMasterVariants as parseMasterVariantsHls } from './hls';

export const OK_REFERER = 'https://ok.ru/';
export const OK_HEADERS = { Referer: OK_REFERER, 'User-Agent': BROWSER_UA, Origin: 'https://ok.ru' };

export interface OkEmbedInfo {
  okId: string;
  title: string;
  duration: number | null;
  poster: string | null;
  hlsManifestUrl: string | null;
  /** MP4 progressifs lisibles (qualités `disallowed` exclues), dans l'ordre d'ok.ru. */
  mp4: Mp4Source[];
  status: string;
}

/** Un MP4 progressif signé d'ok.ru (`name` = mobile, lowest, low, sd, hd, full…). */
export interface Mp4Source {
  name: string;
  url: string;
}

/**
 * Extrait les MP4 du champ `videos` des métadonnées.
 *
 * On écarte les entrées `disallowed: true` (qualité listée mais refusée par
 * ok.ru) et toute URL qui n'est pas en https : elle serait de toute façon
 * refusée par le proxy (anti-SSRF).
 */
export function parseOkVideos(raw: unknown): Mp4Source[] {
  if (!Array.isArray(raw)) return [];
  const out: Mp4Source[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const { name, url, disallowed } = v as { name?: unknown; url?: unknown; disallowed?: unknown };
    if (disallowed === true || typeof name !== 'string' || typeof url !== 'string') continue;
    if (!/^https:\/\//.test(url) || out.some((o) => o.name === name)) continue;
    out.push({ name, url });
  }
  return out;
}

export function isValidOkId(id: string): boolean {
  return /^\d{5,25}$/.test(id);
}

export function parseOkEmbed(html: string, okId: string): OkEmbedInfo {
  const info: OkEmbedInfo = { okId, title: '', duration: null, poster: null, hlsManifestUrl: null, mp4: [], status: '' };
  const m = html.match(/data-options="([^"]+)"/) ?? html.match(/data-options='([^']+)'/);
  if (m) {
    try {
      const opts = JSON.parse(decodeHtmlEntities(m[1]));
      const raw = opts?.flashvars?.metadata;
      const md = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (md) {
        info.hlsManifestUrl = md.hlsManifestUrl ?? md.hlsMasterPlaylistUrl ?? null;
        info.mp4 = parseOkVideos(md.videos);
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
  /** URL de la playlist maîtresse ; '' quand ok.ru n'a pas (encore) de HLS. */
  masterUrl: string;
  /** Contenu de la playlist maîtresse ; '' sans HLS. */
  masterText: string;
  expiresAt: number;
  fetchedAt: number;
  /** Variantes HLS ; vide sans HLS. */
  variants: Variant[];
  /**
   * MP4 progressifs signés (qualités `disallowed` exclues). Seule source
   * lisible tant qu'ok.ru n'a produit que la qualité « mobile ».
   */
  mp4: { name: string; url: string }[];
  /**
   * ok.ru annonce un HLS mais sa playlist n'a pas pu être lue (erreur réseau
   * passagère) : le flux est servi en MP4 en attendant, et retenté vite.
   */
  hlsError?: boolean;
  duration: number | null;
  poster: string | null;
}

/**
 * Le flux résolu est gardé jusqu'à `expiresAt - STREAM_EXPIRY_MARGIN_MS`.
 *
 * Avant, le cache ne vivait que 45 s : toutes les 45 s, une requête de
 * segment déclenchait une re-résolution complète (page embed + master, 1 à
 * 3 s) que toutes les requêtes concurrentes attendaient — d'où un trou
 * dans le buffer du lecteur. Les URL signées vivent ~24 h : on les garde.
 */
export const STREAM_EXPIRY_MARGIN_MS = 5 * 60_000;
/** Rafraîchissement en arrière-plan (stale-while-revalidate) quand il reste moins que ça. */
export const STREAM_REFRESH_BEFORE_MS = 30 * 60_000;
/**
 * Un flux MP4 seul est revérifié plus souvent (en arrière-plan) : dès
 * qu'ok.ru a fini le traitement, le HLS apparaît et doit être servi.
 */
export const MP4_ONLY_REFRESH_MS = 10 * 60_000;
/**
 * Une résolution forcée (segment en 403) réutilise un flux résolu il y a
 * moins de FORCE_DEDUP_MS : plusieurs segments en 403 simultanés ne
 * doivent déclencher qu'UNE résolution.
 */
export const FORCE_DEDUP_MS = 10_000;
/**
 * Un HLS annoncé mais momentanément illisible (`hlsError`) est retenté
 * après ce délai, et non après MP4_ONLY_REFRESH_MS : sans cela, une seule
 * erreur réseau faisait servir la qualité MP4 (ou des 404 au lecteur HLS)
 * pendant dix minutes.
 */
export const HLS_ERROR_RETRY_MS = 30_000;
/** Durée de vie supposée quand l'URL ne porte pas de champ `expires`. */
const DEFAULT_LIFETIME_MS = 3600_000;

interface StreamEntry {
  stream: OkStream | null;
  /** Résolution en cours : une seule à la fois par okId. */
  inflight: Promise<OkStream> | null;
}
const g = globalThis as unknown as { __okStreams?: Map<string, StreamEntry> };
const streams: Map<string, StreamEntry> = (g.__okStreams ??= new Map());

/**
 * Parse les variantes d'une playlist maîtresse ok.ru.
 *
 * Delegue au parseur canonique de `hls.ts` : les deux chemins (réécriture de
 * la playlist pour le proxy et liste des variantes pour l'API) doivent
 * produire EXACTEMENT les mêmes clés, sinon le client demanderait une
 * qualité `sd` que le serveur ne retrouve pas.
 */
export function parseMasterVariants(text: string, baseUrl: string): Variant[] {
  return parseMasterVariantsHls(text, baseUrl).map((v) => ({
    key: v.key,
    bandwidth: Number(v.inf.match(/[^-]BANDWIDTH=(\d+)/)?.[1] ?? 0),
    resolution: v.inf.match(/RESOLUTION=([^,]+)/)?.[1] ?? '',
    url: v.url,
  }));
}

async function doResolve(okId: string): Promise<OkStream> {
  const embed = await fetchOkEmbed(okId);
  let masterText = '';
  let masterUrl = '';
  let variants: Variant[] = [];
  let hlsError = false;
  if (embed.hlsManifestUrl) {
    try {
      const res = await fetchWithRetry(embed.hlsManifestUrl, { headers: OK_HEADERS });
      if (!res.ok) throw new HttpError(res.status, 'master.m3u8');
      masterText = await res.text();
      masterUrl = res.url || embed.hlsManifestUrl;
      variants = parseMasterVariants(masterText, masterUrl);
    } catch (e) {
      // Sans MP4 de repli, un master illisible est fatal ; sinon on sert le MP4.
      if (!embed.mp4.length) throw e;
      hlsError = true;
      masterText = '';
      masterUrl = '';
      variants = [];
    }
  } else if (!embed.mp4.length) {
    throw new Error(`Pas de flux pour ok.ru/${okId}, ni HLS ni MP4 (statut: ${embed.status || 'inconnu'})`);
  }
  const signed = embed.hlsManifestUrl ?? embed.mp4[0]?.url ?? '';
  return {
    okId,
    masterUrl,
    masterText,
    expiresAt: signedUrlExpiry(signed) ?? Date.now() + DEFAULT_LIFETIME_MS,
    fetchedAt: Date.now(),
    variants,
    mp4: embed.mp4,
    hlsError,
    duration: embed.duration,
    poster: embed.poster,
  };
}

function entryFor(okId: string): StreamEntry {
  let e = streams.get(okId);
  if (!e) {
    // Purge des flux expirés : la Map vit aussi longtemps que le processus.
    if (streams.size >= 200) {
      const now = Date.now();
      for (const [k, v] of streams) if (!v.inflight && (!v.stream || v.stream.expiresAt <= now)) streams.delete(k);
    }
    e = { stream: null, inflight: null };
    streams.set(okId, e);
  }
  return e;
}

/** Lance UNE résolution pour cet okId (ou rejoint celle en cours). */
function startResolve(okId: string, e: StreamEntry): Promise<OkStream> {
  if (e.inflight) return e.inflight;
  const p = doResolve(okId).then((s) => {
    e.stream = s;
    return s;
  });
  e.inflight = p;
  // Un échec ne vide pas `e.stream` : un flux encore valable reste servi.
  p.catch(() => undefined).finally(() => {
    if (e.inflight === p) e.inflight = null;
  });
  return p;
}

function shouldRefresh(s: OkStream, now: number): boolean {
  if (s.expiresAt - now < STREAM_REFRESH_BEFORE_MS) return true;
  if (s.hlsError) return now - s.fetchedAt > HLS_ERROR_RETRY_MS;
  return !s.masterText && now - s.fetchedAt > MP4_ONLY_REFRESH_MS;
}

/**
 * Résout le flux signé, avec cache jusqu'à peu avant l'expiration de la signature.
 *
 * - flux valable : servi immédiatement ; s'il approche de l'expiration (ou
 *   s'il n'a que du MP4), un rafraîchissement part en arrière-plan ;
 * - flux expiré ou absent : résolution, partagée par tous les appelants ;
 * - `force` (ex. segment en 403) : contourne le cache, mais rejoint une
 *   résolution en cours, et réutilise un flux résolu il y a moins de
 *   FORCE_DEDUP_MS.
 */
export async function resolveOkStream(okId: string, opts: { force?: boolean } = {}): Promise<OkStream> {
  const e = entryFor(okId);
  const now = Date.now();
  const s = e.stream;
  if (opts.force) {
    if (e.inflight) return e.inflight;
    if (s && now - s.fetchedAt < FORCE_DEDUP_MS) return s;
    return startResolve(okId, e);
  }
  if (s && now < s.expiresAt - STREAM_EXPIRY_MARGIN_MS) {
    if (shouldRefresh(s, now)) startResolve(okId, e).catch(() => undefined);
    return s;
  }
  return startResolve(okId, e);
}

/** Vide le cache des flux (tests). */
export function clearOkStreamCache(): void {
  streams.clear();
}

/** Ordre de préférence des MP4 ok.ru (meilleure qualité d'abord). */
export const MP4_QUALITY_ORDER = ['full', 'hd', 'sd', 'low', 'lowest', 'mobile'] as const;

function mp4Rank(name: string): number {
  const i = (MP4_QUALITY_ORDER as readonly string[]).indexOf(name);
  return i < 0 ? MP4_QUALITY_ORDER.length : i;
}

/** Meilleur MP4 disponible (full > hd > sd > low > lowest > mobile, inconnus en dernier). */
export function bestMp4(sources: readonly Mp4Source[]): Mp4Source | undefined {
  return [...sources].sort((a, b) => mp4Rank(a.name) - mp4Rank(b.name))[0];
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
