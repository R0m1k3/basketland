import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchScoreboardRange } from '../src/lib/espn';
import * as http from '../src/lib/http';

/**
 * Non-régression : ESPN refuse les plages de dates.
 *
 * Symptôme observé dans les logs du conteneur :
 *   [ingest] sync-schedule échoué : HTTP 400 pour
 *   https://site.api.espn.com/.../scoreboard?dates=20261022-20261105&limit=1000
 *
 * Les seuls formats acceptés par l'API sont `YYYYMMDD` (un jour), `YYYYMM`
 * (un mois) et `YYYY` (une année). Toute la planification du calendrier
 * reposait sur un format refusé : le calendrier n'était jamais synchronisé
 * (et l'échec répétait toutes les 15 min dans les logs).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchScoreboardRange', () => {
  it('découpe une période courte en requêtes journalières', async () => {
    const seen: string[] = [];
    vi.spyOn(http, 'fetchJson').mockImplementation(async (url: string) => {
      seen.push(String(url));
      return { events: [] };
    });

    const from = new Date(Date.UTC(2026, 9, 22));
    const to = new Date(Date.UTC(2026, 9, 28));
    await fetchScoreboardRange(from, to, 'nba', 1000);

    expect(seen).toHaveLength(7); // 22 → 28 inclus
    for (const url of seen) {
      expect(url).toMatch(/dates=\d{8}&/); // un seul jour, jamais une plage
      expect(url).not.toContain('-');
    }
    expect(seen[0]).toContain('20261022');
    expect(seen[6]).toContain('20261028');
  });

  it('découpe une période longue en requêtes mensuelles', async () => {
    const seen: string[] = [];
    vi.spyOn(http, 'fetchJson').mockImplementation(async (url: string) => {
      seen.push(String(url));
      return { events: [] };
    });

    // 4 mois : au-delà de 40 jours, on passe par mois (plafond de 1 000).
    const from = new Date(Date.UTC(2026, 8, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    await fetchScoreboardRange(from, to, 'nba', 1000);

    expect(seen).toHaveLength(4);
    for (const url of seen) expect(url).toMatch(/dates=\d{6}&/); // YYYYMM
    expect(seen[0]).toContain('202609');
    expect(seen[3]).toContain('202612');
  });

  it('renvoie un tableau vide si la période est inversée', async () => {
    const spy = vi.spyOn(http, 'fetchJson');
    const from = new Date(Date.UTC(2026, 9, 28));
    const to = new Date(Date.UTC(2026, 9, 22));
    expect(await fetchScoreboardRange(from, to)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ne jette pas tout le résultat si un jour échoue', async () => {
    // Un jour en erreur, les autres répondent : le résultat est conservé.
    let call = 0;
    vi.spyOn(http, 'fetchJson').mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('HTTP 500');
      return { events: [] };
    });

    const from = new Date(Date.UTC(2026, 9, 22));
    const to = new Date(Date.UTC(2026, 9, 24));
    // Un jour a échoué, les deux autres ont été tentés : la fonction
    // NE REJETTE PAS (un incident transitoire ne doit pas vider le
    // calendrier). Elle ne renvoie simplement aucun match, les jours
    // réussis n'en contenant aucun.
    await expect(fetchScoreboardRange(from, to)).resolves.toEqual([]);
    expect(call).toBe(3); // les 3 jours ont été tentés
  });

  it('échoue si TOUS les appels échouent', async () => {
    vi.spyOn(http, 'fetchJson').mockImplementation(async () => {
      throw new Error('HTTP 500');
    });
    const from = new Date(Date.UTC(2026, 9, 22));
    const to = new Date(Date.UTC(2026, 9, 24));
    await expect(fetchScoreboardRange(from, to)).rejects.toThrow(/HTTP 500/);
  });
});
