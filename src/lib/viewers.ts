/**
 * Spectateurs : qui regarde quel match, et à quelle position.
 *
 * La fiche d'un match envoie un signe de vie pendant la lecture
 * (POST /api/matches/[id]/watching, toutes les 20 s) et à chaque
 * interrogation des sous-titres. Sans signe de vie depuis `viewerIdleMs`
 * (3 min par défaut), le spectateur est considéré parti.
 *
 * Sert à donner la PRIORITÉ À LA LECTURE : tant que quelqu'un regarde, les
 * tâches de fond (traduction d'autres matchs, analyse vidéo OCR) attendent,
 * pour ne pas disputer la connexion à ok.ru et le processeur au lecteur.
 */
/** at : dernier signe de vie ; t : position (s) ; movedAt : dernière fois que la position a avancé (lecture). */
const viewers = ((globalThis as unknown as { __blViewers?: Map<number, { at: number; t: number; movedAt?: number }> }).__blViewers ??= new Map());

export function viewerIdleMs(): number {
  const n = Number(process.env.COMMENTARY_VIEWER_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60_000;
}

/** Signe de vie d'un spectateur (position de lecture en secondes, si connue). */
export function touchViewer(matchId: number, t?: number | null): void {
  const prev = viewers.get(matchId);
  const now = Date.now();
  const pos = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : (prev?.t ?? 0);
  // Position qui change : la vidéo est lue (une position identique d'un signe à l'autre : en pause).
  const moved = !!prev && typeof t === 'number' && Math.abs(pos - prev.t) >= 1;
  viewers.set(matchId, { at: now, t: pos, movedAt: moved ? now : prev?.movedAt });
}

/** Durée (ms) sans que la position avance au-delà de laquelle la lecture est considérée en pause. */
const PLAYING_MS = 60_000;

/** La vidéo de ce match est-elle en cours de lecture (spectateur actif ET position qui avance) ? */
export function viewerPlaying(matchId: number, now = Date.now()): boolean {
  const v = viewers.get(matchId);
  return !!v && now - v.at < viewerIdleMs() && v.movedAt !== undefined && now - v.movedAt < PLAYING_MS;
}

export function viewerActive(matchId: number, now = Date.now()): boolean {
  const v = viewers.get(matchId);
  return !!v && now - v.at < viewerIdleMs();
}

/** Position du spectateur actif, sinon null. */
export function viewerPosition(matchId: number): number | null {
  return viewerActive(matchId) ? (viewers.get(matchId)?.t ?? 0) : null;
}

/** Matchs regardés en ce moment. */
export function activeViewers(now = Date.now()): number[] {
  const out: number[] = [];
  for (const [id, v] of viewers) if (now - v.at < viewerIdleMs()) out.push(id);
  return out;
}

/** Quelqu'un regarde-t-il un AUTRE match que `matchId` (ou n'importe lequel, sans argument) ? */
export function someoneWatching(exceptMatchId?: number): boolean {
  return activeViewers().some((id) => id !== exceptMatchId);
}

/** Tests : oublie tous les spectateurs. */
export function __clearViewersForTests(): void {
  viewers.clear();
}
