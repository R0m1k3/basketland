import { getCommentaryCues, getMatch } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { commentaryReady, commentaryStatus, prioritizeOnView } from '@/lib/commentary';

export const dynamic = 'force-dynamic';

/**
 * Sous-titres FR : la TRADUCTION des commentaires du replay (Whisper puis LLM
 * local), triée par video_ts. Vide tant que la piste n'est pas prête ;
 * `commentary` dit où en est le travail.
 *
 * Les anciens sous-titres fabriqués depuis le play-by-play ESPN ne sont plus
 * servis ici (la table `subtitles` reste utilisée en interne pour situer les
 * actions dans la vidéo).
 *
 * Ouvrir la fiche met le match en tête de file s'il n'a pas encore de piste
 * (sauf backoff après un échec).
 */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  prioritizeOnView(id);
  const cues = commentaryReady(id) ? getCommentaryCues(id) : [];
  return json({
    match_id: id,
    count: cues.length,
    subtitles: cues.map((c) => ({ seq: c.seq, video_ts: c.start_ts, end_ts: c.end_ts, text: c.text_fr, speaker: '', kind: 'voice' })),
    commentary: commentaryStatus(id),
  });
}
