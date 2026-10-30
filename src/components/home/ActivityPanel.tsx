'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Activity, ActivityMatch, ActivityTask } from '@/lib/activity';
import { isNbaTeam, teamInfo, teamLogoUrl } from '@/lib/teams';
import TeamLogo from '@/components/ui/TeamLogo';

/** Rafraîchissement du panneau (onglet visible seulement). */
const POLL_MS = 10_000;
/** Matchs en attente affichés avant « et N autres ». */
const MAX_WAITING = 4;

const KIND_LABEL: Record<ActivityTask['kind'], string> = {
  traduction: 'Traduction des commentaires',
  analyse: 'Analyse vidéo',
  doublage: 'Doublage en voix françaises',
};

/** Surnom (« Trail Blazers ») ; nom complet pour une équipe hors NBA (All-Star…). */
const nick = (abbr: string, name: string) => (isNbaTeam(abbr) ? teamInfo(abbr).nick : name);
const matchTitle = (m: ActivityMatch) => `${nick(m.away, m.awayName)} @ ${nick(m.home, m.homeName)}`;

const ANALYSE_PREFIX = 'Analyse vidéo · ';

/**
 * Étape en clair, sans répéter le type de tâche : « Analyse vidéo ·
 * balayage » → « Balayage » ; « Analyse vidéo en pause » → rien (la mention
 * « en pause pendant la lecture » le dit déjà).
 */
function stepOf(t: ActivityTask): string | null {
  if (t.kind === 'traduction') return t.label;
  if (t.kind === 'doublage') return null; // le type de tâche suffit
  if (!t.label.startsWith(ANALYSE_PREFIX)) return null;
  const step = t.label.slice(ANALYSE_PREFIX.length);
  return step.charAt(0).toUpperCase() + step.slice(1);
}

