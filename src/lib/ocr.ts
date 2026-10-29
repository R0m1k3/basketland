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

/**
 * Période lue telle quelle, avec frontières de mot : "2ND", "4TH".
 * Le bord droit évite "1STX".
 */
const PERIOD_STRICT_RE = /\b(1ST|2ND|3RD|4TH)\b/;

/**
 * Période collée au shot clock, sans séparateur : "2ND24", "1ST08".
 * Le bord droit garantit qu'on ne colle pas la période au texte qui suit.
 */
const PERIOD_COLLED_RE = /(1ST|2ND|3RD|4TH)(?![A-Z])/;

/**
 * Prolongation : uniquement si le mot est isolé. Sur le bandeau NBC, "OT7THH"
 * est du bruit de lecture d'un "3RD" mal reconnu : sans frontière de mot,
 * on l'accepterait à tort et on attribuerait une 5e période à un match normal.
 */
const PERIOD_OT_RE = /\bOT(\d?)\b/;

/**
 * Confusions observées avec tesseract.js sur le bandeau NBC :
 * le D de "3RD" est souvent lu O, le D de "2ND" lu O ou 0.
 * Listes explicites : aucune autre approximation n'est acceptée.
 */
const PERIOD_VARIANTS: Array<[RegExp, number]> = [
  [/1ST/, 1],
  [/2ND/, 2],
  [/3RD/, 3],
  [/4TH/, 4],
  [/1S7/, 1],
  [/2NO/, 2],
  [/2N0/, 2],
  [/3RO/, 3],
  [/3R0/, 3],
  [/4T4/, 4],
];

function periodFromToken(tok: string): number | null {
  const t = tok.toUpperCase();
  if (t.startsWith('OT')) return 4 + (Number(t.slice(2)) || 1);
  const n = Number(t[0]);
  return n >= 1 && n <= 4 ? n : null;
}

/**
 * Extrait (période, chrono) d'un texte OCR de bandeau de score.
 * Accepte '8:41 1ST', '1ST 8:41', '42.8 4TH' (dernière minute en dixièmes).
 * Accepte aussi la forme collée du diffuseur NBC : '1:24 65 2ND24' (le shot
 * clock suit la période sans séparateur).
 * Rejette les motifs de bilan ('2-0') et les valeurs impossibles.
 */
export function parseScoreboardText(text: string): ClockReading | null {
  const t = text.toUpperCase().replace(/[|]/g, ' ').replace(/\s+/g, ' ');
  // Période : forme classique (frontières de mot), puis forme collée au shot
  // clock ("2ND24"), puis confusions OCR ("3RO"). La prolongation n'est retenue
  // que si le mot est isolé, pour ne pas confondre un "3RD" mal lu avec un OT.
  let period: number | null = null;
  const strict = t.match(PERIOD_STRICT_RE)?.[1] ?? t.match(PERIOD_COLLED_RE)?.[1] ?? null;
  if (strict) period = periodFromToken(strict);
  if (period === null) {
    for (const [re, value] of PERIOD_VARIANTS) {
      if (re.test(t)) {
        period = value;
        break;
      }
    }
  }
  if (period === null) {
    const ot = t.match(PERIOD_OT_RE);
    if (ot) period = 4 + (Number(ot[1]) || 1);
  }
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

/**
 * Zone de lecture du chrono, dans le bandeau NBC (relevé sur image 1280x720).
 *
 * Le bandeau complet (x 25 %-75 %, y 82 %-98 %) contient trop d'éléments :
 * l'OCR mélange alors le score, le chrono et le shot clock ("165 / 28. 651").
 * En resserrant sur le bloc chrono + période + shot clock (x 42 %-57 %,
 * y 82,5 %-95,5 %), tesseract.js lit proprement "1:24 65 2ND24".
 *
 * On garde trois binarisations : le texte du diffuseur est clair sur fond
 * sombre, mais selon le cadrage et la compression l'inverse peut être net.
 */
export const OCR_FILTERS = [
  // texte clair sur fond sombre -> noir sur blanc, agrandissement ×3
  "crop=iw*0.15:ih*0.13:iw*0.42:ih*0.825,scale=iw*6:-1,format=gray,lutyuv=y='if(gt(val,185),0,255)'",
  // idem, seuillage plus agressif
  "crop=iw*0.15:ih*0.13:iw*0.42:ih*0.825,scale=iw*6:-1,format=gray,lutyuv=y='if(gt(val,210),0,255)'",
  // version inversée (au cas où le bandeau serait clair sur fond sombre)
  'crop=iw*0.15:ih*0.13:iw*0.42:ih*0.825,scale=iw*6:-1,format=gray,negate',
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

/**
 * Applique un filtre ffmpeg à une image PNG en mémoire.
 *
 * Timeout obligatoire : sans lui, un ffmpeg bloqué garderait le slot
 * d'analyse occupé indéfiniment (`analysis.delete` n'est jamais atteint) et
 * empêcherait toute nouvelle analyse jusqu'au redémarrage du conteneur.
 */
export function filterImage(png: Buffer, vf: string, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', vf, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ff.kill('SIGKILL');
      reject(new Error(`ffmpeg filtre : timeout ${timeoutMs} ms`));
    }, timeoutMs);
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    ff.stdout.on('data', (b: Buffer) => chunks.push(b));
    ff.on('error', (e) => done(() => reject(e)));
    ff.on('close', (code) =>
      done(() =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`ffmpeg filtre code ${code}`)),
      ),
    );
    ff.stdin.on('error', () => {
      /* le processus peut avoir déjà été tué : la gestion est faite par close */
    });
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

/**
 * Balaye la vidéo et renvoie les observations OCR brutes.
 *
 * L'URL signée est résolue une seule fois pour tout le balayage : mesuré sur
 * ok.ru, la signature vit ~24 h, alors qu'un scan complet prend 30 à 60 min.
 * Aucune re-résolution n'est donc nécessaire en cours de route. Si un jour la
 * durée de vie de la signature diminue, il faudra re-résoudre la playlist
 * toutes les N frames.
 */
export async function scanVideoClock(playlistUrl: string, o: OcrScanOptions): Promise<FrameObservation[]> {
  // Pas minimum de 10 s : `OCR_STEP_SEC=0` provoquerait une boucle infinie
  // d'extraction de frames jusqu'à saturation de la mémoire.
  const step = Math.max(10, Math.trunc(o.stepSec ?? 60));
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
