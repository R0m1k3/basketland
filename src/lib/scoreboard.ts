/**
 * Localisation ADAPTATIVE du bandeau de score.
 *
 * Les replays viennent de diffuseurs différents (ESPN/ABC, NBC, TNT, Prime
 * Video, chaînes locales) : le bandeau est en bas au centre, en bas à gauche,
 * en haut à droite… et sa taille varie. Une zone de recadrage fixe (ancienne
 * approche, calée sur NBC) ne lisait rien sur les autres diffuseurs, d'où des
 * synchros « estimées » fausses de plusieurs minutes.
 *
 * Méthode :
 *  1. sur quelques images échantillons, on lit des BANDES candidates (bas puis
 *     haut de l'image), découpées en tuiles qui se recouvrent, agrandies et
 *     binarisées de plusieurs façons ;
 *  2. avec les boîtes de mots de tesseract, on repère les jetons « chrono »
 *     (m:ss ou ss.d) proches d'un jeton « période » (1ST…4TH, OT, Q1…) ;
 *  3. on vote : la région qui revient sur le plus d'images est le bandeau.
 *
 * Le balayage complet ne recadre ensuite que cette région (rapide et fiable).
 * Sans région trouvée, on lit les bandes en pleine largeur plutôt que d'abandonner.
 *
 * Toutes les coordonnées publiques sont en FRACTIONS de l'image (0..1), ce qui
 * rend le résultat indépendant de la définition (480p, 720p, 1080p).
 */
import {
  filterImage,
  normalizeOcrText,
  parseClockCandidates,
  parsePeriodText,
  parseScoreboardText,
  pngSize,
  recognizeWords,
  type OcrWord,
  type OcrWorker,
} from './ocr';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ------------------------------------------------------------------ jetons

/** « Q2 » collé au chrono ("Q27:43") : fréquent quand l'espace est étroit. */
const Q_GLUED_RE = /Q([1-4])(?=\d{1,2}[:.]\d)/;
/** Jetons de période à retirer avant de chercher chrono et scores dans un mot. */
const PERIOD_TOKENS_RE = /Q[1-4](?=\d{1,2}[:.]\d)|\bQ[1-4]\b|1ST|2ND|3RD|4TH|1S7|2NO|2N0|3RO|3R0|4T4|\bOT\d?\b/g;

/** Valeur d'un jeton de période isolé ("2ND", "Q3", "3RO", "OT2"…). */
function periodValue(tok: string): number | null {
  if (tok.startsWith('OT')) return 4 + (Number(tok.slice(2)) || 1);
  if (tok.startsWith('Q')) return Number(tok[1]);
  const n = Number(tok[0]);
  return n >= 1 && n <= 4 ? n : null;
}

export interface WordTokens {
  period: number | null;
  clock: number | null;
  /** Nombres de 1 à 3 chiffres (≤ 199) hors chrono et période : scores, shot clock. */
  numbers: number[];
}

/**
 * Décompose un mot OCR. Avec l'alphabet restreint, tesseract colle souvent les
 * éléments voisins : "H54ND61Q27:43" = (P)H(I) 54, (I)ND 61, Q2, 7:43. On lit
 * donc la période, puis le chrono et les nombres dans ce qui reste.
 */
