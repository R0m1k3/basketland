/**
 * Logique commune aux routes du proxy vidéo (HLS et MP4 progressif).
 *
 * Fluidité de lecture (le NAS relaie tout le flux) :
 *  - le flux signé reste en cache jusqu'à peu avant son expiration (okru.ts) ;
 *  - les playlists média (VOD, immuables) sont gardées en mémoire ;
 *  - les segments passent par un cache LRU borné en octets, avec
 *    préchargement des segments suivants et dédoublonnage des
 *    téléchargements en vol : le lecteur ne paie plus l'aller-retour vers
 *    ok.ru à chaque segment.
 */
import { BROWSER_UA, fetchWithRetry } from './http';
import * as db from './db';
import {
  bestMp4,
  isAllowedMediaHost,
  isValidOkId,
  OK_HEADERS,
  pickVariant,
  resolveOkStream,
  STREAM_EXPIRY_MARGIN_MS,
  type Mp4Source,
  type OkStream,
  type Variant,
} from './okru';
import {
  isSegmentName,
  isValidPlaylist,
  nextSegmentName,
  resolveSegmentUrl,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  segmentNames,
} from './hls';

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

/** Master : flux en cache tant que la signature est valable, variantes réécrites vers le proxy. */
export async function proxiedMaster(okId: string): Promise<string> {
  assertOkId(okId);
  assertKnownOkId(okId);
  // On réutilise le cache quand la signature est encore valable : forcer la
  // re-résolution à chaque requête amplifie les appels vers ok.ru et
  // augmente le risque de bannissement d'IP.
  let stream = await resolveOkStream(okId, { force: false });
  // Flux en cache sans HLS (MP4 seul) alors que la base annonce du HLS :
  // ok.ru a fini le traitement depuis la dernière résolution.
  if (!stream.masterText) stream = await resolveOkStream(okId, { force: true });
  if (!stream.masterText) throw new ProxyError(404, 'pas de flux HLS (MP4 seul)');
  if (!isValidPlaylist(stream.masterText)) throw new ProxyError(502, 'playlist maître invalide');
  return rewriteMasterPlaylist(stream.masterText, stream.masterUrl, okId);
}

async function variantFor(okId: string, key: string | null, force = false): Promise<{ stream: OkStream; variant: Variant }> {
  let stream = await resolveOkStream(okId, { force });
  let variant = pickVariant(stream, key);
  // Variante absente d'un flux en cache sans HLS (playlist momentanément
  // illisible lors de la dernière résolution) : on re-résout une fois
  // avant d'échouer, sinon une lecture en cours tombait en 404.
  if (!variant && !force && !stream.masterText) {
    stream = await resolveOkStream(okId, { force: true });
    variant = pickVariant(stream, key);
  }
  if (!variant) throw new ProxyError(404, `variante inconnue: ${key}`);
  return { stream, variant };
}

// ------------------------------------------------------------------ playlists média

interface CachedPlaylist {
  /** Playlist déjà réécrite vers le proxy (aucune URL signée dedans). */
  text: string;
  /** Segments de la playlist : bornent le préchargement. */
  names: Set<string>;
  expiresAt: number;
}

const PLAYLIST_CACHE_MAX = 100;

const gp = globalThis as unknown as {
  __okPlaylists?: Map<string, CachedPlaylist>;
  __okPlaylistInflight?: Map<string, Promise<CachedPlaylist>>;
};
const playlists: Map<string, CachedPlaylist> = (gp.__okPlaylists ??= new Map());
const playlistInflight: Map<string, Promise<CachedPlaylist>> = (gp.__okPlaylistInflight ??= new Map());

/**
 * Lit la playlist média amont, en validant toute redirection AVANT de la suivre.
 *
 * Le paramètre `absUrl` a été supprimé : il permettait à l'appelant de
 * faire lire par le proxy une playlist arbitraire d'un hôte autorisé, via
 * notamment une redirection ouverte. La variante est toujours retrouvée
 * depuis sa clé (QUALITY), côté serveur.
 */
