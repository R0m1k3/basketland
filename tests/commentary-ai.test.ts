import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUserMessage,
  commentaryConfig,
  parseTranslation,
  ServiceError,
  transcribeAudio,
  translateBatch,
  TRANSLATE_SYSTEM_PROMPT,
  translateSystemPrompt,
  validTranslation,
  whisperPrompt,
} from '../src/lib/commentaryAi';

const ENV = ['TRANSCRIBE_URL', 'TRANSLATE_URL', 'TRANSCRIBE_MODEL', 'TRANSLATE_MODEL', 'TRANSLATE_BATCH', 'COMMENTARY_DISABLED', 'TRANSLATE_PROMPT_FILE'];

function setEnv(): void {
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1/';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
}

/** Faux serveur : chaque appel à fetch passe par `handler`. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatRes = (content: string) => jsonRes({ choices: [{ message: { role: 'assistant', content } }] });

/** Lignes du lot demandées dans le message utilisateur. */
function requestedLines(init: RequestInit): { i: number; en: string }[] {
  const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
  const user = body.messages.find((m) => m.role === 'user')!.content;
  const m = /Lignes à traduire :\n(\{.*\})/.exec(user)!;
  return (JSON.parse(m[1]) as { lignes: { i: number; en: string }[] }).lignes;
}

describe('configuration', () => {
  beforeEach(() => ENV.forEach((k) => delete process.env[k]));
  afterEach(() => ENV.forEach((k) => delete process.env[k]));

  it('inactive avec une raison claire tant qu’une URL manque', () => {
    expect(commentaryConfig().disabledReason).toMatch(/TRANSCRIBE_URL, TRANSLATE_URL/);
    process.env.TRANSCRIBE_URL = 'http://x:8000/v1';
    expect(commentaryConfig().disabledReason).toMatch(/serveur de traduction non configuré \(TRANSLATE_URL\)/);
    process.env.TRANSLATE_URL = 'http://x:11434/v1';
    expect(commentaryConfig().disabledReason).toBeNull();
    process.env.COMMENTARY_DISABLED = '1';
    expect(commentaryConfig().disabledReason).toMatch(/COMMENTARY_DISABLED=1/);
  });

  it('modèles et taille de lot par défaut, surchargeables', () => {
    setEnv();
    const c = commentaryConfig();
    expect(c).toMatchObject({ transcribeUrl: 'http://gpu.local:8000/v1', transcribeModel: 'Systran/faster-distil-whisper-large-v3', translateModel: 'mistral-nemo:12b', batch: 20 });
    process.env.TRANSLATE_MODEL = 'qwen3:14b';
    process.env.TRANSLATE_BATCH = '999';
    expect(commentaryConfig()).toMatchObject({ translateModel: 'qwen3:14b', batch: 60 });
  });

  it('prompt système remplaçable par un fichier', () => {
    expect(translateSystemPrompt()).toBe(TRANSLATE_SYSTEM_PROMPT);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-prompt-')), 'prompt.txt');
    fs.writeFileSync(f, 'Traduis, point.');
    process.env.TRANSLATE_PROMPT_FILE = f;
    expect(translateSystemPrompt()).toBe('Traduis, point.');
    process.env.TRANSLATE_PROMPT_FILE = '/nexiste/pas';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(translateSystemPrompt()).toBe(TRANSLATE_SYSTEM_PROMPT);
  });
});

