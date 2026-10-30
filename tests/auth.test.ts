import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/lib/db';
import {
  __resetLoginAttempts,
  changeOwnPassword,
  createSession,
  createUser,
  deleteUser,
  hashPassword,
  hashToken,
  login,
  MSG,
  normalizeUsername,
  resetUserPassword,
  revokeSession,
  SESSION_TTL_MS,
  setupFirstAdmin,
  setUserRole,
  validateSession,
  verifyPassword,
} from '../src/lib/auth';
import { decideAccess, isPublicPath, safeNextPath } from '../src/lib/authRoutes';
import { getSetting, maskApiKey, openAiSettingsView, setSetting } from '../src/lib/settings';
import { freshDb } from './helpers/db';

const DAY = 24 * 3600_000;

beforeEach(() => {
  freshDb();
  __resetLoginAttempts();
});

describe('mots de passe (scrypt)', () => {
  it('hache avec un sel aléatoire et vérifie', async () => {
    const a = await hashPassword('motdepasse1');
    const b = await hashPassword('motdepasse1');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b); // sel différent
    expect(await verifyPassword('motdepasse1', a)).toBe(true);
    expect(await verifyPassword('motdepasse2', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('refuse une empreinte corrompue ou aux paramètres démesurés', async () => {
    expect(await verifyPassword('x', 'n-importe-quoi')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(await verifyPassword('x', `scrypt$${2 ** 30}$8$1$c2Fs$${'A'.repeat(88)}`)).toBe(false);
  });
});

describe('identifiants', () => {
  it('normalise (espaces, minuscules) et valide 3-32 caractères [a-z0-9._-]', () => {
    expect(normalizeUsername('  Romain.B ')).toBe('romain.b');
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('a'.repeat(33))).toBeNull();
    expect(normalizeUsername('jean dupont')).toBeNull();
    expect(normalizeUsername('éric')).toBeNull();
    expect(normalizeUsername(42)).toBeNull();
  });
});

describe('sessions', () => {
  it('crée un jeton de 32 octets et ne stocke que son SHA-256', () => {
    const id = db.insertUser('alice', 'x', 'user');
    const s = createSession(id);
    expect(Buffer.from(s.token, 'base64url')).toHaveLength(32);
    expect(db.getSessionWithUser(s.token)).toBeUndefined();
    expect(db.getSessionWithUser(hashToken(s.token))?.user_id).toBe(id);
    const v = validateSession(s.token);
    expect(v?.user).toEqual({ id, username: 'alice', role: 'user' });
    expect(v?.renewed).toBe(false);
  });

  it('refuse un jeton inconnu, vide ou démesuré', () => {
    expect(validateSession(undefined)).toBeNull();
    expect(validateSession('')).toBeNull();
    expect(validateSession('inconnu')).toBeNull();
    expect(validateSession('x'.repeat(500))).toBeNull();
  });

  it('expire au bout de 30 jours et supprime la session expirée', () => {
    const id = db.insertUser('alice', 'x', 'user');
    const t0 = Date.now();
    const s = createSession(id, t0);
    expect(validateSession(s.token, { now: t0 + SESSION_TTL_MS + 1000 })).toBeNull();
    expect(db.getSessionWithUser(hashToken(s.token))).toBeUndefined();
  });

  it('se prolonge (renouvellement glissant) au plus une fois par jour', () => {
    const id = db.insertUser('alice', 'x', 'user');
    const t0 = Date.now();
    const s = createSession(id, t0);
    expect(validateSession(s.token, { now: t0 + DAY / 2 })?.renewed).toBe(false);
    const later = t0 + 10 * DAY;
    const v = validateSession(s.token, { now: later });
    expect(v?.renewed).toBe(true);
    expect(Date.parse(v!.expiresAt)).toBe(later + SESSION_TTL_MS);
    // Sans renouvellement (composants serveur) : rien n'est écrit.
    const s2 = createSession(id, t0);
    expect(validateSession(s2.token, { now: later, renew: false })?.renewed).toBe(false);
    expect(validateSession(s.token, { now: later + 25 * DAY })).not.toBeNull(); // aurait expiré sans prolongation
  });

  it('révocation', () => {
    const id = db.insertUser('alice', 'x', 'user');
    const s = createSession(id);
    revokeSession(s.token);
    expect(validateSession(s.token)).toBeNull();
  });
});

describe('premier démarrage', () => {
  it("crée l'administrateur seulement s'il n'existe aucun compte", async () => {
    const r = await setupFirstAdmin(' Admin ', 'motdepasse', 'motdepasse');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(validateSession(r.session.token)?.user.username).toBe('admin');
    const again = await setupFirstAdmin('autre', 'motdepasse', 'motdepasse');
    expect(again).toEqual({ ok: false, status: 403, error: MSG.setupDone });
    expect(db.countUsers()).toBe(1);
  });

  it('valide identifiant, longueur et confirmation', async () => {
    expect(await setupFirstAdmin('a', 'motdepasse', 'motdepasse')).toMatchObject({ ok: false, status: 400, error: MSG.badUsername });
    expect(await setupFirstAdmin('admin', 'court', 'court')).toMatchObject({ ok: false, error: MSG.shortPassword });
    expect(await setupFirstAdmin('admin', 'motdepasse', 'autrechose')).toMatchObject({ ok: false, error: MSG.mismatch });
    expect(db.countUsers()).toBe(0);
  });
});

describe('connexion', () => {
  beforeEach(async () => {
    db.insertUser('alice', await hashPassword('motdepasse'), 'user');
  });

  it('succès : session créée, dernière connexion notée, identifiant insensible à la casse', async () => {
    const r = await login('  ALICE ', 'motdepasse', '10.0.0.1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateSession(r.session.token)?.user.username).toBe('alice');
    expect(db.getUserByUsername('alice')?.last_login_at).toBeTruthy();
  });

  it("échec : même message que le compte existe ou non (pas d'énumération)", async () => {
    const wrong = await login('alice', 'mauvais!!', '10.0.0.1');
    const unknown = await login('bob', 'mauvais!!', '10.0.0.2');
    const invalid = await login('é', 'mauvais!!', '10.0.0.3');
    for (const r of [wrong, unknown, invalid]) expect(r).toEqual({ ok: false, status: 401, error: MSG.badCredentials });
  });

  it('5 échecs → 1 minute de blocage (par identifiant et par IP), même avec le bon mot de passe', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect((await login('alice', `faux${i}xxxx`, '10.0.0.1', t0)).ok).toBe(false);
    const blocked = await login('alice', 'motdepasse', '10.0.0.9', t0 + 1000);
    expect(blocked).toMatchObject({ ok: false, status: 429 });
    expect(!blocked.ok && blocked.error).toMatch(/^Trop de tentatives\. Réessayez dans \d+ s\.$/);
    // L'IP fautive est bloquée aussi, quel que soit l'identifiant.
    expect(await login('bob', 'x', '10.0.0.1', t0 + 1000)).toMatchObject({ status: 429 });
    // Après la minute d'attente, la connexion passe.
    expect((await login('alice', 'motdepasse', '10.0.0.9', t0 + 61_000)).ok).toBe(true);
  });
});

describe('administration des comptes', () => {
  let admin: { id: number; username: string; role: 'admin' };
  beforeEach(async () => {
    const id = db.insertUser('admin', await hashPassword('motdepasse'), 'admin');
    admin = { id, username: 'admin', role: 'admin' };
  });

  it('crée un compte (identifiant unique, rôle valide)', async () => {
    expect(await createUser('Bob', 'motdepasse', 'user')).toMatchObject({ ok: true });
    expect(await createUser('bob', 'motdepasse', 'user')).toMatchObject({ ok: false, status: 409 });
    expect(await createUser('carl', 'motdepasse', 'root')).toMatchObject({ ok: false, error: MSG.badRole });
    expect(db.listUsers().map((u) => u.username)).toEqual(['admin', 'bob']);
    expect(Object.keys(db.listUsers()[0])).not.toContain('password_hash');
  });

  it('ne supprime ni soi-même ni le dernier administrateur ; la suppression ferme les sessions', async () => {
    expect(deleteUser(admin, admin.id)).toMatchObject({ ok: false, error: MSG.deleteSelf });
    const bob = db.insertUser('bob', 'x', 'user');
    const s = createSession(bob);
    expect(deleteUser(admin, bob)).toEqual({ ok: true });
    expect(validateSession(s.token)).toBeNull();
    // Dernier administrateur : seul un autre administrateur pourrait le supprimer,
    // et il n'y en a plus (cas d'un compte rétrogradé entre-temps).
    const other = db.insertUser('other', 'x', 'admin');
    db.updateUserRole(admin.id, 'user');
    expect(deleteUser(admin, other)).toMatchObject({ ok: false, error: MSG.deleteLastAdmin });
  });

  it('ne rétrograde pas le dernier administrateur', () => {
    expect(setUserRole(admin.id, 'user')).toMatchObject({ ok: false, error: MSG.demoteLastAdmin });
    const second = db.insertUser('second', 'x', 'admin');
    expect(setUserRole(admin.id, 'user')).toEqual({ ok: true });
    expect(setUserRole(second, 'user')).toMatchObject({ ok: false, error: MSG.demoteLastAdmin });
    expect(db.countAdmins()).toBe(1);
  });

  it('la réinitialisation du mot de passe ferme les sessions du compte', async () => {
    const bob = db.insertUser('bob', await hashPassword('ancienmdp'), 'user');
    const s = createSession(bob);
    const actor = { user: admin, tokenHash: 'x' };
    expect(await resetUserPassword(actor, bob, 'court')).toMatchObject({ ok: false, error: MSG.shortPassword });
    expect(await resetUserPassword(actor, bob, 'nouveaumdp')).toEqual({ ok: true });
    expect(validateSession(s.token)).toBeNull();
    expect((await login('bob', 'nouveaumdp', '1.1.1.1')).ok).toBe(true);
  });

  it('changement de son mot de passe : mot de passe actuel exigé, autres sessions fermées', async () => {
    const current = createSession(admin.id);
    const other = createSession(admin.id);
    const sess = validateSession(current.token)!;
    expect(await changeOwnPassword(sess, 'faux', 'nouveaumdp', 'nouveaumdp')).toMatchObject({ ok: false, error: MSG.badCurrentPassword });
    expect(await changeOwnPassword(sess, 'motdepasse', 'nouveaumdp', 'autre')).toMatchObject({ ok: false, error: MSG.mismatch });
    expect(await changeOwnPassword(sess, 'motdepasse', 'nouveaumdp', 'nouveaumdp')).toEqual({ ok: true });
    expect(validateSession(current.token)).not.toBeNull();
    expect(validateSession(other.token)).toBeNull();
  });
});

describe("règles d'accès par chemin", () => {
  const d = (pathname: string, authenticated: boolean, hasUsers = true, search = '') =>
    decideAccess({ pathname, search, authenticated, hasUsers });

  it('chemins publics', () => {
    for (const p of ['/api/health', '/api/ingest', '/api/auth/login', '/api/auth/setup', '/api/auth/logout', '/_next/static/x.js', '/favicon.ico', '/robots.txt', '/icon.svg'])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ['/', '/matchs', '/api/matches', '/api/video/123/master.m3u8', '/api/healthz', '/api/health/x', '/api/matches/1/subtitles.vtt', '/parametres', '/api/admin/users'])
      expect(isPublicPath(p), p).toBe(false);
  });

  it('page protégée → /login?next=… ; API protégée → 401', () => {
    expect(d('/matchs/42', false, true, '?t=1')).toEqual({ kind: 'redirect', location: '/login?next=%2Fmatchs%2F42%3Ft%3D1' });
    expect(d('/', false)).toEqual({ kind: 'redirect', location: '/login' });
    expect(d('/api/matches', false)).toEqual({ kind: 'unauthorized' });
    expect(d('/api/video/1/segment.ts', false)).toEqual({ kind: 'unauthorized' });
    expect(d('/api/health', false)).toEqual({ kind: 'allow' });
    expect(d('/matchs', true)).toEqual({ kind: 'allow' });
    expect(d('/api/video/1/segment.ts', true)).toEqual({ kind: 'allow' });
    // Le paramètre anti-cache des navigations client n'est pas repris dans `next`.
    expect(d('/equipes', false, true, '?_rsc=abc')).toEqual({ kind: 'redirect', location: '/login?next=%2Fequipes' });
  });

  it('sans aucun compte : tout mène à /setup (API : 401)', () => {
    expect(d('/', false, false)).toEqual({ kind: 'redirect', location: '/setup' });
    expect(d('/login', false, false)).toEqual({ kind: 'redirect', location: '/setup' });
    expect(d('/setup', false, false)).toEqual({ kind: 'allow' });
    expect(d('/api/matches', false, false)).toEqual({ kind: 'unauthorized' });
  });

  it('/setup inaccessible dès qu’un compte existe ; /login quand on est déjà connecté', () => {
    expect(d('/setup', false)).toEqual({ kind: 'redirect', location: '/login' });
    expect(d('/setup', true)).toEqual({ kind: 'redirect', location: '/' });
    expect(d('/login', false)).toEqual({ kind: 'allow' });
    expect(d('/login', true, true, '?next=%2Fclassement')).toEqual({ kind: 'redirect', location: '/classement' });
  });

  it('`next` : seulement des chemins relatifs du même site', () => {
    expect(safeNextPath('/matchs/1?x=2#pbp')).toBe('/matchs/1?x=2#pbp');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', '/\tevil', '/login', '/setup?x', '/api/matches'])
      expect(safeNextPath(bad), String(bad)).toBe('/');
  });
});

describe('paramètres', () => {
  it('lecture, écriture, suppression', () => {
    expect(getSetting('openai_model')).toBeNull();
    setSetting('openai_model', 'gpt-5.4-mini');
    setSetting('openai_model', 'gpt-5.4');
    expect(getSetting('openai_model')).toBe('gpt-5.4');
    setSetting('openai_model', null);
    expect(getSetting('openai_model')).toBeNull();
  });

  it('la clé API n’est exposée que masquée', () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789WXYZ';
    expect(maskApiKey(key)).toBe('sk-…WXYZ');
    expect(maskApiKey('court')).toBe('••••');
    setSetting('openai_api_key', key);
    const view = openAiSettingsView();
    expect(view).toEqual({ keySet: true, keyMasked: 'sk-…WXYZ', model: null });
    expect(JSON.stringify(view)).not.toContain('abcdefghij');
  });
});
