import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { __setCommentaryRunnerForTests, enqueueCommentary, touchViewer } from '../src/lib/commentary';
import { currentActivity } from '../src/lib/activity';
import { settingSet } from '../src/lib/db';
import {
  __dubIdle,
  __setDubEngineForTests,
  __setDubRunnerForTests,
  assembleChunk,
  assignRoles,
  assignSpeakers,
  dubActivity,
  dubDir,
  dubManifest,
  emphasize,
  emptySpeakers,
  enqueueDub,
  enqueueRecentDubs,
  fitCue,
  getDubRecord,
  nextDubChunk,
  placeClips,
  prioritizeDubOnView,
  runDub,
  speechRanges,
  voiceFor,
  type DubControl,
  type DubDeps,
  type VoiceSessionLike,
} from '../src/lib/dub';
import { GET as getDub } from '../src/app/api/matches/[id]/dub/route';
import { GET as getDubAudio } from '../src/app/api/matches/[id]/dub/[idx]/route';
import { freshDb, insertMatch } from './helpers/db';

/**
 * Doublage français : locuteurs et voix, calage des répliques, travail
 * tronçon par tronçon (moteur de voix, extraction et montage simulés),
 * file (GPU partagé avec la traduction, priorité à la lecture), API.
 */

const M = 403000001;
const M2 = 403000002;

// ------------------------------------------------------------------ voix simulées

type Who = 'X' | 'Y' | 'W';
const basis = (k: number) => {
  const v = new Array<number>(192).fill(0.02);
  v[k] = 1;
  return v;
};
const VEC: Record<Who, number[]> = { X: basis(0), Y: basis(1), W: basis(2) };
const F0: Record<Who, number> = { X: 112, Y: 128, W: 214 };

/** [début, fin, texte FR, locuteur, emphase?, non traduit?] */
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
  [135, 137.5, 'Je suis au bord du terrain.', 'W'],
  [140, 143, 'Le coach semble inquiet.', 'W'],
];
const CHUNK2: Line[] = [
  [250, 253, 'Dernière possession.', 'X'],
  [255, 258, 'C’est terminé.', 'Y'],
];
const SCRIPT = [...CHUNK0, ...CHUNK1, ...CHUNK2];
const whoAt = (t: number): Who | null => SCRIPT.find(([a, b]) => t >= a && t <= b)?.[3] ?? null;

let TRACK: db.CommentaryTrackMeta;

function publish(matchId: number, idx: number, lines: Line[], track = TRACK): void {
  db.publishCommentaryChunk(
    matchId,
    track,
    { idx, keepFrom: idx * 120, keepTo: idx === 2 ? Number.POSITIVE_INFINITY : (idx + 1) * 120 },
    lines.map(([s, e, fr, , emphasis, untranslated], k) => ({
      seq: db.chunkSeqBase(idx) + k + 1,
      start_ts: s,
      end_ts: e,
      text_en: `EN ${fr}`,
      text_fr: untranslated ? `EN ${fr}` : fr,
      untranslated: untranslated ? 1 : 0,
      emphasis: emphasis ?? 0,
    })),
  );
}

interface FakeOpts {
  voices?: string[];
  failOpen?: boolean;
  failSynth?: (text: string) => boolean;
  onSynth?: (n: number, text: string) => void;
  duration?: (text: string) => number;
}

