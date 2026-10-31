/**
 * Produit, avec le code Node, les sorties attendues de la file de doublage
 * portée en Rust (étape 6b, src/lib/dub.ts → server/src/media/dub/) :
 * server/tests/fixtures/dub.expected.json, comparé par tests/dub_node.rs.
 *
 * - fonctions pures : moments forts, calage, positions, plages de parole,
 *   phrases d'une traite, empreinte des sous-titres, téléchargement en
 *   clair, locuteurs et voix (suites d'appels, état complet après chacun) ;
 * - montage : arguments de ffmpeg (faux ffmpeg qui les écrit,
 *   helpers/fake_ffmpeg.sh) et métadonnées du fichier produit par le vrai ;
 * - travaux complets (`runDub`) avec le faux moteur de voix, la fausse
 *   extraction et le faux montage de tests/dub.test.ts : résultat,
 *   avancement, appels, journaux, lignes de la base, fichiers, manifeste ;
 * - états de la file (manifestes, activité, résultats des demandes,
 *   enregistrements) avec de faux exécuteurs, traduction et doublage
 *   branchés l'un sur l'autre (`__commentaryGpuGate`, `__dubWantsAudio`).
 *
 * À relancer après une modification de ces modules, depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-dub.mts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-dub-fx-'));
process.env.DATA_DIR = DATA;
for (const k of Object.keys(process.env)) if (/^(DUB_|TTS_|MINIMAX_|COMMENTARY_|TRANSCRIBE_|TRANSLATE_|WHISPER_|OPENAI_|FFMPEG_PATH$)/.test(k)) delete process.env[k];
process.env.COMMENTARY_NIGHT_WINDOW = 'always';
process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';

const db = await import(path.join(ROOT, 'src/lib/db.ts'));
const cm = await import(path.join(ROOT, 'src/lib/commentary.ts'));
const dub = await import(path.join(ROOT, 'src/lib/dub.ts'));
const helpers = await import(path.join(ROOT, 'tests/helpers/db.ts'));

let logs: [string, string][] = [];
console.log = (...a: unknown[]) => void logs.push(['log', a.map(String).join(' ')]);
console.error = (...a: unknown[]) => void logs.push(['error', a.map(String).join(' ')]);

const out: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fonctions pures

out.emphasize = (
  [
    ['Quel tir.', 2], ['Il marque', 2], ['Et il tire,', 2], ['Incroyable !', 2], ['Il va tirer ?', 2], ['Et là…', 2], ['Et là...', 2],
    ['Il crie « allez ».', 2], ['Quel tir.', 1], ['  Quel tir.  ', 0], ['', 2], ['   ', 2], ['Fin ;', 2], ['Oui:  ', 2], ['(dedans.)', 2],
    ['« Bang » !', 2], ['Trois.. ', 2], ['a.b', 2], ['Ok?”', 2], ['Non. ', 2], ['Quoi', undefined],
  ] as [string, number | undefined][]
).map(([t, e]) => ({ text: t, emphasis: e ?? null, out: dub.emphasize(t, e) }));

const fits: unknown[] = [];
for (const d of [0, 0.5, 1, 2, 3.6, 4, 4.86, 6, 10])
  for (const [s, e, n] of [[10, 13, 20], [10, 13, 12], [10, 13, null], [10, 13, 10], [10, 13, 9], [10, 10.05, null], [0, 0.1, 0.15], [5.123, 7.777, 7.9]] as [number, number, number | null][])
    fits.push({ duration: d, start: s, end: e, next: n, fit: dub.fitCue(d, s, e, n) });
out.fitCue = fits;

out.placeClips = [
  [{ start: 10, fitted: 4.4 }, { start: 13.8, fitted: 1 }, { start: 30, fitted: 1 }],
  [{ start: 0, fitted: 1.0004 }, { start: 1, fitted: 0.3 }, { start: 1.2, fitted: 0.1 }],
  [],
  [{ start: 2.0005, fitted: 0.12345 }],
].map((c) => ({ clips: c, at: dub.placeClips(c) }));

out.speechRanges = [
  [[3.2, 5.9], [6.0, 8.004], [12, 13]],
  [[12, 13], [3.2, 5.9], [5.9, 6.1]],
  [[0, 1], [1.25, 2], [2.26, 3]],
  [[1.005, 2.345], [1.1, 1.2]],
  [],
].map((r) => ({ ranges: r, out: dub.speechRanges(r as [number, number][]) }));

out.nextDubChunk = [0, 119.9, 120, 150, 239, 240, 9999, -1].map((t) => {
  const todo = [0, 2, 3].map((i) => ({ idx: i, keepFrom: i * 120, keepTo: i === 3 ? Infinity : (i + 1) * 120 }));
  return { target: t, idx: dub.nextDubChunk(todo, t)?.idx ?? null };
});

out.downloadText = [
  [1.1e9, 2.5e9], [3e8, 0], [2.5e9, 2.5e9], [0, 2.5e9], [1.25e8, 1e9], [5e7, -1], [2.45e9, 2.5e9],
].map(([d, t]) => ({ done: d, total: t, text: dub.downloadText({ done: d, total: t }) }));

const gcue = (start: number, end: number, text_fr: string, o: { emphasis?: number; untranslated?: number } = {}) => ({
  start_ts: start, end_ts: end, text_fr, untranslated: o.untranslated ?? 0, emphasis: o.emphasis ?? 0,
});
out.groupCues = [
  {
    cues: [
      gcue(0, 2, 'Curry remonte la balle,'), gcue(2.2, 4, 'cherche l’écran'), gcue(4.3, 6, 'et déclenche !', { emphasis: 2 }),
      gcue(6.2, 8, 'Belle action.'), gcue(8.1, 9, 'Et maintenant'), gcue(9.2, 10, 'le consultant'), gcue(12, 13, 'reprend'),
      gcue(13.1, 14, 'EN line', { untranslated: 1 }), gcue(14.1, 15, 'puis repart'),
    ],
    speakers: [0, 0, 0, 0, 0, 1, 1, 1, 1],
  },
  { cues: [gcue(0, 5, 'un'), gcue(5.1, 10, 'deux'), gcue(10.1, 14, 'trois')], speakers: [0, 0, 0] },
  { cues: [gcue(0, 1, 'a'), gcue(1.1, 2, 'b »'), gcue(2.1, 3, 'c'), gcue(3.1, 4, '  '), gcue(4.1, 5, 'd', { emphasis: 1 }), gcue(5.1, 6, 'e')], speakers: [null, null, 2, 2] },
  { cues: [gcue(0, 1, 'x :'), gcue(1.1, 2, 'y'), gcue(2.1, 2.9, 'z')], speakers: [3, 3, 3] },
].map((c) => ({ ...c, groups: dub.groupCues(c.cues, c.speakers) }));

const crow = (seq: number, s: number, e: number, fr: string, u = 0, em = 0) => ({ match_id: 1, seq, start_ts: s, end_ts: e, text_en: 'x', text_fr: fr, untranslated: u, emphasis: em });
out.cuesSignature = [
  [],
  [crow(100001, 2, 5, 'Tatum remonte le ballon.')],
  [crow(100001, 2, 5, 'Tatum remonte le ballon.'), crow(100002, 6.25, 9.123456789, '« Quel tir » !\n\t"ok" \\ é😀', 1, 2)],
  [crow(1, 1e-7, 1.5e21, 'x', 0, 0)],
].map((rows) => ({ cues: rows, sig: dub.cuesSignature(rows) }));

// Locuteurs : suites d'appels (état complet après chacun), comme les cas de tests/dub.test.ts.
type Who = 'X' | 'Y' | 'W';
const basis = (k: number) => {
  const v = new Array<number>(192).fill(0.02);
  v[k] = 1;
  return v;
};
const VEC: Record<Who, number[]> = { X: basis(0), Y: basis(1), W: basis(2) };
const ALL = ['A', 'B4', 'B1', 'F'];
const vecOf = (v: string | number | null) => (v === null ? null : typeof v === 'number' ? basis(v) : VEC[v as Who]);
type Op =
  | ['speakers', number[], (string | number | null)[], (number | null)[], (number | null)[], { threshold?: number; minNewSec?: number; maxSpeakers?: number }]
  | ['roles', string[], number?, number?];
const sequences: [string, Op[], Record<string, string>?][] = [
  ['regroupement', [['speakers', [3, 3, 3, 3, 3, 3], ['X', 'X', 'Y', null, 'X', 'Y'], [110, 115, 130, null, 112, 126], [], { threshold: 0.6, minNewSec: 1 }]]],
  ['tete-sans-empreinte', [['speakers', [3, 3, 0.6], [null, 'X', 'Y'], [null, 110, 130], [], { threshold: 0.6, minNewSec: 1 }]]],
  ['bruit', [
    ['speakers', [3, 3, 3, 3, 3, 3], [0, 1, 2, 3, 4, 5], [110, 120, 130, 140, 150, 160], [], { threshold: 0.6 }],
    ['speakers', [3, 1.5], ['X', 'Y'], [110, 120], [], { threshold: 0.6 }],
  ]],
  ['max-2', [['speakers', [3, 3, 3], ['X', 'Y', 'W'], [1, 2, 3], [], { threshold: 0.6, maxSpeakers: 2 }]]],
  ['roles-stables', [
    ['speakers', [2, 5, 1, 4, 1], ['X', 'Y', 5, 'Y', 5], [110, 120, 100, 122, 101], [], { threshold: 0.6, minNewSec: 0.5 }],
    ['roles', ['A', 'B4', 'B1'], 165],
    ['speakers', [30], ['X'], [110], [], { threshold: 0.6 }],
    ['roles', ['A', 'B4', 'B1'], 165],
    ['speakers', [3], [9], [100], [], { threshold: 0.6 }],
    ['roles', ['A', 'B4', 'B1'], 165],
  ]],
  ['hauteur-par-defaut', [['speakers', [3, 3], ['W', 'X'], [240, 110], [], { threshold: 0.6 }], ['roles', ALL]]],
  ['hauteur-reglee', [['speakers', [3, 3], ['W', 'X'], [214, 110], [], { threshold: 0.6 }], ['roles', ALL, 165], ['speakers', [3], [7], [250], [], { threshold: 0.6 }], ['roles', ['A', 'B4', 'B1'], 165]]],
  ['classifieur', [['speakers', [6, 3, 5], ['W', 'X', 'W'], [200, 110, 205], [0.95, 0.03, 0.85], { threshold: 0.6 }], ['roles', ALL]]],
  ['classifieur-sans-F', [['speakers', [11], ['W'], [200], [0.95], { threshold: 0.6 }], ['roles', ['A', 'B4', 'B1']]]],
  ['seuil-desactive', [['speakers', [11], ['W'], [200], [0.99], { threshold: 0.6 }], ['roles', ALL]], { DUB_FEMALE_PROB: '1.01' }],
  ['homme-aigu', [
    ['speakers', [3, 4, 5, 4], ['W', 'W', 'X', 'W'], [245, 238, 110, 250], [0.12, 0.3, 0.02, 0.2], { threshold: 0.6 }],
    ['roles', ALL, 165],
    ['speakers', [20], ['W'], [250], [0.4], { threshold: 0.6 }],
    ['roles', ALL, 165],
  ]],
  ['trop-peu', [
    ['speakers', [12, 9.5], ['X', 'W'], [110, 210], [0.02, 0.99], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [0.8, 0.9, 0.7], ['W', 'W', 'W'], [210, 212, 208], [null, null, null], { threshold: 0.6, minNewSec: 0.5 }],
    ['roles', ALL],
    ['speakers', [0.8, 3], ['W', null], [210, null], [null, 0.99], { threshold: 0.6, minNewSec: 0.5 }],
    ['roles', ALL],
  ]],
  ['bascule', [
    ['speakers', [3, 2], ['W', 'X'], [210, 110], [0.97, 0.02], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [8], ['W'], [212], [0.97], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [10, 10], ['W', 'W'], [200, 200], [0.1, 0.1], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [5], [7], [105], [0.01], { threshold: 0.6 }],
    ['roles', ALL],
  ]],
  ['genre-fige', [
    ['speakers', [12, 12, 7], ['W', 'W', 'W'], [200, 200, 200], [], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [12, 12], ['W', 'W'], [200, 200], [0.99, 0.99], { threshold: 0.6 }],
    ['roles', ALL],
  ]],
  ['fenetre', [
    ['speakers', [28], ['W'], [200], [null], { threshold: 0.6 }],
    ['roles', ALL],
    ['speakers', [10, 6], ['W', 'W'], [200, 200], [0.95, 0.1], { threshold: 0.6 }],
    ['roles', ALL],
  ]],
  ['reglages-env', [['speakers', [1.5, 3, 3, 3], ['X', 'Y', 'W', 4], [100.04, 120.06, -5, Infinity], [0.5, 2, -0.1, 0.5], {}], ['roles', ['B4']]], { DUB_SPEAKER_SIM: '0.9', DUB_MIN_NEW_SPEAKER_SEC: '1', DUB_MAX_SPEAKERS: '2.7', DUB_FEMALE_F0: '150' }],
  ['f0-200', [['speakers', Array(205).fill(1), Array(205).fill('X'), Array.from({ length: 205 }, (_, i) => 100 + i * 0.123), [], { threshold: 0.6 }], ['roles', []]]],
];
out.speakers = sequences.map(([name, ops, env]) => {
  for (const [k, v] of Object.entries(env ?? {})) process.env[k] = v;
  const st = dub.emptySpeakers();
  const steps = ops.map((op) => {
    if (op[0] === 'speakers') {
      const [, d, e, f0, fem, o] = op;
      const ids = dub.assignSpeakers(st, d, e.map(vecOf), f0, fem, o);
      return { ids, state: JSON.parse(JSON.stringify(st)), used: dub.rolesUsed(st) };
    }
    const [, voices, hz, p] = op;
    const switched = dub.assignRoles(st, voices, hz, p).map((s: { id: number }) => s.id);
    return { switched, state: JSON.parse(JSON.stringify(st)), used: dub.rolesUsed(st) };
  });
  for (const k of Object.keys(env ?? {})) delete process.env[k];
  return { name, ops: ops.map((o) => o.map((x) => (Array.isArray(x) ? x.map((y) => (y === Infinity ? 'Infinity' : y)) : x))), env: env ?? {}, steps };
});

out.voiceFor = (['A', 'B4', 'B1', 'F'] as const).flatMap((r) =>
  [['A', 'B4', 'B1'], ['A', 'B4'], ['B4'], ['F'], ['A', 'B4', 'B1', 'F'], ['Z'], []].map((v) => ({ role: r, voices: v, voice: dub.voiceFor(r, v) })),
);

// ------------------------------------------------------------------ montage (ffmpeg)

{
  const fake = path.join(ROOT, 'server', 'tests', 'helpers', 'fake_ffmpeg.sh');
  const log = path.join(DATA, 'ffmpeg-args.txt');
  process.env.FFMPEG_PATH = fake;
  process.env.FAKE_FFMPEG_LOG = log;
  const cases: [{ file: string; at: number; tempo: number }[], number][] = [
    [[{ file: '/x/a.wav', at: 1, tempo: 1 }, { file: '/x/b.wav', at: 2.5, tempo: 1.25 }], 4],
    [[], 2],
    [[], 0.05],
    [[{ file: '/x/c d.wav', at: 0.0000204, tempo: 1.0005 }, { file: '/x/e.wav', at: -1, tempo: 1.3456 }, { file: '/x/f.wav', at: 119.99997, tempo: 1.001 }], 120.0005],
    [[{ file: '/x/g.wav', at: 3.14159, tempo: 1.0015 }], NaN],
  ];
  const args: unknown[] = [];
  for (const [clips, duration] of cases) {
    const o = path.join(DATA, 'chunk.m4a.part');
    await dub.assembleChunk(clips, duration, o);
    args.push({ clips, duration: Number.isNaN(duration) ? 'NaN' : duration, args: fs.readFileSync(log, 'utf8').split('\n').slice(0, -1).map((a) => (a === o ? '<out>' : a)) });
  }
  delete process.env.FFMPEG_PATH;
  delete process.env.FAKE_FFMPEG_LOG;
  // Échec : code et fin de stderr.
  let failure: string | null = null;
  try {
    await dub.assembleChunk([{ file: path.join(DATA, 'absent.wav'), at: 0, tempo: 1 }], 1, path.join(DATA, 'x.m4a'));
  } catch (e) {
    // Adresses internes de ffmpeg (« [in#1 @ 0x…] ») : variables d'un lancement à l'autre.
    failure = (e as Error).message.replace(DATA, '<data>').replace(/@ 0x[0-9a-f]+/g, '@ 0x…');
  }
  // Vrai ffmpeg : métadonnées du fichier produit.
  let probe: unknown = null;
  if (spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0) {
    const a = path.join(DATA, 'a.wav');
    const b = path.join(DATA, 'b.wav');
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5:sample_rate=22050', '-ac', '1', a]);
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.4:sample_rate=24000', '-ac', '1', b]);
    const o = path.join(DATA, 'real.m4a');
    await dub.assembleChunk([{ file: a, at: 1, tempo: 1 }, { file: b, at: 2.5, tempo: 1.25 }], 4, o);
    probe = JSON.parse(
      spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration_ts:format=duration,format_name,size', '-of', 'json', o]).stdout.toString(),
    );
  }
  out.assemble = { args, failure, probe };
}

// ------------------------------------------------------------------ travaux complets (runDub)

const M = 403000001;
const M2 = 403000002;
const F0: Record<Who, number> = { X: 112, Y: 128, W: 214 };
const FEMALE: Record<Who, number> = { X: 0.02, Y: 0.06, W: 0.96 };
type Line = [number, number, string, Who, number?, boolean?];
const CHUNK0: Line[] = [
  [2, 5, 'Tatum remonte le ballon.', 'X'],
  [6, 9, 'Il accélère et marque.', 'X'],
  [10, 13, 'Belle défense des Lakers.', 'Y'],
  [14, 15.5, 'Quel tir.', 'X', 2],
  [20, 23, 'Timeout on the floor.', 'X', 0, true],
  [30, 34, 'Le banc se lève.', 'X'],
  [40, 44, 'Ils mènent de quatre points.', 'Y'],
];
const CHUNK1: Line[] = [
  [125, 128, 'Retour au jeu.', 'Y'],
  [130, 133, 'Panier à trois points.', 'X', 2],
  [135, 139, 'Je suis au bord du terrain.', 'W'],
  [140, 146, 'Le coach semble inquiet.', 'W'],
];
const CHUNK2: Line[] = [
  [250, 253, 'Dernière possession.', 'X'],
  [255, 258, 'C’est terminé.', 'Y'],
];
const SCRIPT = [...CHUNK0, ...CHUNK1, ...CHUNK2];
out.lines = { CHUNK0, CHUNK1, CHUNK2 };
const whoAt = (t: number, script: Line[] = SCRIPT): Who | null => script.find(([a, b]) => t >= a && t <= b)?.[3] ?? null;

let TRACK: Record<string, unknown>;
function publish(matchId: number, idx: number, lines: Line[], track = TRACK): void {
  db.publishCommentaryChunk(
    matchId,
    track,
    { idx, keepFrom: idx * 120, keepTo: idx === 2 ? Number.POSITIVE_INFINITY : (idx + 1) * 120 },
    lines.map(([s, e, fr, , emphasis, untranslated], k) => ({
      seq: db.chunkSeqBase(idx) + k + 1, start_ts: s, end_ts: e, text_en: `EN ${fr}`, text_fr: untranslated ? `EN ${fr}` : fr,
      untranslated: untranslated ? 1 : 0, emphasis: emphasis ?? 0,
    })),
  );
}

interface FakeOpts {
  voices?: string[];
  failOpen?: boolean;
  failSynth?: string[] | 'all';
  failEmbed?: boolean;
  durations?: Record<string, number>;
  script?: Line[];
  noGender?: boolean;
  /** Résolution du flux : échecs avant succès (∞ : toujours). */
  resolveFails?: number;
  /** Sources du flux (variants HLS) ; la fausse extraction échoue pour les `extractFails` premières. */
  variants?: number;
  extractFails?: number;
  local?: boolean;
  yieldAfter?: number;
  target?: number;
}

