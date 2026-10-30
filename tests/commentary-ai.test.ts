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
  anchors,
  consistentTranslation,
  whisperPrompt,
  DEFAULT_TRANSLATE_MODEL,
  groupSentences,
  mtPrompt,
  parsePlainTranslation,
  PLAIN_TRANSLATE_PROMPT,
  splitProportional,
  translateBatchMt,
} from '../src/lib/commentaryAi';
import { setSetting } from '../src/lib/settings';
import { freshDb } from './helpers/db';

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

/** Dernier recours en texte brut (une ligne seule, sans JSON) ? */
function isPlain(init: RequestInit): boolean {
  const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
  return body.messages[0].content === PLAIN_TRANSLATE_PROMPT;
}

/** Lignes du lot demandées dans le message utilisateur. */
function requestedLines(init: RequestInit): { i: number; en: string }[] {
  const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
  const user = body.messages.find((m) => m.role === 'user')!.content;
  const m = /\n(\{.*\})/.exec(user)!;
  return (JSON.parse(m[1]) as { lines: { i: number; en: string }[] }).lines;
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
    expect(c).toMatchObject({ transcribeUrl: 'http://gpu.local:8000/v1', transcribeModel: 'deepdml/faster-whisper-large-v3-turbo-ct2', translateModel: 'translategemma:12b', translateEngine: 'chat', batch: 14, parallel: 2, chunkSec: 120 });
    process.env.TRANSLATE_MODEL = 'hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0';
    expect(commentaryConfig().translateEngine).toBe('mt');
    process.env.TRANSLATE_MODEL = 'qwen3:14b';
    process.env.TRANSLATE_BATCH = '999';
    expect(commentaryConfig()).toMatchObject({ translateModel: 'qwen3:14b', translateEngine: 'chat', batch: 60 });
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
    expect(form.get('model')).toBe('deepdml/faster-whisper-large-v3-turbo-ct2');
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
    // Recopie de l'anglais : refusée, sauf ligne très courte.
    expect(validTranslation('He pulls up from deep.', 'He pulls up from deep.')).toBe(false);
    expect(validTranslation('Santos.', 'Santos.')).toBe(true);
  });

  it('noms et chiffres conservés : détecte une ligne décalée', () => {
    expect(anchors('Brunson got a three, Knicks up 19-16.')).toEqual({ numbers: ['19', '16'], names: ['knick'] });
    expect(anchors('The Celtics. He passes to Tatum')).toEqual({ numbers: [], names: ['celti', 'tatum'] });
    expect(consistentTranslation('Knicks up 19-16.', 'Les Knicks mènent 19-16.')).toBe(true);
    expect(consistentTranslation('Knicks up 19-16.', 'Les Knicks mènent 19 à 6.')).toBe(false);
    expect(consistentTranslation('Here is Tatum taking it to the rim.', 'Brunson marque à trois points.')).toBe(false);
    expect(consistentTranslation('Heading to the NBA Finals.', 'En route vers les finales NBA.')).toBe(true);
  });

  it('message utilisateur : contexte à ne pas traduire, lignes en JSON, /no_think pour Qwen3', () => {
    const m = buildUserMessage([{ i: 5, en: 'Timeout Portland.' }], ['He drives.', 'Fouled.'], 'qwen3:14b');
    expect(m).toContain('Traduis ces lignes. Réponds uniquement avec le JSON demandé.\n');
    expect(m).toContain('{"context":["He drives.","Fouled."],"lines":[{"i":5,"en":"Timeout Portland."}]}');
    expect(m.endsWith('/no_think')).toBe(true);
    expect(buildUserMessage([{ i: 5, en: 'x' }], [], 'mistral-nemo:12b')).not.toContain('/no_think');
  });
});

