'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { TeamRecord } from '@/lib/queries';
import { teamLogoUrl } from '@/lib/teams';
import { seasonLabel } from '@/lib/time';
import GameRow from '@/components/schedule/GameRow';
import TeamGameRow from '@/components/schedule/TeamGameRow';
import ReplayCard from '@/components/home/ReplayCard';
import FormStrip from '@/components/team/FormStrip';
import { countdown, playedWhen, relativeDay } from '@/components/schedule/dates';
import SpoilerToggle from '@/components/ui/SpoilerToggle';
import TeamLogo from '@/components/ui/TeamLogo';
import { IconArrowRight, IconCalendar } from '@/components/ui/Icons';
import { PageData, useDocumentMeta } from '@/components/page/pageData';
import type { TeamPage as TeamData } from '@/components/page/types';

/**
 * Page équipe : bannière aux couleurs du club, bilan et forme, prochain
 * match, calendrier à venir, résultats et replays.
 *
 * Données de `GET /api/pages/equipes/<abbr>`, tirées de la base locale (aucun
 * appel ESPN à l'affichage). Un seul fichier statique sert toutes les
 * équipes : l'abréviation est lue dans l'URL.
 */
export default function TeamPage() {
  const abbr = (usePathname() ?? '').split('/')[2] ?? '';
  return <PageData<TeamData> url={`/api/pages/equipes/${abbr}`}>{(d) => <Team d={d} />}</PageData>;
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

function Team({ d }: { d: TeamData }) {
  useDocumentMeta(d.title);
  const { spoilers, abbr, team: t, today, summary } = d;
  const now = new Date();
  const nextGame = d.next_game;
  const seed = d.seed ?? undefined;
  const pct = d.pct ?? undefined;
  const fmt = (s: TeamRecord) => `${s.wins}–${s.losses}`;

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
              {summary.season !== null ? ` · ${seasonLabel(summary.season)}` : ''}
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
            <FormStrip games={d.form} team={abbr} />
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
                <span className="num text-xl font-bold text-paper">{d.upcoming_count}</span> matchs
              </span>
            </div>
            {d.upcoming_count === 0 ? (
              <p className="px-2 pb-3 text-sm text-paper-mute">Rien de programmé.</p>
            ) : (
              <ol className="space-y-2">
                {d.upcoming_rest.map((g) => (
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
              <span className="num text-xl text-flame-hot">{d.replays_count}</span>
            </h2>
            {d.replays_count === 0 ? (
              <p className="panel-soft px-5 py-6 text-sm text-paper-mute">
                Aucun replay n&apos;a encore été récupéré pour cette équipe. La recherche est automatique et tourne toutes les deux
                heures.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {d.replays.map((g) => (
                  <ReplayCard key={g.id} game={g} when={playedWhen(g.day_paris, g.time_paris, today)} />
                ))}
              </div>
            )}
          </section>

          {/* Résultats */}
          <section aria-labelledby="res-title" className="min-w-0 space-y-4 lg:col-start-1">
            <h2 id="res-title" className="flex items-baseline gap-3">
              <span className="section-title">Résultats récents</span>
              <span className="num text-xl text-paper-mute">{d.finished_count}</span>
            </h2>
            {d.recent.length === 0 ? (
              <p className="text-sm text-paper-mute">Aucun match terminé enregistré.</p>
            ) : (
              <ol className="space-y-2">
                {d.recent.map((g) => (
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
