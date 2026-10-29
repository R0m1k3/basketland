import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { GameView, TeamRecord } from '@/lib/queries';
import { teamInfo, type TeamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import StatusPill from '@/components/ui/StatusPill';
import { RevealButton, ScoreValue } from '@/components/ui/Score';
import GameBadges from './GameBadges';

/** Libellé accessible d'un match : « Detroit Pistons à New York Knicks, 01:00 ». */
export function gameLabel(g: GameView): string {
  const a = teamInfo(g.away.abbr);
  const h = teamInfo(g.home.abbr);
  const base = `${a.city} ${a.nick} à ${h.city} ${h.nick}`.replace(/\s+/g, ' ').trim();
  if (g.status === 'final') return `${base}, terminé${g.hasReplay ? ', replay disponible' : ''}`;
  if (g.status === 'live') return `${base}, en direct`;
  return `${base}, ${g.time_paris}`;
}

export function outcome(g: GameView): { awayWin: boolean; homeWin: boolean } {
  const done = g.status === 'final' && g.away.score !== null && g.home.score !== null;
  return {
    awayWin: done && (g.away.score as number) > (g.home.score as number),
    homeWin: done && (g.home.score as number) > (g.away.score as number),
  };
}

function Side({ team, side, dim, record }: { team: TeamInfo; side: 'away' | 'home'; dim: boolean; record?: TeamRecord }) {
  const away = side === 'away';
  return (
    <div
      className={`flex min-w-0 flex-col items-center gap-1.5 sm:flex-row sm:gap-3 ${away ? 'sm:justify-end' : 'sm:justify-start'}`}
    >
      <TeamLogo abbr={team.abbr} size={40} className={away ? 'sm:order-last' : ''} />
      <div className={`min-w-0 max-w-full text-center ${away ? 'sm:text-right' : 'sm:text-left'}`}>
        <div className="hidden truncate text-[11px] font-medium uppercase tracking-wider text-paper-mute sm:block">{team.city}</div>
        <div
          className={`truncate font-display text-[15px] font-bold uppercase leading-tight tracking-wide sm:text-xl ${dim ? 'tone-loss' : ''}`}
        >
          {team.nick}
        </div>
        {record && (
          <div className="spoil-show num text-xs font-semibold tracking-wider text-paper-faint sm:text-[13px]">
            {record.wins}–{record.losses}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ligne de match façon tableau d'affichage : visiteur à gauche, recevant à
 * droite, et au centre l'heure (à venir) ou le score (en cours / terminé).
 */
export default function GameRow({
  game,
  dateLabel,
  records,
}: {
  game: GameView;
  dateLabel?: string;
  /** Bilans de la saison, affichés sous le nom des équipes. */
  records?: Map<string, TeamRecord>;
}) {
  const away = teamInfo(game.away.abbr);
  const home = teamInfo(game.home.abbr);
  const { awayWin, homeWin } = outcome(game);
  const started = game.status === 'final' || game.status === 'live';
  const ot = game.period > 4 ? (game.period > 5 ? ` · ${game.period - 4} prol.` : ' · Prol.') : '';
  const badges = game.hasReplay || game.hasStats;

  return (
    <article
      data-scope={game.id}
      className="group relative isolate overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900/70 transition hover:border-ink-500 hover:bg-ink-850"
      style={{ '--team-a': away.accent, '--team-b': home.accent } as CSSProperties}
    >
      <div className="team-stripe absolute inset-x-0 top-0 h-[2px] opacity-50 transition-opacity group-hover:opacity-100" />
      <Link
        href={`/matchs/${game.id}`}
        aria-label={gameLabel(game)}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame"
      />
      <div className="pointer-events-none grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-3.5 sm:gap-5 sm:px-5 sm:py-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_13rem]">
        <Side team={away} side="away" dim={homeWin} record={records?.get(away.abbr)} />

        <div className="flex min-w-[7.5rem] flex-col items-center gap-1.5 sm:min-w-[11rem]">
          {dateLabel && (
            <span className="text-[11px] font-semibold uppercase tracking-wider text-paper-mute">{dateLabel}</span>
          )}
          {started ? (
            <>
              <div className="spoil-show flex items-center gap-2 text-[30px] font-bold leading-none sm:gap-3 sm:text-[40px]">
                <span aria-hidden="true" className={`text-xs text-flame ${awayWin ? '' : 'invisible'}`}>▶</span>
                <ScoreValue value={game.away.score} className={homeWin ? 'tone-loss' : ''} />
                <span className="text-xl text-ink-500 sm:text-2xl">–</span>
                <ScoreValue value={game.home.score} className={awayWin ? 'tone-loss' : ''} />
                <span aria-hidden="true" className={`text-xs text-flame ${homeWin ? '' : 'invisible'}`}>◀</span>
              </div>
              <span className="pointer-events-auto">
                <RevealButton id={game.id} />
              </span>
              {game.status === 'live' ? (
                <StatusPill status="live" period={game.period} clock={game.clock_display} />
              ) : (
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-paper-faint">Terminé{ot}</span>
              )}
            </>
          ) : (
            <>
              <span className="num text-[30px] font-bold leading-none text-paper sm:text-[40px]">{game.time_paris}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-flame-hot">À venir</span>
            </>
          )}
        </div>

        <Side team={home} side="home" dim={awayWin} record={records?.get(home.abbr)} />

        {badges && (
          <div className="hidden justify-end lg:flex">
            <GameBadges game={game} />
          </div>
        )}
      </div>
      {badges && (
        <div className="pointer-events-none -mt-1 flex justify-center pb-3 lg:hidden">
          <GameBadges game={game} size="sm" />
        </div>
      )}
    </article>
  );
}
