import { error, json } from '@/lib/api';
import { setupFirstAdmin } from '@/lib/auth';
import { readJsonWrite, setSessionCookie } from '@/lib/authHttp';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/setup { username, password, confirm }
 * Crée le compte ADMINISTRATEUR au premier démarrage et le connecte.
 * Refusé (403) dès qu'un compte existe.
 */
export async function POST(req: Request) {
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;
  const r = await setupFirstAdmin(body.username, body.password, body.confirm);
  if (!r.ok) return error(r.status, r.error);
  const res = json({ ok: true, user: r.user });
  setSessionCookie(res, req, r.session.token, r.session.expiresAt);
  return res;
}
