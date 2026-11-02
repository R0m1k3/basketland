//! Paramètres de l'application modifiables depuis /parametres (table
//! `settings`), équivalent de `src/lib/settings.ts` et
//! `src/lib/minimaxCatalog.ts`.
//!
//! Lecture : [`Settings`] est un instantané de la table (une lecture par
//! usage, comme Node qui relit la base à chaque appel). Une base illisible
//! donne [`Settings::unreadable`] : chaque fonction se comporte alors comme
//! son équivalent Node dans son `catch` (valeurs par défaut ou variables
//! d'environnement). Écriture : [`setting_set`]. Les clés API ne repartent
//! jamais en clair : seules les vues masquées ([`openai_settings_view`],
//! [`minimax_settings_view`]) sont destinées au navigateur.

use crate::db::{col_text, Db};
use crate::js;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Clés connues de la table `settings` (`SETTING_KEYS`).
pub mod keys {
    pub const OPENAI_API_KEY: &str = "openai_api_key";
    pub const OPENAI_MODEL: &str = "openai_model";
    /// « Traduction automatique » : '1' (activée) ou '0' (désactivée).
    pub const AUTO_TRANSLATE: &str = "auto_translate";
    /// Clé API MiniMax (traduction en ligne des commentaires).
    pub const MINIMAX_API_KEY: &str = "minimax_api_key";
    /// Traduction des commentaires par MiniMax : '1' (activée) ; modèle texte.
    pub const MINIMAX_TRANSLATE: &str = "minimax_translate";
    pub const MINIMAX_TRANSLATE_MODEL: &str = "minimax_translate_model";
    /// Moteur de transcription embarqué : 'whisper' (défaut) ou 'nvidia' (Parakeet).
    pub const TRANSCRIBE_ENGINE: &str = "transcribe_engine";
    pub const TRANSLATE_ENGINE: &str = "translate_engine";
    pub const TRANSLATE_LOCAL_MODEL: &str = "translate_local_model";
    /// Connexions simultanées vers ok.ru pour l'audio d'un tronçon (1 à 32).
    pub const FETCH_PARALLEL: &str = "fetch_parallel";
    /// Noms à respecter dans les sous-titres (commentateurs, surnoms…), un par ligne.
    pub const EXTRA_NAMES: &str = "extra_names";
    /// Modèle de secours (même fournisseur) pour les lignes mal traduites.
    pub const TRANSLATE_REPAIR_MODEL: &str = "translate_repair_model";
}

/// Modèle OpenAI proposé quand aucun n'est saisi (placeholder du formulaire).
pub const OPENAI_MODEL_PLACEHOLDER: &str = "gpt-5.4-mini";

// ---------------------------------------------------------------- catalogue MiniMax

/// Modèles texte MiniMax proposés pour la traduction des commentaires.
pub const MINIMAX_TEXT_MODELS: [(&str, &str); 2] = [
    ("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash — rapide"),
    ("MiniMax-M3", "MiniMax M3 — plus soigné, plus lent"),
];
pub const MINIMAX_DEFAULT_TEXT_MODEL: &str = "MiniMax-M3.1-Flash";

/// Adresse de l'API MiniMax (`MINIMAX_API_URL`, sans « / » final).
pub const MINIMAX_DEFAULT_URL: &str = "https://api.minimax.io";

pub fn minimax_api_url() -> String {
    env_trim("MINIMAX_API_URL")
        .unwrap_or_else(|| MINIMAX_DEFAULT_URL.into())
        .trim_end_matches('/')
        .to_string()
}

/// Clé MiniMax : réglage de la page (prioritaire), sinon `MINIMAX_API_KEY`.
pub fn minimax_api_key(s: &Settings) -> Option<String> {
    s.get(keys::MINIMAX_API_KEY)
        .map(|v| js::trim(v).to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| env_trim("MINIMAX_API_KEY"))
}

// ---------------------------------------------------------------- lecture / écriture

/// Instantané de la table `settings`. `rows: None` : base illisible.
/// `Settings::default()` : table vide (aucun réglage enregistré).
#[derive(Debug, Clone)]
pub struct Settings {
    rows: Option<HashMap<String, String>>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            rows: Some(HashMap::new()),
        }
    }
}

impl Settings {
    /// Lit toute la table (quelques lignes).
    pub fn load(c: &Connection) -> rusqlite::Result<Settings> {
        let mut st = c.prepare("SELECT key, value FROM settings")?;
        let rows = st.query_map([], |r| {
            Ok((
                col_text(r, "key").unwrap_or_default(),
                col_text(r, "value").unwrap_or_default(),
            ))
        })?;
        let mut map = HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(Settings { rows: Some(map) })
    }

