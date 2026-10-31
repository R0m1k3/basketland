//! Routes du proxy vidéo ok.ru (`/api/video/[okId]/…`), protégées par
//! session comme toutes les routes d'API (pas dans les chemins publics).

use crate::api::Query;
use crate::routes::guarded;
use crate::state::AppState;
use crate::video::{m3u8_response, VErr};
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;

fn respond(r: Result<Response, VErr>) -> Response {
    r.unwrap_or_else(|e| e.response())
}

fn range(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::RANGE)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
}

/// Playlist maître : variantes réécrites vers le proxy.
pub async fn master(
    State(st): State<AppState>,
    Path(ok_id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async { respond(st.video.master(&st.db, &ok_id).await.map(m3u8_response)) };
    guarded(&st, &uri, &headers, fut).await
}

/// Playlist média d'une variante (`?v=sd|hd|full|…`) : segments réécrits vers /segment.ts.
pub async fn playlist(
    State(st): State<AppState>,
    Path(ok_id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let q = Query::parse(uri.query());
    let fut = async {
        respond(
            st.video
                .media(&st.db, &ok_id, q.get("v"))
                .await
                .map(m3u8_response),
        )
    };
    guarded(&st, &uri, &headers, fut).await
}

/// Segment MPEG-TS (`?v=&s=`), Range pris en charge.
pub async fn segment(
    State(st): State<AppState>,
    Path(ok_id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let q = Query::parse(uri.query());
    let r = range(&headers);
    let fut = async {
        respond(
            st.video
                .segment(&st.db, &ok_id, q.get("v"), q.get("s"), r.as_deref())
                .await,
        )
    };
    guarded(&st, &uri, &headers, fut).await
}

/// Ressource HLS annexe (`?v=&a=`) : clé `#EXT-X-KEY`, segment `#EXT-X-MAP`.
pub async fn asset(
    State(st): State<AppState>,
    Path(ok_id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let q = Query::parse(uri.query());
    let fut = async { respond(st.video.asset(&st.db, &ok_id, q.get("v"), q.get("a")).await) };
    guarded(&st, &uri, &headers, fut).await
}

/// MP4 progressif (replay pas encore converti en HLS), Range dans les deux
/// sens ; le téléchargement amont s'arrête quand le navigateur abandonne.
pub async fn file_mp4(
    State(st): State<AppState>,
    Path(ok_id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let r = range(&headers);
    let fut = async { respond(st.video.mp4(&st.db, &ok_id, r.as_deref()).await) };
    guarded(&st, &uri, &headers, fut).await
}
