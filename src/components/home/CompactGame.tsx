import Link from 'next/link';
import type { GameView } from '@/lib/queries';
import { teamInfo, teamLogoUrl } from '@/lib/teams';
import StatusPill from '@/components/ui/StatusPill';
import { gameLabel, outcome } from '@/components/schedule/GameRow';
import { IconCup, TvMini } from '@/components/ui/TvBadge';

function Mini({ abbr, dim }: { abbr: string; dim?: boolean }) {
  const t = teamInfo(abbr);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={teamLogoUrl(abbr)} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 shrink-0 object-contain" />
      <span className={`truncate font-display text-[15px] font-semibold uppercase tracking-wide ${dim ? 'tone-loss' : ''}`}>{t.nick}</span>
    </span>
  );
}

/**
 * Match en une ligne (listes denses : « Cette nuit », « À venir ») :
 * heure ou score, visiteur @ recevant.
 */
export default function CompactGame({ game, highlight, note, dense }: { game: GameView; highlight?: boolean; note?: string; dense?: boolean }) {
  const { awayWin, homeWin } = outcome(game);
  const started = game.status !== 'scheduled';
  const cup = !!game.cup;
  if (dense) {
    // Une seule ligne : heure (ou score) · visiteur @ recevant.
    return (
      <Link
        href={`/matchs/${game.id}`}
        aria-label={gameLabel(game)}
        data-scope={game.id}
        className={`grid grid-cols-[4rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
          highlight ? 'bg-ink-800 ring-1 ring-inset ring-paper/10' : cup ? 'cup-card border' : 'hover:bg-ink-800'
        }`}
      >
        {game.status === 'live' ? (
          <StatusPill status="live" period={game.period} compact />
        ) : (
          <span className={`num text-base font-semibold ${highlight ? 'text-flame-hot' : 'text-paper'}`}>{game.time_paris}</span>
        )}
        <Mini abbr={game.away.abbr} dim={homeWin} />
        {/* Une seule cellule : le score, ou « @ » (avant le match, ou scores masqués). */}
        <span className="text-center">
          {started ? (
            <>
              <span className="spoil-show num whitespace-nowrap text-sm font-semibold">
                {game.away.score}-{game.home.score}
              </span>
              <span className="spoil-only text-xs text-paper-faint">@</span>
            </>
          ) : (
            <span className="text-xs text-paper-faint">@</span>
          )}
        </span>
        <Mini abbr={game.home.abbr} dim={awayWin} />
        <span className="flex items-center justify-end gap-1">
          {cup && <IconCup size={13} className="text-cup-hot" />}
          <TvMini tv={game.tv_fr} />
        </span>
      </Link>
    );
  }
  return (
    <Link
      href={`/matchs/${game.id}`}
      aria-label={gameLabel(game)}
      data-scope={game.id}
      className={`group grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
        highlight ? 'bg-ink-800 ring-1 ring-inset ring-paper/10' : cup ? 'cup-card border' : 'hover:bg-ink-800'
      }`}
    >
      <span className="flex flex-col items-start leading-none">
        {game.status === 'live' ? (
          <StatusPill status="live" period={game.period} compact />
        ) : (
          <span className={`num text-xl font-semibold ${highlight ? 'text-flame-hot' : 'text-paper'}`}>{game.time_paris}</span>
        )}
        {note && <span className="mt-1 text-[11px] text-paper-mute">{note}</span>}
        {cup && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-cup-hot">
            <IconCup size={11} />
            Cup
          </span>
        )}
        {!!game.tv_fr?.length && (
          <span className="mt-1">
            <TvMini tv={game.tv_fr} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <Mini abbr={game.away.abbr} dim={homeWin} />
          {started && <span className={`spoil-show num text-base font-semibold ${homeWin ? 'tone-loss' : ''}`}>{game.away.score}</span>}
        </span>
        <span className="flex items-center justify-between gap-2">
          <Mini abbr={game.home.abbr} dim={awayWin} />
          {started && <span className={`spoil-show num text-base font-semibold ${awayWin ? 'tone-loss' : ''}`}>{game.home.score}</span>}
        </span>
      </span>
    </Link>
  );
}
