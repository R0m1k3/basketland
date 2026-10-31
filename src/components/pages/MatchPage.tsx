'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MatchClient from '@/components/MatchClient';
import StatsPanel from '@/components/StatsPanel';
import MatchHeader from '@/components/match/MatchHeader';
import Countdown from '@/components/match/Countdown';
import ReplayWatcher from '@/components/match/ReplayWatcher';
import StatusWatcher from '@/components/match/StatusWatcher';
import TeamLogo from '@/components/ui/TeamLogo';
import { FICHE_ROOT_ID } from '@/components/match/format';
import { PageData, useDocumentMeta } from '@/components/page/pageData';
import type { MatchPage as MatchData } from '@/components/page/types';
import { teamInfo } from '@/lib/teams';
import { parisDateLabel } from '@/lib/time';

/**
 * Fiche d'un match (`/matchs/<id>`) : données de `GET /api/pages/matchs/<id>`
 * (match, score par quart-temps, actions traduites, réglages et droits ;
 * titre et description de l'ex-`generateMetadata`). Un seul fichier
 * statique sert tous les matchs : l'identifiant est lu dans l'URL.
 */
export default function MatchPage() {
  const id = (usePathname() ?? '').split('/')[2] ?? '';
  return <PageData<MatchData> url={`/api/pages/matchs/${id}`}>{(d) => <Match d={d} />}</PageData>;
}

function Match({ d }: { d: MatchData }) {
  useDocumentMeta(d.title, d.description);
  const { match, linescore, spoilers } = d;
  const isFinal = match.status === 'final';
  const isLive = match.status === 'live';
  const upcoming = !isFinal && !isLive;
  const items = d.plays;
  const hasVideo = d.has_video;
  const away = teamInfo(match.away.abbr);
  const home = teamInfo(match.home.abbr);
  // Traduction automatique et version française (Paramètres), droits : boutons du bandeau de traduction.
  const autoTranslate = d.auto_translate;
  const vf = d.vf_mode;
  const isAdmin = d.is_admin;

  return (
    <div data-spoilers={spoilers}>
      <div id={FICHE_ROOT_ID} data-scope={match.id} className="space-y-6 sm:space-y-8">
        <nav aria-label="Fil d’Ariane" className="flex items-center gap-2 text-sm text-paper-mute">
          <Link
            href="/matchs"
            className="inline-flex items-center gap-1.5 rounded-full py-1 pr-2 transition hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Calendrier
          </Link>
          <span className="text-ink-500">/</span>
          <span className="truncate text-paper-faint">
            {away.nick} – {home.nick}
          </span>
        </nav>

        <MatchHeader match={match} linescore={linescore} spoilers={spoilers} />

        {/* Coup d'envoi puis fin du match : la page passe d'elle-même à l'écran suivant. */}
        {!isFinal && <StatusWatcher matchId={match.id} status={match.status} dateUtc={match.date_utc} />}

        {hasVideo && (
          <MatchClient
            matchId={match.id}
            video={{ kind: match.video.kind, src: match.video.src, duration: match.video.duration }}
            awayAbbr={match.away.abbr}
            homeAbbr={match.home.abbr}
            plays={d.lite}
            positions={d.positions}
            autoTranslate={autoTranslate}
            vfMode={vf}
            isAdmin={isAdmin}
          />
        )}

        {isFinal && !hasVideo && (
          <Notice
            away={match.away.abbr}
            home={match.home.abbr}
            kicker="Replay"
            title="Replay pas encore trouvé"
            text={`Les replays apparaissent en général quelques heures après la fin du match. Cette page se met à jour toute seule dès qu’il est en ligne ; ${
              autoTranslate
                ? `les commentaires sont ensuite ${vf === 'doublage' ? 'traduits et doublés' : 'traduits'} en français automatiquement.`
                : 'la traduction des commentaires se lance ensuite d’un clic.'
            }`}
          >
            <ReplayWatcher matchId={match.id} dateUtc={match.date_utc} checkedAt={match.video.checked_at} />
          </Notice>
        )}

        {isLive && (
          <Notice
            away={match.away.abbr}
            home={match.home.abbr}
            kicker="En direct"
            title="Match en cours"
            text="Le replay et les commentaires traduits en français seront disponibles quelques heures après le coup de sifflet final."
            live
          />
        )}

        {upcoming && (
          <section className="panel relative overflow-hidden px-4 py-8 text-center sm:px-8 sm:py-12" aria-label="Avant-match">
            <div className="upcoming-glow pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="relative">
              <p className="kicker">Coup d’envoi dans</p>
              <div className="mt-4">
                <Countdown dateUtc={match.date_utc} title={`${match.away.name} – ${match.home.name}`} location={match.venue} />
              </div>
              <p className="mx-auto mt-6 max-w-lg text-sm text-paper-mute">
                <span className="first-letter:uppercase">{parisDateLabel(match.date_utc)}</span> à{' '}
                <strong className="font-semibold text-paper">{match.time_paris}</strong> (heure de Paris)
                {match.broadcast ? ` · ${match.broadcast}` : ''}.
                <br />
                Le replay et les commentaires en français seront disponibles après le match.
              </p>
              <ul className="mx-auto mt-8 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
                {[
                  ['Replay intégral', 'Trouvé automatiquement après le match.'],
                  ['Commentaires en VF', 'La voix des commentateurs traduite en français, en sous-titres.'],
                  ['Stats complètes', 'Leaders, duel d’équipes, box score, actions.'],
                ].map(([t, d]) => (
                  <li key={t} className="panel-soft px-4 py-3">
                    <p className="font-display text-sm font-bold uppercase tracking-wider text-paper">{t}</p>
                    <p className="mt-0.5 text-xs text-paper-mute">{d}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {(isFinal || items.length > 0) && (
          <StatsPanel
            matchId={match.id}
            final={isFinal}
            awayAbbr={match.away.abbr}
            homeAbbr={match.home.abbr}
            plays={items}
            hasVideo={hasVideo}
          />
        )}
      </div>
    </div>
  );
}

function Notice({
  away,
  home,
  kicker,
  title,
  text,
  live,
  children,
}: {
  away: string;
  home: string;
  kicker: string;
  title: string;
  text: string;
  live?: boolean;
  /** Contenu vivant sous le texte (ex. statut de la recherche du replay). */
  children?: React.ReactNode;
}) {
  return (
    <section className="panel relative overflow-hidden" aria-label={title}>
      <div className="grid items-center gap-6 p-6 sm:grid-cols-[auto_1fr] sm:p-8">
        <div className="relative mx-auto grid aspect-video w-56 place-items-center overflow-hidden rounded-xl border border-ink-700 bg-ink-950 sm:w-64">
          <div
            className="poster absolute inset-0"
            style={{ '--team-a-deep': teamInfo(away).primary, '--team-b-deep': teamInfo(home).primary } as React.CSSProperties}
          />
          <div className="relative flex items-center gap-3 opacity-80">
            <TeamLogo abbr={away} size={52} />
            <span className="font-display text-sm font-bold uppercase tracking-[0.2em] text-white/40">vs</span>
            <TeamLogo abbr={home} size={52} />
          </div>
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-paper-mute">
            {live ? 'Live' : 'Bientôt'}
          </span>
        </div>
        <div className="text-center sm:text-left">
          <p className={live ? 'chip-live' : 'kicker'}>
            {live && <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" />}
            {kicker}
          </p>
          <h2 className="title-lg mt-2">{title}</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-paper-mute sm:mx-0">{text}</p>
          {children}
        </div>
      </div>
    </section>
  );
}
