'use client';

import { useEffect, useRef, useState } from 'react';
import { usePlayback } from './playback';
import { fmtClock, fmtTime, parseClock, periodName } from './format';

export interface Anchor {
  period: number;
  clock_sec: number;
  video_ts: number;
  method: 'auto' | 'manual' | 'audio' | 'est' | string;
}

export interface SyncState {
  settings?: { global_offset?: number; quarter_offsets?: Record<string, number> };
  anchors?: Anchor[];
  analysis?: {
    status?: 'none' | 'queued' | 'running' | 'done' | 'estimated' | 'unavailable' | 'failed' | string;
    progress?: { phase?: string; done?: number; total?: number };
    reason?: string;
    position?: number;
    anchors_auto?: number;
  };
  message?: string;
}

export type WriteResult = { ok: boolean; message: string };

type Tone = 'busy' | 'ok' | 'warn' | 'err' | 'idle';

/** Traduit l'état de l'analyse en un libellé court et une tonalité. */
export function describeSync(sync: SyncState | null): { tone: Tone; text: string; detail?: string } {
  if (!sync) return { tone: 'idle', text: 'Vérification de la synchro…' };
  const a = sync.analysis ?? {};
  const manual = (sync.anchors ?? []).filter((x) => x.method === 'manual').length;
  const auto = a.anchors_auto ?? (sync.anchors ?? []).filter((x) => x.method === 'auto').length;
  switch (a.status) {
    case 'queued': {
      const pos = a.position;
      return {
        tone: 'busy',
        text: `Synchro auto en file d’attente${pos ? ` (${pos === 1 ? '1re' : `${pos}e`})` : ''}`,
        detail: 'La VF actuelle est une estimation en attendant.',
      };
    }
    case 'running': {
      const p = a.progress;
      const pct = p && p.total ? Math.min(99, Math.round(((p.done ?? 0) / p.total) * 100)) : null;
      const phase = p?.phase === 'audio' ? 'analyse du son' : p?.phase === 'ocr' ? 'lecture du chrono à l’écran' : undefined;
      return { tone: 'busy', text: `Synchro automatique en cours${pct !== null ? ` · ${pct} %` : '…'}`, detail: phase && `Étape : ${phase}` };
    }
    case 'failed':
      if (manual) return { tone: 'ok', text: 'VF calée manuellement ✓' };
      return { tone: 'err', text: 'Échec de la synchro auto', detail: a.reason ?? 'Recalez la VF à la main ci-dessous.' };
    case 'done':
      return {
        tone: 'ok',
        text: 'VF calée ✓',
        detail: auto ? `${auto} point${auto > 1 ? 's' : ''} lu${auto > 1 ? 's' : ''} sur le chrono à l’écran${manual ? ` + ${manual} manuel${manual > 1 ? 's' : ''}` : ''}` : undefined,
      };
    case 'estimated':
      if (manual) return { tone: 'ok', text: 'VF calée manuellement ✓' };
      return { tone: 'warn', text: 'Synchro estimée — peut être décalée', detail: 'Un recalage rapide est possible ci-dessous.' };
    case 'unavailable':
      if (manual) return { tone: 'ok', text: 'VF calée manuellement ✓' };
      return { tone: 'warn', text: 'Synchro auto indisponible', detail: a.reason ?? 'Recalage manuel possible.' };
    default:
      if (manual) return { tone: 'ok', text: 'VF calée manuellement ✓' };
      return { tone: 'idle', text: 'Synchro automatique en préparation…' };
  }
}

const TONE_CLASS: Record<Tone, string> = {
  busy: 'text-flame-hot',
  ok: 'text-win',
  warn: 'text-warn',
  err: 'text-loss',
  idle: 'text-paper-mute',
};

/** Indicateur discret d'état de la synchro, sous le lecteur. */
export function SyncStatus({ sync, open, onToggle }: { sync: SyncState | null; open: boolean; onToggle: () => void }) {
  const d = describeSync(sync);
  const pct = (() => {
    const p = sync?.analysis?.progress;
    return sync?.analysis?.status === 'running' && p?.total ? Math.min(100, ((p.done ?? 0) / p.total) * 100) : null;
  })();
  return (
    <div className="panel-soft flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      <div className="flex min-w-[230px] flex-1 items-center gap-2.5" role="status" aria-live="polite">
        <StatusDot tone={d.tone} />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${TONE_CLASS[d.tone]}`}>{d.text}</p>
          {d.detail && <p className="text-xs text-paper-faint">{d.detail}</p>}
        </div>
        {pct !== null && (
          <span className="ml-2 hidden h-1 w-24 overflow-hidden rounded-full bg-ink-700 sm:block" aria-hidden="true">
            <span className="block h-full rounded-full bg-flame transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls="recalage-vf" className="btn-ghost !px-2.5 !py-1 !text-[13px]">
        La VF est décalée ?
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}

function StatusDot({ tone }: { tone: Tone }) {
  if (tone === 'busy')
    return <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-flame/25 border-t-flame" aria-hidden="true" />;
  const cls = {
    ok: ['bg-win/20', 'bg-win'],
    warn: ['bg-warn/20', 'bg-warn'],
    err: ['bg-loss/20', 'bg-loss'],
    idle: ['bg-paper-faint/20', 'bg-paper-faint'],
  }[tone];
  return (
    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${cls[0]}`} aria-hidden="true">
      <span className={`h-2 w-2 rounded-full ${cls[1]}`} />
    </span>
  );
}

