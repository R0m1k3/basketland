'use client';

import { memo, useMemo, useState } from 'react';
import { SEEK_EVENT } from './playback';
import { periodName } from './format';
import { teamInfo, teamLogoUrl } from '@/lib/teams';

/** Action du play-by-play, préparée côté serveur (texte déjà traduit). */
export interface PlayItem {
  seq: number;
  period: number;
  clock: string;
  text: string;
  team: string;
  away: number | null;
  home: number | null;
  /** Points marqués sur l'action (0 sinon). */
  pts: number;
  key: boolean;
  /** 'period' pour un début/fin de période. */
  type: 'play' | 'period';
}

type Filter = 'all' | 'key' | 'scoring';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'key', label: 'Actions clés' },
  { id: 'scoring', label: 'Paniers' },
  { id: 'all', label: 'Tout' },
];

/**
 * Onglet « Actions » : play-by-play complet en français, filtrable par
 * période et par type, actions clés en évidence. Les scores portent la
 * classe `.spoil-show` (masqués en mode sans spoiler). Un clic sur ▶ envoie le
 * lecteur au moment estimé de l'action.
 */
export default function PlayByPlay({
  plays,
  awayAbbr,
  homeAbbr,
  hasVideo,
}: {
  plays: PlayItem[];
  awayAbbr: string;
  homeAbbr: string;
  hasVideo: boolean;
}) {
  const periods = useMemo(() => [...new Set(plays.map((p) => p.period))].sort((a, b) => a - b), [plays]);
  const [period, setPeriod] = useState<number | 0>(0);
  const [filter, setFilter] = useState<Filter>('key');

  const groups = useMemo(() => {
    const list = plays.filter((p) => {
      if (period && p.period !== period) return false;
      if (p.type === 'period') return true;
      if (filter === 'scoring') return p.pts > 0;
      if (filter === 'key') return p.key || p.pts > 0;
      return true;
    });
    const out: { period: number; items: PlayItem[] }[] = [];
    for (const p of list) {
      let g = out[out.length - 1];
      if (!g || g.period !== p.period) out.push((g = { period: p.period, items: [] }));
      g.items.push(p);
    }
    return out;
  }, [plays, period, filter]);

  if (!plays.length) {
    return <div className="panel-soft px-6 py-10 text-center text-sm text-paper-mute">Le play-by-play n’est pas encore disponible.</div>;
  }

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/70 px-3 py-3 sm:px-4">
        <div className="scroll-row -mx-1 flex max-w-full gap-1 overflow-x-auto px-1" role="group" aria-label="Filtrer par période">
          <Chip active={period === 0} onClick={() => setPeriod(0)}>
            Match
          </Chip>
          {periods.map((p) => (
            <Chip key={p} active={period === p} onClick={() => setPeriod(p)}>
              {periodName(p)}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex gap-1" role="group" aria-label="Filtrer par type d’action">
          {FILTERS.map((f) => (
            <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)} subtle>
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="max-h-[70vh] overflow-y-auto overscroll-contain">
        {groups.length === 0 && <p className="px-4 py-10 text-center text-sm text-paper-mute">Aucune action pour ce filtre.</p>}
        {groups.map((g) => (
          <section key={g.period} aria-label={periodName(g.period)}>
            <h3 className="sticky top-0 z-[1] border-b border-ink-700/60 bg-ink-900/95 px-4 py-2 font-display text-sm font-bold uppercase tracking-[0.14em] text-paper-dim backdrop-blur">
              {g.period <= 4 ? `${g.period === 1 ? '1er' : `${g.period}e`} quart-temps` : `Prolongation${g.period > 5 ? ` ${g.period - 4}` : ''}`}
            </h3>
            <ol>
              {g.items.map((p) => (
                <PlayRow key={p.seq} p={p} awayAbbr={awayAbbr} homeAbbr={homeAbbr} hasVideo={hasVideo} />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

const PlayRow = memo(function PlayRow({
  p,
  awayAbbr,
  homeAbbr,
  hasVideo,
}: {
  p: PlayItem;
  awayAbbr: string;
  homeAbbr: string;
  hasVideo: boolean;
}) {
  const hasScore = p.away !== null && p.home !== null;
  if (p.type === 'period') {
    return (
      <li className="flex items-center gap-3 bg-ink-850/60 px-4 py-2 text-xs uppercase tracking-wider text-paper-mute">
        <span className="h-px flex-1 bg-ink-700" />
        <span className="font-display text-[13px] font-semibold">{p.text}</span>
        {hasScore && /fin/i.test(p.text) && (
          <span className="spoil-show num text-sm text-paper-dim">
            {awayAbbr} {p.away} – {p.home} {homeAbbr}
          </span>
        )}
        <span className="h-px flex-1 bg-ink-700" />
      </li>
    );
  }
  const t = p.team ? teamInfo(p.team) : null;
  const scoring = p.pts > 0;
  return (
    <li
      className={`pbp-row group flex items-center gap-3 border-b border-ink-800/80 px-3 py-2 sm:px-4 ${p.key || scoring ? '' : 'text-paper-mute'}`}
      style={t && scoring ? ({ '--row-accent': t.accent } as React.CSSProperties) : undefined}
      data-scoring={scoring || undefined}
    >
      <span className="num w-10 shrink-0 text-right text-sm text-paper-faint">{p.clock}</span>
      <span className="grid h-6 w-6 shrink-0 place-items-center">
        {p.team ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={teamLogoUrl(p.team)} alt={p.team} width={20} height={20} loading="lazy" className="opacity-90" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-ink-500" />
        )}
      </span>
      <span className={`min-w-0 flex-1 text-sm leading-snug ${scoring ? 'font-medium text-paper' : p.key ? 'text-paper-dim' : ''}`}>
        {p.text}
        {scoring && (
          <span className="ml-2 inline-block rounded px-1.5 align-[1px] font-display text-[12px] font-bold" style={{ background: `${t?.accent ?? '#FF5A1F'}26`, color: t?.accent ?? '#FF7A45' }}>
            +{p.pts}
          </span>
        )}
      </span>
      {hasScore && (
        <span className="spoil-show num hidden w-16 shrink-0 text-right text-sm text-paper-dim sm:inline">
          <span className={scoring && p.team === awayAbbr ? 'text-paper' : ''}>{p.away}</span>
          <span className="text-paper-faint">–</span>
          <span className={scoring && p.team === homeAbbr ? 'text-paper' : ''}>{p.home}</span>
        </span>
      )}
      {hasVideo && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(SEEK_EVENT, { detail: { seq: p.seq } }))}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-paper-faint transition hover:bg-flame hover:text-ink-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          aria-label={`Revoir l’action : ${p.text}`}
          title="Revoir l’action dans le replay"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" />
          </svg>
        </button>
      )}
    </li>
  );
});

function Chip({ active, onClick, subtle, children }: { active: boolean; onClick: () => void; subtle?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
        active ? (subtle ? 'bg-flame/15 text-flame-hot' : 'bg-paper text-ink-950') : 'bg-ink-800 text-paper-mute hover:text-paper'
      }`}
    >
      {children}
    </button>
  );
}
