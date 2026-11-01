//! Lecture des MP4 progressifs d'ok.ru par blocs, avec cache et lecture
//! anticipée (replays récents, pas encore convertis en HLS).
//!
//! Le MP4 était relayé tel quel, sur UNE connexion vers ok.ru : un match de
//! 4 Go (~4 Mb/s) sur une connexion bridée hachait sans cesse. Ici, le
//! fichier est découpé en blocs de 2 Mo :
//!  - un bloc demandé par le lecteur part tout de suite ;
//!  - les blocs suivants (≈ 50 s de vidéo, `MP4_READAHEAD_BLOCKS`) se
//!    téléchargent en même temps sur plusieurs connexions (`MP4_PARALLEL`) ;
//!  - les blocs restent dans un cache borné (`MP4_CACHE_MB`) : revenir en
//!    arrière ou reprendre la lecture ne retélécharge rien ;
//!  - un même bloc n'est jamais téléchargé deux fois en même temps, et un
//!    téléchargement va au bout même si le lecteur s'en va (bloc en cache).
//!
//! Les octets passent par le proxy vidéo ([`RangeFetch`]) : mêmes en-têtes,
//! mêmes règles de redirection, reprise sur blocage et lien expiré re-résolu.

use crate::video::ByteLru;
use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

/// Taille d'un bloc.
pub const BLOCK: u64 = 2 << 20;

/// Octets `début..=fin` du MP4 ; rend aussi la taille totale du fichier.
/// Erreur `HTTP 416 …` : début au-delà de la fin du fichier.
pub type RangeFetch =
    Arc<dyn Fn(u64, u64) -> BoxFuture<'static, Result<(Bytes, u64), String>> + Send + Sync>;

type Fetch = Shared<BoxFuture<'static, Result<Bytes, String>>>;

struct State {
    cache: ByteLru<Bytes>,
    inflight: HashMap<String, Fetch>,
    /// Taille totale de chaque fichier (clé : okId et qualité).
    totals: HashMap<String, u64>,
}

struct Inner {
    st: Mutex<State>,
    /// Téléchargements anticipés simultanés (le bloc attendu passe devant).
    slots: Semaphore,
    readahead: u64,
}

/// Cache des blocs MP4 d'un proxy vidéo.
#[derive(Clone)]
pub struct Mp4Cache(Arc<Inner>);

