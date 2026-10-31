//! Son SEUL d'une vidéo ok.ru, par son manifeste DASH (`metadataUrl`).
//!
//! Le HLS d'ok.ru ne contient que des segments image + son : pour 2 min de
//! commentaires, il fallait télécharger 5,5 Mo de vidéo (qualité « mobile »)
//! sur des connexions bridées. Le manifeste DASH annonce en plus des pistes
//! AAC sans image (37 à 136 kb/s) : 7 fois moins de données.
//!
//! Chaque piste est un fichier MP4 fragmenté unique (`SegmentBase`) : son
//! index (`sidx`) donne la place, en octets, de chaque fragment (≈ 3 s). Les
//! fragments d'un tronçon sont téléchargés en même temps par plages d'octets
//! (`Range`, plusieurs connexions), recollés derrière l'en-tête
//! d'initialisation, et le fichier obtenu garde les horodatages d'origine.

use super::abort::AbortSignal;
use super::audio::SourceHeaders;
use super::hls_fetch::{fetch_parallel, fetch_retry, fetch_retry_range, FetchStats};
use futures_util::StreamExt;
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;

/// Une piste audio du manifeste.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioTrack {
    pub url: String,
    pub bandwidth: u64,
    /// En-tête d'initialisation (`ftyp` + `moov`), octets `début..=fin`.
    pub init: (u64, u64),
    /// Index `sidx`, octets `début..=fin`.
    pub index: (u64, u64),
}

/// Un fragment de la piste, placé sur l'axe du temps (s) et dans le fichier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fragment {
    pub start: f64,
    pub duration: f64,
    pub offset: u64,
    pub size: u64,
}

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("regex"))
}

