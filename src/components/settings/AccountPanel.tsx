'use client';

import { useState, type FormEvent } from 'react';
import Field from '@/components/auth/Field';
import { logout, postJson } from '@/components/auth/client';
import { IconLogout } from '@/components/ui/Icons';

/** « Mon compte » : identité, changement de mot de passe, déconnexion. */
export default function AccountPanel({ username, role }: { username: string; role: 'admin' | 'user' }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (password.length < 8) return setMsg({ ok: false, text: 'Le mot de passe doit contenir au moins 8 caractères.' });
    if (password !== confirm) return setMsg({ ok: false, text: 'Les mots de passe ne correspondent pas.' });
    setBusy(true);
    const r = await postJson('/api/account/password', { current, password, confirm });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setCurrent('');
    setPassword('');
    setConfirm('');
    setMsg({ ok: true, text: 'Mot de passe modifié. Vos autres sessions ont été déconnectées.' });
  }

  return (
    <div className="panel grid gap-0 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="flex flex-col gap-5 border-b border-ink-700/70 p-5 sm:p-6 md:border-b-0 md:border-r">
        <div className="flex items-center gap-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-flame/15 font-display text-3xl font-extrabold uppercase text-flame-hot"
            aria-hidden="true"
          >
            {username.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="kicker">Connecté en tant que</p>
            <p className="truncate font-display text-2xl font-bold tracking-tight">{username}</p>
          </div>
        </div>
        <div>
          <span className={role === 'admin' ? 'chip-flame' : 'chip'}>{role === 'admin' ? 'Administrateur' : 'Utilisateur'}</span>
        </div>
        <button
          type="button"
          className="btn mt-auto self-start"
          onClick={() => {
            setBusy(true);
            void logout();
          }}
          disabled={busy}
        >
          <IconLogout size={16} />
          Se déconnecter
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4 p-5 sm:p-6" noValidate>
        <h3 className="font-display text-xl font-bold uppercase tracking-tight">Changer de mot de passe</h3>
        <Field
          id="pw-current"
          label="Mot de passe actuel"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="pw-new"
            label="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="8 caractères minimum."
          />
          <Field
            id="pw-confirm"
            label="Confirmation"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !current || !password || !confirm}>
          Enregistrer le mot de passe
        </button>
      </form>
    </div>
  );
}
