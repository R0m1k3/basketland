/**
 * Noms des joueurs : Whisper écorche volontiers les noms propres (« Edie »
 * pour Edey, « Kata » pour Queta…). Avec l'effectif du match (feuille de
 * stats ESPN), on corrige ce qui est presque sûr AVANT la traduction, et on
 * donne la liste au LLM pour le reste.
 */

/** Minuscules, sans accents ni ponctuation. */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Distance d'édition (Levenshtein), plafonnée à `max + 1` pour aller vite. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Mots anglais courants qui ressemblent à des noms : jamais « corrigés ». */
const COMMON = new Set(
  'the and they then them there their this that what when where with while will would could should shot shots ball balls game games team teams play plays good great nice what heat heart hard here have home back down over open free foul fouls line lines lead leads left right time times three point points just jump move moves made make makes take takes rebound board boards block blocks steal steals pass passes drive drives dunk dunks floor court coach bench quarter half third first second fourth final buzzer score scores clock basket bucket miss misses missed run runs hit hits went goes look looks kind call calls side wing post paint lane rim glass deep long short fast break tonight night season year years really still guard guards forward center big little most best well wow yeah okay'.split(
    ' ',
  ),
);

export interface RosterIndex {
  /** Nom de famille plié → orthographe exacte. */
  surnames: Map<string, string>;
  /** Noms complets, pour le prompt de traduction. */
  full: string[];
}

/** Index de l'effectif : noms complets et noms de famille (≥ 4 lettres). */
export function rosterIndex(names: string[]): RosterIndex {
  const full = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const surnames = new Map<string, string>();
  for (const n of full) {
    const parts = n.split(/\s+/).filter((p) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(p));
    const last = parts[parts.length - 1];
    if (last && foldName(last).length >= 4) surnames.set(foldName(last), last);
  }
  return { surnames, full };
}

/** Distance tolérée pour un mot de cette longueur (corrections presque sûres seulement). */
const tolerance = (len: number) => (len >= 8 ? 2 : len >= 5 ? 1 : 0);

/** Nom de famille de l'effectif le plus proche d'un mot, dans la tolérance donnée. */
export function nearestSurname(word: string, roster: RosterIndex, tol = tolerance(foldName(word).length)): string | null {
  const w = foldName(word);
  if (!w || roster.surnames.has(w)) return roster.surnames.get(w) ?? null;
  if (tol <= 0 || COMMON.has(w)) return null;
  let best: string | null = null;
  let bestD = tol + 1;
  let tie = false;
  for (const [k, exact] of roster.surnames) {
    if (k[0] !== w[0] && tol < 2) continue; // même initiale pour les corrections d'une lettre
    const d = editDistance(w, k, tol);
    if (d < bestD) {
      best = exact;
      bestD = d;
      tie = false;
    } else if (d === bestD) tie = true;
  }
  return bestD <= tol && !tie ? best : null;
}

/**
 * Corrige, dans une ligne anglaise, les mots à majuscule presque identiques
 * à un nom de famille de l'effectif (« Edie » → « Edey »). Les cas douteux
 * sont laissés au LLM, qui a la liste.
 */
export function fixRosterNames(text: string, roster: RosterIndex): string {
  if (!roster.surnames.size) return text;
  return text.replace(/\b(\p{Lu}[\p{L}'’-]{2,})/gu, (m) => {
    const base = m.replace(/['’]s$/i, '');
    const suffix = m.slice(base.length);
    const near = nearestSurname(base, roster);
    return near && near !== base ? `${near}${suffix}` : m;
  });
}

/**
 * Un nom de la ligne anglaise (5 premières lettres pliées) est-il rendu en
 * français, tel quel ou corrigé vers un joueur proche de l'effectif ?
 */
export function nameRendered(token5: string, frFolded: string, roster: RosterIndex | undefined): boolean {
  if (frFolded.includes(token5)) return true;
  if (!roster) return false;
  for (const [k] of roster.surnames) {
    if (frFolded.includes(k.slice(0, 5)) && editDistance(token5, k.slice(0, 5), 3) <= 3) return true;
  }
  return false;
}
