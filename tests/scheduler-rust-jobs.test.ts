import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Jobs repris par le serveur Rust (BL_RUST_JOBS, posé par server/src/node.rs
 * pour l'application Node) : le planificateur de Node ne les lance plus et
 * garde les autres (vidéos, analyses, traductions).
 */
const jobs = vi.hoisted(() => ({
  syncSchedule: vi.fn(async () => ({ ok: true, detail: '' })),
  syncSeason: vi.fn(async () => ({ ok: true, detail: '' })),
  syncStats: vi.fn(async () => ({ ok: true, detail: '' })),
  syncSubtitles: vi.fn(async () => ({ ok: true, detail: '' })),
  syncVideos: vi.fn(async () => ({ ok: true, detail: '' })),
}));
const queued = vi.hoisted(() => ({ commentaries: vi.fn(() => 0), analyses: vi.fn(() => 0) }));
vi.mock('../src/lib/ingest', async (orig) => ({ ...(await orig<typeof import('../src/lib/ingest')>()), ...jobs }));
vi.mock('../src/lib/commentary', async (orig) => ({ ...(await orig<typeof import('../src/lib/commentary')>()), enqueueRecentCommentaries: queued.commentaries }));
vi.mock('../src/lib/analysis', async (orig) => ({ ...(await orig<typeof import('../src/lib/analysis')>()), enqueueRecentAnalyses: queued.analyses }));

import { rustJobs, startScheduler } from '../src/lib/scheduler';
import { freshDb } from './helpers/db';

const MIN = 60_000;
const g = globalThis as unknown as { __basketlandCron?: boolean };

function start(env: string | undefined) {
  if (env === undefined) delete process.env.BL_RUST_JOBS;
  else process.env.BL_RUST_JOBS = env;
  g.__basketlandCron = false;
  startScheduler();
}

describe('cron Node : jobs repris par le serveur Rust (BL_RUST_JOBS)', () => {
  beforeEach(() => {
    freshDb(); // base vide : le chargement de la saison se déclenche (< 50 matchs)
    vi.useFakeTimers();
    for (const f of [...Object.values(jobs), ...Object.values(queued)]) f.mockClear();
    delete process.env.DISABLE_CRON;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.BL_RUST_JOBS;
    g.__basketlandCron = false;
  });

  it('lecture de la liste : séparée par des virgules, blancs ignorés', () => {
    process.env.BL_RUST_JOBS = ' sync-schedule, sync-stats,,sync-subtitles ,sync-season ';
    expect([...rustJobs()]).toEqual(['sync-schedule', 'sync-stats', 'sync-subtitles', 'sync-season']);
    delete process.env.BL_RUST_JOBS;
    expect(rustJobs().size).toBe(0);
  });

  it('sans BL_RUST_JOBS : Node lance tous ses jobs, comme avant', async () => {
    start(undefined);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(jobs.syncSeason).toHaveBeenCalledTimes(1);
    expect(jobs.syncSchedule).toHaveBeenCalled();
    expect(jobs.syncStats).toHaveBeenCalled();
    expect(jobs.syncSubtitles).toHaveBeenCalled();
    expect(jobs.syncVideos).toHaveBeenCalled();
  });

  it('jobs repris par Rust : Node ne les lance plus et garde les vidéos, analyses et traductions', async () => {
    start('sync-schedule,sync-stats,sync-subtitles,sync-season');
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(jobs.syncSeason).not.toHaveBeenCalled();
    expect(jobs.syncSchedule).not.toHaveBeenCalled();
    expect(jobs.syncStats).not.toHaveBeenCalled();
    expect(jobs.syncSubtitles).not.toHaveBeenCalled();
    expect(jobs.syncVideos).toHaveBeenCalled();
    expect(queued.analyses).toHaveBeenCalled();
    expect(queued.commentaries).toHaveBeenCalled();
  });

  it('liste partielle : seuls les jobs nommés sont sautés', async () => {
    start('sync-stats');
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(jobs.syncStats).not.toHaveBeenCalled();
    expect(jobs.syncSchedule).toHaveBeenCalled();
    expect(jobs.syncSeason).toHaveBeenCalledTimes(1);
    expect(jobs.syncSubtitles).toHaveBeenCalled();
  });
});
