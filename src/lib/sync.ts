/**
 * Synchronisation VF ↔ vidéo.
 *
 * Problème : la vidéo (≈ 8033 s) est plus courte que le match réel (≈ 9826 s de
 * wallclock ESPN) car les replays coupent une partie des arrêts de jeu (pubs,
 * temps morts, mi-temps). Un mapping linéaire wallclock → vidéo dériverait donc de
 * plusieurs minutes. On procède ainsi :
 *
 * 1. Modèle de temps « compressible » : entre deux actions ESPN consécutives, le temps
 *    réel qui excède l'écoulement du chrono de jeu est du temps mort. Au-delà d'un
 *    seuil, ce temps mort est *compressible* (il a pu être coupé au montage). Le jeu
 *    vivant, lui, est toujours présent dans la vidéo à vitesse 1.
 * 2. Ancres `(période, chrono[, wallclock]) → video_ts` (manuelles, audio ou auto).
 *    Entre deux ancres, on interpole : le temps vivant défile à vitesse 1 et le temps
 *    compressible au taux ρ qui fait coïncider exactement les deux ancres.
 * 3. Détection audio : les coupures (énergie RMS très basse) sont alignées
 *    séquentiellement sur les arrêts de jeu ESPN, ce qui produit des ancres 'audio'
 *    et estime l'offset de démarrage (coup d'envoi) — voir `alignWithCuts`.
 * 4. Réglages manuels persistés (offset global + offset par quart) appliqués en dernier :
 *    l'utilisateur peut toujours recaler.
 */
import type { AnchorMethod, AnchorRow, CutInterval, SyncSettings } from './types';

export const REG_PERIOD_SEC = 720;
export const OT_PERIOD_SEC = 300;

export function periodLength(period: number): number {
  return period <= 4 ? REG_PERIOD_SEC : OT_PERIOD_SEC;
}

/** Secondes de jeu écoulées depuis le coup d'envoi. */
export function gameElapsed(period: number, clockSec: number): number {
  let t = 0;
  for (let p = 1; p < period; p++) t += periodLength(p);
  return t + (periodLength(period) - clockSec);
}

export interface TimedPlay {
  seq: number;
  period: number;
  clock_sec: number;
  wall: number; // epoch secondes
}

export interface Interval {
  start: number;
  end: number;
}

export interface BreakInfo {
  /** Zone compressible en wallclock (epoch s). */
  interval: Interval;
  before: TimedPlay;
  after: TimedPlay;
}

export function toTimedPlays(plays: { seq: number; period: number; clock_sec: number; wallclock: string }[]): TimedPlay[] {
  const out: TimedPlay[] = [];
  for (const p of [...plays].sort((a, b) => a.seq - b.seq)) {
    const w = Date.parse(p.wallclock);
    if (!Number.isFinite(w)) continue;
    out.push({ seq: p.seq, period: p.period, clock_sec: p.clock_sec, wall: w / 1000 });
  }
  // wallclock monotone (les saisies ESPN peuvent légèrement reculer)
  for (let i = 1; i < out.length; i++) if (out[i].wall < out[i - 1].wall) out[i].wall = out[i - 1].wall;
  return out;
}

export interface BreakOptions {
  /** Temps mort minimal (s) pour considérer une coupure possible. */
  minDead?: number;
  /** Secondes conservées après la dernière action avant la coupure. */
  keepAfter?: number;
  /** Secondes conservées avant la reprise. */
  keepBefore?: number;
}

export function findBreaks(tp: TimedPlay[], o: BreakOptions = {}): BreakInfo[] {
  const minDead = o.minDead ?? 60;
  const keepAfter = o.keepAfter ?? 8;
  const keepBefore = o.keepBefore ?? 8;
  const out: BreakInfo[] = [];
  for (let i = 1; i < tp.length; i++) {
    const a = tp[i - 1];
    const b = tp[i];
    const wallGap = b.wall - a.wall;
    const gameDelta = Math.max(0, gameElapsed(b.period, b.clock_sec) - gameElapsed(a.period, a.clock_sec));
    const dead = wallGap - gameDelta;
    if (dead < minDead) continue;
    const start = a.wall + keepAfter;
    const end = b.wall - gameDelta - keepBefore;
    if (end - start > 5) out.push({ interval: { start, end }, before: a, after: b });
  }
  return out;
}

