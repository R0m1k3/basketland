import { dbHealth, lastIngests, lastSuccessfulIngest } from '@/lib/db';
import { ffmpegAvailable } from '@/lib/audio';
import { json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  const h = dbHealth();
  const last = h.ok ? lastSuccessfulIngest() : undefined;
  return json(
    {
      status: h.ok ? 'ok' : 'error',
      db: h,
      last_sync: last ? { task: last.task, finished_at: last.finished_at, detail: last.detail } : null,
      recent_jobs: h.ok ? lastIngests(5).map((j) => ({ task: j.task, ok: !!j.ok, finished_at: j.finished_at })) : [],
      ffmpeg: ffmpegAvailable(),
      node: process.version,
      time: new Date().toISOString(),
    },
    { status: h.ok ? 200 : 503 },
  );
}
