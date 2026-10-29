import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { GameView, TeamRecord } from '@/lib/queries';
import { teamInfo, teamLogoUrl, type TeamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import { relativeDay } from '@/components/schedule/dates';

/**
 * Tuile d'équipe : dégradé discret aux couleurs du club, logo en filigrane
 * qui glisse au survol, bilan et prochain match.
 */
export default function TeamTile({
  team,
  record,
  next,
  seed,
  today,
}: {
  team: TeamInfo;
  record?: TeamRecord;
  next?: GameView;
  seed?: number;
  today: string;
}) {
  const opp = next ? teamInfo(next.home.abbr === team.abbr ? next.away.abbr : next.home.abbr) : undefined;
  const isHome = next?.home.abbr === team.abbr;
  const pct = record && record.wins + record.losses > 0 ? record.wins / (record.wins + record.losses) : undefined;

  return (
    <Link
      href={`/equipes/${team.abbr}`}
      aria-label={`${team.city} ${team.nick}${record ? `, bilan ${record.wins} victoires ${record.losses} défaites` : ''}`}
      className="group relative isolate flex items-center gap-4 overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-[var(--team)] hover:shadow-[0_18px_40px_-20px_var(--team)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
      style={
        {
          '--team': team.accent,
          backgroundImage: `linear-gradient(115deg, ${team.primary}59 0%, ${team.primary}1f 45%, transparent 75%)`,
        } as CSSProperties
      }
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: team.accent }} aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={teamLogoUrl(team.abbr)}
        alt=""
        aria-hidden="true"
        loading="lazy"
        className="pointer-events-none absolute -right-6 -top-4 -z-10 h-32 w-32 rotate-[-8deg] opacity-[0.09] transition duration-500 group-hover:-right-2 group-hover:rotate-0 group-hover:opacity-20"
      />
      <TeamLogo abbr={team.abbr} size={52} className="transition-transform duration-300 group-hover:scale-110" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-paper-mute">{team.city}</div>
        <div className="truncate font-display text-[22px] font-extrabold uppercase leading-none tracking-tight">{team.nick}</div>
        <div className="mt-1.5 truncate text-xs text-paper-mute">
          {next && opp ? (
            <>
              {next.status === 'live' ? (
                <span className="font-semibold text-live">En direct</span>
              ) : (
                <>
                  {relativeDay(next.day_paris, today)} · <span className="num text-[13px] text-paper-dim">{next.time_paris}</span>
                </>
              )}{' '}
              {isHome ? 'vs' : '@'} <span className="font-semibold text-paper-dim">{opp.nick}</span>
            </>
          ) : (
            'Pas de match programmé'
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="num text-[26px] font-bold leading-none">
          {record ? `${record.wins}–${record.losses}` : '0–0'}
        </span>
        <span className="mt-1 text-[11px] font-medium text-paper-mute">
          {seed ? `${seed}${seed === 1 ? 're' : 'e'} à l’${team.conference}` : pct !== undefined ? `${Math.round(pct * 100)} %` : 'Bilan'}
        </span>
      </div>
    </Link>
  );
}
