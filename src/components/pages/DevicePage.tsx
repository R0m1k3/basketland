'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import AuthShell from '@/components/auth/AuthShell';
import Field from '@/components/auth/Field';
import { postJson } from '@/components/auth/client';

interface Device {
  name: string;
  ip: string;
}

/**
 * Validation du code affiché par une TV (server/src/device_auth.rs) : saisie du
 * code, puis confirmation après avoir vu quel appareil demande l'accès. La TV
 * reçoit une session à votre nom ; on la déconnecte depuis Paramètres → Mes appareils.
 */
export default function DevicePage() {
  const [code, setCode] = useState(useSearchParams().get('code') ?? '');
  const [device, setDevice] = useState<Device | null>(null);
  const [done, setDone] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<Device>('/api/auth/device/check', { code });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDevice(r.data);
  }

  async function approve() {
    setBusy(true);
    setError(null);
    const r = await postJson<Device>('/api/auth/device/approve', { code });
    setBusy(false);
    if (!r.ok) {
      setDevice(null);
      return setError(r.error);
    }
    setDone(r.data);
  }

  if (done) {
    return (
      <AuthShell kicker="Appareil connecté" title="C’est fait">
        <p className="text-[15px] leading-relaxed text-paper-dim">
          <strong className="text-paper">{done.name}</strong> est connecté à votre compte. Vous pouvez le déconnecter à tout moment depuis
          Paramètres → Mes appareils.
        </p>
        <a href="/" className="btn-primary w-full py-2.5 text-center text-[15px]">
          Retour à l’accueil
        </a>
      </AuthShell>
    );
  }

  if (device) {
    return (
      <AuthShell kicker="Connecter une TV" title="Confirmer">
        <div className="space-y-2 rounded-2xl bg-ink-800 p-4">
          <p className="font-display text-2xl font-bold">{device.name}</p>
          {device.ip !== 'inconnue' && <p className="text-sm text-paper-faint">Adresse IP : {device.ip}</p>}
        </div>
        <p className="text-sm leading-relaxed text-paper-dim">
          Cet appareil aura accès à votre compte. Ne validez que si c’est bien votre TV et que le code y est affiché en ce moment.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" className="btn" onClick={() => setDevice(null)} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="btn-primary py-2.5 text-[15px]" onClick={() => void approve()} disabled={busy}>
            {busy ? 'Validation…' : 'Autoriser'}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell kicker="Connecter une TV" title="Code de la TV" intro="Saisissez le code affiché sur l’écran de connexion de la TV.">
      <form onSubmit={check} className="space-y-4" noValidate>
        <Field
          id="device-code"
          label="Code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ABCD-EFGH"
          maxLength={12}
          required
          autoFocus
          className="field font-display text-2xl uppercase tracking-[0.15em]"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary w-full py-2.5 text-[15px]" disabled={busy || code.replace(/[\s-]/g, '').length !== 8}>
          {busy ? 'Vérification…' : 'Continuer'}
        </button>
      </form>
    </AuthShell>
  );
}
