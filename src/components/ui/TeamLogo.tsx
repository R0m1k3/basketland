import { teamInfo, teamLogoUrl } from '@/lib/teams';

/**
 * Logo d'équipe posé sur un disque teinté de sa couleur : les logos ESPN
 * sombres (Nets, Spurs…) restent lisibles sur le fond encre.
 */
export default function TeamLogo({ abbr, size = 40, className = '' }: { abbr: string; size?: number; className?: string }) {
  const t = teamInfo(abbr);
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 25%, ${t.accent}33, ${t.primary}22 60%, transparent 75%)`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={teamLogoUrl(abbr)}
        alt={`${t.city} ${t.nick}`.trim()}
        width={Math.round(size * 0.8)}
        height={Math.round(size * 0.8)}
        loading="lazy"
        className="drop-shadow-[0_2px_6px_rgba(0,0,0,.6)]"
      />
    </span>
  );
}
