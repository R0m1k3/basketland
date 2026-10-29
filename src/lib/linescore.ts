/**
 * Tableau des scores par période (« linescore »), calculé depuis le
 * play-by-play : le score cumulé à la dernière action de chaque période,
 * puis la différence avec la période précédente.
 *
 * Module pur (aucun accès base ni DOM) : utilisable côté serveur et testé.
 */

export interface LinescorePlay {
  period: number;
  home_score: number | null;
  away_score: number | null;
}

export interface LinescorePeriod {
  period: number;
  /** Libellé court : « 1 » … « 4 », « P1 », « P2 »… */
  label: string;
  away: number;
  home: number;
}

export interface Linescore {
  periods: LinescorePeriod[];
  away: number;
  home: number;
}

/** Libellé court d'une période pour l'en-tête du tableau. */
export function periodShortLabel(period: number): string {
  return period <= 4 ? String(period) : `P${period - 4}`;
}

/** Libellé lisible : « Q1 » … « Q4 », « Prol. », « Prol. 2 ». */
export function periodName(period: number): string {
  if (period <= 4) return `Q${period}`;
  return period === 5 ? 'Prol.' : `Prol. ${period - 4}`;
}

/**
 * Calcule le linescore. Renvoie `null` si le play-by-play ne contient aucun
 * score exploitable. Les périodes sans action (trou de données) reprennent
 * le cumul précédent, soit 0 point.
 */
export function computeLinescore(plays: LinescorePlay[]): Linescore | null {
  const lastByPeriod = new Map<number, { home: number; away: number }>();
  for (const p of plays) {
    if (!Number.isInteger(p.period) || p.period < 1) continue;
    if (p.home_score === null || p.away_score === null) continue;
    if (!Number.isFinite(p.home_score) || !Number.isFinite(p.away_score)) continue;
    // Les actions sont dans l'ordre chronologique : la dernière vue gagne.
    lastByPeriod.set(p.period, { home: p.home_score, away: p.away_score });
  }
  if (!lastByPeriod.size) return null;

  const lastPlayed = Math.max(...lastByPeriod.keys());
  const maxPeriod = Math.max(4, lastPlayed);
  const periods: LinescorePeriod[] = [];
  let prev = { home: 0, away: 0 };
  for (let period = 1; period <= maxPeriod; period++) {
    const cum = lastByPeriod.get(period);
    // Période pas encore jouée (match en cours) : on s'arrête.
    if (!cum && period > lastPlayed) break;
    const cur = cum ?? prev;
    periods.push({
      period,
      label: periodShortLabel(period),
      away: Math.max(0, cur.away - prev.away),
      home: Math.max(0, cur.home - prev.home),
    });
    prev = cur;
  }
  return { periods, away: prev.away, home: prev.home };
}
