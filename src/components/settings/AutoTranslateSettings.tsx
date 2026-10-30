'use client';

import { useState } from 'react';
import { postJson } from '@/components/auth/client';

type Msg = { ok: boolean; text: string } | null;

/**
 * « Traduction automatique » (administrateurs) : interrupteur enregistré
 * aussitôt (POST /api/admin/settings { autoTranslate }).
 */
export default function AutoTranslateSettings({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setMsg(null);
    setOn(next); // affichage immédiat, annulé si le serveur refuse
    const r = await postJson<{ autoTranslate: boolean }>('/api/admin/settings', { autoTranslate: next });
    setBusy(false);
    if (!r.ok) {
      setOn(!next);
      return setMsg({ ok: false, text: r.error });
    }
    setOn(r.data.autoTranslate);
    setMsg({
      ok: true,
      text: r.data.autoTranslate
        ? 'Traduction automatique activée : les replays disponibles vont être traduits au fil de l’eau.'
        : 'Traduction automatique désactivée : les matchs seront traduits à la demande.',
    });
  }

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-4 border-b border-ink-700/70 p-5 sm:p-6">
        <div className="min-w-0 flex-1">
          <p id="auto-translate-label" className="font-display text-lg font-bold uppercase tracking-wide text-paper">
            Traduction automatique
          </p>
          <p className="mt-0.5 text-sm text-paper-mute">
            {on ? 'Activée : les replays sont traduits dès qu’ils sont disponibles.' : 'Désactivée : traduction à la demande seulement.'}
          </p>
        </div>
        <span className={`hidden sm:inline-flex ${on ? 'chip-flame' : 'chip'}`} aria-hidden="true">
          {on ? 'Activée' : 'Désactivée'}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="auto-translate-label"
          onClick={() => void toggle()}
          disabled={busy}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 disabled:cursor-wait disabled:opacity-70 ${
            on ? 'border-flame bg-flame' : 'border-ink-500 bg-ink-800'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full shadow-[0_1px_3px_rgba(0,0,0,.5)] transition-transform ${on ? 'translate-x-[22px] bg-ink-950' : 'translate-x-[3px] bg-paper-dim'}`}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="space-y-3 p-5 text-sm leading-relaxed text-paper-dim sm:p-6">
        <p className="flex gap-3">
          <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${on ? 'bg-flame' : 'bg-ink-500'}`} aria-hidden="true" />
          <span>
            <strong className="font-semibold text-paper">Activée</strong> : chaque replay est traduit (et analysé) dès qu&apos;il est
            disponible — puis doublé en mode « Doublage voix » —, en pause pendant qu&apos;une vidéo est regardée.
          </span>
        </p>
        <p className="flex gap-3">
          <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${on ? 'bg-ink-500' : 'bg-flame'}`} aria-hidden="true" />
          <span>
            <strong className="font-semibold text-paper">Désactivée</strong> : rien n&apos;est traduit tant qu&apos;un utilisateur ne clique
            pas sur « Sous-titrer ce match » ou « Doubler ce match » sur la fiche du match — moins de charge pour le serveur.
          </span>
        </p>
        {msg && (
          <p className={msg.ok ? 'form-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}
