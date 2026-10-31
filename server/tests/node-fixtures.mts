/**
 * Produit, avec le code Node, les sorties attendues des portages Rust
 * (server/tests/fixtures/*.expected.json, comparées par tests/ingest_node.rs).
 * À relancer après une modification de espn.ts, vf.ts, sync.ts ou ingest.ts,
 * depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = join(ROOT, 'tests', 'fixtures');
const OUT = join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';

const db = await import(join(ROOT, 'src/lib/db.ts'));
const espn = await import(join(ROOT, 'src/lib/espn.ts'));
const vf = await import(join(ROOT, 'src/lib/vf.ts'));
const sync = await import(join(ROOT, 'src/lib/sync.ts'));
const ingest = await import(join(ROOT, 'src/lib/ingest.ts'));

const readJson = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'));
const write = (f: string, v: unknown) => writeFileSync(join(OUT, f), JSON.stringify(v));

const ID = 401909880;
const scoreboardRaw = readJson('espn-scoreboard-20261027.json');
const summaryRaw = readJson('espn-summary-401909880.json');

// 1. Parseurs ESPN.
write('espn-scoreboard-20261027.expected.json', espn.parseScoreboard(scoreboardRaw));
const summary = espn.parseSummary(summaryRaw, ID);
write('espn-summary-401909880.expected.json', summary);

// Variantes de champs (valeurs absentes, nombres, chaînes) : entrée + sortie.
const eventVariants = [
  { id: 1, date: '2026-10-27T23:30Z', season: { year: 2027, type: 1 }, status: { type: { state: 'in', shortDetail: 'Q2 5:00' }, period: 2, displayClock: '5:00' },
    competitions: [{ competitors: [{ homeAway: 'home', score: { value: 50 }, team: { abbreviation: 'LAL', name: 'Lakers' } }, { homeAway: 'away', score: '48', team: { abbreviation: 'BOS', displayName: 'Boston Celtics' } }],
      venue: { fullName: 'Arena' }, broadcasts: [{ names: ['ESPN', 'TNT'] }, { names: ['ESPN'] }], geoBroadcasts: [{ media: { shortName: 'NBA TV' } }, { media: {} }] }] },
  { id: '2', competitions: [{ date: '2026-03-01T01:00:00.123Z', season: { year: '2026', type: '3' }, status: { type: { state: 'post', name: 'STATUS_POSTPONED', detail: 'Postponed' } },
      competitors: [{ homeAway: 'home', score: '', team: { abbreviation: 'NY' } }, { homeAway: 'away', team: { abbreviation: 'DET' } }], broadcast: 'Local' }] },
  { id: 3, date: '2026-04-01T00:00Z', season: { slug: 'play-in-season' }, competitions: [{ status: { type: { state: 'post', name: 'STATUS_FINAL' }, period: 4 },
      competitors: [{ homeAway: 'home', score: 101.5, team: { abbreviation: 'SA' } }, { homeAway: 'away', score: 'abc', team: { abbreviation: 'SAC' } }] }] },
  { id: 4, date: 'pas une date', competitions: [{ competitors: [{ homeAway: 'home', team: {} }, { homeAway: 'away', team: { abbreviation: 'X' } }] }] },
  { id: 5, competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'A' } }] }] },
  { id: 6 },
];
write('espn-events-variants.expected.json', eventVariants.map((ev) => ({ input: ev, output: espn.parseEvent(ev) })));

// 2. VF : classement et traduction de chaque action, puis sélection.
const plays = summary.plays as any[];
const fromDb = (p: any[]) => p.map(({ score_value: _s, participants: _p, ...rest }) => rest);
const synthetic = [
  ['End Game', 'End of Game', 0, 0, 4], ['End Period', 'End of the 2nd Quarter', 0, 0, 2], ['Start Period', 'Start of the 1st Overtime', 0, 0, 5],
  ['End Period', 'End of 2nd Overtime', 0, 0, 6], ['Jumpball', 'A vs. B', 0, 0, 1], ['Jump Ball', 'Weird text', 0, 0, 1],
  ['Timeout', 'Lakers Full timeout', 0, 0, 1], ['Timeout', 'Official timeout', 0, 0, 1], ['Timeout', 'timeout', 0, 0, 1], ['Timeout', 'Celtics 20 Sec. timeout', 0, 0, 3],
  ['Substitution', 'John Doe enters the game for Jim Roe', 0, 0, 2], ['Substitution', 'substitution', 0, 0, 2],
  ['Free Throw', 'Luka Doncic makes technical free throw', 1, 1, 1], ['Free Throw', 'Luka Doncic misses free throw flagrant 1 of 2', 0, 1, 1],
  ['Free Throw', 'X makes free throw clear path 2 of 2', 1, 1, 1], ['Free Throw', 'free throw', 0, 1, 1],
  ['Jump Shot', 'A makes 26-foot step back jumpshot (B assists)', 1, 3, 1], ['Jump Shot', 'A makes 12-foot pullup bank jump shot', 1, 2, 1],
  ['Dunk', 'A makes alley oop dunk (C assists)', 1, 2, 1], ['Layup', 'A makes driving finger roll layup', 1, 2, 1], ['Tip', 'A makes tip shot', 1, 2, 1],
  ['Hook', 'A makes 5-foot hook shot', 1, 2, 1], ['Floater', 'A makes 8-foot floating jump shot', 1, 2, 1], ['Shot', 'A makes two point shot', 1, 2, 1],
  ['Shot', 'A makes 1-foot shot', 1, 2, 1], ['Shot', 'A makes 25-foot three pointer', 1, 3, 1], ['Shot', 'A makes something', 1, 3, 1], ['Shot', 'makes', 1, 2, 1],
  ['Miss', 'A misses 27-foot three point jumper', 0, 0, 1], ['Miss', 'A misses layup', 0, 0, 1], ['Miss', 'misses', 0, 0, 1],
  ['Block', "A blocks B 's 2-foot layup", 0, 0, 1], ["Block", "A blocks B's 20-foot jumper", 0, 0, 1], ['Block', 'A blocks B', 0, 0, 1],
  ['Rebound', 'Lakers offensive team rebound', 0, 0, 1], ['Rebound', 'A defensive rebound', 0, 0, 1], ['Rebound', 'rebound', 0, 0, 1], ['Rebound', 'A rebound', 0, 0, 1],
  ['Turnover', 'A bad pass (B steals)', 0, 0, 1], ['Turnover', 'A lost ball turnover (B steals)', 0, 0, 1], ['Turnover', 'A traveling', 0, 0, 1],
  ['Turnover', 'shot clock turnover', 0, 0, 1], ['Turnover', 'A out of bounds lost ball turnover', 0, 0, 1], ['Turnover', 'A 3 second turnover', 0, 0, 1],
  ['Turnover', 'turnover', 0, 0, 1], ['Turnover', 'A palming turnover', 0, 0, 1], ['Turnover', 'A offensive foul turnover', 0, 0, 1],
  ['Foul', 'A flagrant foul type 1', 0, 0, 1], ['Foul', 'flagrant', 0, 0, 1], ['Foul', 'A defensive 3-seconds (Technical Foul)', 0, 0, 1],
  ['Foul', 'A technical foul', 0, 0, 1], ['Foul', 'A flopping technical', 0, 0, 1], ['Foul', 'A delay of game', 0, 0, 1], ['Foul', 'technical', 0, 0, 1],
  ['Foul', 'A offensive charge', 0, 0, 1], ['Foul', 'A offensive foul', 0, 0, 1], ['Foul', 'charge', 0, 0, 1], ['Foul', 'A shooting foul', 0, 0, 1],
  ['Foul', 'A shooting block foul', 0, 0, 1], ['Foul', 'A personal take foul', 0, 0, 1], ['Foul', 'A loose ball foul', 0, 0, 1],
  ['Foul', 'A clear path foul', 0, 0, 1], ['Foul', 'A personal foul', 0, 0, 1], ['Foul', 'foul', 0, 0, 1], ['Foul', 'A away from play foul', 0, 0, 1],
  ['Challenge', 'Lakers coach\'s challenge', 0, 0, 1], ['Challenge', 'Challenge: call overturned', 0, 0, 1], ['Challenge', 'challenge support', 0, 0, 1], ['Challenge', 'challenge', 0, 0, 1],
  ['Review', 'Instant replay review overturned', 0, 0, 1], ['Review', 'review: ruling stands', 0, 0, 1], ['Review', 'review', 0, 0, 1],
  ['Violation', 'A defensive goaltending', 0, 0, 1], ['Violation', 'A offensive goaltending', 0, 0, 1], ['Violation', 'A kicked ball violation', 0, 0, 1],
  ['Violation', 'A lane violation', 0, 0, 1], ['Violation', 'A jump ball violation', 0, 0, 1], ['Violation', 'violation', 0, 0, 1],
  ['Ejection', 'A ejected', 0, 0, 1], ['Ejection', 'ejection', 0, 0, 1], ['Other', 'Something makes 3 of 4 with a foul', 0, 0, 1],
  ['Other', 'Instant Replay', 0, 0, 1], ['', 'José Calderón émakes the dunk', 0, 0, 1], ['Other', 'Une passe décisive inconnue', 0, 0, 1],
  ['Other', 'A makes jumper and assists and steals of rebound', 0, 0, 1], ['Free Throw', '  Ĳ makes free throw 1 of 1  ', 1, 1, 1],
].map(([event_type, text_en, scoring, score_value, period]) => ({ event_type, text_en, scoring, score_value, period }));
const vfOut = {
  categories: plays.map((p) => vf.classifyPlay(p.event_type, p.text_en, !!p.scoring)),
  translations: plays.map((p) => vf.translatePlay(p)),
  translations_db: fromDb(plays).map((p) => vf.translatePlay(p)),
  synthetic: synthetic.map((s) => ({ ...s, category: vf.classifyPlay(s.event_type as string, s.text_en as string, !!s.scoring), fr: vf.translatePlay(s as any) })),
  commentary: vf.buildCommentary(plays, { homeAbbr: 'LAL', awayAbbr: 'POR' }),
  commentary_db: vf.buildCommentary(fromDb(plays), { homeAbbr: 'LAL', awayAbbr: 'POR' }),
  // Peu d'actions : complété par les « extras ».
  commentary_short: vf.buildCommentary(plays.slice(0, 90), { homeAbbr: 'LAL', awayAbbr: 'POR' }),
  // Deux fois le match : plafonné à 180 lignes.
  commentary_long: vf.buildCommentary([...plays, ...plays.map((p) => ({ ...p, seq: p.seq + 5000 }))], { homeAbbr: 'LAL', awayAbbr: 'POR' }),
  // Lancers francs sans acteur connu, séries interrompues par un remplacement.
  commentary_ft: vf.buildCommentary(plays.filter((p) => /free throw|enters the game|timeout/i.test(p.text_en)).map((p, i) => (i % 7 === 0 ? { ...p, actor: '' } : p)), { homeAbbr: 'LAL', awayAbbr: 'POR' }),
};
write('vf-401909880.expected.json', vfOut);

// 3. regenerateSubtitles sur une base (schéma réel) : plusieurs scénarios.
const tp = sync.toTimedPlays(plays);
const breaks = sync.findBreaks(tp);
// Coupures audio cohérentes avec les arrêts de jeu : coup d'envoi à 420 s, 30 % des arrêts conservés.
const est = sync.buildMapping(tp, breaks, [{ wall: tp[0].wall, video: 420, method: 'manual', period: tp[0].period, clock_sec: tp[0].clock_sec }], { defaultRho: 0.3 });
const cuts = breaks.map((b, i) => ({ start: est.map(b.interval.start) + ((i % 3) - 1) * 1.5, end: est.map(b.interval.end) - 0.5, meanDb: -60 - i }));
cuts.push({ start: 10, end: 12, meanDb: -70 }, { start: 3000.25, end: 3001, meanDb: -55 });
const duration = Math.round(est.map(tp[tp.length - 1].wall) + 240);
const iso = (w: number) => new Date(w * 1000).toISOString();

interface Scenario {
  name: string;
  video: { okId: string | null; duration: number | null };
  anchors: { period: number; clock_sec: number; video_ts: number; method: string; wallclock: string | null }[];
  settings?: { global_offset: number; quarter_offsets: Record<string, unknown> };
  profile?: { ok_id: string; cuts: unknown };
  parsedPlays?: boolean;
  blankWallclock?: number;
}
const p100 = plays[100];
const p300 = plays[300];
const scenarios: Scenario[] = [
  { name: 'estimation', video: { okId: 'ok1', duration: 8033 }, anchors: [] },
  { name: 'sans-duree', video: { okId: null, duration: null }, anchors: [] },
  { name: 'duree-courte', video: { okId: 'ok1', duration: 3000 }, anchors: [] },
  { name: 'duree-longue', video: { okId: 'ok1', duration: 12000 }, anchors: [] },
  {
    name: 'ancres-et-reglages',
    video: { okId: 'ok1', duration: 8033 },
    anchors: [
      { period: p100.period, clock_sec: p100.clock_sec, video_ts: 2100.5, method: 'manual', wallclock: p100.wallclock },
      { period: p300.period, clock_sec: p300.clock_sec, video_ts: 5200, method: 'manual', wallclock: null },
      { period: 2, clock_sec: 333, video_ts: 3100.25, method: 'auto', wallclock: null },
      { period: 4, clock_sec: 100, video_ts: 7400, method: 'est', wallclock: null },
      { period: 1, clock_sec: 600, video_ts: 900, method: 'audio', wallclock: null },
      { period: 3, clock_sec: 700, video_ts: 100, method: 'auto', wallclock: null },
      { period: 9, clock_sec: 100, video_ts: 50, method: 'manual', wallclock: null },
    ],
    settings: { global_offset: 2.5, quarter_offsets: { '2': -1.25, '4': '3', '3': 'x' } },
  },
  { name: 'audio', video: { okId: 'ok1', duration }, anchors: [{ period: p300.period, clock_sec: p300.clock_sec, video_ts: 5000, method: 'manual', wallclock: p300.wallclock }], profile: { ok_id: 'ok1', cuts } },
  { name: 'audio-autre-video', video: { okId: 'ok2', duration }, anchors: [], profile: { ok_id: 'ok1', cuts } },
  { name: 'audio-sans-coupure-exploitable', video: { okId: 'ok1', duration }, anchors: [], profile: { ok_id: 'ok1', cuts: [{ start: 5, end: 6, meanDb: -60 }] } },
  { name: 'audio-cuts-objet', video: { okId: 'ok1', duration }, anchors: [], profile: { ok_id: 'ok1', cuts: { a: 1 } } },
  { name: 'actions-analysees', video: { okId: 'ok1', duration: 8033 }, anchors: [], parsedPlays: true },
  { name: 'wallclock-vide-une-ancre', video: { okId: 'ok1', duration: 8033 }, anchors: [{ period: p100.period, clock_sec: p100.clock_sec, video_ts: 2000, method: 'manual', wallclock: p100.wallclock }], blankWallclock: 3 },
  { name: 'wallclock-vide-sans-ancre', video: { okId: 'ok1', duration: 8033 }, anchors: [], blankWallclock: 3 },
];

function seed(s: Scenario) {
  db.setDbForTests(db.openDatabase(':memory:'));
  db.upsertMatch(summary.match);
  db.setVideo(ID, { slug: null, okId: s.video.okId, duration: s.video.duration, available: !!s.video.okId });
  const ps = plays.map((p, i) => (s.blankWallclock && i < s.blankWallclock ? { ...p, wallclock: '' } : p));
  db.replacePlays(ID, ps);
  for (const a of s.anchors) db.upsertAnchor({ match_id: ID, ...a } as any);
  if (s.settings) db.saveSyncSettings(ID, s.settings.global_offset, s.settings.quarter_offsets as any);
  if (s.profile) db.saveAudioProfile({ match_id: ID, ok_id: s.profile.ok_id, window_sec: 1, rms_db: [-20, -21.5], cuts: s.profile.cuts as any });
  return ps;
}
const dump = () => ({
  subtitles: db.getDb().prepare('SELECT * FROM subtitles WHERE match_id = ? ORDER BY seq').all(ID),
  anchors: db.getDb().prepare('SELECT * FROM sync_anchors WHERE match_id = ? ORDER BY period, clock_sec, method').all(ID),
});
const subtitleScenarios = scenarios.map((s) => {
  const ps = seed(s);
  let count: number | null = null;
  let error: string | null = null;
  try {
    count = ingest.regenerateSubtitles(ID, s.parsedPlays ? ps : undefined);
  } catch (e) {
    error = (e as Error).message;
  }
  return { ...s, count, error, ...dump() };
});
write('subtitles-401909880.expected.json', { duration, scenarios: subtitleScenarios });

// 4. ingestMatchDetails complet, fiche ESPN servie par un faux fetch.
db.setDbForTests(db.openDatabase(':memory:'));
db.upsertMatches(espn.parseScoreboard(scoreboardRaw));
globalThis.fetch = (async () => new Response(JSON.stringify(summaryRaw), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const before = db.getMatch(ID);
const line = await ingest.ingestMatchDetails(before);
const q = (sql: string) => db.getDb().prepare(sql).all();
write('ingest-401909880.expected.json', {
  line,
  matches: q("SELECT id, espn_id, league, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, home_score, away_score, status, status_detail, period, clock_display, venue, broadcast, stats_synced_at IS NOT NULL AS synced FROM matches ORDER BY id"),
  team_stats: q('SELECT * FROM team_stats ORDER BY rowid'),
  player_stats: q('SELECT * FROM player_stats ORDER BY rowid'),
  match_leaders: q('SELECT * FROM match_leaders ORDER BY rowid'),
  plays: q('SELECT * FROM plays ORDER BY match_id, seq'),
  subtitles: q('SELECT * FROM subtitles ORDER BY match_id, seq'),
});
console.log('fixtures écrites', { subtitles: subtitleScenarios.map((s) => [s.name, s.count, s.error, s.anchors.length]), line, duration });
