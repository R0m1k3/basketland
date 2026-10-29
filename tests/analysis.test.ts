import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ffmpeg n'est pas forcément installé sur la machine de test : la file ne
// dépend que de sa disponibilité déclarée.
vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import {
  __analysisIdle,
  __setAnalysisRunnerForTests,
  analysisStatus,
  autoRetryAllowed,
  backoffMs,
  enqueueAnalysis,
  enqueueRecentAnalyses,
  getAnalysisRecord,
  MAX_AUTO_FAILURES,
  pickAnalysisSource,
  pickAudioSource,
  queuePosition,
  type AnalysisRecord,
  type AnalysisRunner,
} from '../src/lib/analysis';
import type { Variant } from '../src/lib/okru';
import { freshDb, insertMatch } from './helpers/db';

const v = (key: string, resolution: string, bandwidth: number): Variant => ({ key, resolution, bandwidth, url: `https://vd.okcdn.ru/${key}.m3u8` });
const mp4 = (...names: string[]) => names.map((name) => ({ name, url: `https://vd.okcdn.ru/${name}.mp4` }));

describe('pickAnalysisSource', () => {
  it('préfère la variante HLS 720p', () => {
    const s = pickAnalysisSource({ variants: [v('sd', '852x480', 1_000_000), v('hd', '1280x720', 2_500_000), v('full', '1920x1080', 5_000_000)] });
    expect(s).toMatchObject({ kind: 'hls', label: 'hd', height: 720 });
  });

  it('prend la plus petite au-dessus de 720p si seules des définitions trop faibles existent en dessous', () => {
    const s = pickAnalysisSource({ variants: [v('low', '640x360', 600_000), v('full', '1920x1080', 5_000_000)] });
    expect(s).toMatchObject({ kind: 'hls', label: 'full' });
  });

  it('déduit la hauteur de la clé quand RESOLUTION manque', () => {
    const s = pickAnalysisSource({ variants: [v('sd', '', 1_000_000), v('hd', '', 2_000_000)] });
    expect(s).toMatchObject({ label: 'hd', height: 720 });
  });

  it('sans HLS, prend le meilleur MP4 ≤ 720p', () => {
    const s = pickAnalysisSource({ variants: [], mp4: mp4('mobile', 'lowest', 'low', 'sd', 'hd', 'full') } as never);
    expect(s).toMatchObject({ kind: 'mp4', label: 'hd', url: 'https://vd.okcdn.ru/hd.mp4' });
  });

  it('sans MP4 ≤ 720p, prend le meilleur MP4 disponible', () => {
    const s = pickAnalysisSource({ variants: [], mp4: mp4('full') } as never);
    expect(s).toMatchObject({ kind: 'mp4', label: 'full' });
  });

  it('HLS prioritaire sur MP4 quand les deux existent', () => {
    const s = pickAnalysisSource({ variants: [v('sd', '852x480', 1_000_000)], mp4: mp4('hd') } as never);
    expect(s?.kind).toBe('hls');
  });

  it('tolère un champ mp4 absent ou malformé', () => {
    expect(pickAnalysisSource({ variants: [] })).toBeNull();
    expect(pickAnalysisSource({ variants: [], mp4: 'oops' } as never)).toBeNull();
    expect(pickAnalysisSource({ variants: [], mp4: [null, { name: 'sd' }, { name: 'sd', url: 'https://x/sd.mp4' }] } as never)).toMatchObject({
      kind: 'mp4',
      label: 'sd',
    });
  });

  it("l'audio prend la source la plus légère", () => {
    expect(pickAudioSource({ variants: [v('hd', '1280x720', 2_500_000), v('low', '640x360', 600_000)] })?.label).toBe('low');
    expect(pickAudioSource({ variants: [], mp4: mp4('hd', 'mobile', 'sd') } as never)?.label).toBe('mobile');
  });
});

