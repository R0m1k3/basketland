import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AccountPanel from '@/components/settings/AccountPanel';
import OpenAiSettings from '@/components/settings/OpenAiSettings';
import UsersAdmin from '@/components/settings/UsersAdmin';
import { currentSession } from '@/lib/authServer';
import { listUsers } from '@/lib/db';
import { OPENAI_MODEL_PLACEHOLDER, openAiSettingsView } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Paramètres' };

function SectionTitle({ id, kicker, children }: { id: string; kicker: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="kicker">{kicker}</p>
      <div className="flex items-center gap-4">
        <h2 id={id} className="section-title shrink-0">
          {children}
        </h2>
        <span className="h-px flex-1 bg-gradient-to-r from-ink-600 to-transparent" aria-hidden="true" />
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  const session = await currentSession();
  if (!session) redirect('/login?next=/parametres');
  const { user } = session;
  const admin = user.role === 'admin';

  return (
    <div className="space-y-12">
      <header className="space-y-2">
        <p className="kicker">Compte{admin ? ' · administration' : ''}</p>
        <h1 className="title-xl">Paramètres</h1>
      </header>

      <section aria-labelledby="s-account" className="space-y-5">
        <SectionTitle id="s-account" kicker="Vous">
          Mon compte
        </SectionTitle>
        <AccountPanel username={user.username} role={user.role} />
      </section>

      {admin && (
        <section aria-labelledby="s-users" className="space-y-5">
          <SectionTitle id="s-users" kicker="Administration">
            Utilisateurs
          </SectionTitle>
          <UsersAdmin initialUsers={listUsers()} meId={user.id} />
        </section>
      )}

      {admin && (
        <section aria-labelledby="s-openai" className="space-y-5">
          <SectionTitle id="s-openai" kicker="Administration">
            Traduction des commentaires
          </SectionTitle>
          <OpenAiSettings initial={openAiSettingsView()} placeholderModel={OPENAI_MODEL_PLACEHOLDER} />
        </section>
      )}
    </div>
  );
}
