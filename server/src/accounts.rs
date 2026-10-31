//! Comptes : mots de passe (scrypt, même format que Node), connexion,
//! premier administrateur, changement de mot de passe et administration
//! des utilisateurs (équivalent de `src/lib/auth.ts`).

use crate::auth::{hash_token, SESSION_TTL_MS};
use crate::db::{col_int, col_text};
use crate::time::iso_utc;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const PASSWORD_MIN: usize = 8;
const PASSWORD_MAX: usize = 200;
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const KEY_LEN: usize = 64;
const SALT_LEN: usize = 16;

pub mod msg {
    pub const BAD_CREDENTIALS: &str = "Identifiant ou mot de passe incorrect.";
    pub const BAD_USERNAME: &str =
        "Identifiant invalide : 3 à 32 caractères parmi a-z, 0-9, point, tiret et tiret bas.";
    pub const SHORT_PASSWORD: &str = "Le mot de passe doit contenir au moins 8 caractères.";
    pub const LONG_PASSWORD: &str = "Le mot de passe ne doit pas dépasser 200 caractères.";
    pub const MISMATCH: &str = "Les mots de passe ne correspondent pas.";
    pub const USERNAME_TAKEN: &str = "Cet identifiant est déjà utilisé.";
    pub const SETUP_DONE: &str = "Le compte administrateur existe déjà.";
    pub const USER_NOT_FOUND: &str = "Utilisateur introuvable.";
    pub const BAD_ROLE: &str = "Rôle invalide.";
    pub const DELETE_SELF: &str = "Vous ne pouvez pas supprimer votre propre compte.";
    pub const DELETE_LAST_ADMIN: &str = "Impossible de supprimer le dernier administrateur.";
    pub const DEMOTE_LAST_ADMIN: &str =
        "Impossible de retirer le rôle administrateur au dernier administrateur.";
    pub const BAD_CURRENT_PASSWORD: &str = "Mot de passe actuel incorrect.";
}

/// Échec : statut HTTP et message.
pub type Fail = (u16, String);
fn fail<T>(status: u16, m: &str) -> Result<T, Fail> {
    Err((status, m.to_string()))
}

// ---------------------------------------------------------------- validation

/// `.length` de JavaScript (unités UTF-16).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `.slice(0, n)` de JavaScript (unités UTF-16 ; une paire coupée devient U+FFFD).
pub fn js_slice(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Identifiant normalisé (espaces retirés, minuscules), ou `None` s'il est invalide.
pub fn normalize_username(raw: Option<&Value>) -> Option<String> {
    let u = js_trim(raw?.as_str()?).to_lowercase();
    let ok = (3..=32).contains(&u.len())
        && u.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b));
    ok.then_some(u)
}

pub fn password_error(pw: Option<&Value>) -> Option<&'static str> {
    match pw.and_then(Value::as_str) {
        Some(p) if js_len(p) >= PASSWORD_MIN => {
            (js_len(p) > PASSWORD_MAX).then_some(msg::LONG_PASSWORD)
        }
        _ => Some(msg::SHORT_PASSWORD),
    }
}

fn is_role(v: Option<&Value>) -> Option<&'static str> {
    match v.and_then(Value::as_str) {
        Some("admin") => Some("admin"),
        Some("user") => Some("user"),
        _ => None,
    }
}

// ---------------------------------------------------------------- mots de passe

/// `scrypt$N$r$p$sel$empreinte` (base64), comme `hashPassword` et scripts/reset-password.mjs.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let params =
        scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN).expect("paramètres scrypt");
    let mut key = [0u8; KEY_LEN];
    scrypt::scrypt(password.as_bytes(), &salt, &params, &mut key).expect("scrypt");
    format!(
        "scrypt${}${SCRYPT_R}${SCRYPT_P}${}${}",
        1u32 << SCRYPT_LOG_N,
        STANDARD.encode(salt),
        STANDARD.encode(key)
    )
}

/// `Buffer.from(x, 'base64')` : tolérant (remplissage absent, caractères hors alphabet ignorés).
fn b64_lenient(s: &str) -> Vec<u8> {
    let clean: String = s
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
        .collect();
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    // Longueur ≡ 1 (mod 4) : Node ignore le dernier caractère isolé.
    let trimmed = if clean.len() % 4 == 1 {
        &clean[..clean.len() - 1]
    } else {
        &clean[..]
    };
    engine.decode(trimmed).unwrap_or_default()
}

