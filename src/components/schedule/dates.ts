/**
 * Libellés de dates en français à partir d'une clé de jour Paris 'YYYY-MM-DD'.
 * Midi UTC sert d'ancre : le jour reste le bon quel que soit l'heure d'été.
 */
import { shiftKey } from '@/lib/dayKeys';

const cache = new Map<string, Intl.DateTimeFormat>();
function f(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = JSON.stringify(opts);
  let x = cache.get(k);
  if (!x) {
    x = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...opts });
    cache.set(k, x);
  }
  return x;
}
const at = (key: string) => new Date(`${key}T12:00:00Z`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 'ven.' */
export function weekdayShort(key: string): string {
  return f({ weekday: 'short' }).format(at(key));
}
/** 'vendredi' */
export function weekdayLong(key: string): string {
  return f({ weekday: 'long' }).format(at(key));
}
/** 30 */
export function dayNumber(key: string): number {
  return Number(key.slice(8, 10));
}
/** 'oct.' */
export function monthShort(key: string): string {
  return f({ month: 'short' }).format(at(key));
}
/** 'octobre 2026' */
export function monthYear(key: string): string {
  return f({ month: 'long', year: 'numeric' }).format(at(key));
}
/** 'ven. 30 oct.' */
export function shortDate(key: string): string {
  return f({ weekday: 'short', day: 'numeric', month: 'short' }).format(at(key));
}
/** 'Vendredi 30 octobre' */
export function longDate(key: string): string {
  return cap(f({ weekday: 'long', day: 'numeric', month: 'long' }).format(at(key)));
}

/** « Aujourd'hui », « Demain », « Hier » ou 'ven. 30 oct.'. */
export function relativeDay(key: string, today: string): string {
  if (key === today) return "Aujourd'hui";
  if (key === shiftKey(today, 1)) return 'Demain';
  if (key === shiftKey(today, -1)) return 'Hier';
  return cap(shortDate(key));
}

/** « Nuit du jeudi 29 au vendredi 30 octobre » (mois répété s'il change). */
export function nightLabel(key: string): string {
  const next = shiftKey(key, 1);
  const sameMonth = key.slice(0, 7) === next.slice(0, 7);
  const a = sameMonth
    ? `${weekdayLong(key)} ${dayNumber(key)}`
    : f({ weekday: 'long', day: 'numeric', month: 'long' }).format(at(key));
  const b = f({ weekday: 'long', day: 'numeric', month: 'long' }).format(at(next));
  return `Nuit du ${a} au ${b}`;
}

/** Temps restant avant un instant : « dans 9 h 15 », « dans 3 j », « dans 12 min ». */
export function countdown(iso: string, now = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return 'imminent';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const m = min % 60;
    return m ? `dans ${h} h ${String(m).padStart(2, '0')}` : `dans ${h} h`;
  }
  if (h < 48) return `dans ${h} h`;
  return `dans ${Math.round(h / 24)} j`;
}

/**
 * Quand un match a été joué, vu de France : un match avant midi s'est joué
 * « cette nuit » (aujourd'hui) ; sinon « Hier », « Mar. 27 oct. »…
 */
export function playedWhen(dayKey: string, timeParis: string, today: string): string {
  const night = Number(timeParis.slice(0, 2)) < 12;
  if (dayKey === today) return night ? 'Cette nuit' : "Aujourd'hui";
  return relativeDay(dayKey, today);
}
