//! `basketland-server reset-password` (portage de `scripts/reset-password.mjs`
//! et de son test dans `tests/auth-routes.test.ts`) : vrai binaire, base
//! temporaire (`DB_PATH`).

use basketland_server::accounts::verify_password;
use rusqlite::Connection;
use std::process::Command;

fn run(db: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_basketland-server"))
        .arg("reset-password")
        .args(args)
        .env("DB_PATH", db)
        .output()
        .expect("binaire")
}

#[test]
fn cree_un_administrateur_puis_change_son_mot_de_passe_et_ferme_ses_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("sous").join("basketland.db");
    let out = run(&db, &["Secours", "motdepasse1"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("Compte administrateur « secours » créé."),
        "{stdout}"
    );
    assert!(
        stdout.contains(&format!("Base : {}", db.display())),
        "{stdout}"
    );

    let c = Connection::open(&db).unwrap();
    let (id, role, hash): (i64, String, String) = c
        .query_row(
            "SELECT id, role, password_hash FROM users WHERE username = 'secours'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(role, "admin");
    assert!(hash.starts_with("scrypt$32768$8$1$"), "{hash}");
    assert!(verify_password("motdepasse1", &hash));
    c.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', ?1, 'x', 'y')",
        [id],
    )
    .unwrap();
    drop(c);

    let out = run(&db, &["secours", "autremdp22"]);
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains(
            "Mot de passe de « secours » (administrateur) mis à jour ; 1 session(s) fermée(s)."
        ),
        "{stdout}"
    );
    let c = Connection::open(&db).unwrap();
    let hash: String = c
        .query_row("SELECT password_hash FROM users WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(verify_password("autremdp22", &hash));
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);

    // Erreurs : identifiant ou mot de passe invalides (1), usage (2).
    for (args, code, msg) in [
        (
            &["x", "motdepasse1"][..],
            1,
            "Erreur : identifiant invalide",
        ),
        (
            &["secours", "court"][..],
            1,
            "Erreur : le mot de passe doit contenir au moins 8 caractères.",
        ),
        (
            &["secours"][..],
            2,
            "Usage : basketland-server reset-password",
        ),
        (&[][..], 2, "Usage : basketland-server reset-password"),
    ] {
        let out = run(&db, args);
        assert_eq!(out.status.code(), Some(code), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).starts_with(msg),
            "{args:?}"
        );
    }
    let long = "x".repeat(201);
    assert_eq!(run(&db, &["secours", &long]).status.code(), Some(1));
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}
