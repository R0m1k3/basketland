/**
 * Phase A de la synchro : lecture du chrono de jeu affiché à l'écran (OCR).
 *
 * On extrait des images de la vidéo à intervalle régulier (ffmpeg, flux HLS 720p),
 * on isole le bandeau de score (bas-centre de l'image), on le binarise de plusieurs
 * façons et on le lit avec tesseract.js (WASM, pas de dépendance système). Chaque
 * lecture « période + chrono » donne une observation (video_ts, période, chrono).
 *
 * Les lectures OCR sont bruitées : `selectConsistentObservations` ne garde que la plus
 * longue chaîne d'observations compatible avec le modèle physique (le jeu vivant n'est
 * jamais coupé, seuls les temps morts peuvent l'être).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gameElapsed, resolveAnchorWall, Timeline, type BreakInfo, type ResolvedAnchor, type TimedPlay } from './sync';

export interface ClockReading {
  period: number | null;
  clock_sec: number;
}

const PERIOD_RE = /\b(1ST|2ND|3RD|4TH|OT\d?|[1-4](?:ST|ND|RD|TH))\b/;

function periodFromToken(tok: string): number | null {
  const t = tok.toUpperCase();
  if (t.startsWith('OT')) return 4 + (Number(t.slice(2)) || 1);
  const n = Number(t[0]);
  return n >= 1 && n <= 4 ? n : null;
}

/**
 * Extrait (période, chrono) d'un texte OCR de bandeau de score.
 * Accepte '8:41 1ST', '1ST 8:41', '42.8 4TH' (dernière minute en dixièmes).
 * Rejette les motifs de bilan ('2-0') et les valeurs impossibles.
 */
export function parseScoreboardText(text: string): ClockReading | null {
  const t = text.toUpperCase().replace(/[|]/g, ' ').replace(/\s+/g, ' ');
  const periodTok = t.match(PERIOD_RE)?.[1] ?? null;
  const period = periodTok ? periodFromToken(periodTok) : null;
  const candidates: number[] = [];
  for (const m of t.matchAll(/(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])/g)) {
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    if (mm <= 12 && ss < 60 && !(mm === 12 && ss > 0)) candidates.push(mm * 60 + ss);
  }
  if (!candidates.length) {
    for (const m of t.matchAll(/(?<![\d:.])(\d{1,2})\.(\d)(?![\d.])/g)) {
      const s = Number(m[1]);
      if (s < 60) candidates.push(Math.round(s + Number(m[2]) / 10));
    }
  }
  if (!candidates.length) return null;
  // Le chrono est le plus souvent la seule valeur mm:ss du bandeau ; sinon on prend la plus plausible.
  const clock = candidates[0];
  if (period !== null && period > 4 && clock > 300) return null;
  return { period, clock_sec: clock };
}

export interface FrameObservation {
  video_ts: number;
  period: number | null;
  clock_sec: number;
}

export interface ConsistencyOptions {
  /** Tolérance (s) sur les écarts vidéo/réel entre deux observations. */
  tolerance?: number;
}

/**
 * Plus longue chaîne d'observations cohérentes (programmation dynamique O(n²)).
 * Entre deux observations i<j : Δvidéo ∈ [temps vivant − tol, temps vivant + temps compressible + tol].
 * Les observations sans période sont résolues sur les périodes candidates.
 */
export function selectConsistentObservations(
  obs: FrameObservation[],
  tp: TimedPlay[],
  breaks: BreakInfo[],
  o: ConsistencyOptions = {},
): ResolvedAnchor[] {
  const tol = o.tolerance ?? 15;
  const tl = new Timeline(breaks.map((b) => b.interval));
  const maxPeriod = tp.reduce((m, p) => Math.max(m, p.period), 0);
  // Développe les observations en candidats (période connue ou hypothèses 1..maxPeriod).
  const cands: ResolvedAnchor[] = [];
  for (const ob of [...obs].sort((a, b) => a.video_ts - b.video_ts)) {
    const periods = ob.period ? [ob.period] : Array.from({ length: maxPeriod }, (_, i) => i + 1);
    for (const p of periods) {
      if (p > maxPeriod) continue;
      if (ob.clock_sec > (p <= 4 ? 720 : 300)) continue;
      const w = resolveAnchorWall({ period: p, clock_sec: ob.clock_sec, wallclock: null }, tp);
      if (w === null) continue;
      cands.push({ wall: w, video: ob.video_ts, method: 'auto', period: p, clock_sec: ob.clock_sec });
    }
  }
  const n = cands.length;
  if (!n) return [];
  const score = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  const strong = (a: ResolvedAnchor) => obs.some((x) => x.video_ts === a.video && x.period === a.period);
  for (let j = 0; j < n; j++) {
    const base = strong(cands[j]) ? 1 : 0.6;
    score[j] = base;
    for (let i = 0; i < j; i++) {
      const a = cands[i];
      const b = cands[j];
      if (b.video <= a.video || b.wall <= a.wall) continue;
      if (gameElapsed(b.period, b.clock_sec) < gameElapsed(a.period, a.clock_sec)) continue;
      const dv = b.video - a.video;
      const live = tl.live(a.wall, b.wall);
      const comp = tl.comp(a.wall, b.wall);
      if (dv < live - tol || dv > live + comp + tol) continue;
      if (score[i] + base > score[j]) {
        score[j] = score[i] + base;
        prev[j] = i;
      }
    }
  }
  let best = 0;
  for (let j = 1; j < n; j++) if (score[j] > score[best]) best = j;
  const chain: ResolvedAnchor[] = [];
  for (let k = best; k >= 0; k = prev[k]) chain.push(cands[k]);
  chain.reverse();
  // Une seule observation par instant vidéo (les hypothèses de période sont exclusives).
  return chain.filter((a, i) => i === 0 || a.video !== chain[i - 1].video);
}

