import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { ServiceError } from '../src/lib/commentaryAi';
import {
  __commentaryIdle,
  __setCommentaryRunnerForTests,
  chunkCues,
  commentaryReady,
  commentaryStatus,
  coveredFrom,
  enqueueCommentary,
  getCommentaryRecord,
  inNightWindow,
  nextChunk,
  planChunks,
  runCommentary,
  touchViewer,
  workDir,
  type CommentaryControl,
  type CommentaryDeps,
  type CommentaryProgress,
} from '../src/lib/commentary';
import type { AsrWord, Transcript } from '../src/lib/commentaryCues';
import { GET as getSubtitles } from '../src/app/api/matches/[id]/subtitles/route';
import { freshDb, insertMatch } from './helpers/db';

/**
 * Traduction à la demande : tronçons traduits à partir de la position du
 * spectateur, publiés un par un, pause quand plus personne ne regarde (ou
 * hors de la fenêtre de nuit pour un travail de fond).
 */

const A = 402000001;
const DURATION = 1300;
const CHUNK = 600; // 3 tronçons : [0, 600[, [600, 1200[, [1200, fin]
const PLANS = planChunks(DURATION, CHUNK);

const SCRIPT: [number, string][] = [
  [10, 'Tatum brings it up the floor.'],
  [120, 'He drives and scores at the rim.'],
  [300, 'Timeout on the floor, the Celtics lead by four.'],
  [650, 'What a shot by Jaylen Brown.'],
  [1100, 'Lakers ball, under two minutes to go.'],
  [1250, 'That will do it, final buzzer.'],
];

