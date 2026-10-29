import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearListingCache, fetchSeasonListing } from '../src/lib/bv';
import * as http from '../src/lib/http';

/**
 * Non-régression de la régression R-1 (revue Opus 5.5, 3e passe).
 *
 * Le cache des listes était keyé par saison seule. Or le parcours des pages
 * s'arrête dès qu'une page est entièrement plus ancienne que la date
 * cherchée : le résultat PARTIEL était donc mis en cache sous la clé de la
 * saison. Comme `syncVideos` traite les matchs du plus récent au plus
 * ancien, le 1er appel (sur le match le plus récent) ne remplissait qu'une
 * ou deux pages — et tous les matchs plus anciens sortaient ensuite
 * « replay non listé » pendant toute la durée de vie du cache (30 min).
 *
 * Correction : le cache mémorise `oldestCovered` (la date la plus ancienne
 * atteinte) et n'est servi que s'il couvre la date demandée.
 */

/**
 * Page de liste HTML minimale, avec le format de slug réel du site :
 * `<equipe>-vs-<equipe>-nba-full-game-replay-<mois>-<jour>-<annee>`.
 *
 * `maxPages` simule la pagination : le parseur lit le nombre de pages
 * disponibles dans les liens `?pageN` présents sur la page.
 */
function listingPage(dates: string[], maxPages = 1): string {
  const links = dates
    .map((d) => {
      const [y, m, day] = d.split('-');
      const month = [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december',
      ][Number(m) - 1];
      const slug = `alpha-vs-omega-nba-full-game-replay-${month}-${Number(day)}-${y}`;
      return `<a href="https://basketball-video.com/2026-27/${slug}">Watch</a>`;
    })
    .join('\n');
  const pager = Array.from({ length: maxPages }, (_, i) => `<a href="?page${i + 1}">${i + 1}</a>`).join('');
  return `${links}\n${pager}`;
}

const PAGE1 = listingPage(['2026-11-15', '2026-11-14', '2026-11-13'], 3);
const PAGE2 = listingPage(['2026-11-12', '2026-11-11', '2026-11-10'], 3);
const PAGE3 = listingPage(['2026-11-09', '2026-11-08', '2026-11-05'], 3);

describe('cache des listes basketball-video (R-1)', () => {
  let fetched: string[];

  beforeEach(() => {
    clearListingCache();
    fetched = [];
    // Les pages sont servies dans l'ordre : page 1 = la plus récente.
    const pages = [PAGE1, PAGE2, PAGE3];
    vi.spyOn(http, 'fetchText').mockImplementation(async (url: string) => {
      fetched.push(url);
      const m = url.match(/page(\d+)/);
      const idx = m ? Number(m[1]) - 1 : 0;
      return pages[idx] ?? '';
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearListingCache();
  });

  it('refait le parcours quand la date demandée est plus ancienne que la couverture du cache', async () => {
    // 1er appel : date du 14 nov. Le parcours s'arrête dès que TOUTES les
    // dates d'une page sont plus anciennes : la page 1 (15, 14, 13 nov)
    // ne suffit pas, la page 2 (12, 11, 10 nov) l'est → 2 pages parcourues,
    // couverture jusqu'au 10 novembre.
    const recent = await fetchSeasonListing(2026, '2026-11-14');
    expect(fetched.length).toBe(2);
    expect(recent.length).toBeGreaterThan(0);

    // 2e appel : date du 4 nov → plus ancienne que la couverture (10 nov).
    // Le cache NE doit PAS être servi tel quel, sinon les matchs des 5 au
    // 9 novembre seraient introuvables.
    fetched.length = 0;
    const older = await fetchSeasonListing(2026, '2026-11-04');
    expect(fetched.length, 'le cache tronqué ne doit pas être réutilisé').toBeGreaterThan(0);
    // Le résultat couvre maintenant les matchs du 5 novembre.
    expect(older.length).toBeGreaterThan(recent.length);
  }, 20_000);

  it('réutilise le cache quand la date demandée est couverte', async () => {
    // Parcours complet jusqu'au 5 novembre (page 3 atteinte).
    const a = await fetchSeasonListing(2026, '2026-11-04');
    const callsAfterFirst = fetched.length;
    expect(callsAfterFirst).toBe(3);

    // Date couverte par le cache (plus récente que la couverture) → cache hit.
    const b = await fetchSeasonListing(2026, '2026-11-06');
    expect(fetched.length, 'cache hit attendu').toBe(callsAfterFirst);
    expect(b.length).toBe(a.length);
  }, 20_000);
});
