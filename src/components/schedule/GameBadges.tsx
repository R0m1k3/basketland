import type { GameView } from '@/lib/queries';
import { IconChart, IconPlay } from '@/components/ui/Icons';
import VfBadge from '@/components/ui/VfBadge';

/**
 * Ce qu'on peut faire avec un match : regarder le replay, la VF, les stats.
 * N'affiche rien pour un match à venir.
 */
export default function GameBadges({ game, size = 'md' }: { game: GameView; size?: 'sm' | 'md' }) {
  if (!game.hasReplay && !game.hasStats && game.vf.state === 'none') return null;
  const pad = size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
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
