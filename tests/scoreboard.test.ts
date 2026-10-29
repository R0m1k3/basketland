import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  analyzeWord,
  findClockCandidates,
  locateScoreboard,
  mergeSplitClocks,
  readScoreboard,
  voteScoreboardRegion,
  type ClockCandidate,
  type Rect,
} from '../src/lib/scoreboard';
import { createOcrWorker, pngSize, type OcrWord, type OcrWorker } from '../src/lib/ocr';
import { ffmpegOk, LAYOUT_RECTS, renderScene, scoreboardScene, testFont, type BugState, type LayoutName } from './helpers/scoreboardImages';

const word = (text: string, x0: number, y0: number, w: number, h: number): OcrWord => ({ text, x0, y0, x1: x0 + w, y1: y0 + h, confidence: 90 });

describe('analyzeWord — jetons collés par tesseract', () => {
  it('lit "H54ND61Q27:43" : Q2, 7:43 et les scores 54 / 61', () => {
    const t = analyzeWord('H54ND61Q27:43');
    expect(t.period).toBe(2);
    expect(t.clock).toBe(463);
    expect(t.numbers).toEqual(expect.arrayContaining([54, 61]));
  });

  it('prend la période la plus proche du chrono ("H12ND9Q19:12" = 1re période, pas le « 2ND » de IND)', () => {
    const t = analyzeWord('H12ND9Q19:12');
    expect(t.period).toBe(1);
    expect(t.clock).toBe(552);
  });

  it('lit la forme collée au shot clock "2ND24" (période 2, pas de chrono)', () => {
    const t = analyzeWord('2ND24');
    expect(t.period).toBe(2);
    expect(t.clock).toBeNull();
    expect(t.numbers).toContain(24);
  });

  it('propose les coupures plausibles de deux scores collés ("5461")', () => {
    expect(analyzeWord('5461').numbers).toEqual(expect.arrayContaining([54, 61]));
  });

  it('lit le format « Q4 » isolé et les dixièmes de la dernière minute', () => {
    expect(analyzeWord('Q4').period).toBe(4);
    expect(analyzeWord('42.8').clock).toBe(43);
  });

  it('ne lit pas "1:12" comme un score', () => {
    expect(analyzeWord('1:12').numbers).toEqual([]);
  });
});

describe('mergeSplitClocks', () => {
  it('recolle "7:" + "43" sur la même ligne', () => {
    const out = mergeSplitClocks([word('7:', 100, 10, 20, 30), word('43', 122, 10, 30, 30)]);
    expect(out.map((w) => w.text)).toEqual(['7:43']);
  });

  it('ne recolle pas deux mots éloignés', () => {
    const out = mergeSplitClocks([word('7:', 100, 10, 20, 30), word('43', 400, 10, 30, 30)]);
    expect(out).toHaveLength(2);
  });
});

describe('findClockCandidates', () => {
  const W = 1280;
  const H = 720;

  it('associe le chrono à la période voisine sur la même ligne et relève les scores', () => {
    const c = findClockCandidates([word('54', 300, 620, 40, 25), word('61', 380, 620, 40, 25), word('2ND', 600, 620, 50, 25), word('7:43', 670, 620, 60, 25)], W, H);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ period: 2, clock_sec: 463, strong: true });
    expect(c[0].scores).toEqual(expect.arrayContaining([54, 61]));
    expect(c[0].rect.x).toBeCloseTo(600 / W, 3);
  });

  it('accepte une période empilée au-dessus du chrono (chaîne locale)', () => {
    const c = findClockCandidates([word('3RD', 200, 580, 50, 25), word('4:05', 200, 615, 60, 25)], W, H);
    expect(c[0]).toMatchObject({ period: 3, clock_sec: 245, strong: true });
  });

  it("n'associe pas une période trop lointaine (chrono seul = lecture faible)", () => {
    const c = findClockCandidates([word('2ND', 50, 100, 50, 25), word('7:43', 900, 620, 60, 25)], W, H);
    expect(c[0]).toMatchObject({ period: null, strong: false });
  });
});

