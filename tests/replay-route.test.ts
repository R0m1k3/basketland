import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ReplayLookup } from '../src/lib/bv';

const findReplay = vi.fn<(m: unknown, o?: { fresh?: boolean }) => Promise<ReplayLookup>>();
vi.mock('../src/lib/bv', () => ({ findReplay: (m: unknown, o?: { fresh?: boolean }) => findReplay(m, o) }));
const prioritizeOnView = vi.fn<(id: number) => void>();
vi.mock('../src/lib/commentary', async (orig) => ({
  ...(await orig<typeof import('../src/lib/commentary')>()),
  prioritizeOnView: (id: number) => prioritizeOnView(id),
}));

import * as db from '../src/lib/db';
import { POST } from '../src/api-routes/matches/[id]/replay/route';
import { searchReplay } from '../src/lib/ingest';
import { __resetReplayChecksForTests, requestReplayCheck } from '../src/lib/replayCheck';
import { freshDb, insertMatch } from './helpers/db';

/**
 * POST /api/matches/[id]/replay { action: 'check' } : recherche à la demande
 * (garde-fous d'écriture, délai de 2 min par match, match terminé seulement,
 * enregistrement comme le job, traduction mise en file si replay trouvé).
 */

const ID = 401909900;
const ctx = (id = ID) => ({ params: Promise.resolve({ id: String(id) }) });

