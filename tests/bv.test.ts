import { describe, it, expect } from 'vitest';
import {
  parseServerBlocks,
  parseFirstOkIframe,
  parseReplaySlug,
  parseListing,
  teamSlug,
  usDateKey,
  matchListingEntry,
  FULL_GAME_MIN_SEC,
} from '../src/lib/bv';

/** HTML réel d'une page de match basketball-video.com. */
const MATCH_PAGE = `
<p style="text-align: center;"><span style="font-size:28px;"><b>Server #1 (OK)</b></span></p>
<p style="text-align: center;"><strong><a class="su-button" href="https://nhlgamestoday.com/nhl-games-on-tv-today-tuesday-april-30-2024" rel="noopener noreferrer"><span>Watch</span></a></strong></p>
<p style="text-align: center;"><span style="font-size:28px;"><b>Server #2 (DM)</b></span></p>
<p style="text-align: center;"><strong><a class="su-button" href="https://nhlgamestoday.com/nhl-games-on-tv-today-sunday-april-28-2024" rel="noopener noreferrer"><span>Watch</span></a></strong></p>
<p style="text-align: center;"><span style="font-size:28px;"><b>Server #3 (FM)</b></span></p>
<p style="text-align: center;"><strong><a class="su-button" href="https://nbaontv.com/nba-games-on-tv-today-saturday-may-4-2024" rel="noopener noreferrer"><span>Watch</span></a></strong></p>
`;

const TARGET_PAGE = `
<iframe allowfullscreen="" class="yt-embed" src="//ok.ru/videoembed/16656495217324"></iframe>
<iframe allowfullscreen="" class="yt-embed" src="//ok.ru/videoembed/16655414594220"></iframe>
`;

describe('parseServerBlocks', () => {
  it('extrait les trois serveurs dans l\'ordre', () => {
    const blocks = parseServerBlocks(MATCH_PAGE);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.n)).toEqual([1, 2, 3]);
    expect(blocks[0].label).toBe('OK');
    expect(blocks[2].label).toBe('FM');
  });

  it('associe chaque serveur à son propre lien', () => {
    const blocks = parseServerBlocks(MATCH_PAGE);
    expect(blocks[0].href).toBe('https://nhlgamestoday.com/nhl-games-on-tv-today-tuesday-april-30-2024');
    expect(blocks[1].href).toBe('https://nhlgamestoday.com/nhl-games-on-tv-today-sunday-april-28-2024');
    expect(blocks[2].href).toBe('https://nbaontv.com/nba-games-on-tv-today-saturday-may-4-2024');
  });

  it('renvoie une liste vide sans bloc Server', () => {
    expect(parseServerBlocks('<p>rien</p>')).toHaveLength(0);
  });
});

describe('parseFirstOkIframe', () => {
  it('retourne le PREMIER iframe ok.ru (règle validée : c\'est le bon match)', () => {
    expect(parseFirstOkIframe(TARGET_PAGE)).toBe('16656495217324');
  });

  it('accepte une URL absolue', () => {
    expect(parseFirstOkIframe('<iframe src="https://ok.ru/videoembed/16656495217324"></iframe>')).toBe(
      '16656495217324',
    );
  });

  it('renvoie null sans iframe ok.ru', () => {
    expect(parseFirstOkIframe('<div>rien</div>')).toBeNull();
    expect(parseFirstOkIframe('<iframe src="https://bysesukior.com/e/xxx"></iframe>')).toBeNull();
  });
});

describe('parseReplaySlug', () => {
  it('extrait équipes et date d\'un slug réel', () => {
    const r = parseReplaySlug(
      'portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026',
    );
    expect(r).not.toBeNull();
    expect(r!.awaySlug).toBe('portland-trail-blazers');
    expect(r!.homeSlug).toBe('los-angeles-lakers');
    expect(r!.date).toBe('2026-10-27');
  });

  it('gère les variantes de slug (game N, pré-saison)', () => {
    const r = parseReplaySlug(
      'denver-nuggets-vs-los-angeles-lakers-nba-preseason-full-game-replay-october-16-2026',
    );
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-10-16');
  });

  it('renvoie null pour un slug qui n\'est pas un replay', () => {
    expect(parseReplaySlug('some-random-page')).toBeNull();
  });
});

describe('parseListing', () => {
  it('extrait les entrées et la pagination', () => {
    const html = `
      <a href="https://basketball-video.com/portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026">Watch</a>
      <a href="https://basketball-video.com/sacramento-kings-vs-san-antonio-spurs-nba-full-game-replay-october-27-2026">Watch</a>
      <a href="?page12">12</a>
      <a href="?page13">13</a>
    `;
    const { entries, maxPage } = parseListing(html);
    expect(entries).toHaveLength(2);
    expect(maxPage).toBe(13);
    expect(entries[0].url).toContain('basketball-video.com/portland-trail-blazers');
  });
});

describe('teamSlug', () => {
  it('normalise un nom d\'équipe ESPN', () => {
    expect(teamSlug('LA Clippers')).toBe('la-clippers');
    expect(teamSlug('Portland Trail Blazers')).toBe('portland-trail-blazers');
    expect(teamSlug('Oklahoma City Thunder')).toBe('oklahoma-city-thunder');
  });
});

describe('usDateKey', () => {
  it('extrait la date US (New York) d\'une date UTC', () => {
    // 03:00 UTC = 23:00 la veille à New York : c'est le comportement voulu,
    // les matchs NBA se jouent la nuit en Amérique du Nord.
    expect(usDateKey('2026-10-28T03:00:00Z')).toBe('2026-10-27');
    expect(usDateKey('2026-10-27T23:30:00Z')).toBe('2026-10-27');
    expect(usDateKey('2026-10-28T19:00:00Z')).toBe('2026-10-28');
  });
});

describe('matchListingEntry', () => {
  it('retrouve l\'entrée correspondant à un match', () => {
    const entries = [
      {
        url: 'https://basketball-video.com/portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026',
        slug: 'portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026',
        awaySlug: 'portland-trail-blazers',
        homeSlug: 'los-angeles-lakers',
        date: '2026-10-27',
      },
    ];
    const found = matchListingEntry(entries, {
      away_name: 'Portland Trail Blazers',
      home_name: 'Los Angeles Lakers',
      date_utc: '2026-10-28T03:00:00Z',
    });
    expect(found).not.toBeNull();
    expect(found!.slug).toContain('portland-trail-blazers');
  });
});

describe('FULL_GAME_MIN_SEC', () => {
  it('filtre les teasers (moins d\'une heure)', () => {
    expect(FULL_GAME_MIN_SEC).toBe(3600);
  });
});
