/**
 * Scraping basketball-video.com (HTML pur, pas de navigateur).
 *
 * 1. Listes : /2026-27, /2026-27?page2… → liens contenant `-vs-` et `nba-full-game-replay`.
 * 2. Page match : blocs « Server #N (LABEL) » suivis d'un lien <a href>.
 * 3. Page cible de chaque serveur : PREMIER <iframe src="//ok.ru/videoembed/<id>"> = la bonne vidéo.
 *    On essaie tous les serveurs (pas seulement le #1) et on retient le premier
 *    embed lisible (HLS, sinon MP4) d'un match complet.
 *
 * User-Agent navigateur obligatoire + 1 requête / 2 s.
 */
import { createRateLimiter, fetchText } from './http';
import { fetchOkEmbed, type OkEmbedInfo } from './okru';
import { seasonLabel } from './time';

export const BV_BASE = 'https://basketball-video.com';
const limiter = createRateLimiter(Number(process.env.BV_RATE_MS ?? 2000));

export function bvFetch(url: string): Promise<string> {
  return limiter(() => fetchText(url, { headers: { Referer: `${BV_BASE}/` }, timeoutMs: 25_000 }));
}

export interface ServerBlock {
  n: number;
  label: string;
  href: string;
}

/** Extrait les blocs « Server #N (LABEL) » et le premier lien qui suit chacun. */
export function parseServerBlocks(html: string): ServerBlock[] {
  const re = /Server\s*#\s*(\d+)\s*(?:\(([^)<]*)\))?/gi;
  const marks: { n: number; label: string; idx: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) marks.push({ n: Number(m[1]), label: (m[2] ?? '').trim(), idx: m.index, end: re.lastIndex });
  const out: ServerBlock[] = [];
  for (let i = 0; i < marks.length; i++) {
    const segment = html.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].idx : undefined);
    const a = segment.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
    if (a && !out.some((o) => o.n === marks[i].n)) out.push({ n: marks[i].n, label: marks[i].label, href: a[1] });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Premier iframe ok.ru de la page (règle validée : c'est le bon match). */
export function parseFirstOkIframe(html: string): string | null {
  const re = /<iframe\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/(?:www\.)?ok\.ru\/videoembed\/(\d+)[^"']*)["']/i;
  return html.match(re)?.[2] ?? null;
}

/** Tous les iframes ok.ru de la page, dans l'ordre, sans doublon. */
export function parseOkIframes(html: string): string[] {
  const re = /<iframe\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/(?:www\.)?ok\.ru\/videoembed\/(\d+)[^"']*)["']/gi;
  const out: string[] = [];
  for (const m of html.matchAll(re)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export interface ListingEntry {
  url: string;
  slug: string;
  awaySlug: string;
  homeSlug: string;
  /** Date US (YYYY-MM-DD) indiquée dans le slug. */
  date: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 'portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026' */
export function parseReplaySlug(slug: string): Omit<ListingEntry, 'url'> | null {
  const clean = slug.replace(/^\/+|\/+$/g, '').replace(/-+$/, '');
  const m = clean.match(/^(.+?)-vs-(.+?)-nba-(?:[a-z0-9-]*?-)?full-game-replay-([a-z]+)-(\d{1,2})-(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[3].slice(0, 3)];
  const date = month ? `${m[5]}-${String(month).padStart(2, '0')}-${m[4].padStart(2, '0')}` : null;
  return { slug: clean, awaySlug: m[1], homeSlug: m[2], date };
}

export function parseListing(html: string): { entries: ListingEntry[]; maxPage: number } {
  const entries = new Map<string, ListingEntry>();
  const re = /href\s*=\s*["']([^"']*-vs-[^"']*nba-[^"']*full-game-replay[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const path = href.replace(/^https?:\/\/[^/]+/, '');
    const parsed = parseReplaySlug(path);
    if (!parsed) continue;
    const url = new URL(path, BV_BASE).toString();
    if (!entries.has(parsed.slug)) entries.set(parsed.slug, { url, ...parsed });
  }
  let maxPage = 1;
  for (const p of html.matchAll(/\?page(\d+)/g)) maxPage = Math.max(maxPage, Number(p[1]));
  return { entries: [...entries.values()], maxPage };
}

/** Nom d'équipe ESPN → slug du site ('LA Clippers' → 'la-clippers'). */
export function teamSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Date US (fuseau New York) d'un match ESPN, format YYYY-MM-DD. */
export function usDateKey(isoUtc: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(isoUtc),
  );
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;
}

export interface MatchLike {
  home_name: string;
  away_name: string;
  date_utc: string;
}

/** Retrouve l'entrée de liste correspondant à un match (équipes + date ± 1 j). */
export function matchListingEntry(entries: ListingEntry[], match: MatchLike): ListingEntry | null {
  const home = teamSlug(match.home_name);
  const away = teamSlug(match.away_name);
  const date = usDateKey(match.date_utc);
  const candidates = entries.filter((e) => {
    const teamsOk = (e.homeSlug === home && e.awaySlug === away) || (e.homeSlug === away && e.awaySlug === home);
    return teamsOk && (!e.date || dayDiff(e.date, date) <= 1);
  });
  candidates.sort((a, b) => (a.date ? dayDiff(a.date, date) : 2) - (b.date ? dayDiff(b.date, date) : 2));
  return candidates[0] ?? null;
}

// ------------------------------------------------------------------ cache de listes

/**
 * Cache des pages de liste d'une saison, par saison.
 *
 * La clé est la SEASON seule, pas la date de référence : la date de
 * référence est calculée par match, donc une clé par date n'était jamais
 * réutilisée et la Map grossissait sans borne.
 *
 * On mémorise aussi `oldestCovered` : la date la plus ancienne atteinte par
 * le parcours. Le cache ne sert QUE s'il couvre la date demandée. Sans
 * cette précaution, le cache tronquait la recherche : le premier appel
 * (sur le match le plus récent) ne parcourait qu'une ou deux pages, le
 * résultat partiel était mis en cache sous la clé de la saison, et tous
 * les matchs plus anciens sortaient ensuite « replay non listé » pendant
 * toute la durée de vie du cache.
 */
const listingCache = new Map<number, { at: number; entries: ListingEntry[]; oldestCovered: string }>();

/** Durée de vie d'une entrée de cache (le contenu du site bouge lentement). */
const LISTING_TTL_MS = 30 * 60_000;

/**
 * Parcourt les pages de la saison jusqu'à dépasser `oldestUsDate` (ou maxPages).
 *
 * Le résultat est mis en cache par saison, avec la date la plus ancienne
 * couverte : un appel ultérieur dont la date est plus ancienne que cette
 * couverture refait le parcours (au lieu de lire un cache tronqué).
 */
export async function fetchSeasonListing(season: number, oldestUsDate: string, maxPages = 15): Promise<ListingEntry[]> {
  const c = listingCache.get(season);
  // Le cache est valide s'il est frais ET s'il couvre la date demandée
  // (comparaison de dates ISO : l'ordre lexical est l'ordre chronologique).
  if (c && Date.now() - c.at < LISTING_TTL_MS && c.oldestCovered <= oldestUsDate) return c.entries;

  const base = `${BV_BASE}/${seasonLabel(season)}`;
  const all = new Map<string, ListingEntry>();
  let maxPage = 1;
  let oldestCovered = '';
  for (let page = 1; page <= Math.min(maxPage, maxPages); page++) {
    const html = await bvFetch(page === 1 ? base : `${base}?page${page}`);
    const parsed = parseListing(html);
    maxPage = Math.max(maxPage, parsed.maxPage);
    for (const e of parsed.entries) all.set(e.slug, e);
    const dates = parsed.entries.map((e) => e.date).filter(Boolean) as string[];
    if (dates.length) {
      const pageOldest = dates.reduce((a, b) => (a && a <= b ? a : b));
      oldestCovered = oldestCovered && oldestCovered <= pageOldest ? oldestCovered : pageOldest;
    }
    if (dates.length && dates.every((d) => d < oldestUsDate)) break;
  }
  const entries = [...all.values()];
  // On borne le nombre de saisons conservées : le cache est en mémoire,
  // dans le processus, et les saisons s'accumulent au fil des mois.
  if (listingCache.size >= 4) {
    const oldestKey = [...listingCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldestKey !== undefined) listingCache.delete(oldestKey);
  }
  listingCache.set(season, { at: Date.now(), entries, oldestCovered: oldestCovered || oldestUsDate });
  return entries;
}

/** Vide le cache des listes (utile en test et après un échec de scrape). */
export function clearListingCache(): void {
  listingCache.clear();
}

export interface ReplayLookup {
  slug: string | null;
  okId: string | null;
  duration: number | null;
  available: boolean;
  /** Type de flux lisible retenu : HLS (traitement ok.ru terminé) ou MP4 progressif seul. */
  kind: 'hls' | 'mp4' | null;
  reason?: string;
}

/** Durée minimale pour considérer un match complet (vs teaser). */
export const FULL_GAME_MIN_SEC = 3600;

/** Flux lisible d'un embed : HLS si présent, sinon MP4 progressif, sinon rien. */
export function embedKind(embed: Pick<OkEmbedInfo, 'hlsManifestUrl' | 'mp4'>): 'hls' | 'mp4' | null {
  if (embed.hlsManifestUrl) return 'hls';
  if (embed.mp4.length) return 'mp4';
  return null;
}

/**
 * Identifiants ok.ru candidats d'une page de match, du plus sûr au moins sûr.
 *
 * Ordre : le PREMIER iframe de chaque serveur (Server #1, #2, …) — c'est
 * la règle validée, le premier iframe d'une page cible est le bon match —,
 * puis les iframes suivants de ces pages et ceux de la page de match. Les
 * iframes secondaires ne sont essayés qu'en dernier recours : sur une page
 * cible partagée, ils peuvent appartenir à un autre match (le seuil de
 * durée écarte au moins les teasers).
 *
 * Générateur paresseux : une page cible n'est téléchargée (au rythme du
 * limiteur) que si les candidats précédents ont échoué.
 */
export async function* replayCandidates(entryUrl: string): AsyncGenerator<string> {
  const page = await bvFetch(entryUrl);
  const servers = parseServerBlocks(page);
  const direct = parseOkIframes(page);
  const seen = new Set<string>();
  const later: string[] = [];
  // Sans bloc « Server », certaines pages embarquent directement l'iframe.
  if (!servers.length && direct.length) {
    seen.add(direct[0]);
    yield direct[0];
  }
  for (const server of servers) {
    let url: URL;
    try {
      url = new URL(server.href, entryUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    let ids: string[];
    try {
      ids = parseOkIframes(await bvFetch(url.toString()));
    } catch {
      continue; // serveur mort : on passe au suivant
    }
    const [first, ...rest] = ids.filter((id) => !seen.has(id));
    later.push(...rest);
    if (first) {
      seen.add(first);
      yield first;
    }
  }
  for (const id of [...later, ...direct]) {
    if (seen.has(id)) continue;
    seen.add(id);
    yield id;
  }
}

export async function findReplay(match: MatchLike & { season: number }): Promise<ReplayLookup> {
  const usDate = usDateKey(match.date_utc);
  const oldest = new Date(Date.parse(`${usDate}T00:00:00Z`) - 2 * 86400_000).toISOString().slice(0, 10);
  const entries = await fetchSeasonListing(match.season, oldest);
  const entry = matchListingEntry(entries, match);
  if (!entry) return { slug: null, okId: null, duration: null, available: false, kind: null, reason: 'replay non listé' };
  // Premier candidat rencontré : rapporté (okId, durée, raison) si aucun n'est lisible.
  let first: { okId: string; duration: number | null; reason: string } | null = null;
  for await (const okId of replayCandidates(entry.url)) {
    let embed: OkEmbedInfo;
    try {
      embed = await fetchOkEmbed(okId);
    } catch (e) {
      first ??= { okId, duration: null, reason: `embed ok.ru illisible (${(e as Error).message})` };
      continue;
    }
    const kind = embedKind(embed);
    const duration = embed.duration;
    if (kind && (duration ?? 0) >= FULL_GAME_MIN_SEC) {
      return { slug: entry.slug, okId, duration, available: true, kind };
    }
    first ??= {
      okId,
      duration,
      reason: duration && duration < FULL_GAME_MIN_SEC ? 'vidéo trop courte (teaser)' : 'flux indisponible',
    };
  }
  if (!first) return { slug: entry.slug, okId: null, duration: null, available: false, kind: null, reason: 'iframe ok.ru introuvable' };
  return { slug: entry.slug, okId: first.okId, duration: first.duration, available: false, kind: null, reason: first.reason };
}
