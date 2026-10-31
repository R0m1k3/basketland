/**
 * Produit, avec le code Node, les sorties attendues de l'analyse vidéo portée
 * en Rust (étape 7 : ocr.ts, scoreboard.ts) : server/tests/fixtures/ocr.expected.json,
 * comparé par tests/ocr_node.rs.
 *
 * - fonctions pures : parseur du bandeau, jetons des mots, périodes et chronos
 *   déformés, candidats chrono, vote, zones fixes et cases claires (vignettes
 *   des vraies images, recalculées par ffmpeg côté Rust : empreinte SHA-256
 *   vérifiée), empreinte du bandeau, recadrages, scores, cohérence des
 *   observations (play-by-play réel de 401909880) ;
 * - LECTURES ENREGISTRÉES : localisation et lecture des vraies images
 *   (tests/real-frames.test.ts) et des images synthétiques
 *   (tests/scoreboard.test.ts) avec tesseract.js ; chaque appel OCR est
 *   enregistré (empreinte SHA-256 de l'image filtrée, psm, alphabet → texte et
 *   mots). Rust rejoue le même enchaînement avec ces réponses : localisations,
 *   lectures et nombre d'appels doivent être identiques à l'octet. Les mêmes
 *   images servent à comparer Tesseract natif et tesseract.js (tests avec la
 *   fonction `ocr`).
 *
 * À relancer après une modification de ces modules, depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-ocr.mts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'server', 'tests', 'fixtures');
const DIR = path.join(ROOT, 'tests', 'fixtures', 'real-frames');
process.env.DB_PATH = ':memory:';
process.chdir(ROOT);

const ocr = await import(path.join(ROOT, 'src/lib/ocr.ts'));
const sb = await import(path.join(ROOT, 'src/lib/scoreboard.ts'));
const sync = await import(path.join(ROOT, 'src/lib/sync.ts'));
const espn = await import(path.join(ROOT, 'src/lib/espn.ts'));
const img = await import(path.join(ROOT, 'tests/helpers/scoreboardImages.ts'));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const out: Record<string, unknown> = {};

/** Générateur pseudo-aléatoire à graine fixe (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ moteur enregistré

type Word = [string, number, number, number, number, number];
const calls: Record<string, { text: string; words: Word[] }> = {};
const order: string[] = [];
const worker = await ocr.createOcrWorker();
let params = { psm: '11', whitelist: '' };
const recorder = {
  async setParameters(p: Record<string, string>) {
    params = { psm: p.tessedit_pageseg_mode, whitelist: p.tessedit_char_whitelist };
    return worker.setParameters!(p);
  },
  async recognize(image: Buffer, o: object, output: object) {
    const r = await worker.recognize(image, o, output);
    const key = `${sha(image)}|${params.psm}|${params.whitelist}`;
    if (!calls[key]) {
      const words: Word[] = [];
      for (const b of r.data.blocks ?? [])
        for (const p of b.paragraphs ?? [])
          for (const l of p.lines ?? [])
            for (const w of l.words ?? []) words.push([w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1, w.confidence]);
      calls[key] = { text: r.data.text ?? '', words };
    }
    order.push(key);
    return r;
  },
  async terminate() {
    return worker.terminate();
  },
};

/** Image 1280x720 de tests/real-frames.test.ts : haut bruité + bas réel. */
function frame(file: string, seed: number): Buffer {
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x707070:s=1280x432:d=1,noise=alls=90:allf=t:all_seed=${seed}`,
      '-i', path.join(DIR, file),
      '-filter_complex', '[0:v][1:v]vstack=inputs=2,format=rgb24',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
const files = (match: string) =>
  fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith(`${match}-`) && f.endsWith('.jpg'))
    .sort((a, b) => Number(/t(\d+)/.exec(a)![1]) - Number(/t(\d+)/.exec(b)![1]));

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
const runs: unknown[] = [];
const allWords: Word[][] = [];
const frameShas: Record<string, string> = {};
const locs: Record<string, unknown> = {};

// 1. Vraies images : localisation puis lecture de chaque image (tests/real-frames.test.ts).
const realFrames: Record<string, Buffer[]> = {};
for (const match of ['nybos', 'memgs', 'denokc']) {
  const fs_ = files(match);
  const frames = fs_.map((f, i) => frame(f, i + 1));
  realFrames[match] = frames;
  frames.forEach((f, i) => (frameShas[`${fs_[i]}|${i + 1}`] = sha(f)));
  const loc = await sb.locateScoreboard(recorder, frames);
  locs[match] = loc.location;
  const reads = [];
  for (const f of frames) reads.push(json(await sb.readScoreboard(recorder, f, loc.location)));
  runs.push({ kind: 'reel', match, files: fs_, locate: { location: json(loc.location), readings: json(loc.readings), ocrCalls: loc.ocrCalls, method: loc.method ?? null }, reads });
}
// 2. Plans sans bandeau : repli pleine largeur (2 images) et gabarits appris.
{
  const empty = [...files('laclal'), 'nybos-16607260052140-t2100.jpg', 'denokc-16592868674220-t2900.jpg'];
  const reads: unknown[] = [];
  for (const [i, f] of empty.entries()) {
    const png = frame(f, 100 + i);
    frameShas[`${f}|${100 + i}`] = sha(png);
    if (i < 2) reads.push({ file: f, seed: 100 + i, loc: null, reading: json(await sb.readScoreboard(recorder, png, null)) });
    for (const m of ['nybos', 'memgs', 'denokc']) {
      const loc = locs[m];
      if (loc) reads.push({ file: f, seed: 100 + i, loc: m, reading: json(await sb.readScoreboard(recorder, png, loc)) });
    }
  }
  runs.push({ kind: 'vide', reads });
}
// 3. Images synthétiques (tests/scoreboard.test.ts).
if (img.testFont()) {
  const STATES = [
    { away: 'PHI', home: 'IND', awayScore: 54, homeScore: 61, period: '2ND', clock: '7:43', shot: '14' },
    { away: 'PHI', home: 'IND', awayScore: 88, homeScore: 85, period: '3RD', clock: '2:05', shot: '9' },
  ];
  const PROBE = { away: 'PHI', home: 'IND', awayScore: 101, homeScore: 99, period: '4TH', clock: '42.8', shot: '5' };
  const asQ = (s: typeof PROBE) => ({ ...s, period: `Q${s.period[0]}` });
  for (const layout of ['bottom-wide', 'bottom-left', 'top-right', 'bottom-light'] as const) {
    const q = layout === 'top-right';
    const specs = STATES.map((s, i) => img.scoreboardScene(layout, q ? asQ(s) : s, i + 2));
    const frames = specs.map((s) => img.renderScene(s));
    const loc = await sb.locateScoreboard(recorder, frames);
    const probeSpec = img.scoreboardScene(layout, q ? asQ(PROBE) : PROBE, 9);
    const probe = img.renderScene(probeSpec);
    const read = json(await sb.readScoreboard(recorder, probe, loc.location));
    runs.push({ kind: 'synthetique', layout, specs, probeSpec, shas: frames.map(sha), probeSha: sha(probe), locate: { location: json(loc.location), readings: json(loc.readings), ocrCalls: loc.ocrCalls, method: loc.method ?? null }, read });
  }
  const s0 = img.scoreboardScene('bottom-left', STATES[0], 5);
  const p0 = img.renderScene(s0);
  runs.push({ kind: 'synthetique-repli', spec: s0, sha: sha(p0), read: json(await sb.readScoreboard(recorder, p0, null)) });
  const emptySpec = { seed: 1, boxes: [], texts: [] };
  const e0 = img.renderScene(emptySpec);
  const le = await sb.locateScoreboard(recorder, [e0]);
  runs.push({ kind: 'synthetique-vide', spec: emptySpec, sha: sha(e0), locate: { location: json(le.location), readings: json(le.readings), ocrCalls: le.ocrCalls, method: le.method ?? null } });
}
await worker.terminate();
for (const k of order) if (calls[k].words.length) allWords.push(calls[k].words);
out.font = img.testFont();
out.frameShas = frameShas;
out.runs = runs;
out.calls = calls;
out.callCount = order.length;
out.tesseract = (await import(path.join(ROOT, 'node_modules/tesseract.js/package.json'), { with: { type: 'json' } })).default.version;

// ------------------------------------------------------------------ fonctions pures

const cases: { fn: string; input: unknown; output: unknown }[] = [];
const add = (fn: string, input: unknown, f: () => unknown) => {
  let output: unknown;
  try {
    output = { ok: json(f()) };
  } catch (e) {
    output = { err: (e as Error).message };
  }
  cases.push({ fn, input, output });
};

// Textes : corpus écrit à la main + tous les textes et mots lus par tesseract.js ci-dessus.
const texts = new Set<string>([
  'N 1:24 6 1 2ND24 TN 157 SR', '1:24 2ND24 1STT 11', '3:49 4TH 24 12 HTTRST1TRTS', '3:49 4TH 24 .', ':. . 3:45 3RO 17 1 1TTT',
  '. 3:45 0 RO 17 OT7THH', '. 1 11:02 0 187 20 HTN', '8:41 1ST', '1ST 8:41', '42.8 4TH', '1:12 OT', 'POR 2-0 LAL', 'NBA ON NBC', '13:05 1ST',
  '2ND :29.7 24', '114:562', '011:4814', '9:75', '857', '8.57', '1006', '1306', '57', '129.7', '6:57', 'B:57', '187', '1T', '1sT', '3R0',
  '2N0', 'OND', 'ND', 'TH', '3ND', '10', '24', '20', '4', '2m', 'H54ND61Q27:43', 'H12ND9Q19:12', '2ND24', '5461', 'Q4', '1:12', '7:', '43',
  'OT2 4:00', 'ot', 'Q2 7:43', '12:00', '12:01', '0:00.0', '1:02.3', '59.9', '60.1', ':.5', '1.2.3', 'Q27:43', '27:43', '1:2:34', 'ÉQ3 1:00',
  '1ˢᵀ', 'ⁿᵈ 7:47', '«Xd', '54-28', '|2ND|8:00|', '  2nd   8:00  ', '1S7', '4T4 0:01', 'OT 6:00', 'OT3 2:00', '15T', '1ST4:56', '4TH24',
  '100012', '0102', '199200', '07:43', '7:430', '7.43', '23.4.5', '2ND 8:00 12', '42208:0012', 'Q1 9:12', 'Q5 1:00', 'Q0 1:00',
]);
for (const c of Object.values(calls)) {
  texts.add(c.text);
  for (const w of c.words) texts.add(w[0]);
}
const textList = [...texts];
for (const t of textList) {
  const n = ocr.normalizeOcrText(t);
  add('texte', t, () => ({
    normalize: n,
    period: ocr.parsePeriodText(n),
    clocks: ocr.parseClockCandidates(n),
    scoreboard: ocr.parseScoreboardText(t),
    word: sb.analyzeWord(t),
    loose: sb.loosePeriod(t),
    looseStrict: sb.loosePeriod(t, { bareSuffix: false }),
    colonless: sb.colonlessClock(t),
    glued: sb.gluedClock(t),
    slot: sb.clockFromSlotText(t),
  }));
}

// Mots : candidats chrono, recollage, période d'une case (listes lues par tesseract.js).
const toWords = (ws: Word[]) => ws.map(([text, x0, y0, x1, y1, confidence]) => ({ text, x0, y0, x1, y1, confidence }));
const r = rng(7);
const lists = allWords.filter(() => r() < 0.5).slice(0, 700);
lists.push(
  [['54', 300, 620, 340, 645, 90], ['61', 380, 620, 420, 645, 90], ['2ND', 600, 620, 650, 645, 90], ['7:43', 670, 620, 730, 645, 90]],
  [['3RD', 200, 580, 250, 605, 90], ['4:05', 200, 615, 260, 640, 90]],
  [['2ND', 50, 100, 100, 125, 90], ['7:43', 900, 620, 960, 645, 90]],
  [['7:', 100, 10, 120, 40, 90], ['43', 122, 10, 152, 40, 90]],
  [['7:', 100, 10, 120, 40, 90], ['43', 400, 10, 430, 40, 90]],
  [['20', 0, 0, 30, 20, 80]], [['4', 0, 0, 30, 20, 80]], [['4', 0, 0, 30, 30, 80]], [['2m', 0, 0, 30, 17, 80]], [['4', 0, 0, 30, 24, 80]], [['2', 0, 0, 30, 3, 80]],
);
for (const [i, ws] of lists.entries()) {
  const words = toWords(ws);
  add('mots', { words: ws, frame: i % 3 }, () => ({
    candidates: sb.findClockCandidates(words, 1280, 720, i % 3),
    merged: sb.mergeSplitClocks(words),
    slot: [17, 25, 40].flatMap((px) => [sb.periodFromSlot(words, px), sb.periodFromSlot(words, px, false), sb.periodFromSlot(words, px, true, true), sb.periodFromSlot(words, px, false, false)]),
  }));
}

// Vote : candidats de mots réels regroupés par « image », et cas de tests/scoreboard.test.ts.
for (let k = 0; k < 40; k++) {
  const g = rng(100 + k);
  const n = 1 + Math.floor(g() * 8);
  const cands: unknown[] = [];
  for (let f = 0; f < n; f++) {
    const ws = toWords(allWords[Math.floor(g() * allWords.length)]);
    cands.push(...sb.findClockCandidates(ws, 1280, 720, f));
  }
  const sampled = g() < 0.2 ? undefined : n;
  add('vote', { cands, sampledFrames: sampled ?? null }, () => {
    const v = sb.voteScoreboardRegion(cands as never, { sampledFrames: sampled });
    return v;
  });
}
const cand = (frame: number, x: number, y: number, strong = true) => ({ frame, period: strong ? 2 : null, clock_sec: 400, rect: { x, y, w: 0.1, h: 0.03 }, clockRect: { x: x + 0.05, y, w: 0.05, h: 0.03 }, textH: 0.03, scores: [], scoreRects: [], strong });
for (const [cs, sampled] of [
  [[cand(0, 0.5, 0.87), cand(1, 0.505, 0.872), cand(2, 0.498, 0.869), cand(1, 0.1, 0.1)], 3],
  [[cand(0, 0.5, 0.87)], 8],
  [[cand(0, 0.5, 0.87, false), cand(1, 0.2, 0.3, false)], 2],
  [[cand(0, 0.5, 0.87, false), cand(1, 0.5, 0.87, false), cand(2, 0.5, 0.87, false)], 8],
  [[cand(0, 0.5, 0.87)], 1],
  [[], 3],
] as const) {
  add('vote', { cands: cs, sampledFrames: sampled }, () => sb.voteScoreboardRegion(cs as never, { sampledFrames: sampled }));
}

// Vignettes des vraies images : zones fixes, cases claires, empreinte du bandeau.
for (const [match, frames] of Object.entries(realFrames)) {
  const thumbs: Buffer[] = [];
  for (const f of frames) thumbs.push(await ocr.rawGray(f, sb.THUMB_W, sb.THUMB_H));
  for (const minAgree of [0.4, 0.6]) {
    const zones = sb.staticOverlayRegions(thumbs, { minAgree });
    add('zones', { match, minAgree, thumbs: thumbs.map(sha) }, () => ({
      zones,
      cells: zones.map((z: { rect: unknown }) => sb.staticBrightCells(thumbs, z.rect as never, { minAgree })),
      panels: zones.map((z: { rect: { x: number; y: number; w: number; h: number } }) => {
        const p = sb.panelSignature(thumbs, z.rect);
        return p ? { sig: p, presence: thumbs.map((t) => sb.panelPresence(t, p)) } : null;
      }),
    }));
  }
}
// Vignettes synthétiques de tests/scoreboard-real-rules.test.ts.
function thumb(seed: number, overlays: { x: number; y: number; w: number; h: number; v: number; digits?: boolean }[]): Buffer {
  const b = Buffer.alloc(sb.THUMB_W * sb.THUMB_H);
  let s = seed * 7919 + 17;
  const blocks: number[] = [];
  for (let i = 0; i < (sb.THUMB_W / 16) * Math.ceil(sb.THUMB_H / 16); i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    blocks.push(40 + ((s >>> 16) % 180));
  }
  for (let y = 0; y < sb.THUMB_H; y++) for (let x = 0; x < sb.THUMB_W; x++) b[y * sb.THUMB_W + x] = blocks[Math.floor(y / 16) * (sb.THUMB_W / 16) + Math.floor(x / 16)];
  for (const o of overlays)
    for (let y = o.y; y < o.y + o.h; y++)
      for (let x = o.x; x < o.x + o.w; x++) {
        const border = y === o.y || y === o.y + o.h - 1 || x === o.x || x === o.x + o.w - 1;
        const digit = o.digits && y > o.y + 2 && y < o.y + o.h - 3 && (x + seed) % 5 === 0;
        b[y * sb.THUMB_W + x] = border ? 10 : digit ? 30 : o.v;
      }
  return b;
}
{
  const bug = [{ x: 100, y: 150, w: 120, h: 14, v: 30 }, { x: 150, y: 152, w: 24, h: 10, v: 235, digits: true }];
  const withBug = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => thumb(i, bug));
  const noBug = thumb(99, []);
  const all = [...withBug, noBug];
  const z = sb.staticOverlayRegions(all);
  const zb = sb.staticOverlayRegions(withBug);
  const sig = sb.panelSignature(withBug, { x: 100 / sb.THUMB_W, y: 150 / sb.THUMB_H, w: 120 / sb.THUMB_W, h: 14 / sb.THUMB_H });
  add('vignettes', { thumbs: all.map(sha) }, () => ({ z, zb, cells: sb.staticBrightCells(withBug, zb[0].rect), sig, presence: [sb.panelPresence(thumb(42, bug), sig!), sb.panelPresence(noBug, sig!)] }));
}

// Recadrages.
{
  const g = rng(11);
  const rects = Array.from({ length: 60 }, () => ({ x: g() * 1.1 - 0.05, y: g() * 1.1 - 0.05, w: g() * 0.6, h: g() * 0.3 }));
  for (const r0 of rects) {
    const k = 1 + g() * 5;
    add('recadrage', { r: r0, k }, () => ({
      crop: sb.pixelCrop(r0, 1280, 720),
      crop480: sb.pixelCrop(r0, 854, 480),
      filters: (['light', 'lightHigh', 'gray', 'dark'] as const).map((b) => sb.cropFilter(r0, 1280, 720, k, b)),
      upscale: sb.upscaleFor(r0.h * 720),
    }));
  }
}

// Scores et cohérence : play-by-play réel (pbp.json pour les scores, 401909880 pour les horaires).
{
  const pbp = JSON.parse(fs.readFileSync(path.join(DIR, 'pbp.json'), 'utf8')) as Record<string, { plays: number[][] }>;
  const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf8')) as Record<string, Record<string, { period: number; clock: number; away: number; home: number | null } | null>>;
  for (const m of ['nybos', 'memgs', 'denokc']) {
    const plays = pbp[m].plays.map((p) => ({ seq: p[0], period: p[1], clock_sec: p[2], home_score: p[3], away_score: p[4] }));
    const tl = ocr.scoreTimeline(plays);
    const checks: unknown[] = [];
    const g = rng(m.length * 31);
    for (const t of Object.values(truth[m])) {
      if (!t || t.home === null) continue;
      checks.push({ read: [t.away, t.home], period: t.period, clock: t.clock });
      checks.push({ read: [t.away + 1, t.home, 24], period: t.period, clock: t.clock });
      checks.push({ read: [t.away, t.home], period: Math.min(4, t.period + 1), clock: t.clock });
    }
    for (let i = 0; i < 30; i++) checks.push({ read: [Math.floor(g() * 120), Math.floor(g() * 120)], period: 1 + Math.floor(g() * 4), clock: Math.floor(g() * 721) });
    add('scores', { plays, checks }, () => ({ timeline: tl, matches: checks.map((c: { read: number[]; period: number; clock: number }) => ocr.scoresMatchAt(c.read, tl, c.period, c.clock)) }));
  }
  const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'espn-summary-401909880.json'), 'utf8'));
  const s = espn.parseSummary(summary, 401909880);
  const tp = sync.toTimedPlays(s.plays);
  const breaks = sync.findBreaks(tp);
  const playRows = s.plays.map((p: { seq: number; period: number; clock_sec: number; wallclock: string; home_score: number | null; away_score: number | null }) => ({ seq: p.seq, period: p.period, clock_sec: p.clock_sec, wallclock: p.wallclock, home_score: p.home_score, away_score: p.away_score }));
  const timeline = ocr.scoreTimeline(playRows);
  const w0 = tp[0].wall;
  const intervals: unknown[] = [];
  for (const p of tp.filter((_: unknown, i: number) => i % 7 === 0)) intervals.push([p.period, p.clock_sec, ocr.clockWallInterval(p.period, p.clock_sec, tp)]);
  for (const [p, c] of [[1, 720], [2, 0], [4, 0], [3, 333], [5, 100], [1, 721]]) intervals.push([p, c, ocr.clockWallInterval(p, c, tp)]);
  const sets: unknown[] = [];
  for (let k = 0; k < 12; k++) {
    const g = rng(500 + k);
    const obs: unknown[] = [];
    for (const p of tp) {
      if (g() > 0.06) continue;
      // Vidéo plus courte que le match (pauses coupées) : rapport ≈ 0,7, plus du bruit.
      const video = Math.round(((p.wall - w0) * 0.7 + 300 + (g() - 0.5) * 20) * 10) / 10;
      const row = playRows.find((x: { seq: number }) => x.seq === p.seq)!;
      const o: Record<string, unknown> = { video_ts: video, period: g() < 0.25 ? null : p.period, clock_sec: g() < 0.08 ? Math.floor(g() * 720) : p.clock_sec };
      if (g() < 0.7 && row.home_score !== null) o.scores = g() < 0.2 ? [row.away_score + 3, row.home_score] : [row.away_score, row.home_score, 24];
      obs.push(o);
    }
    const opts = k % 3 === 0 ? {} : k % 3 === 1 ? { scores: timeline } : { scores: timeline, tolerance: 5, frozenMax: 20 };
    sets.push({ obs, opts: { tolerance: (opts as { tolerance?: number }).tolerance ?? null, frozenMax: (opts as { frozenMax?: number }).frozenMax ?? null, scores: 'scores' in opts }, anchors: ocr.selectConsistentObservations(obs as never, tp, breaks, opts) });
  }
  add('coherence', { plays: playRows }, () => ({ intervals, sets, timeline }));
}
out.cases = cases;

fs.writeFileSync(path.join(OUT, 'ocr.expected.json'), JSON.stringify(out));
console.log(`ocr.expected.json : ${order.length} appels OCR (${Object.keys(calls).length} distincts), ${cases.length} cas`);
