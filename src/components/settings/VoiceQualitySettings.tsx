'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';
import type { VoiceQuality } from '@/components/page/types';

type Msg = { ok: boolean; text: string } | null;
/** Choix affiché : voix embarquées (standard ou HD) ou MiniMax. */
type VoiceChoice = VoiceQuality | 'minimax';

const OPTIONS: { value: VoiceChoice; title: string; text: string }[] = [
  {
    value: 'standard',
    title: 'Embarquées',
    text: 'Qwen3-TTS 0.6B sur la carte graphique : gratuit, rapide, peu gourmand en mémoire.',
  },
  {
    value: 'hd',
    title: 'Embarquées HD',
    text: 'Qwen3-TTS 1.7B : gratuit, mêmes voix, intonation et timbre plus naturels. Environ 2 fois plus lent, ~4 Go de carte graphique.',
  },
  {
    value: 'minimax',
    title: 'MiniMax',
    text: 'Voix en ligne MiniMax (voix réglées plus bas) : très naturelles, mais consomment le crédit ou le forfait MiniMax.',
  },
];

type Reply = { voiceQuality: VoiceQuality; voiceEngine: 'local' | 'minimax'; voiceQualityOverride?: string | null };

/**
 * « Voix du doublage » (administrateurs) : qui dit les commentaires — voix
 * embarquées (standard ou HD) ou MiniMax — même si une clé MiniMax est
 * enregistrée (POST /api/admin/settings { voiceEngine, voiceQuality }).
 * Vaut pour les prochains passages doublés ; « Relancer le doublage » refait
 * un match. La variable TTS_ENGINE (ou TTS_MODEL) l'emporte.
 */
export default function VoiceQualitySettings({
  initial,
  minimaxKeySet,
  override = null,
}: {
  initial: VoiceChoice;
  minimaxKeySet: boolean;
  override?: string | null;
}) {
  const [choice, setChoice] = useState<VoiceChoice>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(override);

  async function choose(next: VoiceChoice) {
    if (next === choice || busy) return;
    const prev = choice;
    setBusy(true);
    setMsg(null);
    setChoice(next);
    const body = next === 'minimax' ? { voiceEngine: 'minimax' } : { voiceEngine: 'local', voiceQuality: next };
    const r = await postJson<Reply>('/api/admin/settings', body);
    setBusy(false);
    if (!r.ok) {
      setChoice(prev);
      return setMsg({ ok: false, text: r.error });
    }
    setChoice(r.data.voiceEngine === 'minimax' ? 'minimax' : r.data.voiceQuality);
    setOverrideMsg(r.data.voiceQualityOverride ?? null);
    setMsg({
      ok: true,
      text:
        next === 'minimax'
          ? minimaxKeySet
            ? 'Voix MiniMax choisies pour les prochains doublages.'
            : 'Voix MiniMax choisies : enregistrez une clé MiniMax plus bas pour qu’elles fonctionnent.'
          : next === 'hd'
            ? 'Voix embarquées HD choisies pour les prochains doublages. Le modèle (~4 Go) est téléchargé au début du premier doublage.'
            : 'Voix embarquées choisies pour les prochains doublages.',
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
          <p className="mt-0.5 text-sm text-paper-mute">Qui dit les commentaires en français quand un match est doublé.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OPTIONS.map((o) => {
            const checked = choice === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="voice-choice"
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
                      {o.value === 'minimax' && !minimaxKeySet && <span className="text-xs text-paper-faint">(clé requise)</span>}
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
          Vaut pour les prochains passages doublés : « Relancer le doublage » sur la fiche d’un match le refait avec ces voix. Le
          doublage ne part jamais tout seul : seulement avec « Doubler ce match ».
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
