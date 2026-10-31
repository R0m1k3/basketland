'use client';

import Link from 'next/link';
import { Fragment, type CSSProperties } from 'react';
import type { StandingRow } from '@/lib/espn';
import { teamInfo } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';
import { PageData } from '@/components/page/pageData';
import type { StandingsPage as StandingsData } from '@/components/page/types';

/** 'W3' → { label: 'V3', win: true } ; 'L2' → 'D2'. */
function streak(s: string): { label: string; win?: boolean } {
  const m = s.match(/^([WL])(\d+)$/i);
  if (!m) return { label: s || '—' };
  const win = m[1].toUpperCase() === 'W';
  return { label: `${win ? 'V' : 'D'}${m[2]}`, win };
}

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

function ConferenceTable({ name, rows }: { name: string; rows: StandingRow[] }) {
  const leader = rows[0] ? teamInfo(rows[0].abbr) : undefined;
  const short = name.replace('Conférence ', '');
  const cols = 11;
  return (
    <section
      aria-labelledby={`conf-${short}`}
      className="panel overflow-hidden"
      style={leader ? ({ '--team-a': leader.accent, '--team-b': leader.primary } as CSSProperties) : undefined}
    >
      <div
        className="relative flex items-end justify-between gap-4 border-b border-ink-700/70 px-4 pb-4 pt-5 sm:px-5"
        style={leader ? { backgroundImage: `linear-gradient(110deg, ${leader.primary}40, transparent 60%)` } : undefined}
      >
        <div className="team-stripe absolute inset-x-0 top-0 h-[3px]" />
        <div>
          <p className="kicker">Conférence</p>
          <h2 id={`conf-${short}`} className="section-title mt-1">
            {short}
          </h2>
        </div>
        {leader && (
          <p className="text-right text-xs text-paper-mute">
            En tête
            <span className="mt-0.5 block font-display text-lg font-bold uppercase tracking-wide text-paper">{leader.nick}</span>
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Classement de la conférence {short}</caption>
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-wider text-paper-faint">
              <th scope="col" className="w-10 py-2.5 pl-3 text-left sm:pl-4">
                <abbr title="Rang" className="no-underline">#</abbr>
              </th>
              <th scope="col" className="py-2.5 text-left">Équipe</th>
              <th scope="col" className="px-1.5 py-2.5 text-right">
                <abbr title="Victoires" className="no-underline">V</abbr>
              </th>
              <th scope="col" className="px-1.5 py-2.5 text-right">
                <abbr title="Défaites" className="no-underline">D</abbr>
              </th>
              <th scope="col" className="px-1.5 py-2.5 text-right">
                <abbr title="Pourcentage de victoires" className="no-underline">%</abbr>
              </th>
              <th scope="col" className="px-1.5 py-2.5 text-right">
                <abbr title="Écart avec le premier (en matchs)" className="no-underline">Éc.</abbr>
              </th>
              <th scope="col" className="px-1.5 py-2.5 text-right">Série</th>
              <th scope="col" className="hidden px-1.5 py-2.5 text-right sm:table-cell">
                <abbr title="10 derniers matchs" className="no-underline">10 der.</abbr>
              </th>
              <th scope="col" className="hidden px-1.5 py-2.5 text-right md:table-cell xl:hidden 2xl:table-cell">
                Dom.
              </th>
              <th scope="col" className="hidden px-1.5 py-2.5 text-right md:table-cell xl:hidden 2xl:table-cell">
                Ext.
              </th>
              <th scope="col" className="hidden py-2.5 pl-1.5 pr-4 text-right sm:table-cell">
                <abbr title="Écart moyen de points par match" className="no-underline">+/-</abbr>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const seed = r.seed || i + 1;
              const t = teamInfo(r.abbr);
              const st = streak(r.streak);
              const diff = Number.parseFloat(r.diff);
              const zone = seed <= 6 ? 'bg-flame' : seed <= 10 ? 'bg-warn' : 'bg-ink-600';
              return (
                <Fragment key={r.abbr || i}>
                  {seed === 7 && <Divider label="Play-in" tone="bg-warn/40" cols={cols} />}
                  {seed === 11 && <Divider label="Hors course" tone="bg-ink-600" cols={cols} />}
                  <tr className="group border-t border-ink-700/50 transition-colors first:border-t-0 hover:bg-ink-800/60">
                    <td className="relative py-2.5 pl-3 sm:pl-4">
                      <span className={`absolute inset-y-1.5 left-0 w-[3px] rounded-r ${zone}`} aria-hidden="true" />
                      <span className="num text-lg font-bold text-paper-dim">{seed}</span>
                    </td>
                    <td className="py-2 pr-2">
                      <Link
                        href={`/equipes/${r.abbr}`}
                        className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
                      >
                        <TeamLogo abbr={r.abbr} size={30} />
                        <span className="min-w-0">
                          <span className="block truncate font-display text-base font-bold uppercase leading-tight tracking-wide group-hover:text-flame-hot">
                            {t.nick || r.name}
                          </span>
                          <span className="hidden truncate text-[11px] text-paper-faint sm:block">{t.city}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num px-1.5 py-2 text-right text-base font-bold text-paper">{r.wins}</td>
                    <td className="num px-1.5 py-2 text-right text-base font-bold text-paper-dim">{r.losses}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-paper-dim">{r.pct}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-paper-mute">{r.gb === '-' || !r.gb ? '—' : r.gb}</td>
                    <td className="px-1.5 py-2 text-right">
                      <span
                        className={`inline-block min-w-[2.25rem] rounded-md px-1.5 py-0.5 text-center font-display text-sm font-bold ${
                          st.win === undefined ? 'text-paper-faint' : st.win ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'
                        }`}
                      >
                        {st.label}
                      </span>
                    </td>
                    <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-mute sm:table-cell">{r.last10 || '—'}</td>
                    <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-mute md:table-cell xl:hidden 2xl:table-cell">
                      {r.home || '—'}
                    </td>
                    <td className="hidden px-1.5 py-2 text-right tabular-nums text-paper-mute md:table-cell xl:hidden 2xl:table-cell">
                      {r.road || '—'}
                    </td>
                    <td
                      className={`hidden py-2 pl-1.5 pr-4 text-right tabular-nums sm:table-cell ${
                        Number.isNaN(diff) ? 'text-paper-faint' : diff > 0 ? 'text-win' : diff < 0 ? 'text-loss' : 'text-paper-mute'
                      }`}
                    >
                      {r.diff || '—'}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Classement par conférence : `GET /api/pages/classement` (cache de 30 min,
 * sinon ESPN, cache périmé si ESPN échoue, liste vide faute de mieux).
 */
export default function StandingsPage() {
  return <PageData<StandingsData> url="/api/pages/classement">{(d) => <Standings conferences={d.conferences} />}</PageData>;
}

function Standings({ conferences }: StandingsData) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-2">
          <p className="kicker">Saison régulière · source ESPN</p>
          <h1 className="title-xl">Classement</h1>
        </div>
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-paper-mute" aria-label="Légende">
          <li className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded bg-flame" aria-hidden="true" />
            1 à 6 : qualifiés pour les playoffs
          </li>
          <li className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded bg-warn" aria-hidden="true" />7 à 10 : play-in
          </li>
          <li className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded bg-ink-600" aria-hidden="true" />
            11 à 15 : hors course
          </li>
        </ul>
      </header>

      {conferences.length === 0 ? (
        <p className="panel-soft px-6 py-10 text-center text-paper-mute">
          Le classement n&apos;est pas encore récupéré. Une synchronisation le remplira.
        </p>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {conferences.map((conf) => (
            <ConferenceTable key={conf.conference} name={conf.conference} rows={conf.rows} />
          ))}
        </div>
      )}
    </div>
  );
}