/** Calcule le temps vivant / compressible entre deux instants wallclock. */
export class Timeline {
  constructor(private readonly breaks: Interval[]) {}

  comp(w1: number, w2: number): number {
    if (w2 <= w1) return 0;
    let c = 0;
    for (const b of this.breaks) {
      const s = Math.max(w1, b.start);
      const e = Math.min(w2, b.end);
      if (e > s) c += e - s;
    }
    return c;
  }

  live(w1: number, w2: number): number {
    if (w2 <= w1) return 0;
    return w2 - w1 - this.comp(w1, w2);
  }
}

export interface ResolvedAnchor {
  wall: number;
  video: number;
  method: AnchorMethod;
  period: number;
  clock_sec: number;
}

/** Retrouve l'instant wallclock correspondant à une ancre (période, chrono). */
export function resolveAnchorWall(a: Pick<AnchorRow, 'period' | 'clock_sec' | 'wallclock'>, tp: TimedPlay[]): number | null {
  if (a.wallclock) {
    const w = Date.parse(a.wallclock);
    if (Number.isFinite(w)) return w / 1000;
  }
  const same = tp.filter((p) => p.period === a.period && p.clock_sec === a.clock_sec);
  if (same.length) return same[0].wall;
  const inPeriod = tp.filter((p) => p.period === a.period);
  if (!inPeriod.length) return null;
  // avant = chrono plus grand (plus tôt), après = chrono plus petit
  let before: TimedPlay | undefined;
  let after: TimedPlay | undefined;
  for (const p of inPeriod) {
    if (p.clock_sec > a.clock_sec) before = p;
    else if (p.clock_sec < a.clock_sec && !after) after = p;
  }
  if (before && after) {
    const span = before.clock_sec - after.clock_sec;
    const f = span > 0 ? (before.clock_sec - a.clock_sec) / span : 0;
    return before.wall + f * (after.wall - before.wall);
  }
  if (before) return before.wall + (before.clock_sec - a.clock_sec);
  if (after) return after.wall - (a.clock_sec - after.clock_sec);
  return null;
}

const METHOD_PRIORITY: Record<AnchorMethod, number> = { manual: 3, auto: 2, audio: 1 };

/**
 * Garde un ensemble d'ancres strictement monotone.
 *
 * Priorité appliquée (voir `METHOD_PRIORITY`) : **manuel > auto (OCR) > audio**.
 * L'ancrage manuel prime, puis l'OCR du chrono à l'écran, et enfin la
 * détection de coupures audio, la moins précise des trois.
 */
export function consistentAnchors(anchors: ResolvedAnchor[]): ResolvedAnchor[] {
  const byPriority = [...anchors].sort((a, b) => METHOD_PRIORITY[b.method] - METHOD_PRIORITY[a.method] || a.wall - b.wall);
  const kept: ResolvedAnchor[] = [];
  for (const a of byPriority) {
    const ok = kept.every((k) => (a.wall === k.wall ? false : (a.wall - k.wall) * (a.video - k.video) > 0));
    if (ok) kept.push(a);
  }
  return kept.sort((a, b) => a.wall - b.wall);
}

export interface MappingOptions {
  videoDuration?: number | null;
  /** Taux de conservation des temps morts par défaut (0 = coupés, 1 = conservés). */
  defaultRho?: number;
  postroll?: number;
  maxPreroll?: number;
}

export interface Mapping {
  map: (wall: number) => number;
  anchors: ResolvedAnchor[];
  defaultRho: number;
}

/** Estimation sans ancre : offset de départ et ρ déduits de la durée vidéo. */
export function estimateStart(tp: TimedPlay[], tl: Timeline, o: MappingOptions = {}): { v0: number; rho: number } {
  const rho0 = o.defaultRho ?? 0.3;
  const D = o.videoDuration ?? 0;
  if (!tp.length || !D) return { v0: 0, rho: rho0 };
  const post = o.postroll ?? 120;
  const maxPre = o.maxPreroll ?? 900;
  const w0 = tp[0].wall;
  const wEnd = tp[tp.length - 1].wall;
  const L = tl.live(w0, wEnd);
  const K = tl.comp(w0, wEnd);
  let rho = rho0;
  let v0 = D - post - (L + rho * K);
  if (v0 < 0 || v0 > maxPre) {
    const target = v0 < 0 ? 0 : maxPre;
    rho = K > 0 ? Math.min(1, Math.max(0, (D - post - target - L) / K)) : rho0;
    v0 = Math.min(maxPre, Math.max(0, D - post - (L + rho * K)));
  }
  return { v0, rho };
}

