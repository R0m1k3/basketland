import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentaryConfig } from '../src/lib/commentaryAi';
import { OllamaSession, WhisperSession, whisperLibraryPath } from '../src/lib/localAi';

/**
 * Services embarqués (Whisper, Ollama) : pilotés par Node, démarrés et
 * arrêtés à la demande. Les vrais binaires ne sont pas dans l'environnement
 * de test : ils sont remplacés par de faux processus au même protocole.
 */

const HELPERS = path.join(__dirname, 'helpers');
const ENV = ['WHISPER_PYTHON', 'WHISPER_WORKER', 'OLLAMA_BIN', 'OLLAMA_PORT', 'MODELS_DIR', 'TRANSCRIBE_URL', 'TRANSLATE_URL', 'TRANSLATE_MODEL'];
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-localai-'));
  process.env.MODELS_DIR = path.join(tmp, 'models');
});
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('configuration : services embarqués par défaut', () => {
  it('sans URL externe ni binaire : inactif', () => {
    process.env.WHISPER_PYTHON = '/nexiste/pas/python';
    process.env.OLLAMA_BIN = '/nexiste/pas/ollama';
    expect(commentaryConfig().disabledReason).toMatch(/non configurés/);
  });

  it('binaires présents : actif, en mode embarqué, Ollama sur 127.0.0.1', () => {
    process.env.WHISPER_PYTHON = process.execPath;
    process.env.WHISPER_WORKER = path.join(HELPERS, 'fakeWhisperWorker.mjs');
    process.env.OLLAMA_BIN = path.join(HELPERS, 'fakeOllama.mjs');
    const c = commentaryConfig();
    expect(c).toMatchObject({ disabledReason: null, transcribeMode: 'embedded', translateMode: 'embedded', translateUrl: 'http://127.0.0.1:11434/v1' });
  });

  it('une URL externe prend le pas sur le service embarqué', () => {
    process.env.WHISPER_PYTHON = process.execPath;
    process.env.WHISPER_WORKER = path.join(HELPERS, 'fakeWhisperWorker.mjs');
    process.env.OLLAMA_BIN = path.join(HELPERS, 'fakeOllama.mjs');
    process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
    expect(commentaryConfig()).toMatchObject({ transcribeMode: 'embedded', translateMode: 'remote', translateUrl: 'http://gpu.local:11434/v1' });
  });
});

describe('Whisper embarqué (faux processus)', () => {
  beforeEach(() => {
    process.env.WHISPER_PYTHON = process.execPath;
    process.env.WHISPER_WORKER = path.join(HELPERS, 'fakeWhisperWorker.mjs');
  });

  it('charge le modèle une fois, transcrit plusieurs tronçons, puis s’arrête', async () => {
    const s = await WhisperSession.open('distil-large-v3');
    const a = await s.transcribe('/tmp/chunk-000.ogg', 'NBA', undefined);
    const b = await s.transcribe('/tmp/chunk-001.ogg', 'NBA', undefined);
    expect(a.segments).toHaveLength(1);
    expect(a.words?.map((w) => w.word.trim())).toEqual(['Curry', 'pulls', 'up.', 'Bang!']);
    expect(b.segments[0].text.trim()).toBe('Curry pulls up. Bang!');
    await s.close();
    await expect(s.transcribe('/tmp/x.ogg', undefined, undefined)).rejects.toThrow(/fermée/);
  });

  it('erreur de transcription remontée, la session reste utilisable', async () => {
    const s = await WhisperSession.open('distil-large-v3');
    await expect(s.transcribe('/tmp/erreur.ogg', undefined, undefined)).rejects.toThrow('Whisper : fichier illisible');
    expect((await s.transcribe('/tmp/ok.ogg', undefined, undefined)).segments).toHaveLength(1);
    await s.close();
  });

  it('échec du chargement du modèle : erreur explicite', async () => {
    await expect(WhisperSession.open('casse')).rejects.toThrow('modèle introuvable');
  });

  it('bibliothèques CUDA de pip ajoutées au LD_LIBRARY_PATH du seul processus Whisper', () => {
    const venv = path.join(tmp, 'venv');
    for (const pkg of ['cublas', 'cudnn']) fs.mkdirSync(path.join(venv, 'lib', 'python3.11', 'site-packages', 'nvidia', pkg, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    const lib = whisperLibraryPath(path.join(venv, 'bin', 'python'));
    expect(lib.split(':')).toEqual([
      path.join(venv, 'lib', 'python3.11', 'site-packages', 'nvidia', 'cublas', 'lib'),
      path.join(venv, 'lib', 'python3.11', 'site-packages', 'nvidia', 'cudnn', 'lib'),
    ]);
    expect(whisperLibraryPath('/nexiste/pas/bin/python')).toBe('');
  });
});

describe('Ollama embarqué (faux binaire)', () => {
  beforeEach(() => {
    process.env.OLLAMA_BIN = path.join(HELPERS, 'fakeOllama.mjs');
    // Port propre au test : un vrai Ollama local éventuel n'interfère pas.
    process.env.OLLAMA_PORT = String(20000 + Math.floor(Math.random() * 20000));
  });

  it('démarre `ollama serve`, télécharge le modèle manquant avec progression, puis s’arrête', async () => {
    const s = await OllamaSession.open(20_000);
    // HOME dans le volume des modèles (clé ~/.ollama/id_ed25519 accessible à `node`), jamais /root.
    const v = (await (await fetch(`${s.base}/api/version`)).json()) as { home: string };
    expect(v.home).toBe(path.join(process.env.MODELS_DIR!, 'ollama-home'));
    expect(fs.existsSync(v.home)).toBe(true);
    const steps: [number, number][] = [];
    await s.ensureModel('hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0', (d, t) => steps.push([d, t]));
    expect(steps).toEqual([
      [2, 4],
      [4, 4],
    ]);
    await s.ensureModel('hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0'); // déjà là : rien à faire
    const base = s.base;
    await s.close();
    await expect(fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('téléchargement refusé : erreur Ollama explicite', async () => {
    const s = await OllamaSession.open(20_000);
    await expect(s.ensureModel('inconnu')).rejects.toThrow('Ollama : pull model manifest: file does not exist');
    await s.close();
  });
});
