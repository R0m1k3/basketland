//! Réécriture des playlists HLS ok.ru (équivalent de `src/lib/hls.ts`).
//!
//! Contraintes réelles du flux :
//!  - l'URL m3u8 est signée et expire (`expires=`) → ré-résolue à la demande ;
//!  - la playlist maître contient des chemins ABSOLUS vers un hôte de segments
//!    différent de celui du m3u8 ;
//!  - la playlist média contient des chemins RELATIFS (`MEDIUM00000.ts`) ;
//!  - les segments exigent l'en-tête `Referer: https://ok.ru/`.

use crate::auth::encode_uri_component;
use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("regex"))
}

/// Un segment doit être un nom de fichier .ts (souvent MEDIA/MEDIUM + index).
fn segment_name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z0-9_-]+\.ts$")
}

/// Nom de fichier simple, extension comprise (ressource annexe : clé, init).
pub fn asset_name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$")
}

/// `String.prototype.trim` : espaces Unicode, fins de ligne et BOM.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `texte.split(/\r?\n/)`.
pub fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// `chaîne.split('/').pop()`.
fn last_path_part(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// Nom de segment acceptable (nom de fichier `.ts` simple, sans chemin).
pub fn is_segment_name(name: &str) -> bool {
    segment_name_re().is_match(name)
}

/// Nom du segment situé `step` positions plus loin, en incrémentant l'index
/// numérique final et en conservant sa largeur : `MEDIUM00041.ts` →
/// `MEDIUM00042.ts`. Sert au préchargement des segments suivants.
/// `None` si le nom ne se termine pas par un index.
pub fn next_segment_name(name: &str, step: i64) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let c = re(&R, r"^([A-Za-z0-9_-]*?)([0-9]+)\.ts$").captures(name)?;
    let digits = &c[2];
    let n = digits.parse::<f64>().ok()? + step as f64;
    // `Number.isSafeInteger(n) && n >= 0`
    if !(0.0..=9_007_199_254_740_991.0).contains(&n) || n.fract() != 0.0 {
        return None;
    }
    Some(format!(
        "{}{:0>width$}.ts",
        &c[1],
        n as u64,
        width = digits.len()
    ))
}

/// Noms des segments d'une playlist média (dans l'ordre).
pub fn segment_names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in split_lines(text) {
        let line = js_trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let name = last_path_part(line);
        if is_segment_name(name) {
            out.push(name.to_string());
        }
    }
    out
}

/// Une playlist HLS valide commence par #EXTM3U et contient des segments
/// (playlist média) ou des variantes (playlist maître).
pub fn is_valid_playlist(text: &str) -> bool {
    if text.is_empty() || !text.contains("#EXTM3U") {
        return false;
    }
    // `/^[A-Za-z0-9_-]+\.ts\s*$/m` : en JavaScript, `^`/`$` reconnaissent
    // aussi `\r` comme fin de ligne (mode CRLF de `regex`).
    static R: OnceLock<Regex> = OnceLock::new();
    let has_segment = re(&R, r"(?mR)^[A-Za-z0-9_-]+\.ts\s*$").is_match(text);
    has_segment || text.contains("#EXT-X-STREAM-INF")
}

/// Résout l'URL absolue d'un segment.
///
/// `segment` doit être un NOM DE FICHIER (`MEDIUM00000.ts`) : toute URL
/// absolue, tout chemin (`/`) est refusé (surface SSRF, traversée). Le
/// dossier de la variante fournit la base.
pub fn resolve_segment_url(segment: &str, variant_url: &str) -> Result<String, String> {
    if segment.starts_with("http://") || segment.starts_with("https://") {
        return Err("URL de segment absolue refusée".into());
    }
    if segment.contains('/') {
        return Err(format!("chemin de segment invalide: {segment}"));
    }
    if !is_segment_name(segment) {
        return Err(format!("nom de segment invalide: {segment}"));
    }
    Ok(format!("{}{segment}", dir_of(variant_url)))
}

/// `url.slice(0, url.lastIndexOf('/') + 1)` : dossier d'une URL.
pub fn dir_of(url: &str) -> &str {
    match url.rfind('/') {
        Some(i) => &url[..=i],
        None => "",
    }
}

