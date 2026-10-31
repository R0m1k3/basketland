/**
 * Produit, avec le code Node, les sorties attendues des fondations médias
 * portées en Rust (étape 6a) : server/tests/fixtures/media.expected.json,
 * comparé par tests/media_node.rs. Sous-titres (commentaryCues.ts), noms des
 * joueurs (rosterNames.ts), prompts, messages et corps des requêtes de
 * traduction, transcription et voix (commentaryAi.ts, voiceMinimax.ts),
 * configuration (settings.ts, voiceAi.ts), audio (audio.ts, audioEnergy.ts),
 * fenêtre de nuit et planification du balayage vidéo (videoScan.ts). Les
 * entrées pseudo-aléatoires sont tirées d'un générateur à graine fixe et
 * écrites dans le fichier : Rust ne refait aucun tirage. À relancer après une
 * modification de ces modules, depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-media.mts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = join(ROOT, 'tests', 'fixtures');
const OUT = join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';
// Environnement neutre : aucune variable de la machine ne doit influencer les sorties.
const ENV_KEYS = [
  'TRANSCRIBE_URL', 'TRANSLATE_URL', 'TRANSCRIBE_MODEL', 'TRANSLATE_MODEL', 'TRANSLATE_BATCH', 'TRANSLATE_PARALLEL', 'TRANSLATE_ENGINE',
  'TRANSLATE_API_KEY', 'TRANSLATE_JSON_SCHEMA', 'TRANSLATE_PROMPT_FILE', 'COMMENTARY_DISABLED', 'COMMENTARY_CHUNK_SEC', 'OPENAI_API_KEY',
  'OPENAI_MODEL', 'MINIMAX_API_KEY', 'MINIMAX_API_URL', 'MINIMAX_TTS_MODEL', 'MINIMAX_TTS_SPEED', 'MINIMAX_TRANSLATE', 'MINIMAX_TRANSLATE_MODEL',
  'MINIMAX_VOICE_A', 'MINIMAX_VOICE_B4', 'MINIMAX_VOICE_B1', 'MINIMAX_VOICE_F', 'MINIMAX_EMOTIONS', 'MINIMAX_RETRY_MS', 'WHISPER_PYTHON',
  'WHISPER_WORKER', 'OLLAMA_BIN', 'OLLAMA_PORT', 'TTS_ENGINE', 'TTS_EMBED_DEVICE', 'TTS_DEVICE', 'TTS_PYTHON', 'TTS_WORKER', 'TTS_MODEL',
  'VOICES_DIR', 'MODELS_DIR', 'DUB_DISABLED', 'COMMENTARY_NIGHT_WINDOW', 'TRANSCRIBE_API_KEY',
];
for (const k of ENV_KEYS) delete process.env[k];

const cues = await import(join(ROOT, 'src/lib/commentaryCues.ts'));
const roster = await import(join(ROOT, 'src/lib/rosterNames.ts'));
const ai = await import(join(ROOT, 'src/lib/commentaryAi.ts'));
const settings = await import(join(ROOT, 'src/lib/settings.ts'));
const mm = await import(join(ROOT, 'src/lib/voiceMinimax.ts'));
const voice = await import(join(ROOT, 'src/lib/voiceAi.ts'));
const audio = await import(join(ROOT, 'src/lib/audio.ts'));
const energy = await import(join(ROOT, 'src/lib/audioEnergy.ts'));
const night = await import(join(ROOT, 'src/lib/nightWindow.ts'));
const scan = await import(join(ROOT, 'src/lib/videoScan.ts'));
const sync = await import(join(ROOT, 'src/lib/sync.ts'));
const ocr = await import(join(ROOT, 'src/lib/ocr.ts'));
const espn = await import(join(ROOT, 'src/lib/espn.ts'));
const db = await import(join(ROOT, 'src/lib/db.ts'));
const synth = await import(join(ROOT, 'tests/helpers/syntheticVideo.ts'));

const cases: { fn: string; input: unknown; output: unknown }[] = [];
const add = (fn: string, input: unknown, f: () => unknown) => {
  let output: unknown;
  try {
    output = { ok: f() };
  } catch (e) {
    output = { err: (e as Error).message };
  }
  cases.push({ fn, input, output });
};
const addAsync = async (fn: string, input: unknown, f: () => Promise<unknown>) => {
  let output: unknown;
  try {
    output = { ok: await f() };
  } catch (e) {
    output = { err: (e as Error).message };
  }
  cases.push({ fn, input, output });
};

/** Générateur pseudo-aléatoire à graine fixe (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261031);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------ 1. sous-titres

const VOCAB = (
  'He crosses over steps back and drills the three from the corner That is his fifth of the night Lakers are rolling now they have outscored Portland ' +
  'by twelve in this quarter alone crowd is on its feet Curry pulls up Bang Splash Jokic finds Murray Wembanyama blocks it Gilgeous-Alexander gets to his spot ' +
  'but so because while when who which that or if then as a an of to in on at for with over under through against between around is was are she we it this ' +
  'Dončić step-back café naïve Ölander 3-and-D 19-16 41% Kata Edie Morrant Sharp'
).split(' ');
const PUNCT = ['', '', '', '', ',', '.', '!', '?', ';', ':', '…', '—', '."', '!"', '”'];

function randomWords(n: number, withEnergy: boolean, t0 = 0): { word: string; start: number; end: number; energy?: number }[] {
  const out: { word: string; start: number; end: number; energy?: number }[] = [];
  let t = t0;
  for (let i = 0; i < n; i++) {
    const kind = rand();
    let word: string;
    if (kind < 0.04) word = pick(["'s", "'re", "n't", "'ll"]);
    else if (kind < 0.07) word = pick(['.', ',', '!', '%', ')']);
    else word = `${rand() < 0.9 ? ' ' : ''}${pick(VOCAB)}${pick(PUNCT)}`;
    const gapKind = rand();
    const gap = gapKind < 0.7 ? rand() * 0.1 : gapKind < 0.88 ? 0.2 + rand() * 0.3 : gapKind < 0.96 ? 0.5 + rand() * 0.8 : 1.2 + rand() * 2;
    t += gap;
    const len = 0.05 + rand() * 0.5;
    const w: { word: string; start: number; end: number; energy?: number } = { word, start: r3(t), end: r3(t + len) };
    if (withEnergy && rand() < 0.9) w.energy = Math.round((rand() < 0.15 ? 4 + rand() * 6 : -3 + rand() * 6) * 10) / 10;
    out.push(w);
    t += len;
  }
  return out;
}

/** Mots réguliers des tests vitest. */
function words(text: string, t0 = 0, step = 0.3, len = 0.25) {
  return text.split(' ').map((w, i) => ({ word: ` ${w}`, start: t0 + i * step, end: t0 + i * step + len }));
}
const seg = (start: number, end: number, text: string, o: Record<string, unknown> = {}) => ({ start, end, text, avg_logprob: -0.2, no_speech_prob: 0.05, compression_ratio: 1.4, ...o });

