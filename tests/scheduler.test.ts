import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const enqueued = vi.hoisted(() => ({ commentaries: vi.fn(() => 2), analyses: vi.fn(() => 3), dubs: vi.fn(async () => 4) }));
vi.mock('../src/lib/commentary', async (orig) => ({ ...(await orig<typeof import('../src/lib/commentary')>()), enqueueRecentCommentaries: enqueued.commentaries }));
vi.mock('../src/lib/analysis', async (orig) => ({ ...(await orig<typeof import('../src/lib/analysis')>()), enqueueRecentAnalyses: enqueued.analyses }));
vi.mock('../src/lib/dub', async (orig) => ({ ...(await orig<typeof import('../src/lib/dub')>()), enqueueRecentDubs: enqueued.dubs }));

import { queueRecentDubs, queueRecentWork } from '../src/lib/scheduler';
import { setAutoTranslate, setVfMode } from '../src/lib/settings';
import { freshDb } from './helpers/db';

describe('cron : traduction et analyse de fond selon le réglage « Traduction automatique »', () => {
  beforeEach(() => {
    freshDb();
    enqueued.commentaries.mockClear();
    enqueued.analyses.mockClear();
    enqueued.dubs.mockClear();
  });
  afterEach(() => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  });

  it('activée (défaut) : les replays récents sont mis en file', () => {
    expect(queueRecentWork({ commentaries: true, analyses: true })).toEqual({ commentaries: 2, analyses: 3 });
    expect(queueRecentWork({ analyses: true })).toEqual({ commentaries: 0, analyses: 3 });
    expect(enqueued.commentaries).toHaveBeenCalledTimes(1);
    expect(enqueued.analyses).toHaveBeenCalledTimes(2);
  });

  it('désactivée : rien n’est mis en file (jobs de 10 min comme après la recherche des vidéos)', () => {
    setAutoTranslate(false);
    expect(queueRecentWork({ commentaries: true, analyses: true })).toEqual({ commentaries: 0, analyses: 0 });
    expect(queueRecentWork({ commentaries: true })).toEqual({ commentaries: 0, analyses: 0 });
    expect(enqueued.commentaries).not.toHaveBeenCalled();
    expect(enqueued.analyses).not.toHaveBeenCalled();
  });

  it('hors de la fenêtre COMMENTARY_NIGHT_WINDOW : rien non plus', () => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    expect(queueRecentWork({ commentaries: true, analyses: true })).toEqual({ commentaries: 0, analyses: 0 });
    expect(enqueued.commentaries).not.toHaveBeenCalled();
  });
});

describe('cron : doublage de fond selon le réglage « Version française »', () => {
  beforeEach(() => {
    freshDb();
    enqueued.dubs.mockClear();
  });
  afterEach(() => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  });

  it('sous-titres (défaut) : aucun doublage de fond, la traduction continue', async () => {
    expect(await queueRecentDubs()).toBe(0);
    expect(enqueued.dubs).not.toHaveBeenCalled();
    expect(queueRecentWork({ commentaries: true })).toEqual({ commentaries: 2, analyses: 0 });
  });

  it('doublage : les replays traduits sont mis en file de doublage', async () => {
    setVfMode('doublage');
    expect(await queueRecentDubs()).toBe(4);
    expect(enqueued.dubs).toHaveBeenCalledTimes(1);
  });

  it('doublage mais traduction automatique désactivée, ou hors fenêtre : rien', async () => {
    setVfMode('doublage');
    setAutoTranslate(false);
    expect(await queueRecentDubs()).toBe(0);
    setAutoTranslate(true);
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    expect(await queueRecentDubs()).toBe(0);
    expect(enqueued.dubs).not.toHaveBeenCalled();
  });
});
