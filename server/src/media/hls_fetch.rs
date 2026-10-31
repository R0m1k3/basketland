//! Téléchargement PARALLÈLE d'une plage d'un flux HLS (audio des
//! commentaires et du doublage).
//!
//! ok.ru bride chaque connexion (quelques centaines de kb/s, avec des arrêts
//! nets) : ffmpeg, qui lit les segments un par un sur une seule connexion,
//! extrayait l'audio moins vite que le temps réel. Ici, les segments d'un
//! tronçon partent en même temps sur plusieurs connexions
//! (`COMMENTARY_FETCH_PARALLEL`, 16 par défaut), chacun repris sur une
//! connexion neuve s'il cale ; ils sont recollés dans l'ordre (MPEG-TS se
//! concatène tel quel) puis découpés localement par ffmpeg.

use super::abort::AbortSignal;
use super::audio::SourceHeaders;
use futures_util::StreamExt;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Un segment de la playlist média, placé sur l'axe du temps.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub url: String,
    pub start: f64,
    pub duration: f64,
}

/// Segments d'une playlist média (`#EXTINF` puis l'URI, relative à `base`).
/// Chiffrement, `#EXT-X-BYTERANGE` ou `#EXT-X-MAP` : refusé (l'appelant
/// retombe sur ffmpeg, qui sait les lire).
pub fn parse_media_playlist(text: &str, base: &str) -> Result<Vec<Segment>, String> {
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err("pas une playlist HLS".into());
    }
    let mut out = Vec::new();
    let mut t = 0.0;
    let mut dur: Option<f64> = None;
    for line in crate::hls::split_lines(text) {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("#EXTINF:") {
            let d = rest.split(',').next().unwrap_or("").trim();
            dur = Some(
                d.parse::<f64>()
                    .ok()
                    .filter(|d| d.is_finite() && *d >= 0.0)
                    .ok_or_else(|| format!("durée de segment invalide : {d}"))?,
            );
        } else if l.starts_with("#EXT-X-STREAM-INF") {
            return Err("playlist maîtresse, pas une playlist média".into());
        } else if l.starts_with("#EXT-X-BYTERANGE")
            || l.starts_with("#EXT-X-MAP")
            || (l.starts_with("#EXT-X-KEY") && !l.contains("METHOD=NONE"))
        {
            return Err(format!(
                "playlist non prise en charge ({})",
                l.split(':').next().unwrap_or(l)
            ));
        } else if !l.is_empty() && !l.starts_with('#') {
            let Some(d) = dur.take() else { continue };
            let url = crate::hls::resolve_url(l, base)?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(format!("URL de segment refusée : {url}"));
            }
            out.push(Segment {
                url,
                start: t,
                duration: d,
            });
            t += d;
        }
    }
    if out.is_empty() {
        return Err("playlist sans segment".into());
    }
    Ok(out)
}

/// Segments qui recouvrent `[start, start + length[`.
pub fn covering(segs: &[Segment], start: f64, length: f64) -> &[Segment] {
    let end = start + length;
    let first = segs
        .iter()
        .position(|s| s.start + s.duration > start)
        .unwrap_or(segs.len());
    let last = segs
        .iter()
        .rposition(|s| s.start < end)
        .map_or(first, |i| i + 1);
    &segs[first..last.max(first)]
}

/// Connexions simultanées vers ok.ru par tronçon (`COMMENTARY_FETCH_PARALLEL`, 16 par défaut, 1 à 32).
pub fn fetch_parallel() -> usize {
    std::env::var("COMMENTARY_FETCH_PARALLEL")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .map_or(16, |n| n.min(32))
}

/// Téléchargement parallèle activé (`COMMENTARY_PARALLEL_FETCH`, sauf `0`).
pub fn parallel_fetch_enabled() -> bool {
    std::env::var("COMMENTARY_PARALLEL_FETCH").ok().as_deref() != Some("0")
}

/// Sans un octet pendant ce délai (`COMMENTARY_FETCH_STALL_MS`, 6 s par
/// défaut), la connexion est abandonnée et le segment repris.
fn stall() -> Duration {
    let ms = std::env::var("COMMENTARY_FETCH_STALL_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n >= 100)
        .unwrap_or(6_000);
    Duration::from_millis(ms)
}
/// Essais par segment (connexion neuve à chaque fois).
const ATTEMPTS: usize = 6;
/// Taille maximale d'une playlist (une URL MP4 n'est pas téléchargée en entier).
const MAX_PLAYLIST: usize = 4 << 20;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

fn request(url: &str, h: &SourceHeaders) -> reqwest::RequestBuilder {
    let mut r = client().get(url);
    if let Some(ua) = h.user_agent.as_deref().filter(|s| !s.is_empty()) {
        r = r.header(reqwest::header::USER_AGENT, ua);
    }
    if let Some(re) = h.referer.as_deref().filter(|s| !s.is_empty()) {
        r = r.header(reqwest::header::REFERER, re);
    }
    r
}

/// Un téléchargement complet, coupé s'il cale (`STALL`) ; `max` : taille maximale.
async fn fetch_once(url: &str, h: &SourceHeaders, max: Option<usize>) -> Result<Vec<u8>, String> {
    let resp = tokio::time::timeout(Duration::from_secs(20), request(url, h).send())
        .await
        .map_err(|_| "pas de réponse en 20 s".to_string())?
        .map_err(|e| e.without_url().to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let expected = resp.content_length();
    if let (Some(n), Some(m)) = (expected, max) {
        if n as usize > m {
            return Err(format!("réponse trop grande ({n} octets)"));
        }
    }
    let mut buf = Vec::with_capacity(expected.unwrap_or(0).min(64 << 20) as usize);
    let mut body = resp.bytes_stream();
    let stall = stall();
    loop {
        match tokio::time::timeout(stall, body.next()).await {
            Err(_) => {
                return Err(format!(
                    "aucun octet depuis {:.1} s ({} octets reçus)",
                    stall.as_secs_f64(),
                    buf.len()
                ))
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(e.without_url().to_string()),
            Ok(Some(Ok(c))) => {
                buf.extend_from_slice(&c);
                if max.is_some_and(|m| buf.len() > m) {
                    return Err("réponse trop grande".into());
                }
            }
        }
    }
    if let Some(n) = expected {
        if buf.len() as u64 != n {
            return Err(format!("réponse tronquée ({}/{n} octets)", buf.len()));
        }
    }
    Ok(buf)
}

/// [`fetch_once`] avec nouveaux essais (pause croissante entre deux).
async fn fetch_retry(
    url: &str,
    h: &SourceHeaders,
    max: Option<usize>,
    signal: Option<&AbortSignal>,
) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        if super::abort::is_aborted(signal) {
            return Err("interrompu".into());
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300 * attempt as u64)).await;
        }
        match fetch_once(url, h, max).await {
            Ok(b) => return Ok(b),
            Err(e) => last = e,
        }
    }
    Err(format!("{last} après {ATTEMPTS} essais"))
}

