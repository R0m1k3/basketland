import { describe, expect, it } from 'vitest';
import { computeLinescore, periodName, periodShortLabel } from '../src/lib/linescore';

const p = (period: number, away: number | null, home: number | null) => ({ period, away_score: away, home_score: home });

describe('computeLinescore', () => {
  it('calcule les points par quart depuis le score cumulé', () => {
    const ls = computeLinescore([
      p(1, 0, 0),
      p(1, 12, 10),
      p(1, 28, 25),
      p(2, 30, 25),
      p(2, 55, 50),
      p(3, 80, 77),
      p(4, 103, 87),
    ]);
    expect(ls).not.toBeNull();
    expect(ls!.periods.map((x) => [x.away, x.home])).toEqual([
      [28, 25],
      [27, 25],
      [25, 27],
      [23, 10],
    ]);
    expect(ls!.away).toBe(103);
    expect(ls!.home).toBe(87);
  });

  it('gère les prolongations et ignore les scores nuls', () => {
    const ls = computeLinescore([p(1, 20, 20), p(2, 50, 50), p(3, null, null), p(3, 75, 75), p(4, 100, 100), p(5, 112, 110)]);
    expect(ls!.periods.map((x) => x.label)).toEqual(['1', '2', '3', '4', 'P1']);
    expect(ls!.periods[4]).toMatchObject({ away: 12, home: 10 });
  });

  it("s'arrête à la dernière période jouée pour un match en cours", () => {
    const ls = computeLinescore([p(1, 20, 18), p(2, 40, 41)]);
    expect(ls!.periods).toHaveLength(2);
  });

  it('renvoie null sans score', () => {
    expect(computeLinescore([])).toBeNull();
    expect(computeLinescore([p(1, null, null)])).toBeNull();
  });

  it('libellés de période', () => {
    expect(periodShortLabel(3)).toBe('3');
    expect(periodShortLabel(6)).toBe('P2');
    expect(periodName(4)).toBe('Q4');
    expect(periodName(5)).toBe('Prol.');
    expect(periodName(6)).toBe('Prol. 2');
  });
});