const jfk = JSON.parse(readFileSync(join(FX, 'faster-whisper-jfk.json'), 'utf8')) as unknown;
const verboseInputs: unknown[] = [
  jfk,
  null,
  [],
  { segments: [null, { start: 'x', end: 1, text: 'a' }, { start: 1, end: 2, text: ' ok', words: [{ word: ' ok', start: 1, end: 1.4 }, { word: 3 }] }] },
  { segments: [{ id: 3.5, start: 2, end: 1, text: ' rev', avg_logprob: 'x', no_speech_prob: 0.2 }], words: [{ word: ' a', start: 1, end: 0.5, energy: 3 }, { word: ' b', start: 1, end: 2, energy: null }] },
  { text: 'x', words: 'pas un tableau', segments: {} },
];
for (const v of verboseInputs) add('parseVerboseJson', v, () => cues.parseVerboseJson(v));

const normTexts = [
  ' Subtitles by the Amara.org community', ' Thanks for watching!', ' Thank you.', ' ♪ ♪', ' [Music] (applause) «Bravo» “Yes”', "Let's go. Let's go. Let's go. Let's go.",
  'the the the the the', "Let's go, let's go! What a game.", 'He scores, he scores again, and again', 'a.b. c.. d...', 'ÉCOLE Dončić 3.5 pts.', '   hmm  ', '',
  'one two one two one two one two', 'yeah yeah yeah yeah', 'I DON\'T SEE YOU', 'see you next time', 'Please like and subscribe to my channel',
];
for (const t of normTexts) {
  add('normText', t, () => cues.normText(t));
  add('isRepetitionLoop', t, () => cues.isRepetitionLoop(t));
}
const prompt = 'NBA basketball game commentary: Portland Trail Blazers at Los Angeles Lakers. LeBron James, Deni Avdija.';
const hallSegs = [
  [seg(0, 2, 'What a pass', { no_speech_prob: 0.8, avg_logprob: -1.3 }), false],
  [seg(0, 2, 'What a pass', { no_speech_prob: 0.8, avg_logprob: -0.4 }), false],
  [seg(0, 2, 'and the and the', { compression_ratio: 2.6 }), false],
  [seg(0, 1, ' Thank you.'), true],
  [seg(0, 1, ' Thank you.'), false],
  [seg(0, 1, ' Yeah.', { no_speech_prob: 0.4 }), false],
  [seg(0, 1, ' Okay.', { avg_logprob: -0.9 }), false],
  [seg(0, 3, ' Portland Trail Blazers at Los Angeles Lakers.'), false],
  [seg(0, 3, ' LeBron James drives baseline.'), false],
  [{ start: 0, end: 1, text: ' bare' }, true],
] as const;
for (const [s, isolated] of hallSegs) {
  add('hallucinationReason', { seg: s, isolated, prompt }, () => cues.hallucinationReason(s, { isolated, prompt }));
}

const HALLU = [' Thank you.', ' Thanks for watching!', ' ♪', ' you', " I don't see you.", ' Here we go.', ' Here we go.', ' Here we go.'];
function randomTranscript(nSeg: number) {
  const segments: Record<string, unknown>[] = [];
  const ws: { word: string; start: number; end: number }[] = [];
  let t = rand() * 5;
  for (let i = 0; i < nSeg; i++) {
    const bogus = rand() < 0.3;
    const text = bogus ? pick(HALLU) : ` ${Array.from({ length: 2 + Math.floor(rand() * 8) }, () => pick(VOCAB)).join(' ')}${pick(['.', '!', '', '?'])}`;
    const tokens = text.trim().split(/\s+/);
    const start = r3(t);
    const sws = tokens.map((tk, k) => ({ word: ` ${tk}`, start: r3(t + k * 0.3), end: r3(t + k * 0.3 + 0.25) }));
    ws.push(...sws);
    const end = r3(t + tokens.length * 0.3);
    const s: Record<string, unknown> = { start, end, text, avg_logprob: -0.2 - rand(), no_speech_prob: rand() * 0.9, compression_ratio: 1 + rand() * 2 };
    if (rand() < 0.2) s.words = sws;
    segments.push(s);
    t = end + (rand() < 0.3 ? 2 + rand() * 3 : rand() * 1.5);
  }
  // Ordre de départ mélangé : le filtre trie.
  segments.sort(() => 0);
  return { segments, words: ws };
}
const filterInputs = [
  { segments: [seg(0, 2, ' Curry pulls up.'), seg(10, 11, ' Thank you.'), seg(20, 22, ' Bang! Splash.')], words: [...words('Curry pulls up.', 0), ...words('Thank you.', 10), ...words('Bang! Splash.', 20)] },
  { segments: [seg(0, 2, ' Curry pulls up.'), seg(2.5, 3, ' Thank you.'), seg(3.5, 4, ' Thank you.'), seg(4.5, 5, " I don't see you."), seg(5.5, 6, " I don't see you.")], words: [] },
  { segments: [seg(0, 1, ' Here we go.'), seg(1.2, 2, ' Here we go.'), seg(2.2, 3, ' Here we go.'), seg(3.2, 4, ' Here we go.')], words: [] },
  ...Array.from({ length: 12 }, () => randomTranscript(4 + Math.floor(rand() * 10))),
];
for (const t of filterInputs) {
  const tr = cues.parseVerboseJson(t);
  add('filterTranscript', { transcript: t, prompt: null }, () => cues.filterTranscript(tr));
  add('filterTranscript', { transcript: t, prompt }, () => cues.filterTranscript(tr, { prompt }));
}

const shiftInputs = [
  { t: { segments: [seg(590, 601, ' end of chunk boundary')], words: [{ word: ' chunk', start: 598, end: 599.5 }, { word: ' boundary', start: 599.8, end: 600.4 }] }, offset: 0, from: 0, to: 600 },
  { t: { segments: [seg(2, 5, ' boundary next', { words: [{ word: ' boundary', start: 2.8, end: 3.4 }, { word: ' far', start: 700, end: 701 }] })], words: [{ word: ' boundary', start: 2.8, end: 3.4, energy: 2.5 }, { word: ' next', start: 3.5, end: 4 }] }, offset: 597, from: 600, to: 1200 },
  { t: filterInputs[5], offset: 120.0005, from: null, to: null },
  { t: filterInputs[6], offset: 0.1 + 0.2, from: 1, to: 9 },
];
const shifted: unknown[] = [];
for (const s of shiftInputs) {
  const tr = cues.parseVerboseJson(s.t);
  const out = cues.shiftTranscript(tr, s.offset, s.from ?? undefined, s.to ?? undefined);
  shifted.push(out);
  add('shiftTranscript', s, () => out);
}
add('mergeTranscripts', shifted, () => cues.mergeTranscripts(shifted as never));