/// Ce qu'a coûté un téléchargement (journal).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FetchStats {
    /// Début (s) du premier segment écrit : le son voulu commence à `start - first_start`.
    pub first_start: f64,
    pub segments: usize,
    pub bytes: u64,
}

/// Télécharge les segments de `playlist_url` qui couvrent `[start, start + length[`
/// en parallèle et les écrit, dans l'ordre, dans `out` (MPEG-TS).
pub async fn fetch_range(
    playlist_url: &str,
    start: f64,
    length: f64,
    headers: &SourceHeaders,
    signal: Option<&AbortSignal>,
    out: &Path,
) -> Result<FetchStats, String> {
    let work = async {
        let text = fetch_retry(playlist_url, headers, Some(MAX_PLAYLIST), signal).await?;
        let text = String::from_utf8_lossy(&text);
        let segs = parse_media_playlist(&text, playlist_url)?;
        let sel = covering(&segs, start, length);
        let Some(first) = sel.first() else {
            return Err(format!("aucun segment à {start} s"));
        };
        let first_start = first.start;
        let part = out.with_extension("part");
        let mut f = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = 0u64;
        // Futures propriétaires (pas d'emprunt) : la tâche reste `Send`.
        let futs: Vec<_> = sel
            .iter()
            .map(|s| {
                let (url, h, sig) = (s.url.clone(), headers.clone(), signal.cloned());
                async move { fetch_retry(&url, &h, Some(64 << 20), sig.as_ref()).await }
            })
            .collect();
        let mut parts = futures_util::stream::iter(futs).buffered(fetch_parallel());
        while let Some(b) = parts.next().await {
            let b = b?;
            bytes += b.len() as u64;
            f.write_all(&b).await.map_err(|e| e.to_string())?;
        }
        f.flush().await.map_err(|e| e.to_string())?;
        drop(f);
        tokio::fs::rename(&part, out)
            .await
            .map_err(|e| e.to_string())?;
        Ok(FetchStats {
            first_start,
            segments: sel.len(),
            bytes,
        })
    };
    let r = tokio::select! {
        r = work => r,
        () = super::abort::wait_aborted(signal) => Err("interrompu".into()),
    };
    if r.is_err() {
        let _ = std::fs::remove_file(out.with_extension("part"));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    const PL: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n\
        #EXTINF:4.000,\nLOW00000.ts\n#EXTINF:4.0,\nLOW00001.ts\n#EXTINF:2.5,\nLOW00002.ts\n#EXT-X-ENDLIST\n";

    #[test]
    fn playlist_et_plage() {
        let s = parse_media_playlist(PL, "https://h.example/v/x/index.m3u8?sig=1").unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s[1].url, "https://h.example/v/x/LOW00001.ts");
        assert_eq!((s[2].start, s[2].duration), (8.0, 2.5));
        let urls = |a: &[Segment]| a.iter().map(|x| x.start).collect::<Vec<_>>();
        assert_eq!(urls(covering(&s, 0.0, 4.0)), vec![0.0]);
        assert_eq!(urls(covering(&s, 3.9, 0.2)), vec![0.0, 4.0]);
        assert_eq!(urls(covering(&s, 5.0, 100.0)), vec![4.0, 8.0]);
        assert!(covering(&s, 20.0, 5.0).is_empty());
    }

    #[test]
    fn playlists_refusees() {
        let b = "https://h.example/a.m3u8";
        assert!(parse_media_playlist("\u{0}\u{1}ftypmp42", b).is_err());
        assert!(
            parse_media_playlist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n", b).is_err()
        );
        assert!(parse_media_playlist(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:4,\na.ts\n",
            b
        )
        .is_err());
        assert!(parse_media_playlist("#EXTM3U\n#EXTINF:4,\nfile:///etc/passwd\n", b).is_err());
        assert!(parse_media_playlist("#EXTM3U\n#EXT-X-ENDLIST\n", b).is_err());
    }
}
