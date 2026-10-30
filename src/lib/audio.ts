/**
 * Analyse d'énergie audio (Phase B de la synchro).
 *
 * - `RmsAccumulator` / `computeRmsDb` : profil RMS (dBFS) par fenêtre d'1 s, en flux.
 * - `detectCuts` : intervalles de très faible énergie = coupures (pubs, transitions).
 * - `analyzeHlsAudio` : décode l'audio du flux HLS le plus léger via ffmpeg (si présent
 *   dans l'image) et calcule le profil sans jamais stocker l'audio.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { CutInterval } from './types';
import { lowerPriority } from './procPriority';

export const SILENCE_FLOOR_DB = -90;

export function rmsToDb(rms: number): number {
  if (rms <= 0) return SILENCE_FLOOR_DB;
  return Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms));
}

/** Accumule des échantillons PCM s16le mono et produit un niveau dBFS par fenêtre. */
export class RmsAccumulator {
  private sumSq = 0;
  private count = 0;
  private carry: number | null = null;
  readonly profile: number[] = [];
  private readonly samplesPerWindow: number;

  constructor(sampleRate: number, windowSec = 1) {
    this.samplesPerWindow = Math.max(1, Math.round(sampleRate * windowSec));
  }

  pushSample(v: number): void {
    const x = v / 32768;
    this.sumSq += x * x;
    this.count++;
    if (this.count >= this.samplesPerWindow) this.flushWindow();
  }

  /** Accepte des blocs arbitraires (gère l'octet orphelin entre deux blocs). */
  pushBuffer(buf: Buffer): void {
    let i = 0;
    if (this.carry !== null && buf.length > 0) {
      const v = (buf[0] << 8) | this.carry;
      this.pushSample(v >= 0x8000 ? v - 0x10000 : v);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < buf.length; i += 2) this.pushSample(buf.readInt16LE(i));
    if (i < buf.length) this.carry = buf[i];
  }

  private flushWindow(): void {
    this.profile.push(Math.round(rmsToDb(Math.sqrt(this.sumSq / this.count)) * 10) / 10);
    this.sumSq = 0;
    this.count = 0;
  }

  finish(): number[] {
    if (this.count > 0) this.flushWindow();
    return this.profile;
  }
}

export function computeRmsDb(samples: ArrayLike<number>, sampleRate: number, windowSec = 1): number[] {
  const acc = new RmsAccumulator(sampleRate, windowSec);
  for (let i = 0; i < samples.length; i++) acc.pushSample(samples[i]);
  return acc.finish();
}

function median(xs: number[]): number {
  if (!xs.length) return SILENCE_FLOOR_DB;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface CutOptions {
  /** Seuil relatif sous la médiane (dB). */
  dropDb?: number;
  /** Seuil absolu (dBFS) : tout ce qui est en dessous est une coupure. */
  absoluteDb?: number;
  /** Durée minimale d'une coupure (en fenêtres). */
  minLen?: number;
  /** Fusionne deux coupures séparées de moins de N fenêtres. */
  mergeGap?: number;
  windowSec?: number;
}

/**
 * Détecte les coupures : fenêtres dont l'énergie est très en dessous du niveau
 * typique de jeu (commentaires + foule = niveau élevé et continu).
 */
export function detectCuts(profileDb: number[], o: CutOptions = {}): CutInterval[] {
  const w = o.windowSec ?? 1;
  const med = median(profileDb.filter((v) => v > SILENCE_FLOOR_DB));
  const threshold = Math.max(o.absoluteDb ?? -60, med - (o.dropDb ?? 20));
  const minLen = o.minLen ?? 2;
  const mergeGap = o.mergeGap ?? 2;
  const raw: { s: number; e: number }[] = [];
  let start = -1;
  for (let i = 0; i <= profileDb.length; i++) {
    const low = i < profileDb.length && profileDb[i] <= threshold;
    if (low && start < 0) start = i;
    else if (!low && start >= 0) {
      raw.push({ s: start, e: i });
      start = -1;
    }
  }
  const merged: { s: number; e: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.s - last.e <= mergeGap) last.e = r.e;
    else merged.push({ ...r });
  }
  return merged
    .filter((r) => r.e - r.s >= minLen)
    .map((r) => {
      const slice = profileDb.slice(r.s, r.e);
      const mean = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
      return { start: r.s * w, end: r.e * w, meanDb: Math.round(mean * 10) / 10 };
    });
}

let ffmpegChecked: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (ffmpegChecked === null) {
    try {
      const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegChecked = r.status === 0;
    } catch {
      ffmpegChecked = false;
    }
  }
  return ffmpegChecked;
}

export interface HlsAudioOptions {
  userAgent: string;
  referer: string;
  sampleRate?: number;
  timeoutMs?: number;
}

/** Décode l'audio d'une playlist HLS et renvoie le profil dBFS (1 valeur / s). */
export function analyzeHlsAudio(playlistUrl: string, o: HlsAudioOptions): Promise<number[]> {
  const sr = o.sampleRate ?? 4000;
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
        '-i',
        playlistUrl,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(sr),
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    lowerPriority(ff);
    const acc = new RmsAccumulator(sr, 1);
    let stderr = '';
    const timer = setTimeout(() => ff.kill('SIGKILL'), o.timeoutMs ?? 45 * 60_000);
    ff.stdout.on('data', (b: Buffer) => acc.pushBuffer(b));
    ff.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-2000);
    });
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const profile = acc.finish();
      if (code === 0 || profile.length > 600) resolve(profile);
      else reject(new Error(`ffmpeg code ${code}: ${stderr}`));
    });
  });
}
