import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { GameView } from '@/lib/queries';
import { teamInfo, type TeamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import { RevealButton } from '@/components/ui/Score';
import { IconPlay } from '@/components/ui/Icons';
import { gameLabel, outcome } from '@/components/schedule/GameRow';

function Line({ team, score, win, lose }: { team: TeamInfo; score: number | null; win: boolean; lose: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <TeamLogo abbr={team.abbr} size={34} />
      <span className={`min-w-0 flex-1 truncate font-display text-lg font-bold uppercase tracking-wide ${lose ? 'tone-loss' : ''}`}>
        {team.nick}
      </span>
      <span className={`spoil-show num text-2xl font-bold ${lose ? 'tone-loss' : ''}`}>{score}</span>
      <span aria-hidden="true" className={`spoil-show w-2 text-[10px] text-flame ${win ? '' : 'invisible'}`}>
        ◀
      </span>
    </div>
  );
}

/** Carte d'un replay disponible : couleurs des deux équipes, score final, badges. */
export default function ReplayCard({ game, when, className = '' }: { game: GameView; when: string; className?: string }) {
  const away = teamInfo(game.away.abbr);
  const home = teamInfo(game.home.abbr);
  const { awayWin, homeWin } = outcome(game);

  return (
    <article
      data-scope={game.id}
      className={`group relative isolate overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900 transition duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:shadow-card ${className}`}
      style={
        {
          backgroundImage: `linear-gradient(140deg, ${away.primary}40 0%, transparent 42%), linear-gradient(320deg, ${home.primary}40 0%, transparent 42%)`,
          '--team-a': away.accent,
          '--team-b': home.accent,
        } as CSSProperties
      }
    >
      <div className="team-stripe absolute inset-x-0 top-0 h-[3px]" />
      <Link
        href={`/matchs/${game.id}`}
        aria-label={gameLabel(game)}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame"
      />
      <div className="pointer-events-none flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-paper-mute">{when}</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-flame text-ink-950 shadow-glow transition-transform group-hover:scale-110">
            <IconPlay size={12} />
          </span>
        </div>
        <div className="space-y-2">
          <Line team={away} score={game.away.score} win={awayWin} lose={homeWin} />
          <Line team={home} score={game.home.score} win={homeWin} lose={awayWin} />
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-ink-700/60 pt-3">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider">
            {game.hasVf && <span className="rounded bg-flame/15 px-1.5 py-0.5 text-flame-hot">VF</span>}
            {game.hasStats && <span className="rounded bg-ink-700 px-1.5 py-0.5 text-paper-dim">Stats</span>}
          </span>
          <span className="pointer-events-auto">
            <RevealButton id={game.id} label="Masqué" />
          </span>
          <span className="spoil-show text-[11px] font-semibold uppercase tracking-[0.2em] text-paper-faint">
            Terminé{game.period > 4 ? ' · Prol.' : ''}
          </span>
        </div>
      </div>
    </article>
  );
}