export function analyzeWord(text: string): WordTokens {
  const t = normalizeOcrText(text).trim();
  let period = parsePeriodText(t);
  if (period === null) {
    const q = Q_GLUED_RE.exec(t);
    if (q) period = Number(q[1]);
  }
  // Mot collé contenant le chrono : la période est le jeton le plus PROCHE du
  // chrono. Sinon "H12ND9Q19:12" (PHI 12, IND 9, Q1 9:12) donnerait la
  // 2e période à cause du « 2ND » formé par le score et « IND ».
  const clockAt = /\d{1,2}[:.]\d/.exec(t);
  if (clockAt) {
    let bestD = Infinity;
    for (const m of t.matchAll(PERIOD_TOKENS_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const d = end <= clockAt.index ? clockAt.index - end : Math.max(0, start - (clockAt.index + clockAt[0].length));
      const p = periodValue(m[0]);
      if (p !== null && d < bestD) {
        bestD = d;
        period = p;
      }
    }
  }
  const rest = t.replace(PERIOD_TOKENS_RE, ' ');
  let clock: number | null = parseClockCandidates(rest)[0] ?? null;
  let clockRe = /\d{1,2}:\d{2}|\d{1,2}\.\d/g;
  if (clock === null) {
    // Minute à un chiffre précédée d'un chiffre parasite ("27:43" → 7:43).
    const m = /(\d):([0-5]\d)(?!\d)/.exec(rest);
    if (m) {
      clock = Number(m[1]) * 60 + Number(m[2]);
      clockRe = /\d:\d{2}/g;
    }
  }
  const numbers: number[] = [];
  for (const m of rest.replace(clock === null ? /$^/ : clockRe, ' ').matchAll(/(?<!\d)\d{1,6}(?!\d)/g)) {
    const run = m[0];
    if (run.length <= 3) {
      if (Number(run) <= 199) numbers.push(Number(run));
      continue;
    }
    // Deux scores collés ("5461" = 54 et 61) : on garde toutes les coupures
    // plausibles, la confrontation au play-by-play fera le tri.
    for (let i = 1; i < run.length; i++) {
      const a = run.slice(0, i);
      const b = run.slice(i);
      if (a.length > 3 || b.length > 3 || (b.length > 1 && b[0] === '0') || (a.length > 1 && a[0] === '0')) continue;
      if (Number(a) <= 199 && Number(b) <= 199) numbers.push(Number(a), Number(b));
    }
  }
  return { period, clock, numbers };
}

/** Chrono (secondes) porté par un mot OCR, ou null. */
export function clockFromWord(text: string): number | null {
  return analyzeWord(text).clock;
}

/** Période portée par un mot OCR (1ST, 2ND24, Q3, OT…), ou null. */
export function periodFromWord(text: string): number | null {
  return analyzeWord(text).period;
}

const height = (b: Box) => Math.max(1, b.y1 - b.y0);
const cy = (b: Box) => (b.y0 + b.y1) / 2;
const hGap = (a: Box, b: Box) => Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/**
 * Recolle les chronos coupés en deux mots par tesseract ("7:" + "43",
 * "7" + ":43") quand les deux morceaux sont sur la même ligne et quasi contigus.
 */
export function mergeSplitClocks(words: OcrWord[]): OcrWord[] {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  const used = new Set<number>();
  const out: OcrWord[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const a = sorted[i];
    let merged: OcrWord | null = null;
    if (clockFromWord(a.text) === null) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(j)) continue;
        const b = sorted[j];
        const h = Math.max(height(a), height(b));
        if (Math.abs(cy(a) - cy(b)) > 0.5 * h || hGap(a, b) > 0.6 * h) continue;
        const text = a.text + b.text;
        if (clockFromWord(b.text) === null && clockFromWord(text) !== null) {
          merged = { ...union(a, b), text, confidence: Math.min(a.confidence, b.confidence) };
          used.add(j);
          break;
        }
      }
    }
    out.push(merged ?? a);
  }
  return out;
}

// ------------------------------------------------------------------ candidats chrono + période

export interface ClockCandidate {
  /** Index de l'image échantillon. */
  frame: number;
  period: number | null;
  clock_sec: number;
  /** Boîte chrono ∪ période, en fractions de l'image. */
  rect: Rect;
  /** Hauteur du texte du chrono, en fraction de la hauteur d'image. */
  textH: number;
  /** Nombres lus près du chrono (scores, shot clock), avec leurs boîtes. */
  scores: number[];
  scoreRects: Rect[];
  /** Période trouvée à côté du chrono (lecture fiable). */
  strong: boolean;
}

const toRect = (b: Box, W: number, H: number): Rect => ({ x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H });

/**
 * Repère, parmi les mots OCR d'une image (coordonnées en pixels de l'image
 * source W×H), les chronos et la période voisine.
 *
 * Voisinage (en hauteurs de texte h du chrono) : même ligne avec un écart
 * horizontal ≤ 6h, ou empilés (écart horizontal ≤ 2h, vertical ≤ 2,5h) —
 * certains bandeaux de chaînes locales mettent la période au-dessus du chrono.
 */
