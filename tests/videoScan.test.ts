import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSummary } from '../src/lib/espn';
import { findBreaks, resolveAnchorWall, toTimedPlays } from '../src/lib/sync';
import { clockWallInterval, parseScoreboardText, scoresMatchAt, scoreTimeline, selectConsistentObservations, type FrameObservation } from '../src/lib/ocr';
import { coarseTimes, planRefinement, safeStep, scanVideo, spread } from '../src/lib/videoScan';
import type { OcrWorker } from '../src/lib/ocr';
import { makeTruth, stateAt } from './helpers/syntheticVideo';

const summary = parseSummary(
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'espn-summary-401909880.json'), 'utf8')) as Record<string, unknown>,
  401909880,
);
const plays = summary.plays;
const tp = toTimedPlays(plays);
const breaks = findBreaks(tp);
const truth = makeTruth(tp, breaks);
const scores = scoreTimeline(plays);

/** Lecture parfaite du bandeau à l'instant vidéo t (sans bandeau pendant une partie des pubs). */
function perfectRead(t: number, hideInBreaks = true) {
  const s = stateAt(plays, breaks, truth.wallAt(t));
  if (!s || (hideInBreaks && s.inBreak && Math.floor(t / 37) % 5 < 3)) return null;
  return { period: s.period, clock_sec: s.clock, scores: [s.home, s.away] };
}

describe('outils de planification', () => {
  it('safeStep borne le pas (NaN, 0, valeurs minuscules)', () => {
    expect(safeStep('abc', 105)).toBe(105);
    expect(safeStep(0, 105)).toBe(105);
    expect(safeStep(3, 105, 20)).toBe(20);
    expect(safeStep(90.7, 105)).toBe(90);
  });

  it('spread et coarseTimes', () => {
    expect(spread(0, 100, 3)).toEqual([0, 50, 100]);
    expect(coarseTimes(500, 100)).toEqual([30, 130, 230, 330, 430]);
    expect(coarseTimes(500, 100, [128])).toEqual([30, 230, 330, 430]);
  });
});

describe('planRefinement', () => {
  it('cible la fenêtre vidéo des quarts-temps sans ancre', () => {
    // Ancres connues seulement en Q1 et Q4.
    const anchors = tp
      .filter((p, i) => (p.period === 1 && i % 40 === 5) || (p.period === 4 && i % 40 === 5))
      .map((p) => ({ wall: p.wall, video: truth.vmap(p.wall), method: 'auto' as const, period: p.period, clock_sec: p.clock_sec }));
    const plan = planRefinement({ anchors, observations: [], scanned: [], duration: truth.duration, tp, breaks });
    expect(plan.length).toBeGreaterThan(0);
    const q2 = tp.filter((p) => p.period === 2);
    const q3 = tp.filter((p) => p.period === 3);
    const inWindow = (t: number, ps: typeof tp) => t >= truth.vmap(ps[0].wall) - 200 && t <= truth.vmap(ps[ps.length - 1].wall) + 200;
    expect(plan.some((t) => inWindow(t, q2))).toBe(true);
    expect(plan.some((t) => inWindow(t, q3))).toBe(true);
    // Rien n'est replanifié dans Q1 (déjà couvert), hors trous et contradictions.
    expect(plan.every((t) => t < truth.duration - 5 && t >= 0)).toBe(true);
  });

  it('ne replanifie pas un instant déjà lu', () => {
    const plan = planRefinement({ anchors: [], observations: [], scanned: [], duration: truth.duration, tp, breaks });
    const again = planRefinement({ anchors: [], observations: [], scanned: plan, duration: truth.duration, tp, breaks });
    for (const t of again) expect(plan.some((s) => Math.abs(s - t) < 15)).toBe(false);
  });
});

