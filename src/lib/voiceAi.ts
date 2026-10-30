/**
 * Voix françaises du doublage, EMBARQUÉES dans le conteneur BasketLand.
 *
 * L'image Docker contient Qwen3-TTS (environnement Python /opt/tts, torch
 * CUDA compris) et les voix figées (assets/voices/<ID>/ : reference.wav,
 * reference.txt, voice.json). Le moteur ne tourne pas en permanence : le
 * doublage ouvre une `VoiceSession` (processus `scripts/voice_worker.py`,
 * modèle chargé une fois), puis la ferme à la fin, ce qui libère la carte
 * graphique. Il ne tourne JAMAIS en même temps que Whisper et le modèle de
 * traduction : la chaîne de doublage les décharge avant.
 *
 *   synth : une ligne de texte → un WAV mono (PCM 16 bits, 24 kHz) dans la
 *           voix demandée (clonage de la voix figée) ;
 *   embed : empreintes vocales (ECAPA, 192 valeurs normalisées) et F0
 *           médiane de segments d'un fichier audio, pour attribuer les
 *           lignes aux commentateurs (diarisation).
 *
 * Modèles téléchargés au premier usage dans `/data/models/hf` (cache
 * Hugging Face, même dossier que les autres modèles), jamais dans l'image.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { modelsDir, stopChild } from './localAi';
import { lowerPriority } from './procPriority';

export const DEFAULT_TTS_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';

export interface VoiceConfig {
  disabledReason?: string;
  model: string;
  device: string;
  voicesDir: string;
  python: string;
  modelsDir: string;
}

export interface VoiceInfo {
  id: string;
  role: string;
  label: string;
  gender: 'm' | 'f';
}

/** Voix connues : ordre d'affichage et valeurs par défaut si voice.json est incomplet. */
const KNOWN_VOICES: Record<string, Omit<VoiceInfo, 'id'>> = {
  A: { role: 'commentateur', label: 'Commentateur', gender: 'm' },
  B4: { role: 'consultant', label: 'Consultant', gender: 'm' },
  B1: { role: 'troisieme_voix', label: 'Troisième voix', gender: 'm' },
  F: { role: 'voix_feminine', label: 'Voix féminine', gender: 'f' },
};
const VOICE_ORDER = Object.keys(KNOWN_VOICES);

export function defaultVoicesDir(): string {
  return path.join(process.cwd(), 'assets', 'voices');
}

function workerPath(): string {
  return process.env.TTS_WORKER || path.join(process.cwd(), 'scripts', 'voice_worker.py');
}

export function voiceConfig(): VoiceConfig {
  const voicesDir = process.env.VOICES_DIR || defaultVoicesDir();
  const cfg: VoiceConfig = {
    model: process.env.TTS_MODEL || DEFAULT_TTS_MODEL,
    device: process.env.TTS_DEVICE || 'auto',
    voicesDir,
    python: process.env.TTS_PYTHON || (fs.existsSync('/opt/tts/bin/python') ? '/opt/tts/bin/python' : 'python3'),
    modelsDir: modelsDir(),
  };
  if (process.env.DUB_DISABLED === '1') cfg.disabledReason = 'doublage désactivé (DUB_DISABLED=1)';
  else if (!fs.existsSync(workerPath())) cfg.disabledReason = `moteur de voix introuvable (${workerPath()})`;
  else if (listVoices(voicesDir).length === 0) cfg.disabledReason = `aucune voix dans ${voicesDir}`;
  return cfg;
}

/**
 * Voix disponibles : sous-dossiers de `dir` qui ont reference.wav et
 * reference.txt (ce dont le moteur a besoin), décrits par leur voice.json.
 */
