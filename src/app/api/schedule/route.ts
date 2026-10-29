import type { NextRequest } from 'next/server';
import { listMatches } from '@/lib/db';
import { intParam, json } from '@/lib/api';
import { groupByParisDay, toDto } from '@/lib/present';
import { addDays, PARIS_TZ, parisDateKey, parisDayStartUtc } from '@/lib/time';

export const dynamic = 'force-dynamic';

/** Calendrier : matchs récents + à venir, groupés par date Europe/Paris. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const back = intParam(sp.get('days_back'), 3, 0, 60);
  const ahead = intParam(sp.get('days_ahead'), 7, 0, 60);
  const team = sp.get('team') ?? undefined;
  const today = parisDateKey(new Date());
  const from = parisDayStartUtc(parisDateKey(addDays(new Date(`${today}T12:00:00Z`), -back)));
  const to = parisDayStartUtc(parisDateKey(addDays(new Date(`${today}T12:00:00Z`), ahead + 1)));
  const matches = listMatches({ from, to, team, limit: 1000 }).map(toDto);
  return json({
    timezone: PARIS_TZ,
    today,
    from,
    to,
    days: groupByParisDay(matches).map((g) => ({ date: g.date, label: g.label, is_today: g.date === today, matches: g.matches })),
  });
}
