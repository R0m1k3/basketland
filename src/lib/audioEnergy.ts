/**
 * Intensité de la voix des commentateurs, mot par mot.
 *
 * Quand le ton monte (panier décisif, contre, dunk), le commentateur parle
 * plus FORT : on mesure l'énergie sonore de chaque mot dans l'audio du
 * tronçon, relative au niveau habituel du tronçon. Les sous-titres s'en
 * servent pour couper au bon endroit (une exclamation a sa propre ligne) et
 * pour mettre en relief les moments forts.
 *
 * Indépendant du moteur de transcription : l'audio est décodé par ffmpeg
 * (PCM 8 kHz mono, quelques dixièmes de seconde pour 2 min), puis l'énergie
 * est calculée ici.
 */
import { spawn } from 'node:child_process';
import type { AsrWord, Transcript } from './commentaryCues';
import { lowerPriority } from './procPriority';

export interface Envelope {
  /** Durée d'une trame (s). */
  frameSec: number;
  /** Puissance moyenne de chaque trame (carré de l'amplitude, 0 à 1). */
  power: Float32Array;
}

const SAMPLE_RATE = 8000;
const FRAME_SEC = 0.05;

/** Enveloppe de puissance d'un PCM 16 bits signé petit-boutiste (mono). */
export function envelopeFromPcm(pcm: Uint8Array, sampleRate = SAMPLE_RATE, frameSec = FRAME_SEC): Envelope {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  const per = Math.max(1, Math.round(sampleRate * frameSec));
  const frames = Math.ceil(samples / per);
  const power = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = f * per;
    const b = Math.min(samples, a + per);
    let sum = 0;
    for (let i = a; i < b; i++) {
      const x = view.getInt16(i * 2, true) / 32768;
      sum += x * x;
    }
    power[f] = b > a ? sum / (b - a) : 0;
  }
  return { frameSec: per / sampleRate, power };
}

const toDb = (p: number) => 10 * Math.log10(p + 1e-10);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Ajoute à chaque mot `energy` : son niveau sonore en dB par rapport au
 * niveau MÉDIAN des mots du tronçon (0 = ton habituel, +6 = nettement plus
 * fort). `offset` : début du tronçon dans l'audio, si les horodatages des
 * mots sont absolus.
 */
export function addWordEnergy(words: AsrWord[], env: Envelope, offset = 0): AsrWord[] {
  const n = env.power.length;
  if (!n || !words.length) return words;
  const raw = words.map((w) => {
    const a = Math.max(0, Math.floor((w.start - offset) / env.frameSec));
    const b = Math.min(n, Math.max(a + 1, Math.ceil((w.end - offset) / env.frameSec)));
    if (a >= n) return null;
    let sum = 0;
    for (let f = a; f < b; f++) sum += env.power[f];
    return toDb(sum / (b - a));
  });
  const ref = median(raw.filter((x): x is number => x !== null));
  return words.map((w, i) => {
    const db = raw[i];
    return db === null ? w : { ...w, energy: Math.round((db - ref) * 10) / 10 };
  });
}

/** Le transcript d'un tronçon, ses mots (au niveau supérieur et imbriqués) annotés d'énergie. */
export function withEnergy(t: Transcript, env: Envelope): Transcript {
  const words = addWordEnergy(t.words, env);
  // Référence commune aux mots imbriqués : on reprend les valeurs calculées
  // sur l'ensemble quand les mêmes mots existent au niveau supérieur.
  const nested = t.segments.flatMap((s) => s.words ?? []);
  const nestedE = nested.length ? addWordEnergy(nested, env) : [];
  let k = 0;
  return {
    words,
    segments: t.segments.map((s) => (s.words ? { ...s, words: s.words.map(() => nestedE[k++]) } : s)),
  };
}

/**
 * Enveloppe d'un fichier audio (décodé par ffmpeg). Null si le décodage
 * échoue : la mise en relief est un bonus, jamais une raison d'échouer.
 */
export function audioEnvelope(file: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<Envelope | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Envelope | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(v);
    };
    let ff: ReturnType<typeof spawn>;
    try {
      ff = spawn(
        process.env.FFMPEG_PATH || 'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      resolve(null);
      return;
    }
    lowerPriority(ff);
    const kill = () => {
      ff.kill('SIGKILL');
      finish(null);
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill);
    const parts: Buffer[] = [];
    ff.stdout?.on('data', (b: Buffer) => parts.push(b));
    ff.on('error', () => finish(null));
    ff.on('close', (code) => {
      const pcm = Buffer.concat(parts);
      finish(code === 0 && pcm.length >= 2 ? envelopeFromPcm(pcm) : null);
    });
  });
}