function fake(o: FakeOpts = {}) {
  const calls = {
    synth: [] as { text: string; voice: string; emphasis: number | null }[],
    extract: [] as { url: string; start: number; length: number; ua: string | null; referer: string | null }[],
    resolve: [] as boolean[],
    embed: [] as [number, number][][],
    opened: 0,
    closed: 0,
    slices: [] as [number, number][],
    assemble: [] as { clips: { file: string; at: number; tempo: number }[]; duration: number; out: string }[],
  };
  const extractStart = new Map<string, number>();
  let failures = 0;
  const session = {
    voices: o.voices ?? ['A', 'B4', 'B1'],
    synth: async (text: string, voice: string, file: string, _s?: AbortSignal, x?: { emphasis?: number }) => {
      calls.synth.push({ text, voice, emphasis: x?.emphasis ?? null });
      if (o.failSynth === 'all' || o.failSynth?.includes(text)) throw new Error('la voix a planté\n  (CUDA)');
      fs.writeFileSync(file, 'RIFF');
      return { duration: o.durations?.[text] ?? 1, sampleRate: 24_000 };
    },
    embed: async (file: string, segments: [number, number][]) => {
      calls.embed.push(segments);
      if (o.failEmbed) throw new Error('ECAPA indisponible');
      const s0 = extractStart.get(path.basename(file)) ?? 0;
      const who = segments.map(([a, b]) => whoAt(s0 + (a + b) / 2, o.script));
      const r = { embeddings: who.map((w) => (w ? VEC[w] : null)), f0: who.map((w) => (w ? F0[w] : null)) };
      return o.noGender ? r : { ...r, female: who.map((w) => (w ? FEMALE[w] : null)) };
    },
    close: async () => void calls.closed++,
  };
  const deps: Record<string, unknown> = {
    resolveStream: async (_okId: string, force?: boolean) => {
      calls.resolve.push(!!force);
      if (failures++ < (o.resolveFails ?? 0)) throw new Error('ok.ru : 503\nService Unavailable');
      const n = o.variants ?? 1;
      return { variants: Array.from({ length: n }, (_, i) => ({ key: `v${i}`, bandwidth: 600_000 + i, resolution: '640x360', url: `https://vd.okcdn.ru/v${i}.m3u8` })), duration: 400 };
    },
    extract: async (url: string, start: number, length: number, file: string, x: { userAgent?: string; referer?: string }) => {
      calls.extract.push({ url, start, length, ua: x.userAgent ? 'BROWSER_UA' : null, referer: x.referer ?? null });
      if (calls.extract.length <= (o.extractFails ?? 0)) throw new Error('HTTP 403');
      extractStart.set(path.basename(file), start);
      fs.writeFileSync(file, Buffer.alloc(2048));
    },
    openVoice: async () => {
      if (o.failOpen) throw new Error('CUDA indisponible\n\tsur ce serveur');
      calls.opened++;
      return session;
    },
    assemble: async (clips: { file: string; at: number; tempo: number }[], duration: number, file: string) => {
      calls.assemble.push({ clips: clips.map((c) => ({ ...c, file: path.basename(c.file) })), duration, out: path.basename(file) });
      fs.writeFileSync(file, Buffer.from(`m4a:${clips.length}:${duration.toFixed(2)}`));
    },
  };
  if (o.local !== undefined) {
    deps.localAudio = async (_okId: string, start: number, length: number, file: string) => {
      calls.slices.push([start, length]);
      if (!o.local) return false;
      extractStart.set(path.basename(file), start);
      fs.writeFileSync(file, Buffer.alloc(2048));
      return true;
    };
  }
  return { deps, calls };
}

