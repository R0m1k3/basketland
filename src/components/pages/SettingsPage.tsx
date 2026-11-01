'use client';

import AccountPanel from '@/components/settings/AccountPanel';
import AutoTranslateSettings from '@/components/settings/AutoTranslateSettings';
import MiniMaxSettings from '@/components/settings/MiniMaxSettings';
import OpenAiSettings from '@/components/settings/OpenAiSettings';
import SubtitleSettings from '@/components/settings/SubtitleSettings';
import UsersAdmin from '@/components/settings/UsersAdmin';
import TranscribeEngineSettings from '@/components/settings/TranscribeEngineSettings';
import FetchParallelSettings from '@/components/settings/FetchParallelSettings';
import ExtraNamesSettings from '@/components/settings/ExtraNamesSettings';
import VoiceQualitySettings from '@/components/settings/VoiceQualitySettings';
import VfModeSettings from '@/components/settings/VfModeSettings';
import { PageData } from '@/components/page/pageData';
import type { SettingsPage as SettingsData } from '@/components/page/types';

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

/**
 * Paramètres : `GET /api/pages/parametres` (compte, réglages de
 * l'administrateur et texte de la version en service). Sans session, la
 * route répond 401 : retour à la connexion.
 */
export default function SettingsPage() {
  return <PageData<SettingsData> url="/api/pages/parametres">{(d) => <Settings d={d} />}</PageData>;
}

function Settings({ d }: { d: SettingsData }) {
  const { user, admin, admin_data: a } = d;

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

      {a && (
        <section aria-labelledby="s-users" className="space-y-5">
          <SectionTitle id="s-users" kicker="Administration">
            Utilisateurs
          </SectionTitle>
          <UsersAdmin initialUsers={a.users} meId={user.id} />
        </section>
      )}

      {a && (
        <section aria-labelledby="s-openai" className="space-y-5">
          <SectionTitle id="s-openai" kicker="Administration">
            Traduction des commentaires
          </SectionTitle>
          <AutoTranslateSettings initial={a.auto_translate} />
          <VfModeSettings initial={a.vf_mode} voiceDisabledReason={a.voice_disabled_reason} />
          <TranscribeEngineSettings initial={a.transcribe_engine} override={a.transcribe_engine_override} />
          <VoiceQualitySettings
            initial={a.voice_engine === 'minimax' ? 'minimax' : (a.voice_quality ?? 'standard')}
            minimaxKeySet={!!a.minimax_key_set}
            override={a.voice_quality_override ?? null}
          />
          <ExtraNamesSettings initial={a.extra_names} />
          <FetchParallelSettings initial={a.fetch_parallel} />
          <MiniMaxSettings initial={a.minimax} initialRepair={a.translate_repair_model} />
          <OpenAiSettings initial={a.openai} placeholderModel={a.openai_model_placeholder} />
        </section>
      )}

      <p className="text-xs leading-relaxed text-paper-faint">{d.version_text}</p>
    </div>
  );
}
