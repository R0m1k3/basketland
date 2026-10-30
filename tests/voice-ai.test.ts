import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TTS_MODEL, listVoices, voiceConfig, VoiceSession } from '../src/lib/voiceAi';

/**
 * Voix du doublage (Qwen3-TTS embarqué) : le vrai moteur Python n'est pas
 * dans l'environnement de test, il est remplacé par un faux processus au
 * même protocole (tests/helpers/fakeVoiceWorker.mjs).
 */

const FAKE = path.join(__dirname, 'helpers', 'fakeVoiceWorker.mjs');
const ENV = ['DUB_DISABLED', 'TTS_MODEL', 'TTS_DEVICE', 'VOICES_DIR', 'TTS_PYTHON', 'TTS_WORKER', 'MODELS_DIR', 'TTS_LOAD_TIMEOUT_MS'];
let tmp: string;

function addVoice(dir: string, id: string, meta?: Record<string, unknown> | string, files = ['reference.wav', 'reference.txt']) {
  const d = path.join(dir, id);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(d, f), f.endsWith('.txt') ? 'Bonsoir à tous.' : 'RIFF');
  if (meta !== undefined) fs.writeFileSync(path.join(d, 'voice.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-voice-'));
  process.env.MODELS_DIR = path.join(tmp, 'models');
});
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listVoices', () => {
  it('lit les voice.json, complète les manques, ignore les dossiers incomplets, ordre A, B4, B1, F', () => {
    const dir = path.join(tmp, 'voices');
    addVoice(dir, 'F', { id: 'F', role: 'voix_feminine', label_fr: 'Voix féminine', gender: 'f' });
    addVoice(dir, 'B1', { id: 'B1', role: 'troisieme_voix', label_fr: 'Troisième voix', gender: 'm' });
    addVoice(dir, 'A', { id: 'A', role: 'commentateur', label_fr: 'Commentateur', gender: 'm', creation: { model: 'x' } });
    addVoice(dir, 'B4', '{ cassé'); // JSON illisible : valeurs par défaut de la voix connue
    addVoice(dir, 'Z'); // voix inconnue sans voice.json
    addVoice(dir, 'Y', { label_fr: 'Sans transcription' }, ['reference.wav']); // inutilisable par le moteur
    fs.writeFileSync(path.join(dir, 'LISEZMOI.txt'), 'pas une voix');
    expect(listVoices(dir)).toEqual([
      { id: 'A', role: 'commentateur', label: 'Commentateur', gender: 'm' },
      { id: 'B4', role: 'consultant', label: 'Consultant', gender: 'm' },
      { id: 'B1', role: 'troisieme_voix', label: 'Troisième voix', gender: 'm' },
      { id: 'F', role: 'voix_feminine', label: 'Voix féminine', gender: 'f' },
      { id: 'Z', role: '', label: 'Z', gender: 'm' },
    ]);
    expect(listVoices(path.join(tmp, 'nexiste-pas'))).toEqual([]);
  });

  it('voix livrées dans assets/voices : A, B4, B1 complètes', () => {
    const dir = path.join(__dirname, '..', 'assets', 'voices');
    expect(listVoices(dir)).toEqual([
      { id: 'A', role: 'commentateur', label: 'Commentateur', gender: 'm' },
      { id: 'B4', role: 'consultant', label: 'Consultant', gender: 'm' },
      { id: 'B1', role: 'troisieme_voix', label: 'Troisième voix', gender: 'm' },
    ]);
    for (const id of ['A', 'B4', 'B1']) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'voice.json'), 'utf8'));
      expect(meta.id).toBe(id);
      expect(meta.reference_transcript).toBe(fs.readFileSync(path.join(dir, id, 'reference.txt'), 'utf8').trim());
      // WAV PCM 16 bits mono 24 kHz (en-tête RIFF standard).
      const wav = fs.readFileSync(path.join(dir, id, 'reference.wav'));
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt16LE(34)).toBe(16);
    }
  });
});

describe('voiceConfig', () => {
  it('valeurs par défaut, et DUB_DISABLED=1 désactive', () => {
    process.env.VOICES_DIR = path.join(__dirname, '..', 'assets', 'voices');
    const c = voiceConfig();
    expect(c).toMatchObject({ model: DEFAULT_TTS_MODEL, device: 'auto', voicesDir: process.env.VOICES_DIR, modelsDir: path.join(tmp, 'models') });
    expect(c.disabledReason).toBeUndefined();
    expect(c.python).toBe(fs.existsSync('/opt/tts/bin/python') ? '/opt/tts/bin/python' : 'python3');
    process.env.DUB_DISABLED = '1';
    expect(voiceConfig().disabledReason).toMatch(/DUB_DISABLED/);
  });

  it('variables d’environnement ; sans voix : désactivé', () => {
    Object.assign(process.env, { TTS_MODEL: 'Qwen/Autre', TTS_DEVICE: 'cpu', TTS_PYTHON: '/usr/bin/python3.11', VOICES_DIR: path.join(tmp, 'vide') });
    const c = voiceConfig();
    expect(c).toMatchObject({ model: 'Qwen/Autre', device: 'cpu', python: '/usr/bin/python3.11' });
    expect(c.disabledReason).toMatch(/aucune voix/);
  });
});