/// Vérifie un mot de passe contre une empreinte stockée (temps constant).
pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 6 || parts[0] != "scrypt" {
        return false;
    }
    let num = |s: &str| {
        let n = crate::api::js_number(s);
        (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
    };
    let (Some(n), Some(r), Some(p)) = (num(parts[1]), num(parts[2]), num(parts[3])) else {
        return false;
    };
    if !(2..=1 << 20).contains(&n)
        || !(1..=32).contains(&r)
        || !(1..=16).contains(&p)
        || !(n as u64).is_power_of_two()
    {
        return false;
    }
    let salt = b64_lenient(parts[4]);
    let expected = b64_lenient(parts[5]);
    if salt.is_empty() || expected.len() < 16 || expected.len() > 128 {
        return false;
    }
    let Ok(params) =
        scrypt::Params::new(n.trailing_zeros() as u8, r as u32, p as u32, expected.len())
    else {
        return false;
    };
    let mut got = vec![0u8; expected.len()];
    if scrypt::scrypt(password.as_bytes(), &salt, &params, &mut got).is_err() {
        return false;
    }
    subtle::ConstantTimeEq::ct_eq(got.as_slice(), expected.as_slice()).into()
}

/// Vérification factice (identifiant inconnu) : même temps de réponse.
fn dummy_verify(password: &str) -> bool {
    static H: OnceLock<String> = OnceLock::new();
    let h = H.get_or_init(|| {
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        hash_password(&hex::encode(b))
    });
    let _ = verify_password(password, h);
    false
}

// ---------------------------------------------------------------- limitation des tentatives

const MAX_FAILURES: u32 = 5;
const BLOCK_MS: i64 = 60_000;
const FAILURE_WINDOW_MS: i64 = 15 * 60_000;

#[derive(Clone, Copy)]
struct Attempts {
    failures: u32,
    first: i64,
    blocked_until: i64,
}

fn attempts() -> &'static Mutex<HashMap<String, Attempts>> {
    static A: OnceLock<Mutex<HashMap<String, Attempts>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

fn blocked_for(keys: &[String], now: i64) -> i64 {
    let a = attempts().lock().unwrap_or_else(|e| e.into_inner());
    keys.iter()
        .map(|k| a.get(k).map_or(0, |x| x.blocked_until) - now)
        .max()
        .unwrap_or(0)
        .max(0)
}

fn record_failure(keys: &[String], now: i64) {
    let mut a = attempts().lock().unwrap_or_else(|e| e.into_inner());
    if a.len() > 10_000 {
        a.retain(|_, x| !(x.blocked_until < now && now - x.first > FAILURE_WINDOW_MS));
    }
    for k in keys {
        let mut x = match a.get(k) {
            Some(x) if now - x.first <= FAILURE_WINDOW_MS => *x,
            _ => Attempts {
                failures: 0,
                first: now,
                blocked_until: 0,
            },
        };
        x.failures += 1;
        if x.failures >= MAX_FAILURES {
            x.blocked_until = now + BLOCK_MS;
            x.failures = 0;
            x.first = now;
        }
        a.insert(k.clone(), x);
    }
}

fn clear_failures(keys: &[String]) {
    let mut a = attempts().lock().unwrap_or_else(|e| e.into_inner());
    for k in keys {
        a.remove(k);
    }
}

fn too_many<T>(wait_ms: i64) -> Result<T, Fail> {
    Err((
        429,
        format!(
            "Trop de tentatives. Réessayez dans {} s.",
            (wait_ms + 999) / 1000
        ),
    ))
}

/// Réservé aux tests.
pub fn reset_attempts() {
    attempts().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

// ---------------------------------------------------------------- base

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
}

fn user_row(r: &rusqlite::Row) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: r.get("id")?,
        username: col_text(r, "username").unwrap_or_default(),
        password_hash: col_text(r, "password_hash").unwrap_or_default(),
        role: col_text(r, "role").unwrap_or_default(),
    })
}

pub fn user_by_name(c: &Connection, name: &str) -> rusqlite::Result<Option<UserRow>> {
    c.query_row("SELECT * FROM users WHERE username = ?1", [name], user_row)
        .optional()
}

