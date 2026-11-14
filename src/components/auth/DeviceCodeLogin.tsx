'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { postJson } from './client';
import { deviceName } from '@/lib/appBridge';

interface Started {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

type PollReply = { status: 'pending' | 'expired' } | { status: 'approved' };

/**
 * Connexion d'une TV sans clavier (server/src/device_auth.rs) : un code s'affiche,
 * on le valide sur un téléphone ou un PC déjà connecté (page /appareil), la TV
 * reçoit alors sa session. Un code expiré est remplacé automatiquement.
 */
export default function DeviceCodeLogin({ next }: { next: string }) {
  const [started, setStarted] = useState<Started | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const begin = useCallback(async () => {
    clearTimeout(timer.current);
    setError(null);
    const r = await postJson<Started>('/api/auth/device/start', { name: deviceName() });
    if (!r.ok) {
      setStarted(null);
      setError(r.error);
      // Nouvel essai dans 30 s (limite de demandes, serveur injoignable).
      timer.current = setTimeout(() => void begin(), 30_000);
      return;
    }
    setStarted(r.data);
  }, []);

  useEffect(() => {
    void begin();
    return () => clearTimeout(timer.current);
  }, [begin]);

  useEffect(() => {
    if (!started) return;
    let live = true;
    const tick = async () => {
      const r = await postJson<PollReply>('/api/auth/device/poll', { device_code: started.device_code });
      if (!live) return;
      if (r.ok && r.data.status === 'approved') {
        window.location.assign(next || '/');
        return;
      }
      if (r.ok && r.data.status === 'expired') {
        void begin();
        return;
      }
      timer.current = setTimeout(() => void tick(), Math.max(2, started.interval) * 1000);
    };
    timer.current = setTimeout(() => void tick(), started.interval * 1000);
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, [started, next, begin]);

  const host = typeof window === 'undefined' ? '' : window.location.host;

  return (
    <div className="space-y-5" aria-live="polite">
      <ol className="space-y-2 text-[15px] leading-relaxed text-paper-dim">
        <li>
          1. Sur votre téléphone ou votre ordinateur, ouvrez{' '}
          <strong className="whitespace-nowrap text-paper">{host}/appareil</strong>
        </li>
        <li>2. Saisissez ce code, puis validez :</li>
      </ol>
      <p
        className="rounded-2xl bg-ink-800 py-5 text-center font-display text-5xl font-extrabold tracking-[0.12em] text-flame-hot"
        data-testid="device-code"
      >
        {started ? started.user_code : '····-····'}
      </p>
      <p className="text-sm text-paper-faint">
        La TV se connectera toute seule dès que le code sera validé. Le code change toutes les 10 minutes.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
