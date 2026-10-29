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
  commentaryReady,
  commentaryStatus,
  cuesFromChunks,
  enqueueCommentary,
  nextStableCues,
  planChunks,
  runCommentary,
  servedCommentaryCues,
  stableCutoff,
  wordsFromChunks,
  workDir,
  type CommentaryDeps,
  type CommentaryProgress,
} from '../src/lib/commentary';
import type { AsrWord, Cue, Transcript } from '../src/lib/commentaryCues';
import { GET as getSubtitles } from '../src/app/api/matches/[id]/subtitles/route';
import { freshDb, insertMatch } from './helpers/db';

/**
 * Sous-titres progressifs : le match est traité tronçon par tronçon, et les
 * sous-titres STABLES sont publiés après chaque tronçon, sans jamais être
 * renumérotés.
 */

const A = 402000001;
const DURATION = 1300; // 3 tronçons : [0, 600[, [600, 1200[, [1200, fin]
const PLANS = planChunks(DURATION, 600);

/**
 * Ce que disent les commentateurs (temps réels dans la vidéo). Deux phrases
 * tombent volontairement à la frontière des tronçons : « Brown pulls up… »
 * finit dans la marge de stabilité du tronçon 1, « And he hits it! » est
 * coupée en deux entre les tronçons 1 et 2.
 */
const SCRIPT: [number, string][] = [
  [10, 'Tatum brings it up the floor.'],
  [120, 'He drives and scores at the rim.'],
  [300, 'Timeout on the floor, the Celtics lead by four.'],
  [596.2, 'Brown pulls up from deep.'],
  [599.4, 'And he hits it!'],
  [650, 'What a shot by Jaylen Brown.'],
  [1100, 'Lakers ball, under two minutes to go.'],
  [1199, 'Rebound Davis.'],
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
    segments.push({
      start: ws[0].start,
      end: ws[ws.length - 1].end,
      text: ws.map((w) => w.word).join(''),
      avg_logprob: -0.2,
      no_speech_prob: 0.02,
      compression_ratio: 1.1,
    });
  }
  return { segments, words };
}

const chunkIndex = (file: string) => Number(/chunk-(\d+)/.exec(file)![1]);

/** Découpage COMPLET du match, d'un coup (référence). */
const fullBuild = () => cuesFromChunks(PLANS.map((plan, i) => ({ plan, transcript: fakeTranscript(i) })));

const published = () => db.getCommentaryCues(A).map((c) => [c.seq, c.start_ts, c.end_ts, c.text_en, c.text_fr] as const);

interface FakeOptions {
  failTranscribeAt?: number;
  failExtractAt?: number;
  failTranslateAt?: number;
  sessions?: boolean;
}

function fakeDeps(o: FakeOptions = {}) {
  const calls = {
    extract: [] as number[],
    transcribe: [] as number[],
    translated: [] as number[],
    events: [] as string[],
    /** Sous-titres en base au début de la transcription de chaque tronçon. */
    snapshots: new Map<number, ReturnType<typeof published>>(),
    complete: new Map<number, number | undefined>(),
  };
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
      calls.snapshots.set(idx, published());
      calls.complete.set(idx, db.getCommentaryTrack(A)?.complete);
      if (idx === o.failTranscribeAt) throw new ServiceError('Whisper s’est arrêté', 'transcription');
      return fakeTranscript(idx);
    },
    translate: async (lines) => {
      calls.events.push(`traduction ${lines.map((l) => l.i).join(',')}`);
      if (o.failTranslateAt !== undefined && lines.some((l) => l.i >= o.failTranslateAt!)) throw new ServiceError('Ollama injoignable', 'traduction');
      calls.translated.push(...lines.map((l) => l.i));
      return lines.map((l) => ({ i: l.i, fr: `FR ${l.en}`, untranslated: false }));
    },
  };
  if (o.sessions) {
    deps.openTranscriber = async (cfg) => {
      calls.events.push('whisper ouvert');
      return {
        transcribe: (file, prompt, signal) => deps.transcribe(file, cfg, { prompt, signal }),
        close: async () => void calls.events.push('whisper fermé'),
      };
    };
    deps.openTranslator = async () => {
      calls.events.push('ollama ouvert');
      return { close: async () => void calls.events.push('ollama fermé') };
    };
  }
  return { deps, calls };
}

