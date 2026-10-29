/**
 * Balayage de la vidéo pour la synchro (Phase A) : localisation du bandeau,
 * passe grossière puis affinage ciblé.
 *
 * 1. Localisation : 10 images réparties sur la vidéo → région du bandeau
 *    (`scoreboard.ts`). Les lectures de ces images servent aussi d'observations.
 * 2. Passe grossière : une image toutes les ~105 s, lecture de la seule région.
 * 3. Affinage (2 tours au plus) : là où les ancres manquent (quart-temps sans
 *    ancre, grand trou entre deux ancres) ou se contredisent (lecture fiable
 *    rejetée par la chaîne cohérente), on resserre le pas (~30 s).
 *
 * But : au moins une ancre fiable par quart-temps. La vidéo est plus courte que
 * le match réel (pubs coupées) : une seule ancre ne suffit pas à caler tout le
 * replay.
 */
import { buildMapping, type BreakInfo, type ResolvedAnchor, type TimedPlay } from './sync';
import { createOcrWorker, selectConsistentObservations, type FrameObservation, type OcrWorker, type ScorePoint } from './ocr';
import { locateScoreboard, readScoreboard, type LocateResult, type ScoreboardLocation, type ScoreboardReading } from './scoreboard';

// ------------------------------------------------------------------ planification (pure)

/** Instants (s) répartis uniformément dans [from, to], bornes comprises si n ≥ 2. */
export function spread(from: number, to: number, n: number): number[] {
  if (n <= 0 || to < from) return [];
  if (n === 1) return [Math.round((from + to) / 2)];
  return Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * i) / (n - 1)));
}

/** Pas de balayage borné ET fini (une valeur NaN, nulle ou minuscule ferait exploser le coût). */
export function safeStep(raw: unknown, def: number, min = 10): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.trunc(n)) : def;
}

/** Passe grossière : un instant tous les `step` s, en évitant ceux déjà lus. */
export function coarseTimes(duration: number, step: number, already: number[] = [], start = 30): number[] {
  const out: number[] = [];
  for (let t = start; t < duration - 5; t += step) {
    const r = Math.round(t);
    if (!already.some((a) => Math.abs(a - r) < step / 4)) out.push(r);
  }
  return out;
}

export interface RefinementInput {
  anchors: ResolvedAnchor[];
  observations: FrameObservation[];
  /** Instants vidéo déjà lus (réussis ou non). */
  scanned: number[];
  duration: number;
  tp: TimedPlay[];
  breaks: BreakInfo[];
}

export interface RefinementOptions {
  fineStep?: number;
  /** Images au plus par fenêtre (quart-temps manquant). */
  perWindow?: number;
  /** Budget total d'images de ce tour. */
  maxFrames?: number;
  /** Trou vidéo (s) entre deux ancres au-delà duquel on resserre. */
  maxGap?: number;
}

/**
 * Instants à relire pour compléter les ancres.
 *
 * - Quart-temps sans ancre : on estime sa fenêtre vidéo avec le mapping courant
 *   (ancres déjà trouvées, sinon estimation par la durée — d'où une marge plus
 *   large) et on y place des images au pas fin.
 * - Trou de plus de `maxGap` s entre deux ancres consécutives : quelques images.
 * - Lecture fiable (période lue) rejetée par la chaîne : deux images à ±pas fin
 *   pour départager.
 */
export function planRefinement(p: RefinementInput, o: RefinementOptions = {}): number[] {
  const fine = o.fineStep ?? 30;
  const perWindow = o.perWindow ?? 10;
  const maxFrames = o.maxFrames ?? 40;
  const maxGap = o.maxGap ?? 1500;
  const D = p.duration;
  if (!p.tp.length || D <= 0) return [];
  const isFree = (t: number, chosen: number[]) =>
    t >= 0 && t < D - 5 && !p.scanned.some((s) => Math.abs(s - t) < fine / 2) && !chosen.some((s) => Math.abs(s - t) < fine / 2);
  const out: number[] = [];
  const add = (times: number[], cap: number) => {
    let n = 0;
    for (const t of times) {
      if (n >= cap || out.length >= maxFrames) break;
      if (isFree(t, out)) {
        out.push(t);
        n++;
      }
    }
  };

  const mapping = buildMapping(p.tp, p.breaks, p.anchors, { videoDuration: D });
  const margin = p.anchors.length ? 90 : 300;
  const periods = [...new Set(p.tp.map((x) => x.period))].sort((a, b) => a - b);
  const covered = new Set(p.anchors.map((a) => a.period));
  for (const period of periods) {
    if (covered.has(period)) continue;
    const plays = p.tp.filter((x) => x.period === period);
    const vs = Math.max(0, mapping.map(plays[0].wall) - margin);
    const ve = Math.min(D - 5, mapping.map(plays[plays.length - 1].wall) + margin);
    if (ve <= vs) continue;
    const n = Math.max(1, Math.min(perWindow, Math.floor((ve - vs) / fine) + 1));
    // Ordre « milieu d'abord » : si le budget est court, on couvre le cœur du quart.
    const times = spread(vs, ve, n).sort((a, b) => Math.abs(a - (vs + ve) / 2) - Math.abs(b - (vs + ve) / 2));
    add(times, perWindow);
  }

  const anchors = [...p.anchors].sort((a, b) => a.video - b.video);
  for (let i = 0; i + 1 < anchors.length; i++) {
    const gap = anchors[i + 1].video - anchors[i].video;
    if (gap <= maxGap) continue;
    const n = Math.min(6, Math.floor(gap / Math.max(fine, gap / 8)));
    add(spread(anchors[i].video + fine, anchors[i + 1].video - fine, n), 6);
  }

  const inChain = new Set(p.anchors.map((a) => a.video));
  const rejected = p.observations.filter((x) => x.period !== null && !inChain.has(x.video_ts));
  add(rejected.flatMap((x) => [x.video_ts - fine, x.video_ts + fine]), 8);

  return out.sort((a, b) => a - b);
}

