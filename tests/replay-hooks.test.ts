import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

/**
 * POST /api/internal/replays : appelé par le serveur Rust (recherche des
 * replays, étape 5b) pour les files restées côté Node. Jeton d'ingestion
 * exigé ; `{}` → traductions et analyses des replays récents (comme le cron
 * de Node après `syncVideos`), `{ match_id }` → traduction du match en tête
 * de file (comme une recherche à la demande qui trouve le replay).
 */
const queued = vi.hoisted(() => ({
  commentaries: vi.fn(() => 2),
  analyses: vi.fn(() => 1),
  prioritize: vi.fn((_id: number) => undefined),
}));
vi.mock('../src/lib/commentary', async (orig) => ({
  ...(await orig<typeof import('../src/lib/commentary')>()),
  enqueueRecentCommentaries: queued.commentaries,
  prioritizeOnView: queued.prioritize,
}));
vi.mock('../src/lib/analysis', async (orig) => ({
  ...(await orig<typeof import('../src/lib/analysis')>()),
  enqueueRecentAnalyses: queued.analyses,
}));

import { POST } from '../src/api-routes/internal/replays/route';
import { isPublicPath } from '../src/lib/authRoutes';
import { setDbForTests } from '../src/lib/db';
import { setAutoTranslate } from '../src/lib/settings';
import { freshDb } from './helpers/db';

const TOKEN = 'jeton-interne-test';

function call(body: unknown, auth: string | null = `Bearer ${TOKEN}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return POST(new Request('http://127.0.0.1:3013/api/internal/replays', { method: 'POST', headers, body: JSON.stringify(body) }));
}

describe('POST /api/internal/replays', () => {
  beforeEach(() => {
    freshDb();
    process.env.INGEST_TOKEN = TOKEN;
    for (const f of Object.values(queued)) f.mockClear();
  });
  afterEach(() => {
    delete process.env.INGEST_TOKEN;
    vi.restoreAllMocks();
  });
  afterAll(() => setDbForTests(undefined));

  it('jeton d’ingestion exigé (le chemin est public pour le middleware)', async () => {
    expect(isPublicPath('/api/internal/replays')).toBe(true);
    expect(isPublicPath('/api/internal/autre')).toBe(false);
    expect((await call({}, null)).status).toBe(401);
    expect((await call({}, 'Bearer faux')).status).toBe(401);
    expect(queued.commentaries).not.toHaveBeenCalled();
    expect(queued.prioritize).not.toHaveBeenCalled();
  });

  it('{} : traductions et analyses mises en file, même ligne de log que le cron', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await call({});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, commentaries: 2, analyses: 1 });
    expect(queued.commentaries).toHaveBeenCalledTimes(1);
    expect(queued.analyses).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[cron] nouveaux replays : 2 traduction(s), 1 analyse(s) mise(s) en file');
  });

  it('traduction automatique désactivée : rien en file', async () => {
    setAutoTranslate(false);
    expect(await (await call({})).json()).toEqual({ ok: true, commentaries: 0, analyses: 0 });
    expect(await (await call({ match_id: 401 })).json()).toEqual({ ok: true, prioritized: false });
    expect(queued.commentaries).not.toHaveBeenCalled();
    expect(queued.prioritize).not.toHaveBeenCalled();
  });

  it('{ match_id } : traduction de ce match en tête de file', async () => {
    const r = await call({ match_id: 401909900 });
    expect(await r.json()).toEqual({ ok: true, prioritized: true });
    expect(queued.prioritize).toHaveBeenCalledWith(401909900);
    expect(queued.commentaries).not.toHaveBeenCalled();
  });

  it('match_id invalide : 400', async () => {
    for (const id of ['abc', -3, 1.5, 0]) expect((await call({ match_id: id })).status).toBe(400);
    expect(queued.prioritize).not.toHaveBeenCalled();
  });

  it('erreur de mise en file : journalisée, sans 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    queued.prioritize.mockImplementationOnce(() => {
      throw new Error('panne');
    });
    expect(await (await call({ match_id: 7 })).json()).toEqual({ ok: true, prioritized: false });
    expect(err).toHaveBeenCalledWith('[replay] mise en file de la traduction impossible :', 'panne');
  });
});
