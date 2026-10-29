import Link from 'next/link';
import {
  cachedStandings,
  gamesOfNight,
  latestReplays,
  latestSeason,
  liveGames,
  nextNightKey,
  nightKeyOf,
  shiftKey,
  todayKey,
  upcomingDays,
} from '@/lib/queries';
import { teamInfo } from '@/lib/teams';
import { seasonLabel } from '@/lib/time';
import Hero from '@/components/home/Hero';
import ReplayCard from '@/components/home/ReplayCard';
import CompactGame from '@/components/home/CompactGame';
import GameRow from '@/components/schedule/GameRow';
import { countdown, longDate, nightLabel, playedWhen, relativeDay, shortDate } from '@/components/schedule/dates';
import AutoRefresh from '@/components/ui/AutoRefresh';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import TeamLogo from '@/components/ui/TeamLogo';
import { IconArrowRight, IconCalendar } from '@/components/ui/Icons';
import { spoilerMode } from '@/components/ui/spoilers';

export const dynamic = 'force-dynamic';

function nightTitle(night: string, today: string): string {
  if (night === today || night === shiftKey(today, -1)) return 'Cette nuit';
  if (night === shiftKey(today, 1)) return 'Demain soir';
  return 'Prochaine nuit';
}

export default async function HomePage() {
  const spoilers = await spoilerMode();
  const now = new Date();
  const today = todayKey(now);
  const season = latestSeason();

  const live = liveGames();
  const replays = latestReplays(9);
  const hero = replays[0];
  const night = nextNightKey(now);
  const nightGames = night ? gamesOfNight(night) : [];
  const nextUp = nightGames.find((g) => g.status === 'scheduled' && Date.parse(g.date_utc) > now.getTime());
  const lastNightDay = nightGames.reduce((m, g) => (g.day_paris > m ? g.day_paris : m), today);
  const days = upcomingDays(shiftKey(lastNightDay, 1), 4, now);
  const standings = cachedStandings();

  return (
    <div data-spoilers={spoilers} className="space-y-12 sm:space-y-16">
      {/* Nouveaux replays, scores et badges sans recharger (toutes les 5 min, onglet visible). */}
      <AutoRefresh />
      {/* Bandeau de date, façon une de journal */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 pb-4">
        <p className="kicker flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-paper">{longDate(today)}</span>
          {season !== undefined && <span>Saison {seasonLabel(season)}</span>}
          <span className="hidden sm:inline">Heures de Paris</span>
        </p>
        <SpoilerToggle initial={spoilers} />
      </div>

      {live.length > 0 && (
        <section aria-labelledby="live-title" className="space-y-4">
          <h2 id="live-title" className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-pulse-live rounded-full bg-live" aria-hidden="true" />
            <span className="section-title">En direct</span>
          </h2>
          <div className="space-y-2.5">
            {live.map((g) => (
              <GameRow key={g.id} game={g} />
            ))}
          </div>
        </section>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {hero ? (
          <Hero game={hero} kicker={nightLabel(nightKeyOf(hero.date_utc))} />
        ) : (
          <section className="panel flex min-h-[320px] flex-col justify-center gap-4 p-8">
            <p className="kicker">Replays</p>
            <h1 className="title-xl">Tous les matchs NBA, en VF.</h1>
            <p className="max-w-xl text-paper-dim">
              Les replays apparaissent ici dès qu&apos;ils sont disponibles, avec les sous-titres français synchronisés.
            </p>
            <Link href="/matchs" className="btn-primary w-fit">
              Voir le calendrier
            </Link>
          </section>
        )}

        {/* Cette nuit */}
        <aside aria-labelledby="night-title" className="panel flex flex-col overflow-hidden">
          <div className="border-b border-ink-700/70 px-5 pb-4 pt-5">
            <p className="kicker">{night ? nightLabel(night) : 'Programme'}</p>
            <div className="mt-1 flex items-end justify-between gap-3">
              <h2 id="night-title" className="section-title">
                {night ? nightTitle(night, today) : 'À venir'}
              </h2>
              {nightGames.length > 0 && (
                <span className="text-sm text-paper-mute">
                  <span className="num text-xl font-bold text-paper">{nightGames.length}</span> match{nightGames.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
            {nextUp && (
              <p className="mt-2 text-sm text-paper-dim">
                Coup d&apos;envoi <span className="font-semibold text-flame-hot">{countdown(nextUp.date_utc, now)}</span>
              </p>
            )}
          </div>
          {nightGames.length === 0 ? (
            <p className="px-5 py-8 text-sm text-paper-mute">Aucun match programmé pour le moment.</p>
          ) : (
            <ol className="flex flex-col gap-0.5 p-2">
              {nightGames.map((g) => (
                <li key={g.id}>
                  <CompactGame game={g} highlight={g.id === nextUp?.id} />
                </li>
              ))}
            </ol>
          )}
          {nightGames.length > 0 && (
            <Link
              href={`/matchs?d=${nightGames[0].day_paris}`}
              className="mt-auto flex items-center justify-between border-t border-ink-700/70 px-5 py-3.5 text-sm font-medium text-paper-dim transition hover:bg-ink-800 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame"
            >
              <span className="flex items-center gap-2">
                <IconCalendar />
                Voir dans le calendrier
              </span>
              <IconArrowRight />
            </Link>
          )}
        </aside>
      </div>

      {/* Replays disponibles */}
      {replays.length > 1 && (
        <section id="replays" aria-labelledby="replays-title" className="scroll-mt-24 space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="kicker">Avec sous-titres français</p>
              <h2 id="replays-title" className="section-title mt-1">
                Replays disponibles
              </h2>
            </div>
            <Link href="/matchs" className="link-more">
              Calendrier
              <IconArrowRight />
            </Link>
          </div>
          <div className="scroll-row -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 lg:mx-0 lg:grid-cols-4 lg:px-0">
            {replays.slice(1, 9).map((g) => (
              <ReplayCard key={g.id} game={g} when={playedWhen(g.day_paris, g.time_paris, today)} className="w-[82%] shrink-0 snap-start sm:w-auto" />
            ))}
          </div>
        </section>
      )}

      {/* Prochains jours */}
      {days.length > 0 && (
        <section aria-labelledby="next-title" className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="kicker">Les prochains jours</p>
              <h2 id="next-title" className="section-title mt-1">
                À venir
              </h2>
            </div>
            <Link href={`/matchs?d=${days[0].key}`} className="link-more">
              Tout le calendrier
              <IconArrowRight />
            </Link>
          </div>
          <div className="scroll-row -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 md:pb-0 xl:grid-cols-4">
            {days.map((d) => (
              <div key={d.key} className="panel-soft flex w-[85%] shrink-0 snap-start flex-col md:w-auto">
                <div className="flex items-baseline justify-between gap-2 border-b border-ink-700/60 px-4 py-3">
                  <h3 className="font-display text-xl font-bold uppercase tracking-wide">{relativeDay(d.key, today)}</h3>
                  <span className="text-xs text-paper-mute">
                    {['Demain', "Aujourd'hui"].includes(relativeDay(d.key, today)) ? `${shortDate(d.key)} · ` : ''}
                    {d.games.length} match{d.games.length > 1 ? 's' : ''}
                  </span>
                </div>
                <ol className="flex flex-col gap-0.5 p-1.5">
                  {d.games.slice(0, 6).map((g) => (
                    <li key={g.id}>
                      <CompactGame game={g} />
                    </li>
                  ))}
                </ol>
                <Link
                  href={`/matchs?d=${d.key}`}
                  className="mt-auto px-4 pb-3 pt-1 text-sm font-medium text-paper-mute transition hover:text-flame-hot focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
                >
                  {d.games.length > 7
                    ? `+ ${d.games.length - 6} autres matchs`
                    : d.games.length === 7
                      ? '+ 1 autre match'
                      : 'Voir la journée'}{' '}
                  →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Classement en bref */}
      {standings && standings.length > 0 && (
        <section aria-labelledby="std-title" className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="kicker">Têtes de série</p>
              <h2 id="std-title" className="section-title mt-1">
                Le classement
              </h2>
            </div>
            <Link href="/classement" className="link-more">
              Classement complet
              <IconArrowRight />
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {standings.map((conf) => (
              <div key={conf.conference} className="panel-soft p-2">
                <h3 className="px-3 pb-1 pt-2 font-display text-sm font-bold uppercase tracking-[0.18em] text-paper-mute">
                  {conf.conference}
                </h3>
                <ol>
                  {conf.rows.slice(0, 5).map((r, i) => {
                    const t = teamInfo(r.abbr);
                    return (
                      <li key={r.abbr}>
                        <Link
                          href={`/equipes/${r.abbr}`}
                          className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
                        >
                          <span className="num w-5 text-lg font-bold text-paper-faint">{r.seed || i + 1}</span>
                          <TeamLogo abbr={r.abbr} size={28} />
                          <span className="min-w-0 flex-1 truncate font-display text-base font-bold uppercase tracking-wide">{t.nick}</span>
                          <span className="num text-lg font-bold">
                            {r.wins}–{r.losses}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
