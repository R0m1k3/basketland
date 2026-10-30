/**
 * Whisper et Ollama EMBARQUÉS dans le conteneur BasketLand.
 *
 * L'image Docker contient faster-whisper (environnement Python
 * /opt/whisper, bibliothèques CUDA comprises) et le binaire Ollama. Ils ne
 * tournent pas en permanence : un travail de traduction les démarre au
 * premier besoin, puis les arrête à la fin (ou sur erreur / abandon).
 *
 *   transcription : processus Python `scripts/whisper_worker.py`, modèle
 *                   chargé une fois pour tout le match ;
 *   traduction    : `ollama serve` lancé à la demande, modèle téléchargé au
 *                   premier usage.
 *
 * Par défaut les deux restent chargés ENSEMBLE pendant tout le travail
 * (traitement tronçon par tronçon, sous-titres publiés au fil de l'eau) :
 * large-v3-turbo en fp16 (~1,6 Go) et Gemma 4 E4B en Q4 (~6,6 Go)
 * tiennent dans une carte de 10-12 Go. `COMMENTARY_GPU_SEQUENTIAL=1` revient
 * à l'enchaînement « Whisper, puis arrêt, puis Ollama » pour un modèle de
 * traduction plus gros (voir commentary.ts). Les modèles sont rangés dans
 * `/data/models` et survivent aux mises à jour du conteneur.
 *
 * Si TRANSCRIBE_URL / TRANSLATE_URL sont définis, les serveurs externes
 * correspondants sont utilisés à la place (voir commentaryAi.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { dataDir } from './db';
import { parseVerboseJson, type Transcript } from './commentaryCues';

// ------------------------------------------------------------------ chemins

export function embeddedPaths(): { python: string; worker: string; ollama: string } {
  return {
    python: process.env.WHISPER_PYTHON || '/opt/whisper/bin/python',
    worker: process.env.WHISPER_WORKER || path.join(process.cwd(), 'scripts', 'whisper_worker.py'),
    ollama: process.env.OLLAMA_BIN || '/usr/bin/ollama',
  };
}

export function embeddedWhisperAvailable(): boolean {
  const p = embeddedPaths();
  return fs.existsSync(p.python) && fs.existsSync(p.worker);
}

export function embeddedOllamaAvailable(): boolean {
  return fs.existsSync(embeddedPaths().ollama);
}

export function modelsDir(): string {
  return process.env.MODELS_DIR || path.join(dataDir(), 'models');
}

/** Port local d'Ollama embarqué (127.0.0.1 uniquement : rien n'est exposé). */
export function embeddedOllamaUrl(): string {
  const port = Math.trunc(Number(process.env.OLLAMA_PORT)) || 11434;
  return `http://127.0.0.1:${port}`;
}

/**
 * Dossiers des bibliothèques CUDA installées par pip (cuBLAS, cuDNN) dans
 * l'environnement Python : ctranslate2 les charge à l'exécution, il faut les
 * mettre dans LD_LIBRARY_PATH du SEUL processus Whisper (Ollama embarque les
 * siennes, et les mélanger pourrait les faire entrer en conflit).
 */
export function whisperLibraryPath(python: string): string {
  const venv = path.dirname(path.dirname(python));
  const out: string[] = [];
  let libs: string[] = [];
  try {
    libs = fs.readdirSync(path.join(venv, 'lib')).filter((d) => d.startsWith('python3'));
  } catch {
    return '';
  }
  for (const py of libs) {
    for (const pkg of ['cublas', 'cudnn', 'cuda_nvrtc', 'cuda_runtime']) {
      const dir = path.join(venv, 'lib', py, 'site-packages', 'nvidia', pkg, 'lib');
      if (fs.existsSync(dir)) out.push(dir);
    }
  }
  return out.join(':');
}

const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200);

/** Arrêt propre d'un processus enfant : SIGTERM, puis SIGKILL au bout de `graceMs`. */
function stopChild(child: ChildProcess, graceMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

// ------------------------------------------------------------------ Whisper

interface Pending {
  resolve: (t: Transcript) => void;
  reject: (e: Error) => void;
}

/**
 * Une session de transcription : un processus Python, un modèle chargé.
 * `open` attend que le modèle soit prêt (le premier lancement le télécharge,
 * ~1,6 Go pour large-v3-turbo).
 */
export class WhisperSession {
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = '';
  private closed = false;
  readonly ready: Promise<{ device: string }>;

  private constructor(model: string) {
    const p = embeddedPaths();
    const models = modelsDir();
    fs.mkdirSync(models, { recursive: true });
    const libPath = whisperLibraryPath(p.python);
    this.child = spawn(
      p.python,
      [p.worker, '--model', model, '--device', process.env.WHISPER_DEVICE || 'auto', '--compute-type', process.env.WHISPER_COMPUTE_TYPE || 'auto', '--download-root', path.join(models, 'whisper')],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HF_HOME: path.join(models, 'hf'),
          PYTHONUNBUFFERED: '1',
          ...(libPath ? { LD_LIBRARY_PATH: [libPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {}),
        },
      },
    );
    this.child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      this.stderrTail = (this.stderrTail + s).slice(-2000);
      for (const line of s.split('\n')) if (line.trim()) console.log(line.trim().startsWith('[whisper]') ? line.trim() : `[whisper] ${line.trim()}`);
    });
    let readyResolve!: (v: { device: string }) => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    // Promesse observée : un échec avant `await ready` ne doit pas être « non géré ».
    this.ready.catch(() => undefined);
    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => {
      let msg: { event?: string; device?: string; error?: string; id?: number; ok?: boolean; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event === 'ready') return readyResolve({ device: msg.device ?? '?' });
      if (msg.event === 'error') return readyReject(new Error(msg.error ?? 'Whisper : échec du chargement'));
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.ok) p.resolve(parseVerboseJson(msg.result));
      else p.reject(new Error(`Whisper : ${msg.error ?? 'transcription impossible'}`));
    });
    this.child.on('error', (e) => readyReject(new Error(`Whisper ne démarre pas : ${short(e)}`)));
    this.child.on('exit', (code, sig) => {
      const why = new Error(
        `Whisper s'est arrêté (${sig ?? `code ${code}`})${this.stderrTail ? ` : ${this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''}`,
      );
      readyReject(why);
      for (const p of this.pending.values()) p.reject(why);
      this.pending.clear();
    });
  }

  static async open(model: string, timeoutMs = Number(process.env.WHISPER_LOAD_TIMEOUT_MS) || 30 * 60_000): Promise<WhisperSession> {
    const s = new WhisperSession(model);
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        s.ready,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`Whisper : modèle ${model} pas prêt après ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
        }),
      ]);
      console.log(`[commentaires] Whisper embarqué prêt (${model}, ${info.device})`);
      return s;
    } catch (e) {
      await s.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  transcribe(file: string, prompt: string | undefined, signal?: AbortSignal): Promise<Transcript> {
    if (this.closed) return Promise.reject(new Error('session Whisper fermée'));
    const id = this.nextId++;
    return new Promise<Transcript>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error('transcription interrompue'));
        void this.close();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (t) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(t);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ id, file, language: 'en', prompt })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    await stopChild(this.child, 5_000);
  }
}

