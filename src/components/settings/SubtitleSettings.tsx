'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_SUB_DELAY } from '@/components/match/playback';

/*
 * Préférences de la VF, propres à ce navigateur : mêmes clés localStorage
 * que le lecteur (VideoPlayer, menu ⚙), qui les relit à chaque ouverture
 * d'un match.
 */
type SubPos = 'haut' | 'bas';
type SubSize = 'S' | 'M' | 'L' | 'XL';

const KEY_POS = 'bl:subpos';
const KEY_SIZE = 'bl:subsize';
const KEY_DELAY = 'bl:subdelay';

const SIZES: SubSize[] = ['S', 'M', 'L', 'XL'];
/** Mêmes rapports que le lecteur (SUB_SCALE), pour l'aperçu. */
const SCALE: Record<SubSize, number> = { S: 0.8, M: 1, L: 1.22, XL: 1.5 };
const SIZE_LABEL: Record<SubSize, string> = { S: 'Petite', M: 'Moyenne', L: 'Grande', XL: 'Très grande' };

// try/catch : stockage parfois indisponible (navigation privée, cookies bloqués).
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Secondes à la française : « +1,5 s ». */
const fmtDelay = (d: number) => `${d > 0 ? '+' : ''}${String(d).replace('.', ',')} s`;

/** Choix exclusif en pastilles (vrais boutons radio, clavier compris). */
function Choice<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label key={o.value} className="cursor-pointer">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="peer sr-only" />
          <span
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-ink-600 bg-ink-850 px-3.5 py-1.5 text-sm font-medium text-paper-dim transition hover:border-ink-500 hover:text-paper peer-checked:border-flame/60 peer-checked:bg-flame/15 peer-checked:text-flame-hot peer-focus-visible:ring-2 peer-focus-visible:ring-flame/60"
            title={o.hint}
          >
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/** « Sous-titres » (tous les utilisateurs) : position et taille de la VF, synchro. */
export default function SubtitleSettings() {
  const [pos, setPos] = useState<SubPos>('haut');
  const [size, setSize] = useState<SubSize>('M');
  const [delay, setDelay] = useState<number | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  // Lecture après le montage : le serveur ne connaît pas le stockage du navigateur.
  useEffect(() => {
    if (readPref(KEY_POS) === 'bas') setPos('bas');
    const s = readPref(KEY_SIZE);
    if (s === 'S' || s === 'M' || s === 'L' || s === 'XL') setSize(s);
    const raw = readPref(KEY_DELAY);
    const d = Number(raw);
    if (raw !== null && Number.isFinite(d)) setDelay(Math.max(-5, Math.min(10, d)));
    setStorageOk(writePref('bl:probe', '1') && writePref('bl:probe', null));
  }, []);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const choosePos = (p: SubPos) => {
    setPos(p);
    setStorageOk(writePref(KEY_POS, p));
  };
  const chooseSize = (s: SubSize) => {
    setSize(s);
    setStorageOk(writePref(KEY_SIZE, s));
  };
  const resetDelay = () => {
    setDelay(null);
    setStorageOk(writePref(KEY_DELAY, null));
    setMsg('Synchro réinitialisée : la VF reprend le réglage par défaut.');
  };

  const customDelay = delay !== null && delay !== DEFAULT_SUB_DELAY;

  return (
    <div className="panel grid gap-0 overflow-hidden md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-6 p-5 sm:p-6">
        <fieldset>
          <legend className="field-label">Position de la VF sur l&apos;image</legend>
          <Choice
            name="subpos"
            value={pos}
            onChange={choosePos}
            options={[
              { value: 'haut', label: 'En haut (recommandé)', hint: 'Ne cache pas le bandeau du score' },
              { value: 'bas', label: 'En bas' },
            ]}
          />
          <p className="field-hint">En haut, la VF ne recouvre pas le bandeau du score de la réalisation télé.</p>
        </fieldset>

        <fieldset>
          <legend className="field-label">Taille du texte</legend>
          <Choice name="subsize" value={size} onChange={chooseSize} options={SIZES.map((s) => ({ value: s, label: s, hint: SIZE_LABEL[s] }))} />
          <p className="field-hint">Proportionnelle à la taille du lecteur : {SIZE_LABEL[size].toLowerCase()}.</p>
        </fieldset>

        <div>
          <p className="field-label">Synchro de la VF</p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn" onClick={resetDelay} disabled={delay === null}>
              Réinitialiser la synchro
            </button>
            <span className="text-sm text-paper-mute">
              {customDelay
                ? `Réglage personnalisé : ${fmtDelay(delay as number)} (défaut ${fmtDelay(DEFAULT_SUB_DELAY)}).`
                : 'Réglage par défaut.'}
            </span>
          </div>
          <p className="field-hint">Efface l&apos;avance ou le retard choisi avec « Plus tôt » / « Plus tard » dans le lecteur.</p>
        </div>

        {msg && (
          <p className="form-ok" role="status">
            {msg}
          </p>
        )}
        {!storageOk && (
          <p className="form-error" role="alert">
            Ce navigateur bloque le stockage local : ces réglages ne seront pas mémorisés.
          </p>
        )}
        <p className="border-t border-ink-700/60 pt-4 text-xs leading-relaxed text-paper-faint">
          Ces réglages sont propres à ce navigateur. Le menu ⚙ du lecteur modifie les mêmes réglages pendant la lecture.
        </p>
      </div>

      {/* Aperçu : où et à quelle taille la VF s'affiche. */}
      <div className="flex items-center border-t border-ink-700/70 bg-ink-950/40 p-5 sm:p-6 md:border-l md:border-t-0">
        <figure className="w-full">
          <div
            className="relative aspect-video w-full overflow-hidden rounded-xl border border-ink-700 shadow-card"
            style={{
              background:
                'radial-gradient(70% 90% at 50% 110%, rgba(214,150,84,.55), transparent 65%), radial-gradient(60% 60% at 50% 35%, rgba(255,255,255,.06), transparent 70%), linear-gradient(180deg, #1b1d26, #12131a)',
            }}
            aria-hidden="true"
          >
            {/* Bandeau du score de la réalisation, en bas comme à la télé : la VF « en bas » le recouvre. */}
            <span className="absolute bottom-[7%] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded bg-black/75 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-white/90">
              <span>MEM 54</span>
              <span className="text-white/40">·</span>
              <span>POR 61</span>
              <span className="ml-1 rounded-sm bg-flame px-1 text-ink-950">Q3 4:12</span>
            </span>
            <span className={`absolute inset-x-0 flex justify-center px-3 ${pos === 'haut' ? 'top-[6%]' : 'bottom-[5%]'}`}>
              <span
                className="max-w-[86%] rounded-md bg-black/55 px-2 py-0.5 text-center font-semibold leading-snug text-white transition-all"
                style={{ fontSize: `${Math.round(12 * SCALE[size])}px`, textShadow: '0 1px 2px rgba(0,0,0,.9)' }}
              >
                Il déclenche de loin… et ça rentre !
              </span>
            </span>
          </div>
          <figcaption className="mt-2 text-center text-xs text-paper-faint">Aperçu</figcaption>
        </figure>
      </div>
    </div>
  );
}
