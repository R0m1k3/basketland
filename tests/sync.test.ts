import { describe, it, expect } from 'vitest';
import {
  periodLength,
  gameElapsed,
  toTimedPlays,
  findBreaks,
  Timeline,
  buildMapping,
  estimateStart,
  applyOffsets,
  type TimedPlay,
} from '../src/lib/sync';

const T0 = Date.parse('2026-10-28T03:12:54Z');

/** Construit une suite d'actions à intervalle régulier. */
function makePlays(count: number, gapSec: number, startSeq = 0): TimedPlay[] {
  const out: TimedPlay[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      seq: startSeq + i,
      period: 1,
      clock_sec: 720 - i * 2,
      wall: T0 / 1000 + i * gapSec,
    });
  }
  return out;
}

describe('periodLength', () => {
  it('dure 12 minutes par quart et 5 en prolongation', () => {
    expect(periodLength(1)).toBe(720);
    expect(periodLength(4)).toBe(720);
    expect(periodLength(5)).toBe(300);
  });
});

describe('gameElapsed', () => {
  it('convertit un chrono en secondes écoulées', () => {
    expect(gameElapsed(1, 720)).toBe(0);
    expect(gameElapsed(1, 0)).toBe(720);
    expect(gameElapsed(2, 720)).toBe(720);
    expect(gameElapsed(2, 0)).toBe(1440);
  });
});

describe('toTimedPlays', () => {
  it('convertit les wallclock ISO en epoch et trie par seq', () => {
    const plays = toTimedPlays([
      { seq: 1, period: 1, clock_sec: 700, wallclock: '2026-10-28T03:12:56Z' },
      { seq: 0, period: 1, clock_sec: 720, wallclock: '2026-10-28T03:12:54Z' },
    ]);
    expect(plays).toHaveLength(2);
    expect(plays[0].seq).toBe(0);
    expect(plays[0].wall).toBe(T0 / 1000);
  });

  it('ignore les wallclock invalides', () => {
    expect(toTimedPlays([{ seq: 0, period: 1, clock_sec: 720, wallclock: 'nope' }])).toHaveLength(0);
  });
});

describe('findBreaks', () => {
  it('détecte un temps mort (grand écart wallclock sans temps de jeu)', () => {
    // 10 actions espacées de 2 s, puis un saut de 300 s.
    const tp: TimedPlay[] = [];
    for (let i = 0; i < 10; i++) {
      tp.push({ seq: i, period: 1, clock_sec: 720 - i * 2, wall: T0 / 1000 + i * 2 });
    }
    tp.push({ seq: 10, period: 1, clock_sec: 700, wall: T0 / 1000 + 20 + 300 });
    const breaks = findBreaks(tp);
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    expect(breaks[0].interval.end - breaks[0].interval.start).toBeGreaterThan(200);
  });

  it('ne détecte rien sur un match continu', () => {
    // Actions régulières : le temps de jeu suit le wallclock.
    const tp: TimedPlay[] = [];
    for (let i = 0; i < 50; i++) {
      tp.push({ seq: i, period: 1, clock_sec: 720 - i * 12, wall: T0 / 1000 + i * 12 });
    }
    expect(findBreaks(tp)).toHaveLength(0);
  });
});

describe('Timeline', () => {
  it('calcule le temps vivant et compressible', () => {
    const tl = new Timeline([{ start: 100, end: 200 }]);
    expect(tl.live(0, 300)).toBe(200);
    expect(tl.comp(0, 300)).toBe(100);
  });
});

describe('estimateStart', () => {
  it('estime v0 et rho à partir de la durée vidéo', () => {
    const tp = makePlays(100, 10);
    const tl = new Timeline([]);
    // Match de 1000 s de jeu, vidéo de 1400 s : v0 + rho*0 = 1400 - post - 1000
    const { v0, rho } = estimateStart(tp, tl, { videoDuration: 1400, postroll: 0, maxPreroll: 900 });
    expect(v0).toBeGreaterThanOrEqual(0);
    expect(v0).toBeLessThanOrEqual(900);
    expect(rho).toBeGreaterThanOrEqual(0);
    expect(rho).toBeLessThanOrEqual(1);
  });

  it('renvoie des valeurs par défaut sans données', () => {
    const { v0, rho } = estimateStart([], new Timeline([]), {});
    expect(v0).toBe(0);
    expect(rho).toBeGreaterThanOrEqual(0);
  });
});

describe('buildMapping', () => {
  it('produit une ancre cohérente sans ancre fournie', () => {
    const tp = makePlays(50, 10);
    const mapping = buildMapping(tp, [], [], { videoDuration: 1400 });
    expect(mapping.anchors.length).toBeGreaterThan(0);
    expect(typeof mapping.map).toBe('function');
  });

  it('respecte une ancre manuelle', () => {
    const tp = makePlays(50, 10);
    const wall = tp[10].wall;
    const mapping = buildMapping(
      tp,
      [],
      [{ wall, video: 1234, method: 'manual', period: 1, clock_sec: 700 }],
      { videoDuration: 1400 },
    );
    expect(mapping.map(wall)).toBeCloseTo(1234, 3);
  });

  it('interpole entre deux ancres', () => {
    const tp = makePlays(50, 10);
    const w0 = tp[0].wall;
    const w1 = tp[20].wall;
    const mapping = buildMapping(
      tp,
      [],
      [
        { wall: w0, video: 0, method: 'manual', period: 1, clock_sec: 720 },
        { wall: w1, video: 200, method: 'manual', period: 1, clock_sec: 480 },
      ],
      { videoDuration: 1400 },
    );
    const mid = (w0 + w1) / 2;
    expect(mapping.map(mid)).toBeCloseTo(100, 0);
  });
});

describe('applyOffsets', () => {
  it('applique le décalage global et le décalage de quart', () => {
    expect(applyOffsets(100, 1, { global_offset: 5, quarter_offsets: {} })).toBe(105);
    expect(applyOffsets(100, 2, { global_offset: 0, quarter_offsets: { '2': -10 } })).toBe(90);
    expect(
      applyOffsets(100, 2, { global_offset: 5, quarter_offsets: { '2': -10 } }),
    ).toBe(95);
  });
});
