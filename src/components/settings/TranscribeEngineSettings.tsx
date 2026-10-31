'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';
import type { TranscribeEngine } from '@/components/page/types';

type Msg = { ok: boolean; text: string } | null;

const OPTIONS: { value: TranscribeEngine; title: string; text: string }[] = [
  {
    value: 'whisper',
    title: 'Whisper',
    text: 'OpenAI Whisper large-v3-turbo. Reçoit la liste des joueurs du match : les noms propres sont les mieux reconnus.',
  },
  {
    value: 'nvidia',
    title: 'NVIDIA Parakeet',
    text: 'Parakeet TDT 0.6B, bien plus rapide sur la carte graphique : la traduction prend plus d’avance sur la lecture. Les noms des joueurs sont corrigés après coup.',
  },
];

/**
 * « Transcription des commentateurs » (administrateurs) : moteur embarqué qui
 * transcrit l'audio anglais avant la traduction, enregistré aussitôt
 * (POST /api/admin/settings { transcribeEngine }). Vaut pour les prochaines
 * traductions ; une piste déjà faite garde son moteur (« Relancer la
 * traduction » la refait).
 */
export default function TranscribeEngineSettings({ initial }: { initial: TranscribeEngine }) {
  const [engine, setEngine] = useState<TranscribeEngine>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function choose(next: TranscribeEngine) {
    if (next === engine || busy) return;
    const prev = engine;
    setBusy(true);
    setMsg(null);
    setEngine(next); // affichage immédiat, annulé si le serveur refuse
    const r = await postJson<{ transcribeEngine: TranscribeEngine }>('/api/admin/settings', { transcribeEngine: next });
    setBusy(false);
    if (!r.ok) {
      setEngine(prev);
      return setMsg({ ok: false, text: r.error });
    }
    setEngine(r.data.transcribeEngine);
    setMsg({
      ok: true,
      text:
        r.data.transcribeEngine === 'nvidia'
          ? 'NVIDIA Parakeet choisi pour les prochaines traductions (modèle téléchargé au premier usage).'
          : 'Whisper choisi pour les prochaines traductions.',
    });
  }

  return (
    <div className="panel overflow-hidden">
      <fieldset className="space-y-4 p-5 sm:p-6" disabled={busy}>
        <legend className="sr-only">Transcription des commentateurs</legend>
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide text-paper" aria-hidden="true">
            Transcription des commentateurs
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">Le moteur qui écoute les commentaires anglais avant leur traduction.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const checked = engine === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="transcribe-engine"
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
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`font-semibold ${checked ? 'text-flame-hot' : 'text-paper'}`}>{o.title}</span>
                      {o.value === 'whisper' && <span className="text-xs text-paper-faint">(par défaut)</span>}
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

        <p className="border-t border-ink-700/60 pt-4 text-xs leading-relaxed text-paper-faint">
          Vaut pour les prochaines traductions : une piste déjà traduite garde son moteur (« Relancer la traduction » sur la fiche
          d’un match la refait). Sans effet quand la transcription passe par un serveur externe (TRANSCRIBE_URL).
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
