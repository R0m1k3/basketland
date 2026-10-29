'use client';

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useCue, usePlayback, type Subtitle } from './playback';
import { stripScores, useNoSpoil } from './spoiler';
import { fmtTime, periodName } from './format';
import { teamInfo } from '@/lib/teams';

export interface PlayClock {
  period: number;
  clock: string;
}

type RowState = 'past' | 'active' | 'future';

/**
 * Panneau « VF en direct » : transcript défilant des sous-titres, ligne
 * courante mise en évidence et suivie automatiquement, clic = aller au
 * moment de l'action. En mode sans spoiler, les lignes à venir sont cachées.
 */
export default function Transcript({
  subtitles,
  clocks,
  vttHref,
  loading,
}: {
  subtitles: Subtitle[];
  clocks: Map<number, PlayClock>;
  vttHref: string;
  loading: boolean;
}) {
  const playback = usePlayback();
  const cue = useCue();
  const noSpoil = useNoSpoil();
  const listRef = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const q = deferredQuery.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = subtitles.map((s, i) => ({ s, i }));
    if (!q) return all;
    return all.filter(({ s }) => s.text.toLowerCase().includes(q));
  }, [subtitles, q]);

  const active = cue.index;
  // Sans spoiler : rien après la ligne courante.
  const visibleRows = noSpoil ? rows.filter(({ i }) => i <= active) : rows;

  // Suivi automatique de la ligne courante, dans la liste seulement (jamais la page).
  useEffect(() => {
    if (!follow || q || active < 0) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!list || !el) return;
    const top = el.offsetTop - list.clientHeight * 0.38;
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [active, follow, q, noSpoil]);

  const stopFollow = useCallback(() => setFollow(false), []);
  const jump = useCallback(
    (s: Subtitle) => {
      // Deux secondes avant : on voit l'action se construire.
      playback.seek(Math.max(0, s.video_ts - 2), true);
      setFollow(true);
    },
    [playback],
  );

  return (
    <div className="panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-700/70 px-4 py-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-pulse-live rounded-full bg-flame/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-flame" />
        </span>
        <h2 className="font-display text-lg font-bold uppercase tracking-wide">VF en direct</h2>
        <span className="ml-auto text-xs text-paper-faint">{subtitles.length ? `${subtitles.length} lignes` : ''}</span>
      </div>

      <div className="border-b border-ink-700/50 px-3 py-2">
        <label className="relative block">
          <span className="sr-only">Rechercher dans la VF</span>
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-paper-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Joueur, action… (ex. « dunk »)"
            className="w-full rounded-lg border border-ink-700 bg-ink-950/60 py-1.5 pl-8 pr-2 text-sm text-paper placeholder:text-paper-faint focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/30"
          />
        </label>
      </div>

      <div className="relative min-h-0 flex-1">
        <ol
          ref={listRef}
          className="transcript h-full overflow-y-auto overscroll-contain py-1"
          onWheel={stopFollow}
          onTouchMove={stopFollow}
          aria-label="Sous-titres français"
        >
          {loading && !subtitles.length && <TranscriptSkeleton />}
          {!loading && !subtitles.length && (
            <li className="px-4 py-8 text-center text-sm text-paper-mute">La VF de ce match est en préparation.</li>
          )}
          {noSpoil && subtitles.length > 0 && active < 0 && !q && (
            <li className="px-4 py-8 text-center text-sm text-paper-mute">
              Mode sans spoiler : les commentaires apparaissent au fil de la lecture.
            </li>
          )}
          {q && visibleRows.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-paper-mute">Aucune ligne ne contient « {deferredQuery} ».</li>
          )}
          {visibleRows.map(({ s, i }) => (
            <Row
              key={s.seq}
              s={s}
              i={i}
              clock={clocks.get(s.seq)}
              state={i === active ? 'active' : i < active ? 'past' : 'future'}
              noSpoil={noSpoil}
              onJump={jump}
            />
          ))}
          {noSpoil && active >= 0 && !q && active < subtitles.length - 1 && (
            <li className="px-4 py-4 text-center text-xs text-paper-faint">La suite s’affiche au fil du match…</li>
          )}
        </ol>
        {!follow && !q && active >= 0 && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 !py-1.5 !text-xs shadow-glow"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            Suivre la lecture
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ink-700/70 px-4 py-2.5 text-[11px] text-paper-faint">
        <span>Cliquez sur une ligne pour revoir l’action</span>
        <a href={vttHref} download className="rounded underline decoration-ink-500 underline-offset-2 hover:text-paper-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60">
          Export WebVTT
        </a>
      </div>
    </div>
  );
}

const Row = memo(function Row({
  s,
  i,
  clock,
  state,
  noSpoil,
  onJump,
}: {
  s: Subtitle;
  i: number;
  clock: PlayClock | undefined;
  state: RowState;
  noSpoil: boolean;
  onJump: (s: Subtitle) => void;
}) {
  const banner = s.kind === 'score' || s.kind === 'banniere';
  const accent = s.speaker ? teamInfo(s.speaker).accent : '#4A4955';
  const text = noSpoil ? stripScores(s.text) : s.text;
  return (
    <li data-i={i} className="transcript-row" data-state={state}>
      <button
        type="button"
        onClick={() => onJump(s)}
        aria-current={state === 'active' ? 'true' : undefined}
        className={`group flex w-full items-start gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame/60 ${
          state === 'active' ? 'bg-flame/10' : 'hover:bg-ink-800/70'
        } ${banner ? 'transcript-banner' : ''}`}
      >
        <span className="num w-[52px] shrink-0 pt-px text-right text-[13px] leading-5 text-paper-faint group-hover:text-paper-mute">
          {clock ? (
            <>
              <span className="block font-sans text-[10px] font-semibold uppercase tracking-wider text-paper-faint">{periodName(clock.period)}</span>
              {clock.clock}
            </>
          ) : (
            fmtTime(s.video_ts)
          )}
        </span>
        <span className="mt-1 h-[calc(100%-8px)] min-h-[14px] w-[3px] shrink-0 self-stretch rounded-full" style={{ background: banner ? '#FF5A1F' : accent }} aria-hidden="true" />
        <span
          className={`min-w-0 flex-1 text-[14px] leading-5 ${
            state === 'active' ? 'font-medium text-paper' : state === 'past' ? 'text-paper-dim' : 'text-paper-mute'
          } ${banner ? 'font-display text-[15px] font-semibold uppercase tracking-wide' : ''}`}
        >
          {text}
        </span>
      </button>
    </li>
  );
});

function TranscriptSkeleton() {
  return (
    <>
      {Array.from({ length: 7 }, (_, i) => (
        <li key={i} className="flex gap-3 px-4 py-2.5" aria-hidden="true">
          <span className="h-4 w-12 animate-pulse rounded bg-ink-800" />
          <span className="h-4 flex-1 animate-pulse rounded bg-ink-800" style={{ maxWidth: `${55 + ((i * 37) % 40)}%` }} />
        </li>
      ))}
    </>
  );
}
