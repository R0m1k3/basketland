/**
 * Logique commune aux routes du proxy vidéo (HLS et MP4 progressif).
 *
 * Fluidité de lecture (le NAS relaie tout le flux) :
 *  - le flux signé reste en cache jusqu'à peu avant son expiration (okru.ts) ;
 *  - les playlists média (VOD, immuables) sont gardées en mémoire ;
 *  - préchargement profond (≈ 90 s de vidéo au-delà du dernier segment
 *    demandé par le lecteur), du segment le plus urgent au plus lointain, qui
 *    suit la qualité réellement lue (un changement de qualité abandonne
 *    l'ancienne) et qu'aucune requête ne peut annuler ;
 *  - les segments passent par un cache borné en octets qui garde en priorité
 *    les segments À VENIR de chaque lecture : les segments déjà lus partent
 *    les premiers ;
 *  - chaque téléchargement amont est surveillé : sans un octet pendant
 *    SEGMENT_STALL_MS (ou nettement trop lent), il est coupé et repris là où
 *    il en était (requête Range) sur une connexion neuve, sans que le
 *    lecteur voie la coupure ;
 *  - téléchargements en vol partagés, connexions persistantes vers ok.ru :
 *    le lecteur ne paie plus l'aller-retour vers ok.ru à chaque segment.
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
  /** Durée moyenne d'un segment (s) : convertit l'avance de préchargement en segments. */
  segSec: number;
  expiresAt: number;
}

/** Durée supposée d'un segment quand la playlist n'est pas (encore) connue (ok.ru : ~6 s). */
const DEFAULT_SEGMENT_SEC = 6;