pub fn user_by_id(c: &Connection, id: i64) -> rusqlite::Result<Option<UserRow>> {
    c.query_row("SELECT * FROM users WHERE id = ?1", [id], user_row)
        .optional()
}

pub fn count_users(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
}

fn count_admins(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT COUNT(*) FROM users WHERE role = 'admin'", [], |r| {
        r.get(0)
    })
}

/// `listUsers` : comptes sans empreinte, par identifiant.
pub fn list_users(c: &Connection) -> rusqlite::Result<Value> {
    let mut st = c.prepare(
        "SELECT id, username, role, created_at, last_login_at FROM users ORDER BY username",
    )?;
    let rows = st.query_map([], |r| {
        Ok(json!({
            "id": col_int(r, "id"),
            "username": col_text(r, "username"),
            "role": col_text(r, "role"),
            "created_at": col_text(r, "created_at"),
            "last_login_at": col_text(r, "last_login_at"),
        }))
    })?;
    Ok(Value::Array(rows.collect::<rusqlite::Result<Vec<_>>>()?))
}

fn now_iso() -> String {
    iso_utc(Utc::now())
}

fn insert_user(c: &Connection, name: &str, hash: &str, role: &str) -> rusqlite::Result<i64> {
    c.execute(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, hash, role, now_iso()],
    )?;
    Ok(c.last_insert_rowid())
}

fn touch_login(c: &Connection, id: i64) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE users SET last_login_at = ?1 WHERE id = ?2",
        params![now_iso(), id],
    )
    .map(|_| ())
}

fn delete_user_sessions(c: &Connection, user_id: i64, keep: Option<&str>) -> rusqlite::Result<()> {
    c.execute(
        "DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2",
        params![user_id, keep.unwrap_or("")],
    )
    .map(|_| ())
}

/// Nouvelle session (jeton aléatoire de 32 octets, base64url) ; ménage des sessions expirées.
pub struct NewSession {
    pub token: String,
    pub expires_at: String,
}

fn create_session(
    c: &Connection,
    user_id: i64,
    now: DateTime<Utc>,
) -> rusqlite::Result<NewSession> {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    let token = URL_SAFE_NO_PAD.encode(b);
    let expires_at = iso_utc(now + Duration::milliseconds(SESSION_TTL_MS));
    let n = now_iso();
    c.execute("DELETE FROM sessions WHERE expires_at <= ?1", [&n])?;
    c.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![hash_token(&token), user_id, n, expires_at],
    )?;
    Ok(NewSession { token, expires_at })
}

// ---------------------------------------------------------------- opérations

pub type DbFn<T> = Result<Result<T, Fail>, rusqlite::Error>;

pub struct LoggedIn {
    pub user: Value,
    pub session: NewSession,
}

/// Connexion : même message et même temps de réponse que l'identifiant existe ou non.
pub fn login(
    c: &Connection,
    raw_username: Option<&Value>,
    password: Option<&Value>,
    ip: &str,
) -> DbFn<LoggedIn> {
    let now_dt = Utc::now();
    let now = now_dt.timestamp_millis();
    let username = normalize_username(raw_username);
    let fallback = match raw_username {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_slice(&crate::jsval::js_string(v), 64).to_lowercase(),
    };
    let keys = vec![
        format!("ip:{ip}"),
        format!("user:{}", username.clone().unwrap_or(fallback)),
    ];
    let wait = blocked_for(&keys, now);
    if wait > 0 {
        return Ok(too_many(wait));
    }
    let pw = password
        .and_then(Value::as_str)
        .map(|p| js_slice(p, PASSWORD_MAX + 1))
        .unwrap_or_default();
    let user = match &username {
        Some(u) => user_by_name(c, u)?,
        None => None,
    };
    let ok = match &user {
        Some(u) => verify_password(&pw, &u.password_hash),
        None => dummy_verify(&pw),
    };
    let Some(user) = user.filter(|_| ok) else {
        record_failure(&keys, now);
        return Ok(fail(401, msg::BAD_CREDENTIALS));
    };
    clear_failures(&keys);
    touch_login(c, user.id)?;
    let session = create_session(c, user.id, now_dt)?;
    Ok(Ok(LoggedIn {
        user: json!({ "id": user.id, "username": user.username, "role": user.role }),
        session,
    }))
}

