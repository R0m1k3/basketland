import { getMatch } from '@/lib/db';
import { allowedOrigins, error, isOriginAllowed, json, parseId, type RouteCtx } from '@/lib/api';
import { requireAdmin } from '@/lib/authHttp';
import { commentaryStatus, enqueueCommentary, prioritizeOnView, touchViewer } from '@/lib/commentary';
import { autoTranslateEnabled } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** GET : statut seul (le même que `commentary` de GET /subtitles, sans effet de bord). */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  return json({ commentary: commentaryStatus(id) });
}

/**
 * POST /api/matches/[id]/commentary
 * - { action: 'start' } → lancement AUTOMATIQUE envoyé par la fiche une fois
 *   la lecture démarrée : en tête de file, sauf piste prête ou backoff après
 *   un échec. Sans effet quand la « Traduction automatique » est désactivée
 *   (réponse `autoTranslate: false` : la fiche montre « Traduire ce match ») ;
 * - { action: 'start', manual: true } → clic « Traduire ce match » (ou
 *   « Réessayer ») : toujours mis en tête de file, backoff ignoré, piste
 *   prête conservée, traduit jusqu'au bout même si l'on quitte la fiche
 *   (en pause seulement pendant la lecture d'un autre match) ;
 * - { action: 'retry' } → « Relancer la traduction », ADMINISTRATEURS
 *   seulement : refait la piste même prête (l'ancienne est écrasée).
 * Mêmes garde-fous que la route sync : origine contrôlée, Content-Type JSON
 * exigé (une requête « simple » text/plain n'est pas préflightée).
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée pour cette écriture');
  const essence = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (essence !== 'application/json') return error(415, 'Content-Type application/json requis');
  let body: { action?: unknown; manual?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; manual?: unknown };
  } catch {
    return error(400, 'JSON invalide');
  }
  if (body?.action !== 'start' && body?.action !== 'retry') return error(400, "action invalide (attendu : 'start' ou 'retry')");

  if (body.action === 'retry') {
    // Écrase une traduction existante : réservé aux administrateurs (401 / 403 sinon).
    const admin = requireAdmin(req);
    if (admin instanceof Response) return admin;
    touchViewer(id);
    const r = enqueueCommentary(id, { priority: true, force: true, explicit: true });
    return json({ commentary: commentaryStatus(id), message: r.message }, { status: r.queued ? 202 : 200 });
  }

  touchViewer(id); // demandé depuis la fiche : quelqu'un regarde
  if (body.manual === true) {
    // Clic explicite : mis en file même pendant le délai d'attente après un
    // échec, et traduit jusqu'au bout même si l'on quitte la fiche.
    const r = enqueueCommentary(id, { priority: true, explicit: true });
    return json({ commentary: commentaryStatus(id), message: r.message }, { status: r.queued ? 202 : 200 });
  }
  if (!autoTranslateEnabled()) {
    // Page ouverte avant le changement de réglage : la fiche affiche alors le bouton.
    return json({
      commentary: commentaryStatus(id),
      autoTranslate: false,
      message: 'Traduction automatique désactivée : lancez-la avec « Traduire ce match ».',
    });
  }
  // Lancement à l'ouverture : en tête de file, sauf piste prête ou backoff après un échec.
  const before = commentaryStatus(id).status;
  prioritizeOnView(id);
  const after = commentaryStatus(id);
  const started = after.status === 'running' || after.status === 'queued';
  return json({ commentary: after, message: started ? 'Traduction des commentaires lancée' : `Pas de lancement (${before})` }, { status: started ? 202 : 200 });
}
