/**
 * Helpers de fuseau horaire : tous les horaires affichés sont en Europe/Paris.
 * On s'appuie uniquement sur Intl (ICU embarqué dans Node 22), sans dépendance.
 */
export const PARIS_TZ = 'Europe/Paris';

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, opts: Intl.DateTimeFormatOptions, locale = 'fr-FR'): Intl.DateTimeFormat {
  let f = partsCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: PARIS_TZ, ...opts });
    partsCache.set(key, f);
  }
  return f;
}

function toDate(input: string | Date | number): Date {
  return input instanceof Date ? input : new Date(input);
}

/** Clé de jour 'YYYY-MM-DD' dans le fuseau de Paris. */
export function parisDateKey(input: string | Date | number): string {
  const parts = fmt('key', { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').formatToParts(toDate(input));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Décalage UTC de Paris à un instant donné, ex. '+01:00' (hiver) ou '+02:00' (été). */
export function parisOffset(input: string | Date | number): string {
  const parts = fmt('off', { timeZoneName: 'longOffset', hour: '2-digit' }, 'en-US').formatToParts(toDate(input));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = tz.match(/GMT([+-]\d{2}):?(\d{2})?/);
  if (!m) return '+00:00';
  return `${m[1]}:${m[2] ?? '00'}`;
}

/** Heure 'HH:mm' à Paris. */
export function parisTime(input: string | Date | number): string {
  return fmt('time', { hour: '2-digit', minute: '2-digit', hour12: false }).format(toDate(input));
}

/** ISO 8601 local Paris avec offset, ex. '2026-10-28T04:12:54+01:00'. */
export function parisIso(input: string | Date | number): string {
  const d = toDate(input);
  const parts = fmt(
    'iso',
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    'en-CA',
  ).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${parisOffset(d)}`;
}

/** Libellé long : 'mercredi 28 octobre 2026'. */
export function parisDateLabel(input: string | Date | number): string {
  return fmt('long', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(input));
}

/** Libellé à partir d'une clé 'YYYY-MM-DD' (midi UTC pour éviter tout débordement). */
export function labelForDateKey(key: string): string {
  return parisDateLabel(new Date(`${key}T12:00:00Z`));
}

/** 'mer. 28 oct. · 04:12' */
export function parisShort(input: string | Date | number): string {
  const d = toDate(input);
  return `${fmt('short', { weekday: 'short', day: 'numeric', month: 'short' }).format(d)} · ${parisTime(d)}`;
}

/** Instant UTC (ISO) du début du jour `key` (YYYY-MM-DD) à Paris. */
export function parisDayStartUtc(key: string): string {
  const guess = new Date(`${key}T00:00:00Z`);
  const off = parisOffset(new Date(guess.getTime() - 2 * 3600_000));
  const t = Date.parse(`${key}T00:00:00${off}`);
  // Vérification (changement d'heure à 2h/3h du matin : l'offset de minuit est celui de la veille).
  return new Date(t).toISOString();
}

/** Format 'YYYYMMDD' (UTC) utilisé par le paramètre `dates` d'ESPN. */
export function espnDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400_000);
}

/** Libellé de saison : 2026 → '2026-27'. */
export function seasonLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Saison NBA courante (année de début) : la saison démarre en octobre. */
export function currentSeason(now = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 8 ? y : y - 1;
}
