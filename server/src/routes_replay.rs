//! `POST /api/matches/[id]/replay` — `{ action: 'check' }` (équivalent de
//! `src/app/api/matches/[id]/replay/route.ts`) : cherche le replay tout de
//! suite (match terminé sans replay, ou avec un replay MP4 seul).
//!
//! Réponse `{ video, checked, message }`, `video` étant le bloc `video` du
//! DTO de `GET /api/matches/[id]` :
//! - 200 : recherche faite (ou inutile : replay déjà là) ;
//! - 202 : recherche lancée, encore en cours (`pending: true`) ;
//! - 409 : match pas encore terminé ;
//! - 429 : dernière recherche de ce match il y a moins de 2 min
//!   (`retry_after`, en-tête `Retry-After`).
//!
//! Mêmes garde-fous que les autres écritures : session, origine contrôlée,
//! Content-Type JSON exigé.

use crate::api::{error, json_response};
use crate::db;
use crate::routes::{db_error, guarded};
use crate::routes_match::parse_id;
use crate::state::AppState;
use crate::writes::{allowed_origins, is_json_content_type, is_origin_allowed};
use axum::body::Body;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::Value;

pub async fn replay(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let fut = async {
        let Some(id) = parse_id(&raw) else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        let m = match st.db.run(move |c| db::get_match(c, id)).await {
            Ok(Some(m)) => m,
            Ok(None) => return error(StatusCode::NOT_FOUND, "match introuvable"),
            Err(e) => return db_error(e),
        };
        if !is_origin_allowed(&headers, &allowed_origins()) {
            return error(
                StatusCode::FORBIDDEN,
                "origine non autorisée pour cette écriture",
            );
        }
        if !is_json_content_type(&headers) {
            return error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Content-Type application/json requis",
            );
        }
        // `await req.json()` : tout JSON valide est accepté ici, seul
        // `action === 'check'` compte ensuite.
        let parsed = axum::body::to_bytes(body, 1 << 20)
            .await
            .ok()
            .and_then(|b| {
                let s = String::from_utf8_lossy(&b);
                serde_json::from_str::<Value>(s.strip_prefix('\u{feff}').unwrap_or(&s)).ok()
            });
        let Some(v) = parsed else {
            return error(StatusCode::BAD_REQUEST, "JSON invalide");
        };
        if v.get("action").and_then(Value::as_str) != Some("check") {
            return error(
                StatusCode::BAD_REQUEST,
                "action invalide (attendu : 'check')",
            );
        }
        let (status, body) = match st
            .replays
            .request_replay_check(&st.db, &st.upstream, m)
            .await
        {
            Ok(r) => r,
            Err(e) => return db_error(e),
        };
        let mut res = json_response(
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            &body,
        );
        if let Some(n) = body.get("retry_after").and_then(Value::as_f64) {
            if n != 0.0 {
                if let Ok(h) = HeaderValue::from_str(&crate::jsval::js_number_string(n)) {
                    res.headers_mut().insert("retry-after", h);
                }
            }
        }
        res
    };
    guarded(&st, &uri, &headers, fut).await
}
