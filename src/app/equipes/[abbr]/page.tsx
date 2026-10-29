import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';
import { cachedStandings, isUpcoming, latestSeason, teamGames, todayKey, type GameView } from '@/lib/queries';
import { isNbaTeam, teamInfo, teamLogoUrl } from '@/lib/teams';
import { seasonLabel } from '@/lib/time';
import GameRow from '@/components/schedule/GameRow';
import TeamGameRow from '@/components/schedule/TeamGameRow';
import ReplayCard from '@/components/home/ReplayCard';
import FormStrip from '@/components/team/FormStrip';
import { countdown, playedWhen, relativeDay } from '@/components/schedule/dates';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import TeamLogo from '@/components/ui/TeamLogo';
import { IconArrowRight, IconCalendar } from '@/components/ui/Icons';
import { spoilerMode } from '@/components/ui/spoilers';

/**
 * Page équipe : bannière aux couleurs du club, bilan et forme, prochain
 * match, calendrier à venir, résultats et replays.
 *
 * Les données viennent de la base locale (aucun appel ESPN à l'affichage) :
 * la page reste instantanée et fonctionne même si l'API est indisponible.
 */
export const dynamic = 'force-dynamic';

const ABBR_RE = /^[A-Z]{2,4}$/;

export async function generateMetadata({ params }: { params: Promise<{ abbr: string }> }): Promise<Metadata> {
  const abbr = (await params).abbr.toUpperCase();
  const t = teamInfo(abbr);
  return { title: isNbaTeam(abbr) ? `${t.city} ${t.nick}` : abbr };
}

interface Split {
  wins: number;
  losses: number;
}

/** Bilan de la SAISON RÉGULIÈRE EN COURS uniquement (ni présaison, ni playoffs, ni saisons passées). */
function seasonSummary(games: GameView[], team: string) {
  const season = latestSeason();
  const regular = games.filter((g) => g.status === 'final' && g.season === season && g.season_type === 'regular');
  const total: Split = { wins: 0, losses: 0 };
  const home: Split = { wins: 0, losses: 0 };
  const road: Split = { wins: 0, losses: 0 };
  const results: boolean[] = [];
  for (const g of regular) {
    const isHome = g.home.abbr === team;
    const mine = isHome ? g.home.score : g.away.score;
    const theirs = isHome ? g.away.score : g.home.score;
    if (mine === null || theirs === null || mine === theirs) continue;
    const won = mine > theirs;
    const bucket = isHome ? home : road;
    if (won) {
      total.wins++;
      bucket.wins++;
    } else {
      total.losses++;
      bucket.losses++;
    }
    results.push(won);
  }
  // Série en cours : nombre de résultats identiques consécutifs à la fin.
  let streak = 0;
  const last = results[results.length - 1];
  for (let i = results.length - 1; i >= 0 && results[i] === last; i--) streak++;
  return { season, total, home, road, streak: streak ? `${last ? 'V' : 'D'}${streak}` : '—', streakWin: last };
}

function StatBlock({ label, value, sub, spoil }: { label: string; value: string; sub?: string; spoil?: boolean }) {
  return (
    <div className="min-w-0 sm:min-w-[5.5rem]">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-paper-dim">{label}</dt>
      <dd className={`num mt-1 text-3xl font-bold leading-none sm:text-4xl ${spoil ? 'spoil-show' : ''}`}>{value}</dd>
      {spoil && (
        <dd className="spoil-only num mt-1 text-3xl font-bold leading-none text-paper-faint sm:text-4xl" aria-label="masqué">
          ?
        </dd>
      )}
      {sub && <dd className="mt-1 text-xs text-paper-mute">{sub}</dd>}
    </div>
  );
}

