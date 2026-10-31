/**
 * Produit, avec le code Node, les sorties attendues du portage Rust de la
 * recherche des replays (server/tests/fixtures/bv.expected.json, comparé par
 * tests/replays.rs) : analyse des pages basketball-video (captures réelles de
 * tests/fixtures/ et cas synthétiques), slugs, dates US, appariement d'un
 * match, raisons lisibles, fenêtre de revérification. À relancer après une
 * modification de bv.ts, replayCheck.ts ou replayCadence.ts, depuis la
 * racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-bv.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = join(ROOT, 'tests', 'fixtures');
const OUT = join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';

const bv = await import(join(ROOT, 'src/lib/bv.ts'));
const okru = await import(join(ROOT, 'src/lib/okru.ts'));
const cadence = await import(join(ROOT, 'src/lib/replayCadence.ts'));
const replayCheck = await import(join(ROOT, 'src/lib/replayCheck.ts'));
const time = await import(join(ROOT, 'src/lib/time.ts'));

const read = (f: string) => readFileSync(join(FX, f), 'utf8');
const cases: { fn: string; input: unknown; output: unknown }[] = [];
const add = (fn: string, input: unknown, f: () => unknown) => {
  let output: unknown;
  try {
    output = { ok: f() };
  } catch (e) {
    output = { err: (e as Error).message };
  }
  cases.push({ fn, input, output });
};

// 1. Pages de match : blocs « Server ».
const matchPages = [
  read('bv-match.html'),
  read('bv-target.html'),
  '<p>rien</p>',
  '<b>server # 2 (dm)</b><a href=\'https://b.example/x\'>x</a><b>SERVER#1</b><a class="x" href="https://a.example/y">y</a>',
  '<b>Server #1 (OK)</b><p>pas de lien</p><b>Server #1 (OK bis)</b><a href="https://a.example/1">1</a><b>Server #3 (  FM  )</b><a href="/relatif">r</a>',
  '<b>Server #02 (A<b)</b><a href="https://x.example/2">2</a><b>Server #10</b><a  data-x href = "https://x.example/10">10</a><b>Server #9 (Z)</b><a href="https://x.example/9">9</a>',
  '<b>Server #1 (OK)</b><abbr href="https://faux.example">a</abbr><a href="">vide</a><a href="https://vrai.example">v</a>',
];
for (const html of matchPages) add('parseServerBlocks', html, () => bv.parseServerBlocks(html));

// 2. Pages cibles : iframes ok.ru.
const targets = [
  read('bv-target.html'),
  read('bv-match.html'),
  '<iframe src="https://ok.ru/videoembed/16656495217324"></iframe>',
  '<IFRAME class="a" SRC=\'//www.ok.ru/videoembed/123456789?autoplay=1\'></IFRAME><iframe src="http://OK.RU/videoembed/987654321"></iframe><iframe src="//ok.ru/videoembed/123456789"></iframe>',
  '<iframe src="https://bysesukior.com/e/x"></iframe><iframe data-src="//ok.ru/videoembed/1" src="//ok.ru/videoembed/22222"></iframe>',
  '<iframe src="https://ok.ru/video/123"></iframe><iframe src="//ok.ru/videoembed/"></iframe>',
];
for (const html of targets) {
  add('parseOkIframes', html, () => bv.parseOkIframes(html));
  add('parseFirstOkIframe', html, () => bv.parseFirstOkIframe(html));
}

// 3. Listes de saison.
const listings = [
  read('bv-listing.html'),
  `<a href="https://basketball-video.com/portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026">W</a>
   <a href='/2026-27/alpha-vs-omega-nba-full-game-replay-november-5-2026/'>W</a>
   <a href="sacramento-kings-vs-san-antonio-spurs-nba-full-game-replay-october-27-2026">W</a>
   <a href="//autre.example/x-vs-y-nba-full-game-replay-may-1-2027">W</a>
   <a HREF = "HTTPS://BASKETBALL-VIDEO.COM/a-vs-b-nba-full-game-replay-june-3-2027">W</a>
   <a href="/a b/é-vs-c-nba-full-game-replay-jan-02-2027?x=1#y">W</a>
   <a href="/x-vs-y-nba-playoffs-game-7-full-game-replay-sept-9-2026">W</a>
   <a href="/x-vs-y-nba-full-game-replay-foo-9-2026">W</a>
   <a href="/portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026-2">dup</a>
   <a href="?page2">2</a><a href="?page12">12</a><a href="/2026-27?page7">7</a><a href="?PAGE99">x</a>`,
  '<p>vide</p>',
];
for (const html of listings) add('parseListing', html, () => bv.parseListing(html));

// 4. Slugs.
const slugs = [
  'portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026',
  'denver-nuggets-vs-los-angeles-lakers-nba-preseason-full-game-replay-october-16-2026',
  '/golden-state-valkyries-vs-atlanta-dream-wnba-finals-game-4-full-game-replay-october-24-2026--',
  'a-vs-b-vs-c-nba-full-game-replay-mayo-1-2027',
  'a-vs-b-nba-full-game-replay-xyz-1-2027',
  'a-vs-b-nba-full-game-replay-ju-1-2027',
  '//a-vs-b-nba-cup-final-full-game-replay-december-31-2026//',
  '2026-27/alpha-vs-omega-nba-full-game-replay-november-5-2026',
  'some-random-page',
  '',
];
for (const s of slugs) add('parseReplaySlug', s, () => bv.parseReplaySlug(s));

// 5. Noms d'équipes, dates US, saisons.
for (const n of ['LA Clippers', 'Portland Trail Blazers', 'Oklahoma City Thunder', 'Atlético Ñandú', '  76ers!!', 'Ünïcödé — Çà', 'İstanbul ΣΑΣ', '-x-'])
  add('teamSlug', n, () => bv.teamSlug(n));
for (const d of ['2026-10-28T03:00:00Z', '2026-10-27T23:30:00Z', '2026-10-28T19:00:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', '2026-11-01T04:30:00.000Z', '2026-11-01T05:30Z', 'pas une date'])
  add('usDateKey', d, () => bv.usDateKey(d));
for (const s of [2026, 2025, 2099, 2008]) add('seasonLabel', s, () => time.seasonLabel(s));

// 6. Appariement d'un match et de la liste.
const entries = [
  { url: 'u1', slug: 's1', awaySlug: 'portland-trail-blazers', homeSlug: 'los-angeles-lakers', date: '2026-10-29' },
  { url: 'u2', slug: 's2', awaySlug: 'portland-trail-blazers', homeSlug: 'los-angeles-lakers', date: '2026-10-27' },
  { url: 'u3', slug: 's3', awaySlug: 'los-angeles-lakers', homeSlug: 'portland-trail-blazers', date: null },
  { url: 'u4', slug: 's4', awaySlug: 'los-angeles-lakers', homeSlug: 'portland-trail-blazers', date: '2026-10-28' },
  { url: 'u5', slug: 's5', awaySlug: 'la-clippers', homeSlug: 'los-angeles-lakers', date: '2026-02-31' },
  { url: 'u6', slug: 's6', awaySlug: 'la-clippers', homeSlug: 'los-angeles-lakers', date: '2026-03-04' },
];
const matches = [
  { away_name: 'Portland Trail Blazers', home_name: 'Los Angeles Lakers', date_utc: '2026-10-28T03:00:00Z' },
  { away_name: 'Portland Trail Blazers', home_name: 'Los Angeles Lakers', date_utc: '2026-10-30T03:00:00Z' },
  { away_name: 'Portland Trail Blazers', home_name: 'Los Angeles Lakers', date_utc: '2026-11-15T03:00:00Z' },
  { away_name: 'LA Clippers', home_name: 'Los Angeles Lakers', date_utc: '2026-03-04T02:00:00Z' },
  { away_name: 'LA Clippers', home_name: 'Los Angeles Lakers', date_utc: '2026-03-05T22:00:00Z' },
  { away_name: 'Boston Celtics', home_name: 'Los Angeles Lakers', date_utc: '2026-10-28T03:00:00Z' },
];
for (const m of matches) add('matchListingEntry', { entries, match: m }, () => bv.matchListingEntry(entries, m));
add('matchListingEntry', { entries: [], match: { away_name: 'A', home_name: 'B', date_utc: 'invalide' } }, () =>
  bv.matchListingEntry([], { away_name: 'A', home_name: 'B', date_utc: 'invalide' }),
);

// 7. Embed ok.ru réel : flux retenu.
const embed = okru.parseOkEmbed(read('ok-embed.html'), '16656495217324');
add('embedKind', 'ok-embed.html', () => ({ kind: bv.embedKind(embed), duration: embed.duration }));

// 8. Raisons lisibles et fenêtre de revérification.
for (const r of [undefined, '', 'replay non listé', 'iframe ok.ru introuvable', 'vidéo trop courte (teaser)', 'flux indisponible', 'embed ok.ru illisible (HTTP 404 pour https://ok.ru/videoembed/1)', 'autre chose'])
  add('humanReplayReason', r ?? null, () => replayCheck.humanReplayReason(r));
for (const now of ['2026-10-29T12:00:00.000Z', '2026-03-29T00:30:00.000Z', '2027-01-01T00:00:00.000Z'])
  add('replayRecheckWindow', now, () => cadence.replayRecheckWindow(Date.parse(now)));

writeFileSync(join(OUT, 'bv.expected.json'), JSON.stringify(cases, null, 1));
console.log(`${cases.length} cas écrits dans server/tests/fixtures/bv.expected.json`);
