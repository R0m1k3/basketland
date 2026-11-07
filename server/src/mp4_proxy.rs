//! Lecture des MP4 progressifs d'ok.ru par blocs, avec cache et lecture
//! anticipée (replays récents, pas encore convertis en HLS).
//!
//! Le MP4 était relayé tel quel, sur UNE connexion vers ok.ru : un match de
//! 4 Go (~4 Mb/s) sur une connexion bridée hachait sans cesse. Ici, le
//! fichier est découpé en blocs de 1 Mo :
//!  - un bloc demandé par le lecteur part tout de suite, en 4 morceaux
//!    parallèles (ok.ru bride chaque connexion : ≈ 1 s au lieu de 4 après
//!    un saut) ;
//!  - les blocs suivants (≈ 110 s de vidéo en 720p, `MP4_READAHEAD_BLOCKS`) se
//!    téléchargent DANS L'ORDRE, `MP4_PARALLEL` à la fois : dès qu'un bloc
//!    arrive, le premier bloc manquant de la fenêtre part. (Lancés tous
//!    ensemble, ils se disputaient les places au hasard : le bloc attendu
//!    par le lecteur pouvait passer après des blocs d'une minute plus loin,
//!    d'où des gels de 8 à 12 s.)
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Taille d'un bloc. ok.ru bride chaque connexion à ≈ 2 Mb/s : un bloc de
/// 1 Mo arrive en ≈ 4 s (un saut dans la vidéo attend un bloc entier).
pub const BLOCK: u64 = 1 << 20;

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
    /// Fenêtre de lecture anticipée de chaque fichier (la dernière demandée).
    windows: HashMap<String, Window>,
}

/// Blocs `from..=to` à garder d'avance pour un fichier.
struct Window {
    fetch: RangeFetch,
    total: u64,
    from: u64,
    to: u64,
}

struct Inner {
    st: Mutex<State>,
    /// Blocs téléchargés en même temps par fichier (le bloc attendu par le
    /// lecteur part toujours, en plus).
    parallel: usize,
    readahead: u64,
    /// Dernier bloc envoyé au lecteur (ms depuis `t0`). Un MP4 se lit sur UNE
    /// longue requête : sans ce repère, le proxy se croyait inactif après
    /// `VIDEO_CACHE_IDLE_MIN` et vidait le cache en pleine lecture (micro-gels).
    last_use_ms: AtomicU64,
    t0: Instant,
}

