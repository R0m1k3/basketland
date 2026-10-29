import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  dayCounts,
  defaultCalendarDay,
  gamesOfDay,
  isDateKey,
  isUpcoming,
  nextDayWithGames,
  prevDayWithGames,
  seasonRecords,
  shiftKey,
  teamGames,
  todayKey,
  type GameView,
} from '@/lib/queries';
import { isNbaTeam, teamInfo } from '@/lib/teams';
import DayStrip from '@/components/schedule/DayStrip';
import GameRow from '@/components/schedule/GameRow';
import TeamGameRow from '@/components/schedule/TeamGameRow';
import TeamPicker from '@/components/schedule/TeamPicker';
import { longDate, monthYear, relativeDay, shortDate, weekdayLong } from '@/components/schedule/dates';
import AutoRefresh from '@/components/ui/AutoRefresh';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import TeamLogo from '@/components/ui/TeamLogo';
import { IconArrowRight, IconChevronLeft, IconChevronRight, IconClose } from '@/components/ui/Icons';
import { spoilerMode } from '@/components/ui/spoilers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendrier' };

type SP = Promise<Record<string, string | string[] | undefined>>;

const dayHref = (k: string) => `/matchs?d=${k}`;

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const spoilers = await spoilerMode();
  const today = todayKey();
  const teamParam = one('team')?.toUpperCase();
  const team = teamParam && isNbaTeam(teamParam) ? teamParam : undefined;
  const d = one('d');
  const selected = isDateKey(d) ? d : defaultCalendarDay();

  return (
    <div data-spoilers={spoilers} className="space-y-6">
      {/* Nouveaux replays, scores et badges sans recharger (toutes les 5 min, onglet visible). */}
      <AutoRefresh />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker">Calendrier NBA · heures de Paris</p>
          <h1 className="title-xl mt-2">{team ? 'Calendrier équipe' : 'Les matchs'}</h1>
        </div>
        <SpoilerToggle initial={spoilers} />
      </header>

      {team ? <TeamView team={team} today={today} backHref={dayHref(selected)} /> : <DayView selected={selected} today={today} />}
    </div>
  );
}

// ---------------------------------------------------------------- vue « jour »