/** Nombre d'ancres par période. */
export function anchorsPerPeriod(anchors: ResolvedAnchor[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const a of anchors) out[a.period] = (out[a.period] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ balayage (ffmpeg + OCR)

export type ScanPhase = 'localisation' | 'balayage' | 'affinage';

export interface ScanOptions {
  duration: number;
  tp: TimedPlay[];
  breaks: BreakInfo[];
  scores?: ScorePoint[];
  /** Extraction d'une image à l'instant t (ffmpeg sur la source choisie). */
  grab: (t: number) => Promise<Buffer>;
  /** Localisation déjà connue (cache par vidéo) : la phase de localisation est sautée. */
  location?: ScoreboardLocation | null;
  /** Pas de la passe grossière (s), 105 par défaut. */
  stepSec?: number;
  /** Images échantillons pour la localisation. */
  sampleFrames?: number;
  /** Tours d'affinage au plus. */
  refineRounds?: number;
  onProgress?: (phase: ScanPhase, done: number, total: number) => void;
  /** Injection pour les tests. */
  worker?: OcrWorker;
  read?: (png: Buffer, loc: ScoreboardLocation | null) => Promise<ScoreboardReading | null>;
  locate?: (frames: Buffer[]) => Promise<LocateResult>;
}

export interface ScanResult {
  observations: FrameObservation[];
  anchors: ResolvedAnchor[];
  location: ScoreboardLocation | null;
  /** La localisation vient-elle du cache ? */
  cachedLocation: boolean;
  framesRead: number;
  elapsedMs: number;
  perPeriod: Record<number, number>;
}

export async function scanVideo(o: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const D = o.duration;
  const step = safeStep(o.stepSec, 105, 20);
  const worker = o.worker ?? (await createOcrWorker());
  const read = o.read ?? ((png: Buffer, loc: ScoreboardLocation | null) => readScoreboard(worker, png, loc));
  const observations: FrameObservation[] = [];
  const scanned: number[] = [];
  let location = o.location ?? null;
  const cachedLocation = !!location;
  let framesRead = 0;
  const consistent = () => selectConsistentObservations(observations, o.tp, o.breaks, { scores: o.scores });

  const readAt = async (times: number[], phase: ScanPhase) => {
    let done = 0;
    for (const t of times) {
      scanned.push(t);
      try {
        const png = await o.grab(t);
        framesRead++;
        const r = await read(png, location);
        if (r) observations.push({ video_ts: t, period: r.period, clock_sec: r.clock_sec, scores: r.scores });
      } catch {
        /* segment indisponible ou image illisible : on continue */
      }
      o.onProgress?.(phase, ++done, times.length);
    }
  };

  try {
    // 1. Localisation sur des images échantillons.
    const localize = async () => {
      const n = Math.max(1, Math.trunc(o.sampleFrames ?? 10));
      const sampleTimes = spread(D * 0.06, D * 0.94, n);
      const frames: Buffer[] = [];
      const frameTimes: number[] = [];
      let done = 0;
      for (const t of sampleTimes) {
        scanned.push(t);
        try {
          frames.push(await o.grab(t));
          frameTimes.push(t);
          framesRead++;
        } catch {
          /* on continue avec les autres images */
        }
        o.onProgress?.('localisation', ++done, sampleTimes.length * 2);
      }
      const loc = o.locate ? await o.locate(frames) : await locateScoreboard(worker, frames, {
        onProgress: (d, tot) => o.onProgress?.('localisation', sampleTimes.length + Math.round((d / Math.max(1, tot)) * sampleTimes.length), sampleTimes.length * 2),
      });
      location = loc.location;
      loc.readings.forEach((r, i) => {
        if (r) observations.push({ video_ts: frameTimes[i], period: r.period, clock_sec: r.clock_sec, scores: r.scores });
      });
    };
    if (!location && D > 60) await localize();

    // 2. Passe grossière.
    const coarse = coarseTimes(D, step, scanned);
    await readAt(coarse, 'balayage');
    // Localisation en cache qui ne lit (presque) rien : l'habillage a changé
    // (autre diffuseur pour la même vidéo ?) — on relocalise et on relit.
    if (cachedLocation && observations.length < 3 && D > 60) {
      location = null;
      observations.length = 0;
      await localize();
      if (location) await readAt(coarse, 'balayage');
    }

    // 3. Affinage ciblé.
    const rounds = Math.max(0, Math.trunc(o.refineRounds ?? 2));
    for (let r = 0; r < rounds; r++) {
      const anchors = consistent();
      const plan = planRefinement({ anchors, observations, scanned, duration: D, tp: o.tp, breaks: o.breaks });
      if (!plan.length) break;
      await readAt(plan, 'affinage');
    }
  } finally {
    if (!o.worker) await worker.terminate();
  }
  const anchors = consistent();
  return {
    observations,
    anchors,
    location,
    cachedLocation,
    framesRead,
    elapsedMs: Date.now() - t0,
    perPeriod: anchorsPerPeriod(anchors),
  };
}
