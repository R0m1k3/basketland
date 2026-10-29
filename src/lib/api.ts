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
/**
 * Origines autorisées à écrire.
 *
 * Chaque entrée peut être :
 *  - une origine complète (`http://nas.local:3000`) ;
 *  - un simple hôte (`nas.local:3000` ou `nas.local`) ;
 *  - une IP (`192.168.1.16`).
 *
 * Les deux formes sont normalisées en `hôte` et `hôte:port` pour que
 * l'exemple du README (`http://nas.local:3000`) fonctionne réellement : la
 * comparaison se faisait auparavant sur `host` (avec port) alors que la
 * configuration documente une URL complète.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.SYNC_WRITE_ORIGINS ?? '';
  const out: string[] = [];
  for (const s of raw.split(',')) {
    const v = s.trim();
    if (!v) continue;
    out.push(v);
    // Une URL complète contribue aussi son hôte nu (sans port) et son
    // hôte:port, pour absorber les deux formes d'écriture.
    if (/^https?:\/\//i.test(v)) {
      try {
        const u = new URL(v);
        out.push(u.host);
        out.push(u.hostname);
      } catch {
        /* on garde la valeur brute */
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Origine (ou adresse IP) de la requête.
 *
 * `Origin` est posé par les navigateurs pour les requêtes cross-origin et
 * pour les POST ; `Referer` sert de repli.
 *
 * `X-Forwarded-For` n'est PAS utilisé : cette en-tête est forgable par le
 * client, l'utiliser pour autoriser une écriture reviendrait à ne rien
 * contrôler du tout. Un proxy de confiance doit ajouter l'hôte d'origine
 * dans `SYNC_WRITE_ORIGINS` (variable d'environnement).
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
 *
 * Règle : l'origine de la requête doit être celle de l'hôte qui a servi la
 * page (en-tête `Host`), ou figurer dans la liste blanche.
 *
 * - La liste vide n'autorise PLUS tout : elle autorise la seule origine
 *   du serveur. Un site tiers envoie un `Origin` différent → refusé.
 *   C'est ce qui bloque le CSRF en configuration par défaut.
 * - `X-Forwarded-For` n'est PAS utilisé (forgeable par le client).
 */
export function isOriginAllowed(req: Request, allowed: string[]): boolean {
  const o = requestOrigin(req);
  // En-tête Host : l'hôte réellement servi (c'est l'origine de la page
  // pour le navigateur).
  const self = req.headers.get('host');
  if (self && o && o === self) return true;
  if (!o) {
    // Aucune origine : requête non navigateur (curl, job interne).
    // Elle est acceptée si la liste est vide, refusée sinon.
    return allowed.length === 0;
  }
  if (allowed.includes(o)) return true;
  // Autorise aussi l'IP seule quand l'origine est « ip:port ».
  const host = o.replace(/:\d+$/, '');
  return allowed.includes(host);
}
