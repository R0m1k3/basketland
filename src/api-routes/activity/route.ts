import { json } from '@/lib/api';
import { currentActivity } from '@/lib/activity';

export const dynamic = 'force-dynamic';

/** GET /api/activity : traductions et analyses en cours ou en attente (panneau de l'accueil). */
export async function GET() {
  return json(currentActivity(), { headers: { 'Cache-Control': 'no-store' } });
}
