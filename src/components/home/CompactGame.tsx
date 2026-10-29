import Link from 'next/link';
import type { GameView } from '@/lib/queries';
import { teamInfo, teamLogoUrl } from '@/lib/teams';
import StatusPill from '@/components/ui/StatusPill';
import { gameLabel, outcome } from '@/components/schedule/GameRow';

function Mini({ abbr, dim }: { abbr: string; dim?: boolean }) {
  const t = teamInfo(abbr);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={teamLogoUrl(abbr)} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 shrink-0 object-contain" />
      <span className={`truncate font-display text-[15px] font-bold uppercase tracking-wide ${dim ? 'tone-loss' : ''}`}>{t.nick}</span>
    </span>
  );
}

/**
 * Match en une ligne (listes denses : « Cette nuit », « À venir ») :
 * heure ou score, visiteur @ recevant.
 */
export default function CompactGame({ game, highlight, note }: { game: GameView; highlight?: boolean; note?: string }) {
  const { awayWin, homeWin } = outcome(game);
  const started = game.status !== 'scheduled';
  return (
    <Link
      href={`/matchs/${game.id}`}
      aria-label={gameLabel(game)}
      data-scope={game.id}
      className={`group grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 rounded-xl px-3 py-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
        highlight ? 'bg-flame/10 ring-1 ring-flame/40' : 'hover:bg-ink-800'
      }`}
    >
      <span className="flex flex-col items-start leading-none">
        {game.status === 'live' ? (
          <StatusPill status="live" />
        ) : (
          <span className={`num text-xl font-bold ${highlight ? 'text-flame-hot' : 'text-paper'}`}>{game.time_paris}</span>
        )}
        {note && <span className="mt-1 text-[10px] font-medium text-paper-mute">{note}</span>}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <Mini abbr={game.away.abbr} dim={homeWin} />
          {started && <span className={`spoil-show num text-base font-bold ${homeWin ? 'tone-loss' : ''}`}>{game.away.score}</span>}
        </span>
        <span className="flex items-center justify-between gap-2">
          <Mini abbr={game.home.abbr} dim={awayWin} />
          {started && <span className={`spoil-show num text-base font-bold ${awayWin ? 'tone-loss' : ''}`}>{game.home.score}</span>}
        </span>
      </span>
    </Link>
  );
}
