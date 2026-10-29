import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ReplayLookup } from '../src/lib/bv';

const findReplay = vi.fn<() => Promise<ReplayLookup>>();
vi.mock('../src/lib/bv', () => ({ findReplay: () => findReplay() }));

import { getMatch, openDatabase, setDbForTests } from '../src/lib/db';
import { syncVideos } from '../src/lib/ingest';

/**
 * syncVideos : un replay MP4 est revérifié pour passer en HLS, mais n'est
 * jamais rétrogradé par une recherche qui échoue.
 */

function insertMp4Match(): number {
  const db = openDatabase(':memory:');
  setDbForTests(db);
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO matches (espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status,
         slug, video_ok_id, video_duration, video_available, video_kind, created_at, updated_at)
       VALUES ('401', 2026, 'regular', $d, 'LAC', 'LA Clippers', 'LAL', 'Los Angeles Lakers', 'final',
         's', '111111', 6016, 1, 'mp4', $now, $now)`,
    )
    .run({ d: new Date(Date.now() - 86400_000).toISOString(), now });
  return Number(r.lastInsertRowid);
}

const kind = (id: number) => (getMatch(id) as unknown as { video_kind: string | null }).video_kind;

beforeEach(() => findReplay.mockReset());
afterAll(() => setDbForTests(undefined));

describe('syncVideos', () => {
  it('MP4 → HLS quand ok.ru a fini le traitement', async () => {
    const id = insertMp4Match();
    findReplay.mockResolvedValue({ slug: 's', okId: '111111', duration: 6016, available: true, kind: 'hls' });
    const r = await syncVideos();
    expect(r.ok).toBe(true);
    expect(kind(id)).toBe('hls');
    expect(getMatch(id)?.video_available).toBe(1);
  });

  it('une recherche en échec ne rétrograde pas un replay MP4 existant', async () => {
    const id = insertMp4Match();
    findReplay.mockResolvedValue({ slug: 's', okId: null, duration: null, available: false, kind: null, reason: 'iframe ok.ru introuvable' });
    await syncVideos();
    const m = getMatch(id)!;
    expect(m.video_available).toBe(1);
    expect(m.video_ok_id).toBe('111111');
    expect(kind(id)).toBe('mp4');
    expect(m.video_checked_at).not.toBeNull(); // revérifié dans 2 h, pas avant
  });

  it('un match sans replay trouvé en MP4 devient disponible (kind mp4)', async () => {
    const id = insertMp4Match();
    const db = (await import('../src/lib/db')).getDb();
    db.prepare('UPDATE matches SET video_available = 0, video_kind = NULL, video_ok_id = NULL WHERE id = $id').run({ id });
    findReplay.mockResolvedValue({ slug: 's', okId: '222222', duration: 6016, available: true, kind: 'mp4' });
    await syncVideos();
    expect(getMatch(id)?.video_ok_id).toBe('222222');
    expect(kind(id)).toBe('mp4');
  });
});