const punctInputs = [
  { words: ['Curry', 'from', 'deep', 'Bang'].map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 })), segments: [seg(0, 2, ' Curry, from deep. Bang!')] },
  { words: words('Curry, from deep.'), segments: [seg(0, 2, ' Curry, from deep. Bang!')] },
  { words: [' it', 's', ' Curry', ' from', ' way', ' downtown', ' yes'].map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.3 })), segments: [seg(0, 1.5, " It's Curry,"), seg(1.6, 3, ' from way downtown! Yes.')] },
];
for (const p of punctInputs) add('punctuateWords', p, () => cues.punctuateWords(p.words, p.segments as never));
const wftInputs = [
  { segments: [seg(10, 12, ' Jokic finds Murray.')], words: [] },
  { segments: [seg(10, 12, ' Jokic  finds Murray. Bang!'), seg(12, 12, ' Zéro durée')], words: [] },
  { segments: [seg(0, 2, ' A b', { words: [{ word: ' A', start: 1, end: 1.2 }, { word: ' b', start: 0.2, end: 0.5 }] })], words: [] },
  jfk,
  ...filterInputs.slice(3, 7),
];
for (const t of wftInputs) add('wordsFromTranscript', t, () => cues.wordsFromTranscript(cues.parseVerboseJson(t)));

const joinInputs = [
  [{ word: ' He', start: 0, end: 0.1 }, { word: "'s", start: 0.1, end: 0.2 }, { word: ' open', start: 0.2, end: 0.3 }, { word: '!', start: 0.3, end: 0.3 }],
  [{ word: ' I', start: 0, end: 0.1 }, { word: " can", start: 0.1, end: 0.2 }, { word: "n't", start: 0.2, end: 0.3 }, { word: ' believe', start: 0.3, end: 0.4 }, { word: '  it \n', start: 0.4, end: 0.5 }, { word: '%)', start: 0.5, end: 0.6 }, { word: "'S", start: 0.6, end: 0.7 }, { word: "'see", start: 0.7, end: 0.8 }],
  ...Array.from({ length: 6 }, () => randomWords(15, false)),
];
for (const w of joinInputs) add('joinWords', w, () => cues.joinWords(w));

const cueInputs: { words: unknown[]; opts: Record<string, number> }[] = [
  { words: words('He crosses over, steps back, and drills the three from the corner. That is his fifth of the night and the Lakers are rolling now, they have outscored Portland by twelve in this quarter alone and the crowd is on its feet', 100, 0.28), opts: {} },
  { words: words('He crosses over, steps back, and drills the three from the corner. That is his fifth of the night', 0, 0.3), opts: {} },
  { words: words('they have outscored Portland by twelve in this quarter alone and the crowd is on its feet right now', 0, 0.28), opts: {} },
  { words: words('Shai Gilgeous-Alexander gets to his spot over the outstretched arm of the long defender', 0, 0.28), opts: {} },
  { words: [...words('Brown drives to the rim', 0), ...words('and he is fouled hard', 1.85)], opts: {} },
  { words: [{ word: ' Wow!', start: 5, end: 5.3 }, ...words('What a block by Wembanyama', 9)], opts: {} },
  { words: [{ word: ' Wow!', start: 5, end: 5.3 }, { word: ' Yes!', start: 7.0, end: 7.2 }], opts: {} },
  { words: [...words('Brown brings it up the floor, looks inside', 0).map((w) => ({ ...w, energy: 0 })), ...words('and he slams it home!', 2.5).map((w) => ({ ...w, energy: 8 }))], opts: {} },
  { words: words('Gilgeous-Alexander gets to his spot and buries it', 10, 0.2, 0.15), opts: {} },
  { words: [{ word: ' a', start: 1, end: 0.5 }, { word: '  ', start: 1, end: 2 }, { word: ' b', start: 1, end: 1 }, { word: ' c', start: 1, end: 1 }], opts: {} },
  { words: cues.wordsFromTranscript(cues.parseVerboseJson(jfk)), opts: {} },
  ...Array.from({ length: 30 }, (_, k) => ({ words: randomWords(10 + Math.floor(rand() * 90), k % 3 !== 0, rand() * 100), opts: {} })),
  ...Array.from({ length: 6 }, () => ({ words: randomWords(60, true), opts: { maxChars: 42, minDuration: 0.8, maxDuration: 4, pauseSplit: 0.5, hardGap: 2, readingTail: 0.2, readingCps: 12, toneShiftDb: 4 } })),
];
for (const c of cueInputs) add('buildCues', c, () => cues.buildCues(c.words as never, c.opts));
const emphasisInputs: [number[], string][] = [
  [[0, 1, -2], 'calme'], [[-3, 4, 4, -1], 'monte'], [[7, 6, -4, -6], 'cri'], [[], 'Wow!'], [[4, 3], 'Yes!'], [[2.9, 3.1, 3], 'x'], [[5.95, 6.05], '!!'],
];
for (const [e, text] of emphasisInputs) {
  const g = e.map((energy, i) => ({ word: ` w${i}`, start: i, end: i + 0.5, energy }));
  add('cueEmphasis', { words: g, text }, () => cues.cueEmphasis(g, text));
}
const wrapInputs = [
  ['Court.', 42], ['Il élimine son défenseur, recule et plante le tir à trois points depuis le coin.', 42], ['Un deux trois quatre cinq six sept huit neuf dix onze douze treize', 30],
  ['Motlongsansespacequidépasselargementlalimitedequaranteedeuxcaractères', 42], ['  Espaces\n\nmultiples   ici,  et là ! Oui vraiment, encore un peu plus long.  ', 42],
] as const;
for (const [t, m] of wrapInputs) add('wrapTwoLines', { text: t, max: m }, () => cues.wrapTwoLines(t, m));

// ------------------------------------------------------------------ 2. noms des joueurs

