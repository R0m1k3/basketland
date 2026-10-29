import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSummary } from '../src/lib/espn';
import { toTimedPlays, findBreaks } from '../src/lib/sync';
import { parseScoreboardText, selectConsistentObservations } from '../src/lib/ocr';

const summary = parseSummary(
  JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'espn-summary-401909880.json'), 'utf8'),
  ) as Record<string, unknown>,
  401909880,
);
const tp = toTimedPlays(summary.plays);
const breaks = findBreaks(tp);

/**
 * Observations réellement lues par tesseract.js sur le replay ok.ru
 * (bandeau NBC, crop resserré) : video_ts, période (null si illisible), chrono.
 *
 * Vérité terrain relevée sur les images :
 *   t=3600s -> 2e période, 1:24   (identique au chrono ESPN)
 *   t=7000s -> 4e période, 3:49
 */
const REAL_OBSERVATIONS = [
  { video_ts: 600, period: null as number | null, clock_sec: 662 },
  { video_ts: 3600, period: 2 as number | null, clock_sec: 84 },
  { video_ts: 5400, period: null as number | null, clock_sec: 225 },
  { video_ts: 7000, period: 4 as number | null, clock_sec: 229 },
];

describe('chaîne OCR → ancres de synchronisation', () => {
  it('convertit les lectures OCR en observations exploitables', () => {
    // Le parseur seul ne connaît pas la position vidéo : c'est le scan qui
    // la fournit. On vérifie ici la cohérence period/clock entre l'OCR et l'ESPN.
    const r = parseScoreboardText('N 1:24 6 1 2ND24 TN 157 SR');
    expect(r).not.toBeNull();
    expect(r!.period).toBe(2);
    expect(r!.clock_sec).toBe(84);
  });

  it('sélectionne une chaîne cohérente d\'ancres', () => {
    const anchors = selectConsistentObservations(REAL_OBSERVATIONS, tp, breaks);
    expect(anchors.length).toBeGreaterThan(0);
    // Les ancres retenues doivent être croissantes en temps vidéo ET en temps de jeu.
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].video).toBeGreaterThan(anchors[i - 1].video);
      expect(anchors[i].wall).toBeGreaterThan(anchors[i - 1].wall);
    }
  });

  it('privilégie les observations dont la période est lue', () => {
    const anchors = selectConsistentObservations(REAL_OBSERVATIONS, tp, breaks);
    // Les deux observations avec période lue (t=3600 → Q2, t=7000 → Q4)
    // doivent figurer dans la chaîne retenue.
    const periods = anchors.map((a) => a.period);
    expect(periods).toContain(2);
    expect(periods).toContain(4);
  });

  it('reconduit la même horloge de jeu que l\'ESPN', () => {
    // L'observation la plus précise (t=3600, 2e période, 1:24) doit se
    // recaler sur le même instant de jeu que l'action ESPN correspondante.
    const anchors = selectConsistentObservations(REAL_OBSERVATIONS, tp, breaks);
    const a = anchors.find((x) => x.video === 3600);
    expect(a).toBeDefined();
    expect(a!.period).toBe(2);
    expect(a!.clock_sec).toBe(84);
    // Son wallclock doit correspondre à celui d'une action ESPN de la 2e
    // période affichant 1:24.
    const espn = summary.plays.find(
      (p) => p.period === 2 && p.clock_sec === 84,
    );
    expect(espn).toBeDefined();
    expect(Math.abs(a!.wall - Date.parse(espn!.wallclock) / 1000)).toBeLessThan(60);
  });

  it('produit des ancres stables (déterminisme)', () => {
    const a1 = selectConsistentObservations(REAL_OBSERVATIONS, tp, breaks);
    const a2 = selectConsistentObservations(REAL_OBSERVATIONS, tp, breaks);
    expect(a1.map((x) => x.video)).toEqual(a2.map((x) => x.video));
    expect(a1.map((x) => x.wall)).toEqual(a2.map((x) => x.wall));
  });

  it('détecte les temps morts dans le play-by-play réel', () => {
    // Un match NBA réel contient des temps morts : ils doivent ressortir.
    expect(breaks.length).toBeGreaterThan(0);
  });
});