describe('transcription (faux serveur speaches)', () => {
  let file: string;
  beforeEach(() => {
    setEnv();
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-asr-')), 'chunk-000.ogg');
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ENV.forEach((k) => delete process.env[k]);
  });

  it('envoie le multipart attendu et lit verbose_json avec words', async () => {
    const calls = fakeFetch(() =>
      jsonRes({
        task: 'transcribe',
        language: 'english',
        duration: 4.2,
        text: ' Curry from deep. Bang!',
        segments: [{ id: 0, seek: 0, start: 0.4, end: 2.1, text: ' Curry from deep. Bang!', tokens: [], temperature: 0, avg_logprob: -0.18, compression_ratio: 1.2, no_speech_prob: 0.02 }],
        words: [
          { word: ' Curry', start: 0.4, end: 0.8 },
          { word: ' from', start: 0.8, end: 1.0 },
          { word: ' deep.', start: 1.0, end: 1.4 },
          { word: ' Bang!', start: 1.6, end: 2.1 },
        ],
      }),
    );
    const t = await transcribeAudio(file, commentaryConfig(), { prompt: 'NBA basketball game commentary.' });
    expect(calls[0].url).toBe('http://gpu.local:8000/v1/audio/transcriptions');
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('Systran/faster-distil-whisper-large-v3');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
    expect(form.get('prompt')).toBe('NBA basketball game commentary.');
    expect((form.get('file') as File).name).toBe('chunk-000.ogg');
    expect(t.words).toHaveLength(4);
    expect(t.segments[0]).toMatchObject({ start: 0.4, end: 2.1, no_speech_prob: 0.02 });
  });

  it('tolère une réponse sans words', async () => {
    fakeFetch(() => jsonRes({ text: ' Timeout.', segments: [{ id: 0, start: 1, end: 1.8, text: ' Timeout.', avg_logprob: -0.3, compression_ratio: 0.9, no_speech_prob: 0.1 }] }));
    const t = await transcribeAudio(file, commentaryConfig());
    expect(t.words).toEqual([]);
    expect(t.segments).toHaveLength(1);
  });

  it('serveur injoignable → ServiceError lisible après un nouvel essai', async () => {
    const calls = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const e = (await transcribeAudio(file, commentaryConfig(), { retryDelayMs: 0 }).catch((x: unknown) => x)) as ServiceError;
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.message).toBe('serveur de transcription injoignable (http://gpu.local:8000/v1) : ECONNREFUSED');
    expect(calls).toHaveLength(2);
  });

  it('erreur 4xx (modèle inconnu) : pas de nouvel essai', async () => {
    const calls = fakeFetch(() => new Response('{"detail":"Model not found"}', { status: 404 }));
    await expect(transcribeAudio(file, commentaryConfig())).rejects.toThrow(/HTTP 404 — \{"detail":"Model not found"\}/);
    expect(calls).toHaveLength(1);
  });

  it('prompt Whisper : équipes puis joueurs, tronqué', () => {
    expect(whisperPrompt('Los Angeles Lakers', 'Portland Trail Blazers', ['LeBron James', 'Deni Avdija'])).toBe(
      'NBA basketball game commentary: Portland Trail Blazers at Los Angeles Lakers. LeBron James, Deni Avdija.',
    );
    expect(whisperPrompt('A', 'B', Array.from({ length: 100 }, (_, i) => `Player Number${i}`)).length).toBeLessThanOrEqual(601);
  });
});

describe('analyse des réponses du LLM', () => {
  it('lit le JSON nu, entouré de texte, en bloc ``` ou après un <think>', () => {
    const want = new Map([
      [1, 'Il tire à trois points.'],
      [2, 'Dedans !'],
    ]);
    const j = '{"t":[{"i":1,"fr":"Il tire à trois points."},{"i":2,"fr":"Dedans !"}]}';
    expect(parseTranslation(j)).toEqual(want);
    expect(parseTranslation(`Voici la traduction :\n${j}\nBonne lecture.`)).toEqual(want);
    expect(parseTranslation(`\`\`\`json\n${j}\n\`\`\``)).toEqual(want);
    expect(parseTranslation(`<think>hmm {"t":[]}</think>\n${j}`)).toEqual(want);
    expect(parseTranslation('[{"id":1,"fr":"Il tire à trois points."},{"id":2,"text":"Dedans !"}]')).toEqual(want);
    expect(parseTranslation('pas de JSON ici').size).toBe(0);
  });

  it('valide la longueur et le contenu', () => {
    expect(validTranslation('Bang!', 'Dedans !')).toBe(true);
    expect(validTranslation('Bang!', '')).toBe(false);
    expect(validTranslation('Bang!', '...')).toBe(false);
    expect(validTranslation('Bang!', 'Dedans ! '.repeat(10))).toBe(false);
    expect(validTranslation('Bang!', '{"i": 3, "fr": "x"}')).toBe(false);
  });

  it('message utilisateur : contexte à ne pas traduire, lignes en JSON, /no_think pour Qwen3', () => {
    const m = buildUserMessage([{ i: 5, en: 'Timeout Portland.' }], ['He drives.', 'Fouled.'], 'qwen3:14b', 'LeBron James');
    expect(m).toContain('Noms propres du match : LeBron James');
    expect(m).toContain('NE PAS traduire');
    expect(m).toContain('- He drives.');
    expect(m).toContain('{"lignes":[{"i":5,"en":"Timeout Portland."}]}');
    expect(m.endsWith('/no_think')).toBe(true);
    expect(buildUserMessage([{ i: 5, en: 'x' }], [], 'mistral-nemo:12b')).not.toContain('/no_think');
  });
});

