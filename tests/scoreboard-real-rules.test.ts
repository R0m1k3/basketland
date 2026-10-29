/**
 * Règles tirées des VRAIES images de diffusion (voir real-frames.test.ts) :
 * lectures déformées du chrono et de la période, zones fixes, empreinte du bandeau.
 * Tests purs (sans ffmpeg ni tesseract).
 */
import { describe, it, expect } from 'vitest';
import {
  clockFromSlotText,
  colonlessClock,
  gluedClock,
  loosePeriod,
  panelPresence,
  panelSignature,
  periodFromSlot,
  staticBrightCells,
  staticOverlayRegions,
  THUMB_H,
  THUMB_W,
} from '../src/lib/scoreboard';
import { parseScoreboardText, type OcrWord } from '../src/lib/ocr';

const word = (text: string, h: number): OcrWord => ({ text, x0: 0, y0: 0, x1: 30, y1: h, confidence: 80 });

describe('chrono : lectures déformées', () => {
  it('dixièmes précédés d’un deux-points (« :29.7 », chaîne locale)', () => {
    expect(parseScoreboardText('2ND :29.7 24')).toEqual({ period: 2, clock_sec: 30 });
  });

  it('suite collée : « 114:562 » = « 1ST 4:56 24 », « 011:4814 » = 11:48', () => {
    expect(gluedClock('114:562')).toBe(296);
    expect(gluedClock('011:4814')).toBe(708);
    expect(gluedClock('9:75')).toBeNull();
  });

  it('sans deux-points, seulement si la valeur est un chrono valide', () => {
    expect(colonlessClock('857')).toBe(537);
    expect(colonlessClock('8.57')).toBe(537);
    expect(colonlessClock('1006')).toBe(606);
    expect(colonlessClock('1306')).toBeNull();
    expect(colonlessClock('57')).toBeNull();
  });

  it('dans la case du chrono : « 129.7 » (deux-points lu « 1 ») = 30 s', () => {
    expect(clockFromSlotText('129.7')).toBe(30);
    expect(clockFromSlotText('6:57')).toBe(417);
    expect(clockFromSlotText('B:57')).toBeNull();
  });
});

describe('période : exposants et suffixes', () => {
  it('« 1ˢᵀ » de Prime Video lu « 187 », « 1T », « 1sT »', () => {
    expect(loosePeriod('187')).toBe(1);
    expect(loosePeriod('1T')).toBe(1);
    expect(loosePeriod('1sT')).toBe(1);
    expect(loosePeriod('3R0')).toBe(3);
    expect(loosePeriod('2N0')).toBe(2);
  });

  it('suffixe seul (« ND », « OND ») : seulement sur demande', () => {
    expect(loosePeriod('OND')).toBe(2);
    expect(loosePeriod('ND')).toBe(2);
    expect(loosePeriod('TH', { bareSuffix: false })).toBeNull();
    expect(loosePeriod('3ND')).toBeNull(); // chiffre et suffixe contradictoires
  });

  it('ne prend pas le shot clock ni un score pour une période', () => {
    expect(loosePeriod('10')).toBeNull();
    expect(loosePeriod('24')).toBeNull();
  });

  it('case dédiée : forme tronquée admise si le texte n’est pas plus gros que le chrono', () => {
    expect(periodFromSlot([word('20', 20)], 17)).toBe(2);
    expect(periodFromSlot([word('4', 20)], 17)).toBe(4);
    expect(periodFromSlot([word('4', 30)], 17)).toBeNull(); // un score, écrit plus gros
    expect(periodFromSlot([word('20', 20)], 17, false)).toBeNull(); // zone de gauche : pas de forme tronquée
  });

  it('zone de gauche : exposant ESPN « 2m » / « 4 » s’il est nettement plus petit que le chrono', () => {
    expect(periodFromSlot([word('2m', 17)], 25, false)).toBe(2);
    expect(periodFromSlot([word('4', 17)], 25, false)).toBe(4);
    expect(periodFromSlot([word('4', 24)], 25, false)).toBeNull();
    expect(periodFromSlot([word('2', 3)], 25)).toBeNull(); // fragment parasite
  });
});

// ------------------------------------------------------------------ vignettes synthétiques

/** Vignette : fond aléatoire (différent à chaque image) + incrustations fixes. */
function thumb(seed: number, overlays: { x: number; y: number; w: number; h: number; v: number; digits?: boolean }[]): Buffer {
  const b = Buffer.alloc(THUMB_W * THUMB_H);
  // Fond en blocs de 16 px (une scène, pas un bruit blanc), différent à chaque image.
  let s = seed * 7919 + 17;
  const blocks: number[] = [];
  for (let i = 0; i < (THUMB_W / 16) * Math.ceil(THUMB_H / 16); i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    blocks.push(40 + ((s >>> 16) % 180));
  }
  for (let y = 0; y < THUMB_H; y++)
    for (let x = 0; x < THUMB_W; x++) b[y * THUMB_W + x] = blocks[Math.floor(y / 16) * (THUMB_W / 16) + Math.floor(x / 16)];
  for (const o of overlays)
    for (let y = o.y; y < o.y + o.h; y++)
      for (let x = o.x; x < o.x + o.w; x++) {
        // Contour sombre (cadre) et, si demandé, « chiffres » qui changent d'une image à l'autre.
        const border = y === o.y || y === o.y + o.h - 1 || x === o.x || x === o.x + o.w - 1;
        const digit = o.digits && y > o.y + 2 && y < o.y + o.h - 3 && (x + seed) % 5 === 0;
        b[y * THUMB_W + x] = border ? 10 : digit ? 30 : o.v;
      }
  return b;
}

describe('zones fixes et empreinte', () => {
  const bug = [
    { x: 100, y: 150, w: 120, h: 14, v: 30 }, // bandeau sombre
    { x: 150, y: 152, w: 24, h: 10, v: 235, digits: true }, // case blanche du chrono
  ];
  const withBug = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => thumb(i, bug));
  const noBug = thumb(99, []);

  it('trouve le bandeau, fixe d’une image à l’autre', () => {
    const z = staticOverlayRegions([...withBug, noBug]);
    expect(z.length).toBeGreaterThan(0);
    const r = z[0].rect;
    expect(r.x * THUMB_W).toBeLessThanOrEqual(104);
    expect((r.x + r.w) * THUMB_W).toBeGreaterThanOrEqual(216);
    expect(r.y * THUMB_H).toBeGreaterThan(140);
  });

  it('trouve la case claire du chrono dans le bandeau', () => {
    const z = staticOverlayRegions(withBug)[0].rect;
    const cells = staticBrightCells(withBug, z);
    expect(cells.length).toBeGreaterThan(0);
    const c = cells[0];
    expect(Math.abs(c.x * THUMB_W - 150)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.w * THUMB_W - 24)).toBeLessThanOrEqual(3);
  });

  it('empreinte : présence forte avec le bandeau, faible sans', () => {
    const sig = panelSignature(withBug, { x: 100 / THUMB_W, y: 150 / THUMB_H, w: 120 / THUMB_W, h: 14 / THUMB_H })!;
    expect(sig).not.toBeNull();
    expect(panelPresence(thumb(42, bug), sig)).toBeGreaterThan(0.8);
    expect(panelPresence(noBug, sig)).toBeLessThan(0.4);
  });
});
