/**
 * Voix du doublage par l'API MiniMax (synthèse vocale en ligne, voix
 * françaises du catalogue MiniMax), à la place de Qwen3-TTS embarqué.
 *
 * Choisi par `TTS_ENGINE=minimax`, ou dès qu'une clé MiniMax est donnée —
 * page Paramètres (prioritaire) ou `MINIMAX_API_KEY` (voir `voiceConfig`,
 * voiceAi.ts). Modèle et voix aussi réglables dans la page Paramètres. La synthèse ne touche plus la carte
 * graphique : le doublage n'attend plus la fin des traductions. L'analyse
 * des voix (empreintes ECAPA, hauteur, genre), qui répartit les répliques
 * entre les commentateurs, reste locale : `voice_worker.py --embed-only`,
 * sur le processeur par défaut (`TTS_EMBED_DEVICE`).
 *
 *   POST {MINIMAX_API_URL}/v1/t2a_v2   une réplique → WAV mono 24 kHz
 *   POST {MINIMAX_API_URL}/v1/get_voice   à l'ouverture : clé vérifiée, voix du catalogue contrôlées
 *
 * Voix : A commentateur, B4 consultant, B1 troisième voix, F voix féminine
 * (rôles de dub.ts), chacune réglable (`MINIMAX_VOICE_A`…) ; une voix vide
 * est retirée (le doublage se replie sur une autre, voir `voiceFor`).
 */
import fs from 'node:fs';
import { MINIMAX_DEFAULT_MODEL, MINIMAX_DEFAULT_VOICES, MINIMAX_ROLES, type MinimaxRole } from './minimaxCatalog';
import { getSetting, savedMinimaxVoices, SETTING_KEYS } from './settings';

export { MINIMAX_DEFAULT_MODEL, MINIMAX_DEFAULT_VOICES };
export const MINIMAX_DEFAULT_URL = 'https://api.minimax.io';
const SAMPLE_RATE = 24_000;

export interface MinimaxConfig {
  url: string;
  key: string;
  model: string;
  /** Rôle → voice_id MiniMax (rôles sans voix retirés). */
  voices: Record<string, string>;
  /** Débit de parole (0,5 à 2). */
  speed: number;
}

/** Réglages enregistrés dans la page Paramètres (prioritaires sur les variables d'environnement). */
function saved(): { key: string | null; model: string | null; voices: Partial<Record<MinimaxRole, string>> } {
  try {
    return { key: getSetting(SETTING_KEYS.minimaxApiKey), model: getSetting(SETTING_KEYS.minimaxModel), voices: savedMinimaxVoices() };
  } catch {
    return { key: null, model: null, voices: {} }; // base illisible : variables d'environnement
  }
}

export function minimaxConfig(): MinimaxConfig {
  const s = saved();
  const voices: Record<string, string> = {};
  for (const role of MINIMAX_ROLES) {
    const v = (s.voices[role] ?? process.env[`MINIMAX_VOICE_${role}`] ?? MINIMAX_DEFAULT_VOICES[role]).trim();
    if (v) voices[role] = v;
  }
  const speed = Number(process.env.MINIMAX_TTS_SPEED);
  return {
    url: (process.env.MINIMAX_API_URL?.trim() || MINIMAX_DEFAULT_URL).replace(/\/+$/, ''),
    key: s.key?.trim() || process.env.MINIMAX_API_KEY?.trim() || '',
    model: s.model?.trim() || process.env.MINIMAX_TTS_MODEL?.trim() || MINIMAX_DEFAULT_MODEL,
    voices,
    speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1,
  };
}

/** Analyse des voix locale (session `--embed-only` de voiceAi.ts). */
export interface Embedder {
  embed(
    file: string,
    segments: [number, number][],
    signal?: AbortSignal,
  ): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[]; female?: (number | null)[] }>;
  close(): Promise<void>;
}

