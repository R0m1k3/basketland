/**
 * Compatibilité : les listes de matchs utilisent désormais
 * `components/schedule/GameRow` (tableau d'affichage) et
 * `components/home/ReplayCard`. Ce module garde les exports historiques
 * (`StatusBadge`, `MatchCard`) pour les pages qui les importent encore.
 */
import type { MatchDto } from '@/lib/present';
import type { GameView } from '@/lib/queries';
import StatusPill from '@/components/ui/StatusPill';
import GameRow from '@/components/schedule/GameRow';

export function StatusBadge({ status, time }: { status: string; detail?: string; time?: string }) {
  return <StatusPill status={status} time={time} />;
}

export function MatchCard({ match, showDate = false }: { match: MatchDto; showDate?: boolean }) {
  const game: GameView = {
    ...match,
    hasStats: false,
    hasReplay: match.video.available,
    hasVf: match.video.available && match.status === 'final',
  };
  return <GameRow game={game} dateLabel={showDate ? match.day_paris : undefined} />;
}