async function fetchMediaPlaylist(okId: string, key: string | null): Promise<CachedPlaylist> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { stream, variant } = await variantFor(okId, key, attempt > 0);
    // `redirect: 'manual'` : la redirection est examinée AVANT d'être
    // suivie. En 'follow', le trafic atteint déjà l'hôte de destination
    // avant qu'on puisse le refuser — la revalidation arrive trop tard.
    const r = await followManual(variant.url, { ...OK_HEADERS }, { timeoutMs: 20_000, retries: 2 });
    if (r.ok) {
      const text = await r.text();
      if (!isValidPlaylist(text)) throw new ProxyError(502, 'playlist média invalide');
      return {
        text: rewriteMediaPlaylist(text, r.url || variant.url, okId, variant.key),
        names: new Set(segmentNames(text)),
        expiresAt: stream.expiresAt - STREAM_EXPIRY_MARGIN_MS,
      };
    }
    await r.body?.cancel().catch(() => undefined);
    if (![400, 403, 404, 410].includes(r.status) || attempt > 0) throw new ProxyError(502, `amont HTTP ${r.status}`);
  }
  throw new ProxyError(502, 'playlist indisponible');
}

/**
 * Playlist média : réécrit les segments vers /segment.ts.
 *
 * Une playlist VOD ok.ru ne change pas : elle est gardée en mémoire (par
 * okId + variante) aussi longtemps que la signature du flux, et un seul
 * téléchargement est fait quand plusieurs lecteurs la demandent ensemble.
 * Retente une fois (re-résolution) si la signature a expiré.
 */
export async function proxiedMedia(okId: string, key: string | null): Promise<string> {
  assertOkId(okId);
  assertKnownOkId(okId);
  const ck = `${okId}|${key ?? ''}`;
  const hit = playlists.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.text;
  let p = playlistInflight.get(ck);
  if (!p) {
    p = fetchMediaPlaylist(okId, key).then((pl) => {
      playlists.delete(ck);
      if (playlists.size >= PLAYLIST_CACHE_MAX) playlists.delete(playlists.keys().next().value as string);
      playlists.set(ck, pl);
      return pl;
    });
    const mine = p;
    playlistInflight.set(ck, mine);
    mine.catch(() => undefined).finally(() => {
      if (playlistInflight.get(ck) === mine) playlistInflight.delete(ck);
    });
  }
  return (await p).text;
}

// ------------------------------------------------------------------ requêtes amont

interface UpstreamOpts {
  /** Délai total (corps compris) ; ignoré en mode `streaming`. */
  timeoutMs?: number;
  retries?: number;
  /**
   * Corps de durée illimitée (MP4 d'un match entier) : le délai ne porte
   * que sur l'arrivée des en-têtes, pas sur la lecture du corps.
   */
  streaming?: boolean;
  /** Annulation par le client (déconnexion du navigateur). */
  signal?: AbortSignal;
}

