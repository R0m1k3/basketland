'use client';

import { useCallback, useEffect, useState } from 'react';
import { postJson } from '@/components/auth/client';

interface SessionRow {
  id: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  current: boolean;
}

const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });

/** « Mes appareils » : sessions ouvertes du compte (navigateurs, TV connectées par code), révocables. */
export default function DevicesPanel() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/account/sessions', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      setRows(((await r.json()) as { sessions: SessionRow[] }).sessions);
    } catch {
      setError('Liste des appareils indisponible.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    const r = await postJson('/api/account/sessions', { action: 'revoke', id });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    await load();
  }

  return (
    <div className="panel space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-xl font-bold uppercase tracking-tight">Mes appareils</h3>
        <a href="/appareil" className="text-sm text-flame-hot underline-offset-2 hover:underline">
          Connecter une TV
        </a>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="text-sm text-paper-faint">Chargement…</p>}
      {rows && (
        <ul className="divide-y divide-ink-700/70">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {s.label ?? 'Navigateur'}
                  {s.current && <span className="chip-flame ml-2 align-middle">cet appareil</span>}
                </p>
                <p className="text-xs text-paper-faint">Connecté le {DATE.format(new Date(s.created_at))}</p>
              </div>
              {!s.current && (
                <button type="button" className="btn" onClick={() => void revoke(s.id)} disabled={busy !== null}>
                  {busy === s.id ? 'Déconnexion…' : 'Déconnecter'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