function post(body: unknown, headers: Record<string, string> = {}, id = ID) {
  return POST(
    new Request(`http://nas.local:3012/api/matches/${id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://nas.local:3012', host: 'nas.local:3012', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx(id),
  );
}

const kind = (id = ID) => (db.getMatch(id) as unknown as { video_kind: string | null }).video_kind;
const FOUND: ReplayLookup = { slug: 's', okId: '777777', duration: 8033, available: true, kind: 'hls' };
const NOT_LISTED: ReplayLookup = { slug: null, okId: null, duration: null, available: false, kind: null, reason: 'replay non listé' };

beforeEach(() => {
  freshDb();
  // Match terminé il y a peu, sans replay, jamais vérifié.
  insertMatch(ID, { okId: null, date_utc: new Date(Date.now() - 3 * 3600_000).toISOString() });
  findReplay.mockReset();
  prioritizeOnView.mockReset();
  __resetReplayChecksForTests();
  delete process.env.SYNC_WRITE_ORIGINS;
});
afterAll(() => db.setDbForTests(undefined));

describe('POST /api/matches/[id]/replay — garde-fous', () => {
  it('403 pour une origine tierce, sans recherche', async () => {
    expect((await post({ action: 'check' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(findReplay).not.toHaveBeenCalled();
  });

  it('415 sans Content-Type JSON', async () => {
    expect((await post({ action: 'check' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ action: 'check' }, { 'content-type': 'text/plain;charset=application/json' })).status).toBe(415);
    expect(findReplay).not.toHaveBeenCalled();
  });

  it('400 pour une action inconnue ou un JSON invalide, 404 pour un match inconnu', async () => {
    expect((await post({ action: 'start' })).status).toBe(400);
    expect((await post('{')).status).toBe(400);
    expect((await post({ action: 'check' }, {}, 999)).status).toBe(404);
  });

  it('409 pour un match pas encore terminé', async () => {
    db.getDb().prepare("UPDATE matches SET status = 'live' WHERE id = $id").run({ id: ID });
    const r = await post({ action: 'check' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ checked: false, video: { available: false } });
    expect(findReplay).not.toHaveBeenCalled();
  });

  it('replay déjà en HLS : rien à chercher', async () => {
    db.setVideo(ID, { slug: 's', okId: '555555', duration: 8000, available: true, kind: 'hls' });
    const r = await post({ action: 'check' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ checked: false, video: { available: true, kind: 'hls' } });
    expect(findReplay).not.toHaveBeenCalled();
  });
});

describe('POST /api/matches/[id]/replay — recherche', () => {
  it('replay trouvé : enregistré comme le job (setVideo, video_kind), traduction mise en file', async () => {
    findReplay.mockResolvedValue(FOUND);
    const r = await post({ action: 'check' });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ checked: true, message: 'Replay trouvé !' });
    expect(d.video).toMatchObject({ available: true, ok_id: '777777', kind: 'hls', src: '/api/video/777777/master.m3u8' });
    expect(d.video.checked_at).not.toBeNull();
    const m = db.getMatch(ID)!;
    expect(m.video_available).toBe(1);
    expect(m.video_ok_id).toBe('777777');
    expect(kind()).toBe('hls');
    expect(prioritizeOnView).toHaveBeenCalledWith(ID);
    // Recherche à la demande : relecture forcée de la 1re page de liste.
    expect(findReplay.mock.calls[0][1]).toEqual({ fresh: true });
  });

  it('pas encore de replay : match marqué vérifié, message lisible, pas de mise en file', async () => {
    findReplay.mockResolvedValue(NOT_LISTED);
    const d = await (await post({ action: 'check' })).json();
    expect(d).toMatchObject({ checked: true, video: { available: false } });
    expect(d.message).toBe('Pas encore de replay : pas encore publié sur le site des replays.');
    expect(db.getMatch(ID)!.video_checked_at).not.toBeNull();
    expect(prioritizeOnView).not.toHaveBeenCalled();
  });

  it('MP4 seul : revérifié, passe en HLS', async () => {
    db.setVideo(ID, { slug: 's', okId: '777777', duration: 8033, available: true, kind: 'mp4' });
    db.getDb().prepare('UPDATE matches SET video_checked_at = NULL WHERE id = $id').run({ id: ID });
    findReplay.mockResolvedValue(FOUND);
    const d = await (await post({ action: 'check' })).json();
    expect(d).toMatchObject({ checked: true, video: { kind: 'hls' } });
    expect(kind()).toBe('hls');
  });

  it('une recherche en échec ne rétrograde pas un replay MP4', async () => {
    db.setVideo(ID, { slug: 's', okId: '777777', duration: 8033, available: true, kind: 'mp4' });
    db.getDb().prepare('UPDATE matches SET video_checked_at = NULL WHERE id = $id').run({ id: ID });
    findReplay.mockResolvedValue(NOT_LISTED);
    const d = await (await post({ action: 'check' })).json();
    expect(d.video).toMatchObject({ available: true, kind: 'mp4' });
    expect(kind()).toBe('mp4');
  });
});

describe('POST /api/matches/[id]/replay — une recherche toutes les 2 min par match', () => {
  it('2e demande immédiate : 429 avec Retry-After, sans nouvelle recherche', async () => {
    findReplay.mockResolvedValue(NOT_LISTED);
    expect((await post({ action: 'check' })).status).toBe(200);
    const r = await post({ action: 'check' });
    expect(r.status).toBe(429);
    const d = await r.json();
    expect(d.checked).toBe(false);
    expect(d.retry_after).toBeGreaterThan(100);
    expect(d.retry_after).toBeLessThanOrEqual(120);
    expect(r.headers.get('retry-after')).toBe(String(d.retry_after));
    expect(findReplay).toHaveBeenCalledTimes(1);
  });

  it('le job vient de vérifier ce match (video_checked_at il y a 1 min) : 429', async () => {
    db.getDb()
      .prepare('UPDATE matches SET video_checked_at = $t WHERE id = $id')
      .run({ id: ID, t: new Date(Date.now() - 60_000).toISOString() });
    expect((await post({ action: 'check' })).status).toBe(429);
    expect(findReplay).not.toHaveBeenCalled();
  });

  it('dernière recherche il y a plus de 2 min : acceptée', async () => {
    db.getDb()
      .prepare('UPDATE matches SET video_checked_at = $t WHERE id = $id')
      .run({ id: ID, t: new Date(Date.now() - 3 * 60_000).toISOString() });
    findReplay.mockResolvedValue(NOT_LISTED);
    expect((await post({ action: 'check' })).status).toBe(200);
    expect(findReplay).toHaveBeenCalledTimes(1);
  });

  it('le délai est propre à chaque match', async () => {
    const OTHER = ID + 1;
    insertMatch(OTHER, { okId: null });
    findReplay.mockResolvedValue(NOT_LISTED);
    expect((await post({ action: 'check' })).status).toBe(200);
    expect((await post({ action: 'check' }, {}, OTHER)).status).toBe(200);
    expect(findReplay).toHaveBeenCalledTimes(2);
  });
});

describe('recherche à la demande et job : jamais deux recherches du même match en parallèle', () => {
  it('une demande pendant la recherche du job la rejoint (un seul findReplay)', async () => {
    let resolve!: (r: ReplayLookup) => void;
    findReplay.mockImplementation(() => new Promise((r) => (resolve = r)));
    const job = searchReplay(db.getMatch(ID)!);
    const req = post({ action: 'check' });
    await new Promise((r) => setTimeout(r, 10));
    resolve(FOUND);
    const [jr, rr] = await Promise.all([job, req]);
    expect(findReplay).toHaveBeenCalledTimes(1);
    expect(jr.available).toBe(true);
    expect((await rr.json()).video.available).toBe(true);
  });

  it('recherche trop longue : 202 pending, le résultat est enregistré ensuite', async () => {
    let resolve!: (r: ReplayLookup) => void;
    findReplay.mockImplementation(() => new Promise((r) => (resolve = r)));
    const r = await requestReplayCheck(db.getMatch(ID)!, { waitMs: 5 });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ checked: true, pending: true, video: { available: false } });
    resolve(FOUND);
    await vi.waitFor(() => expect(prioritizeOnView).toHaveBeenCalledWith(ID));
    expect(db.getMatch(ID)!.video_ok_id).toBe('777777');
  });
});