function fake(o: FakeOpts = {}) {
  const calls = {
    synth: [] as { text: string; voice: string }[],
    extract: [] as number[],
    embed: 0,
    opened: 0,
    closed: 0,
    assemble: [] as { clips: { file: string; at: number; tempo: number }[]; duration: number; out: string }[],
  };
  const extractStart = new Map<string, number>();
  const session: VoiceSessionLike = {
    voices: o.voices ?? ['A', 'B4', 'B1'],
    synth: async (text, voice, out) => {
      calls.synth.push({ text, voice });
      o.onSynth?.(calls.synth.length, text);
      if (o.failSynth?.(text)) throw new Error('la voix a planté');
      fs.writeFileSync(out, 'RIFF');
      return { duration: o.duration?.(text) ?? 1, sampleRate: 24_000 };
    },
    embed: async (file, segments) => {
      calls.embed++;
      const s0 = extractStart.get(file) ?? 0;
      const who = segments.map(([a, b]) => whoAt(s0 + (a + b) / 2));
      return { embeddings: who.map((w) => (w ? VEC[w] : null)), f0: who.map((w) => (w ? F0[w] : null)) };
    },
    close: async () => void calls.closed++,
  };
  const deps: DubDeps = {
    resolveStream: async () => ({ variants: [{ key: 'low', bandwidth: 600_000, resolution: '640x360', url: 'https://vd.okcdn.ru/low.m3u8' }], duration: 400 }),
    extract: async (_url, start, _len, out) => {
      calls.extract.push(start);
      extractStart.set(out, start);
      fs.writeFileSync(out, Buffer.alloc(2048));
    },
    openVoice: async () => {
      if (o.failOpen) throw new Error('CUDA indisponible');
      calls.opened++;
      return session;
    },
    assemble: async (clips, duration, out) => {
      calls.assemble.push({ clips: clips.map((c) => ({ ...c })), duration, out });
      fs.writeFileSync(out, Buffer.from(`m4a:${clips.length}:${duration.toFixed(2)}`));
    },
  };
  return { deps, calls, session };
}

const signal = () => new AbortController().signal;
const viaQueue = (deps: DubDeps) => __setDubRunnerForTests((job, p, sig, c) => runDub(job, p, sig, deps, c));
const params = (id: number, idx?: number) => ({ params: Promise.resolve({ id: String(id), ...(idx === undefined ? {} : { idx: String(idx) }) }) as Promise<{ id: string; idx: string }> });

let dataDir: string;