// ------------------------------------------------------------------ Ollama

async function ollamaUp(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ollama embarqué pour la durée de la traduction. Si un Ollama répond déjà
 * sur le port (lancé ailleurs), il est utilisé tel quel et n'est pas arrêté.
 */
export class OllamaSession {
  private child: ChildProcess | null = null;
  readonly base = embeddedOllamaUrl();

  static async open(timeoutMs = 90_000): Promise<OllamaSession> {
    const s = new OllamaSession();
    if (await ollamaUp(s.base)) return s;
    const models = path.join(modelsDir(), 'ollama');
    fs.mkdirSync(models, { recursive: true });
    // Ollama range sa clé d'identification (~/.ollama/id_ed25519, exigée pour
    // télécharger depuis registry.ollama.ai) dans HOME : un HOME hérité de root
    // (/root) est interdit à l'utilisateur `node` → « permission denied ».
    // La clé est gardée dans le volume, à côté des modèles.
    const home = path.join(modelsDir(), 'ollama-home');
    fs.mkdirSync(home, { recursive: true });
    let tail = '';
    s.child = spawn(embeddedPaths().ollama, ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OLLAMA_HOST: s.base.replace(/^https?:\/\//, ''),
        OLLAMA_MODELS: models,
        HOME: home,
        // Requêtes simultanées = TRANSLATE_PARALLEL (2 par défaut, cf. commentaryAi.translateParallel).
        OLLAMA_NUM_PARALLEL: String(Math.max(1, Math.min(8, Math.trunc(Number(process.env.TRANSLATE_PARALLEL) || 2)))),
        // Même contexte que les requêtes (/api/chat, num_ctx 4096) : pas de rechargement du modèle.
        OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || '4096',
        OLLAMA_KEEP_ALIVE: '10m',
      },
    });
    const keep = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    s.child.stdout?.on('data', keep);
    s.child.stderr?.on('data', keep);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (s.child.exitCode !== null) break;
      if (await ollamaUp(s.base)) {
        const gpu = /library=(cuda|rocm)|CUDA|compute=\d/i.test(tail) ? 'GPU' : 'processeur (aucun GPU détecté)';
        console.log(`[commentaires] Ollama embarqué prêt (${gpu})`);
        return s;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await s.close();
    throw new Error(`Ollama ne démarre pas${tail ? ` : ${tail.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''}`);
  }

  /** Télécharge le modèle s'il manque (premier usage), avec progression en %. */
  async ensureModel(name: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    try {
      const r = await fetch(`${this.base}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(10_000) });
      if (r.ok) return;
    } catch {
      /* pas de réponse : on tente le téléchargement */
    }
    console.log(`[commentaires] téléchargement du modèle ${name} (premier usage)…`);
    const r = await fetch(`${this.base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal });
    if (!r.ok || !r.body) throw new Error(`Ollama : téléchargement de ${name} impossible (HTTP ${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last: { status?: string; error?: string } = {};
    let loggedTenth = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          last = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
          const p = last as { completed?: number; total?: number };
          if (p.total && p.completed !== undefined) {
            onProgress?.(Math.round(p.completed / 1e6), Math.round(p.total / 1e6));
            // Gros fichier du modèle : une ligne de journal tous les 10 %.
            const tenth = Math.floor((p.completed / p.total) * 10);
            if (p.total > 100e6 && tenth > loggedTenth) {
              loggedTenth = tenth;
              console.log(`[commentaires] téléchargement de ${name} : ${tenth * 10} % (${Math.round(p.completed / 1e6)} / ${Math.round(p.total / 1e6)} Mo)`);
            }
          }
        } catch {
          /* ligne partielle */
        }
      }
    }
    if (last.error) throw new Error(`Ollama : ${last.error}`);
    if (last.status !== 'success') throw new Error(`Ollama : téléchargement de ${name} incomplet (${last.status ?? 'sans statut'})`);
    console.log(`[commentaires] modèle ${name} téléchargé`);
  }

  async close(): Promise<void> {
    if (this.child) await stopChild(this.child);
    this.child = null;
  }
}
