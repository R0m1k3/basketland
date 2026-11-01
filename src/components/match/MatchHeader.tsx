import Link from 'next/link';
import TeamLogo from '@/components/ui/TeamLogo';
import StatusPill from '@/components/ui/StatusPill';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import { RevealButton } from '@/components/ui/Score';
import type { SpoilerMode } from '@/components/ui/spoiler-keys';
import type { Linescore } from '@/lib/linescore';
import type { MatchDto } from '@/lib/present';
import { teamInfo } from '@/lib/teams';
import { parisDateLabel, seasonLabel } from '@/lib/time';
import { CupBadge, TvBadges } from '@/components/ui/TvBadge';

const SEASON_TYPE: Record<string, string> = {
  preseason: 'Pré-saison',
  regular: 'Saison régulière',
  post: 'Playoffs',
};

/**
 * En-tête « tableau d'affichage » : couleurs des deux équipes, score géant
 * (masquable), statut, tableau par quart-temps et informations pratiques.
 * Composant serveur : le masquage du score est purement CSS (.spoil-show).
 */
export default function MatchHeader({
  match,
  linescore,
  spoilers,
}: {
  match: MatchDto;
  linescore: Linescore | null;
  spoilers: SpoilerMode;
}) {
  const away = teamInfo(match.away.abbr);
  const home = teamInfo(match.home.abbr);
  const upcoming = match.status !== 'final' && match.status !== 'live';
  const hasScore = !upcoming && match.away.score !== null && match.home.score !== null;
  const awayWins = match.status === 'final' && hasScore && match.away.score! > match.home.score!;
  const homeWins = match.status === 'final' && hasScore && match.home.score! > match.away.score!;
  const dateLabel = parisDateLabel(match.date_utc);

  return (
    <section
      className={`match-hero panel relative overflow-hidden ${match.cup ? 'cup-card' : ''}`}
      style={
        {
          '--team-a': away.accent,
          '--team-b': home.accent,
          '--team-a-deep': away.primary,
          '--team-b-deep': home.primary,
        } as React.CSSProperties
      }
      aria-label={`${match.away.name} contre ${match.home.name}`}
    >
      <div className="team-stripe h-[3px] w-full" aria-hidden="true" />
      {/* Logos en filigrane, coupés par les bords */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="match-hero-wash absolute inset-0" />
        <div className="absolute -left-16 top-1/2 hidden -translate-y-1/2 opacity-[0.07] sm:block">
          <TeamLogo abbr={match.away.abbr} size={300} />
        </div>
        <div className="absolute -right-16 top-1/2 hidden -translate-y-1/2 opacity-[0.07] sm:block">
          <TeamLogo abbr={match.home.abbr} size={300} />
        </div>
      </div>

      <div className="relative px-4 pb-5 pt-4 sm:px-8 sm:pb-7 sm:pt-6">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="kicker truncate">
              NBA · <span className="hidden sm:inline">{SEASON_TYPE[match.season_type] ?? 'Saison'} </span>
              {seasonLabel(match.season)}
            </span>
            <CupBadge cup={match.cup} size="sm" />
          </span>
          {!upcoming && <SpoilerToggle initial={spoilers} className="shrink-0 !px-2.5 !py-1 !text-xs sm:!px-3 sm:!py-1.5 sm:!text-sm" />}
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:mt-6 sm:gap-6">
          <TeamSide abbr={match.away.abbr} name={match.away.name} role="Extérieur" align="left" />

          <div className="flex flex-col items-center text-center">
            {upcoming ? (
              <>
                <span className="num text-5xl font-bold leading-none text-paper sm:text-7xl">{match.time_paris}</span>
                <span className="mt-2 text-[11px] font-medium uppercase tracking-[0.16em] text-paper-mute">Heure de Paris</span>
              </>
            ) : (
              <>
                <div className="spoil-show flex items-center gap-3 sm:gap-6">
                  <Score value={match.away.score} win={awayWins} dim={homeWins} side="left" />
                  <span className="num text-2xl text-ink-500 sm:text-4xl" aria-hidden="true">
                    –
                  </span>
                  <Score value={match.home.score} win={homeWins} dim={awayWins} side="right" />
                </div>
                <RevealButton id={match.id} className="!gap-2 !px-4 !py-2 !text-xs sm:!px-5 sm:!py-2.5 sm:!text-sm" />
              </>
            )}
            <div className="mt-3">
              <StatusPill
                status={match.status}
                period={match.period}
                clock={match.clock_display}
                time={upcoming ? 'À venir' : undefined}
              />
            </div>
          </div>

          <TeamSide abbr={match.home.abbr} name={match.home.name} role="Domicile" align="right" />
        </div>

        {linescore && !upcoming && <LinescoreTable ls={linescore} awayAbbr={match.away.abbr} homeAbbr={match.home.abbr} />}

        <dl className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-ink-700/60 pt-4 text-[13px] text-paper-mute sm:mt-6">
          <Meta icon="calendar" label="Date">
            <span className="first-letter:uppercase">{dateLabel}</span> · {match.time_paris}
          </Meta>
          {match.venue && (
            <Meta icon="pin" label="Salle">
              {match.venue}
            </Meta>
          )}
          {match.broadcast && (
            <Meta icon="tv" label="Diffusion">
              <span className="line-clamp-1">{match.broadcast}</span>
            </Meta>
          )}
        </dl>
        {!!match.tv_fr?.length && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[13px] text-paper-mute">
            <span>{upcoming ? 'À suivre en France sur' : 'Diffusé en France sur'}</span>
            <TvBadges tv={match.tv_fr} size="sm" />
          </div>
        )}
      </div>
    </section>
  );
}