export default async function TeamPage({ params }: { params: Promise<{ abbr: string }> }) {
  const { abbr: raw } = await params;
  const abbr = raw.toUpperCase();
  if (!ABBR_RE.test(abbr)) notFound();

  const all = teamGames(abbr);
  if (!all.length && !isNbaTeam(abbr)) notFound();

  const spoilers = await spoilerMode();
  const t = teamInfo(abbr);
  const now = new Date();
  const today = todayKey(now);
  const upcoming = all.filter((g) => isUpcoming(g, now));
  const finished = all.filter((g) => g.status === 'final');
  const recent = [...finished].reverse();
  const replays = recent.filter((g) => g.hasReplay);
  const summary = seasonSummary(all, abbr);
  const nextGame = upcoming[0];

  const conf = cachedStandings()?.find((c) => c.rows.some((r) => r.abbr === abbr));
  const rank = conf ? conf.rows.findIndex((r) => r.abbr === abbr) : -1;
  const seed = conf && rank >= 0 ? conf.rows[rank].seed || rank + 1 : undefined;
  const played = summary.total.wins + summary.total.losses;
  const pct = played ? Math.round((summary.total.wins / played) * 1000) / 10 : undefined;
  const fmt = (s: Split) => `${s.wins}–${s.losses}`;

  return (
    <div data-spoilers={spoilers} className="space-y-10">
      {/* Bannière */}
      <section
        aria-labelledby="team-title"
        className="grain relative isolate overflow-hidden rounded-[28px] border border-ink-700/80 shadow-card"
        style={
          {
            background: `linear-gradient(118deg, ${t.primary} 0%, ${t.primary}b3 32%, #111116 78%)`,
            '--team-a': t.accent,
            '--team-b': t.primary,
          } as CSSProperties
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={teamLogoUrl(abbr)}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 -z-10 h-[460px] w-[460px] rotate-[-10deg] select-none opacity-[0.16] sm:-right-10 sm:h-[560px] sm:w-[560px]"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-2/3 bg-gradient-to-t from-ink-950/80 to-transparent" />
        <div className="team-stripe absolute inset-x-0 bottom-0 h-[3px]" />

        <div className="relative flex flex-col gap-7 p-5 sm:p-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="kicker text-paper-dim">
              Conférence {t.conference} · Division {t.division}
              {summary.season !== undefined ? ` · ${seasonLabel(summary.season)}` : ''}
            </p>
            <SpoilerToggle initial={spoilers} />
          </div>

          <div className="flex items-center gap-4 sm:gap-6">
            <TeamLogo abbr={abbr} size={76} className="sm:hidden" />
            <TeamLogo abbr={abbr} size={128} className="hidden sm:inline-flex" />
            <div className="min-w-0">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-paper-dim sm:text-base">{t.city}</p>
              <h1 id="team-title" className="font-display text-5xl font-extrabold uppercase leading-[0.85] tracking-tight sm:text-7xl lg:text-8xl">
                {t.nick}
              </h1>
            </div>
          </div>

          <dl data-scope={`form-${abbr}`} className="grid grid-cols-3 gap-x-4 gap-y-5 sm:flex sm:flex-wrap sm:gap-x-12">
            <StatBlock label="Bilan" value={fmt(summary.total)} sub={pct !== undefined ? `${pct.toLocaleString('fr-FR')} % de victoires` : 'Saison régulière'} />
            {seed && <StatBlock label="Rang" value={`${seed}${seed === 1 ? 're' : 'e'}`} sub={`Conférence ${t.conference}`} />}
            <StatBlock label="Domicile" value={fmt(summary.home)} />
            <StatBlock label="Extérieur" value={fmt(summary.road)} />
            <StatBlock label="Série" value={summary.streak} sub="en cours" spoil />
          </dl>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <FormStrip games={finished.filter((g) => g.season_type === 'regular').slice(-10)} team={abbr} />
            <Link href={`/matchs?team=${abbr}`} className="btn bg-ink-950/50 backdrop-blur">
              <IconCalendar />
              Calendrier complet
            </Link>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Prochain match */}
          <section aria-labelledby="next-title" className="min-w-0 space-y-4 lg:col-start-1">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="next-title" className="section-title">
                Prochain match
              </h2>
              {nextGame && nextGame.status !== 'live' && (
                <p className="text-sm text-paper-mute">
                  {relativeDay(nextGame.day_paris, today)} à <span className="num text-base text-paper">{nextGame.time_paris}</span> ·{' '}
                  <span className="font-semibold text-flame-hot">{countdown(nextGame.date_utc, now)}</span>
                </p>
              )}
            </div>
            {nextGame ? (
              <div className="space-y-2">
                <GameRow game={nextGame} />
                {nextGame.venue && <p className="px-1 text-xs text-paper-mute">{nextGame.venue}</p>}
              </div>
            ) : (
              <p className="panel-soft px-5 py-6 text-sm text-paper-mute">Aucun match programmé pour l&apos;instant.</p>
            )}
          </section>

          {/* À venir */}
          <aside aria-labelledby="up-title" className="panel space-y-3 p-3 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-3 lg:row-start-1">
            <div className="flex items-end justify-between px-2 pt-2">
              <h2 id="up-title" className="section-title">
                À venir
              </h2>
              <span className="text-sm text-paper-mute">
                <span className="num text-xl font-bold text-paper">{upcoming.length}</span> matchs
              </span>
            </div>
            {upcoming.length === 0 ? (
              <p className="px-2 pb-3 text-sm text-paper-mute">Rien de programmé.</p>
            ) : (
              <ol className="space-y-2">
                {upcoming.slice(1, 9).map((g) => (
                  <li key={g.id}>
                    <TeamGameRow game={g} team={abbr} />
                  </li>
                ))}
              </ol>
            )}
            <Link href={`/matchs?team=${abbr}`} className="btn w-full">
              Tout le calendrier
              <IconArrowRight />
            </Link>
          </aside>

          {/* Replays */}
          <section aria-labelledby="rep-title" className="min-w-0 space-y-4 lg:col-start-1">
            <h2 id="rep-title" className="flex items-baseline gap-3">
              <span className="section-title">Replays</span>
              <span className="num text-xl text-flame-hot">{replays.length}</span>
            </h2>
            {replays.length === 0 ? (
              <p className="panel-soft px-5 py-6 text-sm text-paper-mute">
                Aucun replay n&apos;a encore été récupéré pour cette équipe. La recherche est automatique et tourne toutes les deux
                heures.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {replays.slice(0, 6).map((g) => (
                  <ReplayCard key={g.id} game={g} when={playedWhen(g.day_paris, g.time_paris, today)} />
                ))}
              </div>
            )}
          </section>

          {/* Résultats */}
          <section aria-labelledby="res-title" className="min-w-0 space-y-4 lg:col-start-1">
            <h2 id="res-title" className="flex items-baseline gap-3">
              <span className="section-title">Résultats récents</span>
              <span className="num text-xl text-paper-mute">{finished.length}</span>
            </h2>
            {recent.length === 0 ? (
              <p className="text-sm text-paper-mute">Aucun match terminé enregistré.</p>
            ) : (
              <ol className="space-y-2">
                {recent.slice(0, 10).map((g) => (
                  <li key={g.id}>
                    <TeamGameRow game={g} team={abbr} />
                  </li>
                ))}
              </ol>
            )}
          </section>
      </div>
    </div>
  );
}
