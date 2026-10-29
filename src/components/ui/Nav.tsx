'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Accueil', match: (p: string) => p === '/' },
  { href: '/matchs', label: 'Calendrier', match: (p: string) => p.startsWith('/matchs') },
  { href: '/equipes', label: 'Équipes', match: (p: string) => p.startsWith('/equipes') },
  { href: '/classement', label: 'Classement', match: (p: string) => p.startsWith('/classement') },
];

/** Navigation principale : onglet actif souligné par l'accent. */
export default function Nav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav className="scroll-row -mx-1 flex items-center gap-1 overflow-x-auto">
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
            {active && <span className="absolute inset-x-3 -bottom-[9px] h-[2px] rounded-full bg-flame" />}
          </Link>
        );
      })}
    </nav>
  );
}