/// Premier administrateur (aucun compte en base), créé et connecté.
pub fn setup_first_admin(
    c: &Connection,
    raw: Option<&Value>,
    password: Option<&Value>,
    confirm: Option<&Value>,
) -> DbFn<LoggedIn> {
    if count_users(c)? > 0 {
        return Ok(fail(403, msg::SETUP_DONE));
    }
    let Some(username) = normalize_username(raw) else {
        return Ok(fail(400, msg::BAD_USERNAME));
    };
    if let Some(e) = password_error(password) {
        return Ok(fail(400, e));
    }
    if password != confirm {
        return Ok(fail(400, msg::MISMATCH));
    }
    let hash = hash_password(password.and_then(Value::as_str).unwrap_or_default());
    // Vérification et insertion dans la même transaction : un seul administrateur.
    c.execute_batch("BEGIN IMMEDIATE")?;
    let id = (|| -> rusqlite::Result<Option<i64>> {
        if count_users(c)? > 0 {
            return Ok(None);
        }
        insert_user(c, &username, &hash, "admin").map(Some)
    })();
    match &id {
        Ok(_) => c.execute_batch("COMMIT")?,
        Err(_) => {
            let _ = c.execute_batch("ROLLBACK");
        }
    }
    let Some(id) = id? else {
        return Ok(fail(403, msg::SETUP_DONE));
    };
    touch_login(c, id)?;
    let session = create_session(c, id, Utc::now())?;
    Ok(Ok(LoggedIn {
        user: json!({ "id": id, "username": username, "role": "admin" }),
        session,
    }))
}

/// Changement de son propre mot de passe ; les autres sessions du compte sont révoquées.
pub fn change_own_password(
    c: &Connection,
    user_id: i64,
    token_hash: &str,
    current: Option<&Value>,
    next: Option<&Value>,
    confirm: Option<&Value>,
) -> DbFn<()> {
    let now = Utc::now().timestamp_millis();
    let keys = vec![format!("pw:{user_id}")];
    let wait = blocked_for(&keys, now);
    if wait > 0 {
        return Ok(too_many(wait));
    }
    let Some(user) = user_by_id(c, user_id)? else {
        return Ok(fail(404, msg::USER_NOT_FOUND));
    };
    let good = current
        .and_then(Value::as_str)
        .is_some_and(|cur| verify_password(&js_slice(cur, PASSWORD_MAX + 1), &user.password_hash));
    if !good {
        record_failure(&keys, now);
        return Ok(fail(400, msg::BAD_CURRENT_PASSWORD));
    }
    clear_failures(&keys);
    if let Some(e) = password_error(next) {
        return Ok(fail(400, e));
    }
    if next != confirm {
        return Ok(fail(400, msg::MISMATCH));
    }
    let hash = hash_password(next.and_then(Value::as_str).unwrap_or_default());
    c.execute(
        "UPDATE users SET password_hash = ?1 WHERE id = ?2",
        params![hash, user.id],
    )?;
    delete_user_sessions(c, user.id, Some(token_hash))?;
    Ok(Ok(()))
}

pub fn create_user(
    c: &Connection,
    raw: Option<&Value>,
    password: Option<&Value>,
    role: Option<&Value>,
) -> DbFn<i64> {
    let Some(username) = normalize_username(raw) else {
        return Ok(fail(400, msg::BAD_USERNAME));
    };
    if let Some(e) = password_error(password) {
        return Ok(fail(400, e));
    }
    let Some(role) = is_role(role) else {
        return Ok(fail(400, msg::BAD_ROLE));
    };
    if user_by_name(c, &username)?.is_some() {
        return Ok(fail(409, msg::USERNAME_TAKEN));
    }
    let hash = hash_password(password.and_then(Value::as_str).unwrap_or_default());
    if user_by_name(c, &username)?.is_some() {
        return Ok(fail(409, msg::USERNAME_TAKEN));
    }
    Ok(Ok(insert_user(c, &username, &hash, role)?))
}