fn attr(tag: &str, name: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(&R, r#"([A-Za-z:]+)="([^"]*)""#);
    r.captures_iter(tag)
        .find(|c| &c[1] == name)
        .map(|c| c[2].to_string())
}

fn range_of(s: &str) -> Option<(u64, u64)> {
    let (a, b) = s.split_once('-')?;
    let (a, b) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (a <= b).then_some((a, b))
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Pistes audio (`audio/mp4`, `SegmentBase`) d'un manifeste DASH ;
/// `mpd_url` résout les `BaseURL` relatives.
pub fn parse_mpd_audio(xml: &str, mpd_url: &str) -> Result<Vec<AudioTrack>, String> {
    static SET: OnceLock<Regex> = OnceLock::new();
    static REP: OnceLock<Regex> = OnceLock::new();
    static BASE: OnceLock<Regex> = OnceLock::new();
    static SB: OnceLock<Regex> = OnceLock::new();
    static INIT: OnceLock<Regex> = OnceLock::new();
    if !xml.contains("<MPD") {
        return Err("pas un manifeste DASH".into());
    }
    let base = url::Url::parse(mpd_url).map_err(|_| "URL du manifeste invalide".to_string())?;
    let mut out = Vec::new();
    for set in re(&SET, r"(?s)<AdaptationSet\b([^>]*)>(.*?)</AdaptationSet>").captures_iter(xml) {
        let set_mime = attr(&set[1], "mimeType").unwrap_or_default();
        for rep in
            re(&REP, r"(?s)<Representation\b([^>]*)>(.*?)</Representation>").captures_iter(&set[2])
        {
            let mime = attr(&rep[1], "mimeType").unwrap_or_else(|| set_mime.clone());
            if !mime.starts_with("audio/") {
                continue;
            }
            let body = &rep[2];
            let (Some(b), Some(sb), Some(init)) = (
                re(&BASE, r"(?s)<BaseURL>(.*?)</BaseURL>").captures(body),
                re(&SB, r"<SegmentBase\b([^>]*)>").captures(body),
                re(&INIT, r"<Initialization\b([^>]*)/?>").captures(body),
            ) else {
                continue;
            };
            let (Some(index), Some(init)) = (
                attr(&sb[1], "indexRange").as_deref().and_then(range_of),
                attr(&init[1], "range").as_deref().and_then(range_of),
            ) else {
                continue;
            };
            let Ok(url) = base.join(unescape(b[1].trim()).as_str()) else {
                continue;
            };
            if !matches!(url.scheme(), "https" | "http") {
                continue;
            }
            out.push(AudioTrack {
                url: url.to_string(),
                bandwidth: attr(&rep[1], "bandwidth")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
                init,
                index,
            });
        }
    }
    if out.is_empty() {
        return Err("aucune piste audio seule dans le manifeste".into());
    }
    Ok(out)
}

/// Piste choisie : la plus légère d'au moins 48 kb/s (assez pour la
/// reconnaissance vocale, qui travaille en 16 kHz mono), sinon la plus riche.
pub fn pick_track(tracks: &[AudioTrack]) -> Option<&AudioTrack> {
    tracks
        .iter()
        .filter(|t| t.bandwidth >= 48_000)
        .min_by_key(|t| t.bandwidth)
        .or_else(|| tracks.iter().max_by_key(|t| t.bandwidth))
}

fn be(b: &[u8], at: usize, n: usize) -> Result<u64, String> {
    let s = b.get(at..at + n).ok_or("index sidx tronqué")?;
    Ok(s.iter().fold(0u64, |acc, x| (acc << 8) | u64::from(*x)))
}

/// Fragments décrits par une boîte `sidx` (`index_end` : dernier octet de
/// l'index ; les fragments suivent, décalés de `first_offset`).
pub fn parse_sidx(b: &[u8], index_end: u64) -> Result<Vec<Fragment>, String> {
    if b.get(4..8) != Some(b"sidx".as_slice()) {
        return Err("index sidx attendu".into());
    }
    let version = *b.get(8).ok_or("index sidx tronqué")?;
    let timescale = be(b, 16, 4)? as f64;
    if timescale <= 0.0 {
        return Err("échelle de temps nulle".into());
    }
    let (ept, first_offset, mut o) = if version == 0 {
        (be(b, 20, 4)?, be(b, 24, 4)?, 28)
    } else {
        (be(b, 20, 8)?, be(b, 28, 8)?, 36)
    };
    let count = be(b, o + 2, 2)? as usize;
    o += 4;
    let mut out = Vec::with_capacity(count);
    let (mut t, mut off) = (ept, index_end + 1 + first_offset);
    for _ in 0..count {
        let r = be(b, o, 4)?;
        if r >> 31 == 1 {
            return Err("index sidx hiérarchique non pris en charge".into());
        }
        let size = r & 0x7fff_ffff;
        let d = be(b, o + 4, 4)?;
        be(b, o + 8, 4)?; // drapeaux SAP : l'entrée doit être complète
        out.push(Fragment {
            start: t as f64 / timescale,
            duration: d as f64 / timescale,
            offset: off,
            size,
        });
        t += d;
        off += size;
        o += 12;
    }
    if out.is_empty() {
        return Err("index sidx vide".into());
    }
    Ok(out)
}

/// Fragments qui recouvrent `[start, start + length[`.
pub fn covering(frags: &[Fragment], start: f64, length: f64) -> &[Fragment] {
    let end = start + length;
    let first = frags
        .iter()
        .position(|f| f.start + f.duration > start)
        .unwrap_or(frags.len());
    let last = frags
        .iter()
        .rposition(|f| f.start < end)
        .map_or(first, |i| i + 1);
    &frags[first..last.max(first)]
}

/// Piste choisie, en-tête d'initialisation et index : les mêmes pour tous les
/// tronçons d'un match, gardés pour le dernier manifeste lu.
struct Prepared {
    track: AudioTrack,
    init: Vec<u8>,
    frags: Vec<Fragment>,
}

async fn prepare(
    mpd_url: &str,
    headers: &SourceHeaders,
    signal: Option<&AbortSignal>,
) -> Result<std::sync::Arc<Prepared>, String> {
    static LAST: std::sync::Mutex<Option<(String, std::sync::Arc<Prepared>)>> =
        std::sync::Mutex::new(None);
    let cached = LAST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(u, _)| u == mpd_url)
        .map(|(_, p)| p.clone());
    if let Some(p) = cached {
        return Ok(p);
    }
    let xml = fetch_retry(mpd_url, headers, Some(4 << 20), signal).await?;
    let tracks = parse_mpd_audio(&String::from_utf8_lossy(&xml), mpd_url)?;
    let track = pick_track(&tracks).ok_or("aucune piste audio")?.clone();
    // En-tête et index se suivent d'ordinaire : une seule requête.
    let (init, index) = if track.init.1 + 1 == track.index.0 {
        let both = fetch_retry_range(
            &track.url,
            headers,
            None,
            Some((track.init.0, track.index.1)),
            signal,
        )
        .await?;
        let cut = (track.init.1 - track.init.0 + 1) as usize;
        (both[..cut].to_vec(), both[cut..].to_vec())
    } else {
        (
            fetch_retry_range(&track.url, headers, None, Some(track.init), signal).await?,
            fetch_retry_range(&track.url, headers, None, Some(track.index), signal).await?,
        )
    };
    let frags = parse_sidx(&index, track.index.1)?;
    let p = std::sync::Arc::new(Prepared { track, init, frags });
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((mpd_url.to_string(), p.clone()));
    Ok(p)
}

/// Télécharge le son seul de `[start, start + length[` depuis le manifeste
/// DASH `mpd_url` et l'écrit dans `out` (MP4 fragmenté lisible par ffmpeg).
pub async fn fetch_audio_range(
    mpd_url: &str,
    start: f64,
    length: f64,
    headers: &SourceHeaders,
    signal: Option<&AbortSignal>,
    out: &Path,
) -> Result<FetchStats, String> {
    let work = async {
        let prepared = prepare(mpd_url, headers, signal).await?;
        let Prepared { track, init, frags } = &*prepared;
        let sel = covering(frags, start, length);
        let Some(first) = sel.first() else {
            return Err(format!("aucun fragment audio à {start} s"));
        };
        let first_start = first.start;
        let part = out.with_extension("part");
        let mut f = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        f.write_all(init).await.map_err(|e| e.to_string())?;
        let mut bytes = init.len() as u64;
        let futs: Vec<_> = sel
            .iter()
            .map(|fr| {
                let (url, h, sig) = (track.url.clone(), headers.clone(), signal.cloned());
                let r = (fr.offset, fr.offset + fr.size - 1);
                async move { fetch_retry_range(&url, &h, None, Some(r), sig.as_ref()).await }
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

    const MPD: &str = r#"<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period>
<AdaptationSet id="1"><Representation bandwidth="134602" mimeType="video/mp4" id="1"><BaseURL>?type=4&amp;sig=v</BaseURL><SegmentBase indexRange="895-1226"><Initialization range="0-894"/></SegmentBase></Representation></AdaptationSet>
<AdaptationSet id="2" mimeType="audio/mp4"><Representation bandwidth="36656" id="5"><BaseURL>?type=a1&amp;sig=a</BaseURL><SegmentBase indexRange="837-1144" indexRangeExact="true"><Initialization range="0-836"/></SegmentBase></Representation>
<Representation bandwidth="53203" id="6"><BaseURL>?type=a2&amp;sig=b</BaseURL><SegmentBase indexRange="837-1144"><Initialization range="0-836"/></SegmentBase></Representation>
<Representation bandwidth="136051" id="8"><BaseURL>?type=a4&amp;sig=d</BaseURL><SegmentBase indexRange="837-1144"><Initialization range="0-836"/></SegmentBase></Representation></AdaptationSet>
<AdaptationSet id="3" mimeType="text/vtt"><Representation bandwidth="12038" id="9"><BaseURL>?subs=1</BaseURL></Representation></AdaptationSet></Period></MPD>"#;

    #[test]
    fn manifeste_pistes_audio() {
        let t = parse_mpd_audio(MPD, "https://ok6-12.vkuser.net/?expires=1&mid=2").unwrap();
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].url, "https://ok6-12.vkuser.net/?type=a1&sig=a");
        assert_eq!((t[0].init, t[0].index), ((0, 836), (837, 1144)));
        let p = pick_track(&t).unwrap();
        assert_eq!(p.bandwidth, 53203);
        assert!(parse_mpd_audio("<html/>", "https://a/").is_err());
        assert!(parse_mpd_audio(
            &MPD.replace("audio/mp4", "video/mp4"),
            "https://ok6-12.vkuser.net/"
        )
        .is_err());
    }

    fn sidx(version: u8, ept: u64, first_offset: u64, refs: &[(u32, u32)]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend([0, 0, 0, 0]);
        b.extend(b"sidx");
        b.extend([version, 0, 0, 0]);
        b.extend(1u32.to_be_bytes());
        b.extend(44_100u32.to_be_bytes());
        if version == 0 {
            b.extend((ept as u32).to_be_bytes());
            b.extend((first_offset as u32).to_be_bytes());
        } else {
            b.extend(ept.to_be_bytes());
            b.extend(first_offset.to_be_bytes());
        }
        b.extend([0, 0]);
        b.extend((refs.len() as u16).to_be_bytes());
        for (size, dur) in refs {
            b.extend(size.to_be_bytes());
            b.extend(dur.to_be_bytes());
            b.extend(0x9000_0000u32.to_be_bytes());
        }
        let n = b.len() as u32;
        b[..4].copy_from_slice(&n.to_be_bytes());
        b
    }

    #[test]
    fn index_sidx() {
        for v in [0, 1] {
            let b = sidx(
                v,
                0,
                0,
                &[(22189, 145_276), (21684, 145_407), (14405, 102_400)],
            );
            let f = parse_sidx(&b, 1144).unwrap();
            assert_eq!(f.len(), 3);
            assert_eq!((f[0].offset, f[0].size), (1145, 22189));
            assert_eq!(f[1].offset, 1145 + 22189);
            assert!((f[1].start - 145_276.0 / 44_100.0).abs() < 1e-9);
            let starts = |a: &[Fragment]| a.iter().map(|x| x.offset).collect::<Vec<_>>();
            assert_eq!(starts(covering(&f, 3.4, 1.0)), vec![1145 + 22189]);
            assert_eq!(covering(&f, 0.0, 100.0).len(), 3);
            assert!(covering(&f, 50.0, 1.0).is_empty());
        }
        assert!(parse_sidx(b"0000moof", 0).is_err());
        let mut b = sidx(0, 0, 0, &[(10, 10)]);
        b.truncate(b.len() - 4);
        assert!(parse_sidx(&b, 0).is_err());
    }
}
