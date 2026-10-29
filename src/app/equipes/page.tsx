import Link from 'next/link';
import { listTeams } from '@/lib/db';
import { teamLogo } from '@/lib/espn';

/**
 * Index des équipes NBA.
 *
 * Complète la page `/equipes/[abbr]` : sans elle, les pages d'équipe
 * n'étaient accessibles que depuis la fiche d'un match.
 */
export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  const teams = listTeams();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Équipes NBA</h1>

      {teams.length === 0 ? (
        <p className="text-sm text-slate-500">
          Aucune équipe enregistrée. Une synchronisation du calendrier remplira cette liste.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link
              key={t.abbr}
              href={`/equipes/${t.abbr}`}
              className="flex items-center gap-3 rounded-xl border border-slate-800 bg-[#111621] p-3 transition hover:border-slate-600 hover:bg-[#151b28]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={teamLogo(t.abbr, 'nba')}
                alt=""
                className="h-10 w-10 shrink-0 rounded-full object-contain"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">{t.name}</div>
                <div className="text-xs text-slate-500">{t.abbr}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
