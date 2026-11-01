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
use crate::js::{self, jsre};
use crate::jsval::js_normalize;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Clés connues de la table `settings` (`SETTING_KEYS`).
pub mod keys {
    pub const OPENAI_API_KEY: &str = "openai_api_key";
    pub const OPENAI_MODEL: &str = "openai_model";
    /// « Traduction automatique » : '1' (activée) ou '0' (désactivée).
    pub const AUTO_TRANSLATE: &str = "auto_translate";
    /// « Version française » : 'sous-titres' (défaut) ou 'doublage'.
    pub const VF_MODE: &str = "vf_mode";
    /// Voix du doublage par MiniMax : clé API, modèle, voix par rôle (JSON { A, B4, B1, F }).
    pub const MINIMAX_API_KEY: &str = "minimax_api_key";
    pub const MINIMAX_MODEL: &str = "minimax_tts_model";
    pub const MINIMAX_VOICES: &str = "minimax_voices";
    /// Traduction des commentaires par MiniMax : '1' (activée) ; modèle texte.
    pub const MINIMAX_TRANSLATE: &str = "minimax_translate";
    pub const MINIMAX_TRANSLATE_MODEL: &str = "minimax_translate_model";
    /// Moteur de transcription embarqué : 'whisper' (défaut) ou 'nvidia' (Parakeet).
    pub const TRANSCRIBE_ENGINE: &str = "transcribe_engine";
    pub const VOICE_QUALITY: &str = "voice_quality";
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

/// Rôles des voix du doublage (dub.ts), dans l'ordre d'affichage.
pub const MINIMAX_ROLES: [&str; 4] = ["A", "B4", "B1", "F"];

/// Libellé d'un rôle (`MINIMAX_ROLE_LABELS`).
pub fn minimax_role_label(role: &str) -> Option<&'static str> {
    Some(match role {
        "A" => "Commentateur",
        "B4" => "Consultant",
        "B1" => "Troisième voix",
        "F" => "Voix féminine",
        _ => return None,
    })
}

/// Modèles de voix MiniMax proposés (id, libellé).
pub const MINIMAX_MODELS: [(&str, &str); 2] = [
    ("speech-2.8-hd", "Speech 2.8 HD — meilleure qualité"),
    (
        "speech-2.8-turbo",
        "Speech 2.8 Turbo — plus rapide, moins de crédits",
    ),
];
pub const MINIMAX_DEFAULT_MODEL: &str = "speech-2.8-hd";

/// Modèles texte MiniMax proposés pour la traduction des commentaires.
pub const MINIMAX_TEXT_MODELS: [(&str, &str); 2] = [
    ("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash — rapide"),
    ("MiniMax-M3", "MiniMax M3 — plus soigné, plus lent"),
];
pub const MINIMAX_DEFAULT_TEXT_MODEL: &str = "MiniMax-M3.1-Flash";

/// Voix françaises du catalogue MiniMax (l'espace dans certains identifiants est voulue).
pub const MINIMAX_FRENCH_VOICES: [(&str, &str); 8] = [
    ("French_Male_Speech_New", "Homme posé"),
    ("French_MaleNarrator", "Narrateur"),
    ("French_CasualMan", "Homme décontracté"),
    ("French_FemaleAnchor", "Présentatrice"),
    ("French_Female_News Anchor", "Présentatrice patiente"),
    ("French_MovieLeadFemale", "Héroïne de cinéma"),
    ("French_Female Journalist", "Journaliste"),
    ("French_Female_Speech_New", "Oratrice assurée"),
];

/// Voix par défaut d'un rôle (`MINIMAX_DEFAULT_VOICES`).
pub fn minimax_default_voice(role: &str) -> &'static str {
    match role {
        "A" => "French_Male_Speech_New",
        "B4" => "French_MaleNarrator",
        "B1" => "French_CasualMan",
        _ => "French_FemaleAnchor",
    }
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

pub const VF_MODES: [&str; 2] = ["sous-titres", "doublage"];

/// `isVfMode`.
pub fn is_vf_mode(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if VF_MODES.contains(&s.as_str()))
}

/// « Version française » : 'doublage', sinon 'sous-titres' (défaut).
pub fn vf_mode(s: &Settings) -> &'static str {
    if s.get(keys::VF_MODE) == Some("doublage") {
        "doublage"
    } else {
        "sous-titres"
    }
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

/// Qualités des voix embarquées du doublage : 'standard' (Qwen3-TTS 0.6B,
/// défaut) ou 'hd' (Qwen3-TTS 1.7B, intonation plus naturelle, plus lent).
pub const VOICE_QUALITIES: [&str; 2] = ["standard", "hd"];

/// Valeur acceptée pour `voiceQuality`.
pub fn is_voice_quality(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if VOICE_QUALITIES.contains(&s.as_str()))
}

/// Qualité des voix embarquées : 'hd', sinon 'standard' (défaut).
pub fn voice_quality(s: &Settings) -> &'static str {
    if s.get(keys::VOICE_QUALITY) == Some("hd") {
        "hd"
    } else {
        "standard"
    }
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

pub fn minimax_model_error(model: &str) -> Option<&'static str> {
    if MINIMAX_MODELS.iter().any(|(id, _)| *id == model) {
        None
    } else {
        Some("Modèle MiniMax inconnu.")
    }
}

