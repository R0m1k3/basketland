/**
 * Phase A de la synchro : lecture du chrono de jeu affiché à l'écran (OCR).
 *
 * Ce module contient les briques bas niveau : parseur du texte du bandeau,
 * extraction d'images (ffmpeg, flux HLS ou MP4), filtres d'image, tesseract.js
 * (WASM, pas de dépendance système) et sélection des observations cohérentes.
 * La localisation du bandeau (variable selon le diffuseur) est dans
 * `scoreboard.ts`, le balayage de la vidéo dans `videoScan.ts`. Chaque lecture
 * « période + chrono » donne une observation (video_ts, période, chrono).
 *
 * Les lectures OCR sont bruitées : `selectConsistentObservations` ne garde que la plus
 * longue chaîne d'observations compatible avec le modèle physique (le jeu vivant n'est
 * jamais coupé, seuls les temps morts peuvent l'être).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
  const t = normalizeOcrText(text);
  const period = parsePeriodText(t);
  const candidates = parseClockCandidates(t);
  if (!candidates.length) return null;
  // Le chrono est le plus souvent la seule valeur mm:ss du bandeau ; sinon on prend la plus plausible.
  const clock = candidates[0];
  if (period !== null && period > 4 && clock > 300) return null;
  return { period, clock_sec: clock };
}

/** Majuscules, séparateurs `|` neutralisés, espaces compactés. */
export function normalizeOcrText(text: string): string {
  return text.toUpperCase().replace(/[|]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Format « Q2 » (Prime Video, certaines chaînes locales) : uniquement si le
 * mot est isolé. Un « Q » collé à d'autres caractères est trop souvent un O
 * ou un 0 mal lus.
 */
const PERIOD_Q_RE = /\bQ([1-4])\b/;

/**
 * Période lue dans un texte OCR normalisé (voir `normalizeOcrText`), ou null.
 *
 * Ordre : forme classique (frontières de mot), forme collée au shot clock
 * ("2ND24"), format « Q2 », confusions OCR ("3RO"), puis prolongation — retenue
 * seulement si le mot est isolé, pour ne pas confondre un "3RD" mal lu avec un OT.
 */
export function parsePeriodText(t: string): number | null {
  const strict = t.match(PERIOD_STRICT_RE)?.[1] ?? t.match(PERIOD_COLLED_RE)?.[1] ?? null;
  if (strict) return periodFromToken(strict);
  const q = t.match(PERIOD_Q_RE);
  if (q) return Number(q[1]);
  for (const [re, value] of PERIOD_VARIANTS) if (re.test(t)) return value;
  const ot = t.match(PERIOD_OT_RE);
  if (ot) return 4 + (Number(ot[1]) || 1);
  return null;
}

/**
 * Valeurs de chrono (secondes) lues dans un texte OCR normalisé, dans l'ordre
 * d'apparition : d'abord les `m:ss`, et seulement à défaut les `ss.d` (dernière
 * minute, en dixièmes).
 */
export function parseClockCandidates(t: string): number[] {
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
  return candidates;
}

export interface FrameObservation {
  video_ts: number;
  period: number | null;
  clock_sec: number;
  /** Nombres lus près du chrono (scores des deux équipes, shot clock…), si disponibles. */
  scores?: number[];
}

/** Score du match après une action du play-by-play. */
export interface ScorePoint {
  period: number;
  clock_sec: number;
  home: number;
  away: number;
}

/** Évolution du score, triée par temps de jeu (actions sans score ignorées). */
export function scoreTimeline(
  plays: { seq: number; period: number; clock_sec: number; home_score: number | null; away_score: number | null }[],
): ScorePoint[] {
  return [...plays]
    .sort((a, b) => a.seq - b.seq)
    .filter((p) => p.home_score !== null && p.away_score !== null)
    .map((p) => ({ period: p.period, clock_sec: p.clock_sec, home: p.home_score as number, away: p.away_score as number }));
}

/**
 * Les nombres lus sur le bandeau contiennent-ils les DEUX scores du match tels
 * qu'ils étaient autour de (période, chrono) ?
 *
 * Fenêtre tolérante (45 s de jeu avant, 10 s après) : le bandeau du diffuseur
 * peut retarder ou devancer légèrement le play-by-play ESPN.
 */
export function scoresMatchAt(read: number[], timeline: ScorePoint[], period: number, clockSec: number, back = 45, fwd = 10): boolean {
  if (read.length < 2 || !timeline.length) return false;
  const g = gameElapsed(period, clockSec);
  const set = new Set(read);
  let before: ScorePoint | null = null;
  const states: ScorePoint[] = [];
  for (const s of timeline) {
    const e = gameElapsed(s.period, s.clock_sec);
    if (e < g - back) before = s;
    else if (e <= g + fwd) states.push(s);
    else break;
  }
  if (before) states.push(before);
  return states.some((s) => s.home !== s.away && set.has(s.home) && set.has(s.away));
}

export interface ConsistencyOptions {
  /** Tolérance (s) sur les écarts vidéo/réel entre deux observations. */
  tolerance?: number;
  /** Évolution du score (play-by-play) : valide ou désambiguïse une lecture qui porte des scores. */
  scores?: ScorePoint[];
  /** Au-delà de cette durée (s) de chrono arrêté, une lecture est ambiguë (8 par défaut). */
  frozenMax?: number;
}

/**
 * Intervalle wallclock pendant lequel le chrono affiche (période, chrono).
 *
 * Chrono qui tourne : un instant (lo = hi). Chrono ARRÊTÉ (lancers francs,
 * temps mort, revue vidéo) : de la première action à ce chrono jusqu'à la
 * reprise, déduite de l'action suivante (reprise = son wallclock moins le jeu
 * écoulé). Une image prise pendant un arrêt peut se situer n'importe où dans
 * cet intervalle — parfois plus d'une minute : l'ancrer au début de l'arrêt
 * décalait la VF d'autant (jusqu'à 60 s mesurés sur une vidéo synthétique).
 * On ancre donc au MILIEU de l'intervalle, et seulement s'il est court.
 */
export function clockWallInterval(period: number, clockSec: number, tp: TimedPlay[]): { lo: number; hi: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < tp.length; i++) {
    if (tp[i].period === period && tp[i].clock_sec === clockSec) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    const w = resolveAnchorWall({ period, clock_sec: clockSec, wallclock: null }, tp);
    return w === null ? null : { lo: w, hi: w };
  }
  // Début de période (12:00 / 5:00) : le bandeau l'affiche aussi AVANT la
  // première action (entre-deux, présentation) — instant indéterminé.
  const lo = clockSec >= (period <= 4 ? 720 : 300) ? tp[first].wall - 600 : tp[first].wall;
  let hi = tp[last].wall;
  const next = tp.slice(last + 1).find((p) => p.period === period && p.clock_sec < clockSec);
  if (next) hi = Math.max(hi, next.wall - (clockSec - next.clock_sec));
  // Fin de période (0.0) : affiché pendant toute la pause qui suit.
  else hi += 600;
  return { lo, hi };
}

interface Candidate extends ResolvedAnchor {
  lo: number;
  hi: number;
  weight: number;
}

/**
 * Plus longue chaîne d'observations cohérentes (programmation dynamique O(n²)).
 * Entre deux observations i<j : Δvidéo ∈ [temps vivant − tol, temps vivant + temps compressible + tol],
 * calculés sur les intervalles de chrono (voir `clockWallInterval`).
 * Les observations sans période sont résolues sur les périodes candidates.
 *
 * Poids d'une observation : 1 si la période est lue, 0,6 sinon (hypothèse) ;
 * bonus si les scores lus sur le bandeau correspondent au play-by-play à cet
 * instant — c'est ce qui permet de choisir la bonne période quand elle est
 * illisible (les scores d'un 1er et d'un 3e quart-temps n'ont rien à voir) ;
 * poids divisé par deux pour une lecture faite pendant un long arrêt du chrono.
 *
 * Les lectures ambiguës (chrono arrêté plus de `frozenMax` s) aident à valider
 * la chaîne mais ne sont rendues comme ancres que si leur période n'a aucune
 * ancre précise et que l'arrêt dure moins de 3 min (l'ancre est placée au
 * milieu de l'arrêt : erreur ≤ 90 s, bien mieux que l'extrapolation sur tout un quart-temps).
 */
export function selectConsistentObservations(
  obs: FrameObservation[],
  tp: TimedPlay[],
  breaks: BreakInfo[],
  o: ConsistencyOptions = {},
): ResolvedAnchor[] {
  const tol = o.tolerance ?? 15;
  const frozenMax = o.frozenMax ?? 8;
  const tl = new Timeline(breaks.map((b) => b.interval));
  const maxPeriod = tp.reduce((m, p) => Math.max(m, p.period), 0);
  // Développe les observations en candidats (période connue ou hypothèses 1..maxPeriod).
  const cands: Candidate[] = [];
  for (const ob of [...obs].sort((a, b) => a.video_ts - b.video_ts)) {
    const periods = ob.period ? [ob.period] : Array.from({ length: maxPeriod }, (_, i) => i + 1);
    for (const p of periods) {
      if (p > maxPeriod) continue;
      if (ob.clock_sec > (p <= 4 ? 720 : 300)) continue;
      const iv = clockWallInterval(p, ob.clock_sec, tp);
      if (iv === null) continue;
      // Arrêt long : poids de base divisé par deux, mais le bonus des scores reste entier.
      let weight = (ob.period ? 1 : 0.6) * (iv.hi - iv.lo > frozenMax ? 0.5 : 1);
      if (o.scores && ob.scores && scoresMatchAt(ob.scores, o.scores, p, ob.clock_sec)) weight += ob.period ? 0.5 : 0.6;
      cands.push({ wall: (iv.lo + iv.hi) / 2, lo: iv.lo, hi: iv.hi, video: ob.video_ts, method: 'auto', period: p, clock_sec: ob.clock_sec, weight });
    }
  }
  const n = cands.length;
  if (!n) return [];
  const score = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const b = cands[j];
    score[j] = b.weight;
    for (let i = 0; i < j; i++) {
      const a = cands[i];
      if (b.video <= a.video || b.hi < a.lo) continue;
      if (gameElapsed(b.period, b.clock_sec) < gameElapsed(a.period, a.clock_sec)) continue;
      const dv = b.video - a.video;
      // Bornes sur les intervalles : plus petit écart réel possible (fin de a →
      // début de b) et plus grand (début de a → fin de b).
      const minLive = tl.live(a.hi, b.lo);
      const maxSpan = tl.live(a.lo, b.hi) + tl.comp(a.lo, b.hi);
      if (dv < minLive - tol || dv > maxSpan + tol) continue;
      if (score[i] + b.weight > score[j]) {
        score[j] = score[i] + b.weight;
        prev[j] = i;
      }
    }
  }
  let best = 0;
  for (let j = 1; j < n; j++) if (score[j] > score[best]) best = j;
  const chain: Candidate[] = [];
  for (let k = best; k >= 0; k = prev[k]) chain.push(cands[k]);
  chain.reverse();
  // Une seule observation par instant vidéo (les hypothèses de période sont exclusives).
  const unique = chain.filter((a, i) => i === 0 || a.video !== chain[i - 1].video);
  const precise = new Set(unique.filter((a) => a.hi - a.lo <= frozenMax).map((a) => a.period));
  return unique
    .filter((a) => a.hi - a.lo <= frozenMax || (a.hi - a.lo <= 180 && !precise.has(a.period)))
    .map((a) => ({ wall: a.wall, video: a.video, method: a.method, period: a.period, clock_sec: a.clock_sec }));
}