pub fn delete_user(c: &Connection, actor_id: i64, target_id: i64) -> DbFn<()> {
    let Some(t) = user_by_id(c, target_id)? else {
        return Ok(fail(404, msg::USER_NOT_FOUND));
    };
    if t.id == actor_id {
        return Ok(fail(400, msg::DELETE_SELF));
    }
    if t.role == "admin" && count_admins(c)? <= 1 {
        return Ok(fail(400, msg::DELETE_LAST_ADMIN));
    }
    c.execute_batch("BEGIN IMMEDIATE")?;
    let r = c
        .execute("DELETE FROM sessions WHERE user_id = ?1", [t.id])
        .and_then(|_| c.execute("DELETE FROM users WHERE id = ?1", [t.id]));
    match r {
        Ok(_) => c.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(Ok(()))
}

/// Réinitialisation par un administrateur : sessions du compte révoquées (sauf la sienne).
pub fn reset_user_password(
    c: &Connection,
    actor_id: i64,
    actor_token_hash: &str,
    target_id: i64,
    password: Option<&Value>,
) -> DbFn<()> {
    let Some(t) = user_by_id(c, target_id)? else {
        return Ok(fail(404, msg::USER_NOT_FOUND));
    };
    if let Some(e) = password_error(password) {
        return Ok(fail(400, e));
    }
    let hash = hash_password(password.and_then(Value::as_str).unwrap_or_default());
    c.execute(
        "UPDATE users SET password_hash = ?1 WHERE id = ?2",
        params![hash, t.id],
    )?;
    delete_user_sessions(c, t.id, (t.id == actor_id).then_some(actor_token_hash))?;
    Ok(Ok(()))
}

pub fn set_user_role(c: &Connection, target_id: i64, role: Option<&Value>) -> DbFn<()> {
    let Some(role) = is_role(role) else {
        return Ok(fail(400, msg::BAD_ROLE));
    };
    let Some(t) = user_by_id(c, target_id)? else {
        return Ok(fail(404, msg::USER_NOT_FOUND));
    };
    if t.role == "admin" && role == "user" && count_admins(c)? <= 1 {
        return Ok(fail(400, msg::DEMOTE_LAST_ADMIN));
    }
    c.execute(
        "UPDATE users SET role = ?1 WHERE id = ?2",
        params![role, t.id],
    )?;
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empreinte_lisible_par_node_et_inversement() {
        let h = hash_password("motdepasse");
        assert!(h.starts_with("scrypt$32768$8$1$"));
        assert!(verify_password("motdepasse", &h));
        assert!(!verify_password("autre", &h));
        // Empreinte écrite par Node (src/lib/auth.ts, hashPassword('motdepasse')).
        let node = "scrypt$32768$8$1$+Wdpz/W2cuRFwih4wpqgog==$jqZRz2unQ6N1EMwmJQ9iX4BkVIGLVJebe1Dzpr7bA1P1QGC1e1I0GApCQI1m4jNIR8B/vbs8iTS9ZicShGpewQ==";
        assert!(verify_password("motdepasse", node));
        assert!(!verify_password("motdepassf", node));
        assert!(
            !verify_password("x", "scrypt$3$8$1$c2Vs$aaaaaaaaaaaaaaaaaaaaaa=="),
            "N non puissance de 2"
        );
        assert!(!verify_password("x", "bcrypt$1"));
    }

    #[test]
    fn identifiants_et_longueurs_comme_javascript() {
        assert_eq!(
            normalize_username(Some(&json!("  Michel.B "))).as_deref(),
            Some("michel.b")
        );
        assert_eq!(normalize_username(Some(&json!("ab"))), None);
        assert_eq!(normalize_username(Some(&json!("é_abc"))), None);
        assert_eq!(normalize_username(Some(&json!(123))), None);
        assert_eq!(
            password_error(Some(&json!("1234567"))),
            Some(msg::SHORT_PASSWORD)
        );
        assert_eq!(password_error(Some(&json!("12345678"))), None);
        assert_eq!(
            password_error(Some(&json!("😀😀😀😀"))),
            None,
            "4 émojis = 8 unités UTF-16"
        );
        assert_eq!(
            password_error(Some(&json!("x".repeat(201)))),
            Some(msg::LONG_PASSWORD)
        );
        assert_eq!(js_slice("a😀b", 2), "a\u{fffd}");
    }
}
