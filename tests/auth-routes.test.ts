import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { NextRequest } from 'next/server';
import * as db from '../src/lib/db';
import { __resetLoginAttempts, createSession, hashPassword, validateSession, verifyPassword } from '../src/lib/auth';
import { POST as setupPost } from '../src/app/api/auth/setup/route';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { POST as logoutPost } from '../src/app/api/auth/logout/route';
import { POST as passwordPost } from '../src/app/api/account/password/route';
import { GET as usersGet, POST as usersPost } from '../src/app/api/admin/users/route';
import { GET as settingsGet, POST as settingsPost } from '../src/app/api/admin/settings/route';
import { middleware } from '../src/middleware';
import { freshDb } from './helpers/db';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const BASE = 'http://nas.local:3012';
const SAME_ORIGIN = { origin: BASE, host: 'nas.local:3012' };

function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...SAME_ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const get = (p: string, headers: Record<string, string> = {}) => new Request(BASE + p, { headers });
const cookie = (token: string) => ({ cookie: `bl_session=${token}` });

async function userWithSession(username: string, role: 'admin' | 'user', password = 'motdepasse') {
  const id = db.insertUser(username, await hashPassword(password), role);
  return { id, token: createSession(id).token };
}

beforeEach(() => {
  freshDb();
  __resetLoginAttempts();
  delete process.env.SYNC_WRITE_ORIGINS;
});

