import { json } from '@/lib/api';
import { revokeSession } from '@/lib/auth';
import { clearSessionCookie, readJsonWrite, sessionToken } from '@/lib/authHttp';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout — supprime la session en base et efface le cookie.
 * Publique (une session déjà expirée doit pouvoir se déconnecter), mais
 * soumise au contrôle d'origine : un autre site ne peut pas déconnecter.
 */
export async function POST(req: Request) {
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;
  revokeSession(sessionToken(req));
  const res = json({ ok: true });
  clearSessionCookie(res, req);
  return res;
}
