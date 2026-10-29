/**
 * Logique (pure, testée) des composants qui tiennent la fiche match à jour
 * sans rechargement : `ReplayWatcher` (match terminé sans replay) et
 * `StatusWatcher` (match en direct ou sur le point de commencer).
 */
import { MANUAL_CHECK_COOLDOWN_MS, nextReplaySearchMs } from '@/lib/replayCadence';

const MIN = 60_000;

/** Interrogation légère de GET /api/matches/[id]. */
export const WATCH_POLL_MS = 60_000;
/** Le guet du replay s'arrête au bout de 3 h (onglet oublié). */
export const REPLAY_WATCH_MAX_MS = 3 * 60 * MIN;
/** Un match à venir n'est surveillé qu'à moins de 30 min du coup d'envoi. */
export const STATUS_WATCH_LEAD_MS = 30 * MIN;
/** … et plus du tout 6 h après le coup d'envoi (le match est fini depuis longtemps). */
export const STATUS_WATCH_MAX_AFTER_START_MS = 6 * 60 * MIN;
/** Calendrier et accueil : rafraîchissement automatique. */
export const PAGE_REFRESH_MS = 5 * MIN;

export type WatchStep = 'refresh' | 'poll' | 'idle' | 'stop';

/**
 * Guet du replay, à chaque tick : `refresh` dès que le replay est
 * disponible (la page serveur affichera le lecteur), `stop` après 3 h,
 * sinon `poll`.
 */
export function replayWatchStep(s: { available: boolean; startedAt: number; now: number }): WatchStep {
  if (s.available) return 'refresh';
  if (s.now - s.startedAt >= REPLAY_WATCH_MAX_MS) return 'stop';
  return 'poll';
}

/** Faut-il interroger l'API pour ce statut ? En direct, ou coup d'envoi dans moins de 30 min. */
export function statusWatchActive(status: string, dateUtc: string, now: number): boolean {
  if (status === 'live') return true;
  if (status !== 'scheduled') return false;
  return Date.parse(dateUtc) - now < STATUS_WATCH_LEAD_MS;
}

/**
 * Guet du statut (match en direct ou à venir) : `refresh` quand le statut a
 * changé depuis le rendu serveur (à venir → en direct → terminé), `stop` 6 h
 * après le coup d'envoi, `poll` si le match est surveillé, sinon `idle`
 * (tick sans requête, en attendant d'être à 30 min du coup d'envoi).
 */
export function statusWatchStep(s: { renderedStatus: string; status: string; dateUtc: string; now: number }): WatchStep {
  if (s.status !== s.renderedStatus) return 'refresh';
  if (s.now - Date.parse(s.dateUtc) >= STATUS_WATCH_MAX_AFTER_START_MS) return 'stop';
  return statusWatchActive(s.status, s.dateUtc, s.now) ? 'poll' : 'idle';
}

/** « à l'instant », « il y a 3 min », « il y a 1 h 05 ». */
export function agoLabel(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** « ~1 min », « ~18 min », « ~1 h 40 » (arrondi au-dessus : jamais « ~0 min »). */
export function inLabel(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / MIN));
  if (m < 60) return `~${m} min`;
  return `~${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * Ligne d'état sous « Replay pas encore trouvé » :
 * « Recherche en cours… » ou « Dernière recherche il y a 3 min · prochaine dans ~17 min ».
 * La prochaine recherche est celle, automatique, du serveur (cadence selon
 * l'âge du match) : estimation, le job passe toutes les 20 min.
 */
export function replayStatusLine(s: {
  searching: boolean;
  checkedAt: string | null;
  dateUtc: string;
  kind: string | null;
  now: number;
}): string {
  if (s.searching) return 'Recherche en cours…';
  const checked = s.checkedAt ? Date.parse(s.checkedAt) : NaN;
  const next = nextReplaySearchMs(s.dateUtc, s.checkedAt, s.kind, s.now) - s.now;
  const nextPart = next > 0 ? `prochaine dans ${inLabel(next)}` : 'prochaine imminente';
  if (!Number.isFinite(checked)) return `Pas encore recherché · ${nextPart}`;
  return `Dernière recherche ${agoLabel(s.now - checked)} · ${nextPart}`;
}

/**
 * Millisecondes avant que « Chercher maintenant » soit de nouveau permis
 * (2 min après la dernière recherche, serveur ou demande locale) ; 0 = permis.
 */
export function manualCheckWaitMs(s: { checkedAt: string | null; lastRequestAt: number | null; now: number }): number {
  const checked = s.checkedAt ? Date.parse(s.checkedAt) : NaN;
  const last = Math.max(Number.isFinite(checked) ? checked : 0, s.lastRequestAt ?? 0);
  return Math.max(0, last + MANUAL_CHECK_COOLDOWN_MS - s.now);
}
