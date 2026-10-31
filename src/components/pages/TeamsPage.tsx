'use client';

import { seasonLabel } from '@/lib/time';
import TeamTile from '@/components/team/TeamTile';
import { PageData } from '@/components/page/pageData';
import type { TeamsPage as TeamsData } from '@/components/page/types';

/**
 * Les 30 franchises, par conférence puis par division, aux couleurs de
 * chaque club : bilan de la saison régulière et prochain match. Données de
 * `GET /api/pages/equipes` (équipes déjà triées dans chaque division).
 */
export default function TeamsPage() {
  return <PageData<TeamsData> url="/api/pages/equipes">{(d) => <Teams d={d} />}</PageData>;
}

function Teams({ d }: { d: TeamsData }) {
  const { season, today } = d;

  return (
    <div className="space-y-12">
      <header className="space-y-2">
        <p className="kicker">{season !== null ? `Saison ${seasonLabel(season)} · ` : ''}30 franchises</p>
        <h1 className="title-xl">Équipes</h1>
        <p className="max-w-2xl text-paper-dim">
          Bilan de la saison régulière, prochain match en heure de Paris : choisissez une équipe pour voir son calendrier et
          ses replays.
        </p>
      </header>

      {d.conferences.map(({ conference: conf, divisions }) => (
        <section key={conf} aria-labelledby={`conf-${conf}`} className="space-y-6">
          <div className="flex items-center gap-4">
            <h2 id={`conf-${conf}`} className="section-title shrink-0">
              Conférence {conf}
            </h2>
            <span className="h-px flex-1 bg-gradient-to-r from-ink-600 to-transparent" aria-hidden="true" />
          </div>
          <div className="grid gap-x-5 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
            {divisions.map(({ division: div, teams }) => (
              <div key={div} className="space-y-2.5">
                <h3 className="kicker flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-flame" aria-hidden="true" />
                  Division {div}
                </h3>
                <ul className="space-y-2.5">
                  {teams.map(({ team: t, record, next, seed }) => (
                    <li key={t.abbr}>
                      <TeamTile team={t} record={record ?? undefined} next={next ?? undefined} seed={seed ?? undefined} today={today} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