describe('VoiceSession (faux moteur)', () => {
  let voices: string;
  beforeEach(() => {
    voices = path.join(tmp, 'voices');
    for (const id of ['B1', 'A', 'B4']) addVoice(voices, id, { id });
    Object.assign(process.env, { TTS_PYTHON: process.execPath, TTS_WORKER: FAKE, VOICES_DIR: voices });
  });

  it('prêt : voix et appareil ; synthèse puis empreintes ; fermeture', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
    const s = await VoiceSession.open();
    expect(s.voices).toEqual(['A', 'B4', 'B1']);
    expect(s.device).toBe('cpu');
    // Modèles dans le cache Hugging Face du volume des modèles.
    expect(logs.some((l) => l.includes(`download-root ${path.join(tmp, 'models', 'hf')}`) && l.includes(`HF_HOME ${path.join(tmp, 'models', 'hf')}`))).toBe(true);
    expect(logs.every((l) => l.startsWith('[voix] '))).toBe(true);
    expect(logs.some((l) => /prêt .*cpu.*A, B4, B1/.test(l))).toBe(true);

    const out = path.join(tmp, 'out', 'l1.wav');
    fs.mkdirSync(path.dirname(out));
    const r = await s.synth('Quel contre de Wembanyama !', 'B4', out);
    expect(r).toEqual({ duration: 1.8, sampleRate: 24000 });
    expect(fs.readFileSync(out, 'utf8')).toBe('RIFF B4 French Quel contre de Wembanyama !');

    const e = await s.embed(out, [
      [0, 2.5],
      [3, 3.2],
      [4, 4.3],
    ]);
    expect(e.embeddings).toHaveLength(3);
    expect(e.embeddings[0]).toHaveLength(192);
    expect(e.embeddings[1]).toBeNull();
    expect(e.f0).toEqual([118.5, null, 118.5]);

    await s.close();
    await expect(s.synth('Encore', 'A', out)).rejects.toThrow(/fermée/);
  });

  it('erreurs du moteur remontées, la session reste utilisable', async () => {
    const s = await VoiceSession.open();
    const out = path.join(tmp, 'x.wav');
    await expect(s.synth('une erreur', 'A', out)).rejects.toThrow('voix : synthèse ratée après 2 essais');
    await expect(s.synth('Bonsoir', 'Q', out)).rejects.toThrow('voix inconnue : Q');
    await expect(s.embed(path.join(tmp, 'absent.ogg'), [[0, 1]])).rejects.toThrow('fichier audio introuvable');
    expect((await s.synth('Bonsoir', 'A', out)).sampleRate).toBe(24000);
    await s.close();
  });

  it('interruption : requête rejetée, moteur arrêté', async () => {
    const s = await VoiceSession.open();
    const pid = Number(fs.readFileSync(path.join(tmp, 'worker.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    const ac = new AbortController();
    const p = s.synth('lent', 'A', path.join(tmp, 'lent.wav'), ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow(/interrompue/);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
    await expect(s.synth('Bonsoir', 'A', path.join(tmp, 'x.wav'))).rejects.toThrow(/fermée/);
    // Signal déjà levé : rien n'est envoyé.
    const ac2 = new AbortController();
    ac2.abort();
    await expect(VoiceSession.open(ac2.signal)).rejects.toThrow(/interrompu/);
  });

  it('chargement : erreur du modèle, délai sans nouvelles, interruption, délai relancé par les journaux', async () => {
    process.env.TTS_MODEL = 'casse';
    await expect(VoiceSession.open()).rejects.toThrow('voix : modèle introuvable');

    process.env.TTS_MODEL = 'muet';
    process.env.TTS_LOAD_TIMEOUT_MS = '300';
    await expect(VoiceSession.open()).rejects.toThrow(/pas prêt/);
    const pid = Number(fs.readFileSync(path.join(tmp, 'worker.pid'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });

    process.env.TTS_LOAD_TIMEOUT_MS = '60000';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(VoiceSession.open(ac.signal)).rejects.toThrow(/interrompu/);

    // 600 ms de « téléchargement » avec une ligne toutes les 100 ms : jamais 300 ms de silence.
    process.env.TTS_MODEL = 'lent-mais-vivant';
    process.env.TTS_LOAD_TIMEOUT_MS = '300';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const s = await VoiceSession.open();
    expect(s.voices).toEqual(['A', 'B4', 'B1']);
    await s.close();
  });

  it('Python introuvable : erreur explicite, sans attente', async () => {
    process.env.TTS_PYTHON = path.join(tmp, 'nexiste', 'python');
    await expect(VoiceSession.open()).rejects.toThrow(/démarrage impossible/);
  });

  it('doublage désactivé : open refuse', async () => {
    process.env.DUB_DISABLED = '1';
    await expect(VoiceSession.open()).rejects.toThrow(/DUB_DISABLED/);
  });
});
