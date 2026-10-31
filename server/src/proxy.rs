//! Relais transparent vers l'application Node : méthode, chemin, en-têtes
//! (Host compris : les contrôles d'origine de Node le comparent à `Origin`)
//! et corps en flux, dans les deux sens — rien n'est mis en mémoire, les
//! vidéos et segments HLS passent tels quels.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;

use crate::state::AppState;

#[derive(Clone)]
pub struct Upstream {
    /// `http://127.0.0.1:3013`
    base: String,
    /// Origines sous lesquelles Next se croit servi (`http://localhost:3013`…) :
    /// retirées des redirections, qui deviennent relatives.
    self_origins: Vec<String>,
    client: Client<HttpConnector, Body>,
}

impl Upstream {
    pub fn new(base: &str) -> Self {
        let mut conn = HttpConnector::new();
        conn.set_nodelay(true);
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .build(conn);
        let base = base.trim_end_matches('/').to_string();
        let port = base
            .rsplit_once(':')
            .map(|(_, p)| p.to_string())
            .unwrap_or_default();
        let mut self_origins = vec![base.clone()];
        for h in ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"] {
            self_origins.push(format!("http://{h}:{port}"));
        }
        Upstream {
            base,
            self_origins,
            client,
        }
    }

    /// `http://localhost:3013/login?next=…` → `/login?next=…` : Next écrit ses
    /// redirections avec l'adresse interne sur laquelle il écoute, que le
    /// navigateur ne peut pas joindre.
    pub fn relative_location(&self, loc: &str) -> Option<String> {
        self.self_origins.iter().find_map(|o| {
            let rest = loc.strip_prefix(o.as_str())?;
            match rest.chars().next() {
                None => Some("/".to_string()),
                Some('/') => Some(rest.to_string()),
                Some('?') | Some('#') => Some(format!("/{rest}")),
                _ => None,
            }
        })
    }
}

impl Upstream {
    /// Appel interne à l'application Node (pas un relais) : POST JSON avec
    /// jeton, réponse JSON. Sert aux traitements restés côté Node (files de
    /// traduction et d'analyse).
    pub async fn post_json(
        &self,
        path: &str,
        bearer: &str,
        body: &serde_json::Value,
        timeout: std::time::Duration,
    ) -> Result<(u16, serde_json::Value), String> {
        let uri: Uri = format!("{}{path}", self.base)
            .parse()
            .map_err(|_| "URL invalide".to_string())?;
        let mut b = axum::http::Request::post(uri.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"));
        if let Some(a) = uri.authority() {
            b = b.header(header::HOST, a.as_str());
        }
        let req = b
            .body(Body::from(body.to_string()))
            .map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(timeout, async {
            let res = self.client.request(req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let bytes = http_body_util::BodyExt::collect(res.into_body())
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            Ok::<_, String>((status, bytes))
        })
        .await
        .map_err(|_| "délai dépassé".to_string())??;
        let v = serde_json::from_slice(&res.1).unwrap_or(serde_json::Value::Null);
        Ok((res.0, v))
    }
}

/// En-têtes propres à une connexion : jamais relayés.
fn strip_hop_by_hop(h: &mut HeaderMap) {
    // Les en-têtes nommés dans `Connection` le sont aussi.
    let named: Vec<HeaderName> = h
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|n| HeaderName::from_bytes(n.trim().as_bytes()).ok())
        .collect();
    for n in named {
        h.remove(n);
    }
    for n in [
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        h.remove(n);
    }
}

pub async fn forward(State(st): State<AppState>, req: Request) -> Response {
    let up = &st.upstream;
    let (mut parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let uri: Uri = match format!("{}{}", up.base, pq).parse() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "URL invalide").into_response(),
    };
    // HTTP/1.1 vers Node quelle que soit la version du client ; Host conservé.
    if !parts.headers.contains_key(header::HOST) {
        if let Some(a) = parts.uri.authority() {
            if let Ok(v) = a.as_str().parse() {
                parts.headers.insert(header::HOST, v);
            }
        }
    }
    strip_hop_by_hop(&mut parts.headers);
    parts.uri = uri;
    parts.version = axum::http::Version::HTTP_11;
    let out = axum::http::Request::from_parts(parts, body);
    match up.client.request(out).await {
        Ok(res) => {
            let (mut parts, body) = res.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            if let Some(rel) = parts
                .headers
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|l| up.relative_location(l))
            {
                if let Ok(v) = rel.parse() {
                    parts.headers.insert(header::LOCATION, v);
                }
            }
            Response::from_parts(parts, Body::new(body))
        }
        Err(e) => {
            eprintln!("[serveur] application Node injoignable : {e}");
            let mut r = (StatusCode::BAD_GATEWAY, axum::Json(serde_json::json!({ "error": "application Node injoignable (démarrage en cours ?)" })))
                .into_response();
            r.headers_mut().insert(
                header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirections_de_next_rendues_relatives() {
        let up = Upstream::new("http://127.0.0.1:3013");
        assert_eq!(
            up.relative_location("http://localhost:3013/login?next=%2Fmatchs%2F3")
                .as_deref(),
            Some("/login?next=%2Fmatchs%2F3")
        );
        assert_eq!(
            up.relative_location("http://127.0.0.1:3013").as_deref(),
            Some("/")
        );
        assert_eq!(
            up.relative_location("http://localhost:3013?x=1").as_deref(),
            Some("/?x=1")
        );
        assert_eq!(up.relative_location("http://localhost:30134/x"), None);
        assert_eq!(up.relative_location("https://ok.ru/video/1"), None);
        assert_eq!(up.relative_location("/login"), None);
    }
}
