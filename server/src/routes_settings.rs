//! `GET/POST /api/admin/settings` (équivalent de
//! `src/app/api/admin/settings/route.ts`) : configuration OpenAI et MiniMax
//! (clés MASQUÉES), traduction automatique, version française.
//! Administrateurs seulement. La route ne fait que lire et écrire la table
//! `settings` ; Node relit cette table à chaque usage.

use crate::api::{error, json_response};
use crate::routes::{db_error, guarded};
use crate::routes_auth::require_admin;
use crate::settings::{self as s, keys, Settings};
use crate::state::AppState;
use crate::writes::read_json_write;
use axum::extract::{OriginalUri, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value};

/// `GET /api/admin/settings`.
pub async fn get(State(st): State<AppState>, uri: OriginalUri, headers: HeaderMap) -> Response {
    let fut = async {
        if let Err(r) = require_admin(&st, &headers).await {
            return r;
        }
        match st.db.run(Settings::load).await {
            Ok(set) => json_response(StatusCode::OK, &s::settings_view(&set)),
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

type Check = fn(&str) -> Option<&'static str>;

/// Champs texte : (champ du corps, clé de la table, validation).
const TEXT_FIELDS: [(&str, &str, Check); 5] = [
    ("openaiApiKey", keys::OPENAI_API_KEY, s::api_key_error),
    ("openaiModel", keys::OPENAI_MODEL, s::model_error),
    ("minimaxApiKey", keys::MINIMAX_API_KEY, s::minimax_key_error),
    ("minimaxModel", keys::MINIMAX_MODEL, s::minimax_model_error),
    (
        "minimaxTranslateModel",
        keys::MINIMAX_TRANSLATE_MODEL,
        s::minimax_translate_model_error,
    ),
];

/// Écritures à faire, dans l'ordre de Node ; toute la requête est validée
/// avant la première écriture : une requête invalide ne change rien.
fn plan_updates(body: &Map<String, Value>) -> Result<Vec<(&'static str, Option<String>)>, String> {
    let mut updates: Vec<(&'static str, Option<String>)> = Vec::new();
    for (field, key, check) in TEXT_FIELDS {
        let Some(raw) = body.get(field) else { continue };
        let value = match raw {
            Value::Null => None,
            Value::String(v) => Some(crate::js::trim(v).to_string()).filter(|v| !v.is_empty()),
            _ => return Err(format!("{field} invalide")),
        };
        if let Some(e) = value.as_deref().and_then(check) {
            return Err(e.into());
        }
        updates.push((key, value));
    }
    if body.get("autoTranslate").is_some_and(|v| !v.is_boolean()) {
        return Err("autoTranslate invalide (attendu : true ou false)".into());
    }
    if body.contains_key("vfMode") && !s::is_vf_mode(body.get("vfMode")) {
        return Err("vfMode invalide (attendu : 'sous-titres' ou 'doublage')".into());
    }
    if body.contains_key("transcribeEngine")
        && !s::is_transcribe_engine(body.get("transcribeEngine"))
    {
        return Err(
            "transcribeEngine invalide (attendu : 'whisper', 'whisper-large' ou 'nvidia')".into(),
        );
    }
    if body.contains_key("fetchParallel") && !s::is_fetch_parallel(body.get("fetchParallel")) {
        return Err("fetchParallel invalide (attendu : un entier de 1 à 32, ou null)".into());
    }
    if let Some(v) = body.get("fetchParallel") {
        updates.push((keys::FETCH_PARALLEL, v.as_u64().map(|n| n.to_string())));
    }
    if let Some(v) = body.get("extraNames") {
        let names = match v {
            Value::Null => None,
            Value::String(s) if s.chars().count() <= 4000 => {
                Some(crate::js::trim(s).to_string()).filter(|s| !s.is_empty())
            }
            _ => {
                return Err(
                    "extraNames invalide (attendu : un texte de 4000 caractères au plus)".into(),
                )
            }
        };
        updates.push((keys::EXTRA_NAMES, names));
    }
    if let Some(v) = body.get("translateRepairModel") {
        let model = match v {
            Value::Null => None,
            Value::String(m) => Some(crate::js::trim(m).to_string()).filter(|m| !m.is_empty()),
            _ => {
                return Err(
                    "translateRepairModel invalide (attendu : un nom de modèle ou null)".into(),
                )
            }
        };
        if model
            .as_ref()
            .is_some_and(|m| m.len() > 100 || m.chars().any(char::is_control))
        {
            return Err(
                "translateRepairModel invalide (attendu : un nom de modèle ou null)".into(),
            );
        }
        updates.push((keys::TRANSLATE_REPAIR_MODEL, model));
    }
    if body.contains_key("translateEngine") && !s::is_translate_engine(body.get("translateEngine"))
    {
        return Err("translateEngine invalide (attendu : 'local', 'minimax' ou 'openai')".into());
    }
    if let Some(e) = body.get("translateEngine").and_then(Value::as_str) {
        updates.push((keys::TRANSLATE_ENGINE, Some(e.to_string())));
        // La case « traduction par MiniMax » du panneau MiniMax suit ce choix.
        if !body.contains_key("minimaxTranslate") {
            updates.push((
                keys::MINIMAX_TRANSLATE,
                Some(if e == "minimax" { "1" } else { "0" }.into()),
            ));
        }
    }
    if let Some(v) = body.get("translateLocalModel") {
        let model = match v {
            Value::Null => None,
            Value::String(m) => {
                let m = crate::js::trim(m).to_string();
                if !m.is_empty() && s::model_error(&m).is_some() {
                    return Err("translateLocalModel invalide (nom de modèle Ollama)".into());
                }
                Some(m).filter(|m| !m.is_empty())
            }
            _ => return Err("translateLocalModel invalide (nom de modèle Ollama)".into()),
        };
        updates.push((keys::TRANSLATE_LOCAL_MODEL, model));
    }
    if let Some(v) = body.get("voxtralUrl") {
        let url = match v {
            Value::Null => None,
            Value::String(u) => {
                if let Some(e) = crate::media::voice_voxtral::voxtral_url_error(u) {
                    return Err(e.into());
                }
                Some(crate::js::trim(u).trim_end_matches('/').to_string()).filter(|u| !u.is_empty())
            }
            _ => return Err("voxtralUrl invalide (attendu : une adresse http(s) ou null)".into()),
        };
        updates.push((keys::VOXTRAL_URL, url));
    }
    if let Some(v) = body.get("voxtralVoices") {
        let ok_role = |r: &str| s::MINIMAX_ROLES.contains(&r);
        let ok_voice = |x: &Value| {
            x.as_str()
                .is_some_and(|x| crate::media::voice_voxtral::VOXTRAL_VOICES.contains(&x))
        };
        match v {
            Value::Null => updates.push((keys::VOXTRAL_VOICES, None)),
            Value::Object(m) if m.iter().all(|(r, x)| ok_role(r) && ok_voice(x)) => {
                updates.push((keys::VOXTRAL_VOICES, Some(v.to_string())));
            }
            _ => {
                return Err(
                    "voxtralVoices invalide (attendu : { A, B4, B1, F } vers une voix Voxtral)"
                        .into(),
                )
            }
        }
    }
    if let Some(v) = body.get("minimaxTranslate") {
        let Some(b) = v.as_bool() else {
            return Err("minimaxTranslate invalide (attendu : true ou false)".into());
        };
        updates.push((
            keys::MINIMAX_TRANSLATE,
            Some(if b { "1" } else { "0" }.into()),
        ));
        // Et le « Moteur de traduction » suit la case : MiniMax, ou plus de choix imposé.
        if !body.contains_key("translateEngine") {
            updates.push((keys::TRANSLATE_ENGINE, b.then(|| "minimax".into())));
        }
    }
    if let Some(v) = body.get("minimaxVoices") {
        updates.push((keys::MINIMAX_VOICES, s::parse_minimax_voices(v)?));
    }
    if let Some(b) = body.get("autoTranslate").and_then(Value::as_bool) {
        updates.push((keys::AUTO_TRANSLATE, Some(if b { "1" } else { "0" }.into())));
    }
    if s::is_vf_mode(body.get("vfMode")) {
        let mode = body
            .get("vfMode")
            .and_then(Value::as_str)
            .unwrap_or_default();
        updates.push((keys::VF_MODE, Some(mode.to_string())));
    }
    if let Some(engine) = body.get("transcribeEngine").and_then(Value::as_str) {
        updates.push((keys::TRANSCRIBE_ENGINE, Some(engine.to_string())));
    }
    if body.contains_key("voiceEngine") && !s::is_voice_engine(body.get("voiceEngine")) {
        return Err("voiceEngine invalide (attendu : 'local' ou 'minimax')".into());
    }
    if let Some(e) = body.get("voiceEngine").and_then(Value::as_str) {
        updates.push((keys::VOICE_ENGINE, Some(e.to_string())));
    }
    if body.contains_key("voiceQuality") && !s::is_voice_quality(body.get("voiceQuality")) {
        return Err("voiceQuality invalide (attendu : 'standard' ou 'hd')".into());
    }
    if let Some(q) = body.get("voiceQuality").and_then(Value::as_str) {
        updates.push((keys::VOICE_QUALITY, Some(q.to_string())));
    }
    Ok(updates)
}

/// `POST /api/admin/settings` : champ absent = inchangé ; null ou chaîne vide = supprimé.
pub async fn post(State(st): State<AppState>, uri: OriginalUri, req: Request) -> Response {
    let headers = req.headers().clone();
    let st2 = st.clone();
    let fut = async move {
        let (parts, body) = req.into_parts();
        if let Err(r) = require_admin(&st2, &parts.headers).await {
            return r;
        }
        let body = match read_json_write(&parts.headers, body).await {
            Ok(b) => b,
            Err(r) => return r,
        };
        let updates = match plan_updates(&body) {
            Ok(u) => u,
            Err(e) => return error(StatusCode::BAD_REQUEST, &e),
        };
        let r = st2
            .db
            .run(move |c| {
                for (key, value) in &updates {
                    s::setting_set(c, key, value.as_deref())?;
                }
                Settings::load(c)
            })
            .await;
        match r {
            Ok(set) => {
                s::apply_fetch_parallel(&set);
                // Moteur NVIDIA choisi : modèle téléchargé tout de suite, pas à
                // la première traduction.
                if body.get("transcribeEngine").and_then(Value::as_str) == Some("nvidia")
                    && crate::media::commentary_ai::transcribe_engine_override(&set).is_none()
                {
                    crate::media::local_ai::prefetch_parakeet();
                }
                let mut out = Map::new();
                out.insert("ok".into(), Value::Bool(true));
                if let Value::Object(v) = s::settings_view(&set) {
                    out.extend(v);
                }
                json_response(StatusCode::OK, &Value::Object(out))
            }
            Err(e) => db_error(e),
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

#[cfg(test)]
mod tests {
    use super::plan_updates;
    use serde_json::{json, Value};

    fn plan(v: Value) -> Result<Vec<(&'static str, Option<String>)>, String> {
        plan_updates(v.as_object().expect("objet"))
    }

    #[test]
    fn validation_dans_l_ordre_de_node() {
        assert_eq!(
            plan(json!({"openaiModel": 3, "openaiApiKey": "x"})),
            Err("La clé API semble invalide (longueur inattendue).".into())
        );
        assert_eq!(
            plan(json!({"openaiModel": 3})),
            Err("openaiModel invalide".into())
        );
        assert_eq!(
            plan(json!({"autoTranslate": "1", "vfMode": "x"})),
            Err("autoTranslate invalide (attendu : true ou false)".into())
        );
        assert_eq!(
            plan(json!({"vfMode": null})),
            Err("vfMode invalide (attendu : 'sous-titres' ou 'doublage')".into())
        );
        assert_eq!(
            plan(
                json!({"openaiApiKey": "  ", "minimaxTranslate": true, "vfMode": "doublage", "autoTranslate": false})
            ),
            Ok(vec![
                ("openai_api_key", None),
                ("minimax_translate", Some("1".into())),
                ("translate_engine", Some("minimax".into())),
                ("auto_translate", Some("0".into())),
                ("vf_mode", Some("doublage".into())),
            ])
        );
    }

    #[test]
    fn qualite_des_voix() {
        assert_eq!(
            plan(json!({"voiceQuality": "hd"})),
            Ok(vec![("voice_quality", Some("hd".into()))])
        );
        for bad in [
            json!({"voiceQuality": "max"}),
            json!({"voiceQuality": null}),
        ] {
            assert!(plan(bad).is_err());
        }
        let s = |v: Option<&str>| {
            crate::settings::Settings::from_pairs(v.map(|v| ("voice_quality", v)))
        };
        assert_eq!(crate::settings::voice_quality(&s(None)), "standard");
        assert_eq!(crate::settings::voice_quality(&s(Some("hd"))), "hd");
        assert_eq!(crate::settings::voice_quality(&s(Some("x"))), "standard");
        assert_eq!(
            plan(json!({"voiceEngine": "local", "voiceQuality": "hd"})),
            Ok(vec![
                ("voice_engine", Some("local".into())),
                ("voice_quality", Some("hd".into()))
            ])
        );
        assert!(plan(json!({"voiceEngine": "google"})).is_err());
        assert_eq!(
            plan(
                json!({"voiceEngine": "voxtral", "voxtralUrl": " http://nas:8000/v1/ ", "voxtralVoices": {"A": "fr_male", "F": "fr_female"}})
            ),
            Ok(vec![
                ("voxtral_url", Some("http://nas:8000/v1".into())),
                (
                    "voxtral_voices",
                    Some(r#"{"A":"fr_male","F":"fr_female"}"#.into())
                ),
                ("voice_engine", Some("voxtral".into())),
            ])
        );
        assert!(plan(json!({"voxtralUrl": "nas"})).is_err());
        assert_eq!(
            plan(
                json!({"translateEngine": "local", "translateLocalModel": "hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q8_0"})
            ),
            Ok(vec![
                ("translate_engine", Some("local".into())),
                ("minimax_translate", Some("0".into())),
                (
                    "translate_local_model",
                    Some("hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q8_0".into())
                ),
            ])
        );
        assert!(plan(json!({"translateEngine": "deepl"})).is_err());
        assert!(plan(json!({"translateLocalModel": "a b"})).is_err());
        assert!(plan(json!({"voxtralVoices": {"A": "robot"}})).is_err());
        assert!(plan(json!({"voxtralVoices": {"Z": "fr_male"}})).is_err());
    }

    #[test]
    fn moteur_de_transcription() {
        for bad in [
            json!({"transcribeEngine": "parakeet"}),
            json!({"transcribeEngine": null}),
        ] {
            assert_eq!(
                plan(bad),
                Err(
                    "transcribeEngine invalide (attendu : 'whisper', 'whisper-large' ou 'nvidia')"
                        .into()
                )
            );
        }
        assert_eq!(
            plan(json!({"transcribeEngine": "nvidia"})),
            Ok(vec![("transcribe_engine", Some("nvidia".into()))])
        );
        let s = |v: Option<&str>| {
            crate::settings::Settings::from_pairs(v.map(|v| ("transcribe_engine", v)))
        };
        assert_eq!(crate::settings::transcribe_engine(&s(None)), "whisper");
        assert_eq!(
            crate::settings::transcribe_engine(&s(Some("nvidia"))),
            "nvidia"
        );
        assert_eq!(crate::settings::transcribe_engine(&s(Some("x"))), "whisper");
        assert_eq!(
            plan(json!({"transcribeEngine": "whisper-large"})),
            Ok(vec![("transcribe_engine", Some("whisper-large".into()))])
        );
        assert_eq!(
            crate::settings::transcribe_engine(&s(Some("whisper-large"))),
            "whisper-large"
        );
        assert_eq!(
            crate::settings::settings_view(&s(Some("nvidia")))["transcribeEngine"],
            "nvidia"
        );
    }

    #[test]
    fn connexions_paralleles() {
        for bad in [
            json!({"fetchParallel": 0}),
            json!({"fetchParallel": 33}),
            json!({"fetchParallel": "8"}),
            json!({"fetchParallel": 4.5}),
        ] {
            assert_eq!(
                plan(bad),
                Err("fetchParallel invalide (attendu : un entier de 1 à 32, ou null)".into())
            );
        }
        assert_eq!(
            plan(json!({"fetchParallel": 24})),
            Ok(vec![("fetch_parallel", Some("24".into()))])
        );
        assert_eq!(
            plan(json!({"fetchParallel": null})),
            Ok(vec![("fetch_parallel", None)])
        );
        let s = |v: Option<&str>| {
            crate::settings::Settings::from_pairs(v.map(|v| ("fetch_parallel", v)))
        };
        assert_eq!(crate::settings::fetch_parallel(&s(None)), None);
        assert_eq!(crate::settings::fetch_parallel(&s(Some("24"))), Some(24));
        assert_eq!(crate::settings::fetch_parallel(&s(Some("99"))), None);
        assert_eq!(
            crate::settings::settings_view(&s(Some("4")))["fetchParallel"],
            4
        );
    }

    #[test]
    fn modele_de_secours() {
        assert_eq!(
            plan(json!({"translateRepairModel": "  MiniMax-M3 "})),
            Ok(vec![("translate_repair_model", Some("MiniMax-M3".into()))])
        );
        for empty in [
            json!({"translateRepairModel": null}),
            json!({"translateRepairModel": ""}),
        ] {
            assert_eq!(plan(empty), Ok(vec![("translate_repair_model", None)]));
        }
        let view = |v: Option<&'static str>| {
            let s = crate::settings::Settings::from_pairs(v.map(|v| ("translate_repair_model", v)));
            crate::settings::settings_view(&s)["translateRepairModel"].clone()
        };
        assert_eq!(view(None), "MiniMax-M3");
        assert_eq!(view(Some("aucun")), Value::Null);
        assert!(plan(json!({"translateRepairModel": 3})).is_err());
        assert!(plan(json!({"translateRepairModel": "a\nb"})).is_err());
        let s =
            crate::settings::Settings::from_pairs(Some(("translate_repair_model", "MiniMax-M3")));
        assert_eq!(
            crate::settings::settings_view(&s)["translateRepairModel"],
            "MiniMax-M3"
        );
    }

    #[test]
    fn noms_a_respecter() {
        assert_eq!(
            plan(json!({"extraNames": " Kevin Ray\nJoker "})),
            Ok(vec![("extra_names", Some("Kevin Ray\nJoker".into()))])
        );
        assert_eq!(
            plan(json!({"extraNames": ""})),
            Ok(vec![("extra_names", None)])
        );
        assert!(plan(json!({"extraNames": 1})).is_err());
        assert!(plan(json!({"extraNames": "x".repeat(4001)})).is_err());
        let s = crate::settings::Settings::from_pairs(Some((
            "extra_names",
            "Kevin Ray\nEddie Johnson, Joker;Kevin Ray",
        )));
        assert_eq!(
            crate::settings::extra_names(&s),
            vec!["Kevin Ray", "Eddie Johnson", "Joker"]
        );
    }
}
