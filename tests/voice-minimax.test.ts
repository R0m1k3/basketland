import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVoiceSession, voiceConfig, voiceEngineName, voiceUsesGpu } from '../src/lib/voiceAi';
import { MINIMAX_DEFAULT_VOICES, minimaxConfig, MinimaxVoiceSession, toWav, type Embedder } from '../src/lib/voiceMinimax';
import { settingSet } from '../src/lib/db';
import { freshDb } from './helpers/db';

/**
 * Voix du doublage par l'API MiniMax : l'API est simulée (fetch remplacé),
 * l'analyse des voix locale par le faux moteur (tests/helpers/fakeVoiceWorker.mjs).
 */

const FAKE = path.join(__dirname, 'helpers', 'fakeVoiceWorker.mjs');
const ENV = [
  'MINIMAX_API_KEY',
  'MINIMAX_API_URL',
  'MINIMAX_TTS_MODEL',
  'MINIMAX_TTS_SPEED',
  'MINIMAX_RETRY_MS',
  'MINIMAX_VOICE_A',
  'MINIMAX_VOICE_B4',
  'MINIMAX_VOICE_B1',
  'MINIMAX_VOICE_F',
  'TTS_ENGINE',
  'TTS_EMBED_DEVICE',
  'TTS_DEVICE',
  'TTS_PYTHON',
  'TTS_WORKER',
  'VOICES_DIR',
  'MODELS_DIR',
  'DUB_DISABLED',
];
let tmp: string;

/** WAV PCM 16 bits mono 24 kHz de `sec` secondes. */
function wav(sec: number): Buffer {
  return toWav(Buffer.alloc(Math.round(sec * 24_000) * 2)).wav;
}

interface Sent {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** fetch simulé : `reply(route, body)` donne { status?, json }. */
function mockApi(reply: (route: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ url, auth: new Headers(init.headers).get('authorization'), body });
      const r = reply(new URL(url).pathname, body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }),
  );
  return sent;
}

const ok = { base_resp: { status_code: 0, status_msg: 'success' } };
const catalog = { ...ok, system_voice: Object.values(MINIMAX_DEFAULT_VOICES).map((voice_id) => ({ voice_id })) };
const speech = (sec: number) => ({ ...ok, data: { audio: wav(sec).toString('hex'), status: 2 }, extra_info: { audio_length: sec * 1000, audio_sample_rate: 24000 } });
const noEmbedder = async (): Promise<Embedder> => Promise.reject(new Error('pas de Python en test'));

