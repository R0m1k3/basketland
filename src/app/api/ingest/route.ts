import { error, json } from '@/lib/api';
import { checkIngestAuth, runJob, type JobName } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

const JOBS: JobName[] = ['sync-schedule', 'sync-season', 'sync-stats', 'sync-videos', 'sync-subtitles'];

/**
 * POST /api/ingest  (Authorization: Bearer <INGEST_TOKEN>)
 * Corps : { "jobs": ["sync-schedule", "sync-stats"], "season": 2026 }
 * Le jeton vient de la variable INGEST_TOKEN ou, à défaut, du fichier /data/ingest_token.
 */
export async function POST(req: Request) {
  if (!checkIngestAuth(req.headers.get('authorization'))) return error(401, 'jeton invalide');
  let body: { jobs?: string[]; season?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const jobs = (body.jobs?.length ? body.jobs : ['sync-schedule', 'sync-stats', 'sync-videos']) as JobName[];
  const unknown = jobs.filter((j) => !JOBS.includes(j));
  if (unknown.length) return error(400, `jobs inconnus: ${unknown.join(', ')} (attendus: ${JOBS.join(', ')})`);
  const results: Record<string, unknown> = {};
  for (const j of jobs) results[j] = await runJob(j, body.season);
  return json({ ok: Object.values(results).every((r) => (r as { ok?: boolean })?.ok !== false), results });
}