describe('traduction par lots (faux serveur Ollama)', () => {
  // LLM généraliste (moteur 'chat', celui du modèle par défaut Gemma 4 E4B) : lots JSON.
  beforeEach(() => {
    setEnv();
    process.env.TRANSLATE_MODEL = 'mistral-nemo:12b';
  });
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
    expect(body).toMatchObject({ model: 'mistral-nemo:12b', stream: false, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(body.messages[0]).toEqual({ role: 'system', content: TRANSLATE_SYSTEM_PROMPT });
    expect(body.messages[1].content).toContain('"context":["Jokic with the ball."]');
  });

  it('Ollama embarqué : API native /api/chat, num_ctx 4096, schéma JSON pour Gemma 4 E4B', async () => {
    const calls = fakeFetch((_u, init) => jsonRes({ message: { role: 'assistant', content: JSON.stringify({ t: requestedLines(init).map((l) => ({ i: l.i, fr: FR[l.i] })) }) } }));
    const cfg = { ...commentaryConfig(), translateMode: 'embedded' as const, translateModel: 'gemma4:e4b' };
    const out = await translateBatch(lines, [], cfg);
    expect(out.every((l) => !l.untranslated)).toBe(true);
    expect(calls[0].url).toBe('http://gpu.local:11434/api/chat');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: 'gemma4:e4b', stream: false, options: { temperature: 0.2, top_p: 0.9, num_ctx: 4096, num_predict: 1200 } });
    expect(body.format?.required).toEqual(['t']);
    // Gemma 4 12B : pas de schéma imposé (il décale alors des lignes).
    await translateBatch(lines, [], { ...cfg, translateModel: 'gemma4:12b' });
    expect(JSON.parse(String(calls[1].init.body)).format).toBeUndefined();
  });

  it('lot décalé (JSON valide, noms perdus) : nouvel essai à température 0, puis lot coupé en deux', async () => {
    const shiftLines = [
      { i: 1, en: 'Brunson got a three.' },
      { i: 2, en: 'Tatum to the rim.' },
      { i: 3, en: 'Knicks up 19-16.' },
      { i: 4, en: 'Timeout Boston.' },
    ];
    const OK: Record<number, string> = { 1: 'Brunson marque à trois points.', 2: 'Tatum au cercle.', 3: 'Les Knicks mènent 19-16.', 4: 'Temps mort Boston.' };
    const asked: { ids: number[]; temperature: number }[] = [];
    fakeFetch((_u, init) => {
      const req = requestedLines(init);
      asked.push({ ids: req.map((l) => l.i), temperature: JSON.parse(String(init.body)).temperature });
      // Lot de 4 : chaque traduction glisse d'une ligne vers le bas.
      if (req.length === 4) return chatRes(JSON.stringify({ t: req.map((l, k) => ({ i: l.i, fr: k ? OK[req[k - 1].i] : 'Et voilà.' })) }));
      return chatRes(JSON.stringify({ t: req.map((l) => ({ i: l.i, fr: OK[l.i] })) }));
    });
    const out = await translateBatch(shiftLines, [], commentaryConfig());
    expect(out).toEqual(shiftLines.map((l) => ({ i: l.i, fr: OK[l.i], untranslated: false })));
    expect(asked).toEqual([
      { ids: [1, 2, 3, 4], temperature: 0.2 },
      { ids: [1, 2, 3, 4], temperature: 0 },
      { ids: [1, 2], temperature: 0.2 },
      { ids: [3, 4], temperature: 0.2 },
    ]);
  });

  it('JSON entouré de texte et de ``` : accepté', async () => {
    fakeFetch((_u, init) => chatRes(`Bien sûr ! \`\`\`json\n${JSON.stringify({ t: requestedLines(init).map((l) => ({ i: l.i, fr: FR[l.i] })) })}\n\`\`\` Voilà.`));
    expect((await translateBatch(lines, [], commentaryConfig())).every((l) => !l.untranslated)).toBe(true);
  });

  it('lot incomplet : nouvel essai, puis moitiés, puis texte brut, puis l’anglais marqué', async () => {
    const asked: number[][] = [];
    const plain: number[] = [];
    fakeFetch((_u, init) => {
      if (isPlain(init)) {
        plain.push(JSON.parse(String(init.body)).temperature);
        return chatRes('');
      }
      const req = requestedLines(init);
      asked.push(req.map((l) => l.i));
      // Plusieurs lignes : seule la 1 revient. Seule, la 2 revient ; la 3 reste vide.
      if (req.length > 1 || req[0].i === 1) return chatRes(JSON.stringify({ t: req.filter((l) => l.i === 1).map((l) => ({ i: l.i, fr: FR[l.i] })) }));
      if (req[0].i === 2) return chatRes(`{"t":[{"i":2,"fr":"Dedans !"}]}`);
      return chatRes('{"t":[{"i":3,"fr":""}]}');
    });
    const out = await translateBatch(lines, [], commentaryConfig());
    expect(out).toEqual([
      { i: 1, fr: FR[1], untranslated: false },
      { i: 2, fr: 'Dedans !', untranslated: false },
      { i: 3, fr: 'Timeout Portland.', untranslated: true },
    ]);
    // Lot entier ×2, moitié [1,2] ×2 (la 2 manque), puis 1 et 2 seules, moitié [3] ×2.
    expect(asked).toEqual([[1, 2, 3], [1, 2, 3], [1, 2], [1, 2], [1], [2], [3], [3]]);
    // La 3, toujours vide : deux essais en texte brut avant l'anglais.
    expect(plain).toEqual([0.2, 0]);
  });

  it('ligne rebelle en JSON : rattrapée en texte brut (sans response_format, consignes basket, contexte)', async () => {
    const line = { i: 7, en: 'Now Kamara from beyond the arc. And Edie with the board.' };
    const calls = fakeFetch((_u, init) => {
      // Le modèle recopie l'anglais en JSON, mais traduit quand on lui demande la ligne seule.
      if (!isPlain(init)) return chatRes(JSON.stringify({ t: [{ i: 7, fr: line.en }] }));
      return chatRes('Traduction : « Maintenant Kamara derrière l’arc. Et Edey au rebond. »');
    });
    const out = await translateBatch([line], ['Portland brings it up.'], commentaryConfig(), { match: 'Memphis Grizzlies @ Portland Trail Blazers' });
    expect(out).toEqual([{ i: 7, fr: 'Maintenant Kamara derrière l’arc. Et Edey au rebond.', untranslated: false }]);
    expect(calls).toHaveLength(3); // JSON ×2, puis texte brut
    const body = JSON.parse(String(calls[2].init.body));
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].content).toContain('« board » = rebond');
    expect(body.messages[0].content).not.toContain('{"t"');
    expect(body.messages[1].content).toContain('match : Memphis Grizzlies @ Portland Trail Blazers');
    expect(body.messages[1].content).toContain('context (à ne pas traduire) :\nPortland brings it up.');
    expect(body.messages[1].content).toContain(`ligne :\n${line.en}`);
  });

  it('réponse en texte brut : étiquette, guillemets, JSON et refus', () => {
    expect(parsePlainTranslation('Il déclenche de loin.')).toBe('Il déclenche de loin.');
    expect(parsePlainTranslation('<think>…</think>\nFrançais : "Il déclenche de loin."')).toBe('Il déclenche de loin.');
    expect(parsePlainTranslation('```\n« Dedans ! »\n```')).toBe('Dedans !');
    expect(parsePlainTranslation('{"t":[{"i":3,"fr":"Temps mort Portland."}]}')).toBe('Temps mort Portland.');
    expect(parsePlainTranslation('{"fr":"Temps mort Portland."}')).toBe('Temps mort Portland.');
    expect(parsePlainTranslation('Désolé, je ne peux pas.')).toBe('');
    expect(parsePlainTranslation("I'm sorry, I can't help with that.")).toBe('');
    expect(parsePlainTranslation('Désolés pour lui, il rate.')).toBe('Désolés pour lui, il rate.');
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

describe('traduction par un modèle pur (MiLMMT, faux serveur Ollama)', () => {
  beforeEach(setEnv);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ENV.forEach((k) => delete process.env[k]);
  });

  it('gabarit officiel du modèle', () => {
    expect(mtPrompt('Bang!')).toBe('Translate this from English to French:\nEnglish: Bang!\nFrench:');
  });

  it('regroupe les sous-titres en phrases (ponctuation finale, 4 lignes max)', () => {
    const l = (i: number, en: string) => ({ i, en });
    expect(groupSentences([l(1, 'Curry brings it up,'), l(2, 'looks for the screen.'), l(3, 'Bang!')]).map((g) => g.map((x) => x.i))).toEqual([[1, 2], [3]]);
    expect(groupSentences([l(1, 'a'), l(2, 'b'), l(3, 'c'), l(4, 'd'), l(5, 'e')]).map((g) => g.length)).toEqual([4, 1]);
  });

  it('répartit une traduction au prorata, entre deux mots, sans part vide', () => {
    const parts = splitProportional('Curry remonte le ballon, cherche l’écran et déclenche.', [20, 21]);
    expect(parts).toHaveLength(2);
    expect(parts!.every((p) => p.length > 0)).toBe(true);
    expect(parts!.join(' ')).toBe('Curry remonte le ballon, cherche l’écran et déclenche.');
    expect(parts![0].endsWith(',')).toBe(true); // coupe préférée après la ponctuation
    expect(splitProportional('Oui !', [10, 10])).toBeNull();
  });

  it('complétion brute /api/generate, phrase par phrase, puis répartition', async () => {
    const prompts: string[] = [];
    fakeFetch((url, init) => {
      expect(url).toBe('http://gpu.local:11434/api/generate');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: DEFAULT_TRANSLATE_MODEL, raw: true, stream: false, options: { temperature: 0, top_k: 1, stop: ['\n'] } });
      prompts.push(body.prompt);
      const en = /English: (.*)\nFrench:/.exec(body.prompt)![1];
      const fr = en === 'Curry brings it up, looks for the screen.' ? ' Curry remonte la balle, cherche l’écran.' : ' Dedans !';
      return new Response(JSON.stringify({ response: fr, done: true }), { headers: { 'Content-Type': 'application/json' } });
    });
    const out = await translateBatchMt(
      [
        { i: 1, en: 'Curry brings it up,' },
        { i: 2, en: 'looks for the screen.' },
        { i: 3, en: 'Bang!' },
      ],
      commentaryConfig(),
      { retryDelayMs: 0 },
    );
    expect(prompts).toHaveLength(2);
    expect(out.map((x) => x.untranslated)).toEqual([false, false, false]);
    expect(`${out[0].fr} ${out[1].fr}`).toBe('Curry remonte la balle, cherche l’écran.');
    expect(out[2].fr).toBe('Dedans !');
  });

  it('réponse vide : nouvel essai puis anglais marqué', async () => {
    fakeFetch(() => new Response(JSON.stringify({ response: '' }), { headers: { 'Content-Type': 'application/json' } }));
    const out = await translateBatchMt([{ i: 1, en: 'Timeout Portland.' }], commentaryConfig(), { retryDelayMs: 0 });
    expect(out).toEqual([{ i: 1, fr: 'Timeout Portland.', untranslated: true }]);
  });
});

