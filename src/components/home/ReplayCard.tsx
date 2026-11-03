import Link from 'next/link';
import { IconCup, TvMini } from '@/components/ui/TvBadge';
import type { CSSProperties } from 'react';
import type { GameView } from '@/lib/queries';
import { teamInfo, type TeamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import { RevealButton } from '@/components/ui/Score';
import { IconPlay } from '@/components/ui/Icons';
import VfBadge from '@/components/ui/VfBadge';
import { gameLabel, outcome } from '@/components/schedule/GameRow';

function Line({ team, score, win, lose }: { team: TeamInfo; score: number | null; win: boolean; lose: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <TeamLogo abbr={team.abbr} size={34} />
      <span className={`min-w-0 flex-1 truncate font-display text-lg font-semibold uppercase tracking-wide ${lose ? 'tone-loss' : ''}`}>
        {team.nick}
      </span>
      <span className={`spoil-show num text-2xl font-semibold ${lose ? 'tone-loss' : ''}`}>{score}</span>
      <span aria-hidden="true" className={`spoil-show w-2 text-[10px] text-paper-mute ${win ? '' : 'invisible'}`}>
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
      className={`group relative isolate overflow-hidden rounded-2xl border transition-colors ${
        game.cup ? 'cup-card' : 'border-ink-700/70 bg-ink-900 hover:border-ink-500 hover:bg-ink-850'
      } ${className}`}
      style={
        {
          // Seul le liseré porte les couleurs des équipes : la une reste la seule carte en couleur.
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
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[13px] text-paper-mute">{when}</span>
            {game.cup && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-cup-hot">
                <IconCup size={12} />
                {game.cup.round === 'group' ? 'NBA Cup' : game.cup.label}
              </span>
            )}
          </span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-800 text-paper-dim transition-colors group-hover:bg-flame group-hover:text-ink-950">
            <IconPlay size={12} />
          </span>
        </div>
        <div className="space-y-2">
          <Line team={away} score={game.away.score} win={awayWin} lose={homeWin} />
          <Line team={home} score={game.home.score} win={homeWin} lose={awayWin} />
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-ink-700/60 pt-3">
          <span className="flex items-center gap-1.5 text-[11px] font-medium">
            <VfBadge vf={game.vf} size="sm" />
            {game.hasStats && <span className="rounded bg-ink-700 px-1.5 py-0.5 text-paper-dim">Stats</span>}
            <TvMini tv={game.tv_fr?.filter((t, i, all) => all.findIndex((x) => x.kind === t.kind) === i).map((t) => (t.kind === 'bein' ? { ...t, name: 'beIN SPORTS' } : t))} />
          </span>
          <span className="pointer-events-auto">
            <RevealButton id={game.id} label="Masqué" />
          </span>
          <span className="spoil-show text-xs text-paper-faint">
            Terminé{game.period > 4 ? ' · prol.' : ''}
          </span>
        </div>
      </div>
    </article>
  );
}
