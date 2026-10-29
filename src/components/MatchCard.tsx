import Link from 'next/link';
import type { MatchDto } from '@/lib/present';

export function StatusBadge({ status, detail }: { status: string; detail?: string }) {
  if (status === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/20 px-2 py-0.5 text-xs font-semibold text-red-400">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500" />
        En direct
      </span>
    );
  }
  if (status === 'final') {
    return (
      <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-xs font-medium text-slate-300">
        Terminé
      </span>
    );
  }
  return (
    <span className="rounded-full bg-court-500/15 px-2 py-0.5 text-xs font-medium text-court-400">
      À venir
    </span>
  );
}

export function TeamBadge({
  abbr,
  name,
  logo,
  score,
  highlight,
}: {
  abbr: string;
  name: string;
  logo: string;
  score: number | null;
  highlight?: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${highlight ? 'font-bold' : ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={name} width={28} height={28} className="h-7 w-7 shrink-0" />
      <span className="truncate text-slate-200">{name}</span>
      {score !== null && <span className="ml-auto pr-1 tabular-nums text-slate-100">{score}</span>}
    </div>
  );
}

/** Carte compacte d'un match, utilisée dans les listes. */
export function MatchCard({ match }: { match: MatchDto }) {
  const playing = match.status === 'live';
  return (
    <Link
      href={`/matchs/${match.id}`}
      className="block rounded-xl border border-slate-800 bg-[#111621] p-3 transition hover:border-slate-600 hover:bg-[#151b28]"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-slate-400">{match.time_paris}</span>
        <div className="flex items-center gap-2">
          {playing && match.clock_display && (
            <span className="text-xs tabular-nums text-red-400">
              Q{match.period} {match.clock_display}
            </span>
          )}
          <StatusBadge status={match.status} detail={match.status_detail} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <TeamBadge
          abbr={match.away.abbr}
          name={match.away.name}
          logo={match.away.logo}
          score={match.away.score}
          highlight={match.away.score !== null && match.home.score !== null && match.away.score > match.home.score}
        />
        <TeamBadge
          abbr={match.home.abbr}
          name={match.home.name}
          logo={match.home.logo}
          score={match.home.score}
          highlight={match.home.score !== null && match.away.score !== null && match.home.score > match.away.score}
        />
      </div>
      {match.video.available && (
        <div className="mt-2 text-xs text-court-400">▶ Replay disponible</div>
      )}
    </Link>
  );
}
