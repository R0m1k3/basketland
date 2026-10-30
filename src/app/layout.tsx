import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Barlow_Condensed, Inter } from 'next/font/google';
import Logo from '@/components/ui/Logo';
import Nav, { BottomNav } from '@/components/ui/Nav';
import UserMenu from '@/components/ui/UserMenu';
import { currentSession } from '@/lib/authServer';
import './globals.css';

const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'BasketLand — Replays NBA en VF', template: '%s · BasketLand' },
  description:
    'Replays NBA, calendrier complet en heure de Paris, statistiques de match et de joueurs, sous-titres français synchronisés.',
};

export const viewport: Viewport = {
  themeColor: '#0B0B0E',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Hors session (connexion, premier démarrage) : en-tête réduit au logo,
  // sans navigation — tous les liens mèneraient à la page de connexion.
  const session = await currentSession();
  return (
    <html lang="fr" className={`${display.variable} ${sans.variable}`}>
      <body>
        <header className="sticky top-0 z-50 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:gap-8">
            {session ? (
              <Link href="/" className="shrink-0" aria-label="BasketLand, accueil">
                <Logo />
              </Link>
            ) : (
              <span className="shrink-0">
                <Logo />
              </span>
            )}
            <div className="min-w-0 flex-1">{session && <Nav />}</div>
            {session && (
              <>
                <span className="hidden shrink-0 items-center gap-1.5 text-xs text-paper-faint xl:flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-win" />
                  Heures de Paris
                </span>
                <UserMenu username={session.user.username} />
              </>
            )}
          </div>
        </header>
        <main className={`mx-auto max-w-7xl px-4 pt-6 sm:pt-8 ${session ? 'pb-28 md:pb-16' : 'pb-16'}`}>{children}</main>
        <footer className={`border-t border-ink-700/60 ${session ? 'pb-20 md:pb-0' : ''}`}>
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-paper-faint">
            <span>BasketLand — replays NBA avec VF synchronisée.</span>
            <span>Les vidéos proviennent de sources tierces ; BasketLand ne les héberge pas.</span>
          </div>
        </footer>
        {session && <BottomNav />}
      </body>
    </html>
  );
}