const rosterNames = ['Zach Edey', 'Ja Morant', 'Jaren Jackson Jr.', 'Neemias Queta', 'Shaedon Sharpe', 'Deni Avdija', 'Jerami Grant', 'Desmond Bane', ' Zach Edey ', '', 'Luka Dončić', 'Nikola Jokić', "De'Aaron Fox", 'Gary Payton II', 'Bo', 'Shai Gilgeous-Alexander'];
const rIdx = roster.rosterIndex(rosterNames);
add('rosterIndex', rosterNames, () => ({ surnames: [...rIdx.surnames.entries()], full: rIdx.full }));
for (const w of ['Morrant', 'Sharp', 'Avdia', 'Grant', 'Edie', 'Kata', 'Heart', 'Doncic', 'Jokic', 'Gilgeous', 'Gilgeousalexander', 'Ques', 'Payton', '', "Fox's", 'Banes', 'Bane']) {
  add('nearestSurname', w, () => roster.nearestSurname(w, rIdx));
}
for (const t of ["Morrant's floater, and Sharp with the rebound.", 'Nice pass by Edie to Kata.', 'DONCIC to Jokic, Gilgeousalexander’s step-back.', 'Avdia-Grant, Sharpe’S dunk', 'élan Morrant']) {
  add('fixRosterNames', t, () => roster.fixRosterNames(t, rIdx));
}
for (const [a, b, m] of [['edie', 'edey', 3], ['morrant', 'morant', 3], ['', 'abc', 3], ['abcdef', 'a', 3], ['kitten', 'sitting', 1], ['é😀', 'e😀', 3]] as const) {
  add('editDistance', [a, b, m], () => roster.editDistance(a, b, m));
}
for (const s of ['Dončić', "De'Aaron", 'Ölander-Ü', 'İstanbul', 'ﬁnals']) add('foldName', s, () => roster.foldName(s));
for (const [t5, fr] of [['kata', ' contre de queta'], ['morra', ' panier de morant'], ['xyzzy', ' rien'], ['edie', ' edey au rebond']] as const) {
  add('nameRendered', [t5, fr], () => [roster.nameRendered(t5, fr, rIdx), roster.nameRendered(t5, fr, undefined)]);
}

// ------------------------------------------------------------------ 3. traduction : prompts, messages, analyse des réponses

add('TRANSLATE_SYSTEM_PROMPT', null, () => ai.TRANSLATE_SYSTEM_PROMPT);
add('PLAIN_TRANSLATE_PROMPT', null, () => ai.PLAIN_TRANSLATE_PROMPT);
const lines = [{ i: 1, en: 'Kata with the block.' }, { i: 22, en: 'He said "wow"   \\ é' }];
for (const model of ['gemma4:e4b', 'qwen3:14b']) {
  for (const [ctx, withRoster, match] of [[[], false, undefined], [['He drives.', 'Fouled.'], true, 'Memphis Grizzlies @ Portland Trail Blazers']] as const) {
    const input = { lines, context: ctx, model, roster: withRoster ? rosterNames : null, match: match ?? null };
    add('buildUserMessage', input, () => ai.buildUserMessage(lines, [...ctx], model, withRoster ? rIdx : undefined, match));
    add('buildPlainMessage', input, () => ai.buildPlainMessage(lines[1].en, [...ctx], model, withRoster ? rIdx : undefined, match));
  }
}
const llmReplies = [
  '{"t":[{"i":1,"fr":"Il tire à trois points."},{"i":2,"fr":"Dedans !"}]}',
  'Voici la traduction :\n{"t":[{"i":1,"fr":"Il tire."}]}\nBonne lecture.',
  '```json\n{"t":[{"i":1,"fr":"a"}]}\n```',
  '```JSON {"t":[{"i":1,"fr":"b"}]}```',
  '<think>hmm {"t":[]}</think>\n{"t":[{"i":1,"fr":"c"}]}',
  '<THINK>x</THINK><think>y</think>[{"id":1,"fr":"Il  tire\nà trois."},{"id":"2","text":"Dedans !"},{"i":2.5,"fr":"x"},{"i":3,"fr":4},null,[1]]',
  'pas de JSON ici', '', 'null', '"chaîne"', '{"translations":[{"i":"0x1","translation":"hex"}]}', '{"autre":{"x":1},"liste":[{"i":7,"fr":"sept"}]}',
  '{"t":null,"lines":[{"i":8,"fr":"huit"}]}', '{"t":"pas une liste"}', '{"2":[{"i":1,"fr":"index"}],"a":[{"i":2,"fr":"lettre"}]}', '{"t":[{"i":1,"fr":"un"},{"i":1,"fr":"deux"}]}',
  'texte { cassé } puis [{"i":4,"fr":"quatre"}]', '{"t":[{"i":-0,"fr":"zéro"},{"i":1e3,"fr":"mille"}]}',
];
for (const r of llmReplies) add('parseTranslation', r, () => [...ai.parseTranslation(r).entries()]);
const plainReplies = [
  'Il déclenche de loin.', '<think>…</think>\nFrançais : "Il déclenche de loin."', '```\n« Dedans ! »\n```', '{"t":[{"i":3,"fr":"Temps mort Portland."}]}', '{"fr":"Temps mort Portland."}',
  'Désolé, je ne peux pas.', "I'm sorry, I can't help with that.", 'Désolés pour lui, il rate.', 'TRADUCTION FRANÇAISE :   « Contre  de Queta »', 'fr: “Oui”', '"guillemets" au milieu "ici"',
  '[1,2]', '{"traduction":"Oui !"}', '{"fr":3}', '{cassé', 'Sorry', 'sorryyy', 'As an AI, I cannot', 'je ne suis pas sûr', 'Je suis désolée.', '```python\nprint()\n```', 'désolée!',
];
for (const r of plainReplies) add('parsePlainTranslation', r, () => ai.parsePlainTranslation(r));
const pairs: [string, string | null][] = [
  ['Bang!', 'Dedans !'], ['Bang!', ''], ['Bang!', '...'], ['Bang!', 'Dedans ! '.repeat(10)], ['Bang!', '{"i": 3, "fr": "x"}'], ['He pulls up from deep.', 'He pulls up from deep.'],
  ['Santos.', 'Santos.'], ['Knicks up 19-16.', 'Les Knicks mènent 19-16.'], ['Knicks up 19-16.', 'Les Knicks mènent 19 à 6.'], ['Here is Tatum taking it to the rim.', 'Brunson marque à trois points.'],
  ['Heading to the NBA Finals.', 'En route vers les finales NBA.'], ['Great block by Kata.', 'Superbe contre de Queta.'], ['Great block by Kata.', 'Superbe passe de Morant.'], ['The Celtics. He passes to Tatum', 'Les Celtics. Il passe à Tatum'],
  ['"Coach" says OK, I\'m Dončić\'s fan — Mr. Øster’s team', 'Le coach dit OK, je suis fan de Doncic, équipe d’Øster'], ['x', null],
];
for (const [en, fr] of pairs) {
  add('validTranslation', [en, fr], () => ai.validTranslation(en, fr ?? undefined));
  add('anchors', en, () => ai.anchors(en));
  if (fr !== null) add('consistentTranslation', [en, fr], () => [ai.consistentTranslation(en, fr), ai.consistentTranslation(en, fr, rIdx)]);
}
add('whisperPrompt', null, () => [
  ai.whisperPrompt('Los Angeles Lakers', 'Portland Trail Blazers', ['LeBron James', 'Deni Avdija']),
  ai.whisperPrompt('A', 'B', Array.from({ length: 100 }, (_, i) => `Player Number${i}`)),
  ai.whisperPrompt('A', 'B', []),
]);
const sentenceLines = [
  [{ i: 1, en: 'Curry brings it up,' }, { i: 2, en: 'looks for the screen.' }, { i: 3, en: 'Bang!' }],
  [{ i: 1, en: 'a' }, { i: 2, en: 'b' }, { i: 3, en: 'c' }, { i: 4, en: 'd' }, { i: 5, en: 'e' }],
  [{ i: 1, en: 'Long '.repeat(70) }, { i: 2, en: 'x."' }, { i: 3, en: 'He said (wow!)' }, { i: 4, en: 'end]' }, { i: 5, en: 'end…»' }],
];
for (const l of sentenceLines) add('groupSentences', l, () => ai.groupSentences(l));
const splits: [string, number[]][] = [
  ['Curry remonte le ballon, cherche l’écran et déclenche.', [20, 21]], ['Oui !', [10, 10]], ['Un deux trois quatre cinq six sept huit neuf dix', [3, 30, 3]],
  ['a, b; c: d. e! f? g… h', [1, 1, 1, 1]], ['seul', [5]], ['Un deux trois quatre', [0, 0]],
];
for (const [fr, w] of splits) add('splitProportional', [fr, w], () => ai.splitProportional(fr, w));
for (const m of ['translategemma:12b', 'gemma4:e4b', 'gemma4:12b', 'qwen3:14b', 'hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0', 'MILMMT']) {
  add('modelTraits', m, () => ({ raw: ai.needsRawGemma(m), noThink: ai.needsNoThink(m), schema: ai.schemaSafe(m), engine: ai.engineFor(m), forced: ai.engineFor(m, ' MT '), mt: ai.mtPrompt(`Bang ${m}`), base: ai.ollamaBase(`http://x:1/${m}/v1`) }));
}
add('gemmaRawPrompt', null, () => ai.gemmaRawPrompt('SYS\nligne', 'USER "é"'));