/** Requête sans suivi de redirection, délai limité à l'arrivée des en-têtes. */
async function fetchHeadersTimeout(url: string, headers: Record<string, string>, opts: UpstreamOpts): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('délai amont dépassé')), opts.timeoutMs ?? 20_000);
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  try {
    return await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      redirect: 'manual',
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

function upstreamFetch(url: string, headers: Record<string, string>, opts: UpstreamOpts, retries: number): Promise<Response> {
  if (opts.streaming) return fetchHeadersTimeout(url, headers, opts);
  return fetchWithRetry(url, { headers, timeoutMs: opts.timeoutMs ?? 60_000, retries, redirect: 'manual' });
}

/**
 * Suit une redirection en validant la destination AVANT de l'émettre.
 *
 * `fetch` avec `redirect: 'follow'` atteint l'hôte de destination avant
 * qu'on puisse le refuser : pour un segment de 1,4 Mo, le trafic
 * indésirable a déjà eu lieu. On suit donc la redirection à la main, en
 * vérifiant l'hôte et le schéma à chaque étape.
 */
async function followManual(url: string, headers: Record<string, string>, opts: UpstreamOpts = {}): Promise<Response> {
  let resp = await upstreamFetch(url, headers, opts, opts.retries ?? 1);
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location');
    if (!loc) throw new ProxyError(502, 'redirection sans cible');
    const next = new URL(loc, url).toString();
    if (!isAllowedMediaHost(next)) throw new ProxyError(502, 'redirection refusée');
    // Le corps de la réponse 3xx n'est pas utilisé : on l'annule pour ne pas
    // laisser une connexion ouverte.
    await resp.body?.cancel().catch(() => undefined);
    resp = await upstreamFetch(next, headers, opts, 0);
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
  // Attention à la casse : ok.ru répond `application/x-mpegURL` (avec la
  // capitalisation d'origine), un test sur `includes('mpegurl')` ne
  // matchait donc jamais.
  const ctype = (resp.headers.get('content-type') ?? '').toLowerCase();
  if (isPlaylistType(ctype)) {
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

function isPlaylistType(ctype: string): boolean {
  const c = ctype.toLowerCase();
  return c.includes('mpegurl') || c.includes('m3u8');
}

// ------------------------------------------------------------------ cache des segments

/**
 * Cache LRU borné en OCTETS (et non en nombre d'entrées : un segment 1080p
 * pèse dix fois un segment 240p). L'entrée la moins récemment lue est
 * évincée la première ; une entrée plus grosse que le budget n'est pas
 * mise en cache.
 */
export class ByteLru<V> {
  private map = new Map<string, { v: V; size: number }>();
  private used = 0;

  constructor(public readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // Réinsertion = passage en tête (la Map garde l'ordre d'insertion).
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  /** Présence, sans modifier l'ordre d'éviction. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, v: V, size: number): boolean {
    this.delete(key);
    if (size > this.maxBytes) return false;
    this.map.set(key, { v, size });
    this.used += size;
    while (this.used > this.maxBytes) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
    return true;
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.used -= e.size;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Téléchargement d'un segment partagé entre plusieurs lecteurs.
 *
 * Le corps amont est lu UNE fois ; chaque requête cliente (et le cache)
 * relit les morceaux reçus au fil de l'eau. Le client reçoit donc les
 * premiers octets sans attendre la fin du téléchargement, et une requête
 * arrivée pendant un préchargement le rejoint au lieu d'en lancer un second.
 */
export class SharedDownload {
  readonly chunks: Uint8Array[] = [];
  received = 0;
  done = false;
  error: unknown = null;
  readonly settled: Promise<void>;
  private settle!: () => void;
  private waiters: (() => void)[] = [];

  constructor(public readonly contentLength: number | null) {
    this.settled = new Promise((r) => (this.settle = r));
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.received += chunk.length;
    this.wake();
  }

  finish(err?: unknown): void {
    if (this.done) return;
    if (err !== undefined) this.error = err;
    this.done = true;
    this.wake();
    this.settle();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Lecture depuis le début ; peut être appelée autant de fois que nécessaire. */
  stream(): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        while (i >= this.chunks.length && !this.done) await new Promise<void>((r) => this.waiters.push(r));
        if (i < this.chunks.length) ctrl.enqueue(this.chunks[i++]);
        else if (this.error) ctrl.error(this.error);
        else ctrl.close();
      },
    });
  }

  /** Corps complet (après `settled`, sans erreur). */
  bytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.received);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/** Budget du cache de segments (Mo), réglable par SEGMENT_CACHE_MB ; 0 le désactive. */
function segmentCacheBytes(): number {
  const raw = Number(process.env.SEGMENT_CACHE_MB);
  const mb = process.env.SEGMENT_CACHE_MB !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 192;
  return Math.floor(mb * 1024 * 1024);
}

/** Nombre de segments préchargés après celui demandé. */
export const PREFETCH_AHEAD = 4;
/** Téléchargements de préchargement simultanés (la ligne du NAS est partagée). */
export const PREFETCH_CONCURRENCY = 2;
/** File d'attente bornée : au-delà, les plus anciens préchargements sont abandonnés. */
const PREFETCH_QUEUE_MAX = 32;

interface PrefetchTask {
  okId: string;
  key: string;
  s: string;
  group: string;
}

const gs = globalThis as unknown as {
  __okSegCache?: ByteLru<Uint8Array<ArrayBuffer>>;
  __okSegInflight?: Map<string, Promise<SharedDownload>>;
  __okPrefetch?: { queue: PrefetchTask[]; active: number };
};
const segCache: ByteLru<Uint8Array<ArrayBuffer>> = (gs.__okSegCache ??= new ByteLru(segmentCacheBytes()));
const segInflight: Map<string, Promise<SharedDownload>> = (gs.__okSegInflight ??= new Map());
const prefetch = (gs.__okPrefetch ??= { queue: [], active: 0 });

function segKey(okId: string, key: string, s: string): string {
  return `${okId}|${key}|${s}`;
}

/**
 * Ouvre le segment chez ok.ru ; la promesse est résolue dès que les
 * en-têtes amont sont valides, le corps continue d'arriver dans le
 * `SharedDownload`. Ré-résout le flux (dédoublonné) si la signature a expiré.
 */
async function openSegment(okId: string, key: string, s: string, ck: string): Promise<SharedDownload> {
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
    const resp = await followManual(url, { ...OK_HEADERS });
    if (resp.ok && resp.body) {
      // ok.ru répond par la playlist (200) pour un nom inconnu, par exemple
      // un préchargement au-delà du dernier segment : ce n'est pas un segment.
      if (isPlaylistType(resp.headers.get('content-type') ?? '')) {
        await resp.body.cancel().catch(() => undefined);
        throw new ProxyError(404, 'segment introuvable');
      }
      const len = Number(resp.headers.get('content-length'));
      const dl = new SharedDownload(Number.isFinite(len) && len > 0 ? len : null);
      void pump(dl, resp.body, ck);
      return dl;
    }
    await resp.body?.cancel().catch(() => undefined);
    // Les statuts se lisent sur la réponse FINALE (après redirection) :
    // 403 = signature expirée → une re-résolution, puis on abandonne.
    if (![400, 403, 404, 410].includes(resp.status) || attempt > 0) {
      throw new ProxyError(502, `amont HTTP ${resp.status}`);
    }
  }
  throw new ProxyError(502, 'segment indisponible');
}

/**
 * Diagnostic : un segment qui met plus de `SLOW_SEGMENT_MS` à arriver
 * d'ok.ru est signalé dans les logs (au plus une ligne toutes les 20 s),
 * avec son débit — pour distinguer un ok.ru lent d'un problème local.
 */
const SLOW_SEGMENT_MS = 4_000;
let lastSlowLog = 0;
function logSlowSegment(ck: string, bytes: number, ms: number): void {
  if (ms < SLOW_SEGMENT_MS || Date.now() - lastSlowLog < 20_000) return;
  lastSlowLog = Date.now();
  const kbps = Math.round((bytes * 8) / ms);
  console.log(`[vidéo] segment lent depuis ok.ru : ${Math.round(bytes / 1024)} Ko en ${(ms / 1000).toFixed(1)} s (${kbps} kb/s) — ${ck.split('|').slice(1).join(' ')}`);
}

/** Lit le corps amont dans le téléchargement partagé, puis le range au cache. */
async function pump(dl: SharedDownload, body: ReadableStream<Uint8Array>, ck: string): Promise<void> {
  const t0 = Date.now();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) dl.push(value);
    }
    if (dl.contentLength !== null && dl.received !== dl.contentLength) {
      throw new Error(`segment tronqué (${dl.received}/${dl.contentLength} octets)`);
    }
    // Rangé AVANT `finish` : une requête qui suit la fin du téléchargement
    // trouve le segment en cache.
    segCache.set(ck, dl.bytes(), dl.received);
    dl.finish();
    logSlowSegment(ck, dl.received, Date.now() - t0);
  } catch (e) {
    dl.finish(e);
  }
}

