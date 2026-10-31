import { getMatch, listClips } from '@/lib/db';
import { error, json, parseId, type RouteCtx } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Hors périmètre v1 : enregistrements personnels (table user_clips prévue). */
export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  return json({ match_id: id, clips: listClips(id), implemented: false });
}

export async function POST() {
  return error(501, 'Enregistrement personnel non disponible en v1');
}
