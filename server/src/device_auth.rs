//! Connexion d'un appareil par code (TV : Fire TV, Google TV), sans clavier.
//!
//! 1. La TV appelle `POST /api/auth/device/start` (public) : elle reçoit un code court à
//!    afficher (`ABCD-EFGH`, 10 min) et un jeton d'attente secret.
//! 2. Sur un téléphone ou un PC déjà connecté, l'utilisateur saisit le code sur `/appareil`
//!    (`check` puis `approve`, session exigée).
//! 3. La TV interroge `POST /api/auth/device/poll` avec son jeton : une fois le code validé,
//!    elle reçoit sa propre session (cookie normal, libellé = nom de l'appareil). Le code ne
//!    sert qu'une fois.
//!
//! Les demandes en attente vivent en mémoire (un redémarrage les efface : il suffit de
//! redemander un code). Seule l'empreinte du jeton d'attente est gardée. Les codes faux sont
//! comptés comme des mots de passe faux (5 essais puis 60 s de blocage, par IP et par compte).

use crate::accounts::{self, Fail};
use crate::auth::hash_token;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::{Rng, RngCore};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Durée de validité d'un code.
pub const CODE_TTL_MS: i64 = 10 * 60_000;
/// Intervalle conseillé entre deux `poll`.
pub const POLL_INTERVAL_S: i64 = 3;
/// Demandes de code par IP sur [`START_WINDOW_MS`].
const MAX_STARTS_PER_IP: usize = 10;
const START_WINDOW_MS: i64 = 10 * 60_000;
/// Plafond global des demandes en attente.
const MAX_PENDING: usize = 500;
/// Sans 0/O ni 1/I : lisible sur une TV et facile à taper.
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;

pub const MSG_UNKNOWN: &str = "Code inconnu ou expiré.";
pub const MSG_USED: &str = "Ce code a déjà été validé.";
pub const MSG_BUSY: &str = "Trop de demandes en cours. Réessayez dans quelques minutes.";

#[derive(Clone, Debug)]
struct Pending {
    user_code: String,
    name: String,
    ip: String,
    expires: i64,
    approved_by: Option<i64>,
}

#[derive(Default)]
struct Store {
    /// Empreinte du jeton d'attente → demande.
    by_device: HashMap<String, Pending>,
    /// Demandes de code par IP (horodatages).
    starts: HashMap<String, Vec<i64>>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Store> {
    store().lock().unwrap_or_else(|e| e.into_inner())
}

fn purge(s: &mut Store, now: i64) {
    s.by_device.retain(|_, p| p.expires > now);
    s.starts.retain(|_, v| {
        v.retain(|t| now - t < START_WINDOW_MS);
        !v.is_empty()
    });
}

/// Réservé aux tests.
pub fn reset() {
    *lock() = Store::default();
}

/// Code saisi → forme canonique (`abcd efgh`, `ABCD-EFGH` → `ABCDEFGH`) ; `None` si invalide.
pub fn normalize_code(raw: &str) -> Option<String> {
    let c: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (c.len() == CODE_LEN && c.bytes().all(|b| ALPHABET.contains(&b))).then_some(c)
}

/// `ABCDEFGH` → `ABCD-EFGH`.
pub fn display_code(c: &str) -> String {
    format!("{}-{}", &c[..4], &c[4..])
}

/// Nom d'appareil fourni par la TV : texte court, sans caractères de contrôle.
pub fn clean_name(raw: Option<&str>) -> String {
    let n: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    let n = n.trim();
    if n.is_empty() {
        "Appareil".into()
    } else {
        n.to_string()
    }
}

#[derive(Debug)]
pub struct Started {
    pub device_code: String,
    pub user_code: String,
    pub expires_in_s: i64,
}

/// Nouvelle demande (TV).
pub fn start(ip: &str, name: &str, now: i64) -> Result<Started, Fail> {
    let mut s = lock();
    purge(&mut s, now);
    let starts = s.starts.entry(ip.to_string()).or_default();
    if starts.len() >= MAX_STARTS_PER_IP {
        let wait = starts[0] + START_WINDOW_MS - now;
        return accounts::too_many(wait);
    }
    if s.by_device.len() >= MAX_PENDING {
        return Err((503, MSG_BUSY.into()));
    }
    s.starts.entry(ip.to_string()).or_default().push(now);

    let mut rng = rand::thread_rng();
    let user_code = loop {
        let c: String = (0..CODE_LEN)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect();
        if !s.by_device.values().any(|p| p.user_code == c) {
            break c;
        }
    };
    let mut b = [0u8; 32];
    rng.fill_bytes(&mut b);
    let device_code = URL_SAFE_NO_PAD.encode(b);
    s.by_device.insert(
        hash_token(&device_code),
        Pending {
            user_code: user_code.clone(),
            name: name.to_string(),
            ip: ip.to_string(),
            expires: now + CODE_TTL_MS,
            approved_by: None,
        },
    );
    Ok(Started {
        device_code,
        user_code,
        expires_in_s: CODE_TTL_MS / 1000,
    })
}

/// Ce que voit la personne qui valide : nom et adresse IP de l'appareil.
#[derive(Debug, PartialEq)]
pub struct DeviceInfo {
    pub name: String,
    pub ip: String,
}

fn limiter_keys(ip: &str, user_id: i64) -> Vec<String> {
    vec![format!("device-ip:{ip}"), format!("device-user:{user_id}")]
}

/// Cherche la demande d'un code ; un code faux compte comme une tentative ratée.
fn find<'a>(
    s: &'a mut Store,
    raw_code: &str,
    ip: &str,
    user_id: i64,
    now: i64,
) -> Result<&'a mut Pending, Fail> {
    let keys = limiter_keys(ip, user_id);
    let wait = accounts::blocked_for(&keys, now);
    if wait > 0 {
        return accounts::too_many(wait);
    }
    purge(s, now);
    let code = normalize_code(raw_code);
    let found = code.and_then(|c| s.by_device.values_mut().find(|p| p.user_code == c));
    match found {
        Some(p) => {
            accounts::clear_failures(&keys);
            Ok(p)
        }
        None => {
            accounts::record_failure(&keys, now);
            Err((404, MSG_UNKNOWN.into()))
        }
    }
}

