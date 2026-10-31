'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import Logo from '@/components/ui/Logo';
import Nav, { BottomNav } from '@/components/ui/Nav';
import UserMenu from '@/components/ui/UserMenu';
import type { SessionPage } from '@/components/page/types';

/**
 * En-tête, contenu et pied de page de toutes les pages. La session est lue
 * une fois par chargement complet (`GET /api/pages/session`) : connexion et
 * déconnexion rechargent la page entière.
 *
 * Hors session (connexion, premier démarrage) : en-tête réduit au logo,
 * sans navigation — tous les liens mèneraient à la page de connexion. Tant
 * que la session n'est pas lue, même en-tête réduit.
 */
export default function SiteShell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionPage['user']>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/pages/session', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<SessionPage>) : null))
      .then((s) => live && s && setUser(s.user))
      .catch(() => {
        /* serveur injoignable : en-tête réduit, la page dit le reste */
      });
    return () => {
      live = false;
    };
  }, []);

  const session = user !== null;
  return (
    <>
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
              <UserMenu username={user.username} />
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
    </>
  );
}