/// `new URL(uri, base).toString()`.
pub fn resolve_url(uri: &str, base: &str) -> Result<String, String> {
    let invalid = || "Invalid URL".to_string();
    match url::Url::parse(uri) {
        Ok(u) => Ok(u.to_string()),
        Err(url::ParseError::RelativeUrlWithoutBase) => url::Url::parse(base)
            .map_err(|_| invalid())?
            .join(uri)
            .map(|u| u.to_string())
            .map_err(|_| invalid()),
        Err(_) => Err(invalid()),
    }
}

/// Entrée de variante analysée dans une playlist maîtresse.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterVariant {
    /// Ligne `#EXT-X-STREAM-INF` complète.
    pub inf: String,
    /// Clé de qualité normalisée (QUALITY, à défaut `v0`, `v1`…).
    pub key: String,
    /// URI de la variante, telle qu'écrite dans la playlist.
    pub uri: String,
    /// URL absolue de la variante.
    pub url: String,
}

/// Saute les lignes vides ou de commentaire à partir de `j`.
fn skip_blank_or_comment(lines: &[&str], mut j: usize) -> usize {
    while j < lines.len() && {
        let t = js_trim(lines[j]);
        t.is_empty() || t.starts_with('#')
    } {
        j += 1;
    }
    j
}

/// Variantes d'une playlist maîtresse : source UNIQUE de vérité pour la
/// réécriture (proxy) et la liste des variantes.
pub fn parse_master_variants(master: &str, base_url: &str) -> Result<Vec<MasterVariant>, String> {
    static Q: OnceLock<Regex> = OnceLock::new();
    static K: OnceLock<Regex> = OnceLock::new();
    let lines = split_lines(master);
    let mut out: Vec<MasterVariant> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let inf = js_trim(lines[i]);
        if !inf.starts_with("#EXT-X-STREAM-INF") {
            i += 1;
            continue;
        }
        // L'URI peut être précédée de lignes vides ou de commentaires.
        let j = skip_blank_or_comment(&lines, i + 1);
        if j >= lines.len() {
            break;
        }
        let uri = js_trim(lines[j]);
        let quality = re(&Q, r"QUALITY=([^,]+)")
            .captures(inf)
            .map(|c| c[1].to_string());
        let raw_key = quality.unwrap_or_else(|| format!("v{}", out.len()));
        let key = re(&K, r"[^a-zA-Z0-9_-]")
            .replace_all(&raw_key, "")
            .into_owned();
        out.push(MasterVariant {
            inf: inf.to_string(),
            key,
            uri: uri.to_string(),
            url: resolve_url(uri, base_url)?,
        });
        i = j + 1;
    }
    Ok(out)
}

/// Réécrit la playlist maîtresse : chaque variante pointe vers le proxy
/// (`playlist.m3u8?v=<QUALITY>`), les autres balises restent à leur place.
/// Les URL signées ne transitent jamais par le client (elles expirent).
pub fn rewrite_master_playlist(
    master: &str,
    master_url: &str,
    ok_id: &str,
) -> Result<String, String> {
    let lines = split_lines(master);
    // Pas de second #EXTM3U si la source en a déjà un (invalide pour hls.js).
    let mut out: Vec<String> = if js_trim_start(master).starts_with("#EXTM3U") {
        Vec::new()
    } else {
        vec!["#EXTM3U".into()]
    };
    let variants = parse_master_variants(master, master_url)?;
    // `new Map(variants.map((v) => [v.inf, v]))` : la dernière l'emporte.
    let mut by_inf: HashMap<&str, &MasterVariant> = HashMap::new();
    for v in &variants {
        by_inf.insert(v.inf.as_str(), v);
    }
    let mut i = 0;
    while i < lines.len() {
        let line = js_trim(lines[i]);
        if line.is_empty() {
            i += 1;
            continue;
        }
        if line.starts_with("#EXT-X-STREAM-INF") {
            if let Some(v) = by_inf.get(line) {
                out.push(v.inf.clone());
                let j = skip_blank_or_comment(&lines, i + 1);
                out.push(format!(
                    "/api/video/{ok_id}/playlist.m3u8?v={}",
                    encode_uri_component(&v.key)
                ));
                i = j + 1;
            } else {
                out.push(line.to_string());
                i += 1;
            }
            continue;
        }
        if line.starts_with('#') {
            out.push(line.to_string());
        }
        i += 1;
    }
    Ok(out.join("\n") + "\n")
}

