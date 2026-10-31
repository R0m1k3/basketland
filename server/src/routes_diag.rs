//! `POST /api/diag/stall` (équivalent de `src/app/api/diag/stall/route.ts`) :
//! signalement d'un gel de lecture par le lecteur (`navigator.sendBeacon`) :
//! durée, position, qualité, débit estimé, avance du tampon. Écrit une ligne
//! dans les journaux ; ne stocke rien. Session exigée, comme chez Node
//! (`sendBeacon` envoie le cookie de la même origine).

use crate::routes::guarded;
use crate::state::AppState;
use crate::writes::{allowed_origins, is_origin_allowed};
use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Au plus une ligne de journal toutes les 5 s (un gel peut se répéter en rafale).
static LAST_LOG: Mutex<Option<Instant>> = Mutex::new(None);

/// `num` : nombre fini, sinon rien.
fn num(d: &Value, k: &str) -> Option<f64> {
    d.get(k).and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// Ligne de journal d'un gel (`ms` présent), comme Node.
pub fn stall_line(d: &Value, ms: f64) -> String {
    use crate::js::to_fixed1;
    let t = num(d, "t").unwrap_or(0.0);
    let h = num(d, "height").filter(|v| *v != 0.0);
    let br = num(d, "bitrate").filter(|v| *v != 0.0);
    let est = num(d, "estimate").filter(|v| *v != 0.0);
    let ahead = num(d, "ahead");
    let n = crate::jsval::js_number_string;
    let mmss = format!("{}:{:0>2}", n((t / 60.0).floor()), n((t % 60.0).floor()));
    let mut line = format!("[lecteur] gel de {} s à {mmss}", to_fixed1(ms / 1000.0));
    if let Some(h) = h {
        line.push_str(&format!(" · {}p", n(h)));
    }
    if let Some(br) = br {
        line.push_str(&format!(" ({} Mb/s)", to_fixed1(br / 1e6)));
    }
    if let Some(est) = est {
        line.push_str(&format!(" · débit mesuré {} Mb/s", to_fixed1(est / 1e6)));
    }
    if let Some(a) = ahead {
        line.push_str(&format!(" · tampon {} s", n(a)));
    }
    line
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

pub async fn stall(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let fut = async {
        if !is_origin_allowed(&headers, &allowed_origins()) {
            return status(StatusCode::FORBIDDEN);
        }
        let Ok(bytes) = axum::body::to_bytes(body, 1 << 20).await else {
            return status(StatusCode::BAD_REQUEST);
        };
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        if crate::js::utf16_len(text) > 2000 {
            return status(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let Ok(d) = serde_json::from_str::<Value>(text) else {
            return status(StatusCode::BAD_REQUEST);
        };
        let Some(ms) = num(&d, "ms") else {
            return status(StatusCode::BAD_REQUEST);
        };
        let now = Instant::now();
        let mut last = LAST_LOG.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_none_or(|l| now.duration_since(l) >= Duration::from_secs(5)) {
            *last = Some(now);
            println!("{}", stall_line(&d, ms));
        }
        status(StatusCode::NO_CONTENT)
    };
    guarded(&st, &uri, &headers, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Cas de tests/diag-stall.test.ts.
    #[test]
    fn ligne_de_journal_comme_node() {
        let d = json!({ "ms": 3200, "t": 754, "height": 720, "bitrate": 2_800_000, "estimate": 1_900_000, "ahead": 0 });
        assert_eq!(
            stall_line(&d, 3200.0),
            "[lecteur] gel de 3.2 s à 12:34 · 720p (2.8 Mb/s) · débit mesuré 1.9 Mb/s · tampon 0 s"
        );
        assert_eq!(
            stall_line(&json!({}), 1250.0),
            "[lecteur] gel de 1.3 s à 0:00"
        );
        assert_eq!(
            stall_line(&json!({ "t": 65.9, "height": 0, "ahead": 1.5 }), 50.0),
            "[lecteur] gel de 0.1 s à 1:05 · tampon 1.5 s"
        );
    }
}