// ------------------------------------------------------------------ 4. corps des requêtes (fetch simulé)

type Captured = { url: string; method?: string; headers: Record<string, string>; body: unknown };
let captured: Captured[] = [];
let responder: (url: string, init: RequestInit) => Response = () => new Response('{}');
const headersOf = (h: HeadersInit | undefined) => Object.fromEntries(new Headers(h).entries());
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  let body: unknown = init.body;
  if (init.body instanceof FormData) {
    const parts: unknown[] = [];
    for (const [name, v] of init.body.entries()) parts.push(typeof v === 'string' ? [name, v] : [name, { filename: (v as File).name, type: (v as File).type, size: (v as File).size }]);
    body = parts;
  }
  captured.push({ url: String(url), method: init.method, headers: headersOf(init.headers), body });
  return responder(String(url), init);
}) as typeof fetch;

const baseCfg = (o: Record<string, unknown>) => ({
  transcribeMode: 'remote', translateMode: 'remote', transcribeUrl: 'http://asr.local/v1', transcribeModel: 'whisper-x', translateUrl: 'http://gpu.local:11434/v1', translateModel: 'mistral-nemo:12b',
  translateEngine: 'chat', translateProvider: 'ollama', translateApiKey: '', batch: 14, parallel: 2, chunkSec: 120, disabledReason: null, ...o,
});
const cfgs = [
  baseCfg({}),
  baseCfg({ translateApiKey: 'tk-remote' }),
  baseCfg({ translateMode: 'embedded', translateModel: 'gemma4:e4b', translateUrl: 'http://127.0.0.1:11434/v1' }),
  baseCfg({ translateMode: 'embedded', translateModel: 'gemma4:12b', translateUrl: 'http://127.0.0.1:11434/v1' }),
  baseCfg({ translateMode: 'embedded', translateModel: 'translategemma:12b', translateUrl: 'http://127.0.0.1:11434/v1' }),
  baseCfg({ translateProvider: 'openai', translateUrl: 'https://api.openai.com/v1', translateModel: 'gpt-5.4-mini', translateApiKey: 'sk-test' }),
  baseCfg({ translateProvider: 'openai', translateUrl: 'https://api.openai.com/v1', translateModel: 'gpt-4.1', translateApiKey: 'sk-test' }),
  baseCfg({ translateProvider: 'minimax', translateUrl: 'https://api.minimax.io/v1', translateModel: 'MiniMax-M3.1-Flash', translateApiKey: 'mm-key' }),
];
const system = `${ai.TRANSLATE_SYSTEM_PROMPT.slice(0, 80)}\n"guillemets" \\ é   fin`;
const user = ai.buildUserMessage(lines, ['ctx'], 'qwen3:14b', rIdx, 'A @ B');
responder = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], message: { content: 'ok' }, response: 'ok' }));
for (const cfg of cfgs) {
  for (const [t, json] of [[0.2, true], [0, true], [0.2, false], [0, false]] as const) {
    captured = [];
    await addAsync('chatCompletion', { cfg, system, user, temperature: t, json }, async () => {
      const content = await ai.chatCompletion(system, user, cfg as never, {}, t, json);
      return { content, request: captured[0] };
    });
  }
}
for (const en of ['Bang!', 'x'.repeat(300), 'Curry brings it up, "looks" for the screen.']) {
  captured = [];
  await addAsync('mtComplete', { cfg: cfgs[0], en }, async () => ({ fr: await ai.mtComplete(en, cfgs[0] as never, {}), request: captured[0] }));
}
const tmp = mkdtempSync(join(tmpdir(), 'bl-media-fx-'));
for (const [name, p] of [['chunk-000.ogg', 'NBA basketball game commentary.'], ['x.mp3', undefined], ['chunk', '']] as const) {
  const file = join(tmp, name);
  writeFileSync(file, Buffer.alloc(32, 7));
  captured = [];
  responder = () => new Response(JSON.stringify({ text: ' x', segments: [{ start: 0, end: 1, text: ' x' }] }));
  process.env.TRANSCRIBE_API_KEY = name === 'x.mp3' ? 'asr-key' : '';
  await addAsync('transcribeAudio', { name, prompt: p ?? null, key: process.env.TRANSCRIBE_API_KEY }, async () => {
    const t = await ai.transcribeAudio(file, cfgs[0] as never, { prompt: p });
    return { transcript: t, request: { ...captured[0], headers: { authorization: captured[0].headers.authorization ?? null } } };
  });
}
delete process.env.TRANSCRIBE_API_KEY;

