import type { Metadata } from 'next';
import { conferenceSeeds, latestSeason, nextGameByTeam, seasonRecords, todayKey } from '@/lib/queries';
import { TEAMS, type TeamInfo } from '@/lib/teams';
import { seasonLabel } from '@/lib/time';
import TeamTile from '@/components/team/TeamTile';

/**
 * Les 30 franchises, par conférence puis par division, aux couleurs de
 * chaque club : bilan de la saison régulière et prochain match.
 */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Équipes' };

const DIVISIONS: Record<TeamInfo['conference'], string[]> = {
  Est: ['Atlantique', 'Centrale', 'Sud-Est'],
  Ouest: ['Nord-Ouest', 'Pacifique', 'Sud-Ouest'],
};

export default function TeamsPage() {
  const records = seasonRecords();
  const next = nextGameByTeam();
  const seeds = conferenceSeeds();
  const season = latestSeason();
  const today = todayKey();

  return (
    <div className="space-y-12">
      <header className="space-y-2">
        <p className="kicker">{season !== undefined ? `Saison ${seasonLabel(season)} · ` : ''}30 franchises</p>
        <h1 className="title-xl">Équipes</h1>
        <p className="max-w-2xl text-paper-dim">
          Bilan de la saison régulière, prochain match en heure de Paris : choisissez une équipe pour voir son calendrier et
          ses replays.
        </p>
      </header>

      {(['Est', 'Ouest'] as const).map((conf) => (
        <section key={conf} aria-labelledby={`conf-${conf}`} className="space-y-6">
          <div className="flex items-center gap-4">
            <h2 id={`conf-${conf}`} className="section-title shrink-0">
              Conférence {conf}
            </h2>
            <span className="h-px flex-1 bg-gradient-to-r from-ink-600 to-transparent" aria-hidden="true" />
          </div>
          <div className="grid gap-x-5 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
            {DIVISIONS[conf].map((div) => {
              const teams = TEAMS.filter((t) => t.conference === conf && t.division === div).sort((a, b) => {
                const ra = records.get(a.abbr);
                const rb = records.get(b.abbr);
                const pa = ra && ra.wins + ra.losses ? ra.wins / (ra.wins + ra.losses) : 0;
                const pb = rb && rb.wins + rb.losses ? rb.wins / (rb.wins + rb.losses) : 0;
                return pb - pa || (rb?.wins ?? 0) - (ra?.wins ?? 0) || a.nick.localeCompare(b.nick);
              });
              return (
                <div key={div} className="space-y-2.5">
                  <h3 className="kicker flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-flame" aria-hidden="true" />
                    Division {div}
                  </h3>
                  <ul className="space-y-2.5">
                    {teams.map((t) => (
                      <li key={t.abbr}>
                        <TeamTile team={t} record={records.get(t.abbr)} next={next.get(t.abbr)} seed={seeds.get(t.abbr)} today={today} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