// ------------------------------------------------------------------ extraction d'images + OCR

/** Bandeau bas-centre, agrandi ×3, plusieurs binarisations (texte clair sur fond sombre et inverse). */
export const OCR_FILTERS = [
  "crop=iw*0.5:ih*0.16:iw*0.25:ih*0.82,scale=iw*3:-1,format=gray,lutyuv=y='if(gt(val,185),0,255)'",
  'crop=iw*0.5:ih*0.16:iw*0.25:ih*0.82,scale=iw*3:-1,format=gray,negate',
  "crop=iw*0.5:ih*0.16:iw*0.25:ih*0.82,scale=iw*4:-1,format=gray,lutyuv=y='if(gt(val,210),0,255)'",
];

export interface FrameGrabOptions {
  userAgent: string;
  referer: string;
}

/** Extrait une image (PNG, format brut) à l'instant `t` d'un flux HLS. */
export function grabFrame(playlistUrl: string, t: number, o: FrameGrabOptions, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-user_agent',
        o.userAgent,
        '-headers',
        `Referer: ${o.referer}\r\n`,
        '-ss',
        String(t),
        '-i',
        playlistUrl,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => ff.kill('SIGKILL'), timeoutMs);
    ff.stdout.on('data', (b: Buffer) => chunks.push(b));
    ff.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-500)));
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length) resolve(buf);
      else reject(new Error(`ffmpeg frame @${t}s code ${code}: ${err}`));
    });
  });
}

/** Applique un filtre ffmpeg à une image PNG en mémoire. */
export function filterImage(png: Buffer, vf: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', vf, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (b: Buffer) => chunks.push(b));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg filtre code ${code}`))));
    ff.stdin.end(png);
  });
}

interface OcrWorker {
  recognize(img: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

const nodeRequire = createRequire(import.meta.url);

export async function createOcrWorker(): Promise<OcrWorker> {
  const { createWorker } = nodeRequire('tesseract.js') as typeof import('tesseract.js');
  const langPath = path.join(path.dirname(nodeRequire.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  await worker.setParameters({
    tessedit_pageseg_mode: '11' as never,
    tessedit_char_whitelist: '0123456789:.STNDRHO',
  });
  return worker as unknown as OcrWorker;
}

/** Lit le chrono sur une image (plusieurs binarisations, première lecture valide). */
export async function readClockFromFrame(worker: OcrWorker, png: Buffer): Promise<ClockReading | null> {
  let fallback: ClockReading | null = null;
  for (const vf of OCR_FILTERS) {
    const img = await filterImage(png, vf);
    const { data } = await worker.recognize(img);
    const r = parseScoreboardText(data.text);
    if (r?.period) return r;
    if (r && !fallback) fallback = r;
  }
  return fallback;
}

export interface OcrScanOptions extends FrameGrabOptions {
  duration: number;
  stepSec?: number;
  startSec?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Balaye la vidéo et renvoie les observations OCR brutes. */
export async function scanVideoClock(playlistUrl: string, o: OcrScanOptions): Promise<FrameObservation[]> {
  const step = o.stepSec ?? 60;
  const times: number[] = [];
  for (let t = o.startSec ?? 30; t < o.duration - 5; t += step) times.push(Math.round(t));
  const worker = await createOcrWorker();
  const out: FrameObservation[] = [];
  try {
    let done = 0;
    for (const t of times) {
      try {
        const frame = await grabFrame(playlistUrl, t, o);
        const r = await readClockFromFrame(worker, frame);
        if (r) out.push({ video_ts: t, period: r.period, clock_sec: r.clock_sec });
      } catch {
        /* image illisible ou segment indisponible : on continue */
      }
      o.onProgress?.(++done, times.length);
    }
  } finally {
    await worker.terminate();
  }
  return out;
}
