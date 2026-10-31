//! Récupération d'accès (équivalent de `scripts/reset-password.mjs`) :
//!
//! ```text
//! docker exec -it basketland basketland-server reset-password <identifiant> <nouveau-mot-de-passe>
//! ```
//!
//! - crée le compte (ADMINISTRATEUR) s'il n'existe pas ;
//! - ferme toutes ses sessions ouvertes ;
//! - même empreinte que l'application (`scrypt$N$r$p$sel$empreinte`) ;
//! - même base que le serveur (`DB_PATH`, sinon `DATA_DIR`, `/data` ou
//!   `./data` + `basketland.db`), créée et migrée au besoin.
//!
//! Codes de sortie : 0 fait, 1 erreur, 2 usage.

use crate::accounts::{hash_password, js_len};
use crate::db::default_db_path;
use crate::js::{jsre, trim};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use std::path::Path;

const USAGE: &str = "Usage : basketland-server reset-password <identifiant> <nouveau-mot-de-passe>";

/// `docker exec` tourne en root par défaut, le serveur en `node` : des
/// fichiers -wal/-shm créés par root le bloqueraient. On prend donc
/// l'identité du propriétaire de la base (ou de son dossier) avant de l'ouvrir.
fn drop_root(db_file: &Path) {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid ne fait que lire l'identité du processus.
    if unsafe { libc::getuid() } != 0 {
        return;
    }
    let reference = if db_file.exists() {
        Some(db_file)
    } else {
        db_file.parent().filter(|d| d.exists())
    };
    let Some(meta) = reference.and_then(|r| std::fs::metadata(r).ok()) else {
        return;
    };
    if meta.uid() != 0 {
        // SAFETY: changement d'identité du processus, sans fil lancé à ce stade.
        unsafe {
            libc::setgid(meta.gid());
            libc::setuid(meta.uid());
        }
    }
}

/// Met à jour (ou crée) le compte ; message de réussite.
fn apply(db_file: &Path, username: &str, password: &str) -> Result<String, String> {
    crate::schema::ensure_schema(db_file)?;
    let mut c = rusqlite::Connection::open(db_file).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    let hash = hash_password(password);
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, role FROM users WHERE username = ?1",
            [username],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let msg = match existing {
        Some((id, role)) => {
            tx.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                params![hash, id],
            )
            .map_err(|e| e.to_string())?;
            let n = tx
                .execute("DELETE FROM sessions WHERE user_id = ?1", [id])
                .map_err(|e| e.to_string())?;
            let who = if role == "admin" {
                "administrateur"
            } else {
                "utilisateur"
            };
            format!("Mot de passe de « {username} » ({who}) mis à jour ; {n} session(s) fermée(s).")
        }
        None => {
            tx.execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?1, ?2, 'admin', ?3)",
                params![username, hash, crate::time::iso_utc(chrono::Utc::now())],
            )
            .map_err(|e| e.to_string())?;
            format!("Compte administrateur « {username} » créé.")
        }
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(msg)
}

/// Sous-commande `reset-password` ; `args` : ce qui suit son nom.
pub fn run(args: &[String]) -> i32 {
    let (Some(raw_user), Some(password)) = (args.first(), args.get(1)) else {
        eprintln!("{USAGE}");
        return 2;
    };
    let die = |msg: &str| {
        eprintln!("Erreur : {msg}");
        1
    };
    let username = trim(raw_user).to_lowercase();
    if !jsre!(r"^[a-z0-9._-]{3,32}$").is_match(&username) {
        return die(
            "identifiant invalide (3 à 32 caractères parmi a-z, 0-9, point, tiret, tiret bas).",
        );
    }
    if js_len(password) < 8 {
        return die("le mot de passe doit contenir au moins 8 caractères.");
    }
    if js_len(password) > 200 {
        return die("le mot de passe ne doit pas dépasser 200 caractères.");
    }
    let db_file = default_db_path();
    drop_root(&db_file);
    match apply(&db_file, &username, password) {
        Ok(msg) => {
            println!("{msg}");
            println!("Base : {}", db_file.display());
            0
        }
        Err(e) => die(&e),
    }
}
