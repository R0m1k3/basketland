/**
 * Protection de tout le site : chaque page et chaque route d'API exige une
 * session valide, sauf les chemins publics (voir src/lib/authRoutes.ts).
 *
 * Middleware en runtime Node.js (stable depuis Next 15.5) : il valide
 * réellement la session en base SQLite, au lieu de ne vérifier que la
 * présence du cookie comme le ferait un middleware Edge.
 *
 * Les routes vidéo (/api/video/…) sont protégées elles aussi : l'élément
 * <video> et hls.js les appellent sur la même origine, le cookie suit.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { decideAccess, isPublicPath } from '@/lib/authRoutes';
import { hasUsers, SESSION_COOKIE, validateSession } from '@/lib/auth';
import { setSessionCookie } from '@/lib/authHttp';

export const config = {
  runtime: 'nodejs',
  // Les ressources de build ne passent même pas par le middleware.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const session = validateSession(req.cookies.get(SESSION_COOKIE)?.value);
  const decision = decideAccess({
    pathname,
    search,
    authenticated: !!session,
    // Avec une session valide, un compte existe forcément : pas de requête.
    hasUsers: session ? true : hasUsers(),
  });

  if (decision.kind === 'unauthorized') {
    return NextResponse.json({ error: 'non connecté' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const res = decision.kind === 'redirect' ? NextResponse.redirect(new URL(decision.location, req.url)) : NextResponse.next();
  // Renouvellement glissant : la session vient d'être prolongée, le cookie aussi.
  if (session?.renewed) setSessionCookie(res, req, req.cookies.get(SESSION_COOKIE)!.value, session.expiresAt);
  return res;
}
