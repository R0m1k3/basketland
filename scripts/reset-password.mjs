#!/usr/bin/env node
/**
 * Récupération d'accès : définit le mot de passe d'un compte BasketLand.
 *
 *   docker exec -it basketland node scripts/reset-password.mjs <identifiant> <nouveau-mot-de-passe>
 *
 * - Crée le compte (ADMINISTRATEUR) s'il n'existe pas.
 * - Ferme toutes ses sessions ouvertes.
 * - Même format d'empreinte que l'application (src/lib/auth.ts) :
 *   scrypt$N$r$p$sel$empreinte (base64).
 * - Même base que l'application : DB_PATH, sinon DATA_DIR (ou /data, ou
 *   ./data) + basketland.db (voir dataDir() dans src/lib/db.ts).
 *
 * JavaScript pur (node:sqlite + node:crypto) : aucune compilation nécessaire.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 64, saltLen: 16 };

function die(msg) {
  console.error(`Erreur : ${msg}`);
  process.exit(1);
}

const [rawUser, password] = process.argv.slice(2);
if (!rawUser || password === undefined) {
  console.error('Usage : node scripts/reset-password.mjs <identifiant> <nouveau-mot-de-passe>');
  process.exit(2);
}

const username = rawUser.trim().toLowerCase();
if (!/^[a-z0-9._-]{3,32}$/.test(username)) die('identifiant invalide (3 à 32 caractères parmi a-z, 0-9, point, tiret, tiret bas).');
if (password.length < 8) die('le mot de passe doit contenir au moins 8 caractères.');
if (password.length > 200) die('le mot de passe ne doit pas dépasser 200 caractères.');

const dataDir = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
const dbFile = process.env.DB_PATH || path.join(dataDir, 'basketland.db');

// `docker exec` tourne en root par défaut, alors que l'application tourne en
// `node` : des fichiers -wal/-shm créés par root la bloqueraient. On prend
// donc l'identité du propriétaire de la base (ou de son dossier) avant de
// l'ouvrir.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const ref = fs.existsSync(dbFile) ? dbFile : fs.existsSync(path.dirname(dbFile)) ? path.dirname(dbFile) : null;
  if (ref) {
    const st = fs.statSync(ref);
    if (st.uid !== 0) {
      process.setgid(st.gid);
      process.setuid(st.uid);
    }
  }
}

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
// Tables identiques à AUTH_SCHEMA_SQL (src/lib/db.ts) : le script doit
// marcher même sur une base jamais ouverte par l'application.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const salt = crypto.randomBytes(SCRYPT.saltLen);
const key = crypto.scryptSync(password, salt, SCRYPT.keyLen, {
  N: SCRYPT.N,
  r: SCRYPT.r,
  p: SCRYPT.p,
  maxmem: 256 * SCRYPT.N * SCRYPT.r,
});
const hash = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;

db.exec('BEGIN IMMEDIATE');
try {
  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    db.exec('COMMIT');
    console.log(`Mot de passe de « ${username} » (${existing.role === 'admin' ? 'administrateur' : 'utilisateur'}) mis à jour ; ${r.changes} session(s) fermée(s).`);
  } else {
    db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)").run(
      username,
      hash,
      new Date().toISOString(),
    );
    db.exec('COMMIT');
    console.log(`Compte administrateur « ${username} » créé.`);
  }
} catch (e) {
  db.exec('ROLLBACK');
  die(e instanceof Error ? e.message : String(e));
} finally {
  db.close();
}
console.log(`Base : ${dbFile}`);
