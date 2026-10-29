import { notFound } from 'next/navigation';
import Link from 'next/link';
import MatchClient from '@/components/MatchClient';
import StatsPanel from '@/components/StatsPanel';
import { StatusBadge } from '@/components/MatchCard';
import { getMatch, getSyncSettings } from '@/lib/db';
import { toDto } from '@/lib/present';

export const dynamic = 'force-dynamic';

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) notFound();

  const row = getMatch(numericId);
  if (!row) notFound();

  const match = toDto(row);
  const settings = getSyncSettings(numericId);
  const isFinal = match.status === 'final';

  return (
    <div className="space-y-6">
      <nav className="text-sm text-slate-500">
        <Link href="/matchs" className="hover:text-white">
          ← Retour aux matchs
        </Link>
      </nav>

      <header className="rounded-xl border border-slate-800 bg-[#111621] p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <StatusBadge status={match.status} detail={match.status_detail} />
          <span>
            {match.date_paris} à {match.time_paris} <span className="text-slate-600">(Paris)</span>
          </span>
          {match.venue && <span>· {match.venue}</span>}
          {match.broadcast && <span>· {match.broadcast}</span>}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={match.away.logo} alt={match.away.name} width={44} height={44} />
            <div>
              <div className="text-lg font-semibold text-white">{match.away.name}</div>
              <div className="text-2xl font-bold tabular-nums text-slate-300">
                {match.away.score ?? '—'}
              </div>
            </div>
          </div>

          <div className="text-center text-sm text-slate-500">
            {match.status === 'live'
              ? `Q${match.period} · ${match.clock_display}`
              : match.status === 'final'
                ? 'Terminé'
                : 'À venir'}
          </div>

          <div className="flex flex-1 items-center justify-end gap-3 sm:justify-end">
            <div className="text-right">
              <div className="text-lg font-semibold text-white">{match.home.name}</div>
              <div className="text-2xl font-bold tabular-nums text-slate-300">
                {match.home.score ?? '—'}
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={match.home.logo} alt={match.home.name} width={44} height={44} />
          </div>
        </div>
      </header>

      <MatchClient
        matchId={match.id}
        masterUrl={match.video.master}
        initialOffset={settings.global_offset ?? 0}
      />

      <section className="rounded-xl border border-slate-800 bg-[#111621] p-5">
        <h2 className="mb-3 text-lg font-semibold text-white">Statistiques du match</h2>
        {isFinal ? (
          <StatsPanel matchId={match.id} enabled />
        ) : (
          <p className="text-sm text-slate-500">
            Les statistiques détaillées seront disponibles dès la fin du match.
            {match.status === 'live' && ' Le match est en cours.'}
          </p>
        )}
      </section>

      {isFinal && match.video.available && (
        <p className="text-xs text-slate-600">
          Export des sous-titres :{' '}
          <a
            href={`/api/matches/${match.id}/subtitles.vtt`}
            className="text-court-400 underline"
            download
          >
            WebVTT
          </a>
        </p>
      )}
    </div>
  );
}