describe('backoff', () => {
  const rec = (failures: number, minutesAgo: number, ok = false): AnalysisRecord => ({
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ok,
    failures,
    reason: '',
    anchors: 0,
    okId: 'A',
  });

  it('espace les tentatives : 1 h, 4 h, 16 h puis 24 h', () => {
    expect(backoffMs(1)).toBe(3600_000);
    expect(backoffMs(2)).toBe(4 * 3600_000);
    expect(backoffMs(3)).toBe(16 * 3600_000);
    expect(backoffMs(4)).toBe(24 * 3600_000);
  });

  it('autorise une nouvelle tentative automatique seulement une fois le délai écoulé', () => {
    expect(autoRetryAllowed(undefined, 'A')).toBe(true);
    expect(autoRetryAllowed(rec(1, 30), 'A')).toBe(false);
    expect(autoRetryAllowed(rec(1, 61), 'A')).toBe(true);
    expect(autoRetryAllowed(rec(2, 61), 'A')).toBe(false);
  });

  it(`abandonne après ${MAX_AUTO_FAILURES} échecs, sauf si la vidéo change`, () => {
    expect(autoRetryAllowed(rec(MAX_AUTO_FAILURES, 10 * 24 * 60), 'A')).toBe(false);
    expect(autoRetryAllowed(rec(MAX_AUTO_FAILURES, 1), 'B')).toBe(true);
  });

  it("ne relance pas automatiquement une analyse réussie", () => {
    expect(autoRetryAllowed(rec(0, 10 * 24 * 60, true), 'A')).toBe(false);
  });
});

