'use client';

import { useState, type FormEvent } from 'react';
import Field from './Field';
import { postJson } from './client';

/** Formulaire de connexion ; redirige ensuite vers la page demandée au départ. */
export default function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ next: string }>('/api/auth/login', { username, password, next });
    if (!r.ok) {
      setError(r.error);
      setBusy(false);
      return;
    }
    // Rechargement complet : l'en-tête (navigation, compte) est rendu côté serveur.
    window.location.assign(r.data.next || '/');
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field
        id="login-username"
        label="Identifiant"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Field
        id="login-password"
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn-primary w-full py-2.5 text-[15px]" disabled={busy || !username || !password}>
        {busy ? 'Connexion…' : 'Se connecter'}
      </button>
    </form>
  );
}
