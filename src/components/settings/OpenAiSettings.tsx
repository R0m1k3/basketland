'use client';

import { useState, type FormEvent } from 'react';
import type { OpenAiSettingsView } from '@/lib/settings';
import Field from '@/components/auth/Field';
import { postJson } from '@/components/auth/client';
import { IconKey } from '@/components/ui/Icons';

type Msg = { ok: boolean; text: string } | null;

/**
 * « Traduction des commentaires » : clé API OpenAI (en écriture seule —
 * le serveur ne renvoie que sa forme masquée) et modèle.
 */
export default function OpenAiSettings({ initial, placeholderModel }: { initial: OpenAiSettingsView; placeholderModel: string }) {
  const [view, setView] = useState(initial);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(initial.model ?? '');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function save(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    const r = await postJson<{ openai: OpenAiSettingsView }>('/api/admin/settings', body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setView(r.data.openai);
    setModel(r.data.openai.model ?? '');
    setKey('');
    setMsg({ ok: true, text: okText });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { openaiModel: model };
    if (key.trim()) body.openaiApiKey = key;
    void save(body, 'Paramètres de traduction enregistrés.');
  }

  return (
    <div className="panel overflow-hidden">
      <div className="space-y-2 border-b border-ink-700/70 p-5 text-sm leading-relaxed text-paper-dim sm:p-6">
        <p>
          Si une clé est enregistrée, la traduction passe par l&apos;API OpenAI au lieu du modèle local (Ollama). La
          transcription (Whisper) reste locale.
        </p>
        <p className="text-paper-mute">
          Une clé API se crée sur{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-flame-hot underline-offset-2 hover:underline">
            platform.openai.com
          </a>{' '}
          et est facturée à l&apos;usage — ce n&apos;est pas l&apos;abonnement ChatGPT.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5 p-5 sm:p-6" noValidate>
        <div>
          <p className="field-label">Clé API OpenAI</p>
          {view.keySet ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-950/70 px-3.5 py-2.5 font-mono text-sm text-paper">
                <IconKey size={15} className="text-win" />
                {view.keyMasked}
              </span>
              <span className="chip">Traduction via OpenAI</span>
              <button
                type="button"
                className="btn-danger px-3 py-1.5"
                disabled={busy}
                onClick={() => void save({ openaiApiKey: null }, 'Clé supprimée : la traduction repasse par le modèle local.')}
              >
                Supprimer la clé
              </button>
            </div>
          ) : (
            <p className="mb-2 text-sm text-paper-mute">Aucune clé enregistrée : la traduction utilise le modèle local (Ollama).</p>
          )}
          <div className="mt-3">
            <label htmlFor="openai-key" className="sr-only">
              {view.keySet ? 'Remplacer la clé API OpenAI' : 'Clé API OpenAI'}
            </label>
            <input
              id="openai-key"
              className="field font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={view.keySet ? 'Coller une nouvelle clé pour la remplacer' : 'sk-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <p className="field-hint">Enregistrée côté serveur, elle n&apos;est plus jamais affichée en entier.</p>
          </div>
        </div>

        <Field
          id="openai-model"
          label="Modèle OpenAI"
          spellCheck={false}
          autoCapitalize="none"
          placeholder={placeholderModel}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          hint="Utilisé seulement si une clé est enregistrée. Laisser vide pour le modèle par défaut."
        />

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