interface ApiReply {
  data?: { audio?: string; status?: number } | null;
  extra_info?: { audio_length?: number; audio_sample_rate?: number };
  system_voice?: { voice_id?: string }[] | null;
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Erreur de l'API ; `retry` : passagère (débit, délai, serveur), à retenter ; `fatal` : clé refusée ou crédit épuisé. */
class MinimaxError extends Error {
  constructor(
    message: string,
    public retry: boolean,
    public fatal = false,
  ) {
    super(message);
  }
}

/** Codes passagers : erreur inconnue, délai, débit (requêtes, jetons). */
const RETRY_CODES = new Set([1000, 1001, 1002, 1039]);
const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Délais entre deux essais (ms) ; `MINIMAX_RETRY_MS` (liste séparée par des virgules) pour les tests. */
function retryDelays(): number[] {
  const raw = process.env.MINIMAX_RETRY_MS;
  const list = raw?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return list?.length ? list : [2_000, 5_000, 15_000];
}

async function call(cfg: MinimaxConfig, route: string, body: unknown, signal?: AbortSignal, timeoutMs = 60_000): Promise<ApiReply> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new MinimaxError('requête interrompue', false);
    throw new MinimaxError(`MiniMax injoignable (${short(e)})`, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new MinimaxError(`MiniMax : clé refusée (HTTP ${res.status})`, false, true);
  if (!res.ok) throw new MinimaxError(`MiniMax : HTTP ${res.status} ${text.slice(0, 120)}`, res.status === 429 || res.status >= 500);
  let reply: ApiReply;
  try {
    reply = JSON.parse(text) as ApiReply;
  } catch {
    throw new MinimaxError('MiniMax : réponse illisible', true);
  }
  const code = reply.base_resp?.status_code ?? 0;
  if (code !== 0) {
    const msg = reply.base_resp?.status_msg || 'erreur';
    const what = code === 1004 ? 'clé refusée' : code === 1008 ? 'crédit épuisé' : msg;
    throw new MinimaxError(`MiniMax : ${what} (code ${code}${what === msg ? '' : ` : ${msg}`})`, RETRY_CODES.has(code), code === 1004 || code === 1008);
  }
  return reply;
}

/** Appel retenté sur les erreurs passagères (débit dépassé, délai, serveur). */
async function callWithRetry(cfg: MinimaxConfig, route: string, body: unknown, signal?: AbortSignal): Promise<ApiReply> {
  const delays = retryDelays();
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(cfg, route, body, signal);
    } catch (e) {
      if (!(e instanceof MinimaxError) || !e.retry || attempt >= delays.length || signal?.aborted) throw e;
      await sleep(delays[attempt], signal);
    }
  }
}

/**
 * WAV PCM 16 bits mono : `audio` tel quel s'il a déjà un en-tête RIFF,
 * sinon (PCM brut) un en-tête est ajouté. Rend le fichier et sa durée (s).
 */
export function toWav(audio: Buffer, sampleRate = SAMPLE_RATE): { wav: Buffer; duration: number; sampleRate: number } {
  if (audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') {
    let channels = 1;
    let sr = sampleRate;
    let bits = 16;
    let dataBytes = 0;
    // Parcours des blocs : « fmt » donne le format, « data » la taille (bornée au fichier reçu).
    for (let off = 12; off + 8 <= audio.length; ) {
      const id = audio.toString('ascii', off, off + 4);
      const size = audio.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 24 <= audio.length) {
        channels = audio.readUInt16LE(off + 10) || 1;
        sr = audio.readUInt32LE(off + 12) || sampleRate;
        bits = audio.readUInt16LE(off + 22) || 16;
      } else if (id === 'data') {
        dataBytes = Math.min(size, audio.length - off - 8);
        break;
      }
      off += 8 + size + (size % 2);
    }
    return { wav: audio, duration: dataBytes / (sr * channels * (bits / 8)), sampleRate: sr };
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(audio.length, 40);
  return { wav: Buffer.concat([header, audio]), duration: audio.length / (sampleRate * 2), sampleRate };
}

/**
 * Ton d'un moment fort (emphase des sous-titres, 0 à 2) : 2 → « surprised »
 * (exclamation, action qui emballe le commentateur), 1 → « happy » (voix
 * enjouée). 0 : rien d'imposé. `MINIMAX_EMOTIONS=0` désactive.
 */
export function minimaxEmotion(emphasis: number | undefined): 'surprised' | 'happy' | null {
  if (process.env.MINIMAX_EMOTIONS === '0') return null;
  return (emphasis ?? 0) >= 2 ? 'surprised' : (emphasis ?? 0) >= 1 ? 'happy' : null;
}

function emotionField(emphasis: number | undefined): { emotion?: string } {
  const e = minimaxEmotion(emphasis);
  return e ? { emotion: e } : {};
}

/** Session de voix MiniMax : même contrat que `VoiceSession` (voiceAi.ts). */
export class MinimaxVoiceSession {
  private closed = false;

