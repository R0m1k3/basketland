'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type IconName = 'home' | 'calendar' | 'teams' | 'table';

const LINKS: { href: string; label: string; icon: IconName; match: (p: string) => boolean }[] = [
  { href: '/', label: 'Accueil', icon: 'home', match: (p) => p === '/' },
  { href: '/matchs', label: 'Calendrier', icon: 'calendar', match: (p) => p.startsWith('/matchs') },
  { href: '/equipes', label: 'Équipes', icon: 'teams', match: (p) => p.startsWith('/equipes') },
  { href: '/classement', label: 'Classement', icon: 'table', match: (p) => p.startsWith('/classement') },
];

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
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
    case 'table':
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      );
  }
}

/** Navigation principale (≥ md) : onglets dans l'en-tête, actif souligné par l'accent. */
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
            className={`relative whitespace-nowrap rounded-full px-3 py-1.5 font-display text-[15px] font-semibold uppercase tracking-wider transition ${
              active ? 'bg-ink-800 text-paper' : 'text-paper-mute hover:text-paper'
            }`}
          >
            {l.label}
            {active && <span className="absolute inset-x-3 -bottom-[13px] h-[2px] rounded-full bg-flame" />}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Navigation mobile : barre d'onglets fixe en bas d'écran (les quatre
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
      <div className="mx-auto grid max-w-md grid-cols-4">
        {LINKS.map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition ${
                active ? 'text-flame' : 'text-paper-mute hover:text-paper'
              }`}
            >
              {active && <span className="absolute inset-x-6 top-0 h-[2px] rounded-full bg-flame" />}
              <Icon name={l.icon} />
              <span className="font-display text-[12px]">{l.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