function TeamSide({ abbr, name, role, align }: { abbr: string; name: string; role: string; align: 'left' | 'right' }) {
  const t = teamInfo(abbr);
  return (
    <Link
      href={`/equipes/${abbr}`}
      className={`group flex min-w-0 flex-col items-center gap-2 rounded-xl p-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 sm:flex-row sm:gap-4 ${
        align === 'right' ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left'
      }`}
    >
      <TeamLogo abbr={abbr} size={88} className="hidden transition-transform group-hover:scale-105 sm:inline-flex" />
      <TeamLogo abbr={abbr} size={52} className="sm:hidden" />
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium uppercase tracking-[0.14em] text-paper-mute sm:text-xs">
          {t.city || role}
        </span>
        <span className="block truncate font-display text-xl font-extrabold uppercase leading-none tracking-tight text-paper group-hover:text-flame-hot sm:text-4xl">
          {t.city ? t.nick : name}
        </span>
        <span className="mt-1 hidden text-[11px] uppercase tracking-wider text-paper-faint sm:block">{role}</span>
      </span>
    </Link>
  );
}

function Score({ value, win, dim, side }: { value: number | null; win: boolean; dim: boolean; side: 'left' | 'right' }) {
  return (
    <span className="relative inline-flex items-center">
      {win && side === 'left' && <span className="win-caret win-caret-left" aria-hidden="true" />}
      <span
        className={`num text-5xl font-bold leading-none sm:text-8xl ${dim ? 'text-paper-mute' : 'text-paper'}`}
        aria-label={win ? `${value}, vainqueur` : String(value ?? '')}
      >
        {value ?? '–'}
      </span>
      {win && side === 'right' && <span className="win-caret win-caret-right" aria-hidden="true" />}
    </span>
  );
}

function LinescoreTable({ ls, awayAbbr, homeAbbr }: { ls: Linescore; awayAbbr: string; homeAbbr: string }) {
  const rows = [
    { abbr: awayAbbr, get: (p: Linescore['periods'][number]) => p.away, total: ls.away },
    { abbr: homeAbbr, get: (p: Linescore['periods'][number]) => p.home, total: ls.home },
  ];
  return (
    <div className="spoil-show mx-auto mt-5 w-full max-w-md overflow-x-auto sm:mt-6">
      <table className="linescore w-full">
        <caption className="sr-only">Score par quart-temps</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">
              <span className="sr-only">Équipe</span>
            </th>
            {ls.periods.map((p) => (
              <th key={p.period} scope="col">
                {p.label}
              </th>
            ))}
            <th scope="col" className="text-paper-dim">
              T
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const best = r.total >= Math.max(ls.away, ls.home);
            return (
              <tr key={r.abbr}>
                <th scope="row" className="text-left">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-1 rounded-full" style={{ background: teamInfo(r.abbr).accent }} />
                    {r.abbr}
                  </span>
                </th>
                {ls.periods.map((p) => (
                  <td key={p.period}>{r.get(p)}</td>
                ))}
                <td className={best ? 'font-bold text-paper' : 'text-paper-dim'}>{r.total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  tv: (
    <>
      <rect x="2.5" y="5" width="19" height="13" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
};

function Meta({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5">
      <dt className="shrink-0">
        <span className="sr-only">{label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="text-paper-faint">
          {ICONS[icon]}
        </svg>
      </dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}
