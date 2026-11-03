import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { GameView } from '@/lib/queries';
import { teamInfo, teamLogoUrl, type TeamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import { RevealButton } from '@/components/ui/Score';
import { IconArrowRight, IconPlay } from '@/components/ui/Icons';
import GameBadges from '@/components/schedule/GameBadges';
import { outcome } from '@/components/schedule/GameRow';

/**
 * Taille du nom : le mot le plus long tient toujours dans la colonne (unités
 * de conteneur `cqi`, ~0,5 em par lettre en Barlow Condensed, avec de la marge), sans dépasser
 * la taille d'origine (2xl / 4xl / 5xl selon l'écran). Les noms en deux mots
 * (« Trail Blazers ») passent sur deux lignes au lieu d'être coupés.
 */
function nameFit(nick: string): CSSProperties {
  const longest = Math.max(4, ...nick.split(/\s+/).map((w) => w.length));
  return { fontSize: `clamp(1.125rem, ${(200 / longest).toFixed(1)}cqi, var(--hero-name-max))` };
}

function HeroTeam({ team, dim, align }: { team: TeamInfo; dim: boolean; align: 'left' | 'right' }) {
  return (
    <div className={`flex min-w-0 flex-col items-center gap-3 text-center ${align === 'left' ? 'md:items-start md:text-left' : 'md:items-end md:text-right'}`}>
      <TeamLogo abbr={team.abbr} size={84} className="md:hidden" />
      <TeamLogo abbr={team.abbr} size={120} className="hidden md:inline-flex" />
      {/* Conteneur de taille : la colonne entière (w-full), pour les unités cqi du nom. */}
      <div className="w-full min-w-0 [container-type:inline-size]">
        <div className="truncate text-sm font-medium text-paper-dim">{team.city}</div>
        <div
          className={`font-display font-semibold uppercase leading-[0.95] [overflow-wrap:anywhere] [text-wrap:balance] [--hero-name-max:1.5rem] sm:[--hero-name-max:2.25rem] lg:[--hero-name-max:3rem] ${dim ? 'tone-loss' : ''}`}
          style={nameFit(team.nick)}
        >
          {team.nick}
        </div>
      </div>
    </div>
  );
}

/**
 * La « une » : le replay le plus récent, mis en scène aux couleurs des deux
 * équipes (fond partagé en diagonale, logos géants en filigrane).
 */
export default function Hero({ game, kicker }: { game: GameView; kicker: string }) {
  const away = teamInfo(game.away.abbr);
  const home = teamInfo(game.home.abbr);
  const { awayWin, homeWin } = outcome(game);

  return (
    <section
      data-scope={game.id}
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden rounded-[20px] border border-ink-700/80 shadow-card"
      style={
        {
          background: `linear-gradient(102deg, ${away.primary} 0%, ${away.primary}d9 30%, #16161C 50%, ${home.primary}d9 70%, ${home.primary} 100%)`,
          '--team-a': away.accent,
          '--team-b': home.accent,
        } as CSSProperties
      }
    >
      {/* Filigranes */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={teamLogoUrl(away.abbr)} alt="" aria-hidden="true" className="watermark -left-24 -top-16 h-[420px] w-[420px] -rotate-12" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={teamLogoUrl(home.abbr)} alt="" aria-hidden="true" className="watermark -bottom-24 -right-24 h-[420px] w-[420px] rotate-12" />
      {/* Assombrissement pour la lisibilité */}
      <div className="pointer-events-none absolute inset-0 -z-0 bg-[radial-gradient(70%_90%_at_50%_45%,rgba(11,11,14,.78),rgba(11,11,14,.35)_70%,rgba(11,11,14,.15))]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-ink-950/90 to-transparent" />
      <div className="team-stripe absolute inset-x-0 top-0 h-[3px]" />

      <div className="relative flex flex-col gap-6 p-5 sm:p-8 lg:p-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-paper">Replay à la une</span>
            <span className="text-paper-dim">{kicker}</span>
          </p>
          <GameBadges game={{ ...game, hasReplay: false }} cup />
        </div>

        <h2 id="hero-title" className="sr-only">
          {away.city} {away.nick} à {home.city} {home.nick}
        </h2>

        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-8">
          <HeroTeam team={away} dim={homeWin} align="left" />

          <div className="col-span-2 row-start-2 flex flex-col items-center gap-2 md:col-span-1 md:col-start-2 md:row-start-1">
            <div className="spoil-show flex items-center gap-2 font-display text-[76px] font-semibold leading-none tabular-nums sm:gap-4 sm:text-[96px] lg:text-[112px]">
              <span className={homeWin ? 'tone-loss' : ''}>{game.away.score}</span>
              <span className="text-[0.5em] text-paper-faint">–</span>
              <span className={awayWin ? 'tone-loss' : ''}>{game.home.score}</span>
            </div>
            <div className="spoil-only flex flex-col items-center gap-3 py-2">
              <span className="font-display text-3xl font-semibold uppercase text-paper-dim sm:text-5xl">? – ?</span>
            </div>
            <RevealButton id={game.id} />
            <span className="text-[13px] text-paper-mute">
              Terminé{game.period > 4 ? ' après prolongation' : ''}
            </span>
          </div>

          <div className="min-w-0 md:col-start-3 md:row-start-1">
            <HeroTeam team={home} dim={awayWin} align="right" />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 md:justify-start">
          <Link href={`/matchs/${game.id}`} className="btn-primary h-12 px-5 text-base">
            <IconPlay size={14} />
            {game.hasVf ? 'Regarder en VF' : 'Regarder le replay'}
          </Link>
          <a href="#replays" className="btn h-12 bg-ink-950/70 px-5">
            Autres replays
            <IconArrowRight className="rotate-90" />
          </a>
          {game.venue && <span className="hidden text-sm text-paper-mute md:inline">{game.venue}</span>}
        </div>
      </div>
    </section>
  );
}
