'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';

type VfMode = 'sous-titres' | 'doublage';
type Msg = { ok: boolean; text: string } | null;

const OPTIONS: { value: VfMode; title: string; text: string; icon: React.ReactNode }[] = [
  {
    value: 'sous-titres',
    title: 'Sous-titres',
    text: 'Les commentaires sont traduits et affichés en sous-titres.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 13h4M13 13h4M7 16h7" />
      </svg>
    ),
  },
  {
    value: 'doublage',
    title: 'Doublage voix',
    text: 'Les commentaires sont traduits puis dits par des voix françaises (le son d’origine est baissé pendant qu’elles parlent). Plus de calcul pour le serveur.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    ),
  },
];

/**
 * « Version française » (administrateurs) : sous-titres ou doublage voix,
 * enregistré aussitôt (POST /api/admin/settings { vfMode }). Le choix reste
 * possible quand le moteur de voix est indisponible : la raison s'affiche.
 */
export default function VfModeSettings({ initial, voiceDisabledReason }: { initial: VfMode; voiceDisabledReason: string | null }) {
  const [mode, setMode] = useState<VfMode>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function choose(next: VfMode) {
    if (next === mode || busy) return;
    const prev = mode;
    setBusy(true);
    setMsg(null);
    setMode(next); // affichage immédiat, annulé si le serveur refuse
    const r = await postJson<{ vfMode: VfMode }>('/api/admin/settings', { vfMode: next });
    setBusy(false);
    if (!r.ok) {
      setMode(prev);
      return setMsg({ ok: false, text: r.error });
    }
    setMode(r.data.vfMode);
    setMsg({
      ok: true,
      text:
        r.data.vfMode === 'doublage'
          ? 'Doublage voix choisi : avec la traduction automatique, les replays traduits sont aussi doublés ; le lecteur part en « VF doublée ».'
          : 'Sous-titres choisis : plus aucun doublage automatique ; « Doubler ce match » reste possible sur la fiche d’un match.',
    });
  }

  return (
    <div className="panel overflow-hidden">
      <fieldset className="space-y-4 p-5 sm:p-6" disabled={busy}>
        <legend className="sr-only">Version française</legend>
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide text-paper" aria-hidden="true">
            Version française
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">Ce que reçoivent les spectateurs : des sous-titres, ou des voix françaises.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const checked = mode === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="vf-mode"
                  value={o.value}
                  checked={checked}
                  onChange={() => void choose(o.value)}
                  className="peer sr-only"
                />
                <span
                  className={`flex h-full gap-3 rounded-xl border p-4 transition peer-focus-visible:ring-2 peer-focus-visible:ring-flame/60 ${
                    checked ? 'border-flame/70 bg-flame/10' : 'border-ink-600 bg-ink-850 hover:border-ink-500'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${checked ? 'bg-flame text-ink-950' : 'bg-ink-800 text-paper-mute'}`}
                  >
                    {o.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`font-semibold ${checked ? 'text-flame-hot' : 'text-paper'}`}>{o.title}</span>
                      {o.value === 'sous-titres' && <span className="text-xs text-paper-faint">(par défaut)</span>}
                    </span>
                    <span className="mt-1 block text-sm leading-relaxed text-paper-dim">{o.text}</span>
                  </span>
                  <span
                    className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-flame' : 'border-ink-500'}`}
                    aria-hidden="true"
                  >
                    {checked && <span className="h-2 w-2 rounded-full bg-flame" />}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {voiceDisabledReason && (
          <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-paper-dim" role="note">
            <strong className="font-semibold text-warn">Moteur de voix indisponible</strong> : {voiceDisabledReason}. Le choix est
            enregistré quand même ; le doublage démarrera quand le moteur sera disponible.
          </p>
        )}

        <div className="space-y-1.5 border-t border-ink-700/60 pt-4 text-xs leading-relaxed text-paper-faint">
          <p>Le doublage part des sous-titres : la traduction des commentaires est donc toujours faite, dans les deux modes.</p>
          <p>
            Match par match, la fiche propose aussi « Sous-titrer ce match » et « Doubler ce match » : quand la traduction automatique est
            désactivée, ou pour doubler un seul match en mode Sous-titres.
          </p>
        </div>

        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
      </fieldset>
    </div>
  );
}
