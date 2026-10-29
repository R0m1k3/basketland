import { fetchStandings } from '@/lib/espn';
import { kvGet, kvSet } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function StandingsPage() {
  const key = 'standings:nba';
  let data = kvGet<Awaited<ReturnType<typeof fetchStandings>>>(key, 30 * 60_000);
  if (!data) {
    try {
      data = await fetchStandings('nba');
      kvSet(key, data);
    } catch {
      data = kvGet(key, Infinity);
    }
  }

  const conferences = data ?? [];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-white">Classement NBA</h1>

      {conferences.length === 0 ? (
        <p className="text-sm text-slate-500">
          Le classement n’est pas encore récupéré. Une synchronisation le remplira.
        </p>
      ) : (
        conferences.map((conf) => (
          <section key={conf.conference}>
            <h2 className="mb-3 text-lg font-semibold text-white">{conf.conference}</h2>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#111621] text-xs text-slate-400">
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Équipe</th>
                    <th className="px-2 py-2 text-right font-medium">V</th>
                    <th className="px-2 py-2 text-right font-medium">D</th>
                    <th className="px-2 py-2 text-right font-medium">%</th>
                    <th className="px-2 py-2 text-right font-medium">Dif.</th>
                  </tr>
                </thead>
                <tbody>
                  {conf.rows.map((r, i) => (
                    <tr key={r.abbr || i} className="border-b border-slate-900/60 last:border-0">
                      <td className="px-3 py-1.5 tabular-nums text-slate-500">{r.seed || i + 1}</td>
                      <td className="px-3 py-1.5 text-slate-200">
                        {r.name}
                        <span className="ml-2 text-xs text-slate-500">{r.abbr}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.wins}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.losses}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.pct}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.diff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
