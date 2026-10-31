'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import AuthShell from '@/components/auth/AuthShell';
import SetupForm from '@/components/auth/SetupForm';
import type { SessionPage } from '@/components/page/types';

/**
 * Premier démarrage : création du compte administrateur. Inaccessible dès
 * qu'un compte existe (le serveur redirige déjà ; `GET /api/pages/session`
 * le redit ici par sûreté).
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    let live = true;
    fetch('/api/pages/session', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<SessionPage>)
      .then((s) => {
        if (live && s.has_users) router.replace('/login');
      })
      .catch(() => {
        /* serveur injoignable : le formulaire dira l'erreur */
      });
    return () => {
      live = false;
    };
  }, [router]);

  return (
    <AuthShell
      kicker="Premier démarrage"
      title="Compte administrateur"
      intro="Bienvenue sur BasketLand. Créez le compte administrateur : il pourra ensuite ajouter d'autres utilisateurs depuis la page Paramètres."
    >
      <SetupForm />
    </AuthShell>
  );
}