/// `String.prototype.trimStart`.
fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Réécrit la playlist média : chaque segment pointe vers le proxy
/// (`segment.ts?v=…&s=…`), les URI de `#EXT-X-KEY` / `#EXT-X-MAP` vers
/// `asset.ts?v=…&a=…`.
pub fn rewrite_media_playlist(text: &str, ok_id: &str, variant_key: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for raw in split_lines(text) {
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            out.push(rewrite_uri_attribute(line, ok_id, variant_key));
            continue;
        }
        let name = last_path_part(line);
        if !is_segment_name(name) {
            continue;
        }
        out.push(format!(
            "/api/video/{ok_id}/segment.ts?v={}&s={}",
            encode_uri_component(variant_key),
            encode_uri_component(name)
        ));
    }
    out.join("\n") + "\n"
}

/// Réécrit l'attribut `URI="..."` d'une balise `#EXT-X-KEY` / `#EXT-X-MAP`
/// vers `/asset.ts` : on ne garde que le NOM du fichier, servi depuis le
/// dossier de la variante (résolu côté serveur).
fn rewrite_uri_attribute(line: &str, ok_id: &str, variant_key: &str) -> String {
    static T: OnceLock<Regex> = OnceLock::new();
    static U: OnceLock<Regex> = OnceLock::new();
    if !re(&T, r"^#EXT-X-(KEY|MAP)").is_match(line) {
        return line.to_string();
    }
    let Some(c) = re(&U, r#"URI="([^"]+)""#).captures(line) else {
        return line.to_string();
    };
    let whole = c.get(0).expect("match");
    let uri = &c[1];
    let name = last_path_part(uri);
    let repl = if asset_name_re().is_match(name) {
        format!(
            "URI=\"/api/video/{ok_id}/asset.ts?v={}&a={}\"",
            encode_uri_component(variant_key),
            encode_uri_component(name)
        )
    } else {
        format!("URI=\"{uri}\"")
    };
    format!("{}{repl}{}", &line[..whole.start()], &line[whole.end()..])
}

/// Durée moyenne des segments d'une playlist média (#EXTINF), à défaut
/// #EXT-X-TARGETDURATION, à défaut 6 s (ok.ru).
pub fn average_segment_sec(text: &str) -> f64 {
    static I: OnceLock<Regex> = OnceLock::new();
    static T: OnceLock<Regex> = OnceLock::new();
    let mut sum = 0.0;
    let mut n = 0u32;
    for c in re(&I, r"#EXTINF:\s*([0-9.]+)").captures_iter(text) {
        let v = crate::api::js_number(&c[1]);
        if v.is_finite() && v > 0.0 {
            sum += v;
            n += 1;
        }
    }
    if n > 0 {
        return sum / n as f64;
    }
    let target = re(&T, r"#EXT-X-TARGETDURATION:\s*([0-9]+)")
        .captures(text)
        .map(|c| crate::api::js_number(&c[1]))
        .unwrap_or(f64::NAN);
    if target > 0.0 {
        target
    } else {
        DEFAULT_SEGMENT_SEC
    }
}

/// Durée supposée d'un segment quand la playlist n'est pas (encore) connue (ok.ru : ~6 s).
pub const DEFAULT_SEGMENT_SEC: f64 = 6.0;

#[cfg(test)]
mod tests {
    use super::*;

    /// Playlist maître ok.ru réelle (relevée sur ok.ru/16656495217324).
    const MASTER: &str = "#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,AVERAGE-BANDWIDTH=1611076,QUALITY=sd,FRAME-RATE=30,RESOLUTION=852x480
/expires/1793345530878/srcIp/82.65.11.128/pr/10/srcAg/CHROME/ch/-536166974/type/2/sig/SqtQ-OC-xHs/ct/8/id/19025075243692/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240
/expires/1793345530878/srcIp/82.65.11.128/pr/10/type/0/sig/J-pRTPnPCh0/id/19025075243692/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=8811888,QUALITY=full,RESOLUTION=1920x1080
/expires/1793345530878/srcIp/82.65.11.128/pr/10/type/3/sig/vhkP6aUPwBo/id/19025075243692/video/
";