// MiniMax : get_voice puis t2a_v2.
db.setDbForTests(db.openDatabase(':memory:'));
process.env.MINIMAX_RETRY_MS = '0';
const catalog = { base_resp: { status_code: 0 }, system_voice: Object.values(mm.MINIMAX_DEFAULT_VOICES).map((voice_id) => ({ voice_id })) };
const speech = { base_resp: { status_code: 0 }, data: { audio: mm.toWav(Buffer.alloc(4800)).wav.toString('hex') }, extra_info: { audio_sample_rate: 24000 } };
responder = (url) => new Response(JSON.stringify(url.endsWith('/v1/get_voice') ? catalog : speech));
const origLog = console.log;
console.log = () => undefined;
for (const env of [{ MINIMAX_API_KEY: 'cle-secrete' }, { MINIMAX_API_KEY: 'k2', MINIMAX_TTS_SPEED: '1.1', MINIMAX_TTS_MODEL: 'speech-2.8-turbo', MINIMAX_API_URL: 'https://api-uw.minimax.io//', MINIMAX_VOICE_F: '' }, { MINIMAX_API_KEY: 'k3', MINIMAX_EMOTIONS: '0', MINIMAX_TTS_SPEED: '0.5' }] as Record<string, string>[]) {
  Object.assign(process.env, env);
  captured = [];
  await addAsync('minimaxSynth', env, async () => {
    const s = await mm.MinimaxVoiceSession.open(undefined, async () => Promise.reject(new Error('pas de Python')));
    const out: unknown[] = [];
    for (const [text, voice, emphasis] of [['  Quel contre   de Wembanyama !', 'B4', undefined], ['Quel dunk !', 'A', 2], ['Belle passe.', 'B1', 1], ['Remise en jeu.', 'A', 0.5]] as const) {
      const r = await s.synth(text, voice, join(tmp, 'v.wav'), undefined, { emphasis });
      out.push(r);
    }
    return { results: out, voices: s.voices, requests: captured };
  });
  for (const k of Object.keys(env)) delete process.env[k];
}
console.log = origLog;
delete process.env.MINIMAX_RETRY_MS;
for (const [label, buf] of [['pcm', Buffer.alloc(48000)], ['wav', mm.toWav(Buffer.alloc(12000)).wav], ['court', Buffer.from('RIFF')], ['riff-fmt8k', Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 2, 0, 0x40, 0x1f, 0, 0, 0, 0, 0, 0, 4, 0, 16, 0]), Buffer.from('LIST'), Buffer.from([3, 0, 0, 0, 1, 2, 3, 0]), Buffer.from('data'), Buffer.from([0xff, 0xff, 0, 0]), Buffer.alloc(100)])]] as const) {
  add('toWav', { label, hex: buf.toString('hex') }, () => {
    const w = mm.toWav(buf);
    return { hex: w.wav.toString('hex'), duration: w.duration, sampleRate: w.sampleRate };
  });
}

// ------------------------------------------------------------------ 5. réglages et configurations

const settingsCases: { settings: Record<string, string>; env: Record<string, string> }[] = [
  { settings: {}, env: {} },
  { settings: { openai_api_key: 'sk-test-0123456789abcd', openai_model: 'gpt-5.4-nano', auto_translate: '0', vf_mode: 'doublage' }, env: {} },
  { settings: { openai_api_key: 'court', minimax_api_key: 'mm-key-0123456789abcdef', minimax_translate: '1', minimax_voices: '{"A":"French_MaleNarrator","B4":"","F":3}', minimax_tts_model: 'speech-2.8-turbo' }, env: { MINIMAX_VOICE_B1: '  Voix_Env  ', MINIMAX_TTS_MODEL: 'ignoré' } },
  { settings: { minimax_translate: '0', minimax_api_key: 'x'.repeat(30), vf_mode: 'autre' }, env: { MINIMAX_TRANSLATE: '1', OPENAI_API_KEY: ' sk-env ', OPENAI_MODEL: ' gpt-x ' } },
  { settings: { minimax_voices: 'cassé', minimax_translate_model: 'MiniMax-M3' }, env: { MINIMAX_API_KEY: ' mm-env ', MINIMAX_TRANSLATE: '1', MINIMAX_TRANSLATE_MODEL: 'ignoré', MINIMAX_API_URL: 'https://mm.example/' } },
  { settings: { openai_api_key: '  ', openai_model: '' }, env: { TRANSLATE_URL: ' http://gpu.local:11434/v1// ', TRANSCRIBE_URL: 'http://asr:8000/v1/', TRANSLATE_MODEL: 'hf.co/MiLMMT-46', TRANSLATE_BATCH: '999', TRANSLATE_PARALLEL: ' ', COMMENTARY_CHUNK_SEC: '12.9', TRANSLATE_API_KEY: ' tk ' } },
  { settings: {}, env: { TRANSLATE_URL: 'http://x/v1', TRANSCRIBE_URL: 'http://y', COMMENTARY_DISABLED: '1', TRANSLATE_ENGINE: 'chat', TRANSLATE_MODEL: 'MiLMMT' } },
  { settings: {}, env: { TRANSCRIBE_URL: 'http://y', OLLAMA_PORT: '12345', TRANSLATE_PARALLEL: '7.8', TRANSCRIBE_MODEL: ' m ' } },
  { settings: { minimax_translate: '1' }, env: { OPENAI_API_KEY: 'sk', MINIMAX_VOICE_A: '', MINIMAX_VOICE_B4: '', MINIMAX_VOICE_B1: '', MINIMAX_VOICE_F: '', TTS_ENGINE: ' MiniMax ' } },
];
// Chemins des services embarqués : absents (déterministe), sauf les voix et le moteur du dépôt.
const fixedEnv = { WHISPER_PYTHON: '/nexiste/pas/python', OLLAMA_BIN: '/nexiste/pas/ollama', TTS_WORKER: join(ROOT, 'scripts', 'voice_worker.py'), VOICES_DIR: join(ROOT, 'assets', 'voices'), MODELS_DIR: '/tmp/bl-models', TTS_PYTHON: '/usr/bin/python3' };
for (const c of settingsCases) {
  db.setDbForTests(db.openDatabase(':memory:'));
  for (const [k, v] of Object.entries(c.settings)) db.settingSet(k, v);
  Object.assign(process.env, fixedEnv, c.env);
  add('settingsView', { ...c, fixedEnv }, () => {
    const cc = ai.commentaryConfig();
    const vc = voice.voiceConfig();
    return {
      openai: settings.openAiSettingsView(),
      minimax: settings.minimaxSettingsView(),
      autoTranslate: settings.autoTranslateEnabled(),
      vfMode: settings.vfMode(),
      minimaxConfig: mm.minimaxConfig(),
      commentaryConfig: cc,
      voiceConfig: vc,
      voiceEngine: voice.voiceEngineName(),
      openAiConfig: ai.openAiConfig(),
      minimaxTranslateConfig: ai.minimaxTranslateConfig(),
    };
  });
  for (const k of [...Object.keys(c.env), ...Object.keys(fixedEnv)]) delete process.env[k];
}
db.setDbForTests(db.openDatabase(':memory:'));
for (const raw of [null, {}, { F: 'French_Female_News Anchor', A: 'x(1)' }, { A: 'ok', 1: 3 }, { A: 'é' }, [], 0, 'A', true, { B4: 'x'.repeat(101) }, { B1: '' }, { Z: 'x' }]) {
  add('parseMinimaxVoices', raw, () => settings.parseMinimaxVoices(raw));
}
for (const k of ['', 'x', 'sk-0123456789abcdefghij', 'sk-0123456789abcdefgh j', 'é'.repeat(25), 'k'.repeat(401), 'k'.repeat(1500), 'k'.repeat(2001)]) {
  add('keyErrors', k, () => [settings.apiKeyError(k), settings.minimaxKeyError(k), settings.maskApiKey(k)]);
}
for (const m of ['gpt-5.4-mini', 'gpt 5', 'a/b:c_d.e-f', 'x'.repeat(101), 'speech-2.8-turbo', 'MiniMax-M3', '']) {
  add('modelErrors', m, () => [settings.modelError(m), settings.minimaxModelError(m), settings.minimaxTranslateModelError(m)]);
}
add('listVoices', join(ROOT, 'assets', 'voices'), () => voice.listVoices(join(ROOT, 'assets', 'voices')));
for (const e of [undefined, 0, 0.99, 1, 1.5, 2, 3]) add('minimaxEmotion', e ?? null, () => mm.minimaxEmotion(e));

