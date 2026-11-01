'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';
import type { TranslateSettingsView } from '@/components/page/types';

type Msg = { ok: boolean; text: string } | null;
type Engine = 'local' | 'minimax' | 'openai';

const OPTIONS: { value: Engine; title: string; text: string }[] = [
  {
    value: 'local',
    title: 'Embarqué',
    text: 'Un modèle installé dans le conteneur (Ollama), sur la carte graphique : gratuit et sans limite. Modèle au choix ci-dessous.',
  },
  {
    value: 'minimax',
    title: 'MiniMax',
    text: 'Modèle texte MiniMax en ligne (clé et modèle réglés dans le panneau MiniMax) : consomme le forfait MiniMax.',
  },
  {
    value: 'openai',
    title: 'OpenAI',
    text: 'Modèle OpenAI en ligne (clé réglée dans le panneau OpenAI) : facturé à l’usage.',
  },
];

/**
 * « Moteur de traduction » (administrateurs) : qui traduit les commentaires
 * — un modèle embarqué (Ollama : TranslateGemma, Gemma 4, Hunyuan-MT…),
 * MiniMax ou OpenAI (POST /api/admin/settings { translateEngine,
 * translateLocalModel }). Vaut pour les prochaines traductions.
 */
export default function TranslationEngineSettings({ initial }: { initial: TranslateSettingsView }) {
  const [view, setView] = useState(initial);
  const [model, setModel] = useState(initial.localModel);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const known = view.models.some((m) => m.id === model);

  async function save(body: Record<string, unknown>, text: string) {
    setBusy(true);
    setMsg(null);
    const r = await postJson<{ translate: TranslateSettingsView }>('/api/admin/settings', body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setView(r.data.translate);
    setModel(r.data.translate.localModel);
    const fallback =
      r.data.translate.engine !== body.translateEngine && body.translateEngine
        ? ` Attention : sans clé, la traduction passe par « ${r.data.translate.engine === 'local' ? 'Embarqué' : r.data.translate.engine} ».`
        : '';
    setMsg({ ok: true, text: text + fallback });
  }

  return (
    <div className="panel overflow-hidden">
      <fieldset className="space-y-4 p-5 sm:p-6" disabled={busy}>
        <legend className="sr-only">Moteur de traduction</legend>
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide text-paper" aria-hidden="true">
            Moteur de traduction
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">
            Qui traduit les commentaires en français. En service : <span className="text-paper">{view.model}</span>.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {OPTIONS.map((o) => {
            const checked = view.engine === o.value;
            return (
              <label key={o.value} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="translate-engine"
                  value={o.value}
                  checked={checked}
                  onChange={() => void save({ translateEngine: o.value }, `Traduction par « ${o.title} » pour les prochains matchs.`)}
                  className="peer sr-only"
                />
                <span
                  className={`flex h-full gap-3 rounded-xl border p-4 transition peer-focus-visible:ring-2 peer-focus-visible:ring-flame/60 ${
                    checked ? 'border-flame/70 bg-flame/10' : 'border-ink-600 bg-ink-850 hover:border-ink-500'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`font-semibold ${checked ? 'text-flame-hot' : 'text-paper'}`}>{o.title}</span>
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

        <div>
          <label htmlFor="translate-local-model" className="field-label">
            Modèle embarqué
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select id="translate-local-model" className="field" value={known ? model : '__autre'} onChange={(e) => setModel(e.target.value === '__autre' ? '' : e.target.value)}>
              {view.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="__autre">Autre modèle Ollama…</option>
            </select>
            {!known && (
              <input
                aria-label="Nom du modèle Ollama"
                className="field font-mono text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gemma4:12b"
                spellCheck={false}
              />
            )}
            <button
              type="button"
              className="btn-primary shrink-0"
              disabled={busy || !model.trim()}
              onClick={() => void save({ translateLocalModel: model.trim() }, `Modèle embarqué « ${model.trim()} » enregistré.`)}
            >
              Utiliser ce modèle
            </button>
          </div>
          <p className="field-hint">
            Téléchargé au premier usage (plusieurs Go). Gemma 4 et TranslateGemma reçoivent les consignes basket et la liste des
            joueurs ; Hunyuan-MT, spécialiste de la traduction, traduit phrase par phrase sans ces consignes. Un changement de
            modèle vaut pour les prochaines traductions (« Relancer la traduction » refait un match).
          </p>
        </div>

        {view.override && (
          <p className="form-error" role="alert">
            {view.override}
          </p>
        )}

        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
      </fieldset>
    </div>
  );
}
