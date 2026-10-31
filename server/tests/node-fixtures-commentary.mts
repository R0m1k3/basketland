/**
 * Produit, avec le code Node, les sorties attendues de la file de traduction
 * portée en Rust (étape 6b, src/lib/commentary.ts → server/src/media/commentary/) :
 * server/tests/fixtures/commentary.expected.json, comparé par
 * tests/commentary_node.rs.
 *
 * - schéma réel de la base (migrations de db.ts) ;
 * - fonctions pures : découpage en tronçons, ordre, couverture, sous-titres
 *   d'un tronçon, sources audio, backoff, `commentaryRetryAllowed`, couverture
 *   en base ;
 * - travaux complets (`runCommentary`) avec de faux transcripteur et
 *   traducteur (les mêmes que tests/commentary-ondemand.test.ts) : lignes de
 *   la base (pistes, sous-titres, tronçons, kv_cache), avancement, appels,
 *   résultat, statut ;
 * - statuts (`commentaryStatus`) dans chaque état de la file, avec un faux
 *   exécuteur.
 *
 * À relancer après une modification de ces modules, depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-commentary.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-commentary-fx-'));
process.env.DATA_DIR = DATA;
const ENV_KEYS = [
  'TRANSCRIBE_URL', 'TRANSLATE_URL', 'TRANSCRIBE_MODEL', 'TRANSLATE_MODEL', 'TRANSLATE_BATCH', 'TRANSLATE_PARALLEL', 'TRANSLATE_ENGINE',
  'TRANSLATE_API_KEY', 'COMMENTARY_DISABLED', 'COMMENTARY_CHUNK_SEC', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'MINIMAX_API_KEY', 'MINIMAX_TRANSLATE',
  'WHISPER_PYTHON', 'WHISPER_WORKER', 'OLLAMA_BIN', 'COMMENTARY_NIGHT_WINDOW', 'COMMENTARY_VIEWER_IDLE_MS', 'COMMENTARY_VIEWER_GONE_MS',
  'COMMENTARY_MAX_LEAD_SEC', 'COMMENTARY_LEAD_POLL_MS', 'COMMENTARY_REPUMP_MS', 'COMMENTARY_FULL_AUDIO', 'COMMENTARY_FULL_AUDIO_POLL_MS',
  'WHISPER_PROMPT', 'WHISPER_HOTWORDS', 'COMMENTARY_TIMEOUT_MS',
];
for (const k of ENV_KEYS) delete process.env[k];
process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';

const db = await import(path.join(ROOT, 'src/lib/db.ts'));
const cm = await import(path.join(ROOT, 'src/lib/commentary.ts'));
const an = await import(path.join(ROOT, 'src/lib/analysis.ts'));
const ai = await import(path.join(ROOT, 'src/lib/commentaryAi.ts'));
const helpers = await import(path.join(ROOT, 'tests/helpers/db.ts'));

console.log = () => {};
console.error = () => {};

const out: Record<string, unknown> = {};

// ------------------------------------------------------------------ schéma

{
  const file = path.join(DATA, 'schema.db');
  const d = db.openDatabase(file);
  out.schema = (d.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[]).map((r) => r.sql);
  d.close();
}

// ------------------------------------------------------------------ fonctions pures

const plans: unknown[] = [];
for (const [d, c, o] of [
  [1300, 600, undefined], [7480, 120, undefined], [0, 120, undefined], [125, 120, undefined], [150, 120, undefined], [61, 60, undefined],
  [3600, 60, 5], [7200.4, 120, undefined], [29, 30, 0], [90.6, 30, undefined],
] as [number, number, number | undefined][]) {
  const p = cm.planChunks(d, c, o);
  plans.push({ duration: d, chunkSec: c, overlap: o ?? null, plans: p.map((x: { keepTo: number }) => ({ ...x, keepTo: Number.isFinite(x.keepTo) ? x.keepTo : null })) });
}
out.plans = plans;

const PL = cm.planChunks(1300, 600);
const PL2 = cm.planChunks(7480, 120);
const order: unknown[] = [];
for (const [which, done, target] of [
  ['a', [], 0], ['a', [], 700], ['a', [1], 700], ['a', [1, 2], 700], ['a', [0, 1, 2], 700], ['a', [], 99999], ['a', [], -5],
  ['b', [], 3000], ['b', [24, 25, 26], 3000], ['b', Array.from({ length: 62 }, (_, i) => i).filter((i) => i !== 10), 7400],
] as [string, number[], number][]) {
  const p = which === 'a' ? PL : PL2;
  const dur = which === 'a' ? 1300 : 7480;
  const set = new Set(done);
  order.push({
    which, done, target,
    next: cm.nextChunk(p, set, target)?.index ?? null,
    at: cm.chunkAt(p, target),
    covered: cm.coveredFrom(p, set, target, dur),
  });
}
out.order = order;

const SCRIPT: [number, string][] = [
  [10, 'Tatum brings it up the floor.'],
  [120, 'He drives and scores at the rim.'],
  [300, 'Timeout on the floor, the Celtics lead by four.'],
  [650, 'What a shot by Jaylen Brwn.'],
  [1100, 'Lakers ball, under two minutes to go.'],
  [1250, 'That will do it, final buzzer.'],
];
const DURATION = 1300;
const CHUNK = 600;

function fakeTranscript(plans: { start: number; length: number }[], index: number) {
  const plan = plans[index];
  const from = plan.start;
  const to = plan.start + plan.length;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const words: { word: string; start: number; end: number }[] = [];
  const segments: Record<string, unknown>[] = [];
  for (const [t0, text] of SCRIPT) {
    const ws = text
      .split(' ')
      .map((w, i) => ({ word: ` ${w}`, start: t0 + i * 0.3, end: t0 + i * 0.3 + 0.25 }))
      .filter((w) => w.start >= from && w.end <= to)
      .map((w) => ({ word: w.word, start: r(w.start - from), end: r(w.end - from) }));
    if (!ws.length) continue;
    words.push(...ws);
    segments.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.word).join(''), avg_logprob: -0.2, no_speech_prob: 0.02, compression_ratio: 1.1 });
  }
  return { segments, words };
}
out.script = SCRIPT;

out.chunkCues = [0, 1, 2].map((i) => cm.chunkCues(PL[i], fakeTranscript(PL, i)));
out.cuesFromChunks = cm.cuesFromChunks([0, 1, 2].map((i) => ({ plan: PL[i], transcript: fakeTranscript(PL, i) })));

const v = (key: string, bandwidth: number, resolution: string) => ({ key, bandwidth, resolution, url: `https://vd.okcdn.ru/${key}.m3u8` });
const m4 = (name: string) => ({ name, url: `https://vd.okcdn.ru/${name}.mp4` });
const streams: Record<string, { variants: unknown[]; mp4?: unknown[] }> = {
  hls: { variants: [v('hd', 2_500_000, '1280x720'), v('low', 600_000, '640x360'), v('sd', 1_200_000, '852x480'), v('full', 5_000_000, '1920x1080'), v('quad', 9_000_000, '2560x1440')] },
  hlsSansResolution: { variants: [v('mobile', 0, ''), v('lowest', 300_000, ''), v('weird', 400_000, 'abc')] },
  hlsEtMp4: { variants: [v('sd', 1_200_000, '852x480')], mp4: [m4('mobile'), m4('low'), m4('hd')] },
  mp4: { variants: [], mp4: [m4('mobile'), m4('full'), m4('sd'), m4('HD'), m4('ultra')] },
  mp4Seul: { variants: [], mp4: [m4('mobile')] },
  vide: { variants: [] },
  egalites: { variants: [v('a', 600_000, '640x360'), v('b', 600_000, '640x240'), v('c', 600_000, '')] },
};
out.sources = Object.entries(streams).map(([name, s]) => ({
  name,
  stream: s,
  audio: cm.audioSources(s),
  analysis: an.analysisSources(s),
  pick: an.pickAnalysisSource(s),
  pickAudio: an.pickAudioSource(s),
}));

out.backoff = [-1, 0, 1, 2, 3, 4, 5, 6].map((n) => ({ n, backoff: an.backoffMs(n), network: an.networkBackoffMs(n) }));
const AT = '2026-10-30T12:00:00.000Z';
const at = Date.parse(AT);
const retry: unknown[] = [];
for (const rec of [
  undefined,
  { at: AT, ok: true, failures: 0, reason: 'ok', okId: 'v1' },
  { at: AT, ok: false, failures: 1, kind: 'erreur', reason: 'boum', okId: 'v1' },
  { at: AT, ok: false, failures: 4, kind: 'erreur', reason: 'boum', okId: 'v1' },
  { at: AT, ok: false, failures: 2, kind: 'contenu', reason: 'vide', okId: null },
  { at: AT, ok: false, failures: 1, netFailures: 3, kind: 'reseau', reason: 'flux', okId: 'v1' },
  { at: AT, ok: false, failures: 0, kind: 'service', reason: 'ollama', okId: 'v1' },
  { at: 'pas une date', ok: false, failures: 1, kind: 'erreur', reason: 'x', okId: 'v1' },
  { at: AT, ok: false, reason: 'sans compteur', okId: 'v1' },
]) {
  for (const okId of ['v1', 'v2', null]) {
    for (const dt of [0, 15 * 60_000, 30 * 60_000, 3600_000, 2 * 3600_000, 4 * 3600_000, 25 * 3600_000, 30 * 24 * 3600_000]) {
      retry.push({ rec: rec ?? null, okId, now: at + dt, allowed: cm.commentaryRetryAllowed(rec, okId, at + dt) });
    }
  }
}
out.retry = retry;

out.workDir = ['16656492000001', 'a/b c', 'é-ok_1', 'x😀y'].map((id) => ({ id, dir: path.relative(DATA, cm.workDir(id)) }));

// ------------------------------------------------------------------ base

const A = 402000001;
const B = 402000002;
const C = 402000003;

function reset() {
  db.setDbForTests(db.openDatabase(':memory:'));
  fs.rmSync(path.join(DATA, 'commentary'), { recursive: true, force: true });
  cm.__setCommentaryRunnerForTests(null);
  for (const id of [A, B, C]) helpers.insertMatch(id, { duration: DURATION });
}

function rows(sql: string) {
  return db.getDb().prepare(sql).all() as Record<string, unknown>[];
}

function snapshot() {
  return {
    tracks: rows('SELECT * FROM commentary_tracks ORDER BY match_id').map(({ created_at: _c, ...r }) => r),
    cues: rows('SELECT * FROM commentary_cues ORDER BY match_id, seq'),
    chunks: rows('SELECT * FROM commentary_chunks ORDER BY match_id, idx'),
    kv: rows("SELECT key, value FROM kv_cache WHERE key LIKE 'commentary%' ORDER BY key").map((r) => {
      const v = JSON.parse(r.value as string);
      if (v && typeof v === 'object' && 'at' in v) v.at = '<at>';
      return { key: r.key, value: v };
    }),
  };
}

// coverage / cuesBefore / progress
{
  reset();
  const okId = db.getMatch(A)!.video_ok_id!;
  const meta = { ok_id: okId, transcribe_model: 'w', translate_model: 'm', chunk_sec: 60, chunks_total: 5 };
  const cue = (seq: number, s: number, en: string, u = 0, e = 0) => ({ seq, start_ts: s, end_ts: s + 2, text_en: en, text_fr: `FR ${en}`, untranslated: u, emphasis: e });
  const steps: unknown[] = [];
  for (const [idx, from, to] of [[2, 120, 180], [0, 0, 60], [4, 240, Infinity], [3, 180, 240.4], [1, 60.2, 120]] as [number, number, number][]) {
    const base = db.chunkSeqBase(idx);
    const res = db.publishCommentaryChunk(A, meta, { idx, keepFrom: from, keepTo: to }, [cue(base + 1, from + 5, `line ${idx}a`, idx === 3 ? 1 : 0, idx), cue(base + 2, from + 20, `line ${idx}b`, 0, 2.6)]);
    steps.push({ idx, res, coverage: db.commentaryCoverage(A), until: db.commentaryPublishedUntil(A), before: db.commentaryCuesBefore(A, from + 21, 5), progress: [...db.commentaryProgressByIds([A, B, A, 1.5])] });
  }
  db.setCommentaryCueTranslation(A, db.chunkSeqBase(3) + 1, 'enfin');
  out.coverage = { steps, after: snapshot(), ready: [...db.commentaryReadyIds([A, B])], untranslated: db.untranslatedCommentaryCues(A) };
}

// ------------------------------------------------------------------ travaux complets

type Fake = { failTranscribeAt?: number; failExtractAt?: number; afterChunk?: (idx: number) => void; untranslatable?: RegExp };
function fakeDeps(o: Fake = {}) {
  const PLANS = cm.planChunks(DURATION, Number(process.env.COMMENTARY_CHUNK_SEC));
  const calls = { extract: [] as number[], transcribe: [] as number[], translated: [] as number[], events: [] as string[], hotwords: [] as (string | null)[] };
  const chunkIndex = (file: string) => PLANS.findIndex((p: { start: number }) => p.start === Number(/chunk-(\d+)-/.exec(file)![1]));
  const deps = {
    resolveStream: async () => ({ variants: [{ key: 'low', bandwidth: 600_000, resolution: '640x360', url: 'https://vd.okcdn.ru/low.m3u8' }], duration: DURATION }),
    extract: async (_url: string, start: number, _len: number, out: string) => {
      const idx = PLANS.findIndex((p: { start: number }) => p.start === start);
      calls.extract.push(idx);
      if (idx === o.failExtractAt) throw new Error('ffmpeg audio code 1: HTTP error 403 Forbidden');
      fs.writeFileSync(out, Buffer.alloc(4096));
    },
    transcribe: async (file: string) => {
      const idx = chunkIndex(file);
      calls.transcribe.push(idx);
      calls.events.push(`transcription ${idx}`);
      if (idx === o.failTranscribeAt) throw new ai.ServiceError('Whisper s’est arrêté', 'transcription');
      return fakeTranscript(PLANS, idx);
    },
    translate: async (lines: { i: number; en: string }[]) => {
      calls.events.push(`traduction ${lines.length}`);
      calls.translated.push(...lines.map((l) => l.i));
      const res = lines.map((l) => (o.untranslatable?.test(l.en) ? { i: l.i, fr: l.en, untranslated: true } : { i: l.i, fr: `FR ${l.en}`, untranslated: false }));
      const idx = Math.floor(lines[0].i / 100_000) - 1;
      o.afterChunk?.(idx);
      return res;
    },
    openTranscriber: async (cfg: unknown) => {
      calls.events.push('whisper ouvert');
      return {
        transcribe: (file: string, prompt: string | undefined, signal: AbortSignal, hotwords?: string) => {
          calls.hotwords.push(hotwords ?? null);
          return deps.transcribe(file, cfg, { prompt, signal });
        },
        close: async () => void calls.events.push('whisper fermé'),
      };
    },
    openTranslator: async () => {
      calls.events.push('ollama ouvert');
      return { close: async () => void calls.events.push('ollama fermé') };
    },
  } as Record<string, unknown> & { transcribe: (f: string, c: unknown, o: unknown) => Promise<unknown> };
  return { deps, calls };
}

const fmt = (p: { phase: string; done: number; total: number; availableUntil?: number }) => `${p.phase} ${p.done}/${p.total} ${p.availableUntil ?? '-'}`;
const ctl = (target: () => number, keepGoing: () => boolean = () => true, playing?: () => boolean) => ({ target, keepGoing, ...(playing ? { playing, watching: () => true } : {}) });

async function run(job: { matchId: number; force: boolean }, deps: unknown, control?: unknown) {
  const events: string[] = [];
  let outcome: unknown;
  try {
    const r = await cm.runCommentary(job, (p: never) => events.push(fmt(p)), new AbortController().signal, deps, control);
    outcome = { ok: r };
  } catch (e) {
    outcome = { err: (e as Error).message, service: e instanceof ai.ServiceError ? (e as { service: string }).service : null };
  }
  return { outcome, events };
}


const runs: unknown[] = [];
async function scenario(name: string, f: () => Promise<unknown[]>) {
  reset();
  process.env.COMMENTARY_CHUNK_SEC = String(CHUNK);
  const steps = await f();
  runs.push({ name, steps });
  for (const k of ['COMMENTARY_CHUNK_SEC', 'COMMENTARY_MAX_LEAD_SEC', 'COMMENTARY_LEAD_POLL_MS', 'COMMENTARY_FULL_AUDIO_POLL_MS', 'WHISPER_HOTWORDS', 'WHISPER_PROMPT']) delete process.env[k];
}
async function step(label: string, job: { matchId: number; force: boolean }, fake: ReturnType<typeof fakeDeps>, control?: unknown) {
  const r = await run(job, fake.deps, control);
  const okId = db.getMatch(job.matchId)!.video_ok_id!;
  const dir = cm.workDir(okId);
  return {
    label,
    // Durée en minutes : « ; 1 min » (les travaux simulés durent moins d'une minute).
    outcome: r.outcome,
    events: r.events,
    calls: { ...fake.calls, extract: [...fake.calls.extract].sort((a, b) => a - b) },
    db: snapshot(),
    status: cm.commentaryStatus(job.matchId),
    served: cm.servedCommentaryCues(job.matchId).map((c: { seq: number }) => c.seq),
    ready: cm.commentaryReady(job.matchId),
    leftoversPending: cm.commentaryLeftoversPending(job.matchId),
    workDir: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null,
  };
}
const J = (force = false) => ({ matchId: A, force });

await scenario('complet', async () => [await step('run', J(), fakeDeps())]);
await scenario('saut', async () => {
  let target = 700;
  return [await step('run', J(), fakeDeps({ afterChunk: (idx) => idx === 1 && (target = 1250) }), ctl(() => target))];
});
await scenario('pause-reprise', async () => {
  let watching = true;
  const a = await step('pause', J(), fakeDeps({ afterChunk: () => (watching = false) }), ctl(() => 700, () => watching));
  const b = await step('reprise', J(), fakeDeps(), ctl(() => 0));
  return [a, b];
});
await scenario('panne-transcription', async () => [
  await step('panne', J(), fakeDeps({ failTranscribeAt: 2 })),
  await step('reprise', J(), fakeDeps()),
]);
await scenario('relance-forcee', async () => [await step('premier', J(), fakeDeps()), await step('force', J(true), fakeDeps())]);
await scenario('intraduisible', async () => [await step('run', J(), fakeDeps({ untranslatable: /^Timeout/ }))]);
await scenario('intraduisible-reprise', async () => {
  let watching = true;
  const a = await step('pause', J(), fakeDeps({ untranslatable: /^Timeout/, afterChunk: () => (watching = false) }), ctl(() => 0, () => watching));
  const b = await step('reprise', J(), fakeDeps());
  return [a, b];
});
await scenario('rattrapage-seul', async () => {
  const a = await step('piste', J(), fakeDeps({ untranslatable: /^Timeout/ }));
  db.kvSet(`commentary-leftovers:${A}`, { okId: 'ancien', model: 'ancien' });
  const b = await step('rattrapage', J(), fakeDeps());
  return [a, b];
});
await scenario('flux-inaccessible', async () => [await step('run', J(), fakeDeps({ failExtractAt: 0 }))]);
await scenario('flux-inaccessible-2', async () => [await step('run', J(), fakeDeps({ failExtractAt: 1 }))]);
await scenario('aucune-parole', async () => {
  const f = fakeDeps();
  f.deps.transcribe = async () => ({ segments: [{ start: 1, end: 2, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.5 }], words: [] });
  return [await step('run', J(), f)];
});
await scenario('avance-max', async () => {
  process.env.COMMENTARY_MAX_LEAD_SEC = '500';
  process.env.COMMENTARY_LEAD_POLL_MS = '5';
  let checks = 0;
  return [await step('run', J(), fakeDeps(), ctl(() => 0, () => ++checks < 20, () => true))];
});
await scenario('effectif', async () => {
  db.replaceStats(
    A,
    [],
    ['Jaylen Brown', 'Mike Conley', 'Jaylen Brown', ''].map((name, i) => ({ match_id: A, team_abbr: i ? 'MIN' : 'BOS', player_id: String(i), player_name: name, position: 'G', jersey: String(i), starter: 1, stats: {} })),
    [],
  );
  return [await step('run', J(), fakeDeps())];
});
await scenario('effectif-sans-hotwords', async () => {
  process.env.WHISPER_HOTWORDS = '0';
  db.replaceStats(A, [], [{ match_id: A, team_abbr: 'BOS', player_id: '1', player_name: 'Jaylen Brown', position: 'G', jersey: '1', starter: 1, stats: {} }], []);
  return [await step('run', J(), fakeDeps())];
});
await scenario('tronçons-120', async () => {
  process.env.COMMENTARY_CHUNK_SEC = '120';
  return [await step('run', J(), fakeDeps())];
});
await scenario('son-complet', async () => {
  process.env.COMMENTARY_FULL_AUDIO_POLL_MS = '5';
  const g = globalThis as { __dubWantsAudio?: (id: number) => boolean };
  const mk = () => {
    const f = fakeDeps();
    const full: string[] = [];
    const cuts: number[] = [];
    f.deps.extractFull = async (url: string, out: string, o: { onProgress?: (s: number) => void }) => {
      full.push(url);
      fs.writeFileSync(out, Buffer.alloc(4096));
      o.onProgress?.(700);
      await new Promise((r) => setTimeout(r, 30));
      o.onProgress?.(DURATION);
    };
    f.deps.cut = async (_file: string, start: number, _len: number, out: string) => {
      cuts.push(start);
      fs.writeFileSync(out, Buffer.alloc(4096));
    };
    return { f, full, cuts };
  };
  g.__dubWantsAudio = () => false;
  const a = mk();
  const s1 = await step('sans-doublage', J(), a.f);
  g.__dubWantsAudio = () => true;
  const b = mk();
  const s2 = await step('doublage', J(true), b.f);
  delete g.__dubWantsAudio;
  return [
    { ...s1, full: a.full, cuts: [...a.cuts].sort((x, y) => x - y) },
    { ...s2, full: b.full, cuts: [...b.cuts].sort((x, y) => x - y) },
  ];
});
out.runs = runs;

// ------------------------------------------------------------------ statuts de la file

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const statuses: unknown[] = [];
const snap = (label: string, ids = [A, B, C]) =>
  statuses.push({ label, status: Object.fromEntries(ids.map((id) => [id, cm.commentaryStatus(id)])), activity: cm.commentaryActivity(), queue: ids.map((id) => cm.commentaryQueuePosition(id)) });
{
  reset();
  const gates = new Map<number, ReturnType<typeof deferred<unknown>>>();
  let progressOf: ((p: unknown) => void) | null = null;
  const runner = (job: { matchId: number }, progress: (p: unknown) => void) => {
    progressOf = progress;
    const d = deferred<unknown>();
    gates.set(job.matchId, d);
    return d.promise;
  };
  cm.__setCommentaryRunnerForTests(runner);
  const results: unknown[] = [];
  results.push(cm.enqueueCommentary(A));
  snap('en cours sans avancement');
  progressOf!({ phase: 'transcription', done: 2, total: 3 });
  snap('en cours');
  progressOf!({ phase: 'traduction', done: 1, total: 3, availableUntil: 600 });
  snap('en cours avec disponible');
  results.push(cm.enqueueCommentary(B));
  results.push(cm.enqueueCommentary(C));
  results.push(cm.enqueueCommentary(B));
  results.push(cm.enqueueCommentary(C, { priority: true }));
  results.push(cm.enqueueCommentary(A, { explicit: true }));
  snap('en file');
  // Piste partielle de B (tronçons 0 et 2) : plages et disponibilité depuis la position.
  const okB = db.getMatch(B)!.video_ok_id!;
  const meta = { ok_id: okB, transcribe_model: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate_model: ai.DEFAULT_TRANSLATE_MODEL, chunk_sec: 600, chunks_total: 3 };
  db.publishCommentaryChunk(B, meta, { idx: 0, keepFrom: 0, keepTo: 600 }, [{ seq: 100001, start_ts: 10, end_ts: 12, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 }]);
  db.publishCommentaryChunk(B, meta, { idx: 2, keepFrom: 1200, keepTo: Infinity }, [{ seq: 300001, start_ts: 1210, end_ts: 1212, text_en: 'Bye', text_fr: 'Au revoir', untranslated: 1 }]);
  snap('en file, piste partielle');
  cm.touchViewer(B, 1250);
  snap('en file, spectateur à 1250');
  cm.touchViewer(B, 700);
  snap('en file, spectateur à 700');
  gates.get(A)!.resolve({ ok: false, kind: 'contenu', reason: 'vide' });
  await new Promise((r) => setTimeout(r, 20));
  snap('A interrompu (remis en file), C en cours');
  gates.get(C)!.resolve({ ok: true, reason: 'ok' });
  await new Promise((r) => setTimeout(r, 20));
  snap('B en cours, A explicite en attente');
  gates.get(B)!.resolve({ ok: false, paused: true, reason: 'en pause' });
  await new Promise((r) => setTimeout(r, 20));
  snap('A attend la fin de la lecture de B');
  cm.__setCommentaryRunnerForTests(runner); // vide la file et oublie les spectateurs
  snap('file vidée');
  results.push(cm.enqueueCommentary(A, { force: true }));
  gates.get(A)!.resolve({ ok: false, kind: 'erreur', reason: 'boum' });
  await cm.__commentaryIdle();
  results.push(cm.enqueueCommentary(B));
  gates.get(B)!.resolve({ ok: false, kind: 'reseau', reason: 'flux' });
  await cm.__commentaryIdle();
  snap('échecs');
  results.push(cm.enqueueCommentary(B));
  gates.get(B)!.resolve({ ok: false, kind: 'reseau', reason: 'flux 2' });
  await cm.__commentaryIdle();
  results.push(cm.enqueueCommentary(C));
  gates.get(C)!.resolve({ ok: false, reason: 'sans nature' });
  await cm.__commentaryIdle();
  snap('échecs répétés');
  results.push(cm.enqueueCommentary(A, { force: true }));
  gates.get(A)!.resolve({ ok: true, reason: 'ok' });
  await cm.__commentaryIdle();
  // Pistes complètes : A sans ligne en anglais, C avec.
  db.replaceCommentary(A, { ok_id: db.getMatch(A)!.video_ok_id!, transcribe_model: 'w', translate_model: 'm' }, [{ seq: 1, start_ts: 1, end_ts: 2, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 }]);
  db.replaceCommentary(C, { ok_id: db.getMatch(C)!.video_ok_id!, transcribe_model: 'w', translate_model: 'm' }, [
    { seq: 1, start_ts: 1, end_ts: 2, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 },
    { seq: 2, start_ts: 3, end_ts: 4, text_en: 'Yo', text_fr: 'Yo', untranslated: 1 },
  ]);
  snap('prêtes');
  results.push(cm.enqueueCommentary(A));
  results.push(cm.enqueueCommentary(C));
  snap('rattrapage en cours (C prête à l’écran)');
  gates.get(C)!.resolve({ ok: true, reason: 'rattrapage' });
  await cm.__commentaryIdle();
  db.setVideo(B, { slug: null, okId: null, duration: null, available: false });
  results.push(cm.enqueueCommentary(B));
  results.push(cm.enqueueCommentary(999));
  snap('sans replay', [B, 999]);
  process.env.COMMENTARY_DISABLED = '1';
  results.push(cm.enqueueCommentary(A));
  snap('inactive');
  delete process.env.COMMENTARY_DISABLED;
  out.queue = { results, statuses, db: snapshot(), disabled: cm.commentaryDisabledReason() };
}

writeFileSync(path.join(OUT, 'commentary.expected.json'), `${JSON.stringify(out, null, 1)}\n`);
fs.rmSync(DATA, { recursive: true, force: true });
process.stdout.write(`file de traduction : ${runs.length} travaux, ${statuses.length} statuts écrits dans server/tests/fixtures/commentary.expected.json\n`);
function writeFileSync(f: string, s: string) {
  fs.writeFileSync(f, s);
}
