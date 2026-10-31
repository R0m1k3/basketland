import { listUsers } from '@/lib/db';
import { error, json } from '@/lib/api';
import { createUser, deleteUser, resetUserPassword, setUserRole } from '@/lib/auth';
import { readJsonWrite, requireAdmin } from '@/lib/authHttp';

export const dynamic = 'force-dynamic';

/** GET /api/admin/users — liste des comptes (sans empreintes de mot de passe). Administrateurs seulement. */
export async function GET(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return json({ users: listUsers() });
}

/**
 * POST /api/admin/users — administrateurs seulement.
 * - { action: 'create', username, password, role }
 * - { action: 'delete', id }            (ni soi-même, ni le dernier administrateur)
 * - { action: 'reset-password', id, password }   (révoque les sessions du compte)
 * - { action: 'set-role', id, role }    (le dernier administrateur le reste)
 */
export async function POST(req: Request) {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  const body = await readJsonWrite(req);
  if (body instanceof Response) return body;

  if (body.action === 'create') {
    const r = await createUser(body.username, body.password, body.role);
    return r.ok ? json({ ok: true, id: r.id, users: listUsers() }, { status: 201 }) : error(r.status, r.error);
  }

  const id = typeof body.id === 'number' && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
  if (id === null) return error(400, 'id invalide');
  let r;
  switch (body.action) {
    case 'delete':
      r = deleteUser(session.user, id);
      break;
    case 'reset-password':
      r = await resetUserPassword(session, id, body.password);
      break;
    case 'set-role':
      r = setUserRole(id, body.role);
      break;
    default:
      return error(400, "action invalide (attendu : 'create', 'delete', 'reset-password' ou 'set-role')");
  }
  return r.ok ? json({ ok: true, users: listUsers() }) : error(r.status, r.error);
}