export function findClockCandidates(wordsIn: OcrWord[], W: number, H: number, frame = 0): ClockCandidate[] {
  const words = mergeSplitClocks(wordsIn);
  const tok = words.map((w) => analyzeWord(w.text));
  const out: ClockCandidate[] = [];
  words.forEach((c, ci) => {
    const clock = tok[ci].clock;
    if (clock === null) return;
    const h = height(c);
    let period = tok[ci].period;
    let box: Box = c;
    let pi = -1;
    if (period === null) {
      let best = Infinity;
      words.forEach((w, wi) => {
        if (wi === ci) return;
        const p = tok[wi].period;
        if (p === null || tok[wi].clock !== null) return;
        const hw = height(w);
        if (hw < 0.4 * h || hw > 2.5 * h) return;
        const dy = Math.abs(cy(w) - cy(c));
        const gap = hGap(w, c);
        const sameLine = dy <= 1.2 * h && gap <= 6 * h;
        const stacked = gap <= 2 * h && dy <= 2.5 * h;
        if (!sameLine && !stacked) return;
        const d = gap + dy;
        if (d < best) {
          best = d;
          period = p;
          pi = wi;
        }
      });
      if (pi >= 0) box = union(c, words[pi]);
    }
    if (period !== null && period > 4 && clock > 300) return;
    // Nombres : ceux du mot du chrono (éléments collés), du mot de la période,
    // puis des mots voisins de taille comparable.
    const scores: number[] = [...tok[ci].numbers, ...(pi >= 0 ? tok[pi].numbers : [])];
    const scoreRects: Rect[] = [];
    words.forEach((w, wi) => {
      if (wi === ci || wi === pi || tok[wi].clock !== null || !tok[wi].numbers.length) return;
      const hw = height(w);
      if (hw < 0.6 * h || hw > 2.2 * h) return;
      if (Math.abs(cy(w) - cy(c)) > 3 * h || hGap(w, box) > 14 * h) return;
      scores.push(...tok[wi].numbers);
      scoreRects.push(toRect(w, W, H));
    });
    out.push({ frame, period, clock_sec: clock, rect: toRect(box, W, H), textH: h / H, scores, scoreRects, strong: period !== null });
  });
  return out;
}

// ------------------------------------------------------------------ vote