// ------------------------------------------------------------------ 6. audio

const pcm = (parts: [number, number][], sr = 8000) => {
  const total = parts.reduce((n, [d]) => n + Math.round(d * sr), 0);
  const buf = new Uint8Array(total * 2);
  const view = new DataView(buf.buffer);
  let i = 0;
  for (const [d, amp] of parts) for (let k = 0; k < Math.round(d * sr); k++, i++) view.setInt16(i * 2, Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / sr)), true);
  return buf;
};
const pcmInputs: [number, number][][] = [[[1, 0.05], [1, 0.4]], [[2, 0.05], [1, 0.4]], [[0.333, 0.2], [0.01, 0.9], [0.5, 0]]];
for (const parts of pcmInputs) {
  const buf = pcm(parts);
  const env = energy.envelopeFromPcm(buf);
  const ws = [
    { word: ' calm', start: 0.2, end: 0.6 }, { word: ' still', start: 1.2, end: 1.6 }, { word: ' BANG!', start: 2.2, end: 2.7 }, { word: ' far', start: 9, end: 9.5 }, { word: ' zero', start: 0.5, end: 0.5 },
  ];
  add('envelope', { parts, pcm: Buffer.from(buf).toString('base64'), words: ws }, () => ({ frameSec: env.frameSec, power: [...env.power], energy: energy.addWordEnergy(ws, env), shifted: energy.addWordEnergy(ws, env, 0.3) }));
  const t = { segments: [{ start: 0, end: 1, text: ' a b', words: [{ word: ' a', start: 0.1, end: 0.3 }, { word: ' b', start: 0.6, end: 0.9 }] }, { start: 1, end: 2, text: ' c' }], words: [{ word: ' far', start: 5, end: 5.2 }, ...ws] };
  add('withEnergy', { parts, transcript: t }, () => energy.withEnergy(cues.parseVerboseJson(t), env));
  const sr = 4000;
  const samples = Array.from(new Int16Array(buf.buffer));
  add('computeRmsDb', { parts, sampleRate: sr }, () => audio.computeRmsDb(samples, sr, 1));
}
const profiles = [
  [...Array(10).fill(-20), -80, -80, -80, -80, -20, -20, -85, ...Array(13).fill(-20)],
  [-90, -90, -30, -31, -29, -70, -70, -30, -55, -56, -57, -30, -90],
  [],
  Array.from({ length: 120 }, () => Math.round((-15 - rand() * 60) * 10) / 10),
];
for (const p of profiles) {
  add('detectCuts', { profile: p, opts: {} }, () => audio.detectCuts(p));
  add('detectCuts', { profile: p, opts: { dropDb: 10, absoluteDb: -40, minLen: 1, mergeGap: 0, windowSec: 0.5 } }, () => audio.detectCuts(p, { dropDb: 10, absoluteDb: -40, minLen: 1, mergeGap: 0, windowSec: 0.5 }));
}
const acc = new audio.RmsAccumulator(4, 1);
acc.pushBuffer(Buffer.from([0x00, 0x40, 0x00]));
acc.pushBuffer(Buffer.from([0x40, 0x00, 0x40, 0x00, 0x40, 0x01]));
acc.pushBuffer(Buffer.from([0x80]));
add('rmsAccumulator', null, () => acc.finish());

// ------------------------------------------------------------------ 7. fenêtre de nuit

for (const spec of [undefined, 'always', ' ON ', 'off', '0', '', '2-6', ' 22 - 26 ', '7-7', 'n\'importe', '3-x']) {
  for (const iso of ['2026-10-31T01:30:00Z', '2026-10-31T05:30:00Z', '2026-10-31T21:30:00Z', '2026-07-01T00:30:00Z']) {
    if (spec === undefined) delete process.env.COMMENTARY_NIGHT_WINDOW;
    else process.env.COMMENTARY_NIGHT_WINDOW = spec;
    add('nightWindow', { spec: spec ?? null, at: iso }, () => ({ open: night.inScheduleWindow(new Date(iso)), label: night.nightWindowLabel() }));
  }
}
delete process.env.COMMENTARY_NIGHT_WINDOW;

