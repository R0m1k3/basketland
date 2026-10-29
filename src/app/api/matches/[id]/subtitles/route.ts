import { getMatch } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { commentaryStatus, prioritizeOnView, servedCommentaryCues } from '@/lib/commentary';

export const dynamic = 'force-dynamic';

/**
 * Sous-titres FR : la TRADUCTION des commentaires du replay (Whisper puis LLM
 * local), triée par video_ts. Les sous-titres sont publiés par tranches de
 * 10 min pendant le travail : ceux déjà traduits sont servis même pendant
 * `status: 'running'`, et `commentary.available_until` dit jusqu'où ils
 * vont ; `status: 'ready'` n'arrive qu'une fois la piste complète.
 *
 * Les anciens sous-titres fabriqués depuis le play-by-play ESPN ne sont plus
 * servis ici (la table `subtitles` reste utilisée en interne pour situer les
 * actions dans la vidéo).
 *
 * Ouvrir la fiche met le match en tête de file s'il n'a pas encore de piste
 * complète (sauf backoff après un échec).
 */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  prioritizeOnView(id);
  const cues = servedCommentaryCues(id);
  return json({
    match_id: id,
    count: cues.length,
    subtitles: cues.map((c) => ({ seq: c.seq, video_ts: c.start_ts, end_ts: c.end_ts, text: c.text_fr, speaker: '', kind: 'voice' })),
    commentary: commentaryStatus(id),
  });
}