/** File d'attente par match (un match peut attendre sa traduction ET son analyse). */
function waitingList(queued: Activity['queued']): { match: ActivityMatch; kinds: ActivityTask['kind'][] }[] {
  const byId = new Map<number, { match: ActivityMatch; kinds: ActivityTask['kind'][] }>();
  for (const q of queued) {
    const e = byId.get(q.match.id);
    if (!e) byId.set(q.match.id, { match: q.match, kinds: [q.kind] });
    else if (!e.kinds.includes(q.kind)) e.kinds.push(q.kind);
  }
  return [...byId.values()];
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function TaskRow({ task, watching }: { task: ActivityTask; watching: boolean }) {
  // Tâche de fond (personne ne regarde CE match) pendant qu'une vidéo est regardée : elle attend.
  const paused = task.paused || (watching && !task.watched);
  const step = stepOf(task);
  const pct = task.pct === null ? null : Math.max(0, Math.min(100, task.pct));
  return (
    <Link
      href={`/matchs/${task.match.id}`}
      className="group grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 transition hover:bg-ink-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flame"
    >
      <span className="flex items-center" aria-hidden="true">
        <TeamLogo abbr={task.match.away} size={30} />
        <TeamLogo abbr={task.match.home} size={30} className="-ml-2.5" />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-display text-[15px] font-bold uppercase tracking-wide text-paper group-hover:text-flame-hot sm:text-base">
            {nick(task.match.away, task.match.awayName)} <span className="text-paper-faint">@</span> {nick(task.match.home, task.match.homeName)}
          </span>
          {pct !== null && <span className={`num shrink-0 text-sm font-bold ${paused ? 'text-paper-mute' : 'text-flame-hot'}`}>{pct} %</span>}
        </span>
        <span className="block text-xs text-paper-mute">
          <span className="text-paper-dim">{KIND_LABEL[task.kind]}</span>
          {step && <> · {step}</>}
        </span>
        {pct !== null && (
          <span
            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-ink-700"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${KIND_LABEL[task.kind]} : ${pct} %`}
          >
            <span className={`block h-full rounded-full transition-[width] duration-700 ${paused ? 'bg-paper-faint' : 'bg-flame'}`} style={{ width: `${pct}%` }} />
          </span>
        )}
        {(task.watched || paused) && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {task.watched && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-live">
                <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" aria-hidden="true" />
                en direct pour un spectateur
              </span>
            )}
            {paused && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-warn">
                <PauseIcon />
                en pause pendant la lecture
              </span>
            )}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * « En cours de traitement » (accueil) : traduction des commentaires et
 * analyse vidéo en cours, puis la file d'attente. Données initiales rendues
 * par le serveur, puis GET /api/activity toutes les 10 s tant que l'onglet
 * est visible.
 */
export default function ActivityPanel({ initial, idleText }: { initial: Activity; idleText: string }) {
  const [data, setData] = useState(initial);
  // Rafraîchissement de la page (AutoRefresh) : nouvelles données du serveur.
  useEffect(() => setData(initial), [initial]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let ctrl: AbortController | undefined;
    const load = () => {
      ctrl?.abort();
      const c = (ctrl = new AbortController());
      fetch('/api/activity', { cache: 'no-store', signal: c.signal })
        .then((r) => (r.ok ? (r.json() as Promise<Activity>) : null))
        .then((d) => {
          if (d && !c.signal.aborted && Array.isArray(d.tasks) && Array.isArray(d.queued)) setData(d);
        })
        .catch(() => undefined);
    };
    const startPolling = () => {
      clearInterval(timer);
      timer = setInterval(load, POLL_MS);
    };
    // Onglet caché : plus d'interrogation ; au retour, mise à jour immédiate.
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(timer);
        ctrl?.abort();
      } else {
        load();
        startPolling();
      }
    };
    if (!document.hidden) startPolling();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const { tasks, queued, watching } = data;
  const waiting = waitingList(queued);

  if (!tasks.length && !waiting.length) {
    return (
      <p className="flex items-center gap-2 text-xs text-paper-mute">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-win" aria-hidden="true" />
        {idleText}
      </p>
    );
  }

  const shown = waiting.slice(0, MAX_WAITING);
  const more = waiting.length - shown.length;
  const running = tasks.some((t) => !(t.paused || (watching && !t.watched)));

  return (
    <section aria-labelledby="activity-title" className="panel-soft overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-ink-700/60 px-4 py-2.5">
        <h2 id="activity-title" className="kicker flex items-center gap-2 !text-[12px]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${running ? 'animate-pulse bg-flame' : 'bg-ink-500'}`} aria-hidden="true" />
          En cours de traitement
        </h2>
        {waiting.length > 0 && (
          <span className="text-xs text-paper-faint">
            <span className="num font-semibold text-paper-dim">{waiting.length}</span> en attente
          </span>
        )}
      </div>

      {tasks.length > 0 ? (
        <ul className={`divide-y divide-ink-700/50 ${tasks.length > 1 ? 'lg:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0' : ''}`}>
          {tasks.map((t) => (
            <li key={`${t.kind}-${t.match.id}`}>
              <TaskRow task={t} watching={watching} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-xs text-paper-mute">
          {watching
            ? 'En pause pendant la lecture : le traitement reprend quand la vidéo s’arrête.'
            : 'Le prochain traitement démarre dans un instant.'}
        </p>
      )}

      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-ink-700/60 px-4 py-2.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-faint">En attente</span>
          {shown.map(({ match, kinds }) => (
            <Link
              key={match.id}
              href={`/matchs/${match.id}`}
              title={`${matchTitle(match)} : ${kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' puis ')}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink-600 bg-ink-900/60 py-0.5 pl-1 pr-2.5 text-xs text-paper-dim transition hover:border-ink-500 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60"
            >
              <span className="flex shrink-0 items-center" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={teamLogoUrl(match.away)} alt="" width={16} height={16} loading="lazy" className="h-4 w-4 object-contain" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={teamLogoUrl(match.home)} alt="" width={16} height={16} loading="lazy" className="-ml-1 h-4 w-4 object-contain" />
              </span>
              <span className="truncate">{matchTitle(match)}</span>
            </Link>
          ))}
          {more > 0 && (
            <span className="text-xs text-paper-faint">
              et {more} autre{more > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