/// `savedMinimaxVoices` : voix enregistrées (rôle → voix), dans l'ordre des rôles.
pub fn saved_minimax_voices(s: &Settings) -> Vec<(&'static str, String)> {
    let raw = s.get(keys::MINIMAX_VOICES).filter(|v| !v.is_empty());
    let v = match raw {
        Some(t) => match crate::jsval::js_parse(t) {
            Some(v) => v,
            None => return Vec::new(),
        },
        None => Value::Object(Map::new()),
    };
    let Value::Object(o) = v else {
        return Vec::new();
    };
    MINIMAX_ROLES
        .iter()
        .filter_map(|r| match o.get(*r) {
            Some(Value::String(s)) if !s.is_empty() => Some((*r, s.clone())),
            _ => None,
        })
        .collect()
}

/// `minimaxTranslateWanted` : réglage de la page, sinon `MINIMAX_TRANSLATE=1`.
pub fn minimax_translate_wanted(s: &Settings) -> bool {
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
    let saved = saved_minimax_voices(s);
    let mut voices = Map::new();
    for r in MINIMAX_ROLES {
        let v = saved
            .iter()
            .find(|(role, _)| *role == r)
            .map(|(_, v)| v.clone())
            .or_else(|| env_trim(&format!("MINIMAX_VOICE_{r}")))
            .unwrap_or_else(|| minimax_default_voice(r).to_string());
        voices.insert(r.to_string(), Value::from(v));
    }
    json!({
        "keySet": key.is_some(),
        "keyMasked": key.map(mask_api_key),
        "envKey": env_trim("MINIMAX_API_KEY").is_some(),
        "model": s.get(keys::MINIMAX_MODEL)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .or_else(|| env_trim("MINIMAX_TTS_MODEL"))
            .unwrap_or_else(|| MINIMAX_DEFAULT_MODEL.into()),
        "voices": voices,
        "translate": minimax_translate_wanted(s),
        "translateModel": minimax_translate_model(s),
    })
}

/// `parseMinimaxVoices` : valeur à enregistrer (JSON, ou `None` pour supprimer), ou message d'erreur.
pub fn parse_minimax_voices(raw: &Value) -> Result<Option<String>, String> {
    if raw.is_null() {
        return Ok(None);
    }
    if !js::truthy(Some(raw)) {
        return Err("minimaxVoices invalide".into());
    }
    // Ordre de `Object.entries` (clés « index » d'abord, comme JavaScript).
    let Value::Object(o) = js_normalize(raw.clone()) else {
        return Err("minimaxVoices invalide".into());
    };
    let plausible = jsre!(r"^[A-Za-z0-9_ ().-]{1,100}$");
    let mut out = Map::new();
    for (role, id) in &o {
        if !MINIMAX_ROLES.contains(&role.as_str()) {
            return Err(format!("Rôle de voix inconnu : {role}"));
        }
        let ok = match id {
            Value::String(s) => {
                MINIMAX_FRENCH_VOICES.iter().any(|(v, _)| v == s) || plausible.is_match(s)
            }
            _ => false,
        };
        if !ok {
            return Err(format!("Voix MiniMax invalide pour {role}"));
        }
        out.insert(role.clone(), id.clone());
    }
    Ok(if out.is_empty() {
        None
    } else {
        Some(Value::Object(out).to_string())
    })
}

/// Ce que `/api/admin/settings` renvoie (clés MASQUÉES).
pub fn settings_view(s: &Settings) -> Value {
    json!({
        "openai": openai_settings_view(s),
        "minimax": minimax_settings_view(s),
        "autoTranslate": auto_translate_enabled(s),
        "vfMode": vf_mode(s),
        "transcribeEngine": transcribe_engine(s),
        "transcribeEngineOverride": crate::media::commentary_ai::transcribe_engine_override(s),
        "voiceQuality": voice_quality(s),
        "voiceQualityOverride": crate::media::voice_ai::voice_quality_override(s),
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
        assert!(minimax_model_error("speech-2.8-turbo").is_none());
        assert!(minimax_translate_model_error("MiniMax-M3").is_none());
        assert!(minimax_translate_model_error("x").is_some());
    }

    #[test]
    fn voix_minimax() {
        assert_eq!(parse_minimax_voices(&Value::Null), Ok(None));
        assert_eq!(parse_minimax_voices(&json!({})), Ok(None));
        assert_eq!(
            parse_minimax_voices(&json!({"F": "French_Female_News Anchor", "A": "x(1)"})),
            Ok(Some(
                r#"{"F":"French_Female_News Anchor","A":"x(1)"}"#.into()
            ))
        );
        assert_eq!(
            parse_minimax_voices(&json!({"A": "ok", "1": 3})),
            Err("Rôle de voix inconnu : 1".into())
        );
        assert_eq!(
            parse_minimax_voices(&json!({"A": "é"})),
            Err("Voix MiniMax invalide pour A".into())
        );
        assert_eq!(
            parse_minimax_voices(&json!([])),
            Err("minimaxVoices invalide".into())
        );
        assert_eq!(
            parse_minimax_voices(&json!(0)),
            Err("minimaxVoices invalide".into())
        );
        let s = Settings::from_pairs([(keys::MINIMAX_VOICES, r#"{"A":"x","B4":"","F":3}"#)]);
        assert_eq!(saved_minimax_voices(&s), vec![("A", "x".to_string())]);
        let s = Settings::from_pairs([(keys::MINIMAX_VOICES, "null")]);
        assert!(saved_minimax_voices(&s).is_empty());
    }

    #[test]
    fn modes() {
        let s = Settings::from_pairs([(keys::AUTO_TRANSLATE, "0"), (keys::VF_MODE, "doublage")]);
        assert!(!auto_translate_enabled(&s));
        assert_eq!(vf_mode(&s), "doublage");
        assert!(auto_translate_enabled(&Settings::unreadable()));
        assert_eq!(vf_mode(&Settings::unreadable()), "sous-titres");
        assert!(is_vf_mode(Some(&json!("doublage"))));
        assert!(!is_vf_mode(Some(&json!(1))));
    }
}
