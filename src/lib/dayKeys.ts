/**
 * Clés de jour de Paris ('YYYY-MM-DD') et nuits NBA : fonctions pures, sans
 * base, utilisables par les composants client comme par `queries.ts`.
 *
 * Une « nuit NBA » regroupe les matchs de midi (Paris) au lendemain midi :
 * un match à 01:30 le 30/10 appartient à la nuit du 29 au 30.
 */
import { addDays, parisDateKey } from './time';

const HOUR = 3600_000;

export function todayKey(now = new Date()): string {
  return parisDateKey(now);
}

/** Décale une clé de jour de `n` jours (midi UTC : insensible aux changements d'heure). */
export function shiftKey(key: string, n: number): string {
  return parisDateKey(addDays(new Date(`${key}T12:00:00Z`), n));
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateKey(v: string | undefined | null): v is string {
  if (!v || !KEY_RE.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && shiftKey(v, 0) === v;
}

/** Nuit NBA d'un match : jour de Paris de (début − 12 h). */
export function nightKeyOf(dateUtc: string): string {
  return parisDateKey(Date.parse(dateUtc) - 12 * HOUR);
}

/** Un match est « à venir » s'il est programmé dans le futur, ou en cours. */
export function isUpcoming(g: { status: string; date_utc: string }, now = new Date()): boolean {
  return g.status === 'live' || (g.status === 'scheduled' && Date.parse(g.date_utc) > now.getTime());
}
