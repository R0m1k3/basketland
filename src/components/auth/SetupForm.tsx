'use client';

import { useState, type FormEvent } from 'react';
import Field from './Field';
import { postJson } from './client';

/** Premier démarrage : création du compte administrateur. */
export default function SetupForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError('Le mot de passe doit contenir au moins 8 caractères.');
    if (password !== confirm) return setError('Les mots de passe ne correspondent pas.');
    setBusy(true);
    const r = await postJson('/api/auth/setup', { username, password, confirm });
    if (!r.ok) {
      setError(r.error);
      setBusy(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field
        id="setup-username"
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
        hint="3 à 32 caractères : lettres minuscules, chiffres, point, tiret."
      />
      <Field
        id="setup-password"
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="8 caractères minimum."
      />
      <Field
        id="setup-confirm"
        label="Confirmation"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn-primary w-full py-2.5 text-[15px]" disabled={busy || !username || !password || !confirm}>
        {busy ? 'Création…' : 'Créer le compte administrateur'}
      </button>
    </form>
  );
}