  private constructor(
    private readonly cfg: MinimaxConfig,
    private embedder: Embedder | null,
  ) {}

  /** Rôles disponibles ('A', 'B4', 'B1', 'F'). */
  get voices(): string[] {
    return Object.keys(this.cfg.voices);
  }

  /**
   * Clé vérifiée et voix contrôlées dans le catalogue (`get_voice`, gratuit),
   * puis analyse des voix locale ouverte. Une clé refusée fait échouer
   * l'ouverture ; une analyse des voix indisponible non (toutes les
   * répliques prennent alors la voix du commentateur).
   */
  static async open(signal: AbortSignal | undefined, openEmbedder: (signal?: AbortSignal) => Promise<Embedder>): Promise<MinimaxVoiceSession> {
    const cfg = minimaxConfig();
    if (!cfg.key) throw new Error('clé MiniMax absente (MINIMAX_API_KEY)');
    if (!Object.keys(cfg.voices).length) throw new Error('aucune voix MiniMax configurée (MINIMAX_VOICE_A…)');
    try {
      const r = await callWithRetry(cfg, '/v1/get_voice', { voice_type: 'system' }, signal);
      const known = new Set((r.system_voice ?? []).map((v) => v.voice_id));
      const missing = Object.entries(cfg.voices).filter(([, id]) => known.size && !known.has(id));
      for (const [role, id] of missing) console.error(`[voix] MiniMax : voix ${id} (${role}) absente du catalogue, la synthèse risque d'échouer`);
    } catch (e) {
      if (e instanceof MinimaxError && e.fatal) throw e; // clé refusée, crédit épuisé
      if (signal?.aborted) throw new Error('ouverture des voix interrompue');
      console.error(`[voix] MiniMax : catalogue des voix illisible (${short(e)}), on continue`);
    }
    let embedder: Embedder | null = null;
    try {
      embedder = await openEmbedder(signal);
    } catch (e) {
      if (signal?.aborted) throw new Error('ouverture des voix interrompue');
      console.error(`[voix] analyse des voix indisponible (${short(e)}) : une seule voix pour tout le match`);
    }
    console.log(`[voix] MiniMax prêt (${cfg.model}, voix ${Object.entries(cfg.voices).map(([r, id]) => `${r}=${id}`).join(', ')})`);
    return new MinimaxVoiceSession(cfg, embedder);
  }

  /**
   * Synthétise `text` dans la voix du rôle `voice` vers `outFile` (WAV mono
   * PCM 16 bits, 24 kHz). Moment fort (`emphasis`, voir `minimaxEmotion`) :
   * ton imposé ; sinon le modèle choisit d'après le texte.
   */
  async synth(
    text: string,
    voice: string,
    outFile: string,
    signal?: AbortSignal,
    o: { emphasis?: number } = {},
  ): Promise<{ duration: number; sampleRate: number }> {
    if (this.closed) throw new Error('session de voix fermée');
    const voiceId = this.cfg.voices[voice];
    if (!voiceId) throw new Error(`voix inconnue : ${voice}`);
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('texte vide');
    const r = await callWithRetry(
      this.cfg,
      '/v1/t2a_v2',
      {
        model: this.cfg.model,
        text: clean,
        stream: false,
        language_boost: 'French',
        output_format: 'hex',
        voice_setting: { voice_id: voiceId, speed: this.cfg.speed, vol: 1, pitch: 0, ...emotionField(o.emphasis) },
        audio_setting: { sample_rate: SAMPLE_RATE, format: 'wav', channel: 1 },
      },
      signal,
    );
    const hex = r.data?.audio;
    if (!hex || typeof hex !== 'string') throw new Error('MiniMax : réponse sans audio');
    const { wav, duration, sampleRate } = toWav(Buffer.from(hex, 'hex'), r.extra_info?.audio_sample_rate || SAMPLE_RATE);
    if (!(duration > 0)) throw new Error('MiniMax : audio vide');
    fs.writeFileSync(outFile, wav);
    return { duration: Math.round(duration * 1000) / 1000, sampleRate };
  }

  embed(
    file: string,
    segments: [number, number][],
    signal?: AbortSignal,
  ): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[]; female?: (number | null)[] }> {
    if (!this.embedder) return Promise.reject(new Error('analyse des voix indisponible'));
    return this.embedder.embed(file, segments, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    const e = this.embedder;
    this.embedder = null;
    await e?.close();
  }
}