    /// Playlist média ok.ru réelle.
    const MEDIA: &str = "#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-ALLOW-CACHE:YES
#EXT-X-TARGETDURATION:7
#EXTINF:6.073367,
MEDIUM00000.ts
#EXTINF:6.006367,
MEDIUM00001.ts
#EXTINF:6.006367,
MEDIUM00002.ts
";

    const BASE: &str = "https://ok6-29.vkuser.net/video.m3u8?cmd=x";

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/../tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn maitre_variantes_vers_le_proxy_avec_quality() {
        let out = rewrite_master_playlist(MASTER, BASE, "16656495217324").unwrap();
        for k in ["sd", "lowest", "full"] {
            assert!(out.contains(&format!("/api/video/16656495217324/playlist.m3u8?v={k}")));
        }
        let out = rewrite_master_playlist(MASTER, BASE, "1").unwrap();
        assert_eq!(out.matches("#EXTM3U").count(), 1);
        assert!(out.contains("QUALITY=sd"));
        assert!(out.contains("RESOLUTION=852x480"));
        assert!(out.contains("BANDWIDTH=2003279"));
        assert!(!out.contains("vkuser.net"));
        assert!(!out.contains("sig="));
        // Sortie exacte (même format que Node).
        assert_eq!(
            out,
            "#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,AVERAGE-BANDWIDTH=1611076,QUALITY=sd,FRAME-RATE=30,RESOLUTION=852x480\n/api/video/1/playlist.m3u8?v=sd\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240\n/api/video/1/playlist.m3u8?v=lowest\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=8811888,QUALITY=full,RESOLUTION=1920x1080\n/api/video/1/playlist.m3u8?v=full\n"
        );
        // Sans #EXTM3U : ajouté en tête.
        assert!(
            rewrite_master_playlist("#EXT-X-STREAM-INF:QUALITY=hd\nx/\n", BASE, "1")
                .unwrap()
                .starts_with("#EXTM3U\n")
        );
    }

    #[test]
    fn media_segments_vers_le_proxy() {
        let out = rewrite_media_playlist(MEDIA, "16656495217324", "sd");
        assert!(out.contains("/api/video/16656495217324/segment.ts?v=sd&s=MEDIUM00000.ts"));
        assert!(out.contains("MEDIUM00002.ts"));
        let out = rewrite_media_playlist(MEDIA, "1", "sd");
        assert!(out.contains("#EXTINF:6.073367,"));
        assert!(out.contains("#EXT-X-TARGETDURATION:7"));
        assert_eq!(out.matches("segment.ts").count(), 3);
    }

    #[test]
    fn media_cle_et_init_vers_asset() {
        let src = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://vd1.okcdn.ru/k/key.bin\",IV=0x1\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://h/k/../x?y\"\n#EXTINF:6,\nA00001.ts\nhttps://h/dir/A00002.ts\nnot-a-segment.mp4\n";
        assert_eq!(
            rewrite_media_playlist(src, "123", "hd"),
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"/api/video/123/asset.ts?v=hd&a=key.bin\",IV=0x1\n#EXT-X-MAP:URI=\"/api/video/123/asset.ts?v=hd&a=init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://h/k/../x?y\"\n#EXTINF:6,\n/api/video/123/segment.ts?v=hd&s=A00001.ts\n/api/video/123/segment.ts?v=hd&s=A00002.ts\n"
        );
    }

    #[test]
    fn validite_des_playlists() {
        assert!(is_valid_playlist(MEDIA));
        assert!(is_valid_playlist(MASTER));
        assert!(!is_valid_playlist("<!DOCTYPE html><html>404</html>"));
        assert!(!is_valid_playlist(""));
        assert!(is_valid_playlist("#EXTM3U\r\nA00001.ts\r\n"));
        assert!(!is_valid_playlist("#EXTM3U\n#EXTINF:6,\n"));
    }

    #[test]
    fn url_de_segment() {
        let v = "https://ok6-29.vkuser.net/expires/1/type/2/sig/ABC/id/190/video/";
        assert_eq!(
            resolve_segment_url("MEDIUM00042.ts", v).unwrap(),
            "https://ok6-29.vkuser.net/expires/1/type/2/sig/ABC/id/190/video/MEDIUM00042.ts"
        );
        assert!(resolve_segment_url("https://ok6-29.vkuser.net/evil", v).is_err());
        assert!(resolve_segment_url("http://127.0.0.1/admin", v).is_err());
        assert!(resolve_segment_url("../../etc/passwd", v).is_err());
        assert!(resolve_segment_url("../MEDIUM1.ts", v).is_err());
        assert!(resolve_segment_url("dir/MEDIUM1.ts", v).is_err());
    }

