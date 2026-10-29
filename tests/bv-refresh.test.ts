import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';

// Pas d'attente entre requêtes dans ce fichier (le limiteur lit la variable au chargement).
vi.hoisted(() => {
  process.env.BV_RATE_MS = '0';
});

import { FIRST_PAGE_REFRESH_MS, LISTING_TTL_MS, clearListingCache, fetchSeasonListing } from '../src/lib/bv';
import * as http from '../src/lib/http';

/**
 * Un replay tout juste publié apparaît en 1re page de la liste de saison.
 * - le cache des listes vit 10 min au plus ;
 * - une recherche à la demande relit la 1re page malgré un cache frais,
 *   SANS reparcourir toute la saison, et sans perdre les entrées connues.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function link(away: string, home: string, d: string): string {
  const [y, m, day] = d.split('-');
  return `<a href="https://basketball-video.com/${away}-vs-${home}-nba-full-game-replay-${MONTHS[Number(m) - 1]}-${Number(day)}-${y}">Watch</a>`;
}

function page(links: string[], maxPages = 3): string {
  return `${links.join('\n')}\n${Array.from({ length: maxPages }, (_, i) => `<a href="?page${i + 1}">${i + 1}</a>`).join('')}`;
}

let pages: string[];
let fetched: string[];

// Horloge simulée qui ne fait qu'avancer : le limiteur de requêtes mémorise
// la date de la prochaine requête permise, un retour en arrière le bloquerait.
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
beforeAll(() => vi.useFakeTimers({ toFake: ['Date'], now: Date.now() }));
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  clearListingCache();
  fetched = [];
  pages = [
    page([link('alpha', 'omega', '2026-11-15'), link('beta', 'gamma', '2026-11-14')]),
    page([link('delta', 'omega', '2026-11-12'), link('alpha', 'beta', '2026-11-11')]),
    page([link('gamma', 'delta', '2026-11-09'), link('omega', 'alpha', '2026-11-05')]),
  ];
  vi.spyOn(http, 'fetchText').mockImplementation(async (url: string) => {
    fetched.push(url);
    const m = url.match(/\?page(\d+)/);
    return pages[m ? Number(m[1]) - 1 : 0] ?? '';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearListingCache();
});

describe('listes basketball-video : fraîcheur', () => {
  it('cache de 10 min au plus', () => {
    expect(LISTING_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('relecture forcée : 1re page seule, nouvelle entrée vue, anciennes conservées', async () => {
    const first = await fetchSeasonListing(2026, '2026-11-04');
    expect(fetched.length).toBe(3);

    // Un nouveau replay est publié : il arrive en tête de la 1re page et
    // repousse la dernière entrée de cette page en page 2.
    pages[0] = page([link('epsilon', 'zeta', '2026-11-16'), link('alpha', 'omega', '2026-11-15')]);
    fetched.length = 0;

    // Sans relecture forcée : cache servi, la nouveauté n'est pas vue.
    const cached = await fetchSeasonListing(2026, '2026-11-14');
    expect(fetched).toEqual([]);
    expect(cached.some((e) => e.awaySlug === 'epsilon')).toBe(false);

    // Relecture forcée (1re page lue il y a plus d'une minute) : une seule
    // requête, sur la 1re page.
    advance(FIRST_PAGE_REFRESH_MS + 1000);
    const fresh = await fetchSeasonListing(2026, '2026-11-14', undefined, { refreshFirstPage: true });
    expect(fetched).toEqual(['https://basketball-video.com/2026-27']);
    expect(fresh.some((e) => e.awaySlug === 'epsilon' && e.homeSlug === 'zeta')).toBe(true);
    // « beta-vs-gamma » a quitté la 1re page mais reste connu.
    expect(fresh.some((e) => e.awaySlug === 'beta' && e.homeSlug === 'gamma')).toBe(true);
    expect(fresh.length).toBe(first.length + 1);

    // La fusion est gardée en cache pour les recherches suivantes.
    fetched.length = 0;
    expect((await fetchSeasonListing(2026, '2026-11-14')).length).toBe(fresh.length);
    expect(fetched).toEqual([]);
  });

  it('relecture forcée au plus une fois par minute (plusieurs matchs demandés)', async () => {
    await fetchSeasonListing(2026, '2026-11-04');
    fetched.length = 0;
    // Juste après le parcours complet, la 1re page est fraîche : rien à relire.
    await fetchSeasonListing(2026, '2026-11-14', undefined, { refreshFirstPage: true });
    expect(fetched).toEqual([]);

    advance(FIRST_PAGE_REFRESH_MS + 1000);
    await fetchSeasonListing(2026, '2026-11-14', undefined, { refreshFirstPage: true });
    await fetchSeasonListing(2026, '2026-11-12', undefined, { refreshFirstPage: true });
    expect(fetched).toEqual(['https://basketball-video.com/2026-27']);
  });

  it('cache périmé (10 min) : parcours complet, même sans relecture forcée', async () => {
    await fetchSeasonListing(2026, '2026-11-14');
    const firstRun = fetched.length;
    advance(LISTING_TTL_MS + 1000);
    fetched.length = 0;
    await fetchSeasonListing(2026, '2026-11-14');
    expect(fetched.length).toBe(firstRun);
    expect(fetched[0]).toBe('https://basketball-video.com/2026-27');
  });
});