/** Transcription simulée d'un tronçon : les mots audibles dans sa fenêtre d'extraction, en temps local. */
function fakeTranscript(index: number): Transcript {
  const plan = PLANS[index];
  const from = plan.start;
  const to = plan.start + plan.length;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const words: AsrWord[] = [];
  const segments: Transcript['segments'] = [];
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

/** Index du tronçon d'après le nom du fichier audio (chunk-<début>-<durée>.ogg). */
const chunkIndex = (file: string) => PLANS.findIndex((p) => p.start === Number(/chunk-(\d+)-/.exec(file)![1]));

const expected = (idx: number) => chunkCues(PLANS[idx], fakeTranscript(idx));
const published = () => db.getCommentaryCues(A).map((c) => ({ seq: c.seq, start: c.start_ts, end: c.end_ts, text: c.text_en, fr: c.text_fr }));

function fakeDeps(o: { failTranscribeAt?: number; failExtractAt?: number; afterChunk?: (idx: number) => void } = {}) {
  const calls = { extract: [] as number[], transcribe: [] as number[], translated: [] as number[], events: [] as string[] };
  const deps: CommentaryDeps = {
    resolveStream: async () => ({ variants: [{ key: 'low', bandwidth: 600_000, resolution: '640x360', url: 'https://vd.okcdn.ru/low.m3u8' }], duration: DURATION }),
    extract: async (_url, start, _len, out) => {
      const idx = PLANS.findIndex((p) => p.start === start);
      calls.extract.push(idx);
      if (idx === o.failExtractAt) throw new Error('ffmpeg audio code 1: HTTP error 403 Forbidden');
      fs.writeFileSync(out, Buffer.alloc(4096));
    },
    transcribe: async (file) => {
      const idx = chunkIndex(file);
      calls.transcribe.push(idx);
      calls.events.push(`transcription ${idx}`);
      if (idx === o.failTranscribeAt) throw new ServiceError('Whisper s’est arrêté', 'transcription');
      return fakeTranscript(idx);
    },
    translate: async (lines) => {
      calls.events.push(`traduction ${lines.length}`);
      calls.translated.push(...lines.map((l) => l.i));
      const res = lines.map((l) => ({ i: l.i, fr: `FR ${l.en}`, untranslated: false }));
      const idx = Math.floor(lines[0].i / 100_000) - 1;
      queueMicrotask(() => o.afterChunk?.(idx));
      return res;
    },
    openTranscriber: async (cfg) => {
      calls.events.push('whisper ouvert');
      return {
        transcribe: (file, prompt, signal) => deps.transcribe(file, cfg, { prompt, signal }),
        close: async () => void calls.events.push('whisper fermé'),
      };
    },
    openTranslator: async () => {
      calls.events.push('ollama ouvert');
      return { close: async () => void calls.events.push('ollama fermé') };
    },
  };
  return { deps, calls };
}

let dataDir: string;
const signal = () => new AbortController().signal;
const ctl = (target: () => number, keepGoing: () => boolean = () => true): CommentaryControl => ({ target, keepGoing });

beforeEach(() => {
  freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-ondemand-'));
  process.env.DATA_DIR = dataDir;
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
  process.env.COMMENTARY_CHUNK_SEC = String(CHUNK);
  insertMatch(A, { duration: DURATION });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  __setCommentaryRunnerForTests(null);
  for (const k of ['DATA_DIR', 'TRANSCRIBE_URL', 'TRANSLATE_URL', 'COMMENTARY_CHUNK_SEC', 'COMMENTARY_VIEWER_IDLE_MS']) delete process.env[k];
  process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ fonctions pures

describe('ordre des tronçons', () => {
  it('à partir de la position visée, puis ce qui précède', () => {
    expect(nextChunk(PLANS, new Set(), 0)?.index).toBe(0);
    expect(nextChunk(PLANS, new Set(), 700)?.index).toBe(1);
    expect(nextChunk(PLANS, new Set([1]), 700)?.index).toBe(2);
    expect(nextChunk(PLANS, new Set([1, 2]), 700)?.index).toBe(0);
    expect(nextChunk(PLANS, new Set([0, 1, 2]), 700)).toBeUndefined();
    expect(nextChunk(PLANS, new Set(), 99_999)?.index).toBe(2); // au-delà de la fin : dernier tronçon
  });

  it('couverture d’un seul tenant à partir d’une position', () => {
    expect(coveredFrom(PLANS, new Set([1, 2]), 700, DURATION)).toBe(DURATION);
    expect(coveredFrom(PLANS, new Set([1]), 700, DURATION)).toBe(1200);
    expect(coveredFrom(PLANS, new Set([1]), 100, DURATION)).toBe(0);
  });

  it('sous-titres d’un tronçon numérotés dans sa plage de seq', () => {
    expect(expected(1).map((c) => c.seq)).toEqual([db.chunkSeqBase(1) + 1, db.chunkSeqBase(1) + 2]);
    expect(expected(0)[0]).toMatchObject({ seq: 100_001, text: 'Tatum brings it up the floor.' });
  });
});

describe('fenêtre de nuit (heures de Paris)', () => {
  it('2-6 par défaut ; off ; always', () => {
    delete process.env.COMMENTARY_NIGHT_WINDOW;
    // 30 octobre 2026 : heure d'hiver, Paris = UTC+1.
    expect(inNightWindow(new Date('2026-10-30T00:59:00Z'))).toBe(false); // 01:59
    expect(inNightWindow(new Date('2026-10-30T01:00:00Z'))).toBe(true); // 02:00
    expect(inNightWindow(new Date('2026-10-30T04:59:00Z'))).toBe(true); // 05:59
    expect(inNightWindow(new Date('2026-10-30T05:00:00Z'))).toBe(false); // 06:00
    process.env.COMMENTARY_NIGHT_WINDOW = '23-3';
    expect(inNightWindow(new Date('2026-10-30T23:30:00Z'))).toBe(true); // 00:30
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    expect(inNightWindow(new Date('2026-10-30T02:00:00Z'))).toBe(false);
    process.env.COMMENTARY_NIGHT_WINDOW = 'always';
    expect(inNightWindow(new Date('2026-10-30T12:00:00Z'))).toBe(true);
  });
});

// ------------------------------------------------------------------ travail complet

describe('runCommentary à la demande', () => {
  it('jusqu’au bout depuis le début : tronçon par tronçon, piste complète, modèles déchargés', async () => {
    const { deps, calls } = fakeDeps();
    const events: CommentaryProgress[] = [];
    const res = await runCommentary({ matchId: A, force: false }, (p) => events.push({ ...p }), signal(), deps);
    expect(res).toMatchObject({ ok: true });
    expect(published()).toEqual([0, 1, 2].flatMap((i) => expected(i).map((c) => ({ seq: c.seq, start: c.start, end: c.end, text: c.text, fr: `FR ${c.text}` }))));
    expect(db.getCommentaryTrack(A)).toMatchObject({ complete: 1, cues: 6, untranslated: 0, chunk_sec: CHUNK, chunks_total: 3 });
    expect(commentaryReady(A)).toBe(true);
    expect(calls.events).toEqual([
      'whisper ouvert',
      'transcription 0',
      'ollama ouvert',
      'traduction 3',
      'transcription 1',
      'traduction 2',
      'transcription 2',
      'traduction 1',
      'whisper fermé',
      'ollama fermé',
    ]);
    expect(events.filter((p) => p.phase === 'traduction').map((p) => `${p.done}/${p.total}`)).toEqual(['0/3', '1/3', '1/3', '2/3', '2/3', '3/3']);
    expect([...new Set(events.map((p) => p.availableUntil))]).toEqual([undefined, 600, 1200, DURATION]);
    expect(fs.existsSync(workDir(db.getMatch(A)!.video_ok_id!))).toBe(false);
  });

  it('commence à la position du spectateur, suit un saut, puis complète ce qui précède', async () => {
    let target = 700;
    const { deps, calls } = fakeDeps({ afterChunk: (idx) => idx === 1 && (target = 1250) });
    const res = await runCommentary({ matchId: A, force: false }, () => {}, signal(), deps, ctl(() => target));
    expect(res.ok).toBe(true);
    expect(calls.transcribe).toEqual([1, 2, 0]);
    expect(db.getCommentaryTrack(A)?.complete).toBe(1);
  });

  it('pause quand plus personne ne regarde : modèles déchargés, rien n’est perdu, reprise sans refaire', async () => {
    let watching = true;
    const first = fakeDeps({ afterChunk: () => (watching = false) });
    const res = await runCommentary({ matchId: A, force: false }, () => {}, signal(), first.deps, ctl(() => 700, () => watching));
    expect(res).toMatchObject({ ok: false, paused: true, reason: expect.stringContaining('1/3') });
    expect(first.calls.transcribe).toEqual([1]);
    expect(first.calls.events.slice(-2)).toEqual(['whisper fermé', 'ollama fermé']);
    expect(db.getCommentaryTrack(A)).toMatchObject({ complete: 0, cues: 2 });
    expect(commentaryReady(A)).toBe(false);

    const second = fakeDeps();
    expect((await runCommentary({ matchId: A, force: false }, () => {}, signal(), second.deps, ctl(() => 0))).ok).toBe(true);
    expect(second.calls.transcribe).toEqual([0, 2]);
    expect(second.calls.translated).not.toContain(db.chunkSeqBase(1) + 1);
    expect(db.getCommentaryTrack(A)?.complete).toBe(1);
  });

  it('reprise après panne : tronçons publiés gardés, transcription en cache réutilisée', async () => {
    const first = fakeDeps({ failTranscribeAt: 2 });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, signal(), first.deps)).rejects.toBeInstanceOf(ServiceError);
    expect(published()).toHaveLength(5);
    const second = fakeDeps();
    expect((await runCommentary({ matchId: A, force: false }, () => {}, signal(), second.deps)).ok).toBe(true);
    expect(second.calls.extract).toEqual([]); // audio du tronçon 3 déjà extrait
    expect(second.calls.transcribe).toEqual([2]);
    expect(second.calls.translated).toEqual([db.chunkSeqBase(2) + 1]);
  });

  it('relance explicite d’une piste complète : on repart de zéro', async () => {
    expect((await runCommentary({ matchId: A, force: false }, () => {}, signal(), fakeDeps().deps)).ok).toBe(true);
    const again = fakeDeps();
    expect((await runCommentary({ matchId: A, force: true }, () => {}, signal(), again.deps)).ok).toBe(true);
    expect(again.calls.transcribe).toEqual([0, 1, 2]);
  });
});

// ------------------------------------------------------------------ par la file

describe('file : spectateur et nuit', () => {
  const viaQueue = (deps: CommentaryDeps) => __setCommentaryRunnerForTests((job, p, sig, c) => runCommentary(job, p, sig, deps, c));

  it('match regardé : traduit depuis la position envoyée par la fiche ; pause sans échec quand la fiche se ferme', async () => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    process.env.COMMENTARY_VIEWER_IDLE_MS = '60000';
    const { deps, calls } = fakeDeps({
      afterChunk: () => {
        // La fiche se ferme : dernier signe de vie très ancien.
        vi.setSystemTime(Date.now() + 10 * 60_000);
      },
    });
    viaQueue(deps);
    const res = await getSubtitles(new Request(`http://nas.local/api/matches/${A}/subtitles?t=700`), { params: Promise.resolve({ id: String(A) }) });
    expect((await res.json()).commentary.status).toBe('running');
    await __commentaryIdle();
    vi.useRealTimers();
    expect(calls.transcribe).toEqual([1]);
    expect(getCommentaryRecord(A)).toBeUndefined(); // ni échec ni succès
    const st = commentaryStatus(A);
    expect(st.status).toBe('none');
    expect(st.covered).toEqual([[600, 1200]]);
  });

  it('travail de fond hors de la fenêtre de nuit : pause immédiate, rien n’est fait', async () => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    const { deps, calls } = fakeDeps();
    viaQueue(deps);
    enqueueCommentary(A); // mise en file de fond (pas de spectateur)
    await __commentaryIdle();
    expect(calls.transcribe).toEqual([]);
    expect(getCommentaryRecord(A)).toBeUndefined();
  });

  it('travail de fond dans la fenêtre : tout le match ; un spectateur prend le relais même hors fenêtre', async () => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'always';
    const { deps, calls } = fakeDeps();
    viaQueue(deps);
    touchViewer(A, 0);
    enqueueCommentary(A);
    await __commentaryIdle();
    expect(calls.transcribe).toEqual([0, 1, 2]);
    expect(commentaryStatus(A).status).toBe('ready');
  });
});
