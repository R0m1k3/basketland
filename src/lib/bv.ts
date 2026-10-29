/**
 * Scraping basketball-video.com (HTML pur, pas de navigateur).
 *
 * 1. Listes : /2026-27, /2026-27?page2… → liens contenant `-vs-` et `nba-full-game-replay`.
 * 2. Page match : blocs « Server #N (LABEL) » suivis d'un lien <a href>.
 * 3. Page cible du Server #1 : PREMIER <iframe src="//ok.ru/videoembed/<id>"> = la bonne vidéo.
 *
 * User-Agent navigateur obligatoire + 1 requête / 2 s.
 */
import { createRateLimiter, fetchText } from './http';
import { fetchOkEmbed } from './okru';
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

const listingCache = new Map<string, { at: number; entries: ListingEntry[] }>();

/** Parcourt les pages de la saison jusqu'à dépasser `oldestUsDate` (ou maxPages). */
export async function fetchSeasonListing(season: number, oldestUsDate: string, maxPages = 15): Promise<ListingEntry[]> {
  const key = `${season}:${oldestUsDate}`;
  const c = listingCache.get(key);
  if (c && Date.now() - c.at < 10 * 60_000) return c.entries;
  const base = `${BV_BASE}/${seasonLabel(season)}`;
  const all = new Map<string, ListingEntry>();
  let maxPage = 1;
  for (let page = 1; page <= Math.min(maxPage, maxPages); page++) {
    const html = await bvFetch(page === 1 ? base : `${base}?page${page}`);
    const parsed = parseListing(html);
    maxPage = Math.max(maxPage, parsed.maxPage);
    for (const e of parsed.entries) all.set(e.slug, e);
    const dates = parsed.entries.map((e) => e.date).filter(Boolean) as string[];
    if (dates.length && dates.every((d) => d < oldestUsDate)) break;
  }
  const entries = [...all.values()];
  listingCache.set(key, { at: Date.now(), entries });
  return entries;
}

export interface ReplayLookup {
  slug: string | null;
  okId: string | null;
  duration: number | null;
  available: boolean;
  reason?: string;
}

/** Durée minimale pour considérer un match complet (vs teaser). */
export const FULL_GAME_MIN_SEC = 3600;

export async function resolveReplayFromPage(entryUrl: string): Promise<{ okId: string | null; server: ServerBlock | null }> {
  const page = await bvFetch(entryUrl);
  const servers = parseServerBlocks(page);
  const server = servers.find((s) => s.n === 1) ?? servers.find((s) => /^ok$/i.test(s.label)) ?? servers[0] ?? null;
  if (!server) {
    // Certaines pages embarquent directement l'iframe.
    return { okId: parseFirstOkIframe(page), server: null };
  }
  const target = await bvFetch(new URL(server.href, entryUrl).toString());
  return { okId: parseFirstOkIframe(target), server };
}

export async function findReplay(match: MatchLike & { season: number }): Promise<ReplayLookup> {
  const usDate = usDateKey(match.date_utc);
  const oldest = new Date(Date.parse(`${usDate}T00:00:00Z`) - 2 * 86400_000).toISOString().slice(0, 10);
  const entries = await fetchSeasonListing(match.season, oldest);
  const entry = matchListingEntry(entries, match);
  if (!entry) return { slug: null, okId: null, duration: null, available: false, reason: 'replay non listé' };
  const { okId } = await resolveReplayFromPage(entry.url);
  if (!okId) return { slug: entry.slug, okId: null, duration: null, available: false, reason: 'iframe ok.ru introuvable' };
  const embed = await fetchOkEmbed(okId);
  const duration = embed.duration;
  const available = !!embed.hlsManifestUrl && (duration ?? 0) >= FULL_GAME_MIN_SEC;
  return {
    slug: entry.slug,
    okId,
    duration,
    available,
    reason: available ? undefined : duration && duration < FULL_GAME_MIN_SEC ? 'vidéo trop courte (teaser)' : 'flux indisponible',
  };
}
