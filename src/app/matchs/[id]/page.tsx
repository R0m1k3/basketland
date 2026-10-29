import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import MatchClient, { type PlayLite, type PlayPosition } from '@/components/MatchClient';
import StatsPanel from '@/components/StatsPanel';
import MatchHeader from '@/components/match/MatchHeader';
import Countdown from '@/components/match/Countdown';
import ReplayWatcher from '@/components/match/ReplayWatcher';
import StatusWatcher from '@/components/match/StatusWatcher';
import TeamLogo from '@/components/ui/TeamLogo';
import type { PlayItem } from '@/components/match/PlayByPlay';
import { FICHE_ROOT_ID } from '@/components/match/format';
import { spoilerMode } from '@/components/ui/spoilers';
import { getMatch, getPlays, getSubtitles } from '@/lib/db';
import { computeLinescore } from '@/lib/linescore';
import { toDto } from '@/lib/present';
import { teamInfo } from '@/lib/teams';
import { parisDateLabel } from '@/lib/time';
import { classifyPlay, translatePlay } from '@/lib/vf';
import type { PlayRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

function loadMatch(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = getMatch(id);
  return row ? toDto(row) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const match = loadMatch((await params).id);
  if (!match) return { title: 'Match introuvable' };
  const a = teamInfo(match.away.abbr).nick;
  const h = teamInfo(match.home.abbr).nick;
  const what = match.status === 'final' ? (match.video.available ? 'replay en VF' : 'statistiques') : 'avant-match';
  return {
    title: `${a} – ${h} · ${what}`,
    description: `${match.away.name} contre ${match.home.name}, ${parisDateLabel(match.date_utc)} à ${match.time_paris} (heure de Paris).`,
  };
}

const PERIOD_CATS = new Set(['period_start', 'period_end', 'game_end']);
const EXTRA_KEY_CATS = new Set(['blocked_fg', 'foul_flagrant', 'foul_technical', 'ejection', 'review', 'challenge']);

/** Prépare le play-by-play pour l'onglet « Actions » : texte traduit, points marqués. */
function toPlayItems(plays: PlayRow[]): PlayItem[] {
  let prevTotal = 0;
  return plays.map((p) => {
    const total = p.home_score !== null && p.away_score !== null ? p.home_score + p.away_score : null;
    const pts = p.scoring && total !== null ? Math.max(0, Math.min(4, total - prevTotal)) : 0;
    if (total !== null) prevTotal = total;
    const cat = classifyPlay(p.event_type, p.text_en, !!p.scoring);
    let text: string;
    try {
      text = translatePlay({ ...p, score_value: pts });
    } catch {
      text = p.text_en;
    }
    return {
      seq: p.seq,
      period: p.period,
      clock: p.clock_display,
      text,
      team: p.team_abbr ?? '',
      away: p.away_score,
      home: p.home_score,
      pts,
      key: !!p.is_key || pts > 0 || EXTRA_KEY_CATS.has(cat),
      type: PERIOD_CATS.has(cat) ? 'period' : 'play',
    };
  });
}

export default async function MatchPage({ params }: Params) {
  const match = loadMatch((await params).id);
  if (!match) notFound();

  const isFinal = match.status === 'final';
  const isLive = match.status === 'live';
  const upcoming = !isFinal && !isLive;
  const plays = upcoming ? [] : getPlays(match.id);
  const linescore = computeLinescore(plays);
  const items = toPlayItems(plays);
  const lite: PlayLite[] = plays.map((p) => [p.seq, p.period, p.clock_sec, p.clock_display]);
  const hasVideo = isFinal && match.video.available && !!match.video.src;
  // Position vidéo estimée de chaque action (play-by-play calé par l'analyse
  // du bandeau) : sert à « Revoir l'action » et aux repères de quart. Ce ne
  // sont PAS les sous-titres affichés (traduction des commentateurs).
  const positions: PlayPosition[] = hasVideo ? getSubtitles(match.id).map((s) => [s.seq, s.video_ts]) : [];
  const away = teamInfo(match.away.abbr);
  const home = teamInfo(match.home.abbr);
  // Mode « scores masqués » commun au site (cookie lu côté serveur : pas de clignotement).
  const spoilers = await spoilerMode();

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
            plays={lite}
            positions={positions}
          />
        )}

        {isFinal && !hasVideo && (
          <Notice
            away={match.away.abbr}
            home={match.home.abbr}
            kicker="Replay"
            title="Replay pas encore trouvé"
            text="Les replays apparaissent en général quelques heures après la fin du match. Cette page se met à jour toute seule dès qu’il est en ligne ; les commentaires sont ensuite traduits en français automatiquement."
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
