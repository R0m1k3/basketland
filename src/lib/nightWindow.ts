/**
 * Fenêtre des tâches de fond lourdes (pré-traduction des commentaires,
 * analyse vidéo OCR), en heures de Paris : `COMMENTARY_NIGHT_WINDOW`,
 * « 2-6 » par défaut (de 2 h à 6 h), « off » pour la désactiver, « always »
 * pour travailler en continu. Hors fenêtre, rien ne tourne en tâche de
 * fond : seuls les matchs qu'on ouvre sont analysés et traduits.
 */
export function inNightWindow(now = new Date()): boolean {
  const spec = (process.env.COMMENTARY_NIGHT_WINDOW ?? '2-6').trim().toLowerCase();
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

/** Libellé de la fenêtre (« de 2 h à 6 h », « en continu »), ou null si elle est désactivée. */
export function nightWindowLabel(): string | null {
  const spec = (process.env.COMMENTARY_NIGHT_WINDOW ?? '2-6').trim().toLowerCase();
  if (spec === 'always' || spec === 'on') return 'en continu';
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(spec);
  return m ? `chaque nuit de ${Number(m[1]) % 24} h à ${Number(m[2]) % 24} h` : null;
}