describe("file d'attente des analyses", () => {
  type Deferred = { resolve: (r: { ok: boolean; anchors: number; reason: string }) => void; reject: (e: Error) => void };
  let pending: Map<number, Deferred>;
  let started: number[];
  const runner: AnalysisRunner = (job, progress) =>
    new Promise((resolve, reject) => {
      started.push(job.matchId);
      progress({ phase: 'lecture du chrono', done: 3, total: 10 });
      pending.set(job.matchId, { resolve, reject });
    });
  const finish = async (id: number, r: { ok: boolean; anchors: number; reason: string } | Error) => {
    const d = pending.get(id)!;
    pending.delete(id);
    if (r instanceof Error) d.reject(r);
    else d.resolve(r);
    await new Promise((res) => setTimeout(res, 0));
  };

  beforeEach(() => {
    freshDb();
    pending = new Map();
    started = [];
    __setAnalysisRunnerForTests(runner);
    delete process.env.ANALYSIS_MAX_PARALLEL;
    delete process.env.ANALYSIS_MIN_INTERVAL_MS;
    for (const id of [1, 2, 3, 4]) insertMatch(id);
  });
  afterEach(() => __setAnalysisRunnerForTests(null));

  it('traite une analyse à la fois, dans l’ordre de mise en file', async () => {
    expect(enqueueAnalysis(1)).toMatchObject({ queued: true, started: true, message: 'Analyse lancée' });
    expect(enqueueAnalysis(2)).toMatchObject({ queued: true, started: false, position: 1, message: 'Analyse en file (position 1)' });
    expect(enqueueAnalysis(3)).toMatchObject({ position: 2, message: 'Analyse en file (position 2)' });
    expect(started).toEqual([1]);
    expect(analysisStatus(1)).toEqual({ status: 'running', progress: { phase: 'lecture du chrono', done: 3, total: 10 } });
    expect(analysisStatus(3)).toEqual({ status: 'queued', position: 2 });
    await finish(1, { ok: true, anchors: 8, reason: 'ok' });
    expect(started).toEqual([1, 2]);
    await finish(2, { ok: true, anchors: 8, reason: 'ok' });
    await finish(3, { ok: true, anchors: 8, reason: 'ok' });
    expect(started).toEqual([1, 2, 3]);
    await __analysisIdle();
  });

  it('une demande explicite passe en tête de file', async () => {
    enqueueAnalysis(1);
    enqueueAnalysis(2);
    enqueueAnalysis(3);
    expect(enqueueAnalysis(3, { priority: true, manual: true })).toMatchObject({ position: 1, message: 'Analyse en file (position 1)' });
    expect(queuePosition(2)).toBe(2);
    expect(enqueueAnalysis(4, { priority: true, manual: true })).toMatchObject({ position: 1 });
    expect(queuePosition(3)).toBe(2);
    await finish(1, { ok: true, anchors: 4, reason: 'ok' });
    expect(started).toEqual([1, 4]);
  });

  it("ne duplique pas un match déjà en file ou en cours", () => {
    enqueueAnalysis(1);
    expect(enqueueAnalysis(1)).toMatchObject({ queued: false, message: 'Analyse déjà en cours' });
    enqueueAnalysis(2);
    expect(enqueueAnalysis(2)).toMatchObject({ queued: true, position: 1, message: 'Analyse déjà en file (position 1)' });
  });

  it('respecte ANALYSIS_MAX_PARALLEL', () => {
    process.env.ANALYSIS_MAX_PARALLEL = '2';
    enqueueAnalysis(1);
    enqueueAnalysis(2);
    enqueueAnalysis(3);
    expect(started).toEqual([1, 2]);
  });

  it('refuse un match sans replay', () => {
    insertMatch(9, { okId: null });
    expect(enqueueAnalysis(9)).toMatchObject({ queued: false, message: 'Analyse impossible : pas de replay disponible' });
    expect(analysisStatus(9)).toMatchObject({ status: 'unavailable', reason: 'pas de replay disponible' });
  });

  it("une analyse qui plante passe en « failed » avec une raison lisible (pas bloquée en « running »)", async () => {
    enqueueAnalysis(1);
    await finish(1, new Error('OCR indisponible : script du worker tesseract.js absent'));
    expect(analysisStatus(1)).toMatchObject({
      status: 'failed',
      reason: 'Analyse impossible : OCR indisponible : script du worker tesseract.js absent',
    });
    expect(getAnalysisRecord(1)).toMatchObject({ ok: false, failures: 1 });
    expect(db.lastIngests(1)[0]).toMatchObject({ task: 'analyse-1', ok: 0 });
  });

  it('dépasse le délai maximal → échec, et la file repart', async () => {
    process.env.ANALYSIS_TIMEOUT_MS = '20';
    try {
      enqueueAnalysis(1);
      enqueueAnalysis(2);
      await new Promise((r) => setTimeout(r, 60));
      expect(analysisStatus(1)).toMatchObject({ status: 'failed', reason: expect.stringContaining('délai dépassé') });
      expect(started).toEqual([1, 2]);
    } finally {
      delete process.env.ANALYSIS_TIMEOUT_MS;
    }
  });

  it('cooldown après un succès pour une relance manuelle', async () => {
    enqueueAnalysis(1, { manual: true });
    await finish(1, { ok: true, anchors: 6, reason: 'ok' });
    expect(enqueueAnalysis(1, { priority: true, manual: true })).toMatchObject({ queued: false, message: expect.stringMatching(/^Analyse récente, réessayez dans ~\d+ min$/) });
    process.env.ANALYSIS_MIN_INTERVAL_MS = '0';
    expect(enqueueAnalysis(1, { priority: true, manual: true })).toMatchObject({ queued: true, started: true });
  });

  it('mise en file automatique : récents avec replay, sans ancre OCR, backoff respecté', async () => {
    insertMatch(5, { date_utc: new Date(Date.now() - 20 * 24 * 3600_000).toISOString() }); // trop ancien
    insertMatch(6, { okId: null }); // pas de replay
    db.upsertAnchor({ match_id: 4, period: 1, clock_sec: 600, video_ts: 500, method: 'auto', wallclock: null }); // déjà analysé
    db.upsertAnchor({ match_id: 3, period: 1, clock_sec: 600, video_ts: 500, method: 'manual', wallclock: null });
    db.upsertAnchor({ match_id: 3, period: 2, clock_sec: 600, video_ts: 1500, method: 'manual', wallclock: null }); // calé à la main
    db.kvSet('analysis:2', { at: new Date().toISOString(), ok: false, failures: 1, reason: 'x', anchors: 0, okId: db.getMatch(2)!.video_ok_id });
    expect(enqueueRecentAnalyses()).toBe(1);
    expect(started).toEqual([1]);
    // Un nouveau passage ne remet rien en file (1 en cours, 2 en backoff).
    expect(enqueueRecentAnalyses()).toBe(0);
    await finish(1, { ok: false, anchors: 0, reason: 'Chrono du bandeau illisible' });
    expect(analysisStatus(1)).toMatchObject({ status: 'failed', reason: 'Chrono du bandeau illisible' });
    expect(enqueueRecentAnalyses()).toBe(0); // backoff de 1 h
  });

  it("statut « done » avec le nombre d'ancres OCR", () => {
    db.upsertAnchor({ match_id: 1, period: 1, clock_sec: 600, video_ts: 500, method: 'auto', wallclock: null });
    db.upsertAnchor({ match_id: 1, period: 2, clock_sec: 600, video_ts: 1900, method: 'auto', wallclock: null });
    expect(analysisStatus(1)).toMatchObject({ status: 'done', anchors_auto: 2 });
    expect(analysisStatus(2)).toEqual({ status: 'none', anchors_auto: 0 });
  });
});
