import { error, json } from '@/lib/api';
import { changeOwnPassword } from '@/lib/auth';
import { readJsonWrite, requireUser } from '@/lib/authHttp';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/password { current, password, confirm }
 * Change le mot de passe du compte connecté. Les autres sessions du compte
 * sont révoquées, la session courante est conservée.
 */
export async function POST(req: Request) {
  const session = requireUser(req);
  if (session instanceof Response) return session;
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;
  const r = await changeOwnPassword(session, body.current, body.password, body.confirm);
  return r.ok ? json({ ok: true }) : error(r.status, r.error);
}
