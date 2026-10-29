import { describe, it, expect } from 'vitest';
import { parseScoreboardText } from '../src/lib/ocr';

/**
 * Textes RÉELLEMENT produits par tesseract.js sur le bandeau NBC du replay
 * ok.ru (crop resserré sur le bloc chrono, upscaling ×6, seuil 185).
 * Ils servent de référence au parseur.
 */
const REAL_TEXTS = [
  { text: 'N 1:24 6 1 2ND24 TN 157 SR', period: 2, clock: 84, note: 't=3600s' },
  { text: '1:24 2ND24 1STT 11', period: 2, clock: 84, note: 't=3600s, crop serré' },
  { text: '3:49 4TH 24 12 HTTRST1TRTS', period: 4, clock: 229, note: 't=7000s' },
  { text: '3:49 4TH 24 .', period: 4, clock: 229, note: 't=7000s, crop serré' },
  { text: ':. . 3:45 3RO 17 1 1TTT', period: 3, clock: 225, note: 't=5400s, "3RD" lu "3RO"' },
];

describe('parseScoreboardText — sur les vrais textes OCR du bandeau NBC', () => {
  for (const t of REAL_TEXTS) {
    it(`lit ${JSON.stringify(t.text.slice(0, 30))} (${t.note})`, () => {
      const r = parseScoreboardText(t.text);
      expect(r).not.toBeNull();
      expect(r!.clock_sec).toBe(t.clock);
      expect(r!.period).toBe(t.period);
    });
  }

  it('lit le chrono mais laisse la période nulle quand elle est illisible', () => {
    // t=5400s : le "3RD" a été lu "3 RO" (séparé) → période non déterminable.
    // L'application la déduira ensuite par hypothèse (selectConsistentObservations).
    const r = parseScoreboardText('. 3:45 0 RO 17 OT7THH');
    expect(r).not.toBeNull();
    expect(r!.clock_sec).toBe(225);
    expect(r!.period).toBeNull();
  });

  it('ne prend PAS "OT7THH" pour une prolongation', () => {
    // "OT7THH" est du bruit de lecture : sans frontière de mot, l'accepter
    // attribuerait une 5e période à un match normal.
    const r = parseScoreboardText('. 3:45 0 RO 17 OT7THH');
    expect(r!.period).not.toBe(5);
  });

  it('lit le chrono seul quand la période est illisible', () => {
    const r = parseScoreboardText('. 1 11:02 0 187 20 HTN');
    expect(r).not.toBeNull();
    expect(r!.clock_sec).toBe(662);
    expect(r!.period).toBeNull();
  });
});

describe('parseScoreboardText — formats classiques', () => {
  it('lit "8:41 1ST"', () => {
    const r = parseScoreboardText('8:41 1ST');
    expect(r!.clock_sec).toBe(521);
    expect(r!.period).toBe(1);
  });

  it('lit "1ST 8:41" (période avant)', () => {
    const r = parseScoreboardText('1ST 8:41');
    expect(r!.clock_sec).toBe(521);
    expect(r!.period).toBe(1);
  });

  it('lit les dixièmes de la dernière minute "42.8 4TH"', () => {
    const r = parseScoreboardText('42.8 4TH');
    expect(r!.clock_sec).toBe(43);
    expect(r!.period).toBe(4);
  });

  it('lit une prolongation "OT" isolée', () => {
    const r = parseScoreboardText('1:12 OT');
    expect(r!.clock_sec).toBe(72);
    expect(r!.period).toBe(5);
  });

  it('rejette un bilan "2-0"', () => {
    expect(parseScoreboardText('POR 2-0 LAL')).toBeNull();
  });

  it('rejette un texte sans chrono', () => {
    expect(parseScoreboardText('NBA ON NBC')).toBeNull();
  });

  it('rejette un chrono hors limites (13 minutes)', () => {
    expect(parseScoreboardText('13:05 1ST')).toBeNull();
  });
});
