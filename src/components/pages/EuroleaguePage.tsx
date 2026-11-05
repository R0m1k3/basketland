'use client';

import { Fragment, useState } from 'react';
import { longDate, relativeDay } from '@/components/schedule/dates';
import AutoRefresh from '@/components/ui/AutoRefresh';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import { RevealButton } from '@/components/ui/Score';
import { TvBadges } from '@/components/ui/TvBadge';
import { PageData } from '@/components/page/pageData';
import type { EuroClub, EuroGame, EuroleaguePage as EuroData, EuroStandingRow } from '@/components/page/types';

/**
 * Onglet Euroleague (`/euroleague`) : données de `GET /api/pages/euroleague`
 * (API officielle de l'Euroleague, cache de 10 min). Deux prochaines
 * journées, deux dernières journées jouées et classement officiel.
 */
export default function EuroleaguePage() {
  return <PageData<EuroData> url="/api/pages/euroleague">{(d) => <Euroleague d={d} />}</PageData>;
}

type Tab = 'upcoming' | 'results' | 'standings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'upcoming', label: 'À venir' },
  { key: 'results', label: 'Résultats' },
  { key: 'standings', label: 'Classement' },
];

function Euroleague({ d }: { d: EuroData }) {
  const [tab, setTab] = useState<Tab>(d.upcoming.length > 0 ? 'upcoming' : d.results.length > 0 ? 'results' : 'standings');
  const count = (t: Tab) => (t === 'upcoming' ? d.upcoming.length : t === 'results' ? d.results.length : null);

  return (
    <div data-spoilers={d.spoilers} className="space-y-6">
      <AutoRefresh />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="kicker">
            Saison {d.season}
            {d.total > 0 && ` · ${d.played} matchs joués sur ${d.total}`}
          </p>
          <h1 className="title-xl">Euroleague</h1>
        </div>
        <SpoilerToggle initial={d.spoilers} />
      </header>

      {!d.available ? (
        <div className="panel-soft flex flex-col items-center gap-3 px-6 py-14 text-center">
          <p className="font-display text-2xl font-bold uppercase">Euroleague indisponible</p>
          <p className="max-w-md text-paper-mute">
            Le site de l’Euroleague ne répond pas pour l’instant. Les matchs et le classement s’afficheront dès qu’il sera
            joignable.
          </p>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Sections de l’Euroleague" className="scroll-row flex gap-2 overflow-x-auto">
            {TABS.map((t) => {
              const active = tab === t.key;
              const n = count(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className={`whitespace-nowrap rounded-full border px-4 py-1.5 font-display text-sm font-semibold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 ${
                    active ? 'border-flame bg-flame/15 text-flame-hot' : 'border-ink-700 text-paper-mute hover:border-ink-500 hover:text-paper'
                  }`}
                >
                  {t.label}
                  {n !== null && <span className="ml-1.5 text-paper-faint">{n}</span>}
                </button>
              );
            })}
          </div>

          <div role="tabpanel">
            {tab === 'upcoming' && <Rounds games={d.upcoming} today={d.today} empty="Aucun match d’Euroleague à venir cette saison." />}
            {tab === 'results' && <Rounds games={d.results} today={d.today} empty="Aucun match d’Euroleague joué pour l’instant." />}
            {tab === 'standings' && <Standings rows={d.standings} round={d.standings_round} />}
          </div>
        </>
      )}
      <p className="text-xs text-paper-faint">Source : euroleaguebasketball.net · heures de Paris · mis à jour toutes les 10 minutes.</p>
    </div>
  );
}

// ---------------------------------------------------------------- matchs