/** Durée moyenne des segments d'une playlist média (#EXTINF), à défaut #EXT-X-TARGETDURATION. */
export function averageSegmentSec(text: string): number {
  let sum = 0;
  let n = 0;
  for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  if (n) return sum / n;
  const target = Number(text.match(/#EXT-X-TARGETDURATION:\s*(\d+)/)?.[1]);
  return target > 0 ? target : DEFAULT_SEGMENT_SEC;
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
        segSec: averageSegmentSec(text),
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
  return (await loadPlaylist(okId, key)).text;
}

/**
 * Playlist média depuis le cache, ou lue une seule fois chez ok.ru.
 * Sert aussi au préchargement : ses noms de segments bornent la fenêtre et
 * ses durées la convertissent en nombre de segments.
 */
function loadPlaylist(okId: string, key: string | null): Promise<CachedPlaylist> {
  const ck = `${okId}|${key ?? ''}`;
  const hit = playlists.get(ck);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit);
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
  return p;
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

/**
 * Connexions persistantes vers ok.ru.
 *
 * Le client HTTP de Node (undici) ferme une connexion inactive au bout de
 * 4 s quand le serveur n'annonce pas de délai `Keep-Alive` (cas des CDN
 * d'ok.ru) : en lecture établie, un segment toutes les ~6 s rouvrait donc
 * une connexion TCP + TLS à chaque fois. Un agent dédié les garde 30 s.
 *
 * Node n'expose pas la classe `Agent` d'undici sans ajouter la dépendance :
 * on reprend le constructeur de l'agent global, créé au premier `fetch`.
 * Si l'agent global n'est pas un `Agent` simple (proxy configuré…) ou pas
 * encore créé, on garde le comportement par défaut.
 */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const ga = globalThis as unknown as { __okAgent?: object | null } & Record<symbol, unknown>;

export function okDispatcher(): object | undefined {
  if (ga.__okAgent !== undefined) return ga.__okAgent ?? undefined;
  try {
    const global = ga[UNDICI_GLOBAL_DISPATCHER] as { constructor?: { name?: string } } | undefined;
    const Agent = global?.constructor as (new (opts: object) => object) | undefined;
    if (!Agent || Agent.name !== 'Agent') return undefined; // réessayé au prochain appel
    ga.__okAgent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000 });
  } catch {
    ga.__okAgent = null;
  }
  return ga.__okAgent ?? undefined;
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
  const dispatcher = okDispatcher();
  try {
    return await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      redirect: 'manual',
      signal: ctrl.signal,
      cache: 'no-store',
      // Option propre au fetch de Node (undici), absente du type standard.
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
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

// ------------------------------------------------------------------ réglages

/** Nombre lu dans l'environnement ; défaut si absent, invalide ou sous le minimum. */
function envNumber(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return def;
  return Math.min(n, max);
}

/**
 * Budget par défaut du cache de segments (Mo). 90 s de 1080p60 ok.ru pèsent
 * ~70 Mo (~100 Mo en pointe) : 512 Mo laissent deux à trois lectures
 * simultanées garder toute leur avance, plus les segments déjà lus.
 */
export const DEFAULT_SEGMENT_CACHE_MB = 512;

/** Budget du cache de segments (octets) : SEGMENT_CACHE_MB ; 0 le désactive. */
function segmentCacheBytes(): number {
  return Math.floor(envNumber('SEGMENT_CACHE_MB', DEFAULT_SEGMENT_CACHE_MB, 0, 16_384) * 1024 * 1024);
}

/** Réglages du préchargement, relus à chaque usage. */
export function prefetchSettings(): { aheadSec: number; concurrency: number } {
  return {
    /** Avance visée, en secondes de vidéo au-delà du dernier segment demandé par le lecteur (0 : pas de préchargement). */
    aheadSec: envNumber('PREFETCH_AHEAD_SEC', 90, 0, 900),
    /** Téléchargements de préchargement simultanés (la ligne du NAS est partagée). */
    concurrency: Math.floor(envNumber('PREFETCH_CONCURRENCY', 3, 1, 8)),
  };
}

/** Plafond de la fenêtre de préchargement, quelle que soit la durée des segments. */
export const PREFETCH_MAX_SEGMENTS = 30;
/**
 * Part du cache que les segments à venir (toutes lectures confondues)
 * peuvent occuper : au-delà, le préchargement attend que le lecteur
 * avance, plutôt que d'évincer ce qu'il a lui-même préparé.
 */
export const PREFETCH_BUDGET_SHARE = 0.6;

/** Taille de la fenêtre (en segments) pour des segments de `segSec` secondes. */
export function prefetchWindow(segSec: number): number {
  const { aheadSec } = prefetchSettings();
  if (aheadSec <= 0) return 0;
  const sec = Number.isFinite(segSec) && segSec > 0 ? segSec : DEFAULT_SEGMENT_SEC;
  return Math.min(PREFETCH_MAX_SEGMENTS, Math.max(1, Math.ceil(aheadSec / sec)));
}

/** Surveillance des téléchargements amont, relue à chaque segment. */
export function downloadSettings(): { stallMs: number; headersMs: number; retries: number } {
  const stallMs = envNumber('SEGMENT_STALL_MS', 5_000, 100, 60_000);
  return {
    /** Aucun octet reçu pendant ce délai : connexion coupée, reprise là où elle en était. */
    stallMs,
    /** Délai d'arrivée des en-têtes (connexion + TLS + réponse d'ok.ru). */
    headersMs: Math.round(stallMs * 1.6),
    /** Reprises au plus par segment (blocage, coupure, erreur réseau ou 5xx). */
    retries: Math.floor(envNumber('SEGMENT_RETRIES', 4, 0, 10)),
  };
}

/**
 * Un segment dont l'arrivée, au débit constaté, dépasserait ce multiple de
 * sa durée est repris sur une connexion neuve (une seule fois par segment) :
 * une connexion TCP dégradée (pertes, nœud du CDN saturé) ne s'en remet
 * souvent pas d'elle-même, une nouvelle repart à plein débit.
 */
const SLOW_RESTART_FACTOR = 2.5;
/** Pause avant de retenter après une erreur réseau ou un 5xx. */
const RETRY_DELAY_MS = 300;

// ------------------------------------------------------------------ cache des segments

/**
 * Cache borné en OCTETS (et non en nombre d'entrées : un segment 1080p pèse
 * dix fois un segment 240p). Une entrée plus grosse que le budget n'est pas
 * mise en cache.
 *
 * Éviction : sans fonction de rang, l'entrée la moins récemment lue part la
 * première (LRU). Avec `rank`, l'entrée de rang le plus BAS part la
 * première, et à rang égal la moins récemment lue. Le proxy s'en sert pour
 * garder les segments à venir d'une lecture : en LRU pur, un segment à
 * peine lu devenait « récent » et survivait au segment suivant, préchargé
 * plus tôt — qui était évincé juste avant d'être demandé.
 */
export class ByteLru<V> {
  private map = new Map<string, { v: V; size: number }>();
  private used = 0;

  constructor(
    public readonly maxBytes: number,
    private readonly rank?: (key: string) => number,
  ) {}

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

  /** Taille d'une entrée, sans modifier l'ordre d'éviction. */
  sizeOf(key: string): number | undefined {
    return this.map.get(key)?.size;
  }

  /** Range l'entrée ; `false` si elle n'est pas gardée (trop grosse, ou la moins prioritaire de toutes). */
  set(key: string, v: V, size: number): boolean {
    this.delete(key);
    if (size > this.maxBytes) return false;
    this.map.set(key, { v, size });
    this.used += size;
    while (this.used > this.maxBytes) this.delete(this.victim());
    return this.map.has(key);
  }

  /** Prochaine entrée à évincer. */
  private victim(): string {
    const keys = this.map.keys();
    const first = keys.next().value as string;
    if (!this.rank) return first;
    let best = first;
    let bestRank = this.rank(first);
    if (bestRank <= 0) return best;
    for (const k of keys) {
      const r = this.rank(k);
      if (r < bestRank) {
        best = k;
        bestRank = r;
        if (r <= 0) break;
      }
    }
    return best;
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
 * Une reprise après blocage (voir `pump`) continue d'alimenter le même
 * objet : les lecteurs ne voient qu'une pause.
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

// ------------------------------------------------------------------ positions de lecture

/**
 * Position d'un lecteur dans une variante : le dernier segment qu'il a
 * demandé (≈ la fin du tampon de hls.js). Le préchargement et l'éviction du
 * cache se règlent dessus.
 *
 * Plusieurs curseurs peuvent coexister dans une variante : deux lecteurs du
 * même match, ou l'ancienne position juste après un saut (elle s'éteint
 * d'elle-même, faute de nouvelles demandes).
 */
interface Cursor {
  okId: string;
  key: string;
  /** `okId|variante` : groupe du cache et des playlists. */
  group: string;
  /** Dernier segment demandé, et son index numérique. */
  name: string;
  idx: number;
  /** performance.now() de la dernière demande, et de la création du curseur. */
  seen: number;
  born: number;
}

/** Sans demande depuis plus longtemps, un curseur n'est plus préchargé (pause, saut, onglet fermé). */
const CURSOR_ACTIVE_MS = 30_000;
/** Au-delà, il est oublié : ses segments à venir ne sont plus protégés dans le cache. */
const CURSOR_TTL_MS = 3 * 60_000;
const CURSOR_MAX = 32;
/**
 * Changement de qualité : un curseur d'une AUTRE variante du même match, à
 * moins de N segments, est le même lecteur — l'ancienne variante est abandonnée.
 */
const SWITCH_TOLERANCE = 3;
/** Un segment dont le préchargement a échoué n'est pas retenté avant ce délai. */
const PREFETCH_FAIL_COOLDOWN_MS = 30_000;

interface PrefetchState {
  cursors: Cursor[];
  /** Préchargements en cours. */
  active: number;
  /** Incrémenté par `clearProxyCaches` : les tâches d'avant ne touchent plus aux compteurs. */
  gen: number;
  /** Échecs récents (clé de segment ou `pl|groupe` → performance.now()). */
  failed: Map<string, number>;
  /** Premier index au-delà de la fin, appris quand la playlist est inconnue. */
  ends: Map<string, number>;
  /** Taille moyenne glissante des segments par variante (budget du préchargement). */
  sizes: Map<string, number>;
}

const gs = globalThis as unknown as {
  __okSegCache2?: ByteLru<Uint8Array<ArrayBuffer>>;
  __okSegInflight?: Map<string, Promise<SharedDownload>>;
  __okPrefetch2?: PrefetchState;
};
const prefetch: PrefetchState = (gs.__okPrefetch2 ??= {
  cursors: [],
  active: 0,
  gen: 0,
  failed: new Map(),
  ends: new Map(),
  sizes: new Map(),
});
let segCache: ByteLru<Uint8Array<ArrayBuffer>> = (gs.__okSegCache2 ??= new ByteLru(segmentCacheBytes(), segmentRank));
const segInflight: Map<string, Promise<SharedDownload>> = (gs.__okSegInflight ??= new Map());

function segKey(okId: string, key: string, s: string): string {
  return `${okId}|${key}|${s}`;
}

/** Index numérique final d'un nom de segment (`MEDIUM00042.ts` → 42), comme `nextSegmentName`. */
function segIndex(name: string): number | null {
  const m = name.match(/(\d+)\.ts$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Fenêtre de préchargement (en segments) d'une variante. */
function groupWindow(group: string): number {
  return prefetchWindow(playlists.get(group)?.segSec ?? DEFAULT_SEGMENT_SEC);
}

/**
 * Enregistre une demande du lecteur. Renvoie le curseur et `continued` :
 * vrai si la demande prolonge une lecture suivie (pas un saut, pas un début).
 */
function touchCursor(okId: string, key: string, name: string): { cursor: Cursor | null; continued: boolean } {
  const idx = segIndex(name);
  if (idx === null) return { cursor: null, continued: false };
  const now = performance.now();
  const group = `${okId}|${key}`;
  prefetch.cursors = prefetch.cursors.filter(
    (c) =>
      now - c.seen <= CURSOR_TTL_MS &&
      // Changement de qualité (ABR) : la position dans l'ancienne variante est abandonnée.
      !(c.okId === okId && c.key !== key && Math.abs(c.idx - idx) <= SWITCH_TOLERANCE),
  );
  const w = groupWindow(group);
  let best: Cursor | null = null;
  for (const c of prefetch.cursors) {
    // Lecture suivie : un pas en avant dans la fenêtre, ou un léger retour (nouvelle tentative).
    if (c.group !== group || idx < c.idx - 2 || idx > c.idx + w + 1) continue;
    if (!best || Math.abs(idx - c.idx) < Math.abs(idx - best.idx)) best = c;
  }
  if (best) {
    best.idx = idx;
    best.name = name;
    best.seen = now;
    return { cursor: best, continued: true };
  }
  const c: Cursor = { okId, key, group, name, idx, seen: now, born: now };
  prefetch.cursors.push(c);
  if (prefetch.cursors.length > CURSOR_MAX) {
    prefetch.cursors.sort((a, b) => b.seen - a.seen);
    prefetch.cursors.length = CURSOR_MAX;
  }
  return { cursor: c, continued: false };
}

/**
 * Rang de conservation d'un segment en cache (plus haut = gardé plus longtemps) :
 *  - 0 : déjà lu, ou hors de toute fenêtre de lecture → évincé en premier ;
 *  - ]1, 2] : à venir pour un lecteur en pause ou inactif ;
 *  - ]2, 3] : à venir pour un lecteur actif.
 * Dans une même tranche, le segment le plus proche de la tête de lecture
 * est gardé le plus longtemps (c'est le prochain demandé).
 */
function segmentRank(ck: string): number {
  const [okId, key, name] = ck.split('|');
  const idx = name ? segIndex(name) : null;
  if (idx === null) return 0;
  const now = performance.now();
  let rank = 0;
  for (const c of prefetch.cursors) {
    if (c.okId !== okId || c.key !== key) continue;
    const age = now - c.seen;
    if (age > CURSOR_TTL_MS) continue;
    const d = idx - c.idx;
    const w = groupWindow(c.group);
    if (d <= 0 || d > w) continue;
    rank = Math.max(rank, (age <= CURSOR_ACTIVE_MS ? 2 : 1) + 1 - d / (w + 1));
  }
  return rank;
}

/** Taille estimée d'un segment de la variante (moyenne glissante, à défaut celle des autres). */
function estSegmentBytes(group: string): number {
  const own = prefetch.sizes.get(group);
  if (own) return own;
  let sum = 0;
  for (const v of prefetch.sizes.values()) sum += v;
  return prefetch.sizes.size ? sum / prefetch.sizes.size : 2 * 1024 * 1024;
}

/** Petites tables par variante : bornées, elles vivent aussi longtemps que le processus. */
const PER_GROUP_MAX = 256;

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= PER_GROUP_MAX) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

function recordSegmentSize(group: string, bytes: number): void {
  const prev = prefetch.sizes.get(group);
  setBounded(prefetch.sizes, group, prev ? prev * 0.8 + bytes * 0.2 : bytes);
}

// ------------------------------------------------------------------ téléchargement des segments

interface SegTarget {
  okId: string;
  key: string;
  s: string;
  ck: string;
  group: string;
}

/** Reprises restantes pour un segment (partagées par toutes ses tentatives). */
interface RetryBudget {
  left: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ouvre la requête amont d'un segment à partir de l'octet `from` (Range).
 * Résolue dès que des en-têtes valides sont arrivés.
 *
 *  - erreur réseau, en-têtes trop lents (`headersMs`) ou 5xx : nouvelle
 *    tentative, dans la limite du budget de reprises ;
 *  - 400/403/404/410 (signature expirée) : une re-résolution du flux
 *    (dédoublonnée), puis on abandonne ;
 *  - réponse « playlist » (ok.ru, pour un nom inconnu) : 404.
 */
async function openUpstream(t: SegTarget, from: number, signal: AbortSignal, budget: RetryBudget): Promise<Response> {
  const { headersMs } = downloadSettings();
  let forced = false;
  for (;;) {
    const { variant } = await variantFor(t.okId, t.key, forced);
    // `resolveSegmentUrl` lève une Error simple : on la traduit en 400
    // (erreur du client) plutôt qu'en 502 (erreur de la passerelle), pour
    // que le refus soit explicite sur le statut HTTP.
    let url: string;
    try {
      url = resolveSegmentUrl(t.s, variant.url);
    } catch (e) {
      throw new ProxyError(400, (e as Error).message);
    }
    if (!isAllowedMediaHost(url)) throw new ProxyError(400, 'hôte non autorisé');
    const headers: Record<string, string> = { ...OK_HEADERS };
    if (from > 0) headers.Range = `bytes=${from}-`;
    let failure: string;
    try {
      const resp = await followManual(url, headers, { streaming: true, timeoutMs: headersMs, signal });
      if (resp.ok && resp.body) {
        // ok.ru répond par la playlist (200) pour un nom inconnu, par exemple
        // un préchargement au-delà du dernier segment : ce n'est pas un segment.
        if (isPlaylistType(resp.headers.get('content-type') ?? '')) {
          await resp.body.cancel().catch(() => undefined);
          throw new ProxyError(404, 'segment introuvable');
        }
        return resp;
      }
      await resp.body?.cancel().catch(() => undefined);
      // Reprise demandée au-delà de la fin : l'appelant conclut.
      if (resp.status === 416 && from > 0) return resp;
      // Les statuts se lisent sur la réponse FINALE (après redirection) :
      // 403 = signature expirée → une re-résolution, puis on abandonne.
      if ([400, 403, 404, 410].includes(resp.status)) {
        if (forced) throw new ProxyError(502, `amont HTTP ${resp.status}`);
        forced = true;
        continue;
      }
      if (resp.status < 500 && resp.status !== 429) throw new ProxyError(502, `amont HTTP ${resp.status}`);
      failure = `amont HTTP ${resp.status}`;
    } catch (e) {
      if (e instanceof ProxyError) throw e;
      failure = (e as Error)?.message || String(e); // réseau, ou en-têtes trop lents
    }
    if (budget.left <= 0) throw new ProxyError(502, failure);
    budget.left--;
    await sleep(RETRY_DELAY_MS);
  }
}

/** Début de plage d'un en-tête `Content-Range: bytes a-b/c`. */
function contentRangeStart(v: string | null): number | null {
  const m = v?.match(/^bytes\s+(\d+)-/i);
  return m ? Number(m[1]) : null;
}

type ReadOutcome =
  | { kind: 'end' }
  | { kind: 'stall' }
  | { kind: 'slow'; kbps: number }
  | { kind: 'error'; error: unknown };

/**
 * Lit un corps amont dans le téléchargement partagé, sous surveillance :
 *  - `stall` : aucun octet depuis `stallMs` ;
 *  - `slow` : au débit constaté, le segment arriverait bien trop tard ;
 *  - `error` : coupure réseau en cours de corps ;
 *  - `end` : fin du corps (complet ou non : l'appelant vérifie la taille).
 * Sur blocage ou lenteur, la connexion est coupée (abort) : une connexion
 * bloquée ne doit ni rester ouverte, ni être réutilisée.
 * Les `skip` premiers octets sont ignorés (amont qui ignore Range).
 */
async function readBody(
  dl: SharedDownload,
  body: ReadableStream<Uint8Array>,
  skip: number,
  ctrl: AbortController,
  o: { t0: number; segSec: number; slowCheck: boolean },
): Promise<ReadOutcome> {
  const { stallMs } = downloadSettings();
  const reader = body.getReader();
  const start = performance.now();
  let last = start;
  let toSkip = skip;
  /** Octets reçus sur cette connexion, sautés compris (mesure du débit). */
  let raw = 0;
  // Objet plutôt que variable : TypeScript ne suit pas les affectations faites dans un callback.
  const st: { verdict: ReadOutcome | null } = { verdict: null };
  const stop = (v: ReadOutcome) => {
    if (st.verdict) return;
    st.verdict = v;
    ctrl.abort(new Error(v.kind === 'stall' ? 'flux amont bloqué' : 'flux amont trop lent'));
    reader.cancel().catch(() => undefined);
  };
  const timer = setInterval(
    () => {
      const now = performance.now();
      if (now - last >= stallMs) return stop({ kind: 'stall' });
      if (!o.slowCheck || dl.contentLength === null || now - start < stallMs) return;
      const rate = raw / (now - start); // octets par ms
      const remainingMs = (dl.contentLength - dl.received + toSkip) / Math.max(rate, 1e-3);
      if (remainingMs > stallMs && now - o.t0 + remainingMs > SLOW_RESTART_FACTOR * o.segSec * 1000) {
        stop({ kind: 'slow', kbps: Math.round(rate * 8) });
      }
    },
    Math.max(25, Math.min(500, stallMs / 4)),
  );
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (error) {
        return st.verdict ?? { kind: 'error', error };
      }
      if (st.verdict) return st.verdict;
      if (r.done) return { kind: 'end' };
      let chunk = r.value;
      if (!chunk?.length) continue;
      last = performance.now();
      raw += chunk.length;
      if (toSkip > 0) {
        const n = Math.min(toSkip, chunk.length);
        toSkip -= n;
        chunk = chunk.subarray(n);
        if (!chunk.length) continue;
      }
      dl.push(chunk);
    }
  } finally {
    clearInterval(timer);
  }
}

/**
 * Lit le segment amont jusqu'au bout, puis le range au cache.
 *
 * Sur blocage, lenteur, coupure ou erreur réseau en cours de corps, le
 * téléchargement reprend à l'octet atteint (`Range: bytes=N-`) sur une
 * connexion neuve, en re-résolvant le flux si la signature a expiré. Les
 * lecteurs déjà branchés sur le `SharedDownload` reçoivent la suite sans
 * rien voir : avant, une connexion bloquée gelait le lecteur jusqu'au délai
 * total de 60 s, et ses nouvelles tentatives rejoignaient… le même
 * téléchargement bloqué.
 */
async function pump(dl: SharedDownload, first: Response, t: SegTarget, budget: RetryBudget, firstCtrl: AbortController): Promise<void> {
  const t0 = performance.now();
  let resp = first;
  let ctrl = firstCtrl;
  let skip = 0;
  let resumes = 0;
  let slowRestarts = 0;
  try {
    for (;;) {
      const segSec = playlists.get(t.group)?.segSec ?? DEFAULT_SEGMENT_SEC;
      const out = await readBody(dl, resp.body!, skip, ctrl, { t0, segSec, slowCheck: slowRestarts === 0 });
      if (out.kind === 'end') {
        if (dl.contentLength === null || dl.received === dl.contentLength) break;
        if (dl.received > dl.contentLength) throw new Error(`segment trop long (${dl.received}/${dl.contentLength} octets)`);
      }
      if (out.kind === 'slow') slowRestarts++;
      if (budget.left <= 0) throw new Error(`${describeOutcome(out)} (${dl.received}/${dl.contentLength ?? '?'} octets)`);
      budget.left--;
      resumes++;
      logResume(t, out, dl, resumes);
      ctrl = new AbortController();
      resp = await openUpstream(t, dl.received, ctrl.signal, budget);
      if (resp.status === 416) {
        // Taille inconnue et tout est déjà là : le corps précédent était complet.
        if (dl.contentLength === null) break;
        throw new Error('reprise refusée (HTTP 416)');
      }
      if (resp.status === 206 && contentRangeStart(resp.headers.get('content-range')) === dl.received) {
        skip = 0;
      } else if (resp.status === 200) {
        // Range ignoré : le corps repart de zéro, on saute ce qui est déjà reçu.
        const len = Number(resp.headers.get('content-length'));
        if (dl.contentLength !== null && len > 0 && len !== dl.contentLength) {
          await resp.body?.cancel().catch(() => undefined);
          throw new Error(`segment modifié en amont (${len} ≠ ${dl.contentLength} octets)`);
        }
        skip = dl.received;
      } else {
        await resp.body?.cancel().catch(() => undefined);
        throw new Error(`reprise refusée (HTTP ${resp.status})`);
      }
    }
    recordSegmentSize(t.group, dl.received);
    // Rangé AVANT `finish` : une requête qui suit la fin du téléchargement
    // trouve le segment en cache.
    segCache.set(t.ck, dl.bytes(), dl.received);
    dl.finish();
    logSlowSegment(t.ck, dl.received, performance.now() - t0, resumes);
  } catch (e) {
    ctrl.abort();
    dl.finish(e);
    logSegmentFailure(t, e, resumes);
  }
}

function describeOutcome(out: ReadOutcome): string {
  switch (out.kind) {
    case 'stall':
      return `aucun octet depuis ${(downloadSettings().stallMs / 1000).toFixed(1)} s`;
    case 'slow':
      return `trop lent (${out.kbps} kb/s)`;
    case 'end':
      return 'coupé avant la fin';
    default:
      return `erreur réseau (${((out.error as Error)?.message ?? String(out.error)).slice(0, 80)})`;
  }
}

/**
 * Ouvre le segment chez ok.ru ; la promesse est résolue dès que les
 * en-têtes amont sont valides, le corps continue d'arriver dans le
 * `SharedDownload`.
 */
async function openSegment(t: SegTarget): Promise<SharedDownload> {
  const budget: RetryBudget = { left: downloadSettings().retries };
  const ctrl = new AbortController();
  const resp = await openUpstream(t, 0, ctrl.signal, budget);
  const len = Number(resp.headers.get('content-length'));
  const dl = new SharedDownload(Number.isFinite(len) && len > 0 ? len : null);
  void pump(dl, resp, t, budget, ctrl);
  return dl;
}

/** Téléchargement du segment, partagé avec celui déjà en vol s'il existe. */
function segmentDownload(okId: string, key: string, s: string): Promise<SharedDownload> {
  const ck = segKey(okId, key, s);
  const existing = segInflight.get(ck);
  if (existing) return existing;
  const p = openSegment({ okId, key, s, ck, group: `${okId}|${key}` });
  segInflight.set(ck, p);
  const release = () => {
    if (segInflight.get(ck) === p) segInflight.delete(ck);
    // Une place s'est libérée, ou la taille des segments est désormais connue.
    drainPrefetch();
  };
  p.then((dl) => dl.settled.then(release), release);
  return p;
}

// ------------------------------------------------------------------ diagnostics

const segLabel = (ck: string) => ck.split('|').slice(1).join(' ');
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Diagnostic : un segment qui met plus de `SLOW_SEGMENT_MS` à arriver
 * d'ok.ru est signalé dans les logs (au plus une ligne toutes les 20 s),
 * avec son débit — pour distinguer un ok.ru lent d'un problème local.
 */
const SLOW_SEGMENT_MS = 4_000;
let lastSlowLog = 0;
function logSlowSegment(ck: string, bytes: number, ms: number, resumes: number): void {
  if (ms < SLOW_SEGMENT_MS || Date.now() - lastSlowLog < 20_000) return;
  lastSlowLog = Date.now();
  const kbps = Math.round((bytes * 8) / ms);
  console.log(
    `[vidéo] segment lent depuis ok.ru : ${Math.round(bytes / 1024)} Ko en ${(ms / 1000).toFixed(1)} s (${kbps} kb/s) — ${segLabel(ck)}` +
      `${resumes ? ` · ${resumes} reprise${resumes > 1 ? 's' : ''}` : ''}`,
  );
}

/** Reprise d'un téléchargement bloqué ou coupé (au plus une ligne toutes les 10 s). */
let lastResumeLog = 0;
function logResume(t: SegTarget, out: ReadOutcome, dl: SharedDownload, n: number): void {
  if (Date.now() - lastResumeLog < 10_000) return;
  lastResumeLog = Date.now();
  const total = dl.contentLength ? `/${Math.round(dl.contentLength / 1024)}` : '';
  console.log(
    `[vidéo] flux ok.ru ${describeOutcome(out)} : reprise n° ${n} à ${Math.round(dl.received / 1024)}${total} Ko sur une connexion neuve — ${t.key} ${t.s}`,
  );
}

/** Segment perdu malgré les reprises (au plus une ligne toutes les 10 s). */
let lastFailLog = 0;
function logSegmentFailure(t: SegTarget, e: unknown, resumes: number): void {
  // Préchargement au-delà de la fin (playlist inconnue) : attendu, pas une panne.
  if (e instanceof ProxyError && e.status === 404) return;
  if (Date.now() - lastFailLog < 10_000) return;
  lastFailLog = Date.now();
  console.log(`[vidéo] segment abandonné après ${resumes} reprise(s) : ${(e as Error)?.message ?? e} — ${t.key} ${t.s}`);
}

/**
 * Le lecteur demande un segment qui n'est pas encore en cache, en pleine
 * lecture suivie : le préchargement n'a pas tenu la cadence (ok.ru plus lent
 * que la qualité lue, ou cache trop petit). Au plus une ligne toutes les 20 s.
 */
let lastCatchUpLog = 0;
function logCatchUp(ck: string, inflight: boolean): void {
  if (Date.now() - lastCatchUpLog < 20_000) return;
  lastCatchUpLog = Date.now();
  console.log(
    `[vidéo] le lecteur rattrape le préchargement (${inflight ? 'segment encore en téléchargement' : 'segment pas encore préchargé'}) — ${segLabel(ck)}` +
      ` · cache ${mb(segCache.bytes)}/${mb(segCache.maxBytes)} Mo`,
  );
}

// ------------------------------------------------------------------ préchargement

/**
 * Lance les préchargements utiles, dans la limite de la concurrence.
 *
 * Pas de file d'attente figée : les candidats sont recalculés à chaque
 * appel depuis les curseurs actifs — pour chacun, les segments qui suivent
 * le dernier demandé, sur `prefetchWindow` segments (≈ PREFETCH_AHEAD_SEC
 * de vidéo), bornés par la playlist. Le plus proche d'une tête de lecture
 * passe en premier, tous lecteurs confondus. Ainsi :
 *  - une nouvelle demande n'annule jamais les segments juste après la tête ;
 *  - après un saut ou un changement de qualité, la nouvelle position passe
 *    devant l'ancienne, qui s'éteint seule ;
 *  - les segments à venir n'occupent pas plus de PREFETCH_BUDGET_SHARE du
 *    cache : le préchargement n'évince pas ce qu'il vient de préparer.
 */
function drainPrefetch(): void {
  const { concurrency } = prefetchSettings();
  if (prefetch.active >= concurrency || segCache.maxBytes <= 0) return;
  const now = performance.now();
  if (prefetch.failed.size > 500) {
    for (const [k, at] of prefetch.failed) if (now - at > PREFETCH_FAIL_COOLDOWN_MS) prefetch.failed.delete(k);
  }
  const seen = new Set<string>();
  const cands: { c: Cursor; name: string; d: number }[] = [];
  let committed = 0; // octets déjà engagés pour des segments à venir (en cache ou en vol)
  for (const c of prefetch.cursors) {
    if (now - c.seen > CURSOR_ACTIVE_MS) continue;
    // Playlist en cours de lecture : on attend ses bornes plutôt que de précharger à l'aveugle.
    if (playlistInflight.has(c.group)) continue;
    const pl = playlists.get(c.group);
    const end = prefetch.ends.get(c.group);
    const w = groupWindow(c.group);
    for (let d = 1; d <= w; d++) {
      const name = nextSegmentName(c.name, d);
      // Au-delà du dernier segment connu : rien à précharger.
      if (!name || (pl && !pl.names.has(name)) || (end !== undefined && c.idx + d >= end)) break;
      const ck = segKey(c.okId, c.key, name);
      if (seen.has(ck)) continue;
      seen.add(ck);
      const size = segCache.sizeOf(ck);
      if (size !== undefined) committed += size;
      else if (segInflight.has(ck)) committed += estSegmentBytes(c.group);
      else if (now - (prefetch.failed.get(ck) ?? -Infinity) >= PREFETCH_FAIL_COOLDOWN_MS) cands.push({ c, name, d });
    }
  }
  // Le plus urgent d'abord : distance à la tête de lecture, puis lecteur le plus récent.
  cands.sort((a, b) => a.d - b.d || b.c.seen - a.c.seen);
  const budget = segCache.maxBytes * PREFETCH_BUDGET_SHARE;
  for (const t of cands) {
    if (prefetch.active >= concurrency) break;
    const est = estSegmentBytes(t.c.group);
    if (committed + est > budget) break;
    committed += est;
    startPrefetch(t.c, t.name);
  }
}

function startPrefetch(c: Cursor, name: string): void {
  const gen = prefetch.gen;
  const ck = segKey(c.okId, c.key, name);
  prefetch.active++;
  segmentDownload(c.okId, c.key, name)
    .then((dl) => dl.settled.then(() => {
      if (dl.error) throw dl.error;
    }))
    .catch((e: unknown) => {
      if (gen !== prefetch.gen) return;
      prefetch.failed.set(ck, performance.now());
      // Au-delà du dernier segment (ok.ru renvoie la playlist) : fin du flux apprise.
      const idx = segIndex(name);
      if (e instanceof ProxyError && e.status === 404 && idx !== null) {
        setBounded(prefetch.ends, c.group, Math.min(prefetch.ends.get(c.group) ?? Infinity, idx));
      }
    })
    .finally(() => {
      if (gen !== prefetch.gen) return;
      prefetch.active--;
      drainPrefetch();
    });
}

/**
 * Après une demande du lecteur : précharge, en lisant d'abord la playlist si
 * elle n'est pas en mémoire (redémarrage du serveur en pleine lecture), pour
 * borner la fenêtre et connaître la durée des segments.
 */
function schedulePrefetch(okId: string, key: string): void {
  const group = `${okId}|${key}`;
  if (playlists.has(group) || segCache.maxBytes <= 0 || prefetchSettings().aheadSec <= 0) {
    drainPrefetch();
    return;
  }
  // Playlist illisible récemment : on n'insiste pas à chaque segment.
  const failKey = `pl|${group}`;
  if (performance.now() - (prefetch.failed.get(failKey) ?? -Infinity) < PREFETCH_FAIL_COOLDOWN_MS) {
    drainPrefetch();
    return;
  }
  const gen = prefetch.gen;
  void loadPlaylist(okId, key)
    .catch(() => {
      if (gen === prefetch.gen) prefetch.failed.set(failKey, performance.now());
    })
    .finally(drainPrefetch);
}

/** Vide les caches du proxy et relit SEGMENT_CACHE_MB (tests). */
export function clearProxyCaches(): void {
  segCache = gs.__okSegCache2 = new ByteLru(segmentCacheBytes(), segmentRank);
  segInflight.clear();
  playlists.clear();
  playlistInflight.clear();
  prefetch.cursors = [];
  prefetch.active = 0;
  prefetch.gen++;
  prefetch.failed.clear();
  prefetch.ends.clear();
  prefetch.sizes.clear();
  mp4Pins.clear();
  lastSlowLog = lastResumeLog = lastFailLog = lastCatchUpLog = 0;
}

/** Attend la fin des préchargements en cours (tests). */
export async function prefetchIdle(): Promise<void> {
  while (prefetch.active > 0 || segInflight.size || playlistInflight.size) {
    await Promise.allSettled([...segInflight.values()].map((p) => p.then((dl) => dl.settled)));
    await Promise.allSettled([...playlistInflight.values()]);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** État du cache de segments (tests, diagnostic). */
export function segmentCacheStats(): { bytes: number; maxBytes: number; entries: number; cursors: number; prefetching: number } {
  return {
    bytes: segCache.bytes,
    maxBytes: segCache.maxBytes,
    entries: segCache.size,
    cursors: prefetch.cursors.length,
    prefetching: prefetch.active,
  };
}

// ------------------------------------------------------------------ route segment

/** Clé de variante telle que produite par `parseMasterVariants` (QUALITY nettoyé). */
const VARIANT_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;

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
 * téléchargement en vol, ou téléchargé et mis en cache ; la position du
 * lecteur est notée et les segments suivants sont préchargés. Avec Range :
 * relais direct.
 */
export async function proxiedSegment(okId: string, key: string | null, s: string | null, range: string | null): Promise<Response> {
  assertOkId(okId);
  assertKnownOkId(okId);
  if (!s) throw new ProxyError(400, 'paramètre s manquant');
  if (!isSegmentName(s)) throw new ProxyError(400, `nom de segment invalide: ${s}`);
  if (range) return passthroughSegment(okId, key, s, range);
  if (!key || !VARIANT_KEY_RE.test(key)) throw new ProxyError(404, `variante inconnue: ${key}`);

  const ck = segKey(okId, key, s);
  const { cursor, continued } = touchCursor(okId, key, s);
  const cached = segCache.get(ck);
  let pending: Promise<SharedDownload> | null = null;
  if (!cached) {
    const inflight = segInflight.has(ck);
    // Ouvert AVANT de lancer les préchargements : le segment attendu passe en premier.
    pending = segmentDownload(okId, key, s);
    if (continued && cursor && performance.now() - cursor.born > 30_000) logCatchUp(ck, inflight);
  }
  schedulePrefetch(okId, key);
  if (cached) return new Response(cached, { status: 200, headers: segmentHeaders(cached.length) });
  const dl = await pending!;
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
