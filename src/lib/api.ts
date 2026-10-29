import { NextResponse } from 'next/server';

export type RouteCtx<P> = { params: Promise<P> };

export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, { ...init, headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) } });
}

export function error(status: number, message: string) {
  return json({ error: message }, { status });
}

export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Origines autorisées à effectuer des écritures de calibration.
 *
 * Liste séparée par des virgules dans `SYNC_WRITE_ORIGINS` : on y met des
 * origines (`http://192.168.1.16:3000`) ou des IP (`192.168.1.16`).
 * Liste vide = aucune restriction (comportement par défaut d'une app
 * mono-utilisateur sur le LAN).
 */
export function allowedOrigins(): string[] {
  const raw = process.env.SYNC_WRITE_ORIGINS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Origine (ou adresse IP) de la requête.
 *
 * `Origin` est posé par les navigateurs pour les requêtes cross-origin et
 * pour les POST ; `Referer` sert de repli. Derrière un reverse proxy, le
 * premier `X-Forwarded-For` est l'adresse du client d'origine.
 */
export function requestOrigin(req: Request): string | null {
  const h = req.headers;
  const origin = h.get('origin');
  if (origin) {
    try {
      const u = new URL(origin);
      return u.host; // host:port
    } catch {
      return origin;
    }
  }
  const xff = h.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const referer = h.get('referer');
  if (referer) {
    try {
      return new URL(referer).host;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Vérifie qu'une requête vient d'une origine autorisée.
 * `allowed` vide = tout est accepté.
 */
export function isOriginAllowed(req: Request, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const o = requestOrigin(req);
  if (!o) return false;
  if (allowed.includes(o)) return true;
  // Autorise aussi l'IP seule quand l'origine est « ip:port ».
  const host = o.replace(/:\d+$/, '');
  return allowed.includes(host);
}
