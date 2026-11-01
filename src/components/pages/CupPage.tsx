'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import type { GameView } from '@/lib/queries';
import { isNbaTeam, teamInfo } from '@/lib/teams';
import { seasonLabel } from '@/lib/time';
import GameRow from '@/components/schedule/GameRow';
import { longDate, relativeDay, shortDate } from '@/components/schedule/dates';
import AutoRefresh from '@/components/ui/AutoRefresh';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import TeamLogo from '@/components/ui/TeamLogo';
import { RevealButton } from '@/components/ui/Score';
import { IconCup, TvMini } from '@/components/ui/TvBadge';
import { PageData } from '@/components/page/pageData';
import type { CupGroupRow, NbaCupPage as CupData } from '@/components/page/types';

/**
 * Onglet NBA Cup (`/nba-cup`) : données de `GET /api/pages/nba-cup` (saison
 * la plus récente : l'onglet repart de zéro à chaque saison). Matchs à
 * venir, résultats, classements des groupes et phase finale.
 */
export default function CupPage() {
  return <PageData<CupData> url="/api/pages/nba-cup">{(d) => <Cup d={d} />}</PageData>;
}

type Tab = 'upcoming' | 'results' | 'groups' | 'bracket';

const TABS: { key: Tab; label: string }[] = [
  { key: 'upcoming', label: 'À venir' },
  { key: 'results', label: 'Résultats' },
  { key: 'groups', label: 'Groupes' },
  { key: 'bracket', label: 'Phase finale' },
];

function Cup({ d }: { d: CupData }) {
  const knockout = [...d.bracket.quarter, ...d.bracket.semi, ...d.bracket.final].some((g) => g !== null);
  const [tab, setTab] = useState<Tab>(d.upcoming.length > 0 ? 'upcoming' : knockout ? 'bracket' : 'results');
  const season = d.season !== null ? seasonLabel(d.season) : '';
  const count = (t: Tab) => (t === 'upcoming' ? d.upcoming.length : t === 'results' ? d.results.length : null);

  return (
    <div data-spoilers={d.spoilers} className="space-y-6">
      <AutoRefresh />
      <header className="relative overflow-hidden rounded-2xl border border-cup/40 px-5 py-6 sm:px-8 sm:py-8 cup-card">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-cup/15 text-cup-hot ring-1 ring-cup/40">
              <IconCup size={30} />
            </span>
            <div>
              <p className="kicker !text-cup-hot">Tournoi de début de saison{season ? ` · ${season}` : ''}</p>
              <h1 className="title-xl mt-1">NBA Cup</h1>
            </div>
          </div>
          <SpoilerToggle initial={d.spoilers} />
        </div>
        <p className="mt-4 max-w-2xl text-sm text-paper-mute">
          Phase de groupes en novembre (6 groupes de 5 équipes, 4 matchs chacune), puis quarts de finale, demi-finales et
          finale en décembre. Les vainqueurs de groupe et le meilleur deuxième de chaque conférence se qualifient.
        </p>
        {d.champion && <Champion abbr={d.champion} season={season} />}
      </header>

      {d.total === 0 ? (
        <div className="panel-soft flex flex-col items-center gap-3 px-6 py-14 text-center">
          <IconCup size={44} className="text-cup/60" />
          <p className="font-display text-2xl font-bold uppercase">Pas encore de NBA Cup cette saison</p>
          <p className="max-w-md text-paper-mute">
            Les matchs du tournoi apparaîtront ici dès qu’ils seront au calendrier (phase de groupes à partir de fin
            octobre ou novembre).
          </p>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Sections de la NBA Cup" className="scroll-row flex gap-2 overflow-x-auto">
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
                  className={`whitespace-nowrap rounded-full border px-4 py-1.5 font-display text-sm font-semibold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cup ${
                    active ? 'border-cup bg-cup/15 text-cup-hot' : 'border-ink-700 text-paper-mute hover:border-ink-500 hover:text-paper'
                  }`}
                >
                  {t.label}
                  {n !== null && <span className="ml-1.5 text-paper-faint">{n}</span>}
                </button>
              );
            })}
          </div>

          <div role="tabpanel">
            {tab === 'upcoming' && <GameList games={d.upcoming} today={d.today} empty="Tous les matchs de la NBA Cup ont été joués." />}
            {tab === 'results' && <GameList games={d.results} today={d.today} empty="Aucun match de la NBA Cup joué pour l’instant." />}
            {tab === 'groups' && <Groups conferences={d.conferences} />}
            {tab === 'bracket' && <Bracket bracket={d.bracket} today={d.today} />}
          </div>
        </>
      )}
    </div>
  );
}

