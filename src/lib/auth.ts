/**
 * Authentification : mots de passe, sessions, comptes et règles d'administration.
 *
 * - Mots de passe : scrypt (node:crypto) avec sel aléatoire par utilisateur,
 *   format `scrypt$N$r$p$sel$empreinte` (base64) — le même que celui écrit par
 *   scripts/reset-password.mjs. Comparaison en temps constant.
 * - Sessions : jeton aléatoire de 32 octets dans un cookie httpOnly ; la base
 *   ne garde que son SHA-256. Durée 30 jours, prolongée au plus une fois par
 *   jour tant que la session sert (renouvellement glissant).
 * - Tentatives de connexion : limitation en mémoire par IP et par
 *   identifiant (5 échecs → 1 minute d'attente).
 *
 * Aucune dépendance à Next : utilisable par le middleware, les routes et les tests.
 */
import crypto from 'node:crypto';
import {
  countAdmins,
  countUsers,
  deleteSession,
  deleteUserRow,
  deleteUserSessions,
  extendSession,
  getSessionWithUser,
  getUserById,
  getUserByUsername,
  insertFirstAdmin,
  insertSession,
  insertUser,
  touchUserLogin,
  updateUserPassword,
  updateUserRole,
  type UserRole,
} from './db';

// ---------------------------------------------------------------- constantes

export const SESSION_COOKIE = 'bl_session';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** La date d'expiration n'est réécrite qu'une fois par jour au plus. */
export const SESSION_RENEW_AFTER_MS = 24 * 3600_000;

export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

/** Paramètres scrypt : N = 2^15 (32 Mio de mémoire, ~100 ms), r = 8, p = 1. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 64, saltLen: 16 };

export const MSG = {
  badCredentials: 'Identifiant ou mot de passe incorrect.',
  badUsername: 'Identifiant invalide : 3 à 32 caractères parmi a-z, 0-9, point, tiret et tiret bas.',
  shortPassword: `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`,
  longPassword: `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX} caractères.`,
  mismatch: 'Les mots de passe ne correspondent pas.',
  usernameTaken: 'Cet identifiant est déjà utilisé.',
  setupDone: 'Le compte administrateur existe déjà.',
  userNotFound: 'Utilisateur introuvable.',
  badRole: 'Rôle invalide.',
  deleteSelf: 'Vous ne pouvez pas supprimer votre propre compte.',
  deleteLastAdmin: 'Impossible de supprimer le dernier administrateur.',
  demoteLastAdmin: 'Impossible de retirer le rôle administrateur au dernier administrateur.',
  badCurrentPassword: 'Mot de passe actuel incorrect.',
} as const;

/** Résultat d'une opération : succès avec données, ou erreur HTTP + message français. */
export type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
}

// ---------------------------------------------------------------- validation

/** Identifiant normalisé (espaces retirés, minuscules), ou null s'il est invalide. */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(u) ? u : null;
}

export function passwordError(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return MSG.shortPassword;
  if (pw.length > PASSWORD_MAX) return MSG.longPassword;
  return null;
}

export function isRole(v: unknown): v is UserRole {
  return v === 'admin' || v === 'user';
}

// ---------------------------------------------------------------- mots de passe

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem : la valeur par défaut (32 Mio) est juste en dessous de ce que
    // demande N = 2^15, r = 8 (128·N·r = 32 Mio + marge).
    crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT.saltLen);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Vérifie un mot de passe contre une empreinte stockée (temps constant). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  // Bornes : une empreinte corrompue ne doit pas déclencher un calcul démesuré.
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if (!salt.length || expected.length < 16 || expected.length > 128) return false;
  try {
    const got = await scrypt(password, salt, N, r, p, expected.length);
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

/**
 * Empreinte factice, calculée une fois : vérifiée quand l'identifiant
 * n'existe pas, pour que la réponse prenne le même temps que pour un
 * identifiant connu (pas d'énumération des comptes par chronométrage).
 */
let dummyHash: Promise<string> | null = null;
function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash.then((h) => verifyPassword(password, h)).then(() => false);
}

// ---------------------------------------------------------------- sessions

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface NewSession {
  token: string;
  expiresAt: string;
}

