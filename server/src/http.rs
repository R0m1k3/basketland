//! Client HTTP sortant (équivalent de `src/lib/http.ts`) : User-Agent de
//! navigateur, délai de 20 s, 2 nouvelles tentatives sur erreur réseau ou 5xx.

use reqwest::Client;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

pub const BROWSER_UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

pub fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .user_agent(BROWSER_UA)
            .timeout(Duration::from_secs(20))
            .build()
            .expect("client HTTP")
    })
}

/// GET avec nouvelles tentatives ; rend la dernière réponse (même en erreur 4xx).
pub async fn get_with_retry(
    url: &str,
    accept: &str,
    retries: u32,
) -> Result<reqwest::Response, String> {
    let mut last = String::new();
    for attempt in 0..=retries {
        match client()
            .get(url)
            .header("Accept", accept)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
        {
            Ok(res) if res.status().is_server_error() && attempt < retries => {
                last = format!("HTTP {} pour {url}", res.status().as_u16())
            }
            Ok(res) => return Ok(res),
            Err(e) => {
                last = if e.is_timeout() {
                    "The operation was aborted due to timeout".into()
                } else {
                    "fetch failed".into()
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
    }
    Err(last)
}

/// `fetchJson` : JSON d'une URL, erreur `HTTP <statut> pour <url>` hors 2xx.
pub async fn fetch_json(url: &str) -> Result<Value, String> {
    let res = get_with_retry(url, "application/json", 2).await?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} pour {url}", res.status().as_u16()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    crate::jsval::js_parse(&text).ok_or_else(|| format!("réponse JSON invalide pour {url}"))
}
