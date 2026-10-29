/**
 * Localisation ADAPTATIVE du bandeau de score.
 *
 * Les replays viennent de diffuseurs différents (ESPN/ABC, NBC, TNT, Prime
 * Video, chaînes locales) : le bandeau est en bas au centre, en bas à gauche,
 * en haut à droite… et sa taille varie. Une zone de recadrage fixe (ancienne
 * approche, calée sur NBC) ne lisait rien sur les autres diffuseurs, d'où des
 * synchros « estimées » fausses de plusieurs minutes.
 *
 * Localisation, sur 8 à 12 images échantillons :
 *  1. ZONES FIXES : les incrustations ne bougent pas d'une image à l'autre,
 *     contrairement au jeu (`staticOverlayRegions`, sur des vignettes) ; dans
 *     chaque zone, les CASES CLAIRES fixes (case blanche du chrono chez Prime
 *     Video, pastille d'ESPN) sont lues seules (`staticBrightCells`) ;
 *  2. OCR de la zone (texte sombre et texte clair fusionnés), relecture serrée
 *     des mots douteux, puis repérage des jetons « chrono » (m:ss, ss.d) et
 *     de la période voisine (1ST…4TH, OT, Q1…) avec les boîtes de mots ;
 *  3. vote : la région qui revient sur le plus d'images est le bandeau. Un
 *     chrono seul suffit s'il revient à la même place (périodes en exposant
 *     souvent illisibles) ;
 *  4. repli : bandes bas/haut en tuiles qui se recouvrent.
 *
 * Lecture d'une image (`readScoreboard`) : empreinte du bandeau (est-il à
 * l'écran ?), puis « gabarit » — chrono, période et scores relus chacun à sa
 * place apprise, en mode une ligne, avec vote entre binarisations.
 *
 * Mesuré sur de vraies images 720p (Prime Video, chaîne locale, ESPN ; voir
 * tests/real-frames.test.ts) : période + chrono lus sur 9/10, 6/6 et 6/7 des
 * images où le bandeau est lisible, aucun faux chrono, rien sur les plans sans
 * bandeau ; localisation 13-25 s pour 10 images, lecture ≈ 1,0-1,5 s par image.
 *
 * Toutes les coordonnées publiques sont en FRACTIONS de l'image (0..1), ce qui
 * rend le résultat indépendant de la définition (480p, 720p, 1080p).
 */
import {
  OCR_WHITELIST,
  filterImage,
  rawGray,
  normalizeOcrText,
  parseClockCandidates,
  parsePeriodText,
  parseScoreboardText,
  pngSize,
  recognizeWords,
  type OcrWord,
  type OcrParams,
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
  /** Boîte du seul chrono (fractions de l'image). */
  clockRect: Rect;
  /** Boîte de la période quand elle est un mot séparé du chrono. */
  periodRect?: Rect;
  /** Période trouvée à côté du chrono (lecture fiable). */
  strong: boolean;
  /** Chrono lu dans une case claire entière (boîte moins précise qu'un mot). */
  fromCell?: boolean;
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
    out.push({ frame, period, clock_sec: clock, rect: toRect(box, W, H), clockRect: toRect(c, W, H), ...(pi >= 0 ? { periodRect: toRect(words[pi], W, H) } : {}), textH: h / H, scores, scoreRects, strong: period !== null });
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
  /** Boîte médiane du seul chrono (lecture sans deux-points « 857 »). */
  clock?: Rect;
  /** Boîte médiane de la période (si elle a été lue à part sur des images). */
  period?: Rect;
  /** Emplacements des nombres récurrents près du chrono (scores, shot clock). */
  scores?: Rect[];
  /** Empreinte du bandeau (vignette médiane), pour savoir s'il est à l'écran. */
  panel?: PanelSignature;
}

/**
 * Empreinte d'un bandeau : niveaux de gris médians de sa zone sur la vignette
 * THUMB_W×THUMB_H, et masque des pixels stables (fond, cadres, logos — pas les
 * chiffres, qui changent).
 */
export interface PanelSignature {
  x: number;
  y: number;
  w: number;
  h: number;
  med: number[];
  mask: number[];
}

/** Empreinte du bandeau sur des vignettes (médiane + pixels stables). */
export function panelSignature(thumbs: Buffer[], r: Rect): PanelSignature | null {
  const n = thumbs.length;
  if (n < 3) return null;
  const x = Math.max(0, Math.floor(r.x * THUMB_W));
  const y = Math.max(0, Math.floor(r.y * THUMB_H));
  const w = Math.min(THUMB_W - x, Math.ceil(r.w * THUMB_W));
  const h = Math.min(THUMB_H - y, Math.ceil(r.h * THUMB_H));
  if (w <= 0 || h <= 0) return null;
  const med: number[] = [];
  const mask: number[] = [];
  const vals = new Array<number>(n);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const p = (y + j) * THUMB_W + x + i;
      for (let k = 0; k < n; k++) vals[k] = thumbs[k][p];
      vals.sort((a, b) => a - b);
      const m = vals[n >> 1];
      let c = 0;
      for (let k = 0; k < n; k++) if (Math.abs(vals[k] - m) <= 20) c++;
      med.push(m);
      if (c / n >= 0.5) mask.push(j * w + i);
    }
  return mask.length >= 20 ? { x, y, w, h, med, mask } : null;
}

/** Part des pixels stables du bandeau retrouvés sur une vignette (0..1). */
export function panelPresence(thumb: Buffer, sig: PanelSignature): number {
  let ok = 0;
  for (const idx of sig.mask) {
    const i = idx % sig.w;
    const j = Math.floor(idx / sig.w);
    if (Math.abs(thumb[(sig.y + j) * THUMB_W + sig.x + i] - sig.med[idx]) <= 28) ok++;
  }
  return ok / sig.mask.length;
}

