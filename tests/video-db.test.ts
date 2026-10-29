import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { finalMatchesNeedingVideo, getMatch, openDatabase, setDbForTests, setVideo } from '../src/lib/db';
import { toDto } from '../src/lib/present';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Colonne video_kind : migration idempotente, setVideo, reprise des replays
 * MP4 (pour passer en HLS) et bloc `video` du DTO.
 */

let db: DatabaseSync;

function insert(espn: string, extra: Partial<Record<string, string | number | null>> = {}): number {
  const now = new Date().toISOString();
  const row = {
    espn_id: espn,
    season: 2026,
    season_type: 'regular',
    date_utc: new Date(Date.now() - 86400_000).toISOString(),
    home_abbr: 'LAC',
    home_name: 'LA Clippers',
    away_abbr: 'LAL',
    away_name: 'Los Angeles Lakers',
    status: 'final',
    created_at: now,
    updated_at: now,
    ...extra,
  };
  const cols = Object.keys(row);
  const r = db
    .prepare(`INSERT INTO matches (${cols.join(',')}) VALUES (${cols.map((c) => `$${c}`).join(',')})`)
    .run(row as Record<string, string | number | null>);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  setDbForTests(db);
});

afterAll(() => setDbForTests(undefined));

describe('migration video_kind', () => {
  it('ajoute la colonne à une base existante, et la ré-ouverture ne lève pas', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-mig-'));
    const file = path.join(dir, 'a.db');
    // Base « ancienne » : table matches sans video_kind.
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(
      `CREATE TABLE matches (id INTEGER PRIMARY KEY, espn_id TEXT UNIQUE NOT NULL, league TEXT NOT NULL DEFAULT 'nba',
        season INTEGER NOT NULL, season_type TEXT NOT NULL, date_utc TEXT NOT NULL, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL,
        away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, home_score INTEGER, away_score INTEGER, status TEXT NOT NULL,
        status_detail TEXT DEFAULT '', period INTEGER DEFAULT 0, clock_display TEXT DEFAULT '', venue TEXT DEFAULT '',
        broadcast TEXT DEFAULT '', slug TEXT, video_ok_id TEXT, video_duration INTEGER, video_available INTEGER DEFAULT 0,
        video_checked_at TEXT, stats_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    old.close();
    const a = openDatabase(file);
    expect((a.prepare('PRAGMA table_info(matches)').all() as { name: string }[]).some((c) => c.name === 'video_kind')).toBe(true);
    a.close();
    const b = openDatabase(file); // seconde ouverture : pas de « duplicate column »
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('setVideo / finalMatchesNeedingVideo', () => {
  const since = () => new Date(Date.now() - 21 * 86400_000).toISOString();
  const recheck = () => new Date(Date.now() - 2 * 3600_000).toISOString();

  it('enregistre le type, et le remet à NULL sans replay', () => {
    const id = insert('1');
    setVideo(id, { slug: 's', okId: '16668708768428', duration: 6016, available: true, kind: 'mp4' });
    expect((getMatch(id) as unknown as { video_kind: string }).video_kind).toBe('mp4');
    setVideo(id, { slug: 's', okId: '16668708768428', duration: 6016, available: false, kind: 'mp4' });
    expect((getMatch(id) as unknown as { video_kind: string | null }).video_kind).toBeNull();
  });

  it('reprend les replays MP4 (pas les HLS), avec la même cadence de 2 h', () => {
    const none = insert('1');
    const mp4 = insert('2', { video_ok_id: '111111', video_available: 1, video_kind: 'mp4' });
    insert('3', { video_ok_id: '222222', video_available: 1, video_kind: 'hls' });
    insert('4', { video_ok_id: '333333', video_available: 1, video_kind: null }); // ancien : HLS implicite
    const mp4Recent = insert('5', { video_ok_id: '444444', video_available: 1, video_kind: 'mp4', video_checked_at: new Date().toISOString() });
    const ids = finalMatchesNeedingVideo(since(), recheck()).map((m) => m.id);
    expect(ids.sort()).toEqual([none, mp4].sort());
    expect(ids).not.toContain(mp4Recent);
  });
});

describe('toDto — bloc video', () => {
  it('HLS', () => {
    const id = insert('1', { video_ok_id: '222222', video_available: 1, video_kind: 'hls', video_duration: 8033 });
    expect(toDto(getMatch(id)!).video).toEqual({
      available: true,
      ok_id: '222222',
      duration: 8033,
      kind: 'hls',
      src: '/api/video/222222/master.m3u8',
      master: '/api/video/222222/master.m3u8',
      checked_at: null,
    });
  });

  it('MP4 : src vers file.mp4, master null', () => {
    const id = insert('1', { video_ok_id: '111111', video_available: 1, video_kind: 'mp4', video_duration: 6016 });
    const v = toDto(getMatch(id)!).video;
    expect(v.kind).toBe('mp4');
    expect(v.src).toBe('/api/video/111111/file.mp4');
    expect(v.master).toBeNull();
  });

  it('ligne antérieure (video_kind NULL) mais disponible : HLS', () => {
    const id = insert('1', { video_ok_id: '333333', video_available: 1 });
    const v = toDto(getMatch(id)!).video;
    expect(v.kind).toBe('hls');
    expect(v.src).toBe('/api/video/333333/master.m3u8');
  });

  it('indisponible : kind, src et master null', () => {
    const id = insert('1', { video_ok_id: '333333', video_available: 0, video_kind: 'mp4' });
    expect(toDto(getMatch(id)!).video).toMatchObject({ available: false, kind: null, src: null, master: null });
  });
});
