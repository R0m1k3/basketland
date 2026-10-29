import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listMatches } from '@/lib/db';
import { teamLogo } from '@/lib/espn';
import { toDto } from '@/lib/present';
import { parisDateKey } from '@/lib/time';
import { MatchCard } from '@/components/MatchCard';

/**
 * Page équipe : prochain match, derniers résultats, replays disponibles.
 *
 * Les données viennent de la base locale (aucun appel ESPN à l'affichage) :
 * la page reste instantanée et fonctionne même si l'API est indisponible.
 */

export const dynamic = 'force-dynamic';

const ABBR_RE = /^[A-Z]{2,4}$/;

/** Un match terminé, dans l'ordre antéchronologique. */
function isFinished(m: { status: string }): boolean {
  return m.status === 'final';
}

export default async function TeamPage({ params }: { params: Promise<{ abbr: string }> }) {
  const { abbr: raw } = await params;
  const abbr = raw.toUpperCase();
  if (!ABBR_RE.test(abbr)) notFound();

  const all = listMatches({ team: abbr, limit: 200, order: 'desc' });
  if (!all.length) notFound();

  // Le nom complet vient du match le plus récent (les noms varient peu).
  const latest = all[0];
  const name = latest.home_abbr === abbr ? latest.home_name : latest.away_name;

  const now = Date.now();
  const upcoming = all
    .filter((m) => m.status !== 'final' && Date.parse(m.date_utc) >= now - 3 * 3600_000)
    .sort((a, b) => a.date_utc.localeCompare(b.date_utc));
  const finished = all.filter(isFinished);
  const withReplay = finished.filter((m) => m.video_available && m.video_ok_id);

  // Bilan de la saison en cours : la base ne contient que 'preseason' et
  // 'regular' (valeurs ESPN).
  const regular = finished.filter((m) => m.season_type === 'regular');
  let wins = 0;
  let losses = 0;
  for (const m of regular) {
    const isHome = m.home_abbr === abbr;
    const mine = isHome ? m.home_score : m.away_score;
    const theirs = isHome ? m.away_score : m.home_score;
    if (mine === null || theirs === null) continue;
    if (mine > theirs) wins++;
    else if (mine < theirs) losses++;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={teamLogo(abbr, latest.league)}
          alt=""
          className="h-16 w-16 rounded-full bg-[#111621] object-contain"
        />
        <div>
          <h1 className="text-2xl font-bold text-white">{name}</h1>
          <p className="text-sm text-slate-400">
            {abbr} · {regular.length} matchs de saison régulière
            {regular.length > 0 ? ` · ${wins} V ${losses} D` : ''}
          </p>
        </div>
        <Link
          href="/matchs"
          className="ml-auto rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
        >
          Tous les matchs
        </Link>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">Prochain match</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun match à venir enregistré pour cette équipe.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {upcoming.slice(0, 2).map((m) => (
              <MatchCard key={m.id} match={toDto(m)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">
          Derniers résultats{' '}
          <span className="text-sm font-normal text-slate-500">({finished.length})</span>
        </h2>
        {finished.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun match terminé enregistré.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {finished.slice(0, 12).map((m) => (
              <MatchCard key={m.id} match={toDto(m)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">
          Replays disponibles{' '}
          <span className="text-sm font-normal text-slate-500">({withReplay.length})</span>
        </h2>
        {withReplay.length === 0 ? (
          <p className="text-sm text-slate-500">
            Aucun replay n’a encore été récupéré pour cette équipe. La recherche est automatique et tourne
            toutes les deux heures.
          </p>
        ) : (
          <ul className="divide-y divide-slate-900/60 overflow-hidden rounded-lg border border-slate-800">
            {withReplay.slice(0, 10).map((m) => {
              const isHome = m.home_abbr === abbr;
              const opponent = isHome ? m.away_name : m.home_name;
              const mine = isHome ? m.home_score : m.away_score;
              const theirs = isHome ? m.away_score : m.home_score;
              const won = mine !== null && theirs !== null && mine > theirs;
              return (
                <li key={m.id}>
                  <Link
                    href={`/matchs/${m.id}`}
                    className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-[#111621]"
                  >
                    <span className="tabular-nums text-slate-500">{parisDateKey(m.date_utc)}</span>
                    <span className="text-slate-300">
                      {isHome ? 'vs' : '@'} {opponent}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {theirs} – {mine}
                    </span>
                    <span className={won ? 'text-emerald-400' : 'text-rose-400'}>
                      {won ? 'V' : 'D'}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">Replay</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