/** Téléchargement du segment, partagé avec celui déjà en vol s'il existe. */
function segmentDownload(okId: string, key: string, s: string): Promise<SharedDownload> {
  const ck = segKey(okId, key, s);
  const existing = segInflight.get(ck);
  if (existing) return existing;
  const p = openSegment(okId, key, s, ck);
  segInflight.set(ck, p);
  const release = () => {
    if (segInflight.get(ck) === p) segInflight.delete(ck);
  };
  p.then((dl) => dl.settled.then(release), release);
  return p;
}

/**
 * Programme le préchargement des segments N+1..N+PREFETCH_AHEAD.
 *
 * Les préchargements encore en attente pour la même variante sont
 * remplacés : après un seek, ceux de l'ancienne position ne servent plus.
 */
function schedulePrefetch(okId: string, key: string, s: string): void {
  if (PREFETCH_AHEAD <= 0 || segCache.maxBytes <= 0) return;
  const group = `${okId}|${key}`;
  const names = playlists.get(group)?.names;
  prefetch.queue = prefetch.queue.filter((t) => t.group !== group);
  let name: string | null = s;
  for (let i = 0; i < PREFETCH_AHEAD; i++) {
    name = name ? nextSegmentName(name) : null;
    // Au-delà du dernier segment connu de la playlist : rien à précharger.
    if (!name || (names && !names.has(name))) break;
    const ck = segKey(okId, key, name);
    if (segCache.has(ck) || segInflight.has(ck)) continue;
    prefetch.queue.push({ okId, key, s: name, group });
  }
  if (prefetch.queue.length > PREFETCH_QUEUE_MAX) prefetch.queue = prefetch.queue.slice(-PREFETCH_QUEUE_MAX);
  drainPrefetch();
}