export function buildMapping(tp: TimedPlay[], breaks: BreakInfo[], anchorsIn: ResolvedAnchor[], o: MappingOptions = {}): Mapping {
  const tl = new Timeline(breaks.map((b) => b.interval));
  let anchors = consistentAnchors(anchorsIn);
  let defaultRho = o.defaultRho ?? 0.3;

  if (!anchors.length) {
    const est = estimateStart(tp, tl, o);
    defaultRho = est.rho;
    const first = tp[0];
    anchors = first ? [{ wall: first.wall, video: est.v0, method: 'auto', period: first.period, clock_sec: first.clock_sec }] : [];
  }

  // Taux par segment entre ancres
  interface Seg {
    a: ResolvedAnchor;
    sigma: number;
    rho: number;
  }
  const segs: Seg[] = [];
  let kSum = 0;
  let rhoK = 0;
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const dv = b.video - a.video;
    const L = tl.live(a.wall, b.wall);
    const K = tl.comp(a.wall, b.wall);
    let sigma = 1;
    let rho: number;
    if (K <= 0) {
      rho = 0;
      sigma = L > 0 ? dv / L : 1;
    } else if (dv < L) {
      rho = 0;
      sigma = L > 0 ? dv / L : 1;
    } else if (dv > L + K) {
      rho = 1;
      sigma = L > 0 ? (dv - K) / L : 1;
    } else {
      rho = (dv - L) / K;
    }
    segs.push({ a, sigma, rho });
    if (K > 0) {
      kSum += K;
      rhoK += rho * K;
    }
  }
  if (kSum > 0 && anchors.length >= 2) defaultRho = Math.min(1, Math.max(0, rhoK / kSum));

  const map = (w: number): number => {
    if (!anchors.length) return 0;
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (w <= first.wall) return first.video - tl.live(w, first.wall) - defaultRho * tl.comp(w, first.wall);
    if (w >= last.wall) return last.video + tl.live(last.wall, w) + defaultRho * tl.comp(last.wall, w);
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].a.wall <= w) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.a.video + s.sigma * tl.live(s.a.wall, w) + s.rho * tl.comp(s.a.wall, w);
  };

  return { map, anchors, defaultRho };
}

// ------------------------------------------------------------------ alignement audio

export interface AlignOptions {
  tolerance?: number;
  maxPreroll?: number;
  step?: number;
  rhoPrior?: number;
  minMatches?: number;
}

export interface AlignResult {
  v0: number;
  score: number;
  matched: { breakIndex: number; cut: CutInterval }[];
  anchors: ResolvedAnchor[];
}

/**
 * Aligne les coupures audio détectées dans la vidéo sur les arrêts de jeu ESPN.
 *
 * Le jeu vivant défile à vitesse 1 dans la vidéo : depuis la dernière ancre connue,
 * le début de la prochaine coupure est donc très prévisible. On balaie l'offset de
 * départ v0 (coup d'envoi dans la vidéo) et, pour chacun, on apparie
 * séquentiellement les arrêts de jeu aux coupures ; on retient le v0 qui maximise
 * le score d'appariement. Chaque appariement fournit une ancre « reprise du jeu ».
 */
