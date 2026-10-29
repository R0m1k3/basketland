import Link from 'next/link';
import { MatchCard } from '@/components/MatchCard';
import { listMatches, listSeasons, listTeams } from '@/lib/db';
import { toDto } from '@/lib/present';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  all: 'Tous',
  scheduled: 'À venir',
  live: 'En direct',
  final: 'Terminés',
};

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const status = one('status') ?? 'all';
  const season = one('season');
  const team = one('team');
  const order = one('order') === 'desc' ? 'desc' : 'asc';

  const matches = listMatches({
    status: status === 'all' ? undefined : (status as 'scheduled' | 'live' | 'final'),
    season: season ? Number(season) : undefined,
    team,
    order,
    limit: 300,
  }).map(toDto);

  // Groupement par jour à Paris.
  const groups: Array<{ date: string; label: string; items: typeof matches }> = [];
  for (const m of matches) {
    const last = groups[groups.length - 1];
    if (!last || last.date !== m.day_paris) {
      groups.push({ date: m.day_paris, label: m.date_paris, items: [m] });
    } else {
      last.items.push(m);
    }
  }

  const teams = listTeams();
  const seasons = listSeasons();

  const qs = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      status,
      season,
      team,
      order,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    const s = params.toString();
    return s ? `/matchs?${s}` : '/matchs';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Matchs</h1>
        <Link
          href={qs({ order: order === 'desc' ? 'asc' : 'desc' })}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
        >
          {order === 'asc' ? 'Du plus ancien au plus récent' : 'Du plus récent au plus ancien'}
        </Link>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-[#111621] p-4">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Statut
          <select
            name="status"
            defaultValue={status}
            className="rounded-lg border border-slate-700 bg-[#0d1119] px-3 py-2 text-sm text-slate-200"
          >
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Équipe
          <select
            name="team"
            defaultValue={team ?? ''}
            className="rounded-lg border border-slate-700 bg-[#0d1119] px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Toutes</option>
            {teams.map((t) => (
              <option key={t.abbr} value={t.abbr}>
                {t.abbr}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Saison
          <select
            name="season"
            defaultValue={season ?? ''}
            className="rounded-lg border border-slate-700 bg-[#0d1119] px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Toutes</option>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <input type="hidden" name="order" value={order} />
        <button
          type="submit"
          className="rounded-lg bg-court-500 px-4 py-2 text-sm font-medium text-white hover:bg-court-600"
        >
          Filtrer
        </button>
      </form>

      {matches.length === 0 ? (
        <p className="text-sm text-slate-500">Aucun match ne correspond à ces filtres.</p>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.date}>
              <h2 className="mb-3 border-b border-slate-800 pb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {g.label}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((m) => (
                  <MatchCard key={m.id} match={m} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