function drainPrefetch(): void {
  while (prefetch.active < PREFETCH_CONCURRENCY && prefetch.queue.length) {
    const t = prefetch.queue.shift()!;
    const ck = segKey(t.okId, t.key, t.s);
    if (segCache.has(ck) || segInflight.has(ck)) continue;
    prefetch.active++;
    segmentDownload(t.okId, t.key, t.s)
      .then((dl) => dl.settled)
      .catch(() => undefined)
      .finally(() => {
        prefetch.active--;
        drainPrefetch();
      });
  }
}

/** Vide les caches du proxy (tests). */
export function clearProxyCaches(): void {
  segCache.clear();
  segInflight.clear();
  playlists.clear();
  playlistInflight.clear();
  prefetch.queue = [];
  prefetch.active = 0;
  mp4Pins.clear();
}

/** Attend la fin des préchargements en cours (tests). */
export async function prefetchIdle(): Promise<void> {
  while (prefetch.active > 0 || prefetch.queue.length || segInflight.size) {
    await Promise.allSettled([...segInflight.values()].map((p) => p.then((dl) => dl.settled)));
    await new Promise((r) => setTimeout(r, 0));
  }
}

function segmentHeaders(len: number | null): Headers {
  const h = new Headers({
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  });
  if (len !== null) h.set('content-length', String(len));
  return h;
}

/**
 * Segment .ts.
 *
 * Sans en-tête Range (cas de hls.js) : servi depuis le cache, ou depuis le
 * téléchargement en vol, ou téléchargé et mis en cache ; dans tous les cas
 * les segments suivants sont préchargés. Avec Range : relais direct.
 */
export async function proxiedSegment(okId: string, key: string | null, s: string | null, range: string | null): Promise<Response> {
  assertOkId(okId);
  assertKnownOkId(okId);
  if (!s) throw new ProxyError(400, 'paramètre s manquant');
  if (!isSegmentName(s)) throw new ProxyError(400, `nom de segment invalide: ${s}`);
  if (range) return passthroughSegment(okId, key, s, range);
  if (!key) throw new ProxyError(404, 'variante inconnue: null');

  schedulePrefetch(okId, key, s);
  const cached = segCache.get(segKey(okId, key, s));
  if (cached) return new Response(cached, { status: 200, headers: segmentHeaders(cached.length) });
  const dl = await segmentDownload(okId, key, s);
  return new Response(dl.stream(), { status: 200, headers: segmentHeaders(dl.contentLength) });
}