fn hv(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn base_headers(r: &mut Response) {
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    // La qualité servie peut changer d'une session à l'autre : pas de cache navigateur.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` → plage `[a, b]` d'un fichier de
/// `total` octets ; `Some(None)` : pas de plage (ou illisible : fichier
/// entier) ; `None` : plage hors du fichier.
pub fn parse_range(range: Option<&str>, total: u64) -> Option<Option<(u64, u64)>> {
    let Some(r) = range else {
        return Some(None);
    };
    let Some(spec) = r
        .trim()
        .strip_prefix("bytes=")
        .and_then(|s| s.split(',').next())
    else {
        return Some(None);
    };
    let Some((a, b)) = spec.trim().split_once('-') else {
        return Some(None);
    };
    let (a, b) = (a.trim(), b.trim());
    let last = total.saturating_sub(1);
    let (start, end) = if a.is_empty() {
        let Ok(n) = b.parse::<u64>() else {
            return Some(None);
        };
        (total.saturating_sub(n), last)
    } else {
        let Ok(start) = a.parse::<u64>() else {
            return Some(None);
        };
        let end = if b.is_empty() {
            last
        } else {
            match b.parse::<u64>() {
                Ok(e) => e.min(last),
                Err(_) => return Some(None),
            }
        };
        (start, end)
    };
    (start <= end && start < total).then_some(Some((start, end)))
}

impl Mp4Cache {
    /// `max_bytes` : taille du cache ; `parallel` : téléchargements anticipés
    /// simultanés ; `readahead` : blocs lus d'avance.
    pub fn new(max_bytes: u64, parallel: usize, readahead: u64) -> Self {
        Mp4Cache(Arc::new(Inner {
            st: Mutex::new(State {
                cache: ByteLru::new(max_bytes),
                inflight: HashMap::new(),
                totals: HashMap::new(),
            }),
            slots: Semaphore::new(parallel.max(1)),
            readahead,
        }))
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bloc `k` : cache, sinon téléchargement en cours, sinon nouveau
    /// téléchargement (`urgent` : sans attendre une place de lecture anticipée).
    fn block(&self, file: &str, fetch: &RangeFetch, k: u64, urgent: bool) -> Fetch {
        let key = format!("{file}#{k}");
        let mut st = self.st();
        if let Some(b) = st.cache.get(&key) {
            return async move { Ok(b) }.boxed().shared();
        }
        if let Some(f) = st.inflight.get(&key) {
            return f.clone();
        }
        let (me, fetch, file, key2) = (self.clone(), fetch.clone(), file.to_string(), key.clone());
        let fut: Fetch = async move {
            let _slot = if urgent {
                None
            } else {
                me.0.slots.acquire().await.ok()
            };
            let r = fetch(k * BLOCK, (k + 1) * BLOCK - 1).await;
            let mut st = me.st();
            st.inflight.remove(&key2);
            let (bytes, total) = r?;
            st.totals.insert(file, total);
            st.cache.set(&key2, bytes.clone(), bytes.len() as u64);
            Ok(bytes)
        }
        .boxed()
        .shared();
        st.inflight.insert(key, fut.clone());
        drop(st);
        tokio::spawn(fut.clone());
        fut
    }

    /// Lance la lecture anticipée des blocs `from..=to` absents du cache.
    fn read_ahead(&self, file: &str, fetch: &RangeFetch, total: u64, from: u64, to: u64) {
        let last = total.div_ceil(BLOCK).saturating_sub(1);
        for k in from..=to.min(last) {
            let key = format!("{file}#{k}");
            let known = {
                let st = self.st();
                st.cache.has(&key) || st.inflight.contains_key(&key)
            };
            if !known {
                drop(self.block(file, fetch, k, false));
            }
        }
    }

    /// Sert la plage `range` du MP4 `file` (clé stable : okId et qualité).
    pub async fn serve(
        &self,
        file: &str,
        fetch: RangeFetch,
        range: Option<&str>,
    ) -> Result<Response, String> {
        // Taille inconnue : le premier bloc la donne (le lecteur commence par là).
        let known = self.st().totals.get(file).copied();
        let total = match known {
            Some(t) => t,
            None => {
                self.block(file, &fetch, 0, true).await?;
                let t = self.st().totals.get(file).copied();
                t.ok_or("taille du MP4 inconnue")?
            }
        };
        let Some(span) = parse_range(range, total) else {
            let mut r = Response::new(Body::empty());
            *r.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            base_headers(&mut r);
            r.headers_mut()
                .insert(header::CONTENT_RANGE, hv(&format!("bytes */{total}")));
            return Ok(r);
        };
        let (start, end) = span.unwrap_or((0, total.saturating_sub(1)));
        let (me, file2) = (self.clone(), file.to_string());
        let ahead = self.0.readahead;
        let body = futures_util::stream::unfold(start, move |pos| {
            let (me, file, fetch) = (me.clone(), file2.clone(), fetch.clone());
            async move {
                if pos > end {
                    return None;
                }
                let k = pos / BLOCK;
                me.read_ahead(&file, &fetch, total, k + 1, k + ahead);
                match me.block(&file, &fetch, k, true).await {
                    Ok(bytes) => {
                        let off = (pos - k * BLOCK) as usize;
                        let stop = bytes.len().min((end - k * BLOCK + 1) as usize);
                        if off >= stop {
                            return Some((
                                Err(std::io::Error::other("bloc MP4 incomplet")),
                                end + 1,
                            ));
                        }
                        Some((Ok(bytes.slice(off..stop)), k * BLOCK + stop as u64))
                    }
                    Err(e) => {
                        eprintln!("[vidéo] bloc MP4 {k} indisponible : {e}");
                        Some((Err(std::io::Error::other(e)), end + 1))
                    }
                }
            }
        });
        let mut r = Response::new(Body::from_stream(body));
        base_headers(&mut r);
        if span.is_some() {
            *r.status_mut() = StatusCode::PARTIAL_CONTENT;
            r.headers_mut().insert(
                header::CONTENT_RANGE,
                hv(&format!("bytes {start}-{end}/{total}")),
            );
        }
        r.headers_mut()
            .insert(header::CONTENT_LENGTH, hv(&(end - start + 1).to_string()));
        Ok(r)
    }

    /// Octets gardés en cache (tests, journal).
    pub fn cached_bytes(&self) -> u64 {
        self.st().cache.bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn plages() {
        assert_eq!(parse_range(None, 100), Some(None));
        assert_eq!(parse_range(Some("bytes=0-"), 100), Some(Some((0, 99))));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Some(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Some(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_range(Some("items=0-1"), 100), Some(None));
    }
}
