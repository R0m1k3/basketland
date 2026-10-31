import { error, json } from '@/lib/api';
import { login } from '@/lib/auth';
import { clientIp, readJsonWrite, setSessionCookie } from '@/lib/authHttp';
import { safeNextPath } from '@/lib/authRoutes';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login { username, password, next? }
 * Réponse : { ok, next } (destination relative du même site) + cookie de session.
 * Échec : 401 « Identifiant ou mot de passe incorrect » (identique que le
 * compte existe ou non), 429 après 5 échecs (1 minute d'attente).
 */
export async function POST(req: Request) {
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;
  const r = await login(body.username, body.password, clientIp(req));
  if (!r.ok) return error(r.status, r.error);
  const res = json({ ok: true, user: r.user, next: safeNextPath(typeof body.next === 'string' ? body.next : null) });
  setSessionCookie(res, req, r.session.token, r.session.expiresAt);
  return res;
}
