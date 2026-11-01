'use client';

import { useState, type FormEvent } from 'react';
import { postJson } from '@/components/auth/client';

type Msg = { ok: boolean; text: string } | null;

/**
 * « Noms à respecter » (administrateurs) : commentateurs, surnoms, anciens
 * joueurs… que la transcription écorche. Ils s'ajoutent aux effectifs et
 * entraîneurs des deux équipes (pris automatiquement) pour la transcription
 * et la traduction (POST /api/admin/settings { extraNames }).
 */
export default function ExtraNamesSettings({ initial }: { initial: string }) {
  const [names, setNames] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await postJson<{ extraNames: string }>('/api/admin/settings', { extraNames: names });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setNames(r.data.extraNames);
    setMsg({ ok: true, text: 'Noms enregistrés : ils servent dès la prochaine traduction.' });
  }

  return (
    <form onSubmit={submit} className="panel space-y-4 p-5 sm:p-6">
      <div>
        <p className="font-display text-lg font-bold uppercase tracking-wide text-paper">Noms à respecter</p>
        <p className="mt-0.5 text-sm text-paper-mute">
          Les joueurs et entraîneurs des deux équipes sont pris automatiquement. Ajoutez ici les commentateurs, les surnoms
          et les autres noms souvent écorchés, un par ligne.
        </p>
      </div>
      <div>
        <label htmlFor="extra-names" className="field-label">
          Noms
        </label>
        <textarea
          id="extra-names"
          className="field min-h-[7rem] font-mono text-sm"
          value={names}
          onChange={(e) => setNames(e.target.value)}
          maxLength={4000}
          placeholder={'Kevin Ray\nEddie Johnson\nJoker (Nikola Jokic)'}
          spellCheck={false}
        />
        <p className="field-hint">Un nom par ligne, ou séparés par des virgules.</p>
      </div>
      {msg && (
        <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={busy}>
        Enregistrer les noms
      </button>
    </form>
  );
}