describe('API OpenAI (clé dans les paramètres ou OPENAI_API_KEY)', () => {
  beforeEach(() => {
    freshDb();
    setEnv(); // un Ollama externe configuré : la clé OpenAI passe devant
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    [...ENV, 'OPENAI_API_KEY', 'OPENAI_MODEL'].forEach((k) => delete process.env[k]);
  });

  it('clé enregistrée dans les paramètres : traduction par OpenAI, modèle par défaut ou choisi', () => {
    expect(commentaryConfig().translateProvider).toBe('ollama');
    setSetting('openai_api_key', 'sk-test-0123456789abcd');
    expect(commentaryConfig()).toMatchObject({
      translateProvider: 'openai',
      translateMode: 'remote',
      translateUrl: 'https://api.openai.com/v1',
      translateModel: 'gpt-5.4-mini',
      translateEngine: 'chat',
      translateApiKey: 'sk-test-0123456789abcd',
      parallel: 4,
    });
    setSetting('openai_model', 'gpt-5.4-nano');
    expect(commentaryConfig().translateModel).toBe('gpt-5.4-nano');
    setSetting('openai_api_key', null);
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(commentaryConfig()).toMatchObject({ translateProvider: 'openai', translateApiKey: 'sk-env' });
  });

  it('requête OpenAI : clé Bearer, JSON, raisonnement bref, sans temperature pour GPT-5', async () => {
    setSetting('openai_api_key', 'sk-test-0123456789abcd');
    const calls = fakeFetch((_u, init) => chatRes(JSON.stringify({ t: requestedLines(init).map((l) => ({ i: l.i, fr: 'Dedans !' })) })));
    const out = await translateBatch([{ i: 1, en: 'Bang!' }], [], commentaryConfig());
    expect(out).toEqual([{ i: 1, fr: 'Dedans !', untranslated: false }]);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-0123456789abcd');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: 'gpt-5.4-mini', response_format: { type: 'json_object' }, reasoning_effort: 'low' });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('clé refusée : message clair', async () => {
    setSetting('openai_api_key', 'sk-test-0123456789abcd');
    fakeFetch(() => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }));
    await expect(translateBatch([{ i: 1, en: 'Bang!' }], [], commentaryConfig())).rejects.toThrow('API OpenAI : clé refusée');
  });
});