/** En dessous de cette présence, le bandeau n'est pas à l'écran (gros plan, pub, mi-temps). */
export const PANEL_MIN_PRESENCE = 0.6;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Rectangle médian (bord par bord). */
function medianRect(rs: Rect[]): Rect {
  const x0 = median(rs.map((r) => r.x));
  const y0 = median(rs.map((r) => r.y));
  const x1 = median(rs.map((r) => r.x + r.w));
  const y1 = median(rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
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
  // Chrono seul (période illisible, fréquent avec les périodes en exposant
  // « 1ˢᵀ » de Prime Video et d'ESPN) : il faut qu'il revienne à la même
  // place sur plusieurs images (2, et au moins un quart des images analysées).
  const weakOk = best.frames >= Math.max(2, Math.ceil(Math.min(sampled, 40) * 0.25));
  const accepted =
    best.strongFrames >= 2 || (best.strongFrames >= 1 && best.frames >= 2) || (sampled <= 1 && best.strongFrames >= 1) || weakOk;
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
  const scoreRects: Rect[] = [];
  for (const s of scoreSpots) {
    if (s.frames.size < minSpot && !(reps.length === 1 && s.frames.size === 1)) continue;
    scoreRects.push(medianRect(s.rects));
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
  // Boîtes de période serrées seulement (même raison que pour le chrono).
  const periodAll = best.members.filter((m) => m.periodRect).map((m) => m.periodRect as Rect);
  const pmin = periodAll.length ? Math.min(...periodAll.map((r) => r.h)) : 0;
  const periodRects = periodAll.filter((r) => r.h <= pmin * 1.35);
  // Boîte du chrono : seulement les boîtes SERRÉES. Une relecture « une ligne »
  // d'un bandeau sur deux rangées (chrono au-dessus, période dessous) rend une
  // boîte haute qui couvre les deux rangées, inutilisable comme gabarit.
  // Les boîtes de mots priment sur les cases (une case peut couvrir deux
  // rangées : chrono et, dessous, période + shot clock).
  const wordMembers = best.members.filter((m) => !m.fromCell);
  const clockSrc = wordMembers.length ? wordMembers : best.members;
  const hmin = Math.min(...clockSrc.map((m) => m.clockRect.h));
  const clock = medianRect(clockSrc.filter((m) => m.clockRect.h <= hmin * 1.35).map((m) => m.clockRect));
  return {
    rect: { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 },
    core,
    textH,
    frames: best.frames,
    strongFrames: best.strongFrames,
    clock,
    ...(periodRects.length ? { period: medianRect(periodRects) } : {}),
    ...(scoreRects.length ? { scores: scoreRects } : {}),
    members: best.members,
  };
}

// ------------------------------------------------------------------ zones fixes (incrustations)

export const THUMB_W = 320;
export const THUMB_H = 180;

export interface StaticRegion {
  rect: Rect;
  /** Pixels « fixes et contrastés » dans la zone (plus = plus probable). */
  score: number;
}

/**
 * Zones FIXES d'une image à l'autre : les incrustations du diffuseur (bandeau
 * de score, logos). Le reste de l'image (parquet, joueurs, public) change
 * d'un échantillon à l'autre, la caméra suivant le jeu.
 *
 * Sur des vignettes en gris (THUMB_W×THUMB_H) : médiane par pixel, part des
 * images proches de cette médiane, contours de l'image médiane. Un pixel
 * fixe (≥ `minAgree` des images) ET sur un contour net appartient à une
 * incrustation. On regroupe ces pixels par cellules 4×4, puis en composantes
 * connexes, triées par nombre de pixels.
 *
 * Bien moins coûteux qu'un OCR de bandes entières, et indifférent à la
 * polarité du texte (noir sur case blanche, blanc sur fond sombre…).
 */
export function staticOverlayRegions(thumbs: Buffer[], o: { w?: number; h?: number; minAgree?: number; maxRegions?: number } = {}): StaticRegion[] {
  const w = o.w ?? THUMB_W;
  const h = o.h ?? THUMB_H;
  const n = thumbs.length;
  if (n < 2) return [];
  const minAgree = o.minAgree ?? 0.4;
  const med = new Uint8Array(w * h);
  const agree = new Float32Array(w * h);
  const vals = new Array<number>(n);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < n; k++) vals[k] = thumbs[k][i];
    vals.sort((a, b) => a - b);
    const m = vals[n >> 1];
    med[i] = m;
    let c = 0;
    for (let k = 0; k < n; k++) if (Math.abs(vals[k] - m) <= 14) c++;
    agree[i] = c / n;
  }
  // Pixels fixes ET sur un contour de l'image médiane.
  const C = 4;
  const cw = Math.ceil(w / C);
  const chh = Math.ceil(h / C);
  const cells = new Uint16Array(cw * chh);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (agree[i] < minAgree) continue;
      const g = Math.abs(med[i + 1] - med[i - 1]) + Math.abs(med[i + w] - med[i - w]);
      if (g < 48) continue;
      cells[Math.floor(y / C) * cw + Math.floor(x / C)]++;
    }
  // Cellule retenue : au moins 3 pixels sur 16. Dilatation horizontale d'une
  // cellule pour relier les caractères d'une même ligne.
  const on = new Uint8Array(cw * chh);
  for (let cy = 0; cy < chh; cy++)
    for (let cx = 0; cx < cw; cx++) {
      if (cells[cy * cw + cx] < 3) continue;
      for (let dx = -1; dx <= 1; dx++) if (cx + dx >= 0 && cx + dx < cw) on[cy * cw + cx + dx] = 1;
    }
  const seen = new Uint8Array(cw * chh);
  const out: StaticRegion[] = [];
  for (let start = 0; start < cw * chh; start++) {
    if (!on[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = cw;
    let y0 = chh;
    let x1 = -1;
    let y1 = -1;
    let score = 0;
    let count = 0;
    while (stack.length) {
      const c = stack.pop() as number;
      const cx = c % cw;
      const cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      score += cells[c];
      count++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
          const j = ny * cw + nx;
          if (on[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    // Trop petit pour un bandeau (logo de chaîne, coin de panneau) : ignoré.
    if (count < 8 || bw < 5 || score < 40) continue;
    const pad = 1;
    const rx0 = Math.max(0, x0 - pad) * C;
    const ry0 = Math.max(0, y0 - pad) * C;
    const rx1 = Math.min(cw, x1 + 1 + pad) * C;
    const ry1 = Math.min(chh, y1 + 1 + pad) * C;
    void bh;
    out.push({ rect: { x: rx0 / w, y: ry0 / h, w: (Math.min(w, rx1) - rx0) / w, h: (Math.min(h, ry1) - ry0) / h }, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, o.maxRegions ?? 4);
}

/**
 * Cases CLAIRES fixes dans une zone (case blanche du chrono chez Prime Video,
 * pastille blanche chez ESPN) : pixels clairs (médiane ≥ 170) et fixes, en
 * composantes connexes de forme « case » (plus larges que hautes, bien
 * remplies). Une case se lit bien mieux seule qu'au milieu du bandeau.
 */
export function staticBrightCells(thumbs: Buffer[], zone: Rect, o: { w?: number; h?: number; minAgree?: number } = {}): Rect[] {
  const w = o.w ?? THUMB_W;
  const h = o.h ?? THUMB_H;
  const n = thumbs.length;
  if (n < 2) return [];
  const minAgree = o.minAgree ?? 0.4;
  const zx0 = Math.max(0, Math.floor(zone.x * w));
  const zy0 = Math.max(0, Math.floor(zone.y * h));
  const zx1 = Math.min(w, Math.ceil((zone.x + zone.w) * w));
  const zy1 = Math.min(h, Math.ceil((zone.y + zone.h) * h));
  const zw = zx1 - zx0;
  const zh = zy1 - zy0;
  if (zw <= 0 || zh <= 0) return [];
  const mask = new Uint8Array(zw * zh);
  const vals = new Array<number>(n);
  for (let y = 0; y < zh; y++)
    for (let x = 0; x < zw; x++) {
      const i = (zy0 + y) * w + zx0 + x;
      for (let k = 0; k < n; k++) vals[k] = thumbs[k][i];
      vals.sort((a, b) => a - b);
      const m = vals[n >> 1];
      if (m < 170) continue;
      let c = 0;
      for (let k = 0; k < n; k++) if (Math.abs(vals[k] - m) <= 30) c++;
      if (c / n >= minAgree) mask[y * zw + x] = 1;
    }
  // Fermeture horizontale (trous de 4 pixels au plus) : les chiffres sombres
  // coupent la case en morceaux sur la vignette.
  const closed = mask.slice();
  for (let y = 0; y < zh; y++) {
    let last = -1;
    for (let x = 0; x < zw; x++) {
      if (!mask[y * zw + x]) continue;
      if (last >= 0 && x - last > 1 && x - last <= 5) for (let k = last + 1; k < x; k++) closed[y * zw + k] = 1;
      last = x;
    }
  }
  const seen = new Uint8Array(zw * zh);
  const out: Rect[] = [];
  for (let s = 0; s < zw * zh; s++) {
    if (!closed[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let x0 = zw;
    let y0 = zh;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    while (stack.length) {
      const c = stack.pop() as number;
      const cx = c % zw;
      const cy = Math.floor(c / zw);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      count++;
      for (const j of [c - 1, c + 1, c - zw, c + zw]) {
        if (j < 0 || j >= zw * zh || seen[j] || !closed[j]) continue;
        if ((j === c - 1 && cx === 0) || (j === c + 1 && cx === zw - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    // Case de chrono : 3 à 20 pixels de haut (vignette 180 px), plus large que haute, bien remplie.
    if (bh < 3 || bh > 20 || bw < 1.2 * bh || bw > 8 * bh || count < 0.45 * bw * bh) continue;
    out.push({ x: (zx0 + x0) / w, y: (zy0 + y0) / h, w: bw / w, h: bh / h });
  }
  // Les plus grandes cases d'abord (une case de chrono est rarement minuscule).
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
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
  /** Texte sombre sur fond clair (case ou pastille blanche) → noir sur blanc, le fond sombre autour devient noir. */
  dark: "format=gray,lutyuv=y='if(lt(val,110),0,255)'",
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
  params: OcrParams = {},
): Promise<{ text: string; words: OcrWord[] }> {
  const c = pixelCrop(r, W, H);
  const img = await filterImage(png, cropFilter(r, W, H, k, bin));
  const { text, words } = await recognizeWords(worker, img, params);
  const sx = c.w / Math.max(2, Math.round((c.w * k) / 2) * 2);
  const sy = c.h / Math.max(2, Math.round((c.h * k) / 2) * 2);
  return {
    text,
    words: words.map((w) => ({ ...w, x0: c.x + w.x0 * sx, x1: c.x + w.x1 * sx, y0: c.y + w.y0 * sy, y1: c.y + w.y1 * sy })),
  };
}

// ------------------------------------------------------------------ localisation

/** Bandes candidates (repli sans zone fixe) : bas d'abord, puis haut. */
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

/**
 * Binarisations lues ET FUSIONNÉES pour une même zone : un bandeau mêle souvent
 * deux polarités (chrono noir sur case blanche, période et scores blancs sur
 * fond sombre — Prime Video, ESPN). `gray` lit le texte sombre, `light` le
 * texte clair ; les mots des deux lectures sont réunis avant l'appariement.
 */
export const MERGED_BINARIZATIONS: Binarization[] = ['gray', 'light'];

/**
 * Binarisations des petits recadrages (une case) : on ajoute `dark`, seule à
 * lire proprement un chrono sombre dans une pastille blanche cerclée de noir
 * (ESPN). Les lectures sont départagées par vote.
 */
export const REFINE_BINARIZATIONS: Binarization[] = ['dark', 'light', 'gray'];

/** OCR d'une zone avec plusieurs binarisations, mots réunis (pixels de l'image source). */
export async function ocrZoneMerged(
  worker: OcrWorker,
  png: Buffer,
  W: number,
  H: number,
  r: Rect,
  k: number,
  bins: Binarization[] = MERGED_BINARIZATIONS,
): Promise<{ text: string; words: OcrWord[]; calls: number }> {
  const words: OcrWord[] = [];
  const texts: string[] = [];
  let calls = 0;
  for (const bin of bins) {
    try {
      const z = await ocrZone(worker, png, W, H, r, k, bin);
      calls++;
      words.push(...z.words);
      texts.push(z.text);
    } catch {
      /* binarisation illisible : on passe */
    }
  }
  return { text: texts.join('\n'), words, calls };
}

const digitCount = (t: string) => (t.match(/\d/g) ?? []).length;

/**
 * Mots « chrono probable » à relire seuls : chiffres avec « : » ou « . »
 * d'abord, puis groupes de 3-4 chiffres (deux-points perdu), puis le reste.
 */
function clockLikeWords(words: OcrWord[], max: number): OcrWord[] {
  const rank = (w: OcrWord) => {
    const d = digitCount(w.text);
    const h = w.y1 - w.y0;
    if (h < 6) return -1;
    if (d >= 2 && d <= 5) {
      if (/\d[:.]\d/.test(w.text) || /^[:.]\d/.test(w.text)) return 3;
      // Bilan « 54-28 » : jamais un chrono. Deux chiffres seuls : après les mots illisibles.
      if (/\d-\d/.test(w.text)) return -1;
      return d >= 3 ? 2 : 0.8;
    }
    // Mot illisible de la taille d'un chrono (« «Xd » pour « 7:47 » dans une
    // pastille blanche cerclée de noir) : relu seul, il se lit souvent.
    const letters = (w.text.match(/[A-Za-z]/g) ?? []).length;
    const aspect = (w.x1 - w.x0) / h;
    if (d === 0 && h >= 10 && aspect >= 1.3 && aspect <= 6 && letters / Math.max(1, w.text.length) < 0.7) return 1;
    return -1;
  };
  const out: OcrWord[] = [];
  for (const w of [...words].filter((x) => rank(x) > 0).sort((a, b) => rank(b) - rank(a))) {
    const h = w.y1 - w.y0;
    if (out.some((o) => Math.abs((o.x0 + o.x1) / 2 - (w.x0 + w.x1) / 2) < 2 * h && Math.abs((o.y0 + o.y1) / 2 - (w.y0 + w.y1) / 2) < h)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * OCR d'une zone en deux passes.
 *
 * 1. Texte épars (psm 11), binarisations fusionnées.
 * 2. Relecture « une ligne » (psm 7) d'un recadrage serré autour des mots qui
 *    ressemblent à un chrono (élargi de 1,6 hauteur de texte de chaque côté),
 *    ou qui sont illisibles mais en ont la taille.
 *
 * Mesuré sur de vraies images : dans un bandeau chargé (logos, fautes,
 * sponsor), la passe 1 perd souvent une partie du chrono (« 57 » pour
 * « 8:57 », « 800 » pour « 8:00 ») ; le recadrage serré le relit entier, avec
 * la période voisine sur la même ligne (« 2ND 8:00 12 »).
 */
export async function ocrZoneRefined(
  worker: OcrWorker,
  png: Buffer,
  W: number,
  H: number,
  r: Rect,
  k: number,
  o: { bins?: Binarization[]; maxRefine?: number } = {},
): Promise<{ text: string; words: OcrWord[]; calls: number }> {
  const first = await ocrZoneMerged(worker, png, W, H, r, k, o.bins);
  let calls = first.calls;
  const words = [...first.words];
  const texts = [first.text];
  for (const w of clockLikeWords(first.words, o.maxRefine ?? 5)) {
    const h = w.y1 - w.y0;
    const px = digitCount(w.text) ? 1.6 * h : 0.5 * h;
    const sub: Rect = { x: (w.x0 - px) / W, y: (w.y0 - 0.35 * h) / H, w: (w.x1 - w.x0 + 2 * px) / W, h: (1.7 * h) / H };
    const clipped: Rect = { x: Math.max(0, sub.x), y: Math.max(0, sub.y), w: Math.min(1, sub.x + sub.w) - Math.max(0, sub.x), h: Math.min(1, sub.y + sub.h) - Math.max(0, sub.y) };
    for (const bin of REFINE_BINARIZATIONS) {
      try {
        // Mot illisible recadré serré : alphabet des chiffres (« 7:47 » et non « 2:47 »).
        const z = await ocrZone(worker, png, W, H, clipped, Math.min(6, Math.max(1.5, 46 / h)), bin, { psm: '7', whitelist: digitCount(w.text) ? '' : '0123456789:.' });
        calls++;
        words.push(...z.words);
        texts.push(z.text);
      } catch {
        /* on passe */
      }
    }
  }
  return { text: texts.join('\n'), words, calls };
}

/** Facteur d'agrandissement d'une zone fixe : texte de bandeau ≈ 10-17 px en 720p → 30-50 px. */
const zoneScale = (H: number) => Math.min(4, Math.max(1.5, (3 * 720) / H));

export interface LocateOptions {
  onProgress?: (done: number, total: number) => void;
  bands?: typeof SEARCH_BANDS;
  binarizations?: Binarization[];
  /** Zones fixes candidates examinées au plus. */
  maxZones?: number;
}

export interface LocateResult {
  location: ScoreboardLocation | null;
  /** Lecture retenue par image échantillon (dans la région gagnante), réutilisable comme observation. */
  readings: (ScoreboardReading | null)[];
  ocrCalls: number;
  /** Méthode qui a trouvé le bandeau. */
  method?: 'zones-fixes' | 'bandes';
}

/**
 * Localise le bandeau sur des images échantillons (8 à 12 conseillées, réparties
 * sur la vidéo pour éviter les plans sans bandeau : avant-match, mi-temps, pubs).
 *
 * 1. Zones fixes (`staticOverlayRegions`) : les incrustations ne bougent pas
 *    d'une image à l'autre. On lit chacune (deux binarisations fusionnées) sur
 *    chaque image et on vote sur les chronos trouvés.
 * 2. Repli : bandes bas puis haut en tuiles qui se recouvrent.
 */
export async function locateScoreboard(worker: OcrWorker, frames: Buffer[], o: LocateOptions = {}): Promise<LocateResult> {
  const sizes = frames.map((f) => pngSize(f));
  const bins = o.binarizations ?? MERGED_BINARIZATIONS;
  let ocrCalls = 0;

  const finish = (cands: ClockCandidate[], method: LocateResult['method'], panel: Rect | null): LocateResult | null => {
    const vote = voteScoreboardRegion(cands, { sampledFrames: frames.length });
    if (!vote) return null;
    const { members, ...location } = vote;
    // La zone fixe entière (bandeau complet) est la meilleure région de lecture :
    // elle contient chrono, période, shot clock et scores.
    // Empreinte sur la région « utile » (chrono, période, scores) et non sur la
    // zone fixe entière, dont les bords (fautes, sponsors) changent souvent.
    const sig = thumbs.length >= 3 ? panelSignature(thumbs, location.rect) : null;
    if (panel) location.rect = unionRect(location.rect, panel);
    if (sig) location.panel = sig;
    const readings = frames.map((_, i) => bestReading(members.filter((m) => m.frame === i), location.core));
    return { location, readings, ocrCalls, method };
  };

  // 1. Zones fixes.
  let zones: Rect[] = [];
  const thumbs: Buffer[] = [];
  let minAgree = 0.4;
  if (frames.length >= 3) {
    for (const f of frames) {
      try {
        thumbs.push(await rawGray(f, THUMB_W, THUMB_H));
      } catch {
        /* image illisible */
      }
    }
    // Avec peu d'images, deux plans proches suffiraient à rendre « fixe » une
    // grande partie de l'image : on exige alors plus d'accord.
    minAgree = thumbs.length <= 5 ? 0.6 : 0.4;
    zones = staticOverlayRegions(thumbs, { minAgree })
      .map((z) => z.rect)
      .filter((r) => r.w * r.h <= 0.3 && r.h <= 0.35)
      .slice(0, o.maxZones ?? 3);
  }
  const total = (zones.length + (o.bands ?? SEARCH_BANDS).length) * frames.length;
  let done = 0;
  for (const zone of zones) {
    const cands: ClockCandidate[] = [];
    const cells = staticBrightCells(thumbs, zone, { minAgree }).slice(0, 2);
    for (let i = 0; i < frames.length; i++) {
      const size = sizes[i];
      if (!size) continue;
      const { width: W, height: H } = size;
      // Cases claires fixes d'abord : lues seules (chiffres uniquement), vote
      // entre binarisations. Peu coûteux et très fiable quand il y en a.
      const cellWords: OcrWord[] = [];
      for (const cell of cells) {
        const r = clip(expand(cell, 0.08, 0.12));
        if (!r) continue;
        // Case claire : texte sombre — binarisations du texte sombre seulement.
        const reads = await ocrLine(worker, frames[i], W, H, r, cell.h * H * 0.6, ['dark', 'gray'], '0123456789:.');
        ocrCalls += 2;
        const values = reads.map((x) => clockFromSlotText(x.text)).filter((v): v is number => v !== null);
        if (!values.length) continue;
        const v = [...values].sort((a, b) => values.filter((x) => x === b).length - values.filter((x) => x === a).length)[0];
        // Mot synthétique « m:ss » à la place de la case : la recherche de la
        // période et des scores voisins se fait ensuite comme pour un mot lu.
        const ih = cell.h * H * 0.7;
        const icy = (cell.y + cell.h / 2) * H;
        cellWords.push({ text: `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`, x0: cell.x * W, x1: (cell.x + cell.w) * W, y0: icy - ih / 2, y1: icy + ih / 2, confidence: 90 });
      }
      // Puis la zone entière (période et scores voisins) ; la relecture des mots
      // douteux, coûteuse, seulement si aucune case n'a donné de chrono.
      const z = await ocrZoneRefined(worker, frames[i], W, H, zone, zoneScale(H), { bins, maxRefine: cellWords.length ? 1 : 3 });
      ocrCalls += z.calls;
      cands.push(...findClockCandidates(z.words, W, H, i));
      for (const cw of cellWords) {
        const c = findClockCandidates([cw, ...z.words], W, H, i).find((x) => x.clockRect.x === cw.x0 / W);
        if (c) cands.push({ ...c, fromCell: true });
      }
      o.onProgress?.(++done, total);
    }
    const r = finish(cands, 'zones-fixes', zone);
    if (r) return r;
  }

  // 2. Repli : bandes en tuiles.
  const cands: ClockCandidate[] = [];
  for (const band of o.bands ?? SEARCH_BANDS) {
    for (let i = 0; i < frames.length; i++) {
      const size = sizes[i];
      if (!size) continue;
      const { width: W, height: H } = size;
      const k = Math.min(4, Math.max(1, 1440 / H));
      for (const tile of TILES) {
        const r: Rect = { x: tile.x, y: band.y, w: tile.w, h: band.h };
        const z = await ocrZoneMerged(worker, frames[i], W, H, r, k, bins);
        ocrCalls += z.calls;
        cands.push(...findClockCandidates(z.words, W, H, i));
      }
      o.onProgress?.(++done, total);
    }
    const r = finish(cands, 'bandes', null);
    if (r) return r;
  }
  return { location: null, readings: frames.map(() => null), ocrCalls };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ lecture d'une image

export interface ScoreboardReading {
  period: number | null;
  clock_sec: number;
  scores: number[];
}

/** Candidat le plus fiable et le plus proche du bloc chrono attendu. */
function bestCandidate(cands: ClockCandidate[], core: Rect | null, maxDist = 0.08): ClockCandidate | null {
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
  return best;
}

function bestReading(cands: ClockCandidate[], core: Rect | null, maxDist = 0.08): ScoreboardReading | null {
  const best = bestCandidate(cands, core, maxDist);
  return best ? { period: best.period, clock_sec: best.clock_sec, scores: best.scores } : null;
}

/**
 * Période lue dans un PETIT jeton voisin du chrono, en tolérant les
 * confusions des périodes en exposant (« 1ˢᵀ » lu « 187 », « 1T », « 15T »).
 * À n'utiliser que sur un jeton déjà repéré à côté du chrono : ailleurs,
 * « 187 » serait un nombre comme un autre.
 */
export function loosePeriod(text: string, o: { bareSuffix?: boolean } = {}): number | null {
  const t = normalizeOcrText(text).replace(/[^0-9A-Z]/g, '');
  if (!t) return null;
  const strict = parsePeriodText(t);
  if (strict !== null && t.length <= 4) return strict;
  if (/^1(?:[S58][T7]|[ST])$/.test(t)) return 1;
  if (/^2(?:N[D0O]?)$/.test(t)) return 2;
  if (/^3(?:R[D0O]?)$/.test(t)) return 3;
  if (/^4(?:[T7][H4]|T)$/.test(t)) return 4;
  // Chiffre perdu, suffixe lu (« ND », « OND ») : les quatre suffixes sont distincts.
  // Un suffixe seul (« TH ») peut venir d'un autre mot (« THURSDAY ») : seulement sur demande.
  const suffix = (o.bareSuffix ?? true ? /^[0-9A-Z]?(ST|ND|RD|TH)$/ : /^[0-9A-Z](ST|ND|RD|TH)$/).exec(t);
  if (suffix) {
    const v = { ST: 1, ND: 2, RD: 3, TH: 4 }[suffix[1] as 'ST' | 'ND' | 'RD' | 'TH'];
    const lead = Number(t[0]);
    return t.length === 3 && lead >= 1 && lead <= 4 && lead !== v ? null : v;
  }
  return null;
}

/**
 * Chrono sans deux-points (« 857 », « 8.57 ») : accepté seulement s'il est à
 * la place habituelle du chrono, et si la valeur est un chrono valide.
 */
export function colonlessClock(text: string): number | null {
  const t = text.replace(/[^0-9.,]/g, '');
  const m = /^(\d{1,2})[.,]?(\d{2})$/.exec(t);
  if (!m || (!/[.,]/.test(t) && t.length < 3)) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (mm > 12 || ss >= 60 || (mm === 12 && ss > 0)) return null;
  return mm * 60 + ss;
}

const overlaps = (w: OcrWord, r: Rect, W: number, H: number) => {
  const cx = (w.x0 + w.x1) / 2 / W;
  const cy = (w.y0 + w.y1) / 2 / H;
  const mx = r.w * 0.6;
  const my = r.h * 0.8;
  return cx >= r.x - mx && cx <= r.x + r.w + mx && cy >= r.y - my && cy <= r.y + r.h + my;
};

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
 * Polarité du texte du chrono : médiane de la zone claire (case ou pastille
 * blanche) → texte « sombre » ; médiane sombre → texte « clair ».
 * Sert à préférer la bonne binarisation quand elles se contredisent
 * (« 7:47 » noir sur blanc lu « 2:47 » par la binarisation du texte clair).
 */
async function clockPolarity(png: Buffer, r: Rect): Promise<'sombre' | 'clair' | null> {
  const size = pngSize(png);
  if (!size) return null;
  const c = pixelCrop(r, size.width, size.height);
  try {
    const g = await rawGray(png, 48, 16, 10_000, `crop=${c.w}:${c.h}:${c.x}:${c.y}`);
    const v = [...g].sort((a, b) => a - b)[g.length >> 1];
    return v >= 150 ? 'sombre' : v <= 90 ? 'clair' : null;
  } catch {
    return null;
  }
}

/** Rectangle agrandi de `ax` × largeur et `ay` × hauteur de chaque côté, borné à l'image. */
function expand(r: Rect, ax: number, ay: number): Rect {
  const x0 = Math.max(0, r.x - r.w * ax);
  const y0 = Math.max(0, r.y - r.h * ay);
  const x1 = Math.min(1, r.x + r.w * (1 + ax));
  const y1 = Math.min(1, r.y + r.h * (1 + ay));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** OCR « une ligne » d'une petite zone ; textes de chaque binarisation. */
async function ocrLine(
  worker: OcrWorker,
  png: Buffer,
  W: number,
  H: number,
  r: Rect,
  textPx: number,
  bins: Binarization[],
  whitelist: string,
  psm = '7',
): Promise<{ text: string; words: OcrWord[] }[]> {
  const k = Math.min(6, Math.max(1.5, 46 / Math.max(4, textPx)));
  const out: { text: string; words: OcrWord[] }[] = [];
  for (const bin of bins) {
    try {
      const z = await ocrZone(worker, png, W, H, r, k, bin, { psm, whitelist });
      if (z.text.trim()) out.push({ text: z.text.trim(), words: z.words });
    } catch {
      /* on passe */
    }
  }
  return out;
}

/**
 * Période lue dans la case « période » d'un gabarit, avec la hauteur des
 * glyphes pour arbitrer :
 *  - forme reconnue (« 2ND », « 3R0 », « 1T »…) : texte pas plus haut que 1,3 × le chrono ;
 *  - forme tronquée (« 4 », « 20 », « 30. » : l'exposant « TH »/« ND » est
 *    perdu) : seulement dans une case dédiée (`relaxed`), avec la même borne de
 *    hauteur — un score voisin est écrit nettement plus gros.
 */
export function periodFromSlot(words: OcrWord[], clockPx: number, relaxed = true, bareSuffix = !relaxed): number | null {
  for (const w of words) {
    const h = w.y1 - w.y0;
    const t = normalizeOcrText(w.text).replace(/[^0-9A-Z.]/g, '');
    const p = loosePeriod(t, { bareSuffix }) ?? parsePeriodText(t);
    if (h < 0.4 * clockPx) continue; // fragment parasite
    if (p !== null && h <= 1.3 * clockPx) return p;
    const m = /^([1-4])[A-Z0.]{0,2}$/.exec(t);
    if (relaxed && m && h <= 1.3 * clockPx) return Number(m[1]);
    // Période en exposant à gauche du chrono (ESPN : « 2ⁿᵈ » lu « 2m », « 4 ») :
    // chiffre suivi de lettres seulement, écrit nettement plus petit que le chrono
    // (un score voisin est plus gros).
    const sup = /^([1-4])[A-Z]{0,2}$/.exec(t);
    if (!relaxed && sup && h <= 0.85 * clockPx) return Number(sup[1]);
  }
  return null;
}

/** Chrono lu dans le texte d'une petite zone (avec ou sans deux-points). */
function clockFromLine(text: string): number | null {
  const t = normalizeOcrText(text);
  const c = parseClockCandidates(t)[0];
  if (c !== undefined) return c;
  return gluedClock(t) ?? colonlessClock(t.replace(/\s+/g, ''));
}

/**
 * Chrono pris dans une suite collée (« 114:562 » = « 1ST 4:56 24 ») : deux
 * chiffres après les deux-points, puis un ou deux avant (deux seulement si la
 * valeur reste un chrono valide).
 */
export function gluedClock(text: string): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(text.replace(/\s+/g, ''));
  if (!m) return null;
  const ss = Number(m[2]);
  if (ss >= 60) return null;
  for (const mmTxt of m[1].length === 2 ? [m[1], m[1][1]] : [m[1]]) {
    const mm = Number(mmTxt);
    if (mm <= 12 && !(mm === 12 && ss > 0)) return mm * 60 + ss;
  }
  return null;
}

/**
 * Chrono lu dans la case du chrono seule : formes classiques, collées,
 * sans deux-points, et dixièmes dont les deux-points ont été lus « 1 »
 * (« 129.7 » pour « :29.7 »).
 */
export function clockFromSlotText(text: string): number | null {
  const t = normalizeOcrText(text).replace(/\s+/g, '');
  const tenths = /^[1:;]?(\d{1,2})\.(\d)$/.exec(t);
  if (tenths && Number(tenths[1]) < 60) return Math.round(Number(tenths[1]) + Number(tenths[2]) / 10);
  return parseClockCandidates(t)[0] ?? gluedClock(t) ?? colonlessClock(t);
}

/**
 * Chrono lu dans une petite zone : d'abord les mots (séparés par tesseract)
 * proches de la place du chrono, puis le texte entier.
 */
function clockFromZone(z: { text: string; words: OcrWord[] }, clock: Rect, W: number, H: number): number | null {
  const cx = (clock.x + clock.w / 2) * W;
  const tol = Math.max(clock.w * W * 0.6, clock.h * H * 1.2);
  const central = z.words.filter((w) => Math.abs((w.x0 + w.x1) / 2 - cx) <= tol);
  for (const w of central) {
    const t = normalizeOcrText(w.text);
    const v = parseClockCandidates(t)[0] ?? gluedClock(t) ?? colonlessClock(t);
    if (v !== null && v !== undefined) return v;
  }
  return clockFromLine(z.text);
}

/**
 * Lecture « gabarit » : la disposition d'un bandeau ne change pas d'une image
 * à l'autre. On relit donc, chacun seul et en mode « une ligne », le chrono à
 * sa place apprise (élargie : « 10:06 » est plus large que « 8:57 »), la
 * période (place apprise, sinon à gauche ou sous le chrono) et les scores.
 *
 * Sur de vraies images (Prime Video : chrono noir sur case blanche, période
 * en exposant dessous), lire le bandeau entier mélangeait les lignes et les
 * polarités ; une case à la fois se lit proprement.
 */
/** Case de période qui a réussi en dernier, par localisation (voir `readTemplate`). */
const periodHint = new WeakMap<ScoreboardLocation, string>();

async function readTemplate(worker: OcrWorker, png: Buffer, W: number, H: number, loc: ScoreboardLocation): Promise<ScoreboardReading | null> {
  const clock = loc.clock as Rect;
  const ch = clock.h * H;
  // Chrono : vote entre les deux binarisations (texte sombre / texte clair).
  // Élargi de 1,6 hauteur de texte de chaque côté (« 10:06 » est plus large
  // que « 8:57 », et la boîte apprise peut n'être qu'une partie du chrono),
  // mais à peine en hauteur, pour ne pas mordre sur une rangée voisine.
  const padX = (1.6 * ch) / W;
  const clockZone = clip({ x: clock.x - padX, y: clock.y - clock.h * 0.3, w: clock.w + 2 * padX, h: clock.h * 1.6 });
  if (!clockZone) return null;
  // 1. Sans alphabet restreint : tesseract sépare les cases voisines
  //    (« 1ST 4:56 24 ») au lieu de tout coller (« 114:562 »).
  // 2. Le mot central (le chrono) est relu SEUL, recadré au plus près, avec
  //    l'alphabet des chiffres : mesuré sur une chaîne locale (police
  //    condensée), « 6:57 » lu « B:57 » / « G57 » / « §:57 » dans la zone
  //    devient « 6:57 » sur toutes les binarisations une fois isolé.
  const zones = await ocrLine(worker, png, W, H, clockZone, ch, ['gray', 'light'], '');
  const cx = (clock.x + clock.w / 2) * W;
  const tol = Math.max(clock.w * W * 0.6, ch * 1.2);
  const central = zones.flatMap((z) => z.words).filter((w) => Math.abs((w.x0 + w.x1) / 2 - cx) <= tol && w.y1 - w.y0 >= ch * 0.6);
  const values: number[] = [];
  if (central.length) {
    // Boîte à relire : un mot déjà lisible comme chrono s'il y en a un, sinon
    // les mots qui contiennent des chiffres, sinon tous les mots centraux.
    const parsed = central.filter((w) => clockFromSlotText(w.text) !== null);
    const digits = central.filter((w) => /\d/.test(w.text));
    const pool = parsed.length ? [parsed[0]] : digits.length ? digits : central;
    // Le mot déjà lisible compte pour deux voix : la relecture ne le contredit
    // que si elle est unanime.
    if (parsed.length) {
      const v0 = clockFromSlotText(parsed[0].text) as number;
      values.push(v0, v0);
    }
    const box = pool.reduce((a, b) => ({ ...a, x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }));
    const bh = box.y1 - box.y0;
    const tight = clip({ x: (box.x0 - 0.3 * bh) / W, y: (box.y0 - 0.2 * bh) / H, w: (box.x1 - box.x0 + 0.6 * bh) / W, h: (1.4 * bh) / H });
    const polarity = tight ? await clockPolarity(png, tight) : null;
    if (tight) {
      for (const z of await ocrLine(worker, png, W, H, tight, bh, polarity === 'sombre' ? ['dark', 'gray'] : polarity === 'clair' ? ['light', 'gray'] : REFINE_BINARIZATIONS, '0123456789:.')) {
        const v = clockFromSlotText(z.text);
        if (v !== null) values.push(v);
      }
    }
  }
  if (!values.length) for (const z of zones) {
    const v = clockFromZone(z, clock, W, H);
    if (v !== null) values.push(v);
  }
  if (!values.length) return null;
  // Vote : la valeur la plus lue ; à égalité, la première (ordre des binarisations).
  const clockSec = [...values].sort((a, b) => values.filter((x) => x === b).length - values.filter((x) => x === a).length)[0];

  // Période : place apprise, sinon à gauche du chrono, sinon dessous (moitié gauche).
  // `relaxed` : forme tronquée (« 4 », « 20 ») admise seulement dans une case
  // dédiée (apprise, ou sous le chrono) ; pas dans la large zone de gauche,
  // qui peut contenir un score se terminant par 0.
  // `bare` : suffixe seul (« ND ») admis — pas dans la zone sous le chrono, où
  // il peut venir d'un autre mot (« THURSDAY »).
  const periodZones: { key: string; r: Rect; relaxed: boolean; bare: boolean }[] = [];
  if (loc.period) periodZones.push({ key: 'appris', r: expand(loc.period, 0.35, 0.25), relaxed: true, bare: true });
  periodZones.push({ key: 'gauche', r: { x: clock.x - (4 * ch) / W, y: clock.y - clock.h * 0.25, w: (4 * ch) / W - clock.w * 0.05, h: clock.h * 1.5 }, relaxed: false, bare: true });
  periodZones.push({ key: 'dessous', r: { x: clock.x - clock.w * 0.15, y: clock.y + clock.h * 1.0, w: clock.w * 0.7, h: clock.h * 1.4 }, relaxed: true, bare: false });
  // La case qui a donné la période à l'image précédente est essayée d'abord
  // (la disposition ne change pas) : moins d'appels OCR par image.
  const hint = periodHint.get(loc);
  periodZones.sort((x, y) => Number(y.key === hint) - Number(x.key === hint));
  let period: number | null = null;
  for (const z of periodZones) {
    const r = clip(z.r);
    if (!r) continue;
    // Zone de gauche : texte épars sans alphabet restreint (mots séparés : « 14 »
    // et « 1ST », au lieu de « 14157 »), le mot le plus proche du chrono d'abord.
    for (const bin of ['gray', 'light'] as Binarization[]) {
      for (const t of await ocrLine(worker, png, W, H, r, ch * 0.55, [bin], z.relaxed ? OCR_WHITELIST : '', z.relaxed ? '7' : '11')) {
        if (!z.relaxed) t.words.sort((a, b) => b.x1 - a.x1);
        period = periodFromSlot(t.words, ch, z.relaxed, z.bare);
      }
      if (period !== null) break;
    }
    if (period !== null) {
      periodHint.set(loc, z.key);
      break;
    }
  }

  // Scores : nombres aux emplacements récurrents (une binarisation suffit le plus souvent).
  const scores: number[] = [];
  for (const sr of (loc.scores ?? []).slice(0, 3)) {
    const r = clip(expand(sr, 0.3, 0.3));
    if (!r) continue;
    for (const bin of ['light', 'gray'] as Binarization[]) {
      const [line] = await ocrLine(worker, png, W, H, r, sr.h * H, [bin], '0123456789');
      const nums = [...(line?.text ?? '').matchAll(/(?<!\d)\d{1,3}(?!\d)/g)].map((m) => Number(m[0])).filter((n) => n <= 199);
      if (nums.length) {
        scores.push(...nums);
        break;
      }
    }
  }
  return { period: period !== null && period > 4 && clockSec > 300 ? null : period, clock_sec: clockSec, scores };
}

function clip(r: Rect): Rect | null {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(1, r.x + r.w);
  const y1 = Math.min(1, r.y + r.h);
  return x1 - x0 > 0.002 && y1 - y0 > 0.002 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Lit (période, chrono, scores) sur une image.
 *
 * Avec une localisation : lecture « gabarit » case par case (voir
 * `readTemplate`) ; à défaut, la région du bandeau entière avec deux
 * binarisations fusionnées (texte sombre et texte clair), puis :
 *  - chrono sans deux-points (« 857 ») accepté à la place habituelle du chrono ;
 *  - période illisible : petits jetons voisins du chrono relus seuls, très
 *    agrandis, en mode « une ligne » avec l'alphabet des périodes.
 * Sans localisation : zones de repli en pleine largeur (plus lent).
 */
export async function readScoreboard(worker: OcrWorker, png: Buffer, loc: ScoreboardLocation | null): Promise<ScoreboardReading | null> {
  const size = pngSize(png);
  if (!size) return null;
  const { width: W, height: H } = size;
  if (!loc) {
    for (const zone of FALLBACK_ZONES) {
      const z = await ocrZoneMerged(worker, png, W, H, zone, Math.min(4, Math.max(1, 1440 / H)), ['lightHigh', 'gray', 'light']);
      // Sans localisation, seule une lecture complète (période + chrono) est
      // retenue : un chrono seul trouvé n'importe où dans une bande entière
      // est trop souvent un nombre parasite (« 2.0 » sur un panneau).
      const r = bestReading(findClockCandidates(z.words, W, H), null);
      if (r?.period) return r;
    }
    return null;
  }

  // 0. Le bandeau est-il à l'écran ? Comparaison à son empreinte (une vignette,
  //    quelques millisecondes) : évite toute lecture — et tout faux chrono —
  //    sur les gros plans, publicités et plateaux de mi-temps.
  if (loc.panel) {
    try {
      const thumb = await rawGray(png, THUMB_W, THUMB_H);
      if (panelPresence(thumb, loc.panel) < PANEL_MIN_PRESENCE) return null;
    } catch {
      /* vignette impossible : on tente la lecture */
    }
  }

  // 1. Gabarit appris à la localisation : chrono, période et scores relus à leur place.
  if (loc.clock) {
    const t = await readTemplate(worker, png, W, H, loc);
    if (t) return t;
  }

  // 2. Repli : la zone entière, en deux passes.
  const k = upscaleFor(loc.textH * H);
  // Avec un gabarit appris, ce repli sert surtout aux images SANS bandeau
  // (gros plans, pubs) : une seule passe, sans relecture, pour rester rapide.
  const z = await ocrZoneRefined(worker, png, W, H, loc.rect, k, { maxRefine: loc.clock ? 0 : 3 });
  const cands = findClockCandidates(z.words, W, H);
  let best = bestCandidate(cands, loc.core);
  let clockWord: { x0: number; y0: number; x1: number; y1: number } | null = best
    ? { x0: best.clockRect.x * W, y0: best.clockRect.y * H, x1: (best.clockRect.x + best.clockRect.w) * W, y1: (best.clockRect.y + best.clockRect.h) * H }
    : null;
  let reading: ScoreboardReading | null = best ? { period: best.period, clock_sec: best.clock_sec, scores: best.scores } : null;

  // Chrono sans deux-points, à la place du chrono.
  if (!reading && loc.clock) {
    for (const w of z.words) {
      if (!overlaps(w, loc.clock, W, H)) continue;
      const c = colonlessClock(w.text);
      if (c === null) continue;
      const near = findClockCandidates([{ ...w, text: `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}` }, ...z.words.filter((x) => x !== w)], W, H);
      best = near[0] ?? null;
      reading = best ? { period: best.period, clock_sec: c, scores: best.scores } : { period: null, clock_sec: c, scores: [] };
      clockWord = w;
      break;
    }
  }
  if (!reading) {
    const p = parseScoreboardText(z.text);
    return p ? { ...p, scores: [] } : null;
  }

  // Période illisible : relecture des petits jetons voisins du chrono.
  if (reading.period === null && clockWord) {
    const h = Math.max(1, clockWord.y1 - clockWord.y0);
    const cyc = (clockWord.y0 + clockWord.y1) / 2;
    const near = z.words
      .filter((w) => {
        if (w.x1 <= clockWord!.x0 - 4 * h || w.x0 >= clockWord!.x1 + 4 * h) return false;
        const wh = w.y1 - w.y0;
        if (wh < 0.4 * h || wh > 1.7 * h) return false;
        if (Math.abs((w.y0 + w.y1) / 2 - cyc) > 2.5 * h) return false;
        // Le chrono lui-même (lu par l'autre binarisation) est exclu.
        return !((w.x0 + w.x1) / 2 >= clockWord!.x0 && (w.x0 + w.x1) / 2 <= clockWord!.x1 && Math.abs((w.y0 + w.y1) / 2 - cyc) < 0.5 * h);
      })
      .sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - (clockWord!.x0 + clockWord!.x1) / 2, (a.y0 + a.y1) / 2 - cyc) - Math.hypot((b.x0 + b.x1) / 2 - (clockWord!.x0 + clockWord!.x1) / 2, (b.y0 + b.y1) / 2 - cyc));
    const tried: OcrWord[] = [];
    for (const w of near) {
      const direct = loosePeriod(w.text);
      if (direct !== null) {
        reading.period = direct;
        break;
      }
      if (tried.some((t) => Math.abs(t.x0 - w.x0) < h && Math.abs(t.y0 - w.y0) < h) || tried.length >= 3) continue;
      tried.push(w);
      const wh = w.y1 - w.y0;
      const pad = 0.35 * wh;
      const sub: Rect = { x: (w.x0 - pad) / W, y: (w.y0 - pad) / H, w: (w.x1 - w.x0 + 2 * pad) / W, h: (wh + 2 * pad) / H };
      for (const bin of ['gray', 'light'] as Binarization[]) {
        try {
          const r = await ocrZone(worker, png, W, H, sub, Math.min(8, Math.max(2, 46 / wh)), bin, { psm: '7', whitelist: OCR_WHITELIST });
          const p = loosePeriod(r.text);
          if (p !== null) {
            reading.period = p;
            break;
          }
        } catch {
          /* on passe */
        }
      }
      if (reading.period !== null) break;
    }
  }
  return reading;
}
