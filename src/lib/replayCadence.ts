/**
 * Cadence de recherche des replays (sans dépendance serveur : importé aussi
 * par les composants client de la fiche match pour annoncer la prochaine
 * recherche automatique).
 *
 * - Job `sync-videos` toutes les 20 min.
 * - Match terminé depuis moins de 12 h : revérifié à chaque passage (20 min).
 * - Plus ancien (jusqu'à 21 jours), ou replay trouvé en MP4 seul en attente
 *   du HLS : revérifié toutes les 2 h.
 *
 * La base ne connaît pas l'heure de fin d'un match : on l'estime à
 * coup d'envoi + 2 h 30 (durée habituelle d'un match NBA diffusé).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Période du job `sync-videos` (scheduler). */
export const VIDEO_JOB_INTERVAL_MS = 20 * MIN;
/** Fenêtre de recherche : matchs terminés depuis au plus 21 jours. */
export const REPLAY_SEARCH_DAYS = 21;
/** Durée estimée d'un match (coup d'envoi → fin), faute d'heure de fin en base. */
export const GAME_LENGTH_EST_MS = 2.5 * HOUR;
/** Un match est « récent » s'il s'est terminé il y a moins de 12 h. */
export const RECENT_FINAL_MS = 12 * HOUR;
/** Revérification d'un match récent sans replay. */
export const RECENT_RECHECK_MS = 20 * MIN;
/** Revérification des autres (plus vieux, ou MP4 en attente du HLS). */
export const RECHECK_MS = 2 * HOUR;
/**
 * Tolérance : le job met du temps à parcourir sa liste (1 requête / 2 s),
 * donc `video_checked_at` est posé APRÈS le début du passage. Sans marge,
 * un match vérifié au passage N aurait « 19 min » au passage N+1 et serait
 * sauté, doublant la cadence réelle.
 */
export const JOB_SLACK_MS = 5 * MIN;
/** Délai minimal entre deux recherches à la demande d'un même match. */
export const MANUAL_CHECK_COOLDOWN_MS = 2 * MIN;

/** Fin estimée d'un match (ms epoch). */
export function estimatedEndMs(dateUtc: string): number {
  return Date.parse(dateUtc) + GAME_LENGTH_EST_MS;
}

/** Match terminé depuis moins de 12 h (fin estimée) ? */
export function isRecentFinal(dateUtc: string, now = Date.now()): boolean {
  return now - estimatedEndMs(dateUtc) < RECENT_FINAL_MS;
}

/** Intervalle de revérification d'un match terminé, selon son âge et son replay. */
export function replayRecheckMs(dateUtc: string, videoKind: string | null | undefined, now = Date.now()): number {
  if (videoKind === 'mp4') return RECHECK_MS;
  return isRecentFinal(dateUtc, now) ? RECENT_RECHECK_MS : RECHECK_MS;
}

/** Bornes (ISO) données à `finalMatchesNeedingVideo`. */
export interface ReplayRecheckWindow {
  /** Coup d'envoi au plus tôt (21 jours). */
  since: string;
  /** Coup d'envoi au plus tôt pour être « récent » (fin estimée < 12 h). */
  recentSince: string;
  /** Match récent sans replay : vérifié avant cette date → à revérifier. */
  recentRecheckBefore: string;
  /** Autres : vérifié avant cette date → à revérifier. */
  recheckBefore: string;
}

export function replayRecheckWindow(now = Date.now()): ReplayRecheckWindow {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    since: iso(now - REPLAY_SEARCH_DAYS * 24 * HOUR),
    recentSince: iso(now - RECENT_FINAL_MS - GAME_LENGTH_EST_MS),
    recentRecheckBefore: iso(now - (RECENT_RECHECK_MS - JOB_SLACK_MS)),
    recheckBefore: iso(now - (RECHECK_MS - JOB_SLACK_MS)),
  };
}

/**
 * Prochaine recherche automatique estimée (ms epoch) : dernière vérification
 * + cadence. Approximative (le job tourne toutes les 20 min, pas à la
 * minute près) ; `now` si le match n'a jamais été vérifié ou est en retard.
 */
export function nextReplaySearchMs(
  dateUtc: string,
  checkedAt: string | null | undefined,
  videoKind: string | null | undefined,
  now = Date.now(),
): number {
  const checked = checkedAt ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(checked)) return now;
  return Math.max(now, checked + replayRecheckMs(dateUtc, videoKind, now));
}