describe('scanVideo (lecture simulée, sans OCR)', () => {
  const fakeWorker = { recognize: async () => ({ data: { text: '' } }), terminate: async () => undefined } as unknown as OcrWorker;
  const loc = { rect: { x: 0.4, y: 0.85, w: 0.2, h: 0.06 }, core: { x: 0.45, y: 0.86, w: 0.1, h: 0.03 }, textH: 0.03, frames: 8, strongFrames: 8 };

  it('obtient au moins une ancre précise par quart-temps, calée à quelques secondes près', async () => {
    const r = await scanVideo({
      duration: truth.duration,
      tp,
      breaks,
      scores,
      location: loc,
      grab: async (t) => Buffer.from(String(t)),
      read: async (png) => perfectRead(Number(png.toString())),
      worker: fakeWorker,
    });
    expect(r.cachedLocation).toBe(true);
    expect(Object.keys(r.perPeriod).map(Number).sort()).toEqual([1, 2, 3, 4]);
    for (const a of r.anchors) expect(Math.abs(a.video - truth.vmap(a.wall))).toBeLessThan(5);
    // Budget borné : passe grossière (~105 s) + affinage.
    expect(r.framesRead).toBeLessThan(120);
  });

  it('relocalise quand la localisation en cache ne lit plus rien', async () => {
    const stale = { ...loc, core: { x: 0.05, y: 0.05, w: 0.1, h: 0.03 } };
    let located = false;
    const r = await scanVideo({
      duration: truth.duration,
      tp,
      breaks,
      scores,
      location: stale,
      sampleFrames: 2,
      grab: async (t) => Buffer.from(String(t)),
      // Ne lit que si la région n'est PAS celle du cache (relocalisation faite).
      read: async (png, l) => (l && l.core.x === 0.05 ? null : perfectRead(Number(png.toString()))),
      locate: async (frames) => {
        located = true;
        return { location: loc, readings: frames.map(() => null), ocrCalls: 0 };
      },
      worker: fakeWorker,
    });
    expect(located).toBe(true);
    expect(r.location?.core.x).not.toBe(0.05);
    expect(r.anchors.length).toBeGreaterThan(3);
  });

  it("affine là où la passe grossière n'a rien lu", async () => {
    // Le bandeau est illisible pendant tout le 2e quart-temps, sauf sur ~1 image sur 4.
    const q2 = tp.filter((p) => p.period === 2);
    const [v2s, v2e] = [truth.vmap(q2[0].wall), truth.vmap(q2[q2.length - 1].wall)];
    const reads: number[] = [];
    const r = await scanVideo({
      duration: truth.duration,
      tp,
      breaks,
      scores,
      location: loc,
      stepSec: 300,
      grab: async (t) => Buffer.from(String(t)),
      read: async (png) => {
        const t = Number(png.toString());
        reads.push(t);
        if (t >= v2s && t <= v2e && reads.length % 4 !== 0) return null;
        return perfectRead(t, false);
      },
      worker: fakeWorker,
    });
    expect(r.perPeriod[2] ?? 0).toBeGreaterThan(0);
  });
});

describe('selectConsistentObservations — chrono arrêté et scores', () => {
  it('intervalle de chrono arrêté : instant si le chrono tourne, durée de l’arrêt sinon', () => {
    // 2e quart, 1:24 : plusieurs actions au même chrono (arrêt de ~40 s).
    const frozen = clockWallInterval(2, 84, tp)!;
    expect(frozen.hi - frozen.lo).toBeGreaterThan(20);
    // Chrono qui n'apparaît dans aucune action : un instant.
    const running = clockWallInterval(3, 225, tp)!;
    expect(running.hi).toBe(running.lo);
  });

  it('modèle de reprise : un chrono entre deux actions est placé juste avant la seconde', () => {
    const q3 = tp.filter((p) => p.period === 3);
    const after = q3.find((p) => p.clock_sec < 225)!;
    expect(resolveAnchorWall({ period: 3, clock_sec: 225, wallclock: null }, tp)).toBe(after.wall - (225 - after.clock_sec));
  });

  it('les scores lus désambiguïsent une période illisible', () => {
    const t = 3000;
    const s = perfectRead(t, false)!;
    const obs: FrameObservation[] = [{ video_ts: t, period: null, clock_sec: s.clock_sec, scores: s.scores }];
    const withScores = selectConsistentObservations(obs, tp, breaks, { scores });
    expect(withScores[0].period).toBe(s.period);
    expect(scoresMatchAt(s.scores, scores, s.period, s.clock_sec)).toBe(true);
    expect(scoresMatchAt([1, 2], scores, s.period, s.clock_sec)).toBe(false);
  });

  it('écarte une lecture incohérente avec les autres', () => {
    const good = [900, 2500, 4200, 6000].map((t) => ({ video_ts: t, ...perfectRead(t, false)! }));
    const bad = { video_ts: 3000, period: 1, clock_sec: 700, scores: [] };
    const anchors = selectConsistentObservations([...good, bad], tp, breaks, { scores });
    expect(anchors.some((a) => a.video === 3000)).toBe(false);
  });
});

describe('parseScoreboardText — format « Q2 »', () => {
  it('lit "Q2 7:43"', () => {
    expect(parseScoreboardText('POR 54 LAL 61 Q2 7:43')).toEqual({ period: 2, clock_sec: 463 });
  });

  it('ne prend pas un "Q" collé à du bruit pour une période', () => {
    expect(parseScoreboardText('XQ27 7:43')?.period).toBeNull();
  });
});
