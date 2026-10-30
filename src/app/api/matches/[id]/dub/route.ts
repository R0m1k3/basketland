import { getMatch } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { dubDisabledReason, dubManifest, prioritizeDubOnView } from '@/lib/dub';
import { touchViewer } from '@/lib/viewers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/matches/[id]/dub — manifeste du doublage français (lecteur) :
 * `{ status, reason?, chunks: [{ idx, start, end, url, speech }], voices }`.
 * Temps en secondes de la vidéo : t = 0 de l'audio d'un tronçon ↔ `start` ;
 * `speech` liste les plages où la voix française parle. Les tronçons déjà
 * doublés sont servis même pendant `running` / `partial`.
 *
 * `?t=<secondes>` : position de lecture. Comme pour les sous-titres, c'est
 * un signe de vie du spectateur (`touchViewer`), et le doublage du match
 * passe en tête de file s'il reste des sous-titres à doubler (il démarre
 * quand le GPU est libre : la traduction passe d'abord). Sans `t`, aucun
 * effet de bord.
 */
export async function GET(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  // Charge le moteur de voix au premier appel : sa configuration dit s'il est utilisable.
  await dubDisabledReason();
  const raw = new URL(req.url).searchParams.get('t');
  if (raw !== null) {
    const t = Number(raw);
    touchViewer(id, Number.isFinite(t) && t >= 0 ? t : null);
    prioritizeDubOnView(id);
  }
  return json(dubManifest(id));
}