let dataDir: string;
const signal = () => new AbortController().signal;

beforeEach(() => {
  freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-progressive-'));
  process.env.DATA_DIR = dataDir;
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
  insertMatch(A, { duration: DURATION });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setCommentaryRunnerForTests(null);
  for (const k of ['DATA_DIR', 'TRANSCRIBE_URL', 'TRANSLATE_URL', 'COMMENTARY_GPU_SEQUENTIAL']) delete process.env[k];
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ stabilité (fonctions pures)

describe('nextStableCues : sous-titres figés tronçon par tronçon', () => {
  /** Rejoue le découpage progressif : rend les sous-titres figés après chaque tronçon. */
  function progressive(transcripts: Transcript[]): Cue[][] {
    const frozen: Cue[] = [];
    const steps: Cue[][] = [];
    for (let i = 0; i < PLANS.length; i++) {
      const words = wordsFromChunks(PLANS.slice(0, i + 1).map((plan, k) => ({ plan, transcript: transcripts[k] })));
      frozen.push(...nextStableCues(words, frozen, stableCutoff(PLANS[i])));
      steps.push(frozen.map((c) => ({ ...c })));
    }
    return steps;
  }

  it('même résultat qu’un découpage complet, seq comprises', () => {
    const steps = progressive(PLANS.map((_, i) => fakeTranscript(i)));
    expect(steps[steps.length - 1]).toEqual(fullBuild());
    expect(fullBuild().map((c) => c.text)).toContain('And he hits it!'); // phrase coupée entre deux tronçons, recollée
  });

  it('seuls les sous-titres finis avant keepTo − 2 s sont figés ; les seq publiées ne bougent plus', () => {
    const steps = progressive(PLANS.map((_, i) => fakeTranscript(i)));
    expect(steps.map((s) => s.length)).toEqual([3, 7, 9]);
    // « Brown pulls up from deep. » finit à 598,15 s : dans la marge du tronçon 1, figé au tronçon 2.
    expect(steps[0].every((c) => c.end <= 598)).toBe(true);
    expect(steps[1][3]).toMatchObject({ seq: 4, text: 'Brown pulls up from deep.' });
    for (let i = 1; i < steps.length; i++) expect(steps[i].slice(0, steps[i - 1].length)).toEqual(steps[i - 1]);
    steps[2].forEach((c, k) => expect(c.seq).toBe(k + 1));
  });

  it('un tronçon suivant qui perturbe la frontière ne renumérote pas ce qui est publié', () => {
    // Mot aberrant du tronçon 2 (milieu après 600 s, mais début à 290 s) : un
    // découpage complet l'insère AVANT des mots du tronçon 1 et renumérote.
    const t1 = fakeTranscript(1);
    t1.words.unshift({ word: ' Whoa', start: 290 - 597, end: 911 - 597 });
    const transcripts = [fakeTranscript(0), t1, fakeTranscript(2)];
    const steps = progressive(transcripts);
    const full = cuesFromChunks(PLANS.map((plan, i) => ({ plan, transcript: transcripts[i] })));
    expect(full.slice(0, 4).map((c) => c.text)).not.toEqual(steps[2].slice(0, 4).map((c) => c.text)); // le découpage complet a bougé…
    expect(steps[1].slice(0, 3)).toEqual(steps[0]); // …pas les sous-titres publiés
    expect(steps[2].slice(0, 3)).toEqual(steps[0]);
    // Jamais de chevauchement entre le dernier publié et le suivant.
    for (let k = 1; k < steps[2].length; k++) expect(steps[2][k].start).toBeGreaterThanOrEqual(steps[2][k - 1].end);
  });
});

// ------------------------------------------------------------------ pipeline complet (dépendances simulées)

describe('runCommentary progressif', () => {
  it('publie après chaque tronçon : préfixes stables, piste incomplète jusqu’à la fin', async () => {
    const { deps, calls } = fakeDeps();
    const events: CommentaryProgress[] = [];
    const res = await runCommentary({ matchId: A, force: false }, (p) => events.push({ ...p }), signal(), deps);
    expect(res.ok).toBe(true);

    const final = published();
    expect(final.map(([seq, start, end, en]) => ({ seq, start, end, text: en }))).toEqual(fullBuild());
    expect(final.every(([, , , en, fr]) => fr === `FR ${en}`)).toBe(true);
    // Au début du tronçon 2, ce qui a été traduit du tronçon 1 est déjà en base…
    expect(calls.snapshots.get(0)).toEqual([]);
    expect(calls.snapshots.get(1)).toEqual(final.slice(0, 3));
    expect(calls.snapshots.get(2)).toEqual(final.slice(0, 7));
    // …dans une piste marquée incomplète.
    expect(calls.complete.get(1)).toBe(0);
    expect(calls.complete.get(2)).toBe(0);
    expect(db.getCommentaryTrack(A)).toMatchObject({ complete: 1, cues: 9, untranslated: 0 });
    expect(commentaryReady(A)).toBe(true);
    // Chaque sous-titre n'est traduit qu'une fois.
    expect(calls.translated).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Avancement en tronçons ; couverture publiée après chaque tronçon.
    const fmt = events.map((p) => `${p.phase} ${p.done}/${p.total}`);
    expect(fmt).toEqual([
      'extraction 0/3',
      'preparation 0/0',
      'transcription 0/3',
      'preparation 0/0',
      'traduction 0/3',
      'traduction 1/3',
      'extraction 1/3',
      'transcription 1/3',
      'traduction 1/3',
      'traduction 2/3',
      'extraction 2/3',
      'transcription 2/3',
      'traduction 2/3',
      'traduction 3/3',
    ]);
    expect([...new Set(events.map((p) => p.availableUntil))]).toEqual([undefined, 598, 1198, DURATION]);
    expect(fs.existsSync(workDir(db.getMatch(A)!.video_ok_id!))).toBe(false);
  });

  it('reprise à mi-parcours : ce qui est publié reste, rien n’est refait, mêmes seq à l’arrivée', async () => {
    const first = fakeDeps({ failTranscribeAt: 2 });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, signal(), first.deps)).rejects.toBeInstanceOf(ServiceError);
    expect(published()).toHaveLength(7);
    expect(db.getCommentaryTrack(A)?.complete).toBe(0);
    expect(commentaryReady(A)).toBe(false);
    expect(servedCommentaryCues(A)).toHaveLength(7);
    const before = published();

    const second = fakeDeps();
    const res = await runCommentary({ matchId: A, force: false }, () => {}, signal(), second.deps);
    expect(res.ok).toBe(true);
    expect(second.calls.extract).toEqual([]); // audio du tronçon 3 déjà extrait
    expect(second.calls.transcribe).toEqual([2]);
    expect(second.calls.translated).toEqual([8, 9]); // cache de traduction (seq + anglais) réutilisé
    expect(published().slice(0, 7)).toEqual(before);
    expect(published().map(([seq, start, end, text]) => ({ seq, start, end, text }))).toEqual(fullBuild());
    expect(db.getCommentaryTrack(A)?.complete).toBe(1);
  });

  it('échec au tronçon 3 : les tronçons 1-2 restent publiés et servis, statut failed', async () => {
    const { deps } = fakeDeps({ failExtractAt: 2 });
    __setCommentaryRunnerForTests((job, progress, sig) => runCommentary(job, progress, sig, deps));
    enqueueCommentary(A);
    await __commentaryIdle();
    const st = commentaryStatus(A);
    expect(st).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^Flux vidéo inaccessible.*tronçon 3\/3/) });
    expect(st.available_until).toBe(db.getCommentaryCues(A)[6].end_ts);
    expect(db.commentaryReadyIds([A])).toEqual(new Set());

    const d = await (await getSubtitles(new Request(`http://nas.local/api/matches/${A}/subtitles`), { params: Promise.resolve({ id: String(A) }) })).json();
    expect(d.count).toBe(7);
    expect(d.subtitles[0]).toEqual({ seq: 1, video_ts: 10, end_ts: expect.any(Number), text: 'FR Tatum brings it up the floor.', speaker: '', kind: 'voice' });
    expect(d.commentary.status).toBe('failed');
  });

  it('échec de traduction en cours de tronçon : rien de partiel n’est publié pour ce tronçon', async () => {
    const { deps } = fakeDeps({ failTranslateAt: 4 });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, signal(), deps)).rejects.toBeInstanceOf(ServiceError);
    expect(published().map(([seq]) => seq)).toEqual([1, 2, 3]);
  });
});

