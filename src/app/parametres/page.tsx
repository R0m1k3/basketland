import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AccountPanel from '@/components/settings/AccountPanel';
import AutoTranslateSettings from '@/components/settings/AutoTranslateSettings';
import OpenAiSettings from '@/components/settings/OpenAiSettings';
import SubtitleSettings from '@/components/settings/SubtitleSettings';
import UsersAdmin from '@/components/settings/UsersAdmin';
import VfModeSettings from '@/components/settings/VfModeSettings';
import { currentSession } from '@/lib/authServer';
import { listUsers } from '@/lib/db';
import { dubDisabledReason } from '@/lib/dub';
import { autoTranslateEnabled, OPENAI_MODEL_PLACEHOLDER, openAiSettingsView, vfMode } from '@/lib/settings';
import { PARIS_TZ } from '@/lib/time';
import { appVersion } from '@/lib/version';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Paramètres' };

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: PARIS_TZ });

/** Version en service : pour vérifier que le serveur tourne sur la dernière image. */
function versionText(): string {
  const { commit, builtAt } = appVersion();
  if (!commit) return 'Numéro de version non renseigné.';
  return `Version ${commit}${builtAt ? ` · image construite le ${dateFmt.format(new Date(builtAt))}` : ''}.`;
}

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

      <section aria-labelledby="s-subtitles" className="space-y-5">
        <SectionTitle id="s-subtitles" kicker="Lecteur">
          Sous-titres
        </SectionTitle>
        <SubtitleSettings />
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
          <AutoTranslateSettings initial={autoTranslateEnabled()} />
          <VfModeSettings initial={vfMode()} voiceDisabledReason={await dubDisabledReason()} />
          <OpenAiSettings initial={openAiSettingsView()} placeholderModel={OPENAI_MODEL_PLACEHOLDER} />
        </section>
      )}

      <p className="text-xs leading-relaxed text-paper-faint">{versionText()}</p>
    </div>
  );
}