export function createSession(userId: number, now = Date.now()): NewSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  insertSession(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

export interface SessionInfo {
  user: SessionUser;
  tokenHash: string;
  expiresAt: string;
  /** La date d'expiration vient d'être repoussée : le cookie doit être réémis. */
  renewed: boolean;
}

/**
 * Valide un jeton de session. Une session expirée est supprimée.
 * `renew` (par défaut) repousse l'expiration si le dernier renouvellement
 * date de plus d'un jour ; les composants serveur, qui ne peuvent pas poser
 * de cookie, passent `renew: false`.
 */
export function validateSession(
  token: string | null | undefined,
  opts: { now?: number; renew?: boolean } = {},
): SessionInfo | null {
  if (!token || token.length > 128) return null;
  const now = opts.now ?? Date.now();
  const tokenHash = hashToken(token);
  const s = getSessionWithUser(tokenHash);
  if (!s) return null;
  const exp = Date.parse(s.expires_at);
  if (!(exp > now)) {
    deleteSession(tokenHash);
    return null;
  }
  let expiresAt = s.expires_at;
  let renewed = false;
  if (opts.renew !== false && exp - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
    expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    extendSession(tokenHash, expiresAt);
    renewed = true;
  }
  return { user: { id: s.user_id, username: s.username, role: s.role }, tokenHash, expiresAt, renewed };
}

export function revokeSession(token: string | null | undefined): void {
  if (token) deleteSession(hashToken(token));
}

// ---------------------------------------------------------------- limitation des tentatives

const MAX_FAILURES = 5;
const BLOCK_MS = 60_000;
/** Les échecs plus anciens que cette fenêtre sont oubliés. */
const FAILURE_WINDOW_MS = 15 * 60_000;

interface Attempts {
  failures: number;
  first: number;
  blockedUntil: number;
}
const attempts = new Map<string, Attempts>();

/** Millisecondes d'attente restantes pour ces clés (0 = pas de blocage). */
function blockedFor(keys: string[], now: number): number {
  return Math.max(0, ...keys.map((k) => (attempts.get(k)?.blockedUntil ?? 0) - now));
}

function recordFailure(keys: string[], now: number): void {
  // Garde-fou mémoire : on purge les entrées périmées si la table grossit.
  if (attempts.size > 10_000) {
    for (const [k, a] of attempts) if (a.blockedUntil < now && now - a.first > FAILURE_WINDOW_MS) attempts.delete(k);
  }
  for (const k of keys) {
    let a = attempts.get(k);
    if (!a || now - a.first > FAILURE_WINDOW_MS) a = { failures: 0, first: now, blockedUntil: 0 };
    a.failures += 1;
    if (a.failures >= MAX_FAILURES) {
      a.blockedUntil = now + BLOCK_MS;
      a.failures = 0;
      a.first = now;
    }
    attempts.set(k, a);
  }
}

function clearFailures(keys: string[]): void {
  for (const k of keys) attempts.delete(k);
}

function tooManyAttempts(waitMs: number) {
  return fail(429, `Trop de tentatives. Réessayez dans ${Math.ceil(waitMs / 1000)} s.`);
}

/** Réservé aux tests. */
export function __resetLoginAttempts(): void {
  attempts.clear();
}

// ---------------------------------------------------------------- connexion et premier compte

export function hasUsers(): boolean {
  return countUsers() > 0;
}

export type LoginResult = Result<{ user: SessionUser; session: NewSession }>;

/**
 * Connexion. Le message d'échec est le même que l'identifiant existe ou non,
 * et le temps de réponse aussi (vérification factice).
 */
export async function login(rawUsername: unknown, password: unknown, ip: string, now = Date.now()): Promise<LoginResult> {
  const username = normalizeUsername(rawUsername);
  const keys = [`ip:${ip}`, `user:${username ?? String(rawUsername ?? '').slice(0, 64).toLowerCase()}`];
  const wait = blockedFor(keys, now);
  if (wait > 0) return tooManyAttempts(wait);
  const pw = typeof password === 'string' ? password.slice(0, PASSWORD_MAX + 1) : '';
  const user = username ? getUserByUsername(username) : undefined;
  const ok = user ? await verifyPassword(pw, user.password_hash) : await dummyVerify(pw);
  if (!user || !ok) {
    recordFailure(keys, now);
    return fail(401, MSG.badCredentials);
  }
  clearFailures(keys);
  touchUserLogin(user.id);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role }, session: createSession(user.id, now) };
}

