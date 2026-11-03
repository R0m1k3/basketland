'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type IconName = 'home' | 'calendar' | 'teams' | 'table' | 'cup' | 'ball';

/** `short` : libellé de la barre mobile (six onglets sur un écran étroit). */
const LINKS: { href: string; label: string; short: string; icon: IconName; match: (p: string) => boolean }[] = [
  { href: '/', label: 'Accueil', short: 'Accueil', icon: 'home', match: (p) => p === '/' },
  { href: '/matchs', label: 'Calendrier', short: 'Matchs', icon: 'calendar', match: (p) => p.startsWith('/matchs') },
  { href: '/nba-cup', label: 'NBA Cup', short: 'NBA Cup', icon: 'cup', match: (p) => p.startsWith('/nba-cup') },
  { href: '/equipes', label: 'Équipes', short: 'Équipes', icon: 'teams', match: (p) => p.startsWith('/equipes') },
  { href: '/classement', label: 'Classement', short: 'Classement', icon: 'table', match: (p) => p.startsWith('/classement') },
  { href: '/euroleague', label: 'Euroleague', short: 'Euroleague', icon: 'ball', match: (p) => p.startsWith('/euroleague') },
];

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20h14V9.5" />
          <path d="M10 20v-5h4v5" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
      );
    case 'teams':
      return (
        <svg {...common}>
          <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z" />
        </svg>
      );
    case 'cup':
      return (
        <svg {...common}>
          <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
          <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" />
          <path d="M12 13v4M8.5 20h7M10 17h4" />
        </svg>
      );
    case 'ball':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5v17" />
          <path d="M6 6c2.2 1.6 3.5 3.6 3.5 6S8.2 16.4 6 18M18 6c-2.2 1.6-3.5 3.6-3.5 6s1.3 4.4 3.5 6" />
        </svg>
      );
    case 'table':
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      );
  }
}

/** Navigation principale (≥ md) : onglets dans l'en-tête, actif souligné par l'accent (posé sur le filet de l'en-tête). */
export default function Nav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav className="hidden items-center gap-1 md:flex" aria-label="Navigation principale">
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`relative whitespace-nowrap rounded-md px-3 py-1.5 font-display text-base font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
              active ? 'text-paper' : 'text-paper-mute hover:text-paper'
            }`}
          >
            {l.label}
            {active && <span className="absolute inset-x-3 -bottom-4 h-0.5 rounded-full bg-flame" />}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Navigation mobile : barre d'onglets fixe en bas d'écran (les six
 * entrées tiennent toujours, sans défilement horizontal).
 *
 * Elle doit être rendue HORS de l'en-tête : le `backdrop-filter` de
 * celui-ci crée un bloc conteneur, et un `position: fixed` à l'intérieur
 * serait positionné par rapport à l'en-tête au lieu de l'écran.
 */
export function BottomNav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-ink-700/80 bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      aria-label="Navigation principale"
    >
      <div className="mx-auto grid max-w-md grid-cols-6">
        {LINKS.map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-w-0 flex-col items-center gap-1 py-2 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                active ? 'text-flame' : 'text-paper-mute hover:text-paper'
              }`}
            >
              {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-flame" />}
              <Icon name={l.icon} />
              <span className="max-w-full truncate px-0.5 font-display text-xs">{l.short}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
