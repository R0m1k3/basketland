'use client';

import { useState, type FormEvent } from 'react';
import { MINIMAX_ROLE_LABELS, MINIMAX_ROLES, type MinimaxRole } from '@/lib/minimaxCatalog';
import { postJson } from '@/components/auth/client';
import type { VoxtralSettingsView } from '@/components/page/types';

type Msg = { ok: boolean; text: string } | null;

/** Libellés des voix prédéfinies de Voxtral (les autres gardent leur nom). */
const VOICE_LABELS: Record<string, string> = {
  fr_male: 'Homme français',
  fr_female: 'Femme française',
  neutral_male: 'Homme neutre (anglais)',
  neutral_female: 'Femme neutre (anglais)',
  casual_male: 'Homme décontracté (anglais)',
  casual_female: 'Femme décontractée (anglais)',
  cheerful_female: 'Femme enjouée (anglais)',
};

/**
 * « Voxtral » (administrateurs) : voix prédéfinie de chaque rôle du doublage
 * (les poids ouverts de Voxtral ne clonent pas de voix) et, en option, un
 * serveur Voxtral externe (POST /api/admin/settings { voxtralVoices, voxtralUrl }).
 * Sans adresse, Voxtral tourne dans le conteneur.
 */
export default function VoxtralSettings({ initial }: { initial: VoxtralSettingsView }) {
  const [voices, setVoices] = useState<Record<MinimaxRole, string>>(initial.voices);
  const [url, setUrl] = useState(initial.envUrl ? '' : initial.url);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const body: Record<string, unknown> = { voxtralVoices: voices };
    if (!initial.envUrl) body.voxtralUrl = url.trim() || null;
    const r = await postJson<{ voxtral: VoxtralSettingsView }>('/api/admin/settings', body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setVoices(r.data.voxtral.voices);
    setMsg({ ok: true, text: 'Réglages Voxtral enregistrés : ils servent dès le prochain passage doublé.' });
  }

  return (
    <form onSubmit={submit} className="panel space-y-4 p-5 sm:p-6">
      <div>
        <p className="font-display text-lg font-bold uppercase tracking-wide text-paper">Voxtral</p>
        <p className="mt-0.5 text-sm text-paper-mute">
          Voix de Mistral, choisies dans « Voix du doublage ». Elles tournent dans le conteneur sur la carte graphique (au
          premier doublage, téléchargement du modèle : ~8 Go). Voxtral ne clone pas les voix : chaque rôle prend une voix toute
          faite ; seules « Homme français » et « Femme française » parlent sans accent.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {MINIMAX_ROLES.map((r) => (
          <div key={r}>
            <label htmlFor={`voxtral-voice-${r}`} className="field-label">
              {MINIMAX_ROLE_LABELS[r]}
            </label>
            <select
              id={`voxtral-voice-${r}`}
              className="field"
              value={voices[r]}
              onChange={(e) => setVoices({ ...voices, [r]: e.target.value })}
            >
              {initial.catalog.map((v) => (
                <option key={v} value={v}>
                  {VOICE_LABELS[v] ?? v}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div>
        <label htmlFor="voxtral-url" className="field-label">
          Serveur Voxtral externe (facultatif)
        </label>
        <input
          id="voxtral-url"
          className="field font-mono text-sm"
          value={initial.envUrl ? initial.url : url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={initial.envUrl}
          placeholder="Vide : Voxtral tourne dans le conteneur"
          spellCheck={false}
        />
        <p className="field-hint">
          {initial.envUrl
            ? 'Adresse imposée par la variable VOXTRAL_URL du conteneur.'
            : 'Seulement si Voxtral tourne ailleurs (vLLM-Omni), par exemple http://192.168.1.10:8000/v1.'}
        </p>
      </div>
      {msg && (
        <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={busy}>
        Enregistrer les voix Voxtral
      </button>
    </form>
  );
}
