/**
 * Fenêtre des tâches de fond lourdes (traduction des commentaires, analyse
 * vidéo OCR), en heures de Paris : `COMMENTARY_NIGHT_WINDOW`, « always » par
 * défaut (dès qu'un replay est disponible), « 2-6 » pour de 2 h à 6 h
 * seulement, « off » pour ne traiter que les matchs qu'on ouvre. Dans tous
 * les cas, les tâches de fond s'effacent pendant qu'une vidéo est regardée
 * (voir viewers.ts).
 *
 * La fenêtre est FERMÉE quand la « Traduction automatique » est désactivée
 * (/parametres) : les files de traduction et d'analyse abandonnent alors
 * leurs travaux de fond déjà en attente, et un travail de fond en cours se
 * met en pause au tronçon suivant. Les demandes explicites (clic « Traduire
 * ce match », match regardé) ne passent pas par la fenêtre.
 */
import { autoTranslateEnabled } from './settings';

/** Plage horaire seule (`COMMENTARY_NIGHT_WINDOW`), sans le réglage « Traduction automatique ». */
export function inScheduleWindow(now = new Date()): boolean {
  const spec = (process.env.COMMENTARY_NIGHT_WINDOW ?? 'always').trim().toLowerCase();
  if (spec === 'off' || spec === '0' || spec === '') return false;
  if (spec === 'always' || spec === 'on') return true;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(spec);
  if (!m) return false;
  const from = Number(m[1]) % 24;
  const to = Number(m[2]) % 24;
  // formatToParts : en français, l'heure seule s'écrit « 02 h ».
  const part = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now).find((p) => p.type === 'hour');
  const h = Number(part?.value ?? NaN);
  if (!Number.isFinite(h)) return false;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** Réglage « Traduction automatique » ; base illisible : valeur par défaut (activée). */
function autoTranslateOn(): boolean {
  try {
    return autoTranslateEnabled();
  } catch {
    return true;
  }
}

/** Les tâches de fond sont-elles permises maintenant ? Plage horaire ouverte ET traduction automatique activée. */
export function inNightWindow(now = new Date()): boolean {
  return inScheduleWindow(now) && autoTranslateOn();
}

/** Libellé de la fenêtre (« de 2 h à 6 h », « en continu »), ou null si elle est désactivée. */
export function nightWindowLabel(): string | null {
  const spec = (process.env.COMMENTARY_NIGHT_WINDOW ?? 'always').trim().toLowerCase();
  if (spec === 'always' || spec === 'on') return 'en continu';
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(spec);
  return m ? `chaque nuit de ${Number(m[1]) % 24} h à ${Number(m[2]) % 24} h` : null;
}
