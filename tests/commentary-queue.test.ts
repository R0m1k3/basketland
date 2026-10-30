import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// La file ne dépend que de la disponibilité DÉCLARÉE de ffmpeg.
vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { DEFAULT_TRANSLATE_MODEL } from '../src/lib/commentaryAi';
import {
  __commentaryIdle,
  __setCommentaryRunnerForTests,
  commentaryQueuePosition,
  commentaryRetryAllowed,
  commentaryStatus,
  enqueueCommentary,
  enqueueRecentCommentaries,
  getCommentaryRecord,
  runCommentary,
  workDir,
  type CommentaryDeps,
  type CommentaryOutcome,
  type CommentaryRunner,
} from '../src/lib/commentary';
import { ServiceError } from '../src/lib/commentaryAi';
import { MAX_AUTO_FAILURES } from '../src/lib/analysis';
import { freshDb, insertMatch } from './helpers/db';

const A = 401000001;
const B = 401000002;
const C = 401000003;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

let dataDir: string;

beforeEach(() => {
  freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-commentary-'));
  process.env.DATA_DIR = dataDir;
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
  for (const id of [A, B, C]) insertMatch(id, { duration: 1300 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setCommentaryRunnerForTests(null);
  for (const k of ['DATA_DIR', 'TRANSCRIBE_URL', 'TRANSLATE_URL', 'COMMENTARY_DISABLED']) delete process.env[k];
  vi.restoreAllMocks();
});

describe('file des traductions', () => {
  it('un seul travail à la fois, les suivants attendent dans l’ordre', async () => {
    const gates = new Map<number, ReturnType<typeof deferred<CommentaryOutcome>>>();
    const started: number[] = [];
    __setCommentaryRunnerForTests((job, progress) => {
      started.push(job.matchId);
      progress({ phase: 'transcription', done: 2, total: 3 });
      const d = deferred<CommentaryOutcome>();
      gates.set(job.matchId, d);
      return d.promise;
    });
    expect(enqueueCommentary(A)).toMatchObject({ queued: true, started: true });
    expect(enqueueCommentary(B)).toMatchObject({ queued: true, started: false, position: 1 });
    expect(started).toEqual([A]);
    expect(commentaryStatus(A)).toEqual({
      status: 'running',
      phase: 'transcription',
      progress: { done: 2, total: 3 },
      models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL },
    });
    expect(commentaryStatus(B)).toMatchObject({ status: 'queued', position: 1 });
    gates.get(A)!.resolve({ ok: true, reason: 'ok' });
    await vi.waitFor(() => expect(started).toEqual([A, B]));
    gates.get(B)!.resolve({ ok: true, reason: 'ok' });
    await __commentaryIdle();
  });

  it('priorité : la fiche ouverte passe en tête de file', () => {
    __setCommentaryRunnerForTests(() => new Promise(() => {}));
    enqueueCommentary(A);
    enqueueCommentary(B);
    enqueueCommentary(C);
    expect(commentaryQueuePosition(C)).toBe(2);
    expect(enqueueCommentary(C, { priority: true })).toMatchObject({ position: 1 });
    expect(commentaryQueuePosition(B)).toBe(2);
    expect(enqueueCommentary(A)).toMatchObject({ started: true, message: 'Traduction déjà en cours' });
  });

  it('un match regardé interrompt le travail de fond, qui reprend juste après sans compter d’échec', async () => {
    const started: number[] = [];
    const gates = new Map<number, ReturnType<typeof deferred<CommentaryOutcome>>>();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    __setCommentaryRunnerForTests((job, _progress, signal) => {
      started.push(job.matchId);
      const d = deferred<CommentaryOutcome>();
      gates.set(job.matchId, d);
      signal.addEventListener('abort', () => d.reject(new Error('travail interrompu')));
      return d.promise;
    });
    enqueueCommentary(A); // fond
    enqueueCommentary(B); // fond
    expect(started).toEqual([A]);
    enqueueCommentary(C, { priority: true }); // fiche ouverte
    await vi.waitFor(() => expect(started).toEqual([A, C]));
    expect(commentaryStatus(C).status).toBe('running');
    // A reprend juste derrière C, devant B ; aucun échec enregistré.
    expect(commentaryQueuePosition(A)).toBe(1);
    expect(commentaryQueuePosition(B)).toBe(2);
    expect(getCommentaryRecord(A)).toBeUndefined();
    // Un autre match regardé n'interrompt pas C (demandé par un spectateur).
    enqueueCommentary(B, { priority: true });
    expect(commentaryStatus(C).status).toBe('running');
    expect(commentaryQueuePosition(B)).toBe(1);
    gates.get(C)!.resolve({ ok: true, reason: 'ok' });
    await vi.waitFor(() => expect(started).toEqual([A, C, B]));
    gates.get(B)!.resolve({ ok: true, reason: 'ok' });
    await vi.waitFor(() => expect(started).toEqual([A, C, B, A]));
    gates.get(A)!.resolve({ ok: true, reason: 'ok' });
    await __commentaryIdle();
    expect(getCommentaryRecord(A)).toMatchObject({ ok: true });
  });

  it('inactive sans configuration : rien n’est mis en file', () => {
    delete process.env.TRANSLATE_URL;
    expect(enqueueCommentary(A)).toMatchObject({ queued: false, message: expect.stringMatching(/TRANSLATE_URL/) });
    expect(commentaryStatus(A)).toEqual({ status: 'disabled', reason: 'serveur de traduction non configuré (TRANSLATE_URL)' });
    expect(enqueueRecentCommentaries()).toBe(0);
  });

  it('échec : statut failed, backoff, abandon après MAX_AUTO_FAILURES ; échec réseau sans compter', async () => {
    let outcome: CommentaryOutcome = { ok: false, kind: 'erreur', reason: 'boum' };
    __setCommentaryRunnerForTests(async () => outcome);
    enqueueCommentary(A);
    await __commentaryIdle();
    const rec = getCommentaryRecord(A)!;
    expect(rec).toMatchObject({ ok: false, failures: 1, kind: 'erreur', reason: 'boum' });
    expect(commentaryStatus(A)).toEqual({ status: 'failed', reason: 'boum' });
    const okId = db.getMatch(A)!.video_ok_id;
    const at = Date.parse(rec.at);
    expect(commentaryRetryAllowed(rec, okId, at + 30 * 60_000)).toBe(false);
    expect(commentaryRetryAllowed(rec, okId, at + 3600_000)).toBe(true);
    expect(commentaryRetryAllowed({ ...rec, failures: MAX_AUTO_FAILURES }, okId, at + 30 * 24 * 3600_000)).toBe(false);
    // Nouvelle vidéo : on repart de zéro.
    expect(commentaryRetryAllowed({ ...rec, failures: MAX_AUTO_FAILURES }, 'autre-video', at)).toBe(true);

    outcome = { ok: false, kind: 'service', reason: 'Ollama éteint' };
    enqueueCommentary(A);
    await __commentaryIdle();
    const rec2 = getCommentaryRecord(A)!;
    expect(rec2).toMatchObject({ failures: 1, netFailures: 1, kind: 'service' });
    expect(commentaryRetryAllowed(rec2, okId, Date.parse(rec2.at) + 16 * 60_000)).toBe(true);
  });

  it('une exception ServiceError devient un échec « service »', async () => {
    __setCommentaryRunnerForTests(async () => {
      throw new ServiceError('serveur de traduction injoignable (http://gpu.local:11434/v1) : ECONNREFUSED', 'traduction');
    });
    enqueueCommentary(A);
    await __commentaryIdle();
    expect(getCommentaryRecord(A)).toMatchObject({ kind: 'service', reason: 'Traduction impossible : serveur de traduction injoignable (http://gpu.local:11434/v1) : ECONNREFUSED' });
  });

  it('job périodique : matchs récents sans piste à jour, backoff respecté', async () => {
    const runner: CommentaryRunner = () => new Promise(() => {});
    __setCommentaryRunnerForTests(runner);
    db.replaceCommentary(A, { ok_id: db.getMatch(A)!.video_ok_id!, transcribe_model: 'w', translate_model: DEFAULT_TRANSLATE_MODEL }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 },
    ]);
    db.setVideo(C, { slug: null, okId: null, duration: null, available: false });
    expect(enqueueRecentCommentaries()).toBe(1); // B seulement (A prête, C sans replay)
    expect(commentaryStatus(B).status).toBe('running');
    // Le replay de A change : la piste n'est plus valable, A repasse en file.
    db.setVideo(A, { slug: null, okId: '999888777', duration: 1300, available: true });
    expect(commentaryStatus(A).status).toBe('none');
    expect(enqueueRecentCommentaries()).toBe(1);
    expect(commentaryStatus(A)).toMatchObject({ status: 'queued', position: 1 });
  });

  it('job périodique : piste faite par un ancien modèle de traduction → refaite', () => {
    __setCommentaryRunnerForTests(() => new Promise(() => {}));
    db.setVideo(C, { slug: null, okId: null, duration: null, available: false });
    db.replaceCommentary(B, { ok_id: db.getMatch(B)!.video_ok_id!, transcribe_model: 'w', translate_model: DEFAULT_TRANSLATE_MODEL }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 },
    ]);
    db.replaceCommentary(A, { ok_id: db.getMatch(A)!.video_ok_id!, transcribe_model: 'w', translate_model: 'ancien-modele' }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'Hi', text_fr: 'Salut', untranslated: 0 },
    ]);
    expect(enqueueRecentCommentaries()).toBe(1); // A seulement (B à jour)
    expect(commentaryStatus(A).status).toBe('running');
  });
});

