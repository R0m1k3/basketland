//! Son SEUL d'un MP4 progressif d'ok.ru (vidéos récentes, avant que le HLS
//! et le DASH n'existent).
//!
//! ffmpeg relisait, pour chaque tronçon, tout l'index du fichier (`moov` :
//! ~7 Mo pour un match de 2 h 30) puis les octets image + son du tronçon, sur
//! une seule connexion bridée. Ici : l'index est lu une fois par match (en
//! parallèle, gardé en mémoire), la place exacte de chaque trame AAC du
//! tronçon en est tirée, et seules ces trames sont téléchargées, en
//! parallèle (~1 Mo pour 2 min). Elles sont réécrites en flux ADTS, que
//! ffmpeg découpe sur place.

use super::abort::AbortSignal;
use super::audio::SourceHeaders;
use super::hls_fetch::{fetch_parallel, fetch_retry_range, FetchStats};
use futures_util::StreamExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

/// Une trame audio : instant de présentation (s), place dans le fichier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub time: f64,
    pub offset: u64,
    pub size: u32,
}

/// Piste audio AAC d'un MP4 : configuration (pour les en-têtes ADTS) et trames.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioIndex {
    /// Profil ADTS (type d'objet AAC − 1), index de fréquence, canaux.
    pub profile: u8,
    pub freq_index: u8,
    pub channels: u8,
    pub frames: Vec<Frame>,
}

fn be(b: &[u8], at: usize, n: usize) -> Result<u64, String> {
    let s = b.get(at..at + n).ok_or("index MP4 tronqué")?;
    Ok(s.iter().fold(0u64, |a, x| (a << 8) | u64::from(*x)))
}

/// Boîtes filles de `b` : (type, contenu).
fn boxes(b: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut o = 0usize;
    while o + 8 <= b.len() {
        let mut size = be(b, o, 4).unwrap_or(0) as usize;
        let typ: [u8; 4] = b[o + 4..o + 8].try_into().unwrap_or([0; 4]);
        let mut head = 8;
        if size == 1 {
            size = be(b, o + 8, 8).unwrap_or(0) as usize;
            head = 16;
        } else if size == 0 {
            size = b.len() - o;
        }
        if size < head || o + size > b.len() {
            break;
        }
        out.push((typ, &b[o + head..o + size]));
        o += size;
    }
    out
}

fn child<'a>(b: &'a [u8], typ: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(b).into_iter().find(|(t, _)| t == typ).map(|(_, c)| c)
}

fn path<'a>(b: &'a [u8], types: &[&[u8; 4]]) -> Option<&'a [u8]> {
    types.iter().try_fold(b, |cur, t| child(cur, t))
}

/// Longueur d'un descripteur MPEG-4 (7 bits par octet) : (longueur, octets lus).
fn desc_len(b: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut n = 0usize;
    for k in 0..4 {
        let x = *b.get(at + k)?;
        n = (n << 7) | usize::from(x & 0x7f);
        if x & 0x80 == 0 {
            return Some((n, k + 1));
        }
    }
    None
}

/// `AudioSpecificConfig` d'une boîte `esds`.
fn audio_specific_config(esds: &[u8]) -> Option<Vec<u8>> {
    let mut o = 4; // version + drapeaux
    while o < esds.len() {
        let tag = esds[o];
        let (len, k) = desc_len(esds, o + 1)?;
        let body = o + 1 + k;
        match tag {
            0x03 => {
                // ES_ID (2), drapeaux (1) puis champs facultatifs.
                let flags = *esds.get(body + 2)?;
                let mut p = body + 3;
                if flags & 0x80 != 0 {
                    p += 2;
                }
                if flags & 0x40 != 0 {
                    p += 1 + usize::from(*esds.get(p)?);
                }
                if flags & 0x20 != 0 {
                    p += 2;
                }
                o = p;
            }
            // DecoderConfigDescriptor : 13 octets fixes avant DecoderSpecificInfo.
            0x04 => o = body + 13,
            0x05 => return esds.get(body..body + len).map(<[u8]>::to_vec),
            _ => o = body + len,
        }
    }
    None
}