/// Morceaux parallèles d'un bloc attendu par le lecteur.
const URGENT_PARTS: u64 = 4;
/// Blocs téléchargés en morceaux parallèles au début d'une plage (lecture, saut).
const URGENT_BLOCKS: u64 = 3;

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
                windows: HashMap::new(),
            }),
            parallel: parallel.max(1),
            last_use_ms: AtomicU64::new(0),
            t0: Instant::now(),
            readahead,
        }))
    }

    /// Vide le cache des blocs (les téléchargements en cours se terminent).
    pub fn clear(&self) {
        let mut st = self.st();
        st.cache.clear();
        st.windows.clear();
    }

    fn mark_used(&self) {
        let now = self.0.t0.elapsed().as_millis() as u64;
        self.0.last_use_ms.store(now, Ordering::Relaxed);
    }

    /// Millisecondes depuis le dernier bloc envoyé au lecteur.
    pub fn idle_ms(&self) -> u64 {
        let now = self.0.t0.elapsed().as_millis() as u64;
        now.saturating_sub(self.0.last_use_ms.load(Ordering::Relaxed))
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bloc `k` : cache, sinon téléchargement en cours, sinon nouveau
    /// téléchargement (`urgent` : attendu par le lecteur, en morceaux
    /// parallèles quand le bloc est entier dans un fichier de taille connue —
    /// la page charge le début du MP4 dès son ouverture —, d'un seul tenant
    /// sinon ou si le découpage échoue).
    fn block(&self, file: &str, fetch: &RangeFetch, k: u64, urgent: bool) -> Fetch {
        let key = format!("{file}#{k}");
        let mut st = self.st();
        if let Some(b) = st.cache.get(&key) {
            return async move { Ok(b) }.boxed().shared();
        }
        if let Some(f) = st.inflight.get(&key) {
            return f.clone();
        }
        let split = urgent && st.totals.get(file).is_some_and(|t| (k + 1) * BLOCK <= *t);
        let (me, fetch, file, key2) = (self.clone(), fetch.clone(), file.to_string(), key.clone());
        let fut: Fetch = async move {
            let r = match split {
                true => match fetch_split(&fetch, k).await {
                    Ok(r) => Ok(r),
                    Err(_) => fetch(k * BLOCK, (k + 1) * BLOCK - 1).await,
                },
                false => fetch(k * BLOCK, (k + 1) * BLOCK - 1).await,
            };
            let out = {
                let mut st = me.st();
                st.inflight.remove(&key2);
                r.map(|(bytes, total)| {
                    st.totals.insert(file.clone(), total);
                    st.cache.set(&key2, bytes.clone(), bytes.len() as u64);
                    bytes
                })
            };
            // Place libérée : le bloc manquant suivant de la fenêtre part
            // (pas après une erreur : les reprises sont déjà faites en amont).
            if out.is_ok() {
                me.refill(&file);
            }
            out
        }
        .boxed()
        .shared();
        st.inflight.insert(key, fut.clone());
        drop(st);
        tokio::spawn(fut.clone());
        fut
    }

    /// Fenêtre de lecture anticipée : blocs `from..=to` du fichier.
    fn read_ahead(&self, file: &str, fetch: &RangeFetch, total: u64, from: u64, to: u64) {
        self.st().windows.insert(
            file.to_string(),
            Window {
                fetch: fetch.clone(),
                total,
                from,
                to,
            },
        );
        self.refill(file);
    }

    /// Lance, dans l'ordre, les premiers blocs manquants de la fenêtre, tant
    /// que moins de `parallel` blocs du fichier sont en cours.
    fn refill(&self, file: &str) {
        let (fetch, todo) = {
            let st = self.st();
            let Some(w) = st.windows.get(file) else {
                return;
            };
            let last = w.total.div_ceil(BLOCK).saturating_sub(1);
            let prefix = format!("{file}#");
            let mut busy = st
                .inflight
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .count();
            let mut todo = Vec::new();
            for k in w.from..=w.to.min(last) {
                if busy >= self.0.parallel {
                    break;
                }
                let key = format!("{file}#{k}");
                if st.cache.has(&key) || st.inflight.contains_key(&key) {
                    continue;
                }
                todo.push(k);
                busy += 1;
            }
            (w.fetch.clone(), todo)
        };
        for k in todo {
            drop(self.block(file, &fetch, k, false));
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
        // Début de lecture ou saut : les premiers blocs partent tous en
        // morceaux parallèles (sinon chacun attendait ≈ 4 s, l'un après l'autre).
        let first = start / BLOCK;
        for k in first + 1..=(first + URGENT_BLOCKS - 1).min(end / BLOCK) {
            drop(self.block(file, &fetch, k, true));
        }
        let (me, file2) = (self.clone(), file.to_string());
        let ahead = self.0.readahead;
        let body = futures_util::stream::unfold(start, move |pos| {
            let (me, file, fetch) = (me.clone(), file2.clone(), fetch.clone());
            async move {
                if pos > end {
                    return None;
                }
                let k = pos / BLOCK;
                me.mark_used();
                // Le bloc attendu part d'abord, la fenêtre ensuite.
                let wanted = me.block(&file, &fetch, k, true);
                me.read_ahead(&file, &fetch, total, k + 1, k + ahead);
                match wanted.await {
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

/// Bloc `k` en `URGENT_PARTS` requêtes parallèles : ok.ru bride chaque
/// connexion, un bloc d'un seul tenant mettait ≈ 4 s à arriver. Erreur si
/// un morceau manque ou est incomplet (bloc en fin de fichier).
async fn fetch_split(fetch: &RangeFetch, k: u64) -> Result<(Bytes, u64), String> {
    let part = BLOCK / URGENT_PARTS;
    let parts = (0..URGENT_PARTS).map(|i| {
        let a = k * BLOCK + i * part;
        fetch(a, a + part - 1)
    });
    let mut buf = Vec::with_capacity(BLOCK as usize);
    let mut total = 0;
    for r in futures_util::future::join_all(parts).await {
        let (bytes, t) = r?;
        if bytes.len() as u64 != part {
            return Err("morceau incomplet".into());
        }
        total = t;
        buf.extend_from_slice(&bytes);
    }
    Ok((Bytes::from(buf), total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    /// Une lecture MP4 tient sur une seule requête : chaque bloc envoyé doit
    /// compter comme activité, sinon les caches sont vidés en pleine lecture.
    #[tokio::test]
    async fn chaque_bloc_envoye_compte_comme_activite() {
        let total = 3 * BLOCK;
        let fetch: RangeFetch = Arc::new(move |a, b| {
            async move {
                let n = (b.min(total - 1) - a + 1) as usize;
                Ok((Bytes::from(vec![7u8; n]), total))
            }
            .boxed()
        });
        let c = Mp4Cache::new(64 << 20, 2, 2);
        let r = c.serve("f", fetch, Some("bytes=0-")).await.unwrap();
        let mut body = r.into_body().into_data_stream();
        assert!(body.next().await.is_some());
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert!(c.idle_ms() >= 60, "inactif pendant la pause");
        assert!(body.next().await.is_some());
        assert!(c.idle_ms() < 60, "bloc suivant envoyé : actif");
    }

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
