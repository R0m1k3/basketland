import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'BasketLand — Replays NBA',
  description:
    'Replays NBA, calendrier complet en heure de Paris, statistiques de match et de joueurs, sous-titres français synchronisés.',
};

export const viewport: Viewport = {
  themeColor: '#0b0e14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <header className="sticky top-0 z-50 border-b border-slate-800 bg-[#0b0e14]/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/" className="flex items-center gap-2 font-bold text-white">
              <span className="inline-block h-5 w-5 rounded-full bg-court-500" />
              BasketLand
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-300">
              <Link href="/" className="hover:text-white">
                Accueil
              </Link>
              <Link href="/matchs" className="hover:text-white">
                Matchs
              </Link>
              <Link href="/classement" className="hover:text-white">
                Classement
              </Link>
            </nav>
            <span className="ml-auto hidden text-xs text-slate-500 sm:block">
              Heure de Paris (Europe/Paris)
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-xs text-slate-600">
          BasketLand — replays NBA. Les vidéos proviennent de sources tierces ; BasketLand ne
          les héberge pas.
        </footer>
      </body>
    </html>
  );
}