export function listVoices(dir: string = process.env.VOICES_DIR || defaultVoicesDir()): VoiceInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: VoiceInfo[] = [];
  for (const id of names) {
    const d = path.join(dir, id);
    if (!fs.existsSync(path.join(d, 'reference.wav')) || !fs.existsSync(path.join(d, 'reference.txt'))) continue;
    let meta: { role?: unknown; label_fr?: unknown; gender?: unknown } = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(d, 'voice.json'), 'utf8'));
    } catch {
      /* voice.json absent ou illisible : valeurs par défaut */
    }
    const known = KNOWN_VOICES[id];
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const gender = meta.gender === 'f' || meta.gender === 'm' ? meta.gender : (known?.gender ?? (id.startsWith('F') ? 'f' : 'm'));
    out.push({ id, role: str(meta.role) ?? known?.role ?? '', label: str(meta.label_fr) ?? known?.label ?? id, gender });
  }
  const rank = (id: string) => (VOICE_ORDER.includes(id) ? VOICE_ORDER.indexOf(id) : VOICE_ORDER.length);
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200);

interface WorkerReply {
  event?: string;
  device?: string;
  model?: string;
  voices?: unknown;
  error?: string;
  id?: number;
  ok?: boolean;
  duration?: number;
  sample_rate?: number;
  embeddings?: unknown;
  f0?: unknown;
}

interface Pending {
  resolve: (r: WorkerReply) => void;
  reject: (e: Error) => void;
}

/**
 * Une session de voix : un processus Python, le modèle chargé, une empreinte
 * de clonage par voix. `open` attend que tout soit prêt (le premier
 * lancement télécharge ~2,5 Go). Les requêtes sont traitées une à une, dans
 * l'ordre d'envoi.
 */
export class VoiceSession {
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = '';
  private closed = false;
  private lastActivity = Date.now();
  private readonly readyP: Promise<{ device: string; voices: string[] }>;
  private info: { device: string; voices: string[] } = { device: '?', voices: [] };

  /** Voix chargées par le moteur (ex. ["A", "B4", "B1"]). */
  get voices(): string[] {
    return [...this.info.voices];
  }

  /** `cuda` ou `cpu`. */
  get device(): string {
    return this.info.device;
  }

