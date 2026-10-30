import { getMatch } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { commentaryStatus, prioritizeOnView, servedCommentaryCues, touchViewer } from '@/lib/commentary';

export const dynamic = 'force-dynamic';

/**
 * Sous-titres FR : la TRADUCTION des commentaires du replay (Whisper puis
 * LLM), triée par video_ts. Traduction à la demande : les sous-titres sont
 * publiés par tronçons d'1 min à partir de la position du spectateur ; ceux
 * déjà traduits sont servis même pendant `status: 'running'`,
 * `commentary.available_until` dit jusqu'où ils vont d'un seul tenant depuis
 * la position, `commentary.covered` liste les plages traduites ;
 * `status: 'ready'` n'arrive qu'une fois la piste complète.
 *
 * `?t=<secondes>` : position de lecture. Chaque appel est un signe de vie du
 * spectateur (`touchViewer`) : sans lui pendant 3 min, la traduction se met
 * en pause et décharge les modèles.
 *
 * Les anciens sous-titres fabriqués depuis le play-by-play ESPN ne sont plus
 * servis ici (la table `subtitles` reste utilisée en interne pour situer les
 * actions dans la vidéo).
 *
 * Ouvrir la fiche met le match en tête de file s'il n'a pas encore de piste
 * complète (sauf backoff après un échec).
 */
export async function GET(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  const t = Number(new URL(req.url).searchParams.get('t'));
  touchViewer(id, Number.isFinite(t) ? t : null);
  prioritizeOnView(id);
  const cues = servedCommentaryCues(id);
  return json({
    match_id: id,
    count: cues.length,
    subtitles: cues.map((c) => ({ seq: c.seq, video_ts: c.start_ts, end_ts: c.end_ts, text: c.text_fr, speaker: '', kind: 'voice' })),
    commentary: commentaryStatus(id),
  });
}
