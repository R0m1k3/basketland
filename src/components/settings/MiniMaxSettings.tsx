'use client';

import { useState, type FormEvent } from 'react';
import type { MinimaxSettingsView } from '@/lib/settings';
import {
  MINIMAX_FRENCH_VOICES,
  MINIMAX_MODELS,
  MINIMAX_ROLE_LABELS,
  MINIMAX_ROLES,
  MINIMAX_TEXT_MODELS,
  type MinimaxRole,
} from '@/lib/minimaxCatalog';
import { postJson } from '@/components/auth/client';
import { IconKey } from '@/components/ui/Icons';

type Msg = { ok: boolean; text: string } | null;

/**
 * « MiniMax » (administrateurs) : clé API MiniMax (en écriture seule —
 * le serveur ne renvoie que sa forme masquée), modèle de voix et voix
 * française de chaque rôle du doublage, et traduction des commentaires par
 * un modèle texte MiniMax (même clé).
 */
export default function MiniMaxSettings({ initial }: { initial: MinimaxSettingsView }) {
  const [view, setView] = useState(initial);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(initial.model);
  const [voices, setVoices] = useState<Record<MinimaxRole, string>>(initial.voices);
  const [translate, setTranslate] = useState(initial.translate);
  const [translateModel, setTranslateModel] = useState(initial.translateModel);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const active = view.keySet || view.envKey;

  async function save(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    const r = await postJson<{ minimax: MinimaxSettingsView }>('/api/admin/settings', body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setView(r.data.minimax);
    setModel(r.data.minimax.model);
    setVoices(r.data.minimax.voices);
    setTranslate(r.data.minimax.translate);
    setTranslateModel(r.data.minimax.translateModel);
    setKey('');
    setMsg({ ok: true, text: okText });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { minimaxModel: model, minimaxVoices: voices, minimaxTranslate: translate, minimaxTranslateModel: translateModel };
    if (key.trim()) body.minimaxApiKey = key;
    void save(body, 'Réglages MiniMax enregistrés : ils servent dès le prochain doublage.');
  }

  return (
    <div className="panel overflow-hidden">
      <div className="space-y-2 border-b border-ink-700/70 p-5 text-sm leading-relaxed text-paper-dim sm:p-6">
        <p className="font-display text-lg font-bold uppercase tracking-wide text-paper">MiniMax</p>
        <p>
          Si une clé est enregistrée, les voix du doublage passent par MiniMax (voix françaises de son catalogue) au lieu du
          moteur local : rien à télécharger, et la carte graphique reste libre pour la traduction. La traduction peut aussi y
          passer (interrupteur plus bas).
        </p>
        <p className="text-paper-mute">
          Une clé API se crée sur{' '}
          <a href="https://platform.minimax.io" target="_blank" rel="noreferrer" className="text-flame-hot underline-offset-2 hover:underline">
            platform.minimax.io
          </a>{' '}
          (Account Management → API Keys). La consommation se compte en caractères : de l&apos;ordre de 60 000 à 100 000 par
          match doublé.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5 p-5 sm:p-6" noValidate>
        <div>
          <p className="field-label">Clé API MiniMax</p>
          {view.keySet ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-950/70 px-3.5 py-2.5 font-mono text-sm text-paper">
                <IconKey size={15} className="text-win" />
                {view.keyMasked}
              </span>
              <span className="chip">Voix via MiniMax</span>
              <button
                type="button"
                className="btn-danger px-3 py-1.5"
                disabled={busy}
                onClick={() =>
                  void save(
                    { minimaxApiKey: null },
                    view.envKey ? 'Clé supprimée : la clé de la variable MINIMAX_API_KEY reprend le relais.' : 'Clé supprimée : le doublage repasse par le moteur local.',
                  )
                }
              >
                Supprimer la clé
              </button>
            </div>
          ) : view.envKey ? (
            <p className="mb-2 text-sm text-paper-mute">Clé fournie par la variable MINIMAX_API_KEY du serveur : voix via MiniMax.</p>
          ) : (
            <p className="mb-2 text-sm text-paper-mute">Aucune clé enregistrée : le doublage utilise le moteur local (Qwen3-TTS).</p>
          )}
          <div className="mt-3">
            <label htmlFor="minimax-key" className="sr-only">
              {view.keySet ? 'Remplacer la clé API MiniMax' : 'Clé API MiniMax'}
            </label>
            <input
              id="minimax-key"
              className="field font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={view.keySet ? 'Coller une nouvelle clé pour la remplacer' : 'Clé API MiniMax'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <p className="field-hint">Enregistrée côté serveur, elle n&apos;est plus jamais affichée en entier.</p>
          </div>
        </div>

        <div>
          <label htmlFor="minimax-model" className="field-label">
            Modèle de voix
          </label>
          <select id="minimax-model" className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            {MINIMAX_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {MINIMAX_ROLES.map((r) => (
            <div key={r}>
              <label htmlFor={`minimax-voice-${r}`} className="field-label">
                {MINIMAX_ROLE_LABELS[r]}
              </label>
              <select
                id={`minimax-voice-${r}`}
                className="field"
                value={voices[r]}
                onChange={(e) => setVoices((v) => ({ ...v, [r]: e.target.value }))}
              >
                {!MINIMAX_FRENCH_VOICES.some((v) => v.id === voices[r]) && <option value={voices[r]}>{voices[r]}</option>}
                {MINIMAX_FRENCH_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="space-y-4 border-t border-ink-700/70 pt-5">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p id="minimax-translate-label" className="field-label !mb-0.5">
                Traduction des commentaires par MiniMax
              </p>
              <p className="text-sm text-paper-mute">
                La traduction passe par un modèle texte MiniMax (même clé) au lieu du modèle local ou d&apos;OpenAI. La transcription
                (Whisper) reste locale.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={translate}
              aria-labelledby="minimax-translate-label"
              onClick={() => setTranslate((t) => !t)}
              disabled={busy}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 disabled:cursor-wait disabled:opacity-70 ${
                translate ? 'border-flame bg-flame' : 'border-ink-500 bg-ink-800'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full shadow-[0_1px_3px_rgba(0,0,0,.5)] transition-transform ${translate ? 'translate-x-[22px] bg-ink-950' : 'translate-x-[3px] bg-paper-dim'}`}
                aria-hidden="true"
              />
            </button>
          </div>
          {translate && (
            <div>
              <label htmlFor="minimax-translate-model" className="field-label">
                Modèle de traduction
              </label>
              <select id="minimax-translate-model" className="field" value={translateModel} onChange={(e) => setTranslateModel(e.target.value)}>
                {MINIMAX_TEXT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!active && <p className="field-hint">Voix et traduction MiniMax servent une fois une clé enregistrée.</p>}

        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          Enregistrer
        </button>
      </form>
    </div>
  );
}
