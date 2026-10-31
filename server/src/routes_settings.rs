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
        return Err("transcribeEngine invalide (attendu : 'whisper' ou 'nvidia')".into());
    }
    if body.contains_key("fetchParallel") && !s::is_fetch_parallel(body.get("fetchParallel")) {
        return Err("fetchParallel invalide (attendu : un entier de 1 à 32, ou null)".into());
    }
    if let Some(v) = body.get("fetchParallel") {
        updates.push((keys::FETCH_PARALLEL, v.as_u64().map(|n| n.to_string())));
    }
    if let Some(v) = body.get("minimaxTranslate") {
        let Some(b) = v.as_bool() else {
            return Err("minimaxTranslate invalide (attendu : true ou false)".into());
        };
        updates.push((
            keys::MINIMAX_TRANSLATE,
            Some(if b { "1" } else { "0" }.into()),
        ));
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
                ("auto_translate", Some("0".into())),
                ("vf_mode", Some("doublage".into())),
            ])
        );
    }

    #[test]
    fn moteur_de_transcription() {
        for bad in [
            json!({"transcribeEngine": "parakeet"}),
            json!({"transcribeEngine": null}),
        ] {
            assert_eq!(
                plan(bad),
                Err("transcribeEngine invalide (attendu : 'whisper' ou 'nvidia')".into())
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
}
