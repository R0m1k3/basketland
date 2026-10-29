/** Base SQLite en mémoire pour les tests (schéma réel). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as db from '../../src/lib/db';
import { parseSummary } from '../../src/lib/espn';
import type { ParsedMatch } from '../../src/lib/types';

export function freshDb(): void {
  db.setDbForTests(db.openDatabase(':memory:'));
}

export function insertMatch(id: number, o: Partial<ParsedMatch> & { okId?: string | null; duration?: number | null } = {}): void {
  const { okId = `1665649${String(id).slice(-7)}`, duration = 7480, ...rest } = o;
  db.upsertMatch({
    id,
    espn_id: String(id),
    league: 'nba',
    season: 2026,
    season_type: 'regular',
    date_utc: new Date(Date.now() - 24 * 3600_000).toISOString(),
    home_abbr: 'LAL',
    home_name: 'Los Angeles Lakers',
    away_abbr: 'POR',
    away_name: 'Portland Trail Blazers',
    home_score: 110,
    away_score: 102,
    status: 'final',
    status_detail: 'Final',
    period: 4,
    clock_display: '0.0',
    venue: '',
    broadcast: 'NBC',
    ...rest,
  } as ParsedMatch);
  if (okId) db.setVideo(id, { slug: null, okId, duration, available: true });
}

/** Play-by-play réel de la fixture ESPN (POR @ LAL), rattaché au match `id`. */
export function fixturePlays(id: number) {
  const s = parseSummary(
    JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'espn-summary-401909880.json'), 'utf8')) as Record<string, unknown>,
    id,
  );
  return s.plays.map((p) => ({ ...p, match_id: id }));
}