/// Index audio d'une boîte `moov` (contenu, sans en-tête) : première piste
/// son AAC, horodatée selon sa liste d'édition (`elst`).
pub fn parse_moov(moov: &[u8]) -> Result<AudioIndex, String> {
    let movie_scale = path(moov, &[b"mvhd"])
        .and_then(|m| {
            let off = if m.first() == Some(&1) { 20 } else { 12 };
            be(m, off, 4).ok()
        })
        .unwrap_or(1000)
        .max(1) as f64;
    for (t, trak) in boxes(moov) {
        if &t != b"trak" {
            continue;
        }
        let Some(hdlr) = path(trak, &[b"mdia", b"hdlr"]) else {
            continue;
        };
        if hdlr.get(8..12) != Some(b"soun".as_slice()) {
            continue;
        }
        let mdhd = path(trak, &[b"mdia", b"mdhd"]).ok_or("mdhd absent")?;
        let scale = be(mdhd, if mdhd.first() == Some(&1) { 20 } else { 12 }, 4)?.max(1) as f64;
        let stbl = path(trak, &[b"mdia", b"minf", b"stbl"]).ok_or("stbl absent")?;
        // Description : mp4a → esds (ou wave → esds, QuickTime).
        let stsd = child(stbl, b"stsd").ok_or("stsd absent")?;
        let entry = boxes(stsd.get(8..).ok_or("stsd vide")?)
            .into_iter()
            .next()
            .ok_or("stsd vide")?;
        if &entry.0 != b"mp4a" {
            return Err(format!(
                "son {} (seul l'AAC est pris en charge)",
                String::from_utf8_lossy(&entry.0)
            ));
        }
        let kids = entry.1.get(28..).ok_or("mp4a tronqué")?;
        let esds = child(kids, b"esds")
            .or_else(|| child(kids, b"wave").and_then(|w| child(w, b"esds")))
            .ok_or("esds absent")?;
        let asc = audio_specific_config(esds).ok_or("configuration AAC illisible")?;
        let aot = asc.first().ok_or("configuration AAC vide")? >> 3;
        let freq_index = ((asc[0] & 0x07) << 1) | (asc.get(1).copied().unwrap_or(0) >> 7);
        let channels = (asc.get(1).copied().unwrap_or(0) >> 3) & 0x0f;
        if !(1..=4).contains(&aot) || aot == 31 || freq_index > 12 || channels == 0 {
            return Err(format!(
                "AAC non pris en charge (type {aot}, fréquence {freq_index})"
            ));
        }
        // Tables : durées, trames par bloc, tailles, places des blocs.
        let stts = child(stbl, b"stts").ok_or("stts absent")?;
        let stsc = child(stbl, b"stsc").ok_or("stsc absent")?;
        let stsz = child(stbl, b"stsz").ok_or("stsz absent")?;
        let (chunks, wide) = match (child(stbl, b"stco"), child(stbl, b"co64")) {
            (Some(c), _) => (c, false),
            (None, Some(c)) => (c, true),
            _ => return Err("stco absent".into()),
        };
        let n_chunks = be(chunks, 4, 4)? as usize;
        let fixed = be(stsz, 4, 4)? as u32;
        let n_samples = be(stsz, 8, 4)? as usize;
        let size_of = |k: usize| -> Result<u32, String> {
            if fixed != 0 {
                Ok(fixed)
            } else {
                Ok(be(stsz, 12 + 4 * k, 4)? as u32)
            }
        };
        let n_stsc = be(stsc, 4, 4)? as usize;
        let stsc_entry = |k: usize| -> Result<(u64, u64), String> {
            Ok((be(stsc, 8 + 12 * k, 4)?, be(stsc, 12 + 12 * k, 4)?))
        };
        // Décalage de la liste d'édition : début du média, délai initial.
        let (mut media_start, mut delay) = (0f64, 0f64);
        if let Some(elst) = path(trak, &[b"edts", b"elst"]) {
            let v1 = elst.first() == Some(&1);
            let n = be(elst, 4, 4)? as usize;
            let w = if v1 { 20 } else { 12 };
            for k in 0..n {
                let o = 8 + k * w;
                let (dur, mt) = if v1 {
                    (be(elst, o, 8)?, be(elst, o + 8, 8)? as i64)
                } else {
                    (be(elst, o, 4)?, be(elst, o + 4, 4)? as u32 as i32 as i64)
                };
                if mt < 0 {
                    delay += dur as f64 / movie_scale;
                } else {
                    media_start = mt as f64 / scale;
                    break;
                }
            }
        }
        let mut frames = Vec::with_capacity(n_samples);
        let (mut sample, mut stsc_k) = (0usize, 0usize);
        for chunk in 0..n_chunks {
            while stsc_k + 1 < n_stsc && stsc_entry(stsc_k + 1)?.0 as usize <= chunk + 1 {
                stsc_k += 1;
            }
            let per = stsc_entry(stsc_k)?.1 as usize;
            let mut off = if wide {
                be(chunks, 8 + 8 * chunk, 8)?
            } else {
                be(chunks, 8 + 4 * chunk, 4)?
            };
            for _ in 0..per {
                if sample >= n_samples {
                    break;
                }
                let size = size_of(sample)?;
                frames.push(Frame {
                    time: 0.0,
                    offset: off,
                    size,
                });
                off += u64::from(size);
                sample += 1;
            }
        }
        // Instants : durées cumulées (stts), liste d'édition appliquée.
        let n_stts = be(stts, 4, 4)? as usize;
        let (mut k, mut t) = (0usize, 0u64);
        'outer: for e in 0..n_stts {
            let count = be(stts, 8 + 8 * e, 4)?;
            let delta = be(stts, 12 + 8 * e, 4)?;
            for _ in 0..count {
                let Some(f) = frames.get_mut(k) else {
                    break 'outer;
                };
                f.time = t as f64 / scale - media_start + delay;
                t += delta;
                k += 1;
            }
        }
        if frames.is_empty() {
            return Err("piste audio vide".into());
        }
        return Ok(AudioIndex {
            profile: aot - 1,
            freq_index,
            channels,
            frames,
        });
    }
    Err("aucune piste son".into())
}

