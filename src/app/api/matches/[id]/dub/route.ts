import { getMatch } from '@/lib/db';
import { allowedOrigins, error, isOriginAllowed, json, parseId, type RouteCtx } from '@/lib/api';
import { requireAdmin } from '@/lib/authHttp';
import { commentaryStatus } from '@/lib/commentary';
import { dubDisabledReason, dubManifest, prioritizeDubOnView, requestDub, stopDub } from '@/lib/dub';
import { touchViewer } from '@/lib/viewers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/matches/[id]/dub — manifeste du doublage français (lecteur) :
 * `{ status, reason?, progress?, chunks: [{ idx, start, end, url, speech }], voices }`.
 * Temps en secondes de la vidéo : t = 0 de l'audio d'un tronçon ↔ `start` ;
 * `speech` liste les plages où la voix française parle. Les tronçons déjà
 * doublés sont servis même pendant `running` / `partial`.
 *
 * `?t=<secondes>` : position de lecture, envoyée par le lecteur seulement
 * pendant la lecture de la VF doublée (en pause : statut seul). Comme pour
 * les sous-titres, c'est un signe de vie du spectateur (`touchViewer`), et
 * le doublage du match passe en tête de file s'il reste des sous-titres à
 * doubler (il démarre
 * quand le GPU est libre : la traduction passe d'abord) — en mode
 * « doublage » avec la traduction automatique, ou si un doublage a déjà été
 * demandé pour ce match. Sans `t`, aucun effet de bord.
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

/**
 * POST /api/matches/[id]/dub
 * - { action: 'start' } → clic « Doubler ce match » (tout utilisateur
 *   connecté) : sous-titres incomplets, la traduction est mise en file
 *   (explicite) ; puis le doublage, en travail explicite : mené jusqu'au bout
 *   même si l'on quitte la fiche, quels que soient la traduction automatique,
 *   la fenêtre de fond et le mode « Version française » (en pause pendant la
 *   lecture d'un autre match et pendant une traduction) ;
 * - { action: 'retry' } → « Relancer le doublage », ADMINISTRATEURS
 *   seulement : le doublage existant est effacé puis refait (refusé, 409,
 *   pendant que ce match est doublé) ;
 * - { action: 'stop' } → « Arrêter le doublage » (tout utilisateur
 *   connecté) : retiré de la file ou interrompu, ce qui est doublé reste ;
 *   « Reprendre le doublage » (`start`) le relance. La traduction n'est
 *   pas touchée.
 * Réponse : `{ dub: manifeste, commentary: statut de la traduction, message }`.
 * Mêmes garde-fous que la route commentary : origine contrôlée, Content-Type
 * JSON exigé (une requête « simple » text/plain n'est pas préflightée).
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée pour cette écriture');
  const essence = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (essence !== 'application/json') return error(415, 'Content-Type application/json requis');
  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return error(400, 'JSON invalide');
  }
  if (body?.action !== 'start' && body?.action !== 'retry' && body?.action !== 'stop') {
    return error(400, "action invalide (attendu : 'start', 'retry' ou 'stop')");
  }
  if (body.action === 'stop') {
    const r = stopDub(id);
    return json({ dub: dubManifest(id), commentary: commentaryStatus(id), message: r.message });
  }
  if (body.action === 'retry') {
    // Efface un doublage existant : réservé aux administrateurs (401 / 403 sinon).
    const admin = requireAdmin(req);
    if (admin instanceof Response) return admin;
  }

  await dubDisabledReason(); // moteur de voix chargé : sa configuration est vérifiée avant la mise en file
  touchViewer(id); // demandé depuis la fiche : quelqu'un regarde
  const r = requestDub(id, { reset: body.action === 'retry' });
  const status = r.queued ? 202 : body.action === 'retry' && r.started ? 409 : 200;
  return json({ dub: dubManifest(id), commentary: commentaryStatus(id), message: r.message }, { status });
}