/// Étape 1 de la validation : quel appareil demande l'accès ?
pub fn check(raw_code: &str, ip: &str, user_id: i64, now: i64) -> Result<DeviceInfo, Fail> {
    let mut s = lock();
    let p = find(&mut s, raw_code, ip, user_id, now)?;
    if p.approved_by.is_some() {
        return Err((409, MSG_USED.into()));
    }
    Ok(DeviceInfo {
        name: p.name.clone(),
        ip: p.ip.clone(),
    })
}

/// Étape 2 : l'utilisateur connecté valide le code ; la TV recevra une session à son nom.
pub fn approve(raw_code: &str, ip: &str, user_id: i64, now: i64) -> Result<DeviceInfo, Fail> {
    let mut s = lock();
    let p = find(&mut s, raw_code, ip, user_id, now)?;
    if p.approved_by.is_some() {
        return Err((409, MSG_USED.into()));
    }
    p.approved_by = Some(user_id);
    Ok(DeviceInfo {
        name: p.name.clone(),
        ip: p.ip.clone(),
    })
}

#[derive(Debug, PartialEq)]
pub enum Poll {
    Pending,
    /// Validé : la demande est retirée (le jeton ne sert qu'une fois).
    Approved {
        user_id: i64,
        name: String,
    },
    Expired,
}

/// Interrogation par la TV.
pub fn poll(device_code: &str, now: i64) -> Poll {
    let mut s = lock();
    purge(&mut s, now);
    let key = hash_token(device_code);
    match s.by_device.get(&key).map(|p| p.approved_by) {
        None => Poll::Expired,
        Some(None) => Poll::Pending,
        Some(Some(user_id)) => {
            let p = s.by_device.remove(&key).expect("présent");
            Poll::Approved {
                user_id,
                name: p.name,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Magasin global partagé (et purgé selon l'heure passée) : un test à la fois.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        g
    }

    #[test]
    fn codes_lisibles() {
        assert_eq!(normalize_code("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code(" ab cd ef gh ").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code("ABCD-EFG0"), None, "0 exclu");
        assert_eq!(normalize_code("ABCDEFGI"), None, "I exclu");
        assert_eq!(normalize_code("ABC"), None);
        assert_eq!(display_code("ABCDEFGH"), "ABCD-EFGH");
        assert_eq!(clean_name(Some("  Fire TV\n Cube ")), "Fire TV Cube");
        assert_eq!(clean_name(None), "Appareil");
    }

    #[test]
    fn parcours_complet_et_usage_unique() {
        let _g = serial();
        let now = 1_000_000;
        let st = start("10.0.0.1", "Fire TV", now).unwrap();
        assert_eq!(st.user_code.len(), CODE_LEN);
        assert_eq!(poll(&st.device_code, now), Poll::Pending);
        let typed = display_code(&st.user_code).to_lowercase();
        assert_eq!(
            check(&typed, "10.0.0.2", 1, now).unwrap(),
            DeviceInfo {
                name: "Fire TV".into(),
                ip: "10.0.0.1".into()
            }
        );
        approve(&typed, "10.0.0.2", 1, now).unwrap();
        assert_eq!(approve(&typed, "10.0.0.2", 1, now).unwrap_err().0, 409);
        assert_eq!(
            poll(&st.device_code, now + 1),
            Poll::Approved {
                user_id: 1,
                name: "Fire TV".into()
            }
        );
        // Jeton consommé : plus rien.
        assert_eq!(poll(&st.device_code, now + 2), Poll::Expired);
        assert_eq!(check(&typed, "10.0.0.2", 1, now + 3).unwrap_err().0, 404);
    }

    #[test]
    fn expiration() {
        let _g = serial();
        let now = 2_000_000;
        let st = start("10.0.1.1", "TV", now).unwrap();
        let later = now + CODE_TTL_MS + 1;
        assert_eq!(poll(&st.device_code, later), Poll::Expired);
        assert_eq!(
            approve(&st.user_code, "10.0.1.2", 2, later).unwrap_err().0,
            404
        );
    }

    #[test]
    fn codes_faux_limites() {
        let _g = serial();
        let now = 3_000_000;
        let st = start("10.0.2.1", "TV", now).unwrap();
        for _ in 0..5 {
            assert_eq!(check("ZZZZ-ZZZZ", "10.0.2.9", 3, now).unwrap_err().0, 404);
        }
        // Bloqué, même avec le bon code.
        assert_eq!(check(&st.user_code, "10.0.2.9", 3, now).unwrap_err().0, 429);
        assert_eq!(
            approve(&st.user_code, "10.0.2.9", 3, now + 61_000)
                .unwrap()
                .name,
            "TV"
        );
    }

    #[test]
    fn demandes_limitees_par_ip() {
        let _g = serial();
        let now = 4_000_000;
        for _ in 0..MAX_STARTS_PER_IP {
            start("10.0.3.1", "TV", now).unwrap();
        }
        assert_eq!(start("10.0.3.1", "TV", now).unwrap_err().0, 429);
        assert!(start("10.0.3.2", "TV", now).is_ok(), "autre IP");
        assert!(start("10.0.3.1", "TV", now + START_WINDOW_MS).is_ok());
    }
}