describe('traduction par lots (faux serveur Ollama)', () => {
  beforeEach(setEnv);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ENV.forEach((k) => delete process.env[k]);
  });

  const lines = [
    { i: 1, en: 'He pulls up from deep.' },
    { i: 2, en: 'Bang!' },
    { i: 3, en: 'Timeout Portland.' },
  ];
  const FR: Record<number, string> = { 1: 'Il déclenche de loin.', 2: 'Dedans !', 3: 'Temps mort Portland.' };

  it('lot valide : une seule requête, au bon format', async () => {
    const calls = fakeFetch((_u, init) => chatRes(JSON.stringify({ t: requestedLines(init).map((l) => ({ i: l.i, fr: FR[l.i] })) })));
    const out = await translateBatch(lines, ['Jokic with the ball.'], commentaryConfig());
    expect(out).toEqual(lines.map((l) => ({ i: l.i, fr: FR[l.i], untranslated: false })));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gpu.local:11434/v1/chat/completions');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: 'mistral-nemo:12b', stream: false, response_format: { type: 'json_object' } });
    expect(body.messages[0]).toEqual({ role: 'system', content: TRANSLATE_SYSTEM_PROMPT });
    expect(body.messages[1].content).toContain('- Jokic with the ball.');
  });

  it('JSON entouré de texte et de ``` : accepté', async () => {
    fakeFetch((_u, init) => chatRes(`Bien sûr ! \`\`\`json\n${JSON.stringify({ t: requestedLines(init).map((l) => ({ i: l.i, fr: FR[l.i] })) })}\n\`\`\` Voilà.`));
    expect((await translateBatch(lines, [], commentaryConfig())).every((l) => !l.untranslated)).toBe(true);
  });

  it('lot incomplet : nouvel essai pour les lignes manquantes, puis ligne par ligne, puis l’anglais marqué', async () => {
    const asked: number[][] = [];
    fakeFetch((_u, init) => {
      const req = requestedLines(init);
      asked.push(req.map((l) => l.i));
      // La ligne 3 n'est jamais rendue dans un lot ; seule la ligne 2 l'est
      // en ligne-par-ligne… et la ligne 3 reste vide.
      if (req.length > 1) return chatRes(JSON.stringify({ t: req.filter((l) => l.i === 1).map((l) => ({ i: l.i, fr: FR[l.i] })) }));
      if (req[0].i === 2) return chatRes(`{"t":[{"i":2,"fr":"Dedans !"}]}`);
      return chatRes('{"t":[{"i":3,"fr":""}]}');
    });
    const out = await translateBatch(lines, [], commentaryConfig());
    expect(out).toEqual([
      { i: 1, fr: FR[1], untranslated: false },
      { i: 2, fr: 'Dedans !', untranslated: false },
      { i: 3, fr: 'Timeout Portland.', untranslated: true },
    ]);
    // Lot entier, nouvel essai des seules lignes manquantes, puis 2 en solo, 3 en solo deux fois.
    expect(asked).toEqual([[1, 2, 3], [2, 3], [2], [3], [3]]);
  });

  it('réponse illisible : repli sans bloquer le match', async () => {
    fakeFetch(() => chatRes('Désolé, je ne peux pas.'));
    const out = await translateBatch(lines.slice(0, 1), [], commentaryConfig());
    expect(out).toEqual([{ i: 1, fr: 'He pulls up from deep.', untranslated: true }]);
  });

  it('modèle absent d’Ollama : ServiceError explicite', async () => {
    fakeFetch(() => new Response('{"error":{"message":"model \\"mistral-nemo:12b\\" not found, try pulling it first"}}', { status: 404 }));
    await expect(translateBatch(lines, [], commentaryConfig())).rejects.toThrow('modèle de traduction « mistral-nemo:12b » absent d\'Ollama (ollama pull mistral-nemo:12b)');
  });
});