    #[test]
    fn variantes_du_maitre() {
        let vs = parse_master_variants(MASTER, BASE).unwrap();
        assert_eq!(
            vs.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(),
            ["sd", "lowest", "full"]
        );
        assert!(vs
            .iter()
            .all(|v| v.url.starts_with("https://ok6-29.vkuser.net/")));
        let with_comment =
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,QUALITY=sd\n#EXT-X-VERSION:3\nmedia.m3u8\n";
        let vs = parse_master_variants(with_comment, "https://h.example/video.m3u8").unwrap();
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].key, "sd");
        assert_eq!(vs[0].url, "https://h.example/media.m3u8");
        // Sans QUALITY : clé positionnelle ; caractères hors [A-Za-z0-9_-] retirés.
        let vs = parse_master_variants(
            "#EXT-X-STREAM-INF:BANDWIDTH=1\na/\n#EXT-X-STREAM-INF:QUALITY=h d!\nb/\n",
            "https://h/x",
        )
        .unwrap();
        assert_eq!(
            vs.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(),
            ["v0", "hd"]
        );
    }

    #[test]
    fn segment_suivant() {
        assert_eq!(
            next_segment_name("MEDIUM00041.ts", 1).as_deref(),
            Some("MEDIUM00042.ts")
        );
        assert_eq!(
            next_segment_name("MEDIUM00041.ts", 4).as_deref(),
            Some("MEDIUM00045.ts")
        );
        assert_eq!(
            next_segment_name("MEDIUM00099.ts", 1).as_deref(),
            Some("MEDIUM00100.ts")
        );
        assert_eq!(
            next_segment_name("MEDIUM99999.ts", 1).as_deref(),
            Some("MEDIUM100000.ts")
        );
        assert_eq!(
            next_segment_name("seg_1a7.ts", 1).as_deref(),
            Some("seg_1a8.ts")
        );
        assert_eq!(next_segment_name("MEDIUM.ts", 1), None);
        assert_eq!(next_segment_name("MEDIUM00001.mp4", 1), None);
        let names = segment_names(&fixture("ok-media.m3u8"));
        assert_eq!(names[0], "MEDIUM00000.ts");
        assert!(names.len() > 3);
        for w in names.windows(2) {
            assert_eq!(next_segment_name(&w[0], 1).as_deref(), Some(w[1].as_str()));
        }
    }

    #[test]
    fn duree_moyenne_des_segments() {
        let avg = average_segment_sec(&fixture("ok-media.m3u8"));
        assert!((avg - 6.01).abs() < 0.05, "{avg}");
        assert_eq!(
            average_segment_sec("#EXTM3U\n#EXT-X-TARGETDURATION:4\nA00001.ts\n"),
            4.0
        );
        assert_eq!(average_segment_sec("#EXTM3U\n"), 6.0);
    }

    #[test]
    fn captures_reelles() {
        let master = fixture("ok-master.m3u8");
        let media = fixture("ok-media.m3u8");
        assert!(is_valid_playlist(&master));
        let keys: Vec<String> = parse_master_variants(&master, BASE)
            .unwrap()
            .into_iter()
            .map(|v| v.key)
            .collect();
        assert!(keys.len() >= 3);
        assert!(keys.contains(&"sd".to_string()) && keys.contains(&"full".to_string()));
        assert!(is_valid_playlist(&media));
        let out = rewrite_master_playlist(&master, BASE, "16656495217324").unwrap();
        assert!(out.contains("/api/video/16656495217324/playlist.m3u8?v=sd"));
        assert!(!out.contains("vkuser.net"));
        assert_eq!(out.matches("#EXTM3U").count(), 1);
        let source = media.lines().filter(|l| is_segment_name(l)).count();
        let out = rewrite_media_playlist(&media, "16656495217324", "sd");
        assert_eq!(out.matches("segment.ts").count(), source);
    }
}