export function alignWithCuts(
  tp: TimedPlay[],
  breaks: BreakInfo[],
  cuts: CutInterval[],
  videoDuration: number,
  o: AlignOptions = {},
): AlignResult | null {
  if (!tp.length || !cuts.length) return null;
  const tol = o.tolerance ?? 12;
  const maxPre = Math.min(o.maxPreroll ?? 900, Math.max(0, videoDuration - 60));
  const step = o.step ?? 1;
  const rhoPrior = o.rhoPrior ?? 0.3;
  const tl = new Timeline(breaks.map((b) => b.interval));
  const w0 = tp[0].wall;
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);

  let best: AlignResult | null = null;
  for (let v0 = 0; v0 <= maxPre; v0 += step) {
    let lastWall = w0;
    let lastVideo = v0;
    let score = 0;
    const matched: { breakIndex: number; cut: CutInterval }[] = [];
    let cutIdx = 0;
    for (let bi = 0; bi < breaks.length; bi++) {
      const b = breaks[bi];
      const live = tl.live(lastWall, b.interval.start);
      const comp = tl.comp(lastWall, b.interval.start);
      const sMin = lastVideo + live;
      const sMax = sMin + comp;
      const expected = sMin + rhoPrior * comp;
      const lo = sMin - tol;
      const hi = sMax + tol;
      while (cutIdx < sortedCuts.length && sortedCuts[cutIdx].start < lo) cutIdx++;
      let pick = -1;
      let pickD = Infinity;
      for (let j = cutIdx; j < sortedCuts.length && sortedCuts[j].start <= hi; j++) {
        const c = sortedCuts[j];
        const breakLen = b.interval.end - b.interval.start;
        if (c.end - c.start > breakLen + tol) continue;
        const d = Math.abs(c.start - expected);
        if (d < pickD) {
          pickD = d;
          pick = j;
        }
      }
      if (pick >= 0) {
        const c = sortedCuts[pick];
        const spread = tol + (sMax - sMin);
        score += 1 - Math.min(1, Math.abs(c.start - expected) / (spread * 2));
        matched.push({ breakIndex: bi, cut: c });
        lastWall = b.interval.end;
        lastVideo = c.end;
        cutIdx = pick + 1;
      }
    }
    if (!best || score > best.score + 1e-9) best = { v0, score, matched, anchors: [] };
  }
  if (!best) return null;
  const minMatches = o.minMatches ?? Math.max(3, Math.ceil(breaks.length * 0.25));
  if (best.matched.length < minMatches) return null;

  const first = tp[0];
  const anchors: ResolvedAnchor[] = [{ wall: first.wall, video: best.v0, method: 'audio', period: first.period, clock_sec: first.clock_sec }];
  for (const m of best.matched) {
    const b = breaks[m.breakIndex];
    // Reprise : fin de la coupure ↔ fin de la zone compressible ; l'action suivante est ensuite à vitesse 1.
    anchors.push({
      wall: b.after.wall,
      video: m.cut.end + (b.after.wall - b.interval.end),
      method: 'audio',
      period: b.after.period,
      clock_sec: b.after.clock_sec,
    });
  }
  best.anchors = anchors;
  return best;
}

// ------------------------------------------------------------------ sous-titres

export interface TimedLine {
  seq: number;
  period: number;
  wallclock: string;
  hold: number;
}

export function applyOffsets(ts: number, period: number, s: Pick<SyncSettings, 'global_offset' | 'quarter_offsets'>): number {
  return ts + (s.global_offset || 0) + (Number(s.quarter_offsets?.[String(period)]) || 0);
}

/** Calcule video_ts / end_ts pour chaque ligne, triés par video_ts. */
export function timeLines<T extends TimedLine>(
  lines: T[],
  mapping: Mapping,
  settings: Pick<SyncSettings, 'global_offset' | 'quarter_offsets'>,
  videoDuration?: number | null,
): (T & { video_ts: number; end_ts: number })[] {
  const timed = lines.map((l) => {
    const w = Date.parse(l.wallclock) / 1000;
    let ts = applyOffsets(mapping.map(w), l.period, settings);
    if (!Number.isFinite(ts)) ts = 0;
    ts = Math.max(0, videoDuration ? Math.min(ts, videoDuration) : ts);
    return { ...l, video_ts: Math.round(ts * 100) / 100, end_ts: 0 };
  });
  timed.sort((a, b) => a.video_ts - b.video_ts || a.seq - b.seq);
  for (let i = 0; i < timed.length; i++) {
    const next = timed[i + 1]?.video_ts ?? Infinity;
    const end = Math.min(timed[i].video_ts + timed[i].hold, Math.max(timed[i].video_ts + 0.8, next - 0.05));
    timed[i].end_ts = Math.round(end * 100) / 100;
  }
  return timed;
}