function Champion({ abbr, season }: { abbr: string; season: string }) {
  const t = teamInfo(abbr);
  return (
    <div className="spoil-show mt-5 flex items-center gap-3 rounded-xl border border-cup/50 bg-ink-950/50 px-4 py-3">
      <TeamLogo abbr={abbr} size={40} />
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-cup-hot">Vainqueur {season}</p>
        <p className="font-display text-xl font-bold uppercase tracking-wide">
          {t.city} {t.nick}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- listes de matchs

/** Affiche pas encore connue (ESPN : équipes « TBD » avant la fin du tour précédent). */
function isTbd(g: GameView): boolean {
  return !isNbaTeam(g.away.abbr) || !isNbaTeam(g.home.abbr);
}

/** Matchs regroupés par jour (heure de Paris), avec la phase de chaque match. */
function GameList({ games, today, empty }: { games: GameView[]; today: string; empty: string }) {
  if (games.length === 0) {
    return <p className="panel-soft px-6 py-10 text-center text-paper-mute">{empty}</p>;
  }
  const days: { key: string; games: GameView[] }[] = [];
  for (const g of games) {
    const last = days[days.length - 1];
    if (last && last.key === g.day_paris) last.games.push(g);
    else days.push({ key: g.day_paris, games: [g] });
  }
  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.key} aria-label={shortDate(day.key)} className="space-y-2.5">
          <h2 className="flex items-baseline gap-2 border-b border-ink-700/70 pb-2">
            <span className="font-display text-lg font-bold uppercase tracking-wide">{longDate(day.key)}</span>
            {['Aujourd\'hui', 'Demain', 'Hier'].includes(relativeDay(day.key, today)) && (
              <span className="chip-flame">{relativeDay(day.key, today)}</span>
            )}
          </h2>
          <ol className="space-y-2.5">
            {day.games.map((g) => (
              <li key={g.id} className="animate-fade-up">
                {isTbd(g) ? <TbdRow game={g} /> : <GameRow game={g} />}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- groupes

function Groups({ conferences }: { conferences: CupData['conferences'] }) {
  return (
    <div className="space-y-8">
      {conferences.map((c) => (
        <section key={c.conference} aria-labelledby={`cup-conf-${c.conference}`} className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id={`cup-conf-${c.conference}`} className="section-title">
              Conférence {c.conference}
            </h2>
            <p className="text-xs text-paper-mute">
              {c.complete ? 'Phase de groupes terminée' : 'Classement provisoire · qualifiés connus à la fin des groupes'}
            </p>
          </div>
          {c.groups.length === 0 ? (
            <p className="panel-soft px-6 py-8 text-center text-paper-mute">Groupes pas encore au calendrier.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {c.groups.map((g) => (
                <GroupTable key={g.name} name={g.name} played={g.played} total={g.total} rows={g.rows} />
              ))}
            </div>
          )}
        </section>
      ))}
      <p className="text-xs text-paper-faint">
        Classement : victoires, puis différence de points, puis points marqués (départage simplifié ; la NBA applique
        d’abord la confrontation directe). Les groupes sont numérotés dans l’ordre alphabétique de leurs équipes.
      </p>
    </div>
  );
}

function GroupTable({ name, played, total, rows }: { name: string; played: number; total: number; rows: CupGroupRow[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-700/70 px-4 py-2.5">
        <h3 className="font-display text-base font-bold uppercase tracking-wide text-cup-hot">{name}</h3>
        <span className="text-[11px] text-paper-mute">
          {played}/{total} matchs joués
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-paper-faint">
            <th scope="col" className="w-8 px-2 py-1.5 text-center font-semibold">
              #
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              Équipe
            </th>
            <th scope="col" className="px-2 py-1.5 text-center font-semibold" title="Victoires – défaites">
              V–D
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold" title="Différence de points">
              +/−
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const t = teamInfo(r.abbr);
            return (
              <tr
                key={r.abbr}
                className={`border-t border-ink-700/50 ${r.qualified ? 'bg-cup/10' : ''}`}
                style={{ '--team': t.accent } as CSSProperties}
              >
                <td className="px-2 py-2 text-center">
                  <span className="spoil-show num text-paper-mute">{i + 1}</span>
                </td>
                <td className="px-2 py-2">
                  <Link href={`/equipes/${r.abbr}`} className="flex min-w-0 items-center gap-2 hover:text-flame-hot">
                    <TeamLogo abbr={r.abbr} size={24} />
                    <span className="truncate font-display font-bold uppercase tracking-wide">{t.nick}</span>
                    {r.qualified && (
                      <span className="spoil-show shrink-0 rounded bg-cup/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cup-hot">
                        Qualifié
                      </span>
                    )}
                  </Link>
                </td>
                <td className="px-2 py-2 text-center">
                  <span className="spoil-show num font-semibold">
                    {r.wins}–{r.losses}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={`spoil-show num ${r.diff > 0 ? 'text-win' : r.diff < 0 ? 'text-loss' : 'text-paper-mute'}`}>
                    {r.diff > 0 ? `+${r.diff}` : r.diff}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- phase finale

const ROUNDS: { key: keyof CupData['bracket']; title: string; when: string }[] = [
  { key: 'quarter', title: 'Quarts de finale', when: 'Début décembre, chez le mieux classé' },
  { key: 'semi', title: 'Demi-finales', when: 'Mi-décembre, à Las Vegas' },
  { key: 'final', title: 'Finale', when: 'Mi-décembre, à Las Vegas' },
];

function Bracket({ bracket, today }: { bracket: CupData['bracket']; today: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {ROUNDS.map((r) => (
        <section key={r.key} aria-labelledby={`cup-round-${r.key}`} className="space-y-3">
          <div>
            <h2 id={`cup-round-${r.key}`} className="font-display text-lg font-bold uppercase tracking-wide text-cup-hot">
              {r.title}
            </h2>
            <p className="text-xs text-paper-faint">{r.when}</p>
          </div>
          <ol className={`flex flex-col gap-3 ${r.key === 'final' ? 'lg:justify-center' : ''} ${r.key === 'semi' ? 'lg:justify-around' : ''} lg:h-[calc(100%-3rem)]`}>
            {bracket[r.key].map((g, i) => (
              <li key={g?.id ?? `${r.key}-${i}`}>
                {g && !isTbd(g) ? <BracketGame game={g} today={today} /> : <TbdSlot game={g ?? undefined} />}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** Match de la phase finale dont l'affiche n'est pas connue (heure non fixée). */
function TbdRow({ game }: { game: GameView }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-cup/40 px-4 py-4 sm:px-5">
      <span className="flex items-center gap-3">
        <IconCup size={20} className="text-cup-hot" />
        <span>
          <span className="block font-display text-lg font-bold uppercase tracking-wide text-cup-hot">{game.cup?.label ?? 'NBA Cup'}</span>
          <span className="text-sm text-paper-mute">Affiche à déterminer · horaire à confirmer</span>
        </span>
      </span>
      <TvMini tv={game.tv_fr} />
    </div>
  );
}

function TbdSlot({ game }: { game?: GameView }) {
  return (
    <div className="flex min-h-[104px] flex-col justify-center gap-2 rounded-xl border border-dashed border-cup/30 px-4 py-3 text-paper-faint">
      {game && (
        <span className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-paper-mute">
          <span className="first-letter:uppercase">{shortDate(game.day_paris)}</span>
          <TvMini tv={game.tv_fr} />
        </span>
      )}
      <span className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide">
        <span className="h-6 w-6 rounded-full bg-ink-700" /> À déterminer
      </span>
      <span className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide">
        <span className="h-6 w-6 rounded-full bg-ink-700" /> À déterminer
      </span>
    </div>
  );
}

function BracketGame({ game, today }: { game: GameView; today: string }) {
  const done = game.status === 'final' && game.away.score !== null && game.home.score !== null;
  const awayWin = done && (game.away.score as number) > (game.home.score as number);
  const homeWin = done && (game.home.score as number) > (game.away.score as number);
  const side = (abbr: string, score: number | null, win: boolean, lose: boolean) => {
    const t = teamInfo(abbr);
    return (
      <span className="flex items-center justify-between gap-2">
        <span className={`flex min-w-0 items-center gap-2 ${lose ? 'tone-loss' : ''}`}>
          <TeamLogo abbr={abbr} size={24} />
          <span className="truncate font-display text-[15px] font-bold uppercase tracking-wide">{t.nick}</span>
        </span>
        {game.status !== 'scheduled' && (
          <span className={`spoil-show num text-base font-bold ${win ? 'text-cup-hot' : lose ? 'tone-loss' : ''}`}>{score}</span>
        )}
      </span>
    );
  };
  return (
    <div className="cup-card relative rounded-xl border px-4 py-3">
      <Link
        href={`/matchs/${game.id}`}
        aria-label={`${teamInfo(game.away.abbr).nick} contre ${teamInfo(game.home.abbr).nick}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cup"
      />
      <div className="pointer-events-none relative space-y-1.5">
        {side(game.away.abbr, game.away.score, awayWin, homeWin)}
        {side(game.home.abbr, game.home.score, homeWin, awayWin)}
        <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-paper-mute">
          <span>
            {game.status === 'final'
              ? 'Terminé'
              : game.status === 'live'
                ? 'En direct'
                : `${relativeDay(game.day_paris, today)} · ${game.time_paris}`}
          </span>
          <TvMini tv={game.tv_fr} />
          {game.status === 'final' && (
            <span className="pointer-events-auto">
              <RevealButton id={game.id} label="Masqué" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