export interface ScoreboardLocation {
  /** Région à recadrer pour lire le bandeau (chrono, période et scores proches). */
  rect: Rect;
  /** Bloc chrono + période seul. */
  core: Rect;
  /** Hauteur du texte du chrono (fraction de la hauteur d'image). */
  textH: number;
  /** Nombre d'images échantillons où le bandeau a été lu à cet endroit. */
  frames: number;
  strongFrames: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface VoteOptions {
  /** Nombre d'images effectivement analysées (règle d'acceptation). */
  sampledFrames?: number;
  /** Tolérance de regroupement des centres (fractions de l'image). */
  tolX?: number;
  tolY?: number;
}

/**
 * Vote sur la région la plus récurrente.
 *
 * Regroupement glouton des centres (chrono ∪ période) ; valeur d'un groupe =
 * images où la période a été lue + 0,35 × images où seul le chrono l'a été.
 * Acceptation : au moins 2 images fiables, ou 1 fiable + 1 autre, ou une seule
 * image fiable quand une seule image a été analysée. Un chrono isolé qui ne se
 * répète pas (horloge d'une publicité, score d'un autre match) est ainsi écarté.
 */
export function voteScoreboardRegion(cands: ClockCandidate[], o: VoteOptions = {}): (ScoreboardLocation & { members: ClockCandidate[] }) | null {
  const tolX = o.tolX ?? 0.05;
  const tolY = o.tolY ?? 0.04;
  const clusters: { cx: number; cy: number; members: ClockCandidate[] }[] = [];
  for (const c of [...cands].sort((a, b) => Number(b.strong) - Number(a.strong))) {
    const p = center(c.rect);
    const cl = clusters.find((k) => Math.abs(k.cx - p.x) <= tolX && Math.abs(k.cy - p.y) <= tolY);
    if (cl) {
      cl.members.push(c);
      cl.cx = median(cl.members.map((m) => center(m.rect).x));
      cl.cy = median(cl.members.map((m) => center(m.rect).y));
    } else clusters.push({ cx: p.x, cy: p.y, members: [c] });
  }
  let best: { value: number; strongFrames: number; frames: number; members: ClockCandidate[] } | null = null;
  for (const k of clusters) {
    const strongF = new Set(k.members.filter((m) => m.strong).map((m) => m.frame));
    const allF = new Set(k.members.map((m) => m.frame));
    const value = strongF.size + 0.35 * (allF.size - strongF.size);
    if (!best || value > best.value) best = { value, strongFrames: strongF.size, frames: allF.size, members: k.members };
  }
  if (!best) return null;
  const sampled = o.sampledFrames ?? Infinity;
  const accepted = best.strongFrames >= 2 || (best.strongFrames >= 1 && best.frames >= 2) || (sampled <= 1 && best.strongFrames >= 1);
  if (!accepted) return null;

  // Un seul représentant par image (le plus fiable) pour les médianes.
  const perFrame = new Map<number, ClockCandidate>();
  for (const m of best.members) {
    const cur = perFrame.get(m.frame);
    if (!cur || (m.strong && !cur.strong)) perFrame.set(m.frame, m);
  }
  const reps = [...perFrame.values()];
  const core: Rect = (() => {
    const x0 = median(reps.map((r) => r.rect.x));
    const y0 = median(reps.map((r) => r.rect.y));
    const x1 = median(reps.map((r) => r.rect.x + r.rect.w));
    const y1 = median(reps.map((r) => r.rect.y + r.rect.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();
  const textH = median(reps.map((r) => r.textH));

  // Scores : on n'élargit la région que vers des nombres qui reviennent à la
  // même place sur au moins 40 % des images (les scores changent, leur place non).
  let x0 = core.x;
  let y0 = core.y;
  let x1 = core.x + core.w;
  let y1 = core.y + core.h;
  const scoreSpots: { cx: number; cy: number; rects: Rect[]; frames: Set<number> }[] = [];
  for (const r of reps) {
    r.scoreRects.forEach((sr) => {
      const p = center(sr);
      const spot = scoreSpots.find((s) => Math.abs(s.cx - p.x) <= 0.03 && Math.abs(s.cy - p.y) <= 0.03);
      if (spot) {
        spot.rects.push(sr);
        spot.frames.add(r.frame);
      } else scoreSpots.push({ cx: p.x, cy: p.y, rects: [sr], frames: new Set([r.frame]) });
    });
  }
  const minSpot = Math.max(2, Math.ceil(reps.length * 0.4));
  for (const s of scoreSpots) {
    if (s.frames.size < minSpot && !(reps.length === 1 && s.frames.size === 1)) continue;
    x0 = Math.min(x0, median(s.rects.map((r) => r.x)));
    y0 = Math.min(y0, median(s.rects.map((r) => r.y)));
    x1 = Math.max(x1, median(s.rects.map((r) => r.x + r.w)));
    y1 = Math.max(y1, median(s.rects.map((r) => r.y + r.h)));
  }
  // Marge : un chrono « 10:00 » est plus large que « 7:43 », la période peut
  // passer de « Q2 » à « 2ND » selon l'habillage.
  const padX = Math.max(textH * 1.6, core.w * 0.25);
  const padY = textH * 0.6;
  const rx0 = clamp01(x0 - padX);
  const ry0 = clamp01(y0 - padY);
  const rx1 = clamp01(x1 + padX);
  const ry1 = clamp01(y1 + padY);
  return {
    rect: { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 },
    core,
    textH,
    frames: best.frames,
    strongFrames: best.strongFrames,
    members: best.members,
  };
}

// ------------------------------------------------------------------ filtres d'image

/**
 * Binarisations disponibles. Localisation : `lightHigh` puis `gray` ; lecture
 * d'une région : `lightHigh`, `gray`, puis `light`. Le seuil bas (`light`)
 * transforme un parquet clair et bruité en milliers de faux caractères
 * (2,7 s par tuile au lieu de 0,1 s) : il n'est essayé que sur la petite
 * région du bandeau, en dernier.
 */
export const BINARIZATIONS = {
  /** Texte clair sur fond sombre → noir sur blanc. */
  light: "format=gray,lutyuv=y='if(gt(val,165),0,255)'",
  /** Idem, seuil plus haut (fonds colorés clairs, texte blanc). */
  lightHigh: "format=gray,lutyuv=y='if(gt(val,205),0,255)'",
  /** Niveaux de gris : tesseract binarise lui-même (texte sombre sur fond clair). */
  gray: 'format=gray',
} as const;

export type Binarization = keyof typeof BINARIZATIONS;

/** Rectangle en pixels pairs, borné à l'image. */
export function pixelCrop(r: Rect, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor((r.x * W) / 2) * 2);
  const y = Math.max(0, Math.floor((r.y * H) / 2) * 2);
  const w = Math.max(2, Math.min(W - x, Math.ceil((r.w * W) / 2) * 2));
  const h = Math.max(2, Math.min(H - y, Math.ceil((r.h * H) / 2) * 2));
  return { x, y, w, h };
}

/** Filtre ffmpeg : recadrage, agrandissement ×k (bicubique), binarisation. */
export function cropFilter(r: Rect, W: number, H: number, k: number, bin: Binarization): string {
  const c = pixelCrop(r, W, H);
  const ow = Math.max(2, Math.round((c.w * k) / 2) * 2);
  const oh = Math.max(2, Math.round((c.h * k) / 2) * 2);
  return `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${ow}:${oh}:flags=bicubic,${BINARIZATIONS[bin]}`;
}

/**
 * Facteur d'agrandissement : tesseract lit le mieux des glyphes de ~40-50 px.
 * `textPx` = hauteur estimée du texte dans l'image source.
 */
export function upscaleFor(textPx: number): number {
  return Math.min(6, Math.max(1, 46 / Math.max(4, textPx)));
}

// ------------------------------------------------------------------ OCR d'une zone

/** OCR d'une zone d'une image ; renvoie les mots en pixels de l'image SOURCE. */
export async function ocrZone(
  worker: OcrWorker,
  png: Buffer,
  W: number,
  H: number,
  r: Rect,
  k: number,
  bin: Binarization,
): Promise<{ text: string; words: OcrWord[] }> {
  const c = pixelCrop(r, W, H);
  const img = await filterImage(png, cropFilter(r, W, H, k, bin));
  const { text, words } = await recognizeWords(worker, img);
  const sx = c.w / Math.max(2, Math.round((c.w * k) / 2) * 2);
  const sy = c.h / Math.max(2, Math.round((c.h * k) / 2) * 2);
  return {
    text,
    words: words.map((w) => ({ ...w, x0: c.x + w.x0 * sx, x1: c.x + w.x1 * sx, y0: c.y + w.y0 * sy, y1: c.y + w.y1 * sy })),
  };
}

// ------------------------------------------------------------------ localisation

/** Bandes candidates : bas d'abord (la grande majorité des diffuseurs), puis haut. */
export const SEARCH_BANDS: { name: string; y: number; h: number }[] = [
  { name: 'bas', y: 0.68, h: 0.32 },
  { name: 'haut', y: 0, h: 0.24 },
];

/** Tuiles horizontales qui se recouvrent de moitié : un bandeau entier tient dans au moins une. */
export const TILES: { x: number; w: number }[] = [
  { x: 0, w: 0.5 },
  { x: 0.25, w: 0.5 },
  { x: 0.5, w: 0.5 },
];

export interface LocateOptions {
  onProgress?: (done: number, total: number) => void;
  bands?: typeof SEARCH_BANDS;
  binarizations?: Binarization[];
}

export interface LocateResult {
  location: ScoreboardLocation | null;
  /** Lecture retenue par image échantillon (dans la région gagnante), réutilisable comme observation. */
  readings: (ScoreboardReading | null)[];
  ocrCalls: number;
}

/**
 * Localise le bandeau sur des images échantillons (8 à 12 conseillées, réparties
 * sur la vidéo pour éviter les plans sans bandeau : avant-match, mi-temps, pubs).
 */
export async function locateScoreboard(worker: OcrWorker, frames: Buffer[], o: LocateOptions = {}): Promise<LocateResult> {
  const bands = o.bands ?? SEARCH_BANDS;
  const bins = o.binarizations ?? (['lightHigh', 'gray'] as Binarization[]);
  const sizes = frames.map((f) => pngSize(f));
  const cands: ClockCandidate[] = [];
  let ocrCalls = 0;
  const total = bands.length * frames.length;
  let done = 0;
  for (const band of bands) {
    for (let i = 0; i < frames.length; i++) {
      const size = sizes[i];
      if (!size) continue;
      const { width: W, height: H } = size;
      // Normalise la définition : une bande de 720p est agrandie ×2 (texte de
      // bandeau ≈ 15-25 px → 30-50 px), une bande de 1080p ×1,33.
      const k = Math.min(4, Math.max(1, 1440 / H));
      for (const tile of TILES) {
        const r: Rect = { x: tile.x, y: band.y, w: tile.w, h: band.h };
        for (const bin of bins) {
          let found: ClockCandidate[] = [];
          try {
            const { words } = await ocrZone(worker, frames[i], W, H, r, k, bin);
            ocrCalls++;
            found = findClockCandidates(words, W, H, i);
          } catch {
            /* image illisible : on passe */
          }
          cands.push(...found);
          if (found.some((c) => c.strong)) break; // binarisation suivante inutile pour cette tuile
        }
      }
      o.onProgress?.(++done, total);
    }
    const vote = voteScoreboardRegion(cands, { sampledFrames: frames.length });
    if (vote) {
      const { members, ...location } = vote;
      const readings = frames.map((_, i) => bestReading(members.filter((m) => m.frame === i), location.core));
      return { location, readings, ocrCalls };
    }
  }
  return { location: null, readings: frames.map(() => null), ocrCalls };
}

// ------------------------------------------------------------------ lecture d'une image

export interface ScoreboardReading {
  period: number | null;
  clock_sec: number;
  scores: number[];
}

/** Candidat le plus fiable et le plus proche du bloc chrono attendu. */
function bestReading(cands: ClockCandidate[], core: Rect | null, maxDist = 0.08): ScoreboardReading | null {
  let best: ClockCandidate | null = null;
  let bestD = Infinity;
  const target = core ? center(core) : null;
  for (const c of cands) {
    const p = center(c.rect);
    const d = target ? Math.hypot(p.x - target.x, (p.y - target.y) * 1.5) : 0;
    if (target && d > maxDist) continue;
    const score = d - (c.strong ? 1 : 0);
    if (score < bestD) {
      bestD = score;
      best = c;
    }
  }
  return best ? { period: best.period, clock_sec: best.clock_sec, scores: best.scores } : null;
}

/**
 * Zones de repli sans localisation : bandes bas et haut en pleine largeur,
 * puis la zone relevée sur le bandeau NBC (x 42-57 %, y 82,5-95,5 %, où
 * tesseract lit proprement "1:24 65 2ND24").
 */
export const FALLBACK_ZONES: Rect[] = [
  { x: 0, y: 0.74, w: 1, h: 0.26 },
  { x: 0, y: 0, w: 1, h: 0.22 },
  { x: 0.42, y: 0.825, w: 0.15, h: 0.13 },
];

/**
 * Lit (période, chrono, scores) sur une image.
 *
 * Avec une localisation : recadrage sur la région du bandeau, trois
 * binarisations au plus (arrêt dès qu'une période est lue). Sans localisation :
 * zones de repli en pleine largeur (plus lent, mais on n'abandonne pas).
 */
export async function readScoreboard(worker: OcrWorker, png: Buffer, loc: ScoreboardLocation | null): Promise<ScoreboardReading | null> {
  const size = pngSize(png);
  if (!size) return null;
  const { width: W, height: H } = size;
  const zones = loc ? [loc.rect] : FALLBACK_ZONES;
  const k = loc ? upscaleFor(loc.textH * H) : Math.min(4, Math.max(1, 1440 / H));
  const bins: Binarization[] = ['lightHigh', 'gray', 'light'];
  let fallback: ScoreboardReading | null = null;
  for (const zone of zones) {
    for (const bin of bins) {
      const { text, words } = await ocrZone(worker, png, W, H, zone, k, bin);
      const r = bestReading(findClockCandidates(words, W, H), loc ? loc.core : null);
      if (r?.period) return r;
      if (r && !fallback) fallback = r;
      // Texte brut : utile quand tesseract ne segmente pas les mots proprement.
      if (!r && loc && !fallback) {
        const p = parseScoreboardText(text);
        if (p) fallback = { ...p, scores: [] };
      }
    }
  }
  return fallback;
}