// ------------------------------------------------------------------ 8. balayage vidéo

const summary = espn.parseSummary(JSON.parse(readFileSync(join(FX, 'espn-summary-401909880.json'), 'utf8')), 401909880);
const plays = summary.plays;
const tp = sync.toTimedPlays(plays);
const breaks = sync.findBreaks(tp);
const truth = synth.makeTruth(tp, breaks);
const scores = ocr.scoreTimeline(plays);
const perfectRead = (t: number, hideInBreaks = true) => {
  const s = synth.stateAt(plays, breaks, truth.wallAt(t));
  if (!s || (hideInBreaks && s.inBreak && Math.floor(t / 37) % 5 < 3)) return null;
  return { period: s.period, clock_sec: s.clock, scores: [s.home, s.away] };
};
const anchorOf = (p: { wall: number; period: number; clock_sec: number }) => ({ wall: p.wall, video: truth.vmap(p.wall), method: 'auto', period: p.period, clock_sec: p.clock_sec });
const q14 = tp.filter((p, i) => (p.period === 1 || p.period === 4) && i % 40 === 5).map(anchorOf);
const sparse = tp.filter((_, i) => i % 150 === 3).map(anchorOf);
const refineInputs = [
  { anchors: [], observations: [], scanned: [], duration: truth.duration, opts: {} },
  { anchors: q14, observations: [], scanned: [], duration: truth.duration, opts: {} },
  { anchors: sparse, observations: [{ video_ts: 3000, period: 1, clock_sec: 700 }, { video_ts: sparse[0]?.video ?? 0, period: 1, clock_sec: 1 }, { video_ts: 5000, period: null, clock_sec: 3 }], scanned: [100, 2000, 3015], duration: truth.duration, opts: {} },
  { anchors: sparse.slice(0, 2), observations: [], scanned: [], duration: truth.duration, opts: { fineStep: 45, perWindow: 3, maxFrames: 12, maxGap: 600 } },
  { anchors: [], observations: [], scanned: [], duration: 0, opts: {} },
];
for (const r of refineInputs) {
  add('planRefinement', r, () => scan.planRefinement({ anchors: r.anchors as never, observations: r.observations as never, scanned: r.scanned, duration: r.duration, tp, breaks }, r.opts));
}
add('scanInputs', null, () => ({ tp, breaks, duration: truth.duration }));

/**
 * Balayage complet. `selectConsistentObservations` (OCR, étape 7) n'est pas
 * porté : ses sorties sont enregistrées, indexées par la liste des
 * observations qui lui est passée (même liste que celle de scanVideo, tenue
 * à jour ici en miroir).
 */
async function recordScan(label: string, o: { stepSec?: number; location?: unknown; sampleFrames?: number; hide?: boolean; failEvery?: number; stale?: boolean }) {
  const reads: Record<string, unknown> = {};
  const locates: Record<string, unknown> = {};
  const grabs: number[] = [];
  const mirror: unknown[] = [];
  const snapshots: Record<string, unknown> = {};
  const snap = () => {
    snapshots[JSON.stringify(mirror)] = ocr.selectConsistentObservations(mirror as never, tp, breaks, { scores });
  };
  let n = 0;
  const loc = { rect: { x: 0.4, y: 0.85, w: 0.2, h: 0.06 }, core: { x: 0.45, y: 0.86, w: 0.1, h: 0.03 }, textH: 0.03, frames: 8, strongFrames: 8 };
  const cached = o.location === undefined ? loc : o.location;
  const locateReading = (t: number) => (t % 3 === 0 ? perfectRead(t, false) : null);
  const r = await scan.scanVideo({
    duration: truth.duration,
    tp,
    breaks,
    scores,
    location: cached as never,
    stepSec: o.stepSec,
    sampleFrames: o.sampleFrames,
    grab: async (t: number) => {
      grabs.push(t);
      if (o.failEvery && ++n % o.failEvery === 0) throw new Error('segment indisponible');
      return Buffer.from(String(t));
    },
    read: async (png: Buffer, l: { core: { x: number } } | null) => {
      const t = Number(png.toString());
      const real = perfectRead(t, o.hide ?? true);
      reads[String(t)] = real;
      const v = o.stale && l && l.core.x === 0.05 ? null : real;
      if (v) mirror.push({ video_ts: t, period: v.period, clock_sec: v.clock_sec, scores: v.scores });
      return v;
    },
    locate: async (frames: Buffer[]) => {
      // Relocalisation d'une localisation en cache : scanVideo a vidé ses observations.
      if (cached) mirror.length = 0;
      const readings = frames.map((f) => (locates[f.toString()] = locateReading(Number(f.toString()))));
      frames.forEach((f, i) => {
        const v = readings[i];
        if (v) mirror.push({ video_ts: Number(f.toString()), period: v.period, clock_sec: v.clock_sec, scores: v.scores });
      });
      return { location: loc, readings, ocrCalls: 0 };
    },
    onProgress: (phase: string, done: number, total: number) => {
      if ((phase === 'balayage' || phase === 'affinage') && done === total) snap();
    },
    worker: { recognize: async () => ({ data: { text: '' } }), terminate: async () => undefined } as never,
  });
  snap();
  cases.push({ fn: 'scanVideo', input: { label, ...o, location: cached, reads, locates, snapshots }, output: { ok: { grabs, observations: r.observations, anchors: r.anchors, framesRead: r.framesRead, perPeriod: r.perPeriod, cachedLocation: r.cachedLocation, location: r.location } } });
}
await recordScan('cache', {});
await recordScan('pas-300', { stepSec: 300, hide: false, failEvery: 7 });
await recordScan('sans-localisation', { location: null, sampleFrames: 4 });
await recordScan('cache-perime', { location: { rect: { x: 0, y: 0, w: 1, h: 1 }, core: { x: 0.05, y: 0.05, w: 0.1, h: 0.03 }, textH: 0.03, frames: 8, strongFrames: 8 }, stale: true, sampleFrames: 2 });

// Chemins du dépôt écrits « <ROOT> » : le fichier ne dépend pas de l'emplacement du dépôt.
writeFileSync(join(OUT, 'media.expected.json'), `${JSON.stringify(cases, null, 1).replaceAll(ROOT, '<ROOT>')}\n`);
console.log(`${cases.length} cas écrits dans server/tests/fixtures/media.expected.json`);
