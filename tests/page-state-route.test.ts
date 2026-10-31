import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

/**
 * POST /api/internal/page-state : appelé par le serveur Rust, qui calcule les
 * données des pages (étape 8a) alors que les files de traduction et de
 * doublage tournent encore côté Node. Jeton d'ingestion exigé ; renvoie le
 * match en cours de traduction, l'activité, les raisons de désactivation.
 */
const st = vi.hoisted(() => ({
  running: vi.fn((): number | null => 401),
  disabled: vi.fn((): string | null => null),
  dub: vi.fn(async (): Promise<string | null> => 'doublage désactivé (DUB_DISABLED=1)'),
  activity: vi.fn(() => ({ tasks: [], queued: [], watching: true })),
}));
vi.mock('../src/lib/commentary', async (orig) => ({
  ...(await orig<typeof import('../src/lib/commentary')>()),
  commentaryRunningMatchId: st.running,
  commentaryDisabledReason: st.disabled,
}));
vi.mock('../src/lib/dub', async (orig) => ({
  ...(await orig<typeof import('../src/lib/dub')>()),
  dubDisabledReason: st.dub,
}));
vi.mock('../src/lib/activity', () => ({ currentActivity: st.activity }));

import { POST } from '../src/api-routes/internal/page-state/route';
import { isPublicPath } from '../src/lib/authRoutes';
import { setDbForTests } from '../src/lib/db';
import { freshDb } from './helpers/db';

const TOKEN = 'jeton-interne-test';

function call(body: unknown, auth: string | null = `Bearer ${TOKEN}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return POST(
    new Request('http://127.0.0.1:3013/api/internal/page-state', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/internal/page-state', () => {
  beforeEach(() => {
    freshDb();
    process.env.INGEST_TOKEN = TOKEN;
    for (const f of Object.values(st)) f.mockClear();
  });
  afterEach(() => {
    delete process.env.INGEST_TOKEN;
  });
  afterAll(() => setDbForTests(undefined));

  it('jeton d’ingestion exigé (le chemin est public pour le middleware)', async () => {
    expect(isPublicPath('/api/internal/page-state')).toBe(true);
    expect((await call({}, null)).status).toBe(401);
    expect((await call({}, 'Bearer faux')).status).toBe(401);
    expect(st.activity).not.toHaveBeenCalled();
  });

  it('état des files, sans le doublage par défaut', async () => {
    const r = await call({});
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe(
      '{"running_match_id":401,"activity":{"tasks":[],"queued":[],"watching":true},"commentary_disabled_reason":null,"dub_disabled_reason":null}',
    );
    expect(st.dub).not.toHaveBeenCalled();
  });

  it('{ dub: true } : raison de désactivation du doublage en plus', async () => {
    st.running.mockReturnValueOnce(null);
    st.disabled.mockReturnValueOnce('ffmpeg absent du serveur');
    const r = await call({ dub: true });
    expect(await r.json()).toEqual({
      running_match_id: null,
      activity: { tasks: [], queued: [], watching: true },
      commentary_disabled_reason: 'ffmpeg absent du serveur',
      dub_disabled_reason: 'doublage désactivé (DUB_DISABLED=1)',
    });
    expect(st.dub).toHaveBeenCalledTimes(1);
  });

  it('corps illisible ou `dub` non booléen : sans le doublage', async () => {
    expect((await (await call('pas du json')).json()).dub_disabled_reason).toBeNull();
    expect((await (await call({ dub: 'oui' })).json()).dub_disabled_reason).toBeNull();
    expect(st.dub).not.toHaveBeenCalled();
  });
});
