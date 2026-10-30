/**
 * Authentification côté HTTP : cookie de session, contrôles des routes
 * d'écriture et gardes « connecté » / « administrateur » des routes d'API.
 */
import type { NextResponse } from 'next/server';
import { allowedOrigins, error, isOriginAllowed } from './api';
import { SESSION_COOKIE, validateSession, type SessionInfo } from './auth';

/** Valeur d'un cookie lue dans l'en-tête `Cookie` d'une requête. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

export function sessionToken(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

/**
 * Requête servie en HTTPS : URL en https, ou proxy inverse qui l'annonce
 * (`X-Forwarded-Proto`). Détermine l'attribut `Secure` du cookie : en HTTP
 * simple sur le LAN, un cookie `Secure` ne serait jamais renvoyé.
 */
export function isHttps(req: Request): boolean {
  const xfp = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp) return xfp === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Adresse du client pour la limitation des tentatives (proxy inverse compris). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || req.headers.get('x-real-ip')?.trim() || 'inconnue';
}

/** Pose le cookie de session (httpOnly, SameSite=Lax, Secure en HTTPS). */
export function setSessionCookie(res: NextResponse, req: Request, token: string, expiresAt: string): void {
  const expires = new Date(expiresAt);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
    expires,
    maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)),
  });
}

export function clearSessionCookie(res: NextResponse, req: Request): void {
  res.cookies.set({ name: SESSION_COOKIE, value: '', httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: 0 });
}

/**
 * Garde-fous communs des écritures (comme les routes sync/commentary) :
 * origine contrôlée et Content-Type JSON exigé — une requête « simple »
 * text/plain d'un autre site n'est pas préflightée. Renvoie le corps JSON
 * (objet), ou une réponse d'erreur.
 */
export async function readJsonWrite(req: Request): Promise<Record<string, unknown> | Response> {
  if (!isOriginAllowed(req, allowedOrigins())) return error(403, 'origine non autorisée pour cette écriture');
  const essence = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (essence !== 'application/json') return error(415, 'Content-Type application/json requis');
  try {
    const body = (await req.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'JSON invalide');
    return body as Record<string, unknown>;
  } catch {
    return error(400, 'JSON invalide');
  }
}

/**
 * Session valide de la requête, ou réponse 401. Le middleware protège déjà
 * les routes ; cette garde le refait au plus près des écritures sensibles
 * (et sert aux tests, qui appellent les routes sans middleware).
 */
export function requireUser(req: Request): SessionInfo | Response {
  return validateSession(sessionToken(req), { renew: false }) ?? error(401, 'non connecté');
}

/** Session d'un administrateur, ou 401 (non connecté) / 403 (simple utilisateur). */
export function requireAdmin(req: Request): SessionInfo | Response {
  const s = requireUser(req);
  if (s instanceof Response) return s;
  return s.user.role === 'admin' ? s : error(403, 'réservé aux administrateurs');
}