function DayView({ selected, today }: { selected: string; today: string }) {
  const counts = dayCounts(shiftKey(selected, -7), shiftKey(selected, 7));
  const games = gamesOfDay(selected);
  const records = seasonRecords();
  const prev = prevDayWithGames(selected);
  const next = nextDayWithGames(selected, true);
  const replays = games.filter((g) => g.hasReplay).length;
  const upcoming = games.filter((g) => isUpcoming(g)).length;
  const live = games.filter((g) => g.status === 'live').length;
  // Les matchs d'avant midi se jouent dans la nuit qui précède (heure de Paris).
  const allNight = games.length > 0 && games.every((g) => Number(g.time_paris.slice(0, 2)) < 12);
  const rel = relativeDay(selected, today);

  return (
    <>
      <DayStrip selected={selected} today={today} counts={counts} hrefFor={dayHref} />
      <TeamPicker allHref={dayHref(selected)} />

      <section aria-labelledby="day-title" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-ink-700/70 pb-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="day-title" className="title-lg">
                {longDate(selected)}
              </h2>
              {['Aujourd\'hui', 'Demain', 'Hier'].includes(rel) && <span className="chip-flame">{rel}</span>}
            </div>
            {allNight && (
              <p className="mt-1 text-sm text-paper-mute">
                Dans la nuit du {weekdayLong(shiftKey(selected, -1))} au {weekdayLong(selected)}
              </p>
            )}
          </div>
          {games.length > 0 && (
            <dl className="flex items-center gap-5 text-sm">
              <Stat n={games.length} label={games.length > 1 ? 'matchs' : 'match'} />
              {live > 0 && <Stat n={live} label="en direct" tone="text-live" />}
              {upcoming > 0 && <Stat n={upcoming} label="à venir" tone="text-flame-hot" />}
              {replays > 0 && <Stat n={replays} label={replays > 1 ? 'replays' : 'replay'} />}
            </dl>
          )}
        </div>

        {games.length === 0 ? (
          <div className="panel-soft flex flex-col items-center gap-4 px-6 py-14 text-center">
            <span className="font-display text-6xl font-extrabold uppercase text-ink-600">Relâche</span>
            <p className="max-w-md text-paper-mute">Aucun match NBA ce jour-là.</p>
            {next && (
              <Link href={dayHref(next)} className="btn-primary">
                Prochains matchs : {shortDate(next)}
                <IconArrowRight />
              </Link>
            )}
          </div>
        ) : (
          <ol className="space-y-2.5">
            {games.map((g) => (
              <li key={g.id} className="animate-fade-up">
                <GameRow game={g} records={records} />
              </li>
            ))}
          </ol>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          {prev ? (
            <Link href={dayHref(prev)} className="btn">
              <IconChevronLeft size={16} />
              {shortDate(prev)}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={dayHref(next)} className="btn">
              {shortDate(next)}
              <IconChevronRight size={16} />
            </Link>
          )}
        </div>
      </section>
    </>
  );
}

function Stat({ n, label, tone = 'text-paper' }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="sr-only">{label}</dt>
      <dd className={`num text-2xl font-bold ${tone}`}>{n}</dd>
      <span className="text-paper-mute" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- vue « équipe »

function groupByMonth(games: GameView[]): { key: string; label: string; games: GameView[] }[] {
  const out: { key: string; label: string; games: GameView[] }[] = [];
  for (const g of games) {
    const k = g.day_paris.slice(0, 7);
    let grp = out[out.length - 1];
    if (!grp || grp.key !== k) {
      grp = { key: k, label: monthYear(g.day_paris), games: [] };
      out.push(grp);
    }
    grp.games.push(g);
  }
  return out;
}

function TeamView({ team, today, backHref }: { team: string; today: string; backHref: string }) {
  const t = teamInfo(team);
  const all = teamGames(team);
  const now = new Date();
  const upcoming = all.filter((g) => isUpcoming(g, now));
  const played = all.filter((g) => g.status === 'final').reverse();
  const rec = seasonRecords().get(team) ?? { wins: 0, losses: 0 };
  const nextGame = upcoming[0];

  return (
    <>
      <TeamPicker selected={team} allHref={backHref} />

      <div
        className="relative isolate overflow-hidden rounded-2xl border border-ink-700/70 p-4 sm:p-6"
        style={
          {
            background: `linear-gradient(110deg, ${t.primary}66, ${t.primary}1a 55%, transparent), #111116`,
            '--team-a': t.accent,
            '--team-b': t.primary,
          } as CSSProperties
        }
      >
        <div className="team-stripe absolute inset-x-0 top-0 h-[3px]" />
        <div className="flex flex-wrap items-center gap-4">
          <TeamLogo abbr={team} size={64} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-paper-dim">{t.city}</p>
            <h2 className="title-lg leading-none">{t.nick}</h2>
            <p className="mt-1 text-sm text-paper-dim">
              Bilan <span className="num text-base font-bold text-paper">{rec.wins}–{rec.losses}</span> · {upcoming.length} match
              {upcoming.length > 1 ? 's' : ''} à venir
            </p>
          </div>
          <div className="flex basis-full flex-wrap gap-2 sm:basis-auto">
            <Link href={`/equipes/${team}`} className="btn">
              Fiche équipe
              <IconArrowRight />
            </Link>
            <Link href={backHref} className="btn-ghost" aria-label="Retirer le filtre équipe">
              <IconClose />
              <span className="hidden sm:inline">Retirer le filtre</span>
            </Link>
          </div>
        </div>
        {nextGame && (
          <p className="mt-4 text-sm text-paper-dim">
            Prochain match :{' '}
            <Link href={`/matchs/${nextGame.id}`} className="font-semibold text-paper underline decoration-flame/60 underline-offset-4 hover:text-flame-hot">
              {relativeDay(nextGame.day_paris, today)} à {nextGame.time_paris}, {nextGame.home.abbr === team ? 'contre' : 'à'}{' '}
              {teamInfo(nextGame.home.abbr === team ? nextGame.away.abbr : nextGame.home.abbr).nick}
            </Link>
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10">
        <section aria-labelledby="up-title" className="min-w-0 space-y-5">
          <h3 id="up-title" className="flex items-baseline gap-3">
            <span className="section-title">À venir</span>
            <span className="num text-xl text-flame-hot">{upcoming.length}</span>
          </h3>
          {upcoming.length === 0 ? (
            <p className="text-sm text-paper-mute">Aucun match programmé pour l&apos;instant.</p>
          ) : (
            groupByMonth(upcoming).map((m) => (
              <div key={m.key} className="space-y-2">
                <h4 className="kicker sticky top-16 z-10 -mx-1 bg-ink-950/90 px-1 py-1.5 backdrop-blur">{m.label}</h4>
                <ol className="space-y-2">
                  {m.games.map((g) => (
                    <li key={g.id}>
                      <TeamGameRow game={g} team={team} />
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </section>

        <section aria-labelledby="past-title" className="min-w-0 space-y-5">
          <h3 id="past-title" className="flex items-baseline gap-3">
            <span className="section-title">Résultats</span>
            <span className="num text-xl text-paper-mute">{played.length}</span>
          </h3>
          {played.length === 0 ? (
            <p className="text-sm text-paper-mute">Aucun match joué cette saison.</p>
          ) : (
            groupByMonth(played).map((m) => (
              <div key={m.key} className="space-y-2">
                <h4 className="kicker sticky top-16 z-10 -mx-1 bg-ink-950/90 px-1 py-1.5 backdrop-blur">{m.label}</h4>
                <ol className="space-y-2">
                  {m.games.map((g) => (
                    <li key={g.id}>
                      <TeamGameRow game={g} team={team} />
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