function reset() {
  db.setDbForTests(db.openDatabase(':memory:'));
  fs.rmSync(path.join(DATA, 'dub'), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'commentary'), { recursive: true, force: true });
  cm.__setCommentaryRunnerForTests(null);
  dub.__setDubRunnerForTests(null);
  dub.__setDubEngineForTests({ config: () => ({}), open: async () => Promise.reject(new Error('pas de moteur')) });
  helpers.insertMatch(M, { duration: 400 });
  helpers.insertMatch(M2, { duration: 400 });
  TRACK = { ok_id: db.getMatch(M)!.video_ok_id!, transcribe_model: 'large-v3-turbo', translate_model: 'translategemma:12b', chunk_sec: 120, chunks_total: 3 };
  logs = [];
}

function rows(sql: string) {
  return db.getDb().prepare(sql).all() as Record<string, unknown>[];
}
const maskAt = (v: Record<string, unknown>) => (v && typeof v === 'object' && 'at' in v ? { ...v, at: '<at>' } : v);
function snapshot() {
  return {
    tracks: rows('SELECT * FROM dub_tracks ORDER BY match_id').map(({ updated_at: _u, ...r }) => r),
    chunks: rows('SELECT * FROM dub_chunks ORDER BY match_id, idx').map(({ created_at: _c, ...r }) => r),
    kv: rows("SELECT key, value FROM kv_cache WHERE key LIKE 'dub:%' ORDER BY key").map((r) => ({ key: r.key, value: maskAt(JSON.parse(r.value as string)) })),
  };
}
const manifest = (id: number) => JSON.parse(JSON.stringify(dub.dubManifest(id)).replace(/\?v=\d+/g, '?v=<t>'));
const files = (id: number) => (fs.existsSync(dub.dubDir(id)) ? fs.readdirSync(dub.dubDir(id)).sort() : null);