// ------------------------------------------------------------------ GPU : sessions Whisper et Ollama

describe('sessions Whisper / Ollama', () => {
  it('par défaut : les deux restent ouvertes ensemble, tronçon par tronçon, fermées à la fin', async () => {
    const { deps, calls } = fakeDeps({ sessions: true });
    expect((await runCommentary({ matchId: A, force: false }, () => {}, signal(), deps)).ok).toBe(true);
    expect(calls.events).toEqual([
      'whisper ouvert',
      'transcription 0',
      'ollama ouvert',
      'traduction 1,2,3',
      'transcription 1',
      'traduction 4,5,6,7',
      'transcription 2',
      'traduction 8,9',
      'whisper fermé',
      'ollama fermé',
    ]);
  });

  it('sur erreur : les deux sessions sont fermées', async () => {
    const { deps, calls } = fakeDeps({ sessions: true, failTranscribeAt: 1 });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, signal(), deps)).rejects.toBeInstanceOf(ServiceError);
    expect(calls.events.slice(-2)).toEqual(['whisper fermé', 'ollama fermé']);
  });

  it('abandon : travail interrompu, sessions fermées', async () => {
    const ctrl = new AbortController();
    const { deps, calls } = fakeDeps({ sessions: true });
    const translate = deps.translate;
    deps.translate = async (...args) => {
      const r = await translate(...args);
      ctrl.abort();
      return r;
    };
    await expect(runCommentary({ matchId: A, force: false }, () => {}, ctrl.signal, deps)).rejects.toThrow('travail interrompu');
    expect(calls.events.slice(-2)).toEqual(['whisper fermé', 'ollama fermé']);
    expect(calls.transcribe).toEqual([0]);
  });

  it('COMMENTARY_GPU_SEQUENTIAL=1 : tout transcrire, fermer Whisper, puis traduire (publication toujours progressive)', async () => {
    process.env.COMMENTARY_GPU_SEQUENTIAL = '1';
    const { deps, calls } = fakeDeps({ sessions: true });
    const snapshots: number[] = [];
    const translate = deps.translate;
    deps.translate = async (...args) => {
      snapshots.push(published().length);
      return translate(...args);
    };
    const res = await runCommentary({ matchId: A, force: false }, () => {}, signal(), deps);
    expect(res).toMatchObject({ ok: true, reason: expect.stringContaining('GPU séquentiel') });
    expect(calls.events).toEqual([
      'whisper ouvert',
      'transcription 0',
      'transcription 1',
      'transcription 2',
      'whisper fermé',
      'ollama ouvert',
      'traduction 1,2,3',
      'traduction 4,5,6,7',
      'traduction 8,9',
      'ollama fermé',
    ]);
    expect(snapshots).toEqual([0, 3, 7]);
    expect(published().map(([seq, start, end, text]) => ({ seq, start, end, text }))).toEqual(fullBuild());
  });

  it('mode séquentiel, reprise après panne de traduction : ni extraction ni transcription refaites', async () => {
    process.env.COMMENTARY_GPU_SEQUENTIAL = '1';
    const first = fakeDeps({ failTranslateAt: 4 });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, signal(), first.deps)).rejects.toBeInstanceOf(ServiceError);
    expect(first.calls.transcribe).toEqual([0, 1, 2]);
    expect(published()).toHaveLength(3);
    const second = fakeDeps();
    expect((await runCommentary({ matchId: A, force: false }, () => {}, signal(), second.deps)).ok).toBe(true);
    expect(second.calls.extract).toEqual([]);
    expect(second.calls.transcribe).toEqual([]);
    expect(second.calls.translated).toEqual([4, 5, 6, 7, 8, 9]);
  });
});
