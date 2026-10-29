import { getMatch, getPlays, getSubtitles, getSyncSettings } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';
import { ingestMatchDetails, regenerateSubtitles } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

/** Sous-titres FR triés par video_ts. */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const m = getMatch(id);
  if (!m) return error(404, 'match introuvable');
  let subs = getSubtitles(id);
  if (!subs.length && m.status === 'final') {
    try {
      if (!getPlays(id).length) await ingestMatchDetails(m);
      else regenerateSubtitles(id);
      subs = getSubtitles(id);
    } catch (e) {
      return json({ match_id: id, count: 0, subtitles: [], reason: (e as Error).message }, { status: 502 });
    }
  }
  return json({
    match_id: id,
    count: subs.length,
    video_available: !!m.video_available,
    settings: getSyncSettings(id),
    subtitles: subs.map((s) => ({ seq: s.seq, video_ts: s.video_ts, end_ts: s.end_ts, text: s.text_fr, speaker: s.speaker, kind: s.kind })),
  });
}