const runs: unknown[] = [];
async function step(label: string, f: ReturnType<typeof fake>, o: FakeOpts = {}, matchId = M) {
  const events: unknown[] = [];
  let n = 0;
  const ctl = { yieldReason: () => (o.yieldAfter !== undefined && ++n > o.yieldAfter ? 'gpu' : null), target: () => o.target ?? 0 };
  let outcome: unknown;
  try {
    outcome = { ok: await dub.runDub({ matchId }, (p: unknown) => events.push(p), new AbortController().signal, f.deps, ctl) };
  } catch (e) {
    outcome = { err: (e as Error).message };
  }
  const r = { label, outcome, events, calls: JSON.parse(JSON.stringify(f.calls)), db: snapshot(), files: files(matchId), logs, manifest: manifest(matchId) };
  logs = [];
  return r;
}
async function scenario(name: string, fn: () => Promise<unknown[]>) {
  reset();
  runs.push({ name, steps: await fn() });
}
const run = (label: string, o: FakeOpts = {}, matchId = M) => step(label, fake(o), o, matchId);

await scenario('partiel', async () => {
  publish(M, 0, CHUNK0);
  publish(M, 1, CHUNK1);
  return [await run('run', { voices: ALL })];
});
await scenario('stables-puis-complet', async () => {
  publish(M, 0, CHUNK0);
  const a = await run('premier');
  publish(M, 2, CHUNK2);
  publish(M, 1, CHUNK1);
  return [a, await run('second', { target: 250 })];
});
await scenario('bascule-vers-F', async () => {
  const late: Line[] = [
    [2, 8, 'Tatum remonte le ballon.', 'X'], [10, 13, 'Je suis au bord du terrain.', 'W'], [20, 26, 'Il accélère et marque.', 'X'],
    [125, 133, 'Le coach semble inquiet.', 'W'], [134, 140, 'Panier à trois points.', 'X'], [250, 253, 'On revient au jeu.', 'W'],
  ];
  publish(M, 0, late.slice(0, 3));
  const a = await run('premier', { voices: ALL, script: late });
  publish(M, 1, late.slice(3, 5));
  publish(M, 2, late.slice(5));
  return [a, await run('second', { voices: ALL, script: late })];
});
await scenario('sans-classifieur', async () => {
  publish(M, 1, CHUNK1);
  return [await run('run', { voices: ALL, noGender: true })];
});
await scenario('trop-longue', async () => {
  publish(M, 0, [[10, 13, 'Une très longue phrase qui ne tient pas.', 'X'], [13.8, 16, 'Suite.', 'X'], [16.2, 17, 'Encore', 'Y'], [17.1, 18, 'et encore.', 'Y']]);
  return [await run('run', { durations: { 'Une très longue phrase qui ne tient pas.': 6, 'Encore et encore.': 2.7 } })];
});
await scenario('replique-en-echec', async () => {
  publish(M, 0, CHUNK0);
  const a = await run('une', { failSynth: ['Le banc se lève.'] });
  publish(M, 1, CHUNK1);
  return [a, await run('toutes', { failSynth: 'all' })];
});
await scenario('synthese-vide', async () => {
  publish(M, 0, CHUNK0.slice(0, 2));
  return [await run('run', { durations: { 'Tatum remonte le ballon.': 0 } })];
});
await scenario('moteur-indisponible', async () => {
  publish(M, 0, CHUNK0);
  return [await run('run', { failOpen: true })];
});
await scenario('empreintes-impossibles', async () => {
  publish(M, 0, CHUNK0);
  return [await run('run', { failEmbed: true })];
});
await scenario('flux', async () => {
  publish(M, 0, CHUNK0);
  const a = await run('resolution-en-echec', { resolveFails: 99 });
  const b = await run('resolution-reessayee', { resolveFails: 1 });
  db.deleteDub(M);
  const c = await run('sources', { variants: 5, extractFails: 4 });
  db.deleteDub(M);
  const d = await run('sources-toutes-ko', { variants: 2, extractFails: 99 });
  return [a, b, c, d];
});
await scenario('piste-changee', async () => {
  publish(M, 0, CHUNK0);
  const a = await run('premier');
  publish(M, 0, CHUNK0.map((l, i) => (i === 0 ? ([l[0], l[1], 'Tatum avance.', l[3]] as Line) : l)));
  const b = await run('retraduit');
  fs.writeFileSync(path.join(dub.dubDir(M), 'chunk-7.m4a'), 'vieux');
  const track2 = { ...TRACK, translate_model: 'gemma4:e4b' };
  db.openCommentaryTrack(M, track2);
  publish(M, 1, CHUNK1, track2);
  const c = await run('nouveau-modele');
  return [a, b, c];
});
await scenario('cede-la-place', async () => {
  publish(M, 0, CHUNK0);
  publish(M, 1, CHUNK1);
  return [await run('entre-deux-repliques', { yieldAfter: 3 }), await run('avant-le-troncon', { yieldAfter: 0 }), await run('apres-un-troncon', { yieldAfter: 8 })];
});
await scenario('une-traite', async () => {
  publish(M, 0, [[2, 4, 'Curry remonte la balle,', 'X'], [4.2, 6, 'cherche l’écran', 'X'], [6.3, 8, 'et déclenche !', 'X', 2], [8.5, 10, 'Dedans', 'Y', 1]]);
  return [await run('run')];
});
await scenario('son-complet', async () => {
  publish(M, 0, CHUNK0);
  const a = await run('decoupe', { local: true });
  db.deleteDub(M);
  const b = await run('absent', { local: false });
  publish(M, 1, CHUNK1);
  publish(M, 2, CHUNK2);
  // Son complet sur disque : le doublage complet l'efface.
  const full = path.join(cm.workDir(db.getMatch(M)!.video_ok_id!), 'full.ogg');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'ogg');
  const c = await run('complet', { local: true });
  return [a, b, { ...c, fullAudioKept: fs.existsSync(full) }];
});
await scenario('troncons-sans-replique', async () => {
  publish(M, 0, [[20, 23, 'Timeout on the floor.', 'X', 0, true]]);
  publish(M, 1, []);
  return [await run('run')];
});
await scenario('etat-en-base', async () => {
  publish(M, 0, CHUNK0);
  const t = db.getCommentaryTrack(M)!;
  db.openDubTrack(M, t.ok_id, db.commentaryKey(t));
  const state = {
    zzz: 1,
    speakers: [
      { role: 'B4', id: 4, extra: { a: [1, 2] }, f0: [128], centroid: VEC.Y, talk: 12.345, n: 3, femaleP: 0.05, femaleSec: 12.3 },
      { id: 'x', centroid: [], f0: [] },
      { id: 1.5, centroid: [], f0: [] },
      null,
      { id: 7, centroid: basis(9), f0: [] },
    ],
    nextId: '2',
  };
  db.getDb().prepare('UPDATE dub_tracks SET speakers = ? WHERE match_id = ?').run(JSON.stringify(state), M);
  const a = await run('relu');
  db.getDb().prepare("UPDATE dub_tracks SET speakers = 'pas du json' WHERE match_id = ?").run(M);
  publish(M, 0, CHUNK0.slice(0, 3));
  return [a, await run('illisible')];
});
await scenario('sans-replay-ni-sous-titres', async () => {
  const a = await run('sans-sous-titres');
  db.setVideo(M, { slug: null, okId: null, duration: null, available: false });
  return [a, await run('sans-replay')];
});
out.runs = runs;