describe('POST /api/auth/setup', () => {
  it('crée l’administrateur, pose le cookie de session, puis refuse', async () => {
    const res = await setupPost(post('/api/auth/setup', { username: 'Admin', password: 'motdepasse', confirm: 'motdepasse' }));
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^bl_session=[A-Za-z0-9_-]{43};/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).not.toMatch(/Secure/i); // HTTP simple sur le LAN
    const again = await setupPost(post('/api/auth/setup', { username: 'x2x', password: 'motdepasse', confirm: 'motdepasse' }));
    expect(again.status).toBe(403);
  });

  it('cookie Secure derrière un proxy HTTPS (X-Forwarded-Proto)', async () => {
    const res = await setupPost(
      post('/api/auth/setup', { username: 'admin', password: 'motdepasse', confirm: 'motdepasse' }, { 'x-forwarded-proto': 'https' }),
    );
    expect(res.headers.get('set-cookie')).toMatch(/Secure/i);
  });

  it('origine étrangère, Content-Type non JSON : refusés', async () => {
    const body = { username: 'admin', password: 'motdepasse', confirm: 'motdepasse' };
    expect((await setupPost(post('/api/auth/setup', body, { origin: 'http://evil.example' }))).status).toBe(403);
    expect((await setupPost(post('/api/auth/setup', JSON.stringify(body), { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(db.countUsers()).toBe(0);
  });
});

describe('POST /api/auth/login et /logout', () => {
  beforeEach(async () => {
    db.insertUser('alice', await hashPassword('motdepasse'), 'user');
  });

  it('connexion : cookie + destination sûre ; déconnexion : session supprimée', async () => {
    const res = await loginPost(post('/api/auth/login', { username: 'alice', password: 'motdepasse', next: '//evil.example' }));
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe('/');
    const token = /bl_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1];
    expect(validateSession(token)).not.toBeNull();

    const out = await logoutPost(post('/api/auth/logout', {}, cookie(token)));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/bl_session=;.*Max-Age=0/i);
    expect(validateSession(token)).toBeNull();
  });

  it('échecs : message générique, puis 429 en français', async () => {
    const fail = await loginPost(post('/api/auth/login', { username: 'alice', password: 'mauvais1' }, { 'x-forwarded-for': '10.1.1.1' }));
    expect(fail.status).toBe(401);
    expect(await fail.json()).toEqual({ error: 'Identifiant ou mot de passe incorrect.' });
    for (let i = 0; i < 4; i++) await loginPost(post('/api/auth/login', { username: 'alice', password: 'mauvais1' }, { 'x-forwarded-for': '10.1.1.1' }));
    const blocked = await loginPost(post('/api/auth/login', { username: 'alice', password: 'motdepasse' }, { 'x-forwarded-for': '10.1.1.1' }));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/Trop de tentatives/);
  });
});

describe('gardes administrateur', () => {
  it('sans session : 401 ; simple utilisateur : 403 ; administrateur : 200', async () => {
    const admin = await userWithSession('admin', 'admin');
    const bob = await userWithSession('bob', 'user');
    expect((await usersGet(get('/api/admin/users'))).status).toBe(401);
    expect((await usersGet(get('/api/admin/users', cookie(bob.token)))).status).toBe(403);
    expect((await usersPost(post('/api/admin/users', { action: 'delete', id: admin.id }, cookie(bob.token)))).status).toBe(403);
    expect((await settingsGet(get('/api/admin/settings', cookie(bob.token)))).status).toBe(403);
    expect((await settingsPost(post('/api/admin/settings', { openaiApiKey: null }, cookie(bob.token)))).status).toBe(403);
    const list = await usersGet(get('/api/admin/users', cookie(admin.token)));
    expect(list.status).toBe(200);
    const { users } = await list.json();
    expect(users.map((u: { username: string }) => u.username)).toEqual(['admin', 'bob']);
    expect(JSON.stringify(users)).not.toContain('scrypt');
  });

  it('actions : création, rôle, réinitialisation, suppression, et dernier administrateur', async () => {
    const admin = await userWithSession('admin', 'admin');
    const c = cookie(admin.token);
    const created = await usersPost(post('/api/admin/users', { action: 'create', username: 'Bob', password: 'motdepasse', role: 'user' }, c));
    expect(created.status).toBe(201);
    const bobId = (await created.json()).id as number;
    const bobSession = createSession(bobId);

    expect((await usersPost(post('/api/admin/users', { action: 'set-role', id: admin.id, role: 'user' }, c))).status).toBe(400);
    expect((await usersPost(post('/api/admin/users', { action: 'delete', id: admin.id }, c))).status).toBe(400);
    expect((await usersPost(post('/api/admin/users', { action: 'reset-password', id: bobId, password: 'nouveaumdp' }, c))).status).toBe(200);
    expect(validateSession(bobSession.token)).toBeNull();
    expect(await verifyPassword('nouveaumdp', db.getUserById(bobId)!.password_hash)).toBe(true);
    expect((await usersPost(post('/api/admin/users', { action: 'set-role', id: bobId, role: 'admin' }, c))).status).toBe(200);
    expect((await usersPost(post('/api/admin/users', { action: 'delete', id: bobId }, c))).status).toBe(200);
    expect(db.getUserById(bobId)).toBeUndefined();
    expect((await usersPost(post('/api/admin/users', { action: 'explode', id: 1 }, c))).status).toBe(400);
  });

  it('changement de son mot de passe (route)', async () => {
    const bob = await userWithSession('bob', 'user');
    expect((await passwordPost(post('/api/account/password', { current: 'motdepasse', password: 'nouveaumdp', confirm: 'nouveaumdp' }))).status).toBe(401);
    const res = await passwordPost(post('/api/account/password', { current: 'motdepasse', password: 'nouveaumdp', confirm: 'nouveaumdp' }, cookie(bob.token)));
    expect(res.status).toBe(200);
    expect(validateSession(bob.token)).not.toBeNull();
  });
});

describe('paramètres OpenAI (route)', () => {
  it('la clé n’est jamais renvoyée en entier', async () => {
    const admin = await userWithSession('admin', 'admin');
    const c = cookie(admin.token);
    const key = 'sk-proj-SECRETSECRETSECRETSECRET-abcd';
    const saved = await settingsPost(post('/api/admin/settings', { openaiApiKey: `  ${key} `, openaiModel: 'gpt-5.4-mini' }, c));
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text).openai).toEqual({ keySet: true, keyMasked: 'sk-…abcd', model: 'gpt-5.4-mini' });
    expect(db.settingGet('openai_api_key')).toBe(key);

    const read = await (await settingsGet(get('/api/admin/settings', c))).text();
    expect(read).not.toContain('SECRET');

    // Modèle seul : la clé reste en place.
    await settingsPost(post('/api/admin/settings', { openaiModel: '' }, c));
    expect(db.settingGet('openai_api_key')).toBe(key);
    expect(db.settingGet('openai_model')).toBeNull();

    expect((await settingsPost(post('/api/admin/settings', { openaiApiKey: 'trop court' }, c))).status).toBe(400);
    const del = await settingsPost(post('/api/admin/settings', { openaiApiKey: null }, c));
    expect((await del.json()).openai).toEqual({ keySet: false, keyMasked: null, model: null });
  });
});

