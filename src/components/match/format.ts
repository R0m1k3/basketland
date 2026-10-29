/** Petites fonctions de mise en forme partagées par la fiche match (client et serveur). */

/** Id de la racine de la fiche (porte `data-scope` pour le mode « scores masqués »). */
export const FICHE_ROOT_ID = 'fiche-match';

/** Durée vidéo : « 4:05 » ou « 1:02:09 ». */
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Chrono de match en secondes → « 7:43 ». */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** « 7:43 », « 7.43 », « 743 » ou « 0:05.3 » → secondes (null si invalide). */
export function parseClock(input: string): number | null {
  const v = input.trim().replace(',', '.');
  const mmss = (min: number, sec: number) => (sec >= 60 || min > 15 ? null : min * 60 + sec);
  // « 7:43 », « 7 43 », « 7h43 » (secondes décimales éventuelles ignorées)
  let m = v.match(/^(\d{1,2})[:h ](\d{1,2})(?:\.\d+)?$/);
  if (m) return mmss(Number(m[1]), Number(m[2]));
  // « 7.43 » : minutes.secondes si deux chiffres après le point et minutes plausibles
  m = v.match(/^(\d{1,2})\.(\d{2})$/);
  if (m && Number(m[1]) <= 15) return mmss(Number(m[1]), Number(m[2]));
  // « 743 »
  m = v.match(/^(\d{1,2})(\d{2})$/);
  if (m) return mmss(Number(m[1]), Number(m[2]));
  // Dernière minute : le chrono affiche les secondes seules (« 42.3 »).
  m = v.match(/^(\d{1,2})(?:\.\d+)?$/);
  if (m) {
    const sec = Number(m[1]);
    return sec < 60 ? sec : null;
  }
  return null;
}

export { periodName } from '@/lib/linescore';
