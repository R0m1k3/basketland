import Link from 'next/link';
import { MatchCard } from '@/components/MatchCard';
import { listMatches } from '@/lib/db';
import { toDto } from '@/lib/present';
import { addDays, parisDateKey, parisDayStartUtc } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const today = parisDateKey(new Date());
  const from = parisDayStartUtc(today);
  const to = parisDayStartUtc(parisDateKey(addDays(new Date(`${today}T12:00:00Z`), 3)));

  const upcoming = listMatches({ from, to, limit: 12 }).map(toDto);
  const recent = listMatches({ status: 'final', order: 'desc', limit: 6 }).map(toDto);
  const live = listMatches({ status: 'live', limit: 6 }).map(toDto);

  const replayable = recent.filter((m) => m.video.available);

  return (
    <div className="space-y-10">
      <section className="rounded-2xl border border-slate-800 bg-gradient-to-br from-[#141a26] to-[#0d1119] p-8">
        <h1 className="text-3xl font-bold text-white sm:text-4xl">Tous les matchs NBA. Tous les replays.</h1>
        <p className="mt-3 max-w-2xl text-slate-300">
          Calendrier complet en heure de Paris, replays en streaming, statistiques détaillées et
          <strong className="text-white"> sous-titres français synchronisés</strong> sur le
          commentaire original de la diffusion.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/matchs"
            className="rounded-lg bg-court-500 px-4 py-2 font-medium text-white hover:bg-court-600"
          >
            Voir tous les matchs
          </Link>
          <Link
            href="/classement"
            className="rounded-lg border border-slate-700 px-4 py-2 font-medium text-slate-200 hover:border-slate-500"
          >
            Classement NBA
          </Link>
        </div>
      </section>

      {live.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-semibold text-white">En direct</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        </section>
      )}

      {replayable.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-semibold text-white">Derniers replays</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {replayable.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold text-white">Prochains matchs</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-slate-500">
            Aucun match à venir en base. Lancez une synchronisation pour remplir le calendrier.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
