import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import LoginForm from '@/components/auth/LoginForm';
import { hasUsers } from '@/lib/auth';
import { safeNextPath } from '@/lib/authRoutes';
import { currentSession } from '@/lib/authServer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connexion', robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  // Le middleware fait déjà ces redirections ; on les garde ici par sûreté.
  if (!hasUsers()) redirect('/setup');
  if (await currentSession()) redirect(next);

  return (
    <AuthShell kicker="Accès privé" title="Connexion" intro="Connectez-vous pour accéder aux replays, au calendrier et aux statistiques.">
      <LoginForm next={next} />
      <p className="text-xs leading-relaxed text-paper-faint">
        Mot de passe oublié ? Demandez à un administrateur de le réinitialiser depuis la page Paramètres.
      </p>
    </AuthShell>
  );
}
