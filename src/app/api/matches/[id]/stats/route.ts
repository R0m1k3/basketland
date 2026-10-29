import { getLeaders, getMatch, getPlayerStats, getTeamStats } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { ingestMatchDetails } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

/** Stats équipe + joueurs. `available: false` tant que le match n'est pas terminé. */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  let m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  if (m.status !== 'final') {
    return json({ available: false, status: m.status, reason: 'Statistiques disponibles à la fin du match' });
  }
  // Match terminé mais stats pas encore ingérées : on les récupère à la volée.
  if (!m.stats_synced_at) {
    try {
      await ingestMatchDetails(m);
      m = getMatch(id) ?? m;
    } catch (e) {
      return json({ available: false, status: m.status, reason: `Récupération ESPN impossible : ${(e as Error).message}` }, { status: 502 });
    }
  }
  const teams = getTeamStats(id);
  const players = getPlayerStats(id);
  if (!players.length) return json({ available: false, status: m.status, reason: 'Statistiques pas encore publiées' });
  const order = [m.away_abbr, m.home_abbr];
  return json({
    available: true,
    status: m.status,
    columns: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'],
    teams: order.map((abbr) => ({
      abbr,
      name: abbr === m!.home_abbr ? m!.home_name : m!.away_name,
      score: abbr === m!.home_abbr ? m!.home_score : m!.away_score,
      stats: teams.find((t) => t.team_abbr === abbr)?.stats ?? {},
      players: players
        .filter((p) => p.team_abbr === abbr)
        .map((p) => ({ id: p.player_id, name: p.player_name, position: p.position, jersey: p.jersey, starter: !!p.starter, stats: p.stats })),
    })),
    leaders: getLeaders(id),
  });
}
