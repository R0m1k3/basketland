'use client';

import { useEffect, useState } from 'react';
import { IconEye, IconEyeOff } from './Icons';
import { SPOILER_COOKIE, SPOILER_STORAGE, type SpoilerMode } from './spoiler-keys';

/** Applique le mode à tous les conteneurs `[data-spoilers]` de la page et le mémorise. */
function applyMode(mode: SpoilerMode) {
  document.querySelectorAll('[data-spoilers]').forEach((el) => el.setAttribute('data-spoilers', mode));
  try {
    localStorage.setItem(SPOILER_STORAGE, mode);
  } catch {
    /* stockage indisponible (navigation privée…) : le cookie suffit */
  }
  document.cookie = `${SPOILER_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

/** Révèle le score d'un match précis (bouton `[data-reveal]` → conteneurs `[data-scope]`). */
function onRevealClick(e: MouseEvent) {
  const btn = (e.target as Element | null)?.closest?.('[data-reveal]');
  if (!btn) return;
  e.preventDefault();
  const id = btn.getAttribute('data-reveal') ?? '';
  document.querySelectorAll(`[data-scope="${CSS.escape(id)}"]`).forEach((el) => el.setAttribute('data-revealed', ''));
}

/**
 * Bascule « Masquer les scores » : pour regarder un replay sans connaître le
 * résultat. Le rendu serveur lit le cookie, ce composant garde localStorage
 * et cookie synchronisés et gère les boutons « Afficher » de chaque match.
 */
export default function SpoilerToggle({ initial, className = '' }: { initial: SpoilerMode; className?: string }) {
  const [mode, setMode] = useState<SpoilerMode>(initial);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SPOILER_STORAGE);
    } catch {
      stored = null;
    }
    if ((stored === 'hide' || stored === 'show') && stored !== initial) {
      setMode(stored);
      applyMode(stored);
    }
    document.addEventListener('click', onRevealClick);
    return () => document.removeEventListener('click', onRevealClick);
  }, [initial]);

  const hidden = mode === 'hide';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hidden}
      onClick={() => {
        const next: SpoilerMode = hidden ? 'show' : 'hide';
        setMode(next);
        applyMode(next);
      }}
      className={`group inline-flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
        hidden ? 'border-flame/50 bg-flame/10 text-paper' : 'border-ink-600 bg-ink-850 text-paper-dim hover:border-ink-500 hover:text-paper'
      } ${className}`}
      title={hidden ? 'Les scores sont masqués : cliquez pour les afficher' : 'Masquer les scores pour éviter les spoilers'}
    >
      {hidden ? <IconEyeOff className="text-flame-hot" /> : <IconEye />}
      <span>Masquer les scores</span>
      <span
        aria-hidden="true"
        className={`relative h-[18px] w-8 rounded-full transition-colors ${hidden ? 'bg-flame' : 'bg-ink-600'}`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-paper shadow transition-[left] ${
            hidden ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </span>
    </button>
  );
}
