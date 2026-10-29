import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { GameView } from '@/lib/queries';
import { teamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import StatusPill from '@/components/ui/StatusPill';
import { RevealButton } from '@/components/ui/Score';
import GameBadges from './GameBadges';
import { dayNumber, monthShort, weekdayShort } from './dates';

/**
 * Ligne de match du point de vue d'une équipe : date, adversaire (vs/@),
 * puis l'heure ou le résultat (V/D + score).
 */
export default function TeamGameRow({ game, team }: { game: GameView; team: string }) {
  const isHome = game.home.abbr === team;
  const opp = teamInfo(isHome ? game.away.abbr : game.home.abbr);
  const mine = isHome ? game.home.score : game.away.score;
  const theirs = isHome ? game.away.score : game.home.score;
  const done = game.status === 'final' && mine !== null && theirs !== null;
  const won = done && (mine as number) > (theirs as number);
  const key = game.day_paris;

  return (
    <article
      data-scope={game.id}
      className="group relative isolate flex items-center gap-3 rounded-xl border border-ink-700/60 bg-ink-900/60 px-3 py-2.5 transition hover:border-ink-500 hover:bg-ink-850 sm:gap-4 sm:px-4"
      style={{ '--team': opp.accent } as CSSProperties}
    >
      <Link
        href={`/matchs/${game.id}`}
        aria-label={`${weekdayShort(key)} ${dayNumber(key)} ${monthShort(key)} : ${isHome ? 'contre' : 'à'} ${opp.city} ${opp.nick}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame"
      />
      <div className="flex w-11 shrink-0 flex-col items-center leading-none">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-paper-mute">{weekdayShort(key).replace('.', '')}</span>
        <span className="num text-[22px] font-bold">{dayNumber(key)}</span>
        <span className="text-[10px] uppercase text-paper-faint">{monthShort(key).replace('.', '')}</span>
      </div>
      <span className="w-6 shrink-0 text-center font-display text-sm font-bold uppercase text-paper-faint">{isHome ? 'vs' : '@'}</span>
      <TeamLogo abbr={opp.abbr} size={36} />
      <div className="min-w-0 flex-1">
        <div className="hidden truncate text-[11px] uppercase tracking-wider text-paper-mute sm:block">{opp.city}</div>
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-base font-bold uppercase leading-tight tracking-wide sm:text-lg">{opp.nick}</span>
          {game.season_type !== 'regular' && (
            <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-paper-mute">
              {game.season_type === 'preseason' ? 'Présaison' : 'Playoffs'}
            </span>
          )}
        </div>
      </div>
      <div className="hidden shrink-0 lg:block">
        <GameBadges game={game} size="sm" />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {game.status === 'final' ? (
          <>
            <span className="spoil-show flex items-center gap-2">
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-md font-display text-sm font-extrabold ${
                  won ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'
                }`}
              >
                {won ? 'V' : 'D'}
              </span>
              <span className="num text-xl font-bold">
                {mine}
                <span className="text-paper-faint">–</span>
                {theirs}
              </span>
            </span>
            <RevealButton id={game.id} label="Masqué" />
          </>
        ) : game.status === 'live' ? (
          <StatusPill status="live" period={game.period} clock={game.clock_display} />
        ) : (
          <span className="num text-xl font-bold text-paper">{game.time_paris}</span>
        )}
        {game.hasReplay && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-flame-hot lg:hidden">▶ Replay</span>
        )}
      </div>
    </article>
  );
}