beforeEach(() => {
  freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-minimax-'));
  process.env.MODELS_DIR = path.join(tmp, 'models');
  process.env.MINIMAX_RETRY_MS = '0,0,0';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('choix du moteur et réglages', () => {
  it('MiniMax dès qu’une clé est définie (analyse des voix sur le processeur), sinon Qwen3-TTS ; TTS_ENGINE l’emporte', () => {
    expect(voiceEngineName()).toBe('local');
    expect(voiceUsesGpu()).toBe(true);
    process.env.MINIMAX_API_KEY = 'cle';
    expect(voiceEngineName()).toBe('minimax');
    expect(voiceConfig()).toMatchObject({ engine: 'minimax', device: 'cpu' });
    expect(voiceConfig().disabledReason).toBeUndefined();
    expect(voiceUsesGpu()).toBe(false);
    process.env.TTS_EMBED_DEVICE = 'cuda';
    expect(voiceUsesGpu()).toBe(true);
    process.env.TTS_ENGINE = 'local';
    expect(voiceEngineName()).toBe('local');
    process.env.TTS_ENGINE = 'minimax';
    delete process.env.MINIMAX_API_KEY;
    expect(voiceConfig().disabledReason).toMatch(/MINIMAX_API_KEY/);
  });

  it('voix françaises du catalogue par défaut, réglables ; une voix vide est retirée', () => {
    expect(minimaxConfig()).toMatchObject({
      url: 'https://api.minimax.io',
      model: 'speech-2.8-hd',
      speed: 1,
      voices: { A: 'French_Male_Speech_New', B4: 'French_MaleNarrator', B1: 'French_CasualMan', F: 'French_FemaleAnchor' },
    });
    Object.assign(process.env, { MINIMAX_VOICE_F: '', MINIMAX_VOICE_A: 'French_CasualMan', MINIMAX_TTS_SPEED: '1.1', MINIMAX_API_URL: 'https://api-uw.minimax.io/' });
    const c = minimaxConfig();
    expect(c.voices).toEqual({ A: 'French_CasualMan', B4: 'French_MaleNarrator', B1: 'French_CasualMan' });
    expect(c).toMatchObject({ speed: 1.1, url: 'https://api-uw.minimax.io' });
    process.env.MINIMAX_TTS_SPEED = '5';
    expect(minimaxConfig().speed).toBe(1);
  });
});

describe('réglages de la page Paramètres', () => {
  it('clé, modèle et voix enregistrés : prioritaires sur les variables d’environnement, et activent MiniMax', () => {
    Object.assign(process.env, { MINIMAX_API_KEY: 'cle-variable', MINIMAX_TTS_MODEL: 'speech-2.6-hd', MINIMAX_VOICE_B4: 'French_CasualMan' });
    settingSet('minimax_api_key', 'cle-page');
    settingSet('minimax_tts_model', 'speech-2.8-turbo');
    settingSet('minimax_voices', JSON.stringify({ A: 'French_MaleNarrator' }));
    expect(minimaxConfig()).toMatchObject({
      key: 'cle-page',
      model: 'speech-2.8-turbo',
      voices: { A: 'French_MaleNarrator', B4: 'French_CasualMan', B1: 'French_CasualMan', F: 'French_FemaleAnchor' },
    });
    delete process.env.MINIMAX_API_KEY;
    expect(voiceEngineName()).toBe('minimax'); // clé de la page seule
    settingSet('minimax_api_key', null);
    expect(voiceEngineName()).toBe('local');
  });
});

describe('MinimaxVoiceSession (API simulée)', () => {
  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'cle-secrete';
  });

  it('ouverture (clé vérifiée par get_voice), synthèse d’une réplique en WAV 24 kHz dans la voix du rôle', async () => {
    const sent = mockApi((route) => (route === '/v1/get_voice' ? { json: catalog } : { json: speech(1.5) }));
    const s = await MinimaxVoiceSession.open(undefined, noEmbedder);
    expect(s.voices).toEqual(['A', 'B4', 'B1', 'F']);
    const out = path.join(tmp, 'l1.wav');
    const r = await s.synth('  Quel contre   de Wembanyama !', 'B4', out);
    expect(r).toEqual({ duration: 1.5, sampleRate: 24000 });
    expect(fs.readFileSync(out).toString('ascii', 0, 4)).toBe('RIFF');
    expect(sent.map((x) => new URL(x.url).pathname)).toEqual(['/v1/get_voice', '/v1/t2a_v2']);
    expect(sent[1].auth).toBe('Bearer cle-secrete');
    expect(sent[1].body).toMatchObject({
      model: 'speech-2.8-hd',
      text: 'Quel contre de Wembanyama !',
      stream: false,
      language_boost: 'French',
      output_format: 'hex',
      voice_setting: { voice_id: 'French_MaleNarrator', speed: 1 },
      audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 },
    });
    await expect(s.synth('x', 'Z', out)).rejects.toThrow(/voix inconnue/);
    // Pas d'analyse des voix : l'empreinte échoue (le doublage garde alors une seule voix).
    await expect(s.embed(out, [[0, 1]])).rejects.toThrow(/analyse des voix indisponible/);
    await s.close();
    await expect(s.synth('Bonsoir.', 'A', out)).rejects.toThrow(/fermée/);
  });

  it('PCM brut : en-tête WAV ajouté ; débit dépassé (1002) puis succès : retenté', async () => {
    let calls = 0;
    mockApi((route) => {
      if (route === '/v1/get_voice') return { json: catalog };
      if (++calls === 1) return { json: { base_resp: { status_code: 1002, status_msg: 'rate limit' } } };
      return { json: { ...ok, data: { audio: Buffer.alloc(48_000).toString('hex') }, extra_info: { audio_sample_rate: 24000 } } };
    });
    const s = await MinimaxVoiceSession.open(undefined, noEmbedder);
    const out = path.join(tmp, 'pcm.wav');
    expect(await s.synth('Bonsoir.', 'A', out)).toEqual({ duration: 1, sampleRate: 24000 });
    expect(calls).toBe(2);
    const w = fs.readFileSync(out);
    expect(w.toString('ascii', 0, 4)).toBe('RIFF');
    expect(w.length).toBe(48_044);
  });

  it('clé refusée ou crédit épuisé : l’ouverture échoue avec la raison ; catalogue illisible : on continue', async () => {
    mockApi(() => ({ json: { base_resp: { status_code: 1004, status_msg: 'login fail' } } }));
    await expect(MinimaxVoiceSession.open(undefined, noEmbedder)).rejects.toThrow(/clé refusée \(code 1004/);
    mockApi(() => ({ status: 401, json: {} }));
    await expect(MinimaxVoiceSession.open(undefined, noEmbedder)).rejects.toThrow(/clé refusée \(HTTP 401\)/);
    mockApi((route) => (route === '/v1/get_voice' ? { status: 404, json: {} } : { json: speech(1) }));
    const s = await MinimaxVoiceSession.open(undefined, noEmbedder);
    expect(s.voices).toHaveLength(4);
    mockApi(() => ({ json: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } } }));
    await expect(s.synth('Bonsoir.', 'A', path.join(tmp, 'x.wav'))).rejects.toThrow(/crédit épuisé/);
  });

  it('voix absente du catalogue : signalée dans le journal, pas bloquante', async () => {
    process.env.MINIMAX_VOICE_A = 'French_Inconnue';
    mockApi(() => ({ json: catalog }));
    const err = vi.mocked(console.error);
    await MinimaxVoiceSession.open(undefined, noEmbedder);
    expect(err.mock.calls.some(([m]) => String(m).includes('French_Inconnue'))).toBe(true);
  });

  it('bout en bout : openVoiceSession avec MiniMax, analyse des voix par le moteur local (--embed-only)', async () => {
    const voices = path.join(tmp, 'voices');
    fs.mkdirSync(voices);
    Object.assign(process.env, { TTS_PYTHON: process.execPath, TTS_WORKER: FAKE, VOICES_DIR: voices });
    mockApi((route) => (route === '/v1/get_voice' ? { json: catalog } : { json: speech(2) }));
    const s = await openVoiceSession();
    expect(s.voices).toEqual(['A', 'B4', 'B1', 'F']);
    const audio = path.join(tmp, 'src.ogg');
    fs.writeFileSync(audio, 'x');
    const e = await s.embed(audio, [[0, 2]]);
    expect(e.embeddings[0]).toHaveLength(192);
    expect(await s.synth('Bonsoir.', 'F', path.join(tmp, 'f.wav'))).toEqual({ duration: 2, sampleRate: 24000 });
    await s.close();
  });
});

describe('toWav', () => {
  it('lit la durée d’un WAV existant, même avec une taille de données exagérée (flux)', () => {
    expect(toWav(wav(0.5)).duration).toBeCloseTo(0.5, 5);
    const w = wav(0.25);
    w.writeUInt32LE(0xffffffff, 40);
    expect(toWav(w).duration).toBeCloseTo(0.25, 5);
  });
});