  private constructor(cfg: VoiceConfig) {
    fs.mkdirSync(cfg.modelsDir, { recursive: true });
    const hf = path.join(cfg.modelsDir, 'hf');
    this.child = spawn(
      cfg.python,
      [workerPath(), '--model', cfg.model, '--device', cfg.device, '--download-root', hf, '--voices-dir', cfg.voicesDir],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HOME: hf, PYTHONUNBUFFERED: '1' },
      },
    );
    lowerPriority(this.child);
    this.child.stdin?.on('error', () => undefined); // processus déjà mort : l'erreur arrive par 'exit'
    // Journaux du moteur, ligne par ligne (un morceau reçu peut couper une ligne).
    let partial = '';
    const logLine = (raw: string) => {
      const line = raw.trim();
      if (line) console.log(line.startsWith('[voix]') ? line : `[voix] ${line}`);
    };
    this.child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      this.lastActivity = Date.now();
      this.stderrTail = (this.stderrTail + s).slice(-2000);
      const lines = (partial + s).split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      lines.forEach(logLine);
    });
    this.child.stderr?.on('end', () => logLine(partial));
    let readyResolve!: (v: { device: string; voices: string[] }) => void;
    let readyReject!: (e: Error) => void;
    this.readyP = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    // Promesse observée : un échec avant `await` ne doit pas être « non géré ».
    this.readyP.catch(() => undefined);
    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => {
      let msg: WorkerReply;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.event === 'ready') {
        const voices = Array.isArray(msg.voices) ? msg.voices.filter((v): v is string => typeof v === 'string') : [];
        return readyResolve({ device: msg.device ?? '?', voices });
      }
      if (msg.event === 'error') return readyReject(new Error(`voix : ${msg.error ?? 'échec du chargement'}`));
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(`voix : ${msg.error ?? 'échec'}`));
    });
    this.child.on('error', (e) => {
      const why = new Error(`moteur de voix : démarrage impossible (${short(e)})`);
      this.closed = true;
      readyReject(why);
      for (const p of this.pending.values()) p.reject(why);
      this.pending.clear();
    });
    this.child.on('exit', (code, sig) => {
      const tail = this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' | ');
      const why = new Error(`moteur de voix arrêté (${sig ?? `code ${code}`})${tail ? ` : ${tail}` : ''}`);
      this.closed = true;
      readyReject(why);
      for (const p of this.pending.values()) p.reject(why);
      this.pending.clear();
    });
  }

  /**
   * Démarre le moteur et attend qu'il soit prêt. Délai : `TTS_LOAD_TIMEOUT_MS`
   * (10 min par défaut) SANS nouvelle du processus ; chaque ligne de journal
   * (progression du téléchargement du modèle) relance le délai.
   */
  static async open(signal?: AbortSignal): Promise<VoiceSession> {
    const cfg = voiceConfig();
    if (cfg.disabledReason) throw new Error(cfg.disabledReason);
    if (signal?.aborted) throw new Error('chargement des voix interrompu');
    const timeoutMs = Number(process.env.TTS_LOAD_TIMEOUT_MS) || 10 * 60_000;
    const s = new VoiceSession(cfg);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const info = await Promise.race([
        s.readyP,
        new Promise<never>((_, rej) => {
          const check = () => {
            const idle = Date.now() - s.lastActivity;
            if (idle >= timeoutMs) rej(new Error(`voix : modèle ${cfg.model} pas prêt (aucune nouvelle depuis ${Math.round(timeoutMs / 60_000)} min)`));
            else timer = setTimeout(check, Math.min(timeoutMs - idle, 5_000));
          };
          timer = setTimeout(check, Math.min(timeoutMs, 5_000));
          onAbort = () => rej(new Error('chargement des voix interrompu'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      s.info = info;
      console.log(`[voix] Qwen3-TTS embarqué prêt (${cfg.model}, ${info.device}, voix ${info.voices.join(', ') || 'aucune'})`);
      return s;
    } catch (e) {
      await s.close();
      throw e;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private request(op: Record<string, unknown>, what: string, signal?: AbortSignal): Promise<WorkerReply> {
    if (this.closed) return Promise.reject(new Error('session de voix fermée'));
    const id = this.nextId++;
    return new Promise<WorkerReply>((resolve, reject) => {
      // Interruption : le modèle ne sait pas s'arrêter en pleine génération,
      // on arrête le processus (comme pour Whisper).
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error(`${what} interrompue`));
        void this.close();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ id, ...op })}\n`);
    });
  }

  /** Synthétise `text` dans la voix `voice` vers `outFile` (WAV mono PCM 16 bits). */
  async synth(text: string, voice: string, outFile: string, signal?: AbortSignal): Promise<{ duration: number; sampleRate: number }> {
    const r = await this.request({ op: 'synth', text, voice, out: path.resolve(outFile), language: 'French' }, 'synthèse vocale', signal);
    return { duration: Number(r.duration) || 0, sampleRate: Number(r.sample_rate) || 0 };
  }

  /**
   * Empreinte vocale (192 valeurs, norme 1) et F0 médiane (Hz) de chaque
   * segment [début, fin] (secondes) de `file`. `null` : segment trop court
   * (< 0,4 s) pour une empreinte, ou sans voix pour la F0.
   */
  async embed(file: string, segments: [number, number][], signal?: AbortSignal): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[] }> {
    const r = await this.request({ op: 'embed', file: path.resolve(file), segments }, 'analyse des voix', signal);
    const embeddings = Array.isArray(r.embeddings) ? (r.embeddings as unknown[]).map((e) => (Array.isArray(e) ? (e as number[]) : null)) : [];
    const f0 = Array.isArray(r.f0) ? (r.f0 as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)) : [];
    if (embeddings.length !== segments.length || f0.length !== segments.length) {
      throw new Error(`voix : réponse incomplète (${embeddings.length} empreintes pour ${segments.length} segments)`);
    }
    return { embeddings, f0 };
  }

  /** Arrête le moteur : la mémoire du GPU est rendue. */
  async close(): Promise<void> {
    this.closed = true;
    // Jamais démarré (Python introuvable) ou déjà arrêté : rien à attendre.
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.end();
    await stopChild(this.child, 5_000);
  }
}