// ------------------------------------------------------------------ exécution complète (dépendances simulées)

function fakeDeps(o: { failExtract?: boolean; failTranslate?: boolean } = {}) {
  const calls = { extract: [] as number[], transcribe: [] as string[], translate: 0 };
  const deps: CommentaryDeps = {
    resolveStream: async () => ({ variants: [{ key: 'low', bandwidth: 600_000, resolution: '640x360', url: 'https://vd.okcdn.ru/low.m3u8' }], duration: 1300 }),
    extract: async (_url, start, _len, out) => {
      calls.extract.push(start);
      if (o.failExtract) throw new Error('ffmpeg audio @0s code 1: HTTP error 403 Forbidden');
      fs.writeFileSync(out, Buffer.alloc(4096));
    },
    transcribe: async (file) => {
      calls.transcribe.push(path.basename(file));
      // Chaque tronçon : une phrase 10 s après son début d'extraction.
      const idx = [0, 597, 1197].indexOf(Number(/chunk-(\d+)-/.exec(file)![1])); // fichier chunk-<début>-<durée>
      const text = `Play number ${idx + 1} is good.`;
      const words = text.split(' ').map((w, i) => ({ word: ` ${w}`, start: 10 + i * 0.3, end: 10.25 + i * 0.3 }));
      return { segments: [{ start: 10, end: 12, text: ` ${text}`, avg_logprob: -0.2, no_speech_prob: 0.02, compression_ratio: 1.1 }], words };
    },
    translate: async (lines) => {
      calls.translate++;
      if (o.failTranslate) throw new ServiceError('serveur de traduction injoignable', 'traduction');
      return lines.map((l) => ({ i: l.i, fr: l.en.replace(/Play number (\d+) is good\./, 'Action $1 réussie.'), untranslated: false }));
    },
  };
  return { deps, calls };
}

