/**
 * Session courante pour les composants serveur (layout, pages).
 * Le middleware a déjà validé (et renouvelé) la session : ici on se contente
 * de la relire, sans écrire en base ni poser de cookie.
 */
import { cookies } from 'next/headers';
import { SESSION_COOKIE, validateSession, type SessionInfo } from './auth';

export async function currentSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return validateSession(token, { renew: false });
}
