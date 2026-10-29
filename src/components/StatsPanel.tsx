'use client';

import { useEffect, useState } from 'react';

interface PlayerStat {
  id: string;
  name: string;
  position: string;
  jersey: string;
  starter: boolean;
  stats: Record<string, string>;
}

interface TeamStats {
  abbr: string;
  name: string;
  score: number | null;
  stats: Record<string, string>;
  players: PlayerStat[];
}

interface StatsPayload {
  available: boolean;
  status?: string;
  reason?: string;
  columns?: string[];
  teams?: TeamStats[];
  leaders?: Array<{ team_abbr: string; category: string; player_name: string; value: number }>;
}

/** Panneau des statistiques, chargé à la demande quand l'utilisateur l'ouvre. */
export default function StatsPanel({ matchId, enabled }: { matchId: number; enabled: boolean }) {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || data || loading) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/matches/${matchId}/stats`)
      .then((r) => r.json())
      .then((d: StatsPayload) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ available: false, reason: 'Erreur de chargement des statistiques.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, matchId, data, loading]);

  if (!data) {
    return <p className="text-sm text-slate-500">Chargement des statistiques…</p>;
  }
  if (!data.available) {
    return <p className="text-sm text-slate-500">{data.reason ?? 'Statistiques indisponibles.'}</p>;
  }

  const columns = data.columns ?? [];

  return (
    <div className="space-y-6">
      {(data.teams ?? []).map((team) => (
        <section key={team.abbr}>
          <h3 className="mb-2 text-sm font-semibold text-white">
            {team.name} <span className="text-slate-400">{team.score ?? ''}</span>
          </h3>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-[#111621] text-xs text-slate-400">
                  <th className="px-3 py-2 text-left font-medium">Joueur</th>
                  {columns.map((c) => (
                    <th key={c} className="px-2 py-2 text-right font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {team.players.map((p) => (
                  <tr key={p.id} className="border-b border-slate-900/60 last:border-0">
                    <td className="px-3 py-1.5 text-slate-200">
                      {p.name}
                      {p.starter && <span className="ml-1.5 text-[10px] text-court-400">(T)</span>}
                    </td>
                    {columns.map((c) => (
                      <td key={c} className="px-2 py-1.5 text-right tabular-nums text-slate-300">
                        {p.stats[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {data.leaders && data.leaders.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-white">Meilleurs joueurs du match</h3>
          <ul className="space-y-1 text-sm text-slate-300">
            {data.leaders.map((l, i) => (
              <li key={i}>
                <span className="text-slate-400">{l.category}</span> — {l.player_name}{' '}
                <span className="tabular-nums text-white">{l.value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
