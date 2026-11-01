import type { GameView } from '@/lib/queries';
import { IconChart, IconPlay } from '@/components/ui/Icons';
import VfBadge from '@/components/ui/VfBadge';
import { CupBadge, TvBadges } from '@/components/ui/TvBadge';

/** Le match a quelque chose à afficher dans [`GameBadges`]. */
export function hasBadges(game: GameView, withCup = false): boolean {
  return game.hasReplay || game.hasStats || game.vf.state !== 'none' || !!game.tv_fr?.length || (withCup && !!game.cup);
}

/**
 * Ce qu'on peut faire avec un match : regarder le replay, la VF, les stats ;
 * et sa diffusion en France (beIN SPORTS avec la chaîne pour un match à
 * venir, Prime Video). `cup` : affiche aussi le repère NBA Cup.
 */
export default function GameBadges({
  game,
  size = 'md',
  cup = false,
  className = '',
}: {
  game: GameView;
  size?: 'sm' | 'md';
  cup?: boolean;
  className?: string;
}) {
  if (!hasBadges(game, cup)) return null;
  const pad = size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]';
  const upcoming = game.status === 'scheduled' || game.status === 'live';
  return (
    <span className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {cup && <CupBadge cup={game.cup} size={size} />}
      <TvBadges tv={game.tv_fr} size={size} short={!upcoming} />
      {game.hasReplay && (
        <span className={`inline-flex items-center gap-1 rounded-full bg-flame font-bold uppercase tracking-wider text-ink-950 ${pad}`}>
          <IconPlay size={10} />
          Replay
        </span>
      )}
      <VfBadge vf={game.vf} size={size} />
      {game.hasStats && (
        <span className={`inline-flex items-center gap-1 rounded-full border border-ink-600 font-bold uppercase tracking-wider text-paper-dim ${pad}`}>
          <IconChart size={11} />
          Stats
        </span>
      )}
    </span>
  );
}