// ------------------------------------------------------------------ extraction d'images + OCR

export interface FrameGrabOptions {
  userAgent: string;
  referer: string;
}

/**
 * Extrait une image (PNG, format brut) à l'instant `t` d'une source lisible par
 * ffmpeg : playlist HLS ou MP4 progressif (seek par requêtes Range).
 */
export function grabFrame(sourceUrl: string, t: number, o: FrameGrabOptions, timeoutMs = 60_000): Promise<Buffer> {
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
        sourceUrl,
        '-an',
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

/** Mot reconnu par tesseract, avec sa boîte en pixels de l'image analysée. */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessPage {
  text: string;
  blocks?: { paragraphs?: { lines?: { words?: { text: string; confidence: number; bbox: TessBbox }[] }[] }[] }[] | null;
}

export interface OcrWorker {
  recognize(img: Buffer, options?: object, output?: { text?: boolean; blocks?: boolean }): Promise<{ data: TessPage }>;
  terminate(): Promise<unknown>;
}

/**
 * `require` résolu À L'EXÉCUTION depuis le dossier courant (racine de l'app,
 * ou `.next/standalone` dont `server.js` fait son dossier courant).
 *
 * Un `createRequire(import.meta.url)` est réécrit par webpack quand Next
 * empaquette le serveur : `require.resolve('tesseract.js/…')` y renvoyait un
 * identifiant de module interne (« (rsc)/…/index.js ») au lieu d'un chemin.
 * `process.getBuiltinModule` (Node ≥ 22.3) est opaque pour l'empaqueteur.
 */
function runtimeRequire(): NodeJS.Require {
  const mod = process.getBuiltinModule?.('node:module') as typeof import('node:module') | undefined;
  if (mod) return mod.createRequire(path.join(process.cwd(), 'package.json'));
  return createRequire(import.meta.url);
}

/**
 * Caractères reconnus : chiffres, ponctuation du chrono et lettres des
 * périodes (1ST, 2ND, 3RD, 4TH, OT, Q1…). Restreindre l'alphabet évite que
 * tesseract « invente » des mots dans les noms d'équipes et les publicités.
 */
export const OCR_WHITELIST = '0123456789:.STNDRHOQ';

/**
 * Démarre un worker tesseract.js.
 *
 * Le script du worker est passé EXPLICITEMENT (`workerPath`) : tesseract.js le
 * calcule par défaut depuis son propre `__dirname`, qui pointe dans `.next/`
 * une fois le code empaqueté par Next — « Cannot find module
 * .next/worker-script/node/index.js ». Cette erreur était levée dans le thread
 * du worker, hors de toute promesse : l'analyse restait « en cours » pour
 * toujours. On vérifie donc la présence des fichiers et on borne le démarrage
 * dans le temps, pour échouer avec un message lisible.
 * (`next.config.mjs` déclare aussi tesseract.js comme paquet externe et
 * copie ses fichiers dans le build standalone.)
 */
export async function createOcrWorker(timeoutMs = 90_000): Promise<OcrWorker> {
  const nodeRequire = runtimeRequire();
  let workerPath: string;
  let langPath: string;
  try {
    workerPath = nodeRequire.resolve('tesseract.js/src/worker-script/node/index.js');
    langPath = path.join(path.dirname(nodeRequire.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  } catch (e) {
    throw new Error(`OCR indisponible : tesseract.js introuvable (${(e as Error).message})`);
  }
  if (!fs.existsSync(workerPath)) throw new Error(`OCR indisponible : script du worker tesseract.js absent (${workerPath})`);
  if (!fs.existsSync(path.join(langPath, 'eng.traineddata.gz'))) throw new Error(`OCR indisponible : données de langue absentes (${langPath})`);
  const { createWorker } = nodeRequire('tesseract.js') as typeof import('tesseract.js');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`OCR indisponible : tesseract.js n'a pas démarré en ${timeoutMs / 1000} s`)), timeoutMs);
  });
  try {
    const worker = await Promise.race([
      createWorker('eng', 1, {
        langPath,
        workerPath,
        cacheMethod: 'none',
        gzip: true,
        errorHandler: (e: unknown) => console.error('[ocr] erreur tesseract.js :', e),
      }),
      timeout,
    ]);
    await worker.setParameters({
      tessedit_pageseg_mode: '11' as never,
      tessedit_char_whitelist: OCR_WHITELIST,
    });
    return worker as unknown as OcrWorker;
  } finally {
    clearTimeout(timer);
  }
}

/** Texte et mots (avec boîtes) d'une image. */
export async function recognizeWords(worker: OcrWorker, img: Buffer): Promise<{ text: string; words: OcrWord[] }> {
  const { data } = await worker.recognize(img, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) {
          const text = (w.text ?? '').trim();
          if (text) words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence });
        }
  return { text: data.text ?? '', words };
}

/** Dimensions d'une image PNG (lues dans l'en-tête IHDR), ou null si ce n'est pas un PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
