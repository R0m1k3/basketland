import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { GET, POST } from '../src/app/api/matches/[id]/sync/route';
import { __setAnalysisRunnerForTests } from '../src/lib/analysis';
import { fixturePlays, freshDb, insertMatch } from './helpers/db';

const ID = 401909880;
const ctx = { params: Promise.resolve({ id: String(ID) }) };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`http://nas.local:3012/api/matches/${ID}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://nas.local:3012', host: 'nas.local:3012', ...headers },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

describe('API /api/matches/[id]/sync', () => {
  beforeEach(() => {
    freshDb();
    insertMatch(ID, { duration: 8033 });
    db.replacePlays(ID, fixturePlays(ID));
    __setAnalysisRunnerForTests(() => new Promise(() => {})); // analyse « en cours » indéfiniment
    delete process.env.SYNC_WRITE_ORIGINS;
  });
  afterEach(() => __setAnalysisRunnerForTests(null));

  it('GET expose le statut d’analyse', async () => {
    const r = await GET(new Request(`http://nas.local:3012/api/matches/${ID}/sync`), ctx);
    const d = await r.json();
    expect(d.analysis).toEqual({ status: 'none', anchors_auto: 0 });
    expect(d.audio.status).toBe('none');
  });

  describe("action « clock »", () => {
    it('crée une ancre manuelle (période, chrono lus à l’écran) à la position vidéo', async () => {
      const r = await post({ action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 });
      expect(r.status).toBe(200);
      const d = await r.json();
      expect(d.message).toBe('ancre posée (2e période, 1:24)');
      expect(d.subtitles).toBeGreaterThan(0);
      const a = d.anchors.find((x: { method: string }) => x.method === 'manual');
      expect(a).toMatchObject({ period: 2, clock_sec: 84, video_ts: 3600 });
      // Wallclock résolu depuis le play-by-play (première action à 1:24 du 2e quart).
      const play = fixturePlays(ID).find((p) => p.period === 2 && p.clock_sec === 84)!;
      expect(a.wallclock).toBe(new Date(Date.parse(play.wallclock)).toISOString());
    });

    it('retire les offsets global et de quart avant stockage (même convention que « anchor »)', async () => {
      db.saveSyncSettings(ID, 5, { '2': 2 });
      await post({ action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 });
      expect(db.getAnchors(ID).find((a) => a.method === 'manual')?.video_ts).toBe(3593);
    });

    it('arrondit les dixièmes de la dernière minute', async () => {
      const d = await (await post({ action: 'clock', video_ts: 7000, period: 4, clock_sec: 42.8 })).json();
      expect(d.message).toBe('ancre posée (4e période, 0:43)');
      expect(db.getAnchors(ID)[0].clock_sec).toBe(43);
    });

    it.each([
      [{ video_ts: 3600, period: 2.5, clock_sec: 84 }, 400],
      [{ video_ts: 3600, period: 0, clock_sec: 84 }, 400],
      [{ video_ts: 3600, period: 11, clock_sec: 84 }, 400],
      [{ video_ts: 3600, period: '2', clock_sec: 84 }, 400],
      [{ video_ts: 3600, period: 2, clock_sec: 721 }, 400],
      [{ video_ts: 3600, period: 2, clock_sec: -1 }, 400],
      [{ video_ts: -1, period: 2, clock_sec: 84 }, 400],
      [{ video_ts: 99999, period: 2, clock_sec: 84 }, 400],
      [{ period: 2, clock_sec: 84 }, 400],
      [{ video_ts: 100, period: 5, clock_sec: 301 }, 400],
      [{ video_ts: 100, period: 6, clock_sec: 200 }, 422],
    ])('valide strictement %j → %i', async (body, status) => {
      const r = await post({ action: 'clock', ...body });
      expect(r.status).toBe(status);
      expect(db.getAnchors(ID)).toHaveLength(0);
    });

    it('refuse une origine étrangère et un Content-Type non JSON', async () => {
      expect((await post({ action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 }, { 'content-type': 'text/plain' })).status).toBe(415);
      expect(db.getAnchors(ID)).toHaveLength(0);
    });

    it('409 si le play-by-play manque', async () => {
      db.replacePlays(ID, []);
      expect((await post({ action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 })).status).toBe(409);
    });
  });

  describe("action « analyze »", () => {
    it('lance l’analyse (tête de file) et renvoie un message lisible', async () => {
      const r = await post({ action: 'analyze' });
      expect(r.status).toBe(202);
      const d = await r.json();
      expect(d).toMatchObject({ started: true, queued: true, message: 'Analyse lancée' });
      expect(d.analysis.status).toBe('running');
      const again = await (await post({ action: 'analyze' })).json();
      expect(again).toMatchObject({ started: false, queued: false, message: 'Analyse déjà en cours' });
    });

    it('met en file derrière une analyse en cours avec sa position', async () => {
      insertMatch(1);
      const { enqueueAnalysis } = await import('../src/lib/analysis');
      enqueueAnalysis(1);
      const d = await (await post({ action: 'analyze' })).json();
      expect(d).toMatchObject({ started: false, queued: true, position: 1, message: 'Analyse en file (position 1)' });
      expect(d.analysis).toEqual({ status: 'queued', position: 1 });
    });
  });
});
