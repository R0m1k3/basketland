/**
 * Règles d'accès par chemin, utilisées par le middleware (src/lib/middleware.ts,
 * gardé comme référence : le serveur Rust les applique désormais).
 * Fonctions pures, sans base ni Next : testées directement.
 *
 * Tout est protégé par défaut. Restent publics :
 * - /login, /setup et leurs routes d'API ;
 * - /api/health (healthcheck Docker) ;
 * - /api/ingest, qui a sa propre authentification par jeton (INGEST_TOKEN) ;
 * - /api/internal/replays et /api/internal/page-state, appelés par le serveur
 *   Rust seul, avec le même jeton (le serveur Rust ne relaie jamais
 *   /api/internal/… depuis l'extérieur) ;
 * - les fichiers internes et statiques de Next (/_next/…), les icônes et
 *   fichiers posés à la racine (favicon.ico, robots.txt, icon.svg…).
 */

export const LOGIN_PATH = '/login';
export const SETUP_PATH = '/setup';

const PUBLIC_EXACT = new Set([
  '/api/health',
  '/api/ingest',
  '/api/internal/replays',
  '/api/internal/page-state',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
]);

/** Ressources internes de Next (build, polices, HMR et overlay en développement). */
const PUBLIC_PREFIXES = ['/_next/', '/__nextjs'];

/**
 * Fichier statique à la racine (dossier public/, icônes de l'app). Limité à la
 * racine et à des extensions de ressources : aucune page ni route d'API n'a
 * cette forme.
 */
const ROOT_STATIC_RE = /^\/[^/]+\.(?:ico|png|jpe?g|gif|svg|webp|avif|txt|xml|webmanifest|woff2?)$/i;

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

export function isApiPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === '/api' || p.startsWith('/api/');
}

/** Chemin accessible sans session (ni redirection vers /setup). */
export function isPublicPath(pathname: string): boolean {
  const p = normalize(pathname);
  return PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p.startsWith(x)) || ROOT_STATIC_RE.test(p);
}

/**
 * Destination après connexion (`?next=`) : uniquement un chemin relatif du
 * même site. Tout le reste (URL absolue, `//hôte`, antislash, caractères de
 * contrôle, pages d'authentification, API) renvoie vers l'accueil.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\') || /[\x00-\x1f\x7f]/.test(raw)) return '/';
  const base = 'http://basketland.invalid';
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return '/';
  }
  if (u.origin !== base) return '/';
  const path = normalize(u.pathname);
  if (path === LOGIN_PATH || path === SETUP_PATH || isApiPath(path)) return '/';
  return u.pathname + u.search + u.hash;
}

export type AccessDecision = { kind: 'allow' } | { kind: 'redirect'; location: string } | { kind: 'unauthorized' };

export interface AccessInput {
  pathname: string;
  /** Chaîne de requête, avec ou sans « ? ». */
  search: string;
  /** Session valide présente. */
  authenticated: boolean;
  /** Au moins un compte existe (sinon : configuration initiale). */
  hasUsers: boolean;
}

const allow: AccessDecision = { kind: 'allow' };
const redirect = (location: string): AccessDecision => ({ kind: 'redirect', location });

/**
 * Décision d'accès pour une requête.
 * - page protégée sans session → /login?next=… (ou /setup s'il n'y a aucun compte) ;
 * - API protégée sans session → 401 JSON ;
 * - /setup une fois un compte créé → /login (ou l'accueil si connecté) ;
 * - /login sans aucun compte → /setup ; déjà connecté → destination `next`.
 */
export function decideAccess({ pathname, search, authenticated, hasUsers }: AccessInput): AccessDecision {
  const path = normalize(pathname);
  if (isPublicPath(path)) return allow;
  const params = new URLSearchParams(search);
  if (path === SETUP_PATH) return hasUsers ? redirect(authenticated ? '/' : LOGIN_PATH) : allow;
  if (path === LOGIN_PATH) {
    if (!hasUsers) return redirect(SETUP_PATH);
    return authenticated ? redirect(safeNextPath(params.get('next'))) : allow;
  }
  if (authenticated) return allow;
  if (isApiPath(path)) return { kind: 'unauthorized' };
  if (!hasUsers) return redirect(SETUP_PATH);
  // `_rsc` n'est qu'un paramètre anti-cache des navigations client de Next.
  params.delete('_rsc');
  const qs = params.toString();
  const target = path + (qs ? `?${qs}` : '');
  return redirect(target === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`);
}