/// En-tête ADTS (7 octets, sans CRC) d'une trame de `len` octets.
pub fn adts_header(ix: &AudioIndex, len: usize) -> [u8; 7] {
    let full = len + 7;
    [
        0xff,
        0xf1,
        (ix.profile << 6) | (ix.freq_index << 2) | (ix.channels >> 2),
        ((ix.channels & 3) << 6) | ((full >> 11) as u8 & 0x03),
        ((full >> 3) & 0xff) as u8,
        (((full & 7) as u8) << 5) | 0x1f,
        0xfc,
    ]
}

/// Trames de `[start, start + length[` (avec une trame de marge de chaque côté).
pub fn frames_for(ix: &AudioIndex, start: f64, length: f64) -> &[Frame] {
    let f = &ix.frames;
    let first = f.partition_point(|x| x.time < start).saturating_sub(1);
    let end = f.partition_point(|x| x.time < start + length);
    &f[first..(end + 1).min(f.len()).max(first)]
}

/// Écart (octets d'image) au-delà duquel deux blocs son sont demandés à part.
const MERGE_GAP: u64 = 8 << 10;
/// Taille maximale d'une plage demandée.
const MAX_RANGE: u64 = 1 << 20;

/// Plages d'octets `[début, fin[` couvrant ces trames : blocs contigus réunis,
/// et blocs séparés de peu d'image (≤ 8 Ko, le coût d'une requête de plus) aussi, jusqu'à 1 Mo par plage :
/// un peu plus d'octets, bien moins de requêtes.
pub fn byte_ranges(frames: &[Frame]) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    for f in frames {
        let end = f.offset + u64::from(f.size);
        match out.last_mut() {
            Some(last)
                if f.offset >= last.1
                    && f.offset - last.1 <= MERGE_GAP
                    && end - last.0 <= MAX_RANGE =>
            {
                last.1 = end
            }
            _ => out.push((f.offset, end)),
        }
    }
    out
}

/// Index MP4 du dernier fichier lu (une seule lecture par match).
static LAST: Mutex<Option<(String, Arc<AudioIndex>)>> = Mutex::new(None);

/// Place de la boîte `moov` : premières boîtes lues par plages d'octets.
async fn locate_moov(
    url: &str,
    h: &SourceHeaders,
    signal: Option<&AbortSignal>,
) -> Result<(u64, u64), String> {
    let mut o = 0u64;
    for _ in 0..16 {
        let head = fetch_retry_range(url, h, None, Some((o, o + 15)), signal).await?;
        let mut size = be(&head, 0, 4)?;
        let typ = &head[4..8];
        if size == 1 {
            size = be(&head, 8, 8)?;
        }
        if size < 8 {
            return Err("MP4 illisible (boîte sans taille)".into());
        }
        if typ == b"moov" {
            return Ok((o, size));
        }
        o += size;
    }
    Err("index MP4 (moov) introuvable".into())
}

/// Index audio du MP4 `url` : gardé pour le match, sinon lu (en parallèle).
async fn index_of(
    url: &str,
    h: &SourceHeaders,
    signal: Option<&AbortSignal>,
) -> Result<Arc<AudioIndex>, String> {
    let cached = LAST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(u, _)| u == url)
        .map(|(_, ix)| ix.clone());
    if let Some(ix) = cached {
        return Ok(ix);
    }
    let (at, size) = locate_moov(url, h, signal).await?;
    if size > 256 << 20 {
        return Err(format!("index MP4 démesuré ({size} octets)"));
    }
    const PART: u64 = 512 << 10;
    let parts: Vec<(u64, u64)> = (0..size.div_ceil(PART))
        .map(|k| (at + k * PART, (at + (k + 1) * PART).min(at + size) - 1))
        .collect();
    let futs: Vec<_> = parts
        .into_iter()
        .map(|r| {
            let (url, h, sig) = (url.to_string(), h.clone(), signal.cloned());
            async move { fetch_retry_range(&url, &h, None, Some(r), sig.as_ref()).await }
        })
        .collect();
    let mut moov = Vec::with_capacity(size as usize);
    let mut stream = futures_util::stream::iter(futs).buffered(fetch_parallel());
    while let Some(b) = stream.next().await {
        moov.extend(b?);
    }
    let head = if be(&moov, 0, 4)? == 1 { 16 } else { 8 };
    let ix = Arc::new(parse_moov(&moov[head..])?);
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((url.to_string(), ix.clone()));
    Ok(ix)
}

