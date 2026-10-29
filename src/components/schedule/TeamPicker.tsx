import Link from 'next/link';
import { TEAMS } from '@/lib/teams';
import { teamLogoUrl } from '@/lib/teams';
import ScrollToSelected from './ScrollToSelected';

/**
 * Filtre par équipe : les 30 logos sur une rangée (Est puis Ouest). Un clic
 * bascule le calendrier sur tous les matchs de l'équipe.
 */
export default function TeamPicker({ selected, allHref }: { selected?: string; allHref: string }) {
  const east = TEAMS.filter((t) => t.conference === 'Est').sort((a, b) => a.nick.localeCompare(b.nick));
  const west = TEAMS.filter((t) => t.conference === 'Ouest').sort((a, b) => a.nick.localeCompare(b.nick));

  const item = (abbr: string, label: string, accent: string) => {
    const active = selected === abbr;
    return (
      <li key={abbr}>
        <Link
          href={active ? allHref : `/matchs?team=${abbr}`}
          aria-label={active ? `${label} (filtre actif, retirer)` : `Matchs des ${label}`}
          title={label}
          aria-current={active ? 'true' : undefined}
          data-selected={active ? '' : undefined}
          className={`group flex h-11 w-11 items-center justify-center rounded-full transition lg:h-[35px] lg:w-[35px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
            active ? 'scale-105 bg-ink-700' : 'hover:bg-ink-800'
          }`}
          style={active ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={teamLogoUrl(abbr)}
            alt=""
            width={30}
            height={30}
            loading="lazy"
            className={`h-[30px] w-[30px] object-contain transition lg:h-[26px] lg:w-[26px] ${
              selected && !active ? 'opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0' : ''
            }`}
          />
        </Link>
      </li>
    );
  };

  return (
    <div className="flex items-center gap-2">
      <Link
        href={allHref}
        className={`shrink-0 rounded-full px-3 py-1.5 font-display text-sm font-semibold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${
          selected ? 'text-paper-mute hover:text-paper' : 'bg-paper text-ink-950'
        }`}
        aria-current={!selected ? 'true' : undefined}
      >
        Toutes
      </Link>
      <ScrollToSelected watch={selected} className="scroll-row relative min-w-0 flex-1 overflow-x-auto">
        <ul className="flex w-max items-center gap-0.5 py-1 pr-2 lg:w-full lg:justify-between lg:gap-0" aria-label="Filtrer par équipe">
          <li aria-hidden="true" className="px-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-paper-faint lg:px-1">
            Est
          </li>
          {east.map((t) => item(t.abbr, `${t.city} ${t.nick}`, t.accent))}
          <li className="mx-1 h-6 w-px bg-ink-600" aria-hidden="true" />
          <li aria-hidden="true" className="px-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-paper-faint lg:px-1">
            Ouest
          </li>
          {west.map((t) => item(t.abbr, `${t.city} ${t.nick}`, t.accent))}
        </ul>
      </ScrollToSelected>
    </div>
  );
}