describe('voteScoreboardRegion', () => {
  const cand = (frame: number, x: number, y: number, strong = true): ClockCandidate => ({
    frame,
    period: strong ? 2 : null,
    clock_sec: 400,
    rect: { x, y, w: 0.1, h: 0.03 },
    textH: 0.03,
    scores: [],
    scoreRects: [],
    strong,
  });

  it('retient la région récurrente et écarte un chrono isolé (pub, autre match)', () => {
    const v = voteScoreboardRegion([cand(0, 0.5, 0.87), cand(1, 0.505, 0.872), cand(2, 0.498, 0.869), cand(1, 0.1, 0.1)], { sampledFrames: 3 });
    expect(v).not.toBeNull();
    expect(v!.core.x).toBeCloseTo(0.5, 2);
    expect(v!.frames).toBe(3);
    // La région de lecture englobe le bloc chrono avec une marge.
    expect(v!.rect.x).toBeLessThan(v!.core.x);
    expect(v!.rect.x + v!.rect.w).toBeGreaterThan(v!.core.x + v!.core.w);
  });

  it("refuse une région vue sur une seule image parmi plusieurs", () => {
    expect(voteScoreboardRegion([cand(0, 0.5, 0.87)], { sampledFrames: 8 })).toBeNull();
  });

  it('refuse des lectures faibles qui ne se répètent pas', () => {
    expect(voteScoreboardRegion([cand(0, 0.5, 0.87, false), cand(1, 0.2, 0.3, false)], { sampledFrames: 2 })).toBeNull();
  });
});

// ------------------------------------------------------------------ images de test (ffmpeg + tesseract)

const canRender = ffmpegOk() && !!testFont();

const STATES: BugState[] = [
  { away: 'PHI', home: 'IND', awayScore: 54, homeScore: 61, period: '2ND', clock: '7:43', shot: '14' },
  { away: 'PHI', home: 'IND', awayScore: 88, homeScore: 85, period: '3RD', clock: '2:05', shot: '9' },
];
const PROBE: BugState = { away: 'PHI', home: 'IND', awayScore: 101, homeScore: 99, period: '4TH', clock: '42.8', shot: '5' };

function inside(core: Rect, expected: Rect): boolean {
  const cx = core.x + core.w / 2;
  const cy = core.y + core.h / 2;
  return cx >= expected.x && cx <= expected.x + expected.w && cy >= expected.y && cy <= expected.y + expected.h;
}

const asQ = (s: BugState): BugState => ({ ...s, period: `Q${s.period[0]}` });

describe.skipIf(!canRender)('localisation sur images de diffusion synthétiques', () => {
  let worker: OcrWorker;
  beforeAll(async () => {
    worker = await createOcrWorker();
  }, 60_000);
  afterAll(async () => {
    await worker?.terminate();
  });

  const layouts: LayoutName[] = ['bottom-wide', 'bottom-left', 'top-right', 'bottom-light'];
  for (const layout of layouts) {
    it(
      `trouve le bandeau « ${layout} » puis lit la région seule`,
      async () => {
        const q = layout === 'top-right';
        const frames = STATES.map((s, i) => renderScene(scoreboardScene(layout, q ? asQ(s) : s, i + 2)));
        expect(pngSize(frames[0])).toEqual({ width: 1280, height: 720 });
        const t0 = Date.now();
        const r = await locateScoreboard(worker, frames);
        const locMs = Date.now() - t0;
        expect(r.location).not.toBeNull();
        expect(inside(r.location!.core, LAYOUT_RECTS[layout])).toBe(true);
        // Les lectures des images échantillons sont réutilisables comme observations.
        expect(r.readings[0]).toMatchObject({ period: 2, clock_sec: 463 });
        expect(r.readings[1]).toMatchObject({ period: 3, clock_sec: 125 });

        const probe = renderScene(scoreboardScene(layout, q ? asQ(PROBE) : PROBE, 9));
        const t1 = Date.now();
        const read = await readScoreboard(worker, probe, r.location);
        const readMs = Date.now() - t1;
        expect(read).toMatchObject({ period: 4, clock_sec: 43 });
        console.log(`[mesure] ${layout} : localisation ${locMs} ms (${r.ocrCalls} OCR, 2 images), lecture région ${readMs} ms`);
      },
      120_000,
    );
  }

  it(
    'sans bandeau localisé, lit quand même les bandes en pleine largeur',
    async () => {
      const png = renderScene(scoreboardScene('bottom-left', STATES[0], 5));
      const read = await readScoreboard(worker, png, null);
      expect(read).toMatchObject({ period: 2, clock_sec: 463 });
    },
    60_000,
  );

  it(
    "ne localise rien sur des images sans bandeau",
    async () => {
      const frames = [renderScene({ seed: 1, boxes: [], texts: [] })];
      const r = await locateScoreboard(worker, frames);
      expect(r.location).toBeNull();
    },
    120_000,
  );
});