/// Télécharge le son de `[start, start + length[` du MP4 `url` (trames AAC
/// seulement, en parallèle) et l'écrit dans `out` en flux ADTS.
pub async fn fetch_audio_range(
    url: &str,
    start: f64,
    length: f64,
    headers: &SourceHeaders,
    signal: Option<&AbortSignal>,
    out: &Path,
) -> Result<FetchStats, String> {
    let work = async {
        let ix = index_of(url, headers, signal).await?;
        let frames = frames_for(&ix, start, length);
        let Some(first) = frames.first() else {
            return Err(format!("aucune trame audio à {start} s"));
        };
        let ranges = byte_ranges(frames);
        let futs: Vec<_> =
            ranges
                .iter()
                .map(|&(a, b)| {
                    let (url, h, sig) = (url.to_string(), headers.clone(), signal.cloned());
                    async move {
                        fetch_retry_range(&url, &h, None, Some((a, b - 1)), sig.as_ref()).await
                    }
                })
                .collect();
        let mut data: Vec<Vec<u8>> = Vec::with_capacity(ranges.len());
        let mut stream = futures_util::stream::iter(futs).buffered(fetch_parallel());
        while let Some(b) = stream.next().await {
            data.push(b?);
        }
        // Trames réécrites en ADTS, dans l'ordre.
        let part = out.with_extension("part");
        let mut f = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        let (mut r, mut bytes) = (0usize, 0u64);
        let mut buf = Vec::with_capacity(frames.iter().map(|f| f.size as usize + 7).sum());
        for fr in frames {
            // Plage qui contient la trame (plages et trames dans l'ordre du fichier).
            while ranges.get(r).is_some_and(|(_, end)| fr.offset >= *end) {
                r += 1;
            }
            let (a, _) = *ranges.get(r).ok_or("trames audio manquantes")?;
            let pos = (fr.offset - a) as usize;
            let raw = data
                .get(r)
                .and_then(|d| d.get(pos..pos + fr.size as usize))
                .ok_or("trame audio tronquée")?;
            buf.extend_from_slice(&adts_header(&ix, raw.len()));
            buf.extend_from_slice(raw);
            bytes += raw.len() as u64;
        }
        f.write_all(&buf).await.map_err(|e| e.to_string())?;
        f.flush().await.map_err(|e| e.to_string())?;
        drop(f);
        tokio::fs::rename(&part, out)
            .await
            .map_err(|e| e.to_string())?;
        Ok(FetchStats {
            first_start: first.time,
            segments: ranges.len(),
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

    #[test]
    fn plages_contigues() {
        let f = |offset, size| Frame {
            time: 0.0,
            offset,
            size,
        };
        // Contigus, ou séparés de peu d'image : une seule plage.
        assert_eq!(
            byte_ranges(&[f(100, 10), f(110, 5), f(200, 7), f(207, 3)]),
            vec![(100, 210)]
        );
        // Trop d'image entre deux blocs : deux plages.
        assert_eq!(
            byte_ranges(&[f(100, 10), f(100_000, 5)]),
            vec![(100, 110), (100_000, 100_005)]
        );
        // Plafond d'une plage : 1 Mo.
        let far: Vec<Frame> = (0..300).map(|k| f(k * 8_000, 100)).collect();
        let r = byte_ranges(&far);
        assert!(
            r.len() > 1 && r.iter().all(|(a, b)| b - a <= 1 << 20),
            "{r:?}"
        );
    }

    #[test]
    fn en_tete_adts() {
        let ix = AudioIndex {
            profile: 1,
            freq_index: 4,
            channels: 2,
            frames: vec![],
        };
        // AAC LC, 44,1 kHz, stéréo, trame de 100 octets (107 avec l'en-tête).
        assert_eq!(
            adts_header(&ix, 100),
            [0xff, 0xf1, 0x50, 0x80, 0x0d, 0x7f, 0xfc]
        );
    }
}