/** Relais direct d'une requête partielle (Range), sans cache. */
async function passthroughSegment(okId: string, key: string | null, s: string, range: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { variant } = await variantFor(okId, key, attempt > 0);
    let url: string;
    try {
      url = resolveSegmentUrl(s, variant.url);
    } catch (e) {
      throw new ProxyError(400, (e as Error).message);
    }
    if (!isAllowedMediaHost(url)) throw new ProxyError(400, 'hôte non autorisé');
    const resp = await followManual(url, { ...OK_HEADERS, Range: range });
    if (resp.ok || resp.status === 206) {
      const out = segmentHeaders(null);
      for (const h of ['content-length', 'content-range']) {
        const v = resp.headers.get(h);
        if (v) out.set(h, v);
      }
      return new Response(resp.body, { status: resp.status, headers: out });
    }
    await resp.body?.cancel().catch(() => undefined);
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

// ------------------------------------------------------------------ MP4 progressif

/**
 * Qualité MP4 épinglée par okId.
 *
 * Le navigateur lit un MP4 par une succession de requêtes Range sur la
 * MÊME URL : si la qualité changeait entre deux requêtes (ok.ru vient de
 * produire le `hd`), les octets demandés viendraient d'un autre fichier et
 * la lecture casserait. On garde donc la qualité choisie tant qu'elle est
 * utilisée ; après MP4_PIN_IDLE_MS sans requête, on reprend la meilleure.
 */
const MP4_PIN_IDLE_MS = 15 * 60_000;
const gm = globalThis as unknown as { __okMp4Pins?: Map<string, { name: string; lastUsed: number }> };
const mp4Pins: Map<string, { name: string; lastUsed: number }> = (gm.__okMp4Pins ??= new Map());

function chooseMp4(okId: string, stream: OkStream): Mp4Source | undefined {
  const now = Date.now();
  const pin = mp4Pins.get(okId);
  if (pin && now - pin.lastUsed < MP4_PIN_IDLE_MS) {
    const same = stream.mp4.find((m) => m.name === pin.name);
    if (same) {
      pin.lastUsed = now;
      return same;
    }
  }
  const best = bestMp4(stream.mp4);
  if (best) {
    if (mp4Pins.size >= 200) {
      for (const [k, v] of mp4Pins) if (now - v.lastUsed >= MP4_PIN_IDLE_MS) mp4Pins.delete(k);
    }
    mp4Pins.set(okId, { name: best.name, lastUsed: now });
  }
  return best;
}

/** En-tête Range accepté tel quel (`bytes=…`) ; tout autre format est ignoré. */
function sanitizeRange(range: string | null): string | null {
  return range && /^bytes=[\d\s,-]+$/.test(range) ? range : null;
}

/**
 * MP4 progressif (vidéo dont ok.ru n'a produit que des MP4, pas encore de HLS).
 *
 * Relais de la meilleure qualité disponible (full > hd > sd > low > lowest >
 * mobile), avec passage des en-têtes Range dans les deux sens (206,
 * Content-Range, Content-Length, Accept-Ranges) pour que le navigateur
 * puisse chercher dans la vidéo. Mêmes garde-fous que les segments : hôte
 * autorisé, redirection validée avant d'être suivie, okId connu en base.
 * Une signature expirée (403/410) déclenche une re-résolution de l'embed.
 */
export async function proxiedMp4(okId: string, rangeIn: string | null, signal?: AbortSignal): Promise<Response> {
  assertOkId(okId);
  assertKnownOkId(okId);
  const range = sanitizeRange(rangeIn);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = await resolveOkStream(okId, { force: attempt > 0 });
    const src = chooseMp4(okId, stream);
    if (!src) throw new ProxyError(404, 'pas de MP4 pour ce replay');
    if (!isAllowedMediaHost(src.url)) throw new ProxyError(502, 'hôte non autorisé');
    const headers: Record<string, string> = { ...OK_HEADERS };
    if (range) headers.Range = range;
    // Corps de plusieurs Go lu au rythme du lecteur : pas de délai total.
    const resp = await followManual(src.url, headers, { streaming: true, timeoutMs: 20_000, signal });
    if (resp.ok) {
      const ctype = (resp.headers.get('content-type') ?? '').toLowerCase();
      const out = new Headers({
        'Content-Type': ctype.startsWith('video/') ? ctype : 'video/mp4',
        'Accept-Ranges': 'bytes',
        // La qualité servie peut changer d'une session à l'autre : pas de
        // cache navigateur qui mélangerait les octets de deux fichiers.
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      for (const h of ['content-length', 'content-range']) {
        const v = resp.headers.get(h);
        if (v) out.set(h, v);
      }
      return new Response(resp.body, { status: resp.status, headers: out });
    }
    await resp.body?.cancel().catch(() => undefined);
    if (resp.status === 416) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': resp.headers.get('content-range') ?? '', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (![403, 410].includes(resp.status) || attempt > 0) throw new ProxyError(502, `amont HTTP ${resp.status}`);
  }
  throw new ProxyError(502, 'MP4 indisponible');
}

export function proxyErrorResponse(e: unknown): Response {
  const status = e instanceof ProxyError ? e.status : 502;
  return new Response(JSON.stringify({ error: (e as Error).message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