describe('middleware', () => {
  const mw = (p: string, headers: Record<string, string> = {}) => middleware(new NextRequest(BASE + p, { headers }));

  it('premier démarrage : pages → /setup, API → 401, health public', () => {
    expect(mw('/matchs').headers.get('location')).toBe(`${BASE}/setup`);
    expect(mw('/api/matches').status).toBe(401);
    expect(mw('/api/health').headers.get('x-middleware-next')).toBe('1');
    expect(mw('/setup').headers.get('x-middleware-next')).toBe('1');
  });

  it('sans session : redirection vers /login?next=… ; avec session : accès', async () => {
    const { token } = await userWithSession('alice', 'user');
    const r = mw('/matchs/42');
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe(`${BASE}/login?next=%2Fmatchs%2F42`);
    const api = mw('/api/video/123/master.m3u8');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'non connecté' });
    expect(mw('/api/ingest').headers.get('x-middleware-next')).toBe('1');
    expect(mw('/matchs/42', cookie(token)).headers.get('x-middleware-next')).toBe('1');
    expect(mw('/api/video/123/master.m3u8', cookie(token)).headers.get('x-middleware-next')).toBe('1');
    expect(mw('/setup', cookie(token)).headers.get('location')).toBe(`${BASE}/`);
    expect(mw('/matchs', { cookie: 'bl_session=faux' }).status).toBe(307);
  });

  it('renouvellement glissant : cookie réémis quand la session est prolongée', async () => {
    const id = db.insertUser('alice', 'x', 'user');
    const old = createSession(id, Date.now() - 5 * 24 * 3600_000);
    const res = mw('/', cookie(old.token));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^bl_session=${old.token};`));
    const fresh = createSession(id);
    expect(mw('/', cookie(fresh.token)).headers.get('set-cookie')).toBeNull();
  });
});

describe('scripts/reset-password.mjs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-reset-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'basketland.db');
  const script = path.join(__dirname, '..', 'scripts', 'reset-password.mjs');
  const runScript = (...args: string[]) =>
    spawnSync(process.execPath, ['--no-warnings', script, ...args], { env: { ...process.env, DB_PATH: dbFile }, encoding: 'utf8' });

  it('crée un administrateur, puis change son mot de passe et ferme ses sessions', async () => {
    const created = runScript('Secours', 'motdepasse1');
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toContain('Compte administrateur « secours » créé.');

    // Même base ouverte par l'application : le format d'empreinte est compatible.
    const conn = db.openDatabase(dbFile);
    db.setDbForTests(conn);
    const u = db.getUserByUsername('secours')!;
    expect(u.role).toBe('admin');
    expect(await verifyPassword('motdepasse1', u.password_hash)).toBe(true);
    const s = createSession(u.id);

    const reset = runScript('secours', 'autremdp22');
    expect(reset.status, reset.stderr).toBe(0);
    expect(reset.stdout).toContain('1 session(s) fermée(s)');
    expect(await verifyPassword('autremdp22', db.getUserByUsername('secours')!.password_hash)).toBe(true);
    expect(validateSession(s.token)).toBeNull();
    conn.close();
    db.setDbForTests(undefined);

    expect(runScript('x', 'motdepasse1').status).toBe(1);
    expect(runScript('secours', 'court').status).toBe(1);
    expect(runScript().status).toBe(2);
    // La base reste lisible par un client SQLite quelconque.
    const raw = new DatabaseSync(dbFile);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    raw.close();
  });
});
