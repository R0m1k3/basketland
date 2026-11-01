'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';
import type { VoiceQuality } from '@/components/page/types';

type Msg = { ok: boolean; text: string } | null;

const OPTIONS: { value: VoiceQuality; title: string; text: string }[] = [
  {
    value: 'standard',
    title: 'Standard',
    text: 'Qwen3-TTS 0.6B : rapide, peu gourmand en mémoire de la carte graphique.',
  },
  {
    value: 'hd',
    title: 'HD',
    text: 'Qwen3-TTS 1.7B : mêmes voix, intonation et timbre plus naturels et plus vivants. Environ 2 fois plus lent, ~4 Go de carte graphique.',
  },
];

/**
 * « Voix du doublage » (administrateurs) : taille du modèle des voix
 * embarquées (POST /api/admin/settings { voiceQuality }). Vaut pour les
 * prochains passages doublés ; « Relancer le doublage » refait un match.
 * Sans effet avec les voix MiniMax ou la variable TTS_MODEL.
 */
export default function VoiceQualitySettings({ initial, override = null }: { initial: VoiceQuality; override?: string | null }) {
  const [quality, setQuality] = useState<VoiceQuality>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(override);

  async function choose(next: VoiceQuality) {
    if (next === quality || busy) return;
    const prev = quality;
    setBusy(true);
    setMsg(null);
    setQuality(next);
    const r = await postJson<{ voiceQuality: VoiceQuality; voiceQualityOverride?: string | null }>('/api/admin/settings', { voiceQuality: next });
    setBusy(false);
    if (!r.ok) {
      setQuality(prev);
      return setMsg({ ok: false, text: r.error });
    }
    setQuality(r.data.voiceQuality);
    setOverrideMsg(r.data.voiceQualityOverride ?? null);
    setMsg({
      ok: true,
      text:
        r.data.voiceQuality === 'hd'
          ? 'Voix HD choisies pour les prochains doublages. Le modèle (~4 Go) est téléchargé au début du premier doublage.'
          : 'Voix standard choisies pour les prochains doublages.',
    });
  }

  return (
    <div className="panel overflow-hidden">
      <fieldset className="space-y-4 p-5 sm:p-6" disabled={busy}>
        <legend className="sr-only">Voix du doublage</legend>
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide text-paper" aria-hidden="true">
            Voix du doublage
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">La qualité des voix françaises embarquées qui disent les commentaires.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const checked = quality === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="voice-quality"
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
                      {o.value === 'standard' && <span className="text-xs text-paper-faint">(par défaut)</span>}
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

        {overrideMsg && (
          <p className="form-error" role="alert">
            {overrideMsg}
          </p>
        )}

        <p className="border-t border-ink-700/60 pt-4 text-xs leading-relaxed text-paper-faint">
          Vaut pour les prochains passages doublés : « Relancer le doublage » sur la fiche d’un match le refait avec ces voix.
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
