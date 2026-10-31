import { fetchStandings } from '@/lib/espn';
import { kvGet, kvSet } from '@/lib/db';
import { json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  const key = 'standings:nba';
  let data = kvGet<Awaited<ReturnType<typeof fetchStandings>>>(key, 30 * 60_000);
  if (!data) {
    try {
      data = await fetchStandings('nba');
      kvSet(key, data);
    } catch (e) {
      data = kvGet(key, Infinity);
      if (!data) return json({ error: (e as Error).message }, { status: 502 });
    }
  }
  return json({ conferences: data });
}
