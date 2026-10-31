'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';

type Msg = { ok: boolean; text: string } | null;

const DEFAULT = 16;
const OPTIONS: { value: number; hint: string }[] = [
  { value: 4, hint: 'ménage la connexion' },
  { value: 8, hint: '' },
  { value: 16, hint: 'par défaut' },
  { value: 24, hint: '' },
  { value: 32, hint: 'le plus rapide' },
];

/**
 * « Téléchargement de l'audio » (administrateurs) : nombre de connexions
 * simultanées vers ok.ru pour l'audio d'un tronçon à traduire, enregistré
 * aussitôt (POST /api/admin/settings { fetchParallel }). ok.ru bride chaque
 * connexion : plus il y en a, plus la traduction prend d'avance, mais plus
 * elle prend de débit à la lecture vidéo. Vaut dès le tronçon suivant.
 */
export default function FetchParallelSettings({ initial }: { initial: number }) {
  const [value, setValue] = useState<number>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function choose(next: number) {
    if (next === value || busy) return;
    const prev = value;
    setBusy(true);
    setMsg(null);
    setValue(next); // affichage immédiat, annulé si le serveur refuse
    const r = await postJson<{ fetchParallel: number }>('/api/admin/settings', { fetchParallel: next });
    setBusy(false);
    if (!r.ok) {
      setValue(prev);
      return setMsg({ ok: false, text: r.error });
    }
    setValue(r.data.fetchParallel);
    setMsg({ ok: true, text: `${r.data.fetchParallel} connexions simultanées, dès le prochain tronçon.` });
  }

  return (
    <div className="panel overflow-hidden">
      <fieldset className="space-y-4 p-5 sm:p-6" disabled={busy}>
        <legend className="sr-only">Téléchargement de l’audio</legend>
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide text-paper" aria-hidden="true">
            Téléchargement de l’audio
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">
            Connexions ouvertes en même temps vers ok.ru pour récupérer le son à traduire. ok.ru limite chaque connexion :
            plus il y en a, plus la traduction prend d’avance.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {OPTIONS.map((o) => {
            const checked = value === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="fetch-parallel"
                  value={o.value}
                  checked={checked}
                  onChange={() => void choose(o.value)}
                  className="peer sr-only"
                />
                <span
                  className={`flex h-full flex-col items-center justify-center rounded-xl border px-2 py-3 text-center transition peer-focus-visible:ring-2 peer-focus-visible:ring-flame/60 ${
                    checked ? 'border-flame/70 bg-flame/10' : 'border-ink-600 bg-ink-850 hover:border-ink-500'
                  }`}
                >
                  <span className={`text-lg font-semibold tabular-nums ${checked ? 'text-flame-hot' : 'text-paper'}`}>
                    {o.value}
                  </span>
                  <span className="text-xs text-paper-faint">{o.hint || ' '}</span>
                </span>
              </label>
            );
          })}
        </div>

        {!OPTIONS.some((o) => o.value === value) && (
          <p className="text-sm text-paper-dim">Réglage actuel : {value} connexions.</p>
        )}

        <p className="border-t border-ink-700/60 pt-4 text-xs leading-relaxed text-paper-faint">
          Si la vidéo saccade pendant une traduction, baissez ce nombre. Défaut : {DEFAULT} (ou la variable
          COMMENTARY_FETCH_PARALLEL du conteneur).
        </p>

        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
      </fieldset>
    </div>
  );
}