/** Écusson du club, ou son code quand l'image manque. */
function Crest({ club, size = 28 }: { club: EuroClub; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!club.crest || broken) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-ink-700 font-display text-[10px] font-bold text-paper-dim"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {club.tv}
      </span>
    );
  }
  return (
    // Images du CDN de l'Euroleague : pas d'optimisation Next (export statique).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={club.crest}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/** Matchs regroupés par journée, puis par jour (heure de Paris). */
function Rounds({ games, today, empty }: { games: EuroGame[]; today: string; empty: string }) {
  if (games.length === 0) {
    return <p className="panel-soft px-6 py-10 text-center text-paper-mute">{empty}</p>;
  }
  const rounds: { label: string; days: { key: string; games: EuroGame[] }[] }[] = [];
  for (const g of games) {
    let r = rounds[rounds.length - 1];
    if (!r || r.label !== g.round_label) {
      r = { label: g.round_label, days: [] };
      rounds.push(r);
    }
    const day = r.days[r.days.length - 1];
    if (day && day.key === g.day_paris) day.games.push(g);
    else r.days.push({ key: g.day_paris, games: [g] });
  }
  return (
    <div className="max-w-3xl space-y-8">
      {rounds.map((r) => (
        <section key={r.label} aria-label={r.label} className="space-y-4">
          <h2 className="section-title">{r.label}</h2>
          {r.days.map((day) => {
            const rel = relativeDay(day.key, today);
            return (
              <div key={day.key} className="space-y-2.5">
                <h3 className="flex items-baseline gap-2 border-b border-ink-700/70 pb-2">
                  <span className="font-display text-lg font-bold uppercase tracking-wide">{longDate(day.key)}</span>
                  {['Aujourd\'hui', 'Demain', 'Hier'].includes(rel) && <span className="chip-flame">{rel}</span>}
                </h3>
                <ol className="space-y-2">
                  {day.games.map((g) => (
                    <li key={g.code} className="animate-fade-up">
                      <GameCard game={g} />
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function Side({ club, align, win, lose }: { club: EuroClub; align: 'left' | 'right'; win: boolean; lose: boolean }) {
  return (
    <span
      className={`flex min-w-0 items-center gap-2.5 ${align === 'right' ? 'flex-row-reverse text-right' : ''} ${lose ? 'tone-loss' : ''}`}
      title={club.full}
    >
      <Crest club={club} />
      <span className={`min-w-0 truncate font-display text-base font-bold uppercase tracking-wide ${win ? 'text-paper' : ''}`}>
        <span className="sm:hidden">{club.tv}</span>
        <span className="hidden sm:inline">{club.name}</span>
      </span>
    </span>
  );
}

function GameCard({ game }: { game: EuroGame }) {
  const { home, away } = game;
  const done = game.status === 'final' && home.score !== null && away.score !== null;
  const homeWin = done && (home.score as number) > (away.score as number);
  const awayWin = done && (away.score as number) > (home.score as number);
  const scope = `el-${game.code}`;
  return (
    <div data-scope={scope} className="panel grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-3 sm:px-5">
      <Side club={home} align="right" win={homeWin} lose={awayWin} />
      <div className="flex min-w-[5.5rem] flex-col items-center gap-1 text-center">
        {done ? (
          <>
            <span className="spoil-show num whitespace-nowrap text-2xl font-bold">
              <span className={awayWin ? 'tone-loss' : ''}>{home.score}</span>
              <span className="px-1.5 text-paper-faint">–</span>
              <span className={homeWin ? 'tone-loss' : ''}>{away.score}</span>
            </span>
            <span className="spoil-show text-[11px] uppercase tracking-wider text-paper-mute">Terminé</span>
            <RevealButton id={scope} label="Masqué" />
          </>
        ) : game.status === 'live' ? (
          <span className="chip-live">
            <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" aria-hidden="true" />
            En cours
          </span>
        ) : game.status === 'pending' ? (
          <span className="text-xs text-paper-mute">Score à venir</span>
        ) : (
          <span className="num text-xl font-bold text-paper">{game.time_paris}</span>
        )}
      </div>
      <Side club={away} align="left" win={awayWin} lose={homeWin} />
      {game.tv_fr?.length ? (
        <div className="col-span-3 flex flex-wrap justify-center gap-1.5">
          {/* Chaîne et différé pour un match à venir, diffuseur seul ensuite (comme `GameBadges`). */}
          <TvBadges tv={game.tv_fr} size="sm" short={game.status === 'pending' || game.status === 'final'} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- classement

/** Bandeau de séparation inséré dans le tableau (play-in, éliminés). */
function Divider({ label, tone, cols }: { label: string; tone: string; cols: number }) {
  return (
    <tr aria-hidden="true">
      <td colSpan={cols} className="px-0 py-0">
        <div className="flex items-center gap-3 px-3 py-1.5">
          <span className={`h-px flex-1 ${tone}`} />
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-paper-faint">{label}</span>
          <span className={`h-px flex-1 ${tone}`} />
        </div>
      </td>
    </tr>
  );
}

function Standings({ rows, round }: { rows: EuroStandingRow[]; round: number | null }) {
  if (rows.length === 0) {
    return (
      <p className="panel-soft px-6 py-10 text-center text-paper-mute">
        Le classement apparaîtra après la première journée.
      </p>
    );
  }
  const cols = 9;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-paper-mute">Saison régulière{round !== null && ` · après la journée ${round}`}</p>
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-paper-mute" aria-label="Légende">
          <li className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded bg-flame" aria-hidden="true" />1 à 6 : playoffs
          </li>
          <li className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded bg-warn" aria-hidden="true" />7 à 10 : play-in
          </li>
        </ul>
      </div>
      <section aria-label="Classement de l’Euroleague" className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Classement de l’Euroleague</caption>
            <thead>
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-paper-faint">
                <th scope="col" className="w-10 py-2.5 pl-3 text-left sm:pl-4">
                  <abbr title="Rang" className="no-underline">#</abbr>
                </th>
                <th scope="col" className="py-2.5 text-left">Club</th>
                <th scope="col" className="px-1.5 py-2.5 text-right">
                  <abbr title="Victoires" className="no-underline">V</abbr>
                </th>
                <th scope="col" className="px-1.5 py-2.5 text-right">
                  <abbr title="Défaites" className="no-underline">D</abbr>
                </th>
                <th scope="col" className="hidden px-1.5 py-2.5 text-right sm:table-cell">
                  <abbr title="Pourcentage de victoires" className="no-underline">%</abbr>
                </th>
                <th scope="col" className="hidden px-1.5 py-2.5 text-right md:table-cell">Dom.</th>
                <th scope="col" className="hidden px-1.5 py-2.5 text-right md:table-cell">Ext.</th>
                <th scope="col" className="px-1.5 py-2.5 text-right">
                  <abbr title="Différence de points" className="no-underline">+/-</abbr>
                </th>
                <th scope="col" className="hidden py-2.5 pl-1.5 pr-4 text-right sm:table-cell">
                  <abbr title="Cinq derniers matchs (le plus récent à droite)" className="no-underline">Forme</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const pos = r.position || i + 1;
                const zone = pos <= 6 ? 'bg-flame' : pos <= 10 ? 'bg-warn' : 'bg-ink-600';
                return (
                  <Fragment key={r.code || i}>
                    {pos === 7 && <Divider label="Play-in" tone="bg-warn/40" cols={cols} />}
                    {pos === 11 && <Divider label="Hors course" tone="bg-ink-600" cols={cols} />}
                    <tr className="border-t border-ink-700/50 transition-colors first:border-t-0 hover:bg-ink-800/60">
                      <td className="relative py-2.5 pl-3 sm:pl-4">
                        <span className={`absolute inset-y-1.5 left-0 w-[3px] rounded-r ${zone}`} aria-hidden="true" />
                        <span className="num text-lg font-bold text-paper-dim">{pos}</span>
                      </td>
                      <td className="py-2 pr-2">
                        <span className="flex min-w-0 items-center gap-2.5" title={r.full}>
                          <Crest club={r} size={28} />
                          <span className="min-w-0 truncate font-display text-base font-bold uppercase leading-tight tracking-wide">
                            {r.name}
                          </span>
                        </span>
                      </td>
                      <td className="num px-1.5 py-2 text-right text-base font-bold text-paper">
                        {r.wins}
                      </td>
                      <td className="num px-1.5 py-2 text-right text-base font-bold text-paper-dim">
                        {r.losses}
                      </td>
                      <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-dim sm:table-cell">
                        {r.pct || '—'}
                      </td>
                      <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-mute md:table-cell">
                        {r.home || '—'}
                      </td>
                      <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-mute md:table-cell">
                        {r.road || '—'}
                      </td>
                      <td className={`px-1.5 py-2 text-right tabular-nums ${r.diff > 0 ? 'text-win' : r.diff < 0 ? 'text-loss' : 'text-paper-mute'}`}>
                        {r.diff > 0 ? `+${r.diff}` : r.diff}
                      </td>
                      <td className="hidden py-2 pl-1.5 pr-4 sm:table-cell">
                        <span className="flex justify-end gap-1" aria-label={`Forme : ${r.form.map((x) => (x === 'W' ? 'V' : 'D')).join(' ')}`}>
                          {r.form.map((x, k) => (
                            <span
                              key={k}
                              className={`flex h-5 w-5 items-center justify-center rounded font-display text-[11px] font-bold ${
                                x === 'W' ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'
                              }`}
                            >
                              {x === 'W' ? 'V' : 'D'}
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
