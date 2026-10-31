import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const enqueued = vi.hoisted(() => ({ commentaries: vi.fn(() => 2), analyses: vi.fn(() => 3) }));
vi.mock('../src/lib/commentary', async (orig) => ({ ...(await orig<typeof import('../src/lib/commentary')>()), enqueueRecentCommentaries: enqueued.commentaries }));
vi.mock('../src/lib/analysis', async (orig) => ({ ...(await orig<typeof import('../src/lib/analysis')>()), enqueueRecentAnalyses: enqueued.analyses }));

import { queueRecentWork } from '../src/lib/scheduler';
import { setAutoTranslate } from '../src/lib/settings';
import { freshDb } from './helpers/db';

describe('cron : traduction et analyse de fond selon le réglage « Traduction automatique »', () => {
  beforeEach(() => {
    freshDb();
    enqueued.commentaries.mockClear();
    enqueued.analyses.mockClear();
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