describe('runCommentary', () => {
  const ctrl = () => new AbortController().signal;
  // Tronçons de 10 min ici (3 tronçons) : le découpage fin d'1 min est testé dans commentary-ondemand.
  beforeEach(() => void (process.env.COMMENTARY_CHUNK_SEC = '600'));
  afterEach(() => void delete process.env.COMMENTARY_CHUNK_SEC);
  /** Début (s) du tronçon d'après le nom du fichier audio (chunk-<début>-<durée>.ogg). */
  const startOf = (f: string) => Number(/chunk-(\d+)-/.exec(f)![1]);

  it('extrait, transcrit, décale, traduit et stocke ; le dossier de travail est supprimé', async () => {
    const { deps, calls } = fakeDeps();
    const phases: string[] = [];
    const res = await runCommentary({ matchId: A, force: false }, (p) => phases.push(`${p.phase} ${p.done}/${p.total}`), ctrl(), deps);
    expect(res.ok).toBe(true);
    // Extraction anticipée : le tronçon suivant se télécharge pendant le traitement du courant.
    expect([...calls.extract].sort((a, b) => a - b)).toEqual([0, 597, 1197]);
    const cues = db.getCommentaryCues(A);
    expect(cues.map((c) => [c.start_ts, c.text_en, c.text_fr])).toEqual([
      [10, 'Play number 1 is good.', 'Action 1 réussie.'],
      [607, 'Play number 2 is good.', 'Action 2 réussie.'],
      [1207, 'Play number 3 is good.', 'Action 3 réussie.'],
    ]);
    // Tronçon par tronçon : chaque tronçon est transcrit, traduit et publié avant le suivant.
    expect(phases.filter((p) => p.startsWith('transcription') || p.startsWith('traduction'))).toEqual([
      'transcription 0/3',
      'traduction 0/3',
      'traduction 1/3',
      'transcription 1/3',
      'traduction 1/3',
      'traduction 2/3',
      'transcription 2/3',
      'traduction 2/3',
      'traduction 3/3',
    ]);
    expect(fs.existsSync(workDir(db.getMatch(A)!.video_ok_id!))).toBe(false);
    expect(commentaryStatus(A)).toEqual({ status: 'ready', models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL } });
    expect(db.commentaryReadyIds([A, B, 12345])).toEqual(new Set([A]));
  });

  it('reprise : après une panne de traduction, ni extraction ni transcription déjà faites ne sont refaites', async () => {
    const first = fakeDeps({ failTranslate: true });
    await expect(runCommentary({ matchId: A, force: false }, () => {}, ctrl(), first.deps)).rejects.toBeInstanceOf(ServiceError);
    // Le tronçon 1 a été transcrit, sa traduction a échoué : rien n'est publié.
    expect(first.calls.transcribe.map(startOf)).toEqual([0]);
    expect(db.getCommentaryCues(A)).toHaveLength(0);
    const second = fakeDeps();
    const res = await runCommentary({ matchId: A, force: false }, () => {}, ctrl(), second.deps);
    expect(res.ok).toBe(true);
    expect(second.calls.extract).toEqual([1197]); // tronçon 2 déjà téléchargé par anticipation
    expect(second.calls.transcribe.map(startOf)).toEqual([597, 1197]);
    expect(db.getCommentaryCues(A)).toHaveLength(3);
  });

  it('flux inaccessible : échec « reseau » (backoff court), pas d’exception', async () => {
    const { deps } = fakeDeps({ failExtract: true });
    const res = await runCommentary({ matchId: A, force: false }, () => {}, ctrl(), deps);
    expect(res).toMatchObject({ ok: false, kind: 'reseau' });
    expect(res.reason).toMatch(/^Flux vidéo inaccessible : l'audio n'a pas pu être extrait \(tronçon 1\/3 : .*403.*\)\..*~15 min\.$/);
  });

  it('aucune parole : échec « contenu »', async () => {
    const { deps } = fakeDeps();
    deps.transcribe = async () => ({ segments: [{ start: 1, end: 2, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.5 }], words: [] });
    expect(await runCommentary({ matchId: A, force: false }, () => {}, ctrl(), deps)).toMatchObject({ ok: false, kind: 'contenu' });
  });
});
