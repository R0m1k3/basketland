'use client';

import { useState, type FormEvent } from 'react';
import type { PublicUser, UserRole } from '@/lib/db';
import Field from '@/components/auth/Field';
import { postJson } from '@/components/auth/client';

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });
const fmt = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : 'jamais');

const ROLE_LABEL: Record<UserRole, string> = { admin: 'Administrateur', user: 'Utilisateur' };

type Msg = { ok: boolean; text: string } | null;

/** Administration des comptes : liste, ajout, rôle, réinitialisation, suppression. */
export default function UsersAdmin({ initialUsers, meId }: { initialUsers: PublicUser[]; meId: number }) {
  const [users, setUsers] = useState(initialUsers);
  const [msg, setMsg] = useState<Msg>(null);

  /** Action sur un compte ; la réponse renvoie la liste à jour. */
  async function act(body: Record<string, unknown>, okText: string): Promise<boolean> {
    setMsg(null);
    const r = await postJson<{ users: PublicUser[] }>('/api/admin/users', body);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return false;
    }
    setUsers(r.data.users);
    setMsg({ ok: true, text: okText });
    return true;
  }

  return (
    <div className="space-y-6">
      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3 sm:px-5">
          <p className="kicker">Comptes</p>
          <span className="text-xs text-paper-faint">
            {users.length} compte{users.length > 1 ? 's' : ''}
          </span>
        </div>
        <ul>
          {users.map((u) => (
            <UserRowItem key={u.id} user={u} isMe={u.id === meId} act={act} />
          ))}
        </ul>
        {msg && (
          <div className="border-t border-ink-700/70 px-4 py-3 sm:px-5">
            <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
              {msg.text}
            </p>
          </div>
        )}
      </div>

      <AddUserForm onCreated={setUsers} />
    </div>
  );
}

function UserRowItem({
  user,
  isMe,
  act,
}: {
  user: PublicUser;
  isMe: boolean;
  act: (body: Record<string, unknown>, okText: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'idle' | 'reset' | 'delete'>('idle');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    const ok = await act(body, okText);
    setBusy(false);
    if (ok) {
      setMode('idle');
      setPassword('');
    }
  }

  function submitReset(e: FormEvent) {
    e.preventDefault();
    void run({ action: 'reset-password', id: user.id, password }, `Mot de passe de ${user.username} réinitialisé ; ses sessions ont été fermées.`);
  }

  return (
    <li className="border-t border-ink-700/60 px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold text-paper">{user.username}</span>
            {isMe && <span className="chip">vous</span>}
          </p>
          <p className="mt-1 text-xs text-paper-faint">
            Créé le {fmt(user.created_at)} · Dernière connexion : {fmt(user.last_login_at)}
          </p>
        </div>
        <label className="sr-only" htmlFor={`role-${user.id}`}>
          Rôle de {user.username}
        </label>
        <select
          id={`role-${user.id}`}
          className="field w-auto py-2 pr-8 text-sm"
          value={user.role}
          disabled={busy}
          onChange={(e) => void run({ action: 'set-role', id: user.id, role: e.target.value }, `Rôle de ${user.username} modifié.`)}
        >
          <option value="admin">{ROLE_LABEL.admin}</option>
          <option value="user">{ROLE_LABEL.user}</option>
        </select>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn px-3 py-1.5" onClick={() => setMode(mode === 'reset' ? 'idle' : 'reset')} disabled={busy}>
            Mot de passe
          </button>
          {!isMe && (
            <button type="button" className="btn-danger px-3 py-1.5" onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')} disabled={busy}>
              Supprimer
            </button>
          )}
        </div>
      </div>

      {mode === 'reset' && (
        <form onSubmit={submitReset} className="mt-4 rounded-xl bg-ink-850/70 p-3 sm:p-4" noValidate>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <Field
                id={`reset-${user.id}`}
                label={`Nouveau mot de passe pour ${user.username}`}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex gap-2 py-0.5">
              <button type="submit" className="btn-primary" disabled={busy || password.length < 8}>
                Réinitialiser
              </button>
              <button type="button" className="btn-ghost" onClick={() => setMode('idle')}>
                Annuler
              </button>
            </div>
          </div>
          <p className="field-hint">8 caractères minimum. Ses sessions ouvertes seront fermées.</p>
        </form>
      )}

      {mode === 'delete' && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-loss/30 bg-loss/5 p-3 sm:p-4">
          <p className="min-w-0 flex-1 basis-56 text-sm text-paper-dim">
            Supprimer définitivement le compte <strong className="text-paper">{user.username}</strong> ?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => void run({ action: 'delete', id: user.id }, `Compte ${user.username} supprimé.`)}
            >
              Confirmer la suppression
            </button>
            <button type="button" className="btn-ghost" onClick={() => setMode('idle')}>
              Annuler
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AddUserForm({ onCreated }: { onCreated: (users: PublicUser[]) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const r = await postJson<{ users: PublicUser[] }>('/api/admin/users', { action: 'create', username, password, role });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    onCreated(r.data.users);
    setMsg({ ok: true, text: `Compte ${username.trim().toLowerCase()} créé.` });
    setUsername('');
    setPassword('');
    setRole('user');
  }

  return (
    <form onSubmit={submit} className="panel-soft space-y-4 p-4 sm:p-5" noValidate>
      <h3 className="font-display text-xl font-bold uppercase tracking-tight">Ajouter un utilisateur</h3>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field
          id="new-username"
          label="Identifiant"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint="3 à 32 caractères : a-z, 0-9, . _ -"
        />
        <Field
          id="new-password"
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="8 caractères minimum."
        />
        <div>
          <label htmlFor="new-role" className="field-label">
            Rôle
          </label>
          <select id="new-role" className="field" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="user">{ROLE_LABEL.user}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </select>
        </div>
      </div>
      {msg && (
        <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={busy || !username || password.length < 8}>
        {busy ? 'Création…' : 'Créer le compte'}
      </button>
    </form>
  );
}