/** Création du compte administrateur au premier démarrage (aucun utilisateur en base). */
export async function setupFirstAdmin(rawUsername: unknown, password: unknown, confirm: unknown): Promise<LoginResult> {
  if (hasUsers()) return fail(403, MSG.setupDone);
  const username = normalizeUsername(rawUsername);
  if (!username) return fail(400, MSG.badUsername);
  const pwErr = passwordError(password);
  if (pwErr) return fail(400, pwErr);
  if (password !== confirm) return fail(400, MSG.mismatch);
  const hash = await hashPassword(password as string);
  // Revérifié dans la transaction : deux formulaires envoyés en même temps
  // ne créent qu'un seul administrateur.
  const id = insertFirstAdmin(username, hash);
  if (id === null) return fail(403, MSG.setupDone);
  touchUserLogin(id);
  return { ok: true, user: { id, username, role: 'admin' }, session: createSession(id) };
}

// ---------------------------------------------------------------- compte courant

/** Changement de son propre mot de passe ; les autres sessions de l'utilisateur sont révoquées. */
export async function changeOwnPassword(
  session: Pick<SessionInfo, 'user' | 'tokenHash'>,
  current: unknown,
  next: unknown,
  confirm: unknown,
  now = Date.now(),
): Promise<Result> {
  const keys = [`pw:${session.user.id}`];
  const wait = blockedFor(keys, now);
  if (wait > 0) return tooManyAttempts(wait);
  const user = getUserById(session.user.id);
  if (!user) return fail(404, MSG.userNotFound);
  if (typeof current !== 'string' || !(await verifyPassword(current.slice(0, PASSWORD_MAX + 1), user.password_hash))) {
    recordFailure(keys, now);
    return fail(400, MSG.badCurrentPassword);
  }
  clearFailures(keys);
  const pwErr = passwordError(next);
  if (pwErr) return fail(400, pwErr);
  if (next !== confirm) return fail(400, MSG.mismatch);
  updateUserPassword(user.id, await hashPassword(next as string));
  deleteUserSessions(user.id, session.tokenHash);
  return { ok: true };
}

// ---------------------------------------------------------------- administration des comptes

export async function createUser(rawUsername: unknown, password: unknown, role: unknown): Promise<Result<{ id: number }>> {
  const username = normalizeUsername(rawUsername);
  if (!username) return fail(400, MSG.badUsername);
  const pwErr = passwordError(password);
  if (pwErr) return fail(400, pwErr);
  if (!isRole(role)) return fail(400, MSG.badRole);
  if (getUserByUsername(username)) return fail(409, MSG.usernameTaken);
  const hash = await hashPassword(password as string);
  // Revérifié après le hachage (asynchrone) : une création concurrente du
  // même identifiant ferait sinon échouer l'INSERT sur la contrainte UNIQUE.
  if (getUserByUsername(username)) return fail(409, MSG.usernameTaken);
  return { ok: true, id: insertUser(username, hash, role) };
}

export function deleteUser(actor: SessionUser, targetId: number): Result {
  const target = getUserById(targetId);
  if (!target) return fail(404, MSG.userNotFound);
  if (target.id === actor.id) return fail(400, MSG.deleteSelf);
  if (target.role === 'admin' && countAdmins() <= 1) return fail(400, MSG.deleteLastAdmin);
  deleteUserRow(target.id);
  return { ok: true };
}

/**
 * Réinitialisation du mot de passe d'un compte par un administrateur : toutes
 * les sessions du compte sont révoquées (sauf celle de l'administrateur s'il
 * réinitialise son propre compte).
 */
export async function resetUserPassword(actor: Pick<SessionInfo, 'user' | 'tokenHash'>, targetId: number, password: unknown): Promise<Result> {
  const target = getUserById(targetId);
  if (!target) return fail(404, MSG.userNotFound);
  const pwErr = passwordError(password);
  if (pwErr) return fail(400, pwErr);
  updateUserPassword(target.id, await hashPassword(password as string));
  deleteUserSessions(target.id, target.id === actor.user.id ? actor.tokenHash : undefined);
  return { ok: true };
}

export function setUserRole(targetId: number, role: unknown): Result {
  if (!isRole(role)) return fail(400, MSG.badRole);
  const target = getUserById(targetId);
  if (!target) return fail(404, MSG.userNotFound);
  if (target.role === 'admin' && role === 'user' && countAdmins() <= 1) return fail(400, MSG.demoteLastAdmin);
  updateUserRole(target.id, role);
  return { ok: true };
}