    /// Lecture depuis le code asynchrone ; base illisible : [`Settings::unreadable`].
    pub async fn read(db: &Db) -> Settings {
        db.run(Settings::load)
            .await
            .unwrap_or_else(|_| Settings::unreadable())
    }

    /// Base illisible : chaque réglage se comporte comme dans le `catch` de Node.
    pub fn unreadable() -> Settings {
        Settings { rows: None }
    }

    /// Instantané fabriqué (tests).
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Settings {
        Settings {
            rows: Some(
                pairs
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ),
        }
    }

    pub fn is_readable(&self) -> bool {
        self.rows.is_some()
    }

    /// `getSetting` (absent, ou base illisible : `None`).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.rows.as_ref()?.get(key).map(String::as_str)
    }
}

/// `settingGet` : lecture directe d'un paramètre.
pub fn setting_get(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut st = c.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = st.query_map([key], |r| Ok(col_text(r, "value")))?;
    Ok(rows.next().transpose()?.flatten())
}

/// `settingSet` / `setSetting` : écrit un paramètre ; `None` le supprime.
pub fn setting_set(c: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        None => c
            .execute("DELETE FROM settings WHERE key = ?1", [key])
            .map(|_| ()),
        Some(v) => c
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                [key, v, &crate::time::iso_utc(chrono::Utc::now())],
            )
            .map(|_| ()),
    }
}

/// Variable d'environnement (absente : `None` ; vide : `Some("")`, comme `process.env`).
pub(crate) fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `process.env.X?.trim()` non vide.
pub(crate) fn env_trim(name: &str) -> Option<String> {
    env(name)
        .map(|v| js::trim(&v).to_string())
        .filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------- réglages

/// « Traduction automatique » (ACTIVÉE par défaut) : seule la valeur '0' la désactive.
pub fn auto_translate_enabled(s: &Settings) -> bool {
    s.get(keys::AUTO_TRANSLATE) != Some("0")
}

/// Moteurs de transcription embarqués proposés dans les Paramètres :
/// Whisper large-v3-turbo (défaut), Whisper large-v3 complet (plus précis),
/// NVIDIA Parakeet.
pub const TRANSCRIBE_ENGINES: [&str; 3] = ["whisper", "whisper-large", "nvidia"];

/// Valeur acceptée pour `transcribeEngine`.
pub fn is_transcribe_engine(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if TRANSCRIBE_ENGINES.contains(&s.as_str()))
}

/// Moteur de transcription embarqué : 'nvidia' (Parakeet), 'whisper-large'
/// (Whisper large-v3 complet), sinon 'whisper' (large-v3-turbo, défaut).
pub fn transcribe_engine(s: &Settings) -> &'static str {
    match s.get(keys::TRANSCRIBE_ENGINE) {
        Some("nvidia") => "nvidia",
        Some("whisper-large") => "whisper-large",
        _ => "whisper",
    }
}

/// « Moteur de traduction » : moteur réellement utilisé, modèle embarqué,
/// modèles proposés, et pourquoi le choix ne s'applique pas (serveur externe).
pub fn translate_settings_view(s: &Settings) -> Value {
    use crate::media::commentary_ai::{commentary_config, ServiceMode, TranslateProvider};
    let c = commentary_config(s);
    let engine = match c.translate_provider {
        TranslateProvider::Minimax => "minimax",
        TranslateProvider::Openai => "openai",
        TranslateProvider::Ollama => "local",
    };
    let local_model = translate_local_model(s)
        .or_else(|| env_trim("TRANSLATE_MODEL"))
        .unwrap_or_else(|| crate::media::commentary_ai::DEFAULT_TRANSLATE_MODEL.into());
    let models: Vec<Value> = LOCAL_TRANSLATE_MODELS
        .iter()
        .map(|(id, label)| json!({ "id": id, "label": label }))
        .collect();
    let remote = c.translate_provider == TranslateProvider::Ollama
        && c.translate_mode == ServiceMode::Remote;
    json!({
        "engine": engine,
        "choice": translate_engine_choice(s),
        "localModel": local_model,
        "models": models,
        "model": c.translate_model,
        "override": remote.then(|| format!(
            "La traduction passe par un serveur externe (TRANSLATE_URL = {}) : le modèle choisi ici doit y être installé.",
            c.translate_url
        )),
    })
}