const METHOD_LABEL: Record<string, string> = {
  auto: 'Auto',
  manual: 'Manuel',
  audio: 'Son',
  est: 'Estimé',
};

const NUDGES = [-5, -1, -0.5, 0.5, 1, 5];
const PERIODS = [1, 2, 3, 4, 5];

const fmtDelta = (d: number) => `${d > 0 ? '+' : '−'}${String(Math.abs(d)).replace('.', ',')} s`;

/**
 * Recalage manuel simple, replié par défaut :
 * (a) décalage rapide ±, (b) « le chrono à l'écran indique… », (c) points
 * de calage existants, (d) remise à zéro.
 */
export default function SyncPanel({
  sync,
  write,
}: {
  sync: SyncState | null;
  write: (body: Record<string, unknown>, success: string) => Promise<WriteResult>;
}) {
  const playback = usePlayback();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<WriteResult | null>(null);
  const [period, setPeriod] = useState(1);
  const [clockInput, setClockInput] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const posRef = useRef<HTMLSpanElement>(null);

  // Position vidéo affichée en direct, sans re-rendu React.
  useEffect(() => {
    let last = '';
    return playback.onTick((t) => {
      const txt = fmtTime(t);
      if (txt !== last && posRef.current) {
        posRef.current.textContent = txt;
        last = txt;
      }
    });
  }, [playback]);

  const offset = sync?.settings?.global_offset ?? 0;
  const anchors = [...(sync?.anchors ?? [])].sort((a, b) => a.period - b.period || b.clock_sec - a.clock_sec);
  const analysisBusy = sync?.analysis?.status === 'running' || sync?.analysis?.status === 'queued';

  const run = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setFeedback(null);
    const r = await write(body, success);
    setFeedback(r);
    setBusy(false);
    return r;
  };

  const calibrate = async (e: React.FormEvent) => {
    e.preventDefault();
    const sec = parseClock(clockInput);
    if (sec === null) {
      setFeedback({ ok: false, message: 'Chrono invalide : saisissez par exemple 7:43 (minutes:secondes).' });
      return;
    }
    // Position lue AU MOMENT DU CLIC (jamais stockée dans l'état React).
    const videoTs = Math.round(playback.currentTime * 100) / 100;
    const r = await run(
      { action: 'clock', video_ts: videoTs, period, clock_sec: sec },
      `VF calée : ${periodName(period)} ${fmtClock(sec)} à ${fmtTime(videoTs)} de la vidéo.`,
    );
    if (r.ok) setClockInput('');
  };

  return (
    <section id="recalage-vf" className="panel animate-fade-up space-y-5 p-4 sm:p-5" aria-label="Recaler la VF">
      {/* (a) Décalage rapide */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display text-base font-bold uppercase tracking-wide">Décalage rapide</h3>
          <span className="text-xs text-paper-faint">
            Décalage actuel : <span className="num text-sm text-paper">{offset === 0 ? '0 s' : fmtDelta(offset)}</span>
          </span>
        </div>
        <p className="mt-1 text-xs text-paper-mute">La VF annonce l’action trop tôt ? Retardez-la. Trop tard ? Avancez-la.</p>
        <div className="mt-3 grid grid-cols-6 gap-1.5 sm:max-w-md">
          {NUDGES.map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              onClick={() => run({ action: 'nudge', delta: d }, d > 0 ? `VF retardée de ${fmtDelta(d).slice(1)}.` : `VF avancée de ${fmtDelta(d).slice(1)}.`)}
              className={`num rounded-lg border px-1 py-2 text-[15px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 disabled:opacity-50 ${
                d < 0 ? 'border-ink-600 bg-ink-850 hover:border-ink-500' : 'border-flame/30 bg-flame/5 hover:border-flame/60'
              }`}
              title={d < 0 ? `Avancer la VF de ${Math.abs(d)} s` : `Retarder la VF de ${d} s`}
            >
              {fmtDelta(d)}
            </button>
          ))}
          <span className="col-span-3 text-center text-[11px] uppercase tracking-wider text-paper-faint">← Avancer la VF</span>
          <span className="col-span-3 text-center text-[11px] uppercase tracking-wider text-paper-faint">Retarder la VF →</span>
        </div>
      </div>

      {/* (b) Chrono affiché à l'écran */}
      <form onSubmit={calibrate} className="border-t border-ink-700/60 pt-4">
        <h3 className="font-display text-base font-bold uppercase tracking-wide">Caler sur le chrono à l’écran</h3>
        <p className="mt-1 text-xs text-paper-mute">
          Mettez la vidéo en pause sur une image où le chrono du match est visible, indiquez ce qu’il affiche, puis calez.
          Plusieurs points (un par quart) rendent la VF très précise.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <fieldset>
            <legend className="mb-1 text-[11px] uppercase tracking-wider text-paper-faint">Période</legend>
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  aria-pressed={period === p}
                  className={`min-w-[42px] rounded-lg px-2 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
                    period === p ? 'bg-paper text-ink-950' : 'bg-ink-800 text-paper-dim hover:bg-ink-700'
                  }`}
                >
                  {periodName(p)}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-paper-faint">Chrono affiché</span>
            <input
              value={clockInput}
              onChange={(e) => setClockInput(e.target.value)}
              inputMode="decimal"
              placeholder="7:43"
              autoComplete="off"
              className="num w-24 rounded-lg border border-ink-600 bg-ink-950/60 px-3 py-[7px] text-center text-lg text-paper placeholder:text-paper-faint focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/30"
              aria-describedby="pos-video"
            />
          </label>
          <button type="submit" disabled={busy || !clockInput.trim()} className="btn-primary !py-2.5">
            Caler ici
          </button>
          <span id="pos-video" className="pb-2.5 text-xs text-paper-faint">
            Position vidéo : <span ref={posRef} className="num text-sm text-paper-dim" />
          </span>
        </div>
      </form>

      {/* (c) Points de calage */}
      <div className="border-t border-ink-700/60 pt-4">
        <h3 className="font-display text-base font-bold uppercase tracking-wide">
          Points de calage <span className="text-paper-faint">({anchors.length})</span>
        </h3>
        {anchors.length === 0 ? (
          <p className="mt-1 text-xs text-paper-mute">Aucun pour l’instant : la VF est positionnée par estimation.</p>
        ) : (
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {anchors.map((a) => (
              <li key={`${a.method}-${a.period}-${a.clock_sec}`} className="flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-1.5 text-sm">
                <span className="num text-paper">
                  {periodName(a.period)} {fmtClock(a.clock_sec)}
                </span>
                <span className="text-paper-faint">→</span>
                <button
                  type="button"
                  className="num rounded text-paper-dim underline-offset-2 hover:text-flame-hot hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60"
                  onClick={() => playback.seek(a.video_ts)}
                  title="Aller à cette position"
                >
                  {fmtTime(a.video_ts)}
                </button>
                <span className={`chip !px-1.5 !py-0 !text-[10px] ${a.method === 'manual' ? '!border-flame/40 !text-flame-hot' : ''}`}>
                  {METHOD_LABEL[a.method] ?? a.method}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ action: 'delete-anchor', period: a.period, clock_sec: a.clock_sec }, 'Point de calage supprimé.')}
                  className="ml-auto grid h-6 w-6 place-items-center rounded-full text-paper-faint transition hover:bg-loss/15 hover:text-loss focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60"
                  aria-label={`Supprimer le point ${periodName(a.period)} ${fmtClock(a.clock_sec)}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* (d) Actions globales + retour */}
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-700/60 pt-4">
        <button
          type="button"
          disabled={busy || analysisBusy}
          onClick={() => run({ action: 'analyze' }, 'Synchro automatique relancée.')}
          className="btn !py-1.5 !text-xs"
        >
          Relancer la synchro auto
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              setTimeout(() => setConfirmReset(false), 4000);
              return;
            }
            setConfirmReset(false);
            void run({ action: 'reset' }, 'Réglages manuels effacés.');
          }}
          className={`btn !py-1.5 !text-xs ${confirmReset ? '!border-loss/60 !text-loss' : ''}`}
        >
          {confirmReset ? 'Confirmer la réinitialisation' : 'Réinitialiser'}
        </button>
        <p
          className={`ml-auto min-h-[1.25rem] text-sm ${feedback ? (feedback.ok ? 'text-win' : 'text-loss') : 'text-paper-faint'}`}
          role="status"
          aria-live="polite"
        >
          {busy ? 'Enregistrement…' : feedback?.message}
        </p>
      </div>
    </section>
  );
}
