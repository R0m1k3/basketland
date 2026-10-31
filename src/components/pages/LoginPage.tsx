'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import AuthShell from '@/components/auth/AuthShell';
import LoginForm from '@/components/auth/LoginForm';
import type { SessionPage } from '@/components/page/types';

/**
 * Connexion. `GET /api/pages/session?next=` dit s'il existe un compte, si une
 * session est ouverte, et nettoie la destination (`safeNextPath`). Le serveur
 * fait déjà ces redirections ; on les garde ici par sûreté. À rendre sous
 * `<Suspense>` (`useSearchParams`).
 */
export default function LoginPage() {
  const router = useRouter();
  const raw = useSearchParams().get('next');
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const q = raw === null ? '' : `?${new URLSearchParams({ next: raw })}`;
    fetch(`/api/pages/session${q}`, { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<SessionPage>)
      .then((s) => {
        if (!live) return;
        if (!s.has_users) router.replace('/setup');
        else if (s.user) router.replace(s.next);
        else setNext(s.next);
      })
      .catch(() => {
        // Serveur injoignable : le formulaire reste utilisable, il dira l'erreur.
        if (live) setNext('/');
      });
    return () => {
      live = false;
    };
  }, [raw, router]);

  return (
    <AuthShell kicker="Accès privé" title="Connexion" intro="Connectez-vous pour accéder aux replays, au calendrier et aux statistiques.">
      {/* Avant la réponse : `next` brut, que POST /api/auth/login nettoie aussi. */}
      <LoginForm next={next ?? raw ?? '/'} />
      <p className="text-xs leading-relaxed text-paper-faint">
        Mot de passe oublié ? Demandez à un administrateur de le réinitialiser depuis la page Paramètres.
      </p>
    </AuthShell>
  );
}