/// « Noms à respecter » (Paramètres) : un nom par ligne (ou séparés par des
/// virgules), donnés à la transcription et à la traduction.
pub fn extra_names(s: &Settings) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in s
        .get(keys::EXTRA_NAMES)
        .unwrap_or_default()
        .split(['\n', ',', ';'])
    {
        let n = crate::js::trim(n).to_string();
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// Modèle de secours MiniMax par défaut : plus soigné que Flash.
pub const DEFAULT_REPAIR_MODEL: &str = "MiniMax-M3";
/// Valeur du réglage qui coupe le modèle de secours.
pub const NO_REPAIR_MODEL: &str = "aucun";

/// Modèle de secours MiniMax des lignes mal traduites (`translateRepairModel`) :
/// réglage, sinon `TRANSLATE_REPAIR_MODEL`, sinon MiniMax-M3 ; `None` (« aucun ») :
/// le modèle principal reprend lui-même ses lignes.
pub fn translate_repair_model(s: &Settings) -> Option<String> {
    let v = s
        .get(keys::TRANSLATE_REPAIR_MODEL)
        .map(|v| crate::js::trim(v).to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| env_trim("TRANSLATE_REPAIR_MODEL"))
        .unwrap_or_else(|| DEFAULT_REPAIR_MODEL.into());
    (v != NO_REPAIR_MODEL).then_some(v)
}

/// Bornes du nombre de connexions simultanées (`fetchParallel`).
pub const FETCH_PARALLEL_MAX: u64 = 32;

/// Valeur acceptée pour `fetchParallel` : entier de 1 à 32, ou null (défaut).
pub fn is_fetch_parallel(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Null) => true,
        Some(v) => v
            .as_u64()
            .is_some_and(|n| (1..=FETCH_PARALLEL_MAX).contains(&n)),
        None => false,
    }
}

/// Connexions simultanées choisies dans les Paramètres, `None` si aucun choix.
pub fn fetch_parallel(s: &Settings) -> Option<usize> {
    s.get(keys::FETCH_PARALLEL)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| (1..=FETCH_PARALLEL_MAX).contains(n))
        .map(|n| n as usize)
}

/// Applique le choix des Paramètres au téléchargement de l'audio.
pub fn apply_fetch_parallel(s: &Settings) {
    crate::media::hls_fetch::set_fetch_parallel(fetch_parallel(s));
}

/// Coupe JavaScript `s.slice(a, b)` en unités UTF-16 (indices positifs).
fn utf16_range(s: &str, a: usize, b: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let b = b.min(u.len());
    let a = a.min(b);
    String::from_utf16_lossy(&u[a..b])
}

/// Forme masquée d'une clé API : préfixe + 4 derniers caractères (`sk-…abcd`).
pub fn mask_api_key(key: &str) -> String {
    let n = js::utf16_len(key);
    if n < 12 {
        return "••••".into();
    }
    format!("{}…{}", utf16_range(key, 0, 3), utf16_range(key, n - 4, n))
}

/// `openAiSettingsView` : `{ keySet, keyMasked, model }`.
pub fn openai_settings_view(s: &Settings) -> Value {
    let key = s.get(keys::OPENAI_API_KEY).filter(|k| !k.is_empty());
    json!({
        "keySet": key.is_some(),
        "keyMasked": key.map(mask_api_key),
        "model": s.get(keys::OPENAI_MODEL),
    })
}

fn visible_ascii(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// `apiKeyError` : clé OpenAI saisie, un seul « mot » de caractères ASCII visibles.
pub fn api_key_error(key: &str) -> Option<&'static str> {
    let n = js::utf16_len(key);
    if !(20..=400).contains(&n) {
        return Some("La clé API semble invalide (longueur inattendue).");
    }
    if !visible_ascii(key) {
        return Some("La clé API ne doit contenir ni espace ni caractère accentué.");
    }
    None
}

/// `modelError` : nom de modèle (ex. `gpt-5.4-mini`).
pub fn model_error(model: &str) -> Option<&'static str> {
    let ok = !model.is_empty()
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b));
    if js::utf16_len(model) > 100 || !ok {
        return Some("Nom de modèle invalide.");
    }
    None
}

/// `minimaxKeyError` : clé MiniMax (jusqu'à ~1 000 caractères).
pub fn minimax_key_error(key: &str) -> Option<&'static str> {
    let n = js::utf16_len(key);
    if !(20..=2000).contains(&n) {
        return Some("La clé API semble invalide (longueur inattendue).");
    }
    if !visible_ascii(key) {
        return Some("La clé API ne doit contenir ni espace ni caractère accentué.");
    }
    None
}

pub fn minimax_translate_model_error(model: &str) -> Option<&'static str> {
    if MINIMAX_TEXT_MODELS.iter().any(|(id, _)| *id == model) {
        None
    } else {
        Some("Modèle de traduction MiniMax inconnu.")
    }
}

