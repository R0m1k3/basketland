import { error, json } from '@/lib/api';
import { currentActivity } from '@/lib/activity';
import { commentaryDisabledReason, commentaryRunningMatchId } from '@/lib/commentary';
import { dubDisabledReason } from '@/lib/dub';
import { checkIngestAuth } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST /api/internal/page-state  (Authorization: Bearer <INGEST_TOKEN>)
 *
 * Appelé par le serveur Rust seul, qui calcule les données des pages
 * (`GET /api/pages/…`, étape 8a de docs/migration-rust.md) alors que les files
 * de traduction et de doublage tournent encore ici : il lui faut leur état en
 * mémoire. Jamais exposé : le serveur Rust ne relaie pas /api/internal/…
 * (404) et ce chemin exige le jeton d'ingestion. Le branchement des médias en
 * Rust le rendra inutile.
 *
 * Corps : `{ dub?: boolean }` — `dub: true` ajoute `dubDisabledReason()`
 * (charge le moteur de voix ; page Paramètres d'un administrateur seulement).
 */
export async function POST(req: Request) {
  if (!checkIngestAuth(req.headers.get('authorization'))) return error(401, 'jeton invalide');
  let body: { dub?: unknown } | null = null;
  try {
    body = (await req.json()) as { dub?: unknown } | null;
  } catch {
    body = null;
  }
  const dub = !!body && typeof body === 'object' && body.dub === true;
  return json({
    running_match_id: commentaryRunningMatchId(),
    activity: currentActivity(),
    commentary_disabled_reason: commentaryDisabledReason(),
    dub_disabled_reason: dub ? await dubDisabledReason() : null,
  });
}
