import Link from 'next/link';
import type { GameView } from '@/lib/queries';
import { teamInfo } from '@/lib/teams';
import { RevealButton } from '@/components/ui/Score';

/**
 * Forme récente : une pastille V/D par match (du plus ancien au plus récent),
 * chacune menant à la fiche du match. Masquée en mode « scores masqués ».
 */
export default function FormStrip({ games, team }: { games: GameView[]; team: string }) {
  if (!games.length) return null;
  const scope = `form-${team}`;
  return (
    <div data-scope={scope} className="flex flex-wrap items-center gap-3">
      <span className="kicker text-paper-dim">Forme</span>
      <ol className="spoil-show flex items-center gap-1.5" aria-label={`${games.length} derniers matchs, du plus ancien au plus récent`}>
        {games.map((g, i) => {
          const isHome = g.home.abbr === team;
          const mine = (isHome ? g.home.score : g.away.score) ?? 0;
          const theirs = (isHome ? g.away.score : g.home.score) ?? 0;
          const won = mine > theirs;
          const opp = teamInfo(isHome ? g.away.abbr : g.home.abbr);
          const label = `${won ? 'Victoire' : 'Défaite'} ${mine}–${theirs} ${isHome ? 'contre' : 'à'} ${opp.nick}`;
          return (
            <li key={g.id}>
              <Link
                href={`/matchs/${g.id}`}
                title={label}
                aria-label={label}
                className={`flex h-8 w-8 items-center justify-center rounded-lg font-display text-[15px] font-extrabold transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
                  won ? 'bg-win text-ink-950' : 'bg-loss/90 text-ink-950'
                } ${i === games.length - 1 ? 'ring-2 ring-paper/70 ring-offset-2 ring-offset-ink-900' : ''}`}
              >
                {won ? 'V' : 'D'}
              </Link>
            </li>
          );
        })}
      </ol>
      <span className="spoil-only flex items-center gap-1.5" aria-hidden="true">
        {games.map((g) => (
          <span key={g.id} className="h-8 w-8 rounded-lg border border-dashed border-ink-500" />
        ))}
      </span>
      <RevealButton id={scope} label="Forme masquée" />
    </div>
  );
}
