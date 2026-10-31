//! Version de l'application en service (équivalent de `src/lib/version.ts`) :
//! commit et date de construction de l'image Docker (`APP_COMMIT`,
//! `APP_BUILT_AT`, posés par la CI). Construite hors de la CI : `None`.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppVersion {
    /// Commit court (7 caractères).
    pub commit: Option<String>,
    /// Date ISO de construction de l'image.
    pub built_at: Option<String>,
}

impl AppVersion {
    pub fn to_json(&self) -> Value {
        json!({ "commit": self.commit, "builtAt": self.built_at })
    }
}

/// `appVersion`. `APP_BUILT_AT` est lu comme `Date.parse` pour les formats
/// ISO 8601 (ceux de la CI) ; un autre format accepté par JavaScript seul
/// (« Sat Oct 31 2026… ») donne ici `None`.
pub fn app_version() -> AppVersion {
    let env = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| crate::js::trim(&v).to_string())
    };
    let sha = env("APP_COMMIT")
        .filter(|s| (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit()));
    let built = env("APP_BUILT_AT")
        .filter(|s| !s.is_empty())
        .and_then(|s| crate::time::parse_instant(&s))
        .map(crate::time::iso_utc);
    AppVersion {
        commit: sha.map(|s| s[..7].to_string()),
        built_at: built,
    }
}
