import { error, json } from '@/lib/api';
import { checkIngestAuth } from '@/lib/ingest';
import { prioritizeFoundReplay } from '@/lib/replayCheck';
import { queueNewReplayWork } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

/**
 * POST /api/internal/replays  (Authorization: Bearer <INGEST_TOKEN>)
 *
 * Appelé par le serveur Rust seul, qui cherche désormais les replays (étape
 * 5b de docs/migration-rust.md) alors que les files de traduction et
 * d'analyse restent ici. Jamais exposé : le serveur Rust ne relaie pas
 * /api/internal/… (404) et ce chemin exige le jeton d'ingestion.
 *
 * Corps :
 * - `{ match_id }` : replay trouvé par une recherche à la demande → traduction
 *   de ce match en tête de file (`prioritizeFoundReplay`) ;
 * - `{}` : replays trouvés par le job `sync-videos` → `queueNewReplayWork`
 *   (traductions et analyses des replays récents), comme le cron de Node
 *   après `syncVideos`.
 */
export async function POST(req: Request) {
  if (!checkIngestAuth(req.headers.get('authorization'))) return error(401, 'jeton invalide');
  let body: { match_id?: unknown } | null = null;
  try {
    body = (await req.json()) as { match_id?: unknown } | null;
  } catch {
    body = null;
  }
  const raw = body && typeof body === 'object' ? body.match_id : undefined;
  if (raw !== undefined && raw !== null) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) return error(400, 'match_id invalide');
    return json({ ok: true, prioritized: prioritizeFoundReplay(id) });
  }
  return json({ ok: true, ...queueNewReplayWork() });
}
