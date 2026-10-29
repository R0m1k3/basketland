import type { NextRequest } from 'next/server';
import { countMatches, listMatches, type MatchFilters } from '@/lib/db';
import { error, intParam, json } from '@/lib/api';
import { groupByParisDay, toDto } from '@/lib/present';
import { PARIS_TZ, parisDateKey, parisDayStartUtc } from '@/lib/time';
import type { MatchStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUSES = ['scheduled', 'live', 'final'];

/**
 * GET /api/matches?status=final&season=2026&team=LAL&date=2026-10-28&limit=50&offset=0
 * Sans filtre de statut/saison/date : matchs du jour (Paris) et à venir.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');
  if (status && !STATUSES.includes(status)) return error(400, `status invalide (${STATUSES.join('|')})`);
  const date = sp.get('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(400, 'date attendue au format YYYY-MM-DD (jour à Paris)');

  const f: MatchFilters = {
    league: sp.get('league') ?? 'nba',
    status: (status as MatchStatus) ?? undefined,
    season: sp.get('season') ? Number(sp.get('season')) : undefined,
    team: sp.get('team') ?? undefined,
    limit: intParam(sp.get('limit'), 50, 1, 500),
    offset: intParam(sp.get('offset'), 0, 0, 1_000_000),
    order: sp.get('order') === 'desc' ? 'desc' : 'asc',
  };
  if (sp.get('video') === '1') f.video = true;

  if (date) {
    f.from = parisDayStartUtc(date);
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    f.to = parisDayStartUtc(next);
  } else if (!status && !f.season && sp.get('all') !== '1') {
    // Par défaut : à partir du début de la journée en cours à Paris.
    f.from = parisDayStartUtc(parisDateKey(new Date()));
  }

  const rows = listMatches(f);
  const total = countMatches(f);
  const matches = rows.map(toDto);
  return json({
    timezone: PARIS_TZ,
    total,
    limit: f.limit,
    offset: f.offset,
    filters: { status: f.status ?? null, season: f.season ?? null, team: f.team ?? null, date: date ?? null, from: f.from ?? null },
    matches,
    groups: groupByParisDay(matches).map((g) => ({ date: g.date, label: g.label, ids: g.matches.map((m) => m.id) })),
  });
}
