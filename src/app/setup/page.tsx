import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import SetupForm from '@/components/auth/SetupForm';
import { hasUsers } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Premier démarrage', robots: { index: false } };

export default function SetupPage() {
  // Inaccessible dès qu'un compte existe (le middleware redirige déjà).
  if (hasUsers()) redirect('/login');

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
