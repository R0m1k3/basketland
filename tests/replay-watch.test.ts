import { describe, it, expect } from 'vitest';
import {
  RECENT_RECHECK_MS,
  RECHECK_MS,
  isRecentFinal,
  nextReplaySearchMs,
  replayRecheckMs,
} from '../src/lib/replayCadence';
import {
  REPLAY_WATCH_MAX_MS,
  agoLabel,
  inLabel,
  manualCheckWaitMs,
  replayStatusLine,
  replayWatchStep,
  statusWatchActive,
  statusWatchStep,
} from '../src/components/match/watch';

/**
 * Cadence de recherche des replays et logique de décision des composants
 * qui tiennent la fiche match à jour (quand rafraîchir, interroger, s'arrêter).
 */

const H = 3600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('cadence de revérification', () => {
  it('récent = fin estimée (coup d’envoi + 2 h 30) il y a moins de 12 h', () => {
    expect(isRecentFinal(iso(NOW - 14 * H), NOW)).toBe(true); // fini il y a 11 h 30
    expect(isRecentFinal(iso(NOW - 15 * H), NOW)).toBe(false); // fini il y a 12 h 30
  });

  it('20 min pour un match récent, 2 h sinon, 2 h pour un MP4 même récent', () => {
    expect(replayRecheckMs(iso(NOW - 3 * H), null, NOW)).toBe(RECENT_RECHECK_MS);
    expect(replayRecheckMs(iso(NOW - 48 * H), null, NOW)).toBe(RECHECK_MS);
    expect(replayRecheckMs(iso(NOW - 3 * H), 'mp4', NOW)).toBe(RECHECK_MS);
    expect(RECENT_RECHECK_MS).toBe(20 * MIN);
    expect(RECHECK_MS).toBe(2 * H);
  });

  it('prochaine recherche : dernière vérification + cadence, jamais dans le passé', () => {
    const d = iso(NOW - 3 * H);
    expect(nextReplaySearchMs(d, iso(NOW - 5 * MIN), null, NOW)).toBe(NOW + 15 * MIN);
    expect(nextReplaySearchMs(d, iso(NOW - 30 * MIN), null, NOW)).toBe(NOW);
    expect(nextReplaySearchMs(d, null, null, NOW)).toBe(NOW);
  });
});

describe('ReplayWatcher : quand rafraîchir, quand s’arrêter', () => {
  it('refresh dès que le replay est disponible', () => {
    expect(replayWatchStep({ available: true, startedAt: NOW, now: NOW + MIN })).toBe('refresh');
  });

  it('poll pendant 3 h, puis stop', () => {
    expect(replayWatchStep({ available: false, startedAt: NOW, now: NOW + 2 * H })).toBe('poll');
    expect(replayWatchStep({ available: false, startedAt: NOW, now: NOW + REPLAY_WATCH_MAX_MS })).toBe('stop');
    // Le replay arrivé pile à la fin l'emporte sur l'arrêt.
    expect(replayWatchStep({ available: true, startedAt: NOW, now: NOW + REPLAY_WATCH_MAX_MS })).toBe('refresh');
  });

  it('bouton « Chercher maintenant » : 2 min après la dernière recherche (serveur ou locale)', () => {
    expect(manualCheckWaitMs({ checkedAt: null, lastRequestAt: null, now: NOW })).toBe(0);
    expect(manualCheckWaitMs({ checkedAt: iso(NOW - 30_000), lastRequestAt: null, now: NOW })).toBe(90_000);
    expect(manualCheckWaitMs({ checkedAt: iso(NOW - 5 * MIN), lastRequestAt: NOW - 60_000, now: NOW })).toBe(60_000);
    expect(manualCheckWaitMs({ checkedAt: iso(NOW - 5 * MIN), lastRequestAt: null, now: NOW })).toBe(0);
  });

  it('ligne d’état', () => {
    const d = iso(NOW - 3 * H);
    expect(replayStatusLine({ searching: true, checkedAt: null, dateUtc: d, kind: null, now: NOW })).toBe('Recherche en cours…');
    expect(replayStatusLine({ searching: false, checkedAt: iso(NOW - 3 * MIN), dateUtc: d, kind: null, now: NOW })).toBe(
      'Dernière recherche il y a 3 min · prochaine dans ~17 min',
    );
    expect(replayStatusLine({ searching: false, checkedAt: iso(NOW - 25 * MIN), dateUtc: d, kind: null, now: NOW })).toBe(
      'Dernière recherche il y a 25 min · prochaine imminente',
    );
    expect(replayStatusLine({ searching: false, checkedAt: null, dateUtc: d, kind: null, now: NOW })).toBe(
      'Pas encore recherché · prochaine imminente',
    );
    // Vieux match : cadence de 2 h.
    expect(replayStatusLine({ searching: false, checkedAt: iso(NOW - 20 * MIN), dateUtc: iso(NOW - 48 * H), kind: null, now: NOW })).toBe(
      'Dernière recherche il y a 20 min · prochaine dans ~1 h 40',
    );
  });

  it('libellés relatifs', () => {
    expect(agoLabel(20_000)).toBe('à l’instant');
    expect(agoLabel(65 * MIN)).toBe('il y a 1 h 05');
    expect(inLabel(10_000)).toBe('~1 min');
    expect(inLabel(59 * MIN)).toBe('~59 min');
  });
});

describe('StatusWatcher : match en direct ou à venir', () => {
  const start = iso(NOW + 20 * MIN);

  it('interroge seulement en direct ou à moins de 30 min du coup d’envoi', () => {
    expect(statusWatchActive('live', iso(NOW - H), NOW)).toBe(true);
    expect(statusWatchActive('scheduled', start, NOW)).toBe(true);
    expect(statusWatchActive('scheduled', iso(NOW + 2 * H), NOW)).toBe(false);
    expect(statusWatchActive('scheduled', iso(NOW - 10 * MIN), NOW)).toBe(true); // coup d'envoi retardé
    expect(statusWatchActive('final', iso(NOW - H), NOW)).toBe(false);
  });

  it('refresh quand le statut change (à venir → en direct → terminé)', () => {
    expect(statusWatchStep({ renderedStatus: 'live', status: 'final', dateUtc: iso(NOW - 2 * H), now: NOW })).toBe('refresh');
    expect(statusWatchStep({ renderedStatus: 'scheduled', status: 'live', dateUtc: start, now: NOW })).toBe('refresh');
  });

  it('poll, idle (match lointain, pas de requête) ou stop (6 h après le coup d’envoi)', () => {
    expect(statusWatchStep({ renderedStatus: 'live', status: 'live', dateUtc: iso(NOW - H), now: NOW })).toBe('poll');
    expect(statusWatchStep({ renderedStatus: 'scheduled', status: 'scheduled', dateUtc: iso(NOW + 3 * H), now: NOW })).toBe('idle');
    expect(statusWatchStep({ renderedStatus: 'live', status: 'live', dateUtc: iso(NOW - 6 * H), now: NOW })).toBe('stop');
  });
});