beforeEach(() => {
  freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-dub-'));
  process.env.DATA_DIR = dataDir;
  process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  insertMatch(M, { duration: 400 });
  insertMatch(M2, { duration: 400 });
  TRACK = { ok_id: db.getMatch(M)!.video_ok_id!, transcribe_model: 'large-v3-turbo', translate_model: 'translategemma:12b', chunk_sec: 120, chunks_total: 3 };
  __setDubEngineForTests({ config: () => ({}), open: async () => fake().session });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  __setDubRunnerForTests(null);
  __setCommentaryRunnerForTests(null);
  __setDubEngineForTests(null);
  for (const k of ['DATA_DIR', 'DUB_DISABLED', 'DUB_REPUMP_MS', 'COMMENTARY_VIEWER_IDLE_MS', 'COMMENTARY_REPUMP_MS', 'TRANSCRIBE_URL', 'TRANSLATE_URL', 'DUB_SPEAKER_SIM']) delete process.env[k];
  process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ fonctions pures

describe('texte : moments forts', () => {
  it('emphase 2 : « ! » final (point remplacé, sinon ajouté) ; « ! », « ? », « … » gardés', () => {
    expect(emphasize('Quel tir.', 2)).toBe('Quel tir !');
    expect(emphasize('Il marque', 2)).toBe('Il marque !');
    expect(emphasize('Et il tire,', 2)).toBe('Et il tire !');
    expect(emphasize('Incroyable !', 2)).toBe('Incroyable !');
    expect(emphasize('Il va tirer ?', 2)).toBe('Il va tirer ?');
    expect(emphasize('Et là…', 2)).toBe('Et là…');
    expect(emphasize('Et là...', 2)).toBe('Et là...');
    expect(emphasize('Il crie « allez ».', 2)).toBe('Il crie « allez » !');
    expect(emphasize('Quel tir.', 1)).toBe('Quel tir.');
    expect(emphasize('  Quel tir.  ', 0)).toBe('Quel tir.');
  });
});

describe('calage des répliques', () => {
  it('place : jusqu’au sous-titre suivant, au plus 0,6 s après la fin du sien', () => {
    expect(fitCue(2, 10, 13, 20)).toMatchObject({ slot: 3.6, tempo: 1, fitted: 2, overrun: false });
    expect(fitCue(2, 10, 13, 12)).toMatchObject({ slot: 2, tempo: 1, overrun: false });
    expect(fitCue(2, 10, 13, null).slot).toBeCloseTo(3.6);
  });

  it('trop longue : accélérée (atempo = durée / place), au plus ×1,35, au-delà déborde', () => {
    const a = fitCue(4, 10, 13, 20); // place 3,6 s
    expect(a.tempo).toBeCloseTo(4 / 3.6, 3);
    expect(a.fitted).toBeCloseTo(3.6, 2);
    expect(a.overrun).toBe(false);
    const b = fitCue(6, 10, 13, 20);
    expect(b.tempo).toBe(1.35);
    expect(b.fitted).toBeCloseTo(6 / 1.35);
    expect(b.overrun).toBe(true);
  });

  it('une réplique qui déborde repousse la suivante (jamais deux voix en même temps)', () => {
    expect(placeClips([{ start: 10, fitted: 4.4 }, { start: 13.8, fitted: 1 }, { start: 30, fitted: 1 }])).toEqual([10, 14.45, 30]);
  });

  it('plages de parole fusionnées et arrondies', () => {
    expect(speechRanges([[3.2, 5.9], [6.0, 8.004], [12, 13]])).toEqual([[3.2, 8], [12, 13]]);
  });

  it('prochain tronçon : celui du spectateur ou le suivant, puis le premier', () => {
    const todo = [0, 2, 3].map((i) => ({ idx: i, keepFrom: i * 120, keepTo: i === 3 ? Infinity : (i + 1) * 120 }));
    expect(nextDubChunk(todo, 0)?.idx).toBe(0);
    expect(nextDubChunk(todo, 150)?.idx).toBe(2); // tronçon 1 déjà fait
    expect(nextDubChunk(todo, 9999)?.idx).toBe(3);
  });
});

describe('locuteurs et voix', () => {
  const durations = (n: number, d = 3) => new Array<number>(n).fill(d);

  it('regroupement : même voix → même locuteur ; voix inconnue → nouveau ; sans empreinte → celui d’avant', () => {
    const st = emptySpeakers();
    const ids = assignSpeakers(st, durations(6), [VEC.X, VEC.X, VEC.Y, null, VEC.X, VEC.Y], [110, 115, 130, null, 112, 126], { threshold: 0.6, minNewSec: 1 });
    expect(ids).toEqual([0, 0, 1, 1, 0, 1]);
    expect(st.speakers).toHaveLength(2);
    expect(st.speakers[0].talk).toBe(9);
    expect(st.speakers[1].talk).toBe(9);
  });

  it('réplique trop courte et inconnue : rattachée au locuteur le plus proche ; tête sans empreinte : celui d’après', () => {
    const st = emptySpeakers();
    const ids = assignSpeakers(st, [3, 3, 0.6], [null, VEC.X, VEC.Y], [null, 110, 130], { threshold: 0.6, minNewSec: 1 });
    expect(ids).toEqual([0, 0, 0]);
    expect(st.speakers).toHaveLength(1);
  });

  it('rôles : 1er temps de parole → A, 2e → B4, suivants → B1 ; stables ; nouveau locuteur → prochaine voix libre', () => {
    const st = emptySpeakers();
    assignSpeakers(st, [2, 5, 1, 4, 1], [VEC.X, VEC.Y, basis(5), VEC.Y, basis(5)], [110, 120, 100, 122, 101], { threshold: 0.6, minNewSec: 0.5 });
    assignRoles(st, ['A', 'B4', 'B1'], 165);
    expect(st.speakers.map((s) => s.role)).toEqual(['B4', 'A', 'B1']); // Y parle le plus
    // Plus tard, X parle beaucoup : sa voix ne change pas.
    assignSpeakers(st, [30], [VEC.X], [110], { threshold: 0.6 });
    assignRoles(st, ['A', 'B4', 'B1'], 165);
    expect(st.speakers[0].role).toBe('B4');
    // Un nouveau locuteur prend la prochaine voix libre (A et B4 prises → B1).
    assignSpeakers(st, [3], [basis(9)], [100], { threshold: 0.6 });
    assignRoles(st, ['A', 'B4', 'B1'], 165);
    expect(st.speakers[3].role).toBe('B1');
  });

  it('voix aiguë : F si le moteur l’a, sinon B1 ; un premier locuteur seul prend A, le suivant B4', () => {
    const a = emptySpeakers();
    assignSpeakers(a, [3, 3], [VEC.W, VEC.X], [214, 110], { threshold: 0.6 });
    assignRoles(a, ['A', 'B4', 'B1', 'F'], 165);
    expect(a.speakers.map((s) => s.role)).toEqual(['F', 'A']);
    const b = emptySpeakers();
    assignSpeakers(b, [3], [VEC.W], [214], { threshold: 0.6 });
    assignRoles(b, ['A', 'B4', 'B1'], 165);
    expect(b.speakers[0].role).toBe('B1');
    const c = emptySpeakers();
    assignSpeakers(c, [3], [VEC.X], [110], { threshold: 0.6 });
    assignRoles(c, ['A', 'B4', 'B1'], 165);
    assignSpeakers(c, [3], [VEC.Y], [125], { threshold: 0.6 });
    assignRoles(c, ['A', 'B4', 'B1'], 165);
    expect(c.speakers.map((s) => s.role)).toEqual(['A', 'B4']);
  });

  it('voix absente du moteur : repli', () => {
    expect(voiceFor('F', ['A', 'B4', 'B1'])).toBe('B1');
    expect(voiceFor('B1', ['A', 'B4'])).toBe('B4');
    expect(voiceFor('A', ['A', 'B4', 'B1', 'F'])).toBe('A');
  });
});

// ------------------------------------------------------------------ travail

describe('runDub', () => {
  it('double les tronçons traduits : locuteurs → voix, emphase, répliques non traduites sautées, publication', async () => {
    publish(M, 0, CHUNK0);
    publish(M, 1, CHUNK1);
    const { deps, calls } = fake({ voices: ['A', 'B4', 'B1', 'F'] });
    const res = await runDub({ matchId: M }, () => {}, signal(), deps);
    expect(res).toMatchObject({ ok: true });
    // Non traduite (« Timeout on the floor. ») : pas dite.
    expect(calls.synth.map((s) => s.text)).not.toContain('EN Timeout on the floor.');
    expect(calls.synth).toEqual([
      { text: 'Tatum remonte le ballon.', voice: 'A' },
      { text: 'Il accélère et marque.', voice: 'A' },
      { text: 'Belle défense des Lakers.', voice: 'B4' },
      { text: 'Quel tir !', voice: 'A' },
      { text: 'Le banc se lève.', voice: 'A' },
      { text: 'Ils mènent de quatre points.', voice: 'B4' },
      { text: 'Retour au jeu.', voice: 'B4' },
      { text: 'Panier à trois points !', voice: 'A' },
      { text: 'Je suis au bord du terrain.', voice: 'F' },
      { text: 'Le coach semble inquiet.', voice: 'F' },
    ]);
    expect(calls.opened).toBe(1);
    expect(calls.closed).toBe(1);
    expect(calls.extract).toEqual([0, 119.5]);
    const chunks = db.getDubChunks(M);
    expect(chunks.map((c) => [c.idx, c.start_ts, c.end_ts, c.file])).toEqual([
      [0, 0, 120, 'chunk-0.m4a'],
      [1, 120, 240, 'chunk-1.m4a'],
    ]);
    expect(JSON.parse(chunks[0].speech)).toEqual([[2, 3], [6, 7], [10, 11], [14, 15], [30, 31], [40, 41]]);
    // Montage : positions relatives au début du tronçon, durée = zone du tronçon.
    expect(calls.assemble[1].clips.map((c) => c.at)).toEqual([5, 10, 15, 20]);
    expect(calls.assemble[1].duration).toBe(120);
    expect(fs.readFileSync(path.join(dubDir(M), 'chunk-0.m4a'), 'utf8')).toBe('m4a:6:120.00');
    expect(fs.existsSync(path.join(dubDir(M), 'tmp'))).toBe(false);
    expect(fs.readdirSync(dubDir(M)).sort()).toEqual(['chunk-0.m4a', 'chunk-1.m4a']);
    // Piste traduite partielle : doublage partiel.
    expect(db.getDubTrack(M)).toMatchObject({ complete: 0, voices: JSON.stringify(['A', 'B4', 'F']) });
  });

  it('voix stables d’un travail à l’autre ; dernier tronçon → doublage complet', async () => {
    publish(M, 0, CHUNK0);
    expect((await runDub({ matchId: M }, () => {}, signal(), fake().deps)).ok).toBe(true);
    publish(M, 2, CHUNK2);
    publish(M, 1, CHUNK1); // 3/3 tronçons publiés : piste traduite complète
    expect(db.getCommentaryTrack(M)?.complete).toBe(1);
    const second = fake();
    expect((await runDub({ matchId: M }, () => {}, signal(), second.deps, { yieldReason: () => null, target: () => 250 })).ok).toBe(true);
    // Position du spectateur d'abord (tronçon 2), puis le tronçon 1 ; le 0 n'est pas refait.
    expect(second.calls.extract).toEqual([239.5, 119.5]);
    expect(second.calls.synth.map((s) => s.voice)).toEqual(['A', 'B4', 'B4', 'A', 'B1', 'B1']); // W sans voix F → B1
    const last = db.getDubChunks(M).find((c) => c.idx === 2)!;
    expect(last.end_ts).toBeCloseTo(258.6); // dernier tronçon : fin de la dernière réplique + 0,6 s
    expect(db.getDubTrack(M)?.complete).toBe(1);
    expect(dubManifest(M).status).toBe('ready');
  });

  it('réplique trop longue : accélérée ×1,35 au plus, la suivante repoussée, dépassement compté', async () => {
    publish(M, 0, [
      [10, 13, 'Une très longue phrase qui ne tient pas.', 'X'],
      [13.8, 16, 'Suite.', 'X'],
    ]);
    const { deps, calls } = fake({ duration: (t) => (t.startsWith('Une') ? 6 : 1) });
    const res = await runDub({ matchId: M }, () => {}, signal(), deps);
    expect(res.reason).toContain('1 dépassement');
    const clips = calls.assemble[0].clips;
    expect(clips[0]).toMatchObject({ at: 10, tempo: 1.35 }); // place 3,6 s pour 6 s de voix
    expect(clips[1].at).toBeCloseTo(10 + 6 / 1.35 + 0.05, 3);
    expect(clips[1].tempo).toBe(1);
  });

  it('une réplique en échec est sautée, pas le tronçon ; tout le tronçon en échec → erreur', async () => {
    publish(M, 0, CHUNK0);
    const one = fake({ failSynth: (t) => t === 'Le banc se lève.' });
    expect((await runDub({ matchId: M }, () => {}, signal(), one.deps)).ok).toBe(true);
    expect(db.getDubChunks(M)).toHaveLength(1);
    expect(one.calls.assemble[0].clips).toHaveLength(5);

    publish(M, 1, CHUNK1);
    const all = fake({ failSynth: () => true });
    await expect(runDub({ matchId: M }, () => {}, signal(), all.deps)).rejects.toThrow(/synthèse impossible/);
    expect(all.calls.closed).toBe(1);
    expect(db.getDubChunks(M)).toHaveLength(1);
  });

  it('moteur de voix qui ne démarre pas : panne de service (nouvel essai rapide)', async () => {
    publish(M, 0, CHUNK0);
    const res = await runDub({ matchId: M }, () => {}, signal(), fake({ failOpen: true }).deps);
    expect(res).toMatchObject({ ok: false, kind: 'service', reason: expect.stringContaining('CUDA indisponible') });
  });

  it('flux vidéo inaccessible : échec réseau', async () => {
    publish(M, 0, CHUNK0);
    const { deps } = fake();
    deps.extract = async () => {
      throw new Error('HTTP 403');
    };
    expect(await runDub({ matchId: M }, () => {}, signal(), deps)).toMatchObject({ ok: false, kind: 'reseau' });
  });

  it('piste traduite changée (autre modèle) : doublage effacé et refait ; tronçon retraduit : redoublé', async () => {
    publish(M, 0, CHUNK0);
    await runDub({ matchId: M }, () => {}, signal(), fake().deps);
    const before = db.getDubChunks(M)[0].cues_sig;
    // Retraduction du tronçon 0 (même piste) : sous-titres différents.
    publish(M, 0, CHUNK0.map((l, i) => (i === 0 ? ([l[0], l[1], 'Tatum avance.', l[3]] as Line) : l)));
    const again = fake();
    await runDub({ matchId: M }, () => {}, signal(), again.deps);
    expect(again.calls.synth[0].text).toBe('Tatum avance.');
    expect(db.getDubChunks(M)[0].cues_sig).not.toBe(before);
    // Nouveau modèle de traduction : nouvelle piste, l'ancien doublage disparaît.
    fs.writeFileSync(path.join(dubDir(M), 'chunk-7.m4a'), 'vieux');
    const track2 = { ...TRACK, translate_model: 'gemma4:e4b' };
    db.openCommentaryTrack(M, track2);
    publish(M, 1, CHUNK1, track2);
    expect(dubManifest(M).chunks).toEqual([]); // l'ancien doublage n'est plus servi
    const third = fake();
    await runDub({ matchId: M }, () => {}, signal(), third.deps);
    expect(db.getDubChunks(M).map((c) => c.idx)).toEqual([1]);
    expect(fs.existsSync(path.join(dubDir(M), 'chunk-7.m4a'))).toBe(false);
    expect(db.getDubTrack(M)?.commentary_key).toBe(db.commentaryKey({ ...track2, chunk_sec: 120 }));
  });

  it('cède la place entre deux répliques : moteur fermé, tronçon pas publié', async () => {
    publish(M, 0, CHUNK0);
    let n = 0;
    const ctl: DubControl = { yieldReason: () => (++n > 3 ? 'gpu' : null), target: () => 0 };
    const { deps, calls } = fake();
    const res = await runDub({ matchId: M }, () => {}, signal(), deps, ctl);
    expect(res).toMatchObject({ ok: false, yielded: 'gpu' });
    expect(calls.closed).toBe(1);
    expect(calls.synth.length).toBeLessThan(5);
    expect(db.getDubChunks(M)).toEqual([]);
    expect(fs.existsSync(path.join(dubDir(M), 'tmp'))).toBe(false);
  });
});

// ------------------------------------------------------------------ file

describe('file : GPU partagé et priorité à la lecture', () => {
  it('une traduction démarre pendant le doublage : il ferme le moteur, se remet en file, reprend après', async () => {
    process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
    process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
    process.env.DUB_REPUMP_MS = '10';
    publish(M, 0, CHUNK0);
    publish(M, 1, CHUNK1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __setCommentaryRunnerForTests(async () => {
      await gate;
      return { ok: true, reason: 'ok' };
    });
    let started = false;
    const { deps, calls } = fake({
      onSynth: (n) => {
        // Pendant la 2e réplique, quelqu'un lance la traduction d'un autre match.
        if (n === 2 && !started) {
          started = true;
          enqueueCommentary(M2, { priority: true });
        }
      },
    });
    viaQueue(deps);
    expect(enqueueDub(M).started).toBe(true);
    await vi.waitFor(() => expect(dubManifest(M)).toMatchObject({ status: 'waiting', reason: expect.stringContaining('GPU') }));
    expect(calls.closed).toBe(1);
    expect(calls.synth).toHaveLength(2);
    expect(db.getDubChunks(M)).toEqual([]);
    expect(dubActivity().waitingForGpu).toBe(true);
    expect(getDubRecord(M)).toBeUndefined(); // ni échec ni succès
    release();
    await vi.waitFor(() => expect(db.getDubChunks(M)).toHaveLength(2));
    await __dubIdle();
    expect(calls.opened).toBe(2);
    expect(getDubRecord(M)?.ok).toBe(true);
  });

  it('doublage de fond : s’efface quand un AUTRE match est regardé, reprend après', async () => {
    process.env.DUB_REPUMP_MS = '10';
    process.env.COMMENTARY_VIEWER_IDLE_MS = '60000';
    publish(M, 0, CHUNK0);
    publish(M, 1, CHUNK1);
    const { deps, calls } = fake({ onSynth: (n) => n === 2 && touchViewer(M2, 10) });
    viaQueue(deps);
    enqueueDub(M);
    await vi.waitFor(() => expect(dubManifest(M).status).toBe('waiting'));
    expect(calls.closed).toBe(1);
    expect(db.getDubChunks(M)).toEqual([]);
    vi.setSystemTime(Date.now() + 10 * 60_000); // la lecture s'arrête
    await __dubIdle();
    vi.useRealTimers();
    expect(db.getDubChunks(M)).toHaveLength(2);
  });

  it('match regardé : passe devant un doublage de fond (interrompu, repris ensuite), à partir de la position', async () => {
    process.env.DUB_REPUMP_MS = '10';
    process.env.COMMENTARY_VIEWER_IDLE_MS = '60000';
    const t2 = { ...TRACK, ok_id: db.getMatch(M2)!.video_ok_id! };
    publish(M, 0, CHUNK0);
    publish(M2, 0, CHUNK0, t2);
    publish(M2, 1, CHUNK1, t2);
    const order: string[] = [];
    let opened = false;
    const { deps } = fake({
      onSynth: (_n, text) => {
        order.push(text);
        if (!opened) {
          opened = true;
          touchViewer(M2, 130);
          prioritizeDubOnView(M2);
        }
      },
    });
    viaQueue(deps);
    enqueueDub(M);
    await vi.waitFor(() => expect(db.getDubChunks(M2)).toHaveLength(2));
    // M2 depuis la position du spectateur (tronçon 1), puis le tronçon 0.
    expect(order[1]).toBe('Retour au jeu.');
    expect(db.getDubChunks(M)).toEqual([]);
    expect(dubManifest(M).status).toBe('waiting'); // attend la fin de la lecture
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await __dubIdle();
    vi.useRealTimers();
    expect(db.getDubChunks(M)).toHaveLength(1);
  });

  it('fond hors fenêtre ou pré-traduction désactivée : rien n’est mis en file ni doublé', async () => {
    publish(M, 0, CHUNK0);
    viaQueue(fake().deps);
    settingSet('auto_translate', '0');
    expect(await enqueueRecentDubs()).toBe(0);
    settingSet('auto_translate', null);
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    expect(await enqueueRecentDubs()).toBe(0);
    enqueueDub(M); // mise en file de fond directe : abandonnée hors fenêtre
    await __dubIdle();
    expect(db.getDubChunks(M)).toEqual([]);
  });

  it('job périodique : matchs traduits au doublage incomplet, une fois', async () => {
    publish(M, 0, CHUNK0);
    const { deps } = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __setDubRunnerForTests(async () => {
      await gate;
      return { ok: true, reason: 'simulé' };
    });
    expect(await enqueueRecentDubs()).toBe(1); // M2 n'a pas de sous-titres
    expect(await enqueueRecentDubs()).toBe(0); // déjà en cours
    release();
    await __dubIdle();
    viaQueue(deps);
    expect(await enqueueRecentDubs()).toBe(1);
    await __dubIdle();
    expect(db.finalMatchesNeedingDub(new Date(Date.now() - 10 * 86400_000).toISOString())).toEqual([]);
    expect(await enqueueRecentDubs()).toBe(0);
  });

  it('activité : tâche « doublage » pendant le travail', async () => {
    publish(M, 0, CHUNK0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __setDubRunnerForTests(async (_job, progress) => {
      progress({ done: 1, total: 3, chunk: 1 });
      await gate;
      return { ok: true, reason: 'ok' };
    });
    enqueueDub(M);
    expect(currentActivity().tasks).toEqual([
      expect.objectContaining({ kind: 'doublage', match: expect.objectContaining({ id: M }), label: 'Doublage en français', pct: 33 }),
    ]);
    release();
    await __dubIdle();
  });
});

// ------------------------------------------------------------------ API

describe('API', () => {
  it('manifeste : forme exacte, ?t= donne la priorité au match regardé ; audio servi avec Range', async () => {
    const empty = await (await getDub(new Request(`http://nas.local/api/matches/${M}/dub`), params(M))).json();
    expect(empty).toEqual({ status: 'none', reason: 'pas encore de sous-titres français', chunks: [], voices: {} });

    publish(M, 0, CHUNK0);
    publish(M, 1, CHUNK1);
    viaQueue(fake().deps);
    // Sans t : aucun effet de bord.
    expect((await (await getDub(new Request(`http://nas.local/api/matches/${M}/dub`), params(M))).json()).status).toBe('none');
    const r = await getDub(new Request(`http://nas.local/api/matches/${M}/dub?t=10`), params(M));
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await r.json()).status).toBe('running');
    await __dubIdle();
    const m = await (await getDub(new Request(`http://nas.local/api/matches/${M}/dub?t=10`), params(M))).json();
    expect(m.status).toBe('partial');
    expect(m.voices).toEqual({ A: 'Commentateur', B4: 'Consultant', B1: 'Troisième voix' });
    expect(m.chunks).toHaveLength(2);
    expect(m.chunks[0]).toEqual({
      idx: 0,
      start: 0,
      end: 120,
      url: expect.stringMatching(new RegExp(`^/api/matches/${M}/dub/0\\?v=\\d+$`)),
      speech: [[2, 3], [6, 7], [10, 11], [14, 15], [30, 31], [40, 41]],
    });
    expect(Object.keys(m).sort()).toEqual(['chunks', 'status', 'voices']);

    // Audio : en entier, puis une plage.
    const full = await getDubAudio(new Request(`http://nas.local${m.chunks[0].url}`), params(M, 0));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/mp4');
    expect(full.headers.get('cache-control')).toBe('private, max-age=86400');
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(bytes.toString()).toBe('m4a:6:120.00');
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    const part = await getDubAudio(new Request('http://nas.local/x', { headers: { range: 'bytes=4-6' } }), params(M, 0));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-6/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('6:1');
    expect((await getDubAudio(new Request('http://nas.local/x', { headers: { range: 'bytes=999-' } }), params(M, 0))).status).toBe(416);
    expect((await getDubAudio(new Request('http://nas.local/x'), params(M, 5))).status).toBe(404);
    expect((await getDubAudio(new Request('http://nas.local/x'), { params: Promise.resolve({ id: String(M), idx: 'abc' }) })).status).toBe(400);
  });

  it('manifeste : doublage désactivé ; match inconnu', async () => {
    process.env.DUB_DISABLED = '1';
    publish(M, 0, CHUNK0);
    const d = await (await getDub(new Request(`http://nas.local/api/matches/${M}/dub?t=0`), params(M))).json();
    expect(d).toEqual({ status: 'disabled', reason: expect.stringContaining('DUB_DISABLED'), chunks: [], voices: {} });
    expect(dubActivity().running).toBeNull();
    expect((await getDub(new Request('http://nas.local/api/matches/999/dub'), params(999))).status).toBe(404);
  });

  it('manifeste : échec sans tronçon → failed ; avec tronçons → partial et la raison', async () => {
    publish(M, 0, CHUNK0);
    viaQueue(fake({ failOpen: true }).deps);
    enqueueDub(M);
    await __dubIdle();
    expect(dubManifest(M)).toMatchObject({ status: 'failed', reason: expect.stringContaining('Moteur de voix indisponible') });
    expect(getDubRecord(M)).toMatchObject({ kind: 'service', failures: 0, netFailures: 1 });
  });
});

// ------------------------------------------------------------------ montage réel (ffmpeg)

// Même binaire que le code (FFMPEG_PATH) : sans ffmpeg (CI), le montage réel est sauté.
const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe('montage ffmpeg', () => {
  it.skipIf(!hasFfmpeg)('silence + répliques à leur place, accélérées ; AAC mono 24 kHz en MP4', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-dub-ff-'));
    try {
      const a = path.join(dir, 'a.wav');
      const b = path.join(dir, 'b.wav');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5:sample_rate=22050', '-ac', '1', a]);
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.4:sample_rate=24000', '-ac', '1', b]);
      const out = path.join(dir, 'chunk.m4a.part');
      await assembleChunk(
        [
          { file: a, at: 1, tempo: 1 },
          { file: b, at: 2.5, tempo: 1.25 },
        ],
        4,
        out,
      );
      const probe = JSON.parse(
        spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration,format_name', '-of', 'json', out]).stdout.toString(),
      );
      expect(probe.streams[0]).toMatchObject({ codec_name: 'aac', sample_rate: '24000', channels: 1 });
      expect(probe.format.format_name).toContain('mp4');
      expect(Number(probe.format.duration)).toBeCloseTo(4, 1);
      // Énergie par fenêtre : silence, réplique 1 (1-1,5 s), silence, réplique 2 (2,5-2,82 s), silence.
      const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 's16le', '-ac', '1', '-ar', '24000', '-']).stdout as Buffer;
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const rms = (from: number, to: number) => {
        let s = 0;
        const a0 = Math.floor(from * 24000);
        const a1 = Math.floor(to * 24000);
        for (let i = a0; i < a1; i++) s += samples[i] * samples[i];
        return Math.sqrt(s / (a1 - a0));
      };
      expect(rms(0.1, 0.9)).toBeLessThan(50);
      expect(rms(1.1, 1.4)).toBeGreaterThan(1000);
      expect(rms(1.7, 2.4)).toBeLessThan(50);
      expect(rms(2.55, 2.75)).toBeGreaterThan(1000);
      expect(rms(2.95, 3.9)).toBeLessThan(50);
      // Sans réplique : silence seul.
      const silent = path.join(dir, 'silence.m4a');
      await assembleChunk([], 2, silent);
      expect(fs.statSync(silent).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
