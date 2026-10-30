'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { logout } from '@/components/auth/client';
import { IconLogout, IconSettings } from './Icons';

/**
 * Compte dans l'en-tête (toutes tailles d'écran) : accès aux paramètres et
 * déconnexion. Sur mobile, deux boutons icônes à droite du logo — la barre
 * d'onglets du bas garde ses quatre entrées.
 */
export default function UserMenu({ username }: { username: string }) {
  const pathname = usePathname() ?? '';
  const active = pathname.startsWith('/parametres');
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Link
        href="/parametres"
        aria-current={active ? 'page' : undefined}
        aria-label={`Paramètres (connecté en tant que ${username})`}
        title="Paramètres"
        className={`inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-full px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
          active ? 'bg-ink-800 text-flame' : 'text-paper-mute hover:bg-ink-800 hover:text-paper'
        }`}
      >
        <IconSettings size={19} />
        <span className="hidden max-w-[10rem] truncate lg:inline">{username}</span>
      </Link>
      <button
        type="button"
        onClick={() => {
          setBusy(true);
          void logout();
        }}
        disabled={busy}
        aria-label="Se déconnecter"
        title="Se déconnecter"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-paper-mute transition hover:bg-ink-800 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 disabled:opacity-50"
      >
        <IconLogout size={19} />
      </button>
    </div>
  );
}