// ------------------------------------------------------------------ file : états

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
{
  reset();
  process.env.DUB_REPUMP_MS = '10';
  process.env.COMMENTARY_REPUMP_MS = '10';
  process.env.COMMENTARY_VIEWER_IDLE_MS = '60000';
  const t2 = { ...TRACK, ok_id: db.getMatch(M2)!.video_ok_id! };
  publish(M, 0, CHUNK0);
  publish(M2, 0, CHUNK0, t2);
  const states: unknown[] = [];
  const results: unknown[] = [];
  const snap = (label: string) =>
    states.push({
      label,
      manifest: { [M]: manifest(M), [M2]: manifest(M2) },
      activity: dub.dubActivity(),
      positions: [dub.dubQueuePosition(M), dub.dubQueuePosition(M2)],
      commentary: cm.commentaryActivity(),
      db: snapshot(),
    });
  // Doublage simulé : attend sa porte, ou l'interruption.
  const gates = new Map<number, ReturnType<typeof deferred<unknown>>>();
  const started: number[] = [];
  let progressOf: ((p: unknown) => void) | null = null;
  dub.__setDubRunnerForTests((job: { matchId: number }, progress: (p: unknown) => void, signal: AbortSignal) => {
    started.push(job.matchId);
    progressOf = progress;
    const d = deferred<unknown>();
    gates.set(job.matchId, d);
    signal.addEventListener('abort', () => d.resolve({ ok: false, kind: 'erreur', reason: 'interrompu' }), { once: true });
    return d.promise;
  });
  const cgates = new Map<number, ReturnType<typeof deferred<unknown>>>();
  cm.__setCommentaryRunnerForTests((job: { matchId: number }) => {
    const d = deferred<unknown>();
    cgates.set(job.matchId, d);
    return d.promise;
  });
  let downloading: { done: number; total: number } | null = null;
  let prepared = 0;
  dub.__setDubEngineForTests({ config: () => ({}), open: async () => Promise.reject(new Error('x')), prepare: async () => void prepared++, download: () => downloading });
  results.push(dub.enqueueDub(M));
  results.push(dub.releaseGpuForTranslation());
  snap('rien');
  results.push(dub.enqueueDub(M, { explicit: true }));
  snap('en cours sans avancement');
  progressOf!({ done: 1, total: 3, chunk: 1, step: 'synthèse des répliques : 1 / 4' });
  snap('en cours');
  downloading = { done: 1.1e9, total: 2.5e9 };
  snap('en cours, téléchargement des voix');
  downloading = null;
  results.push(dub.enqueueDub(M2, { explicit: true }));
  results.push(dub.enqueueDub(M, { explicit: true }));
  results.push(dub.enqueueDub(M2));
  snap('M2 en file');
  results.push(dub.stopDub(M2));
  results.push(dub.stopDub(M2));
  snap('M2 arrêté');
  dub.prioritizeDubOnView(M2);
  // « Reprendre » : traduction de M2 d'abord (piste partielle), elle prend le GPU.
  results.push(dub.requestDub(M2));
  await sleep(150);
  snap('M2 repris, sa traduction prend le GPU au doublage de M');
  downloading = { done: 3e8, total: 0 };
  snap('attente du GPU, téléchargement des voix');
  downloading = null;
  cgates.get(M2)!.resolve({ ok: true, reason: 'traduit' });
  await sleep(100);
  snap('traduction finie : M en tête (rendu par le GPU)');
  gates.get(M)!.resolve({ ok: false, kind: 'service', reason: 'Moteur de voix indisponible : x (nouvel essai automatique)' });
  await sleep(50);
  snap('M en échec service, M2 en cours');
  gates.get(M2)!.resolve({ ok: false, yielded: 'viewer', reason: 'en pause (0 tronçon(s) doublé(s)) : un autre match est regardé' });
  await sleep(50);
  snap('M2 a cédé (lecture)');
  gates.get(M2)!.resolve({ ok: false, yielded: 'window', reason: 'en pause (0 tronçon(s) doublé(s)) : hors de la fenêtre des tâches de fond' });
  await sleep(50);
  snap('M2 hors fenêtre');
  // Pistes traduites complètes : les demandes ne passent plus par la traduction.
  publish(M, 1, CHUNK1);
  publish(M, 2, CHUNK2);
  publish(M2, 1, CHUNK1, t2);
  publish(M2, 2, CHUNK2, t2);
  for (const [kind, reason] of [['service', 'service encore'], ['erreur', 'boum'], [undefined, 'sans nature']] as const) {
    results.push(dub.requestDub(M));
    await sleep(20);
    gates.get(M)!.resolve({ ok: false, ...(kind ? { kind } : {}), reason });
    await sleep(50);
  }
  snap('échecs répétés');
  results.push(dub.requestDub(M));
  await sleep(20);
  gates.get(M)!.resolve({ ok: true, reason: '1 tronçon(s) doublé(s)' });
  await dub.__dubIdle();
  snap('succès');
  // Regardé : le doublage demandé passe en tête ; le doublage d'un autre match est interrompu.
  results.push(dub.requestDub(M2));
  await sleep(20);
  cm.touchViewer(M, 10);
  results.push(dub.enqueueDub(M, { priority: true }));
  await sleep(50);
  snap('M regardé passe devant M2');
  gates.get(M)!.resolve({ ok: true, reason: 'ok' });
  await sleep(50);
  snap('M fini, M2 attend la fin de la lecture');
  results.push(dub.requestDub(M, { reset: true }));
  snap('M relancé');
  results.push(dub.requestDub(M, { reset: true }));
  gates.get(M)!.resolve({ ok: true, reason: 'ok' });
  await sleep(50);
  // Doublage complet et à jour : rien à refaire.
  const tm = db.getCommentaryTrack(M)!;
  db.openDubTrack(M, tm.ok_id, db.commentaryKey(tm));
  db.setDubComplete(M, true);
  results.push(dub.requestDub(M));
  snap('déjà doublé');
  process.env.DUB_DISABLED = '1';
  results.push(dub.enqueueDub(M, { explicit: true }));
  results.push(dub.requestDub(M));
  snap('inactif');
  delete process.env.DUB_DISABLED;
  for (const k of ['DUB_REPUMP_MS', 'COMMENTARY_REPUMP_MS', 'COMMENTARY_VIEWER_IDLE_MS']) delete process.env[k];
  dub.__setDubRunnerForTests(null);
  cm.__setCommentaryRunnerForTests(null);
  out.queue = { results, states, started, prepared: prepared > 0, logs: logs.filter(([, l]) => l.startsWith('[doublage]')) };
  logs = [];
}

fs.writeFileSync(path.join(OUT, 'dub.expected.json'), `${JSON.stringify(out)}\n`);
fs.rmSync(DATA, { recursive: true, force: true });
process.stdout.write(`doublage : ${runs.length} scénarios, ${(out.queue as { states: unknown[] }).states.length} états de la file écrits dans server/tests/fixtures/dub.expected.json\n`);