pub fn translate_engine_choice(s: &Settings) -> Option<&'static str> {
    match s.get(keys::TRANSLATE_ENGINE) {
        Some("local") => Some("local"),
        Some("minimax") => Some("minimax"),
        Some("openai") => Some("openai"),
        _ => None,
    }
}

/// Valeur acceptée pour `translateEngine`.
pub fn is_translate_engine(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if s == "local" || s == "minimax" || s == "openai")
}

/// Modèles de traduction embarqués proposés (id Ollama, libellé).
pub const LOCAL_TRANSLATE_MODELS: [(&str, &str); 4] = [
    (
        "translategemma:12b",
        "TranslateGemma 12B (Google) — par défaut",
    ),
    ("gemma4:e4b", "Gemma 4 E4B (Google)"),
    (
        "hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q8_0",
        "Hunyuan-MT 7B (Tencent) — spécialiste de la traduction",
    ),
    (
        "hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q4_K_M",
        "Hunyuan-MT 7B (Tencent), version légère",
    ),
];

/// Modèle de traduction embarqué choisi dans les Paramètres (prioritaire sur `TRANSLATE_MODEL`).
pub fn translate_local_model(s: &Settings) -> Option<String> {
    s.get(keys::TRANSLATE_LOCAL_MODEL)
        .map(|m| js::trim(m).to_string())
        .filter(|m| !m.is_empty())
}

/// `minimaxTranslateWanted` : moteur choisi (« Moteur de traduction »),
/// sinon réglage de la page MiniMax, sinon `MINIMAX_TRANSLATE=1`.
pub fn minimax_translate_wanted(s: &Settings) -> bool {
    if let Some(e) = translate_engine_choice(s) {
        return e == "minimax";
    }
    match s.get(keys::MINIMAX_TRANSLATE) {
        None => env("MINIMAX_TRANSLATE").map(|v| js::trim(&v).to_string()) == Some("1".into()),
        Some(v) => v == "1",
    }
}

/// `minimaxTranslateModel` : réglage, sinon `MINIMAX_TRANSLATE_MODEL`, sinon défaut.
pub fn minimax_translate_model(s: &Settings) -> String {
    s.get(keys::MINIMAX_TRANSLATE_MODEL)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| env_trim("MINIMAX_TRANSLATE_MODEL"))
        .unwrap_or_else(|| MINIMAX_DEFAULT_TEXT_MODEL.into())
}

/// `minimaxSettingsView` : ce que l'interface peut afficher (jamais la clé complète).
pub fn minimax_settings_view(s: &Settings) -> Value {
    let key = s.get(keys::MINIMAX_API_KEY).filter(|k| !k.is_empty());
    json!({
        "keySet": key.is_some(),
        "keyMasked": key.map(mask_api_key),
        "envKey": env_trim("MINIMAX_API_KEY").is_some(),
        "translate": minimax_translate_wanted(s),
        "translateModel": minimax_translate_model(s),
    })
}

/// Ce que `/api/admin/settings` renvoie (clés MASQUÉES).
pub fn settings_view(s: &Settings) -> Value {
    json!({
        "openai": openai_settings_view(s),
        "minimax": minimax_settings_view(s),
        "autoTranslate": auto_translate_enabled(s),
        "transcribeEngine": transcribe_engine(s),
        "transcribeEngineOverride": crate::media::commentary_ai::transcribe_engine_override(s),
        "translate": translate_settings_view(s),
        "fetchParallel": fetch_parallel(s).unwrap_or_else(crate::media::hls_fetch::fetch_parallel_default),
        "translateRepairModel": translate_repair_model(s),
        "extraNames": s.get(keys::EXTRA_NAMES).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masque_et_validation() {
        assert_eq!(mask_api_key("court"), "••••");
        assert_eq!(mask_api_key("sk-test-0123456789abcd"), "sk-…abcd");
        assert!(api_key_error("sk-0123456789abcdefghij").is_none());
        assert!(api_key_error("sk-0123456789abcdefgh j").is_some());
        assert!(api_key_error("x").is_some());
        assert!(model_error("gpt-5.4-mini").is_none());
        assert!(model_error("gpt 5").is_some());
        assert!(minimax_translate_model_error("MiniMax-M3").is_none());
        assert!(minimax_translate_model_error("x").is_some());
    }

    #[test]
    fn modes() {
        let s = Settings::from_pairs([(keys::AUTO_TRANSLATE, "0")]);
        assert!(!auto_translate_enabled(&s));
        assert!(auto_translate_enabled(&Settings::unreadable()));
    }
}
