//! Flux ok.ru : lecture de la page d'embed, URL signées, variantes et MP4
//! (partie sans réseau de `src/lib/okru.ts` ; la résolution avec cache est
//! dans [`crate::video`]).
//!
//! GET https://ok.ru/videoembed/<id> → attribut `data-options` (JSON échappé
//! HTML) → flashvars.metadata (objet ou chaîne JSON) → `hlsManifestUrl`
//! signée (expires=…, srcAg=CHROME) et `videos` (MP4 progressifs par qualité).
//!
//! Tant qu'ok.ru n'a pas fini de traiter une vidéo, l'embed n'a PAS de
//! `hlsManifestUrl` : seule la qualité « mobile » existe, en MP4 progressif.
//! Ce MP4 est lisible : on le relaie plutôt que de déclarer le replay absent.

use crate::hls;
use crate::jsval::js_string;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

pub const OK_REFERER: &str = "https://ok.ru/";

/// En-têtes exigés par ok.ru (`OK_HEADERS`).
pub fn ok_headers() -> Vec<(&'static str, String)> {
    vec![
        ("Referer", OK_REFERER.to_string()),
        ("User-Agent", crate::http::BROWSER_UA.to_string()),
        ("Origin", "https://ok.ru".to_string()),
    ]
}

/// Un MP4 progressif signé d'ok.ru (`name` = mobile, lowest, low, sd, hd, full…).
#[derive(Debug, Clone, PartialEq)]
pub struct Mp4Source {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OkEmbedInfo {
    pub ok_id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub poster: Option<String>,
    pub hls_manifest_url: Option<String>,
    /// MP4 progressifs lisibles (qualités `disallowed` exclues), dans l'ordre d'ok.ru.
    pub mp4: Vec<Mp4Source>,
    pub status: String,
}

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("regex"))
}

/// `isValidOkId` : 5 à 25 chiffres.
pub fn is_valid_ok_id(id: &str) -> bool {
    (5..=25).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// `String.fromCharCode(n)` (unité UTF-16 ; une demi-paire isolée devient U+FFFD).
fn from_char_code(n: f64) -> String {
    let unit = if n.is_finite() {
        (n.trunc().rem_euclid(65_536.0)) as u32
    } else {
        0
    };
    char::from_u32(unit)
        .map(String::from)
        .unwrap_or_else(|| "\u{fffd}".into())
}

/// Décodage minimal des entités HTML (`decodeHtmlEntities`), dans le même ordre.
pub fn decode_html_entities(s: &str) -> String {
    static DEC: OnceLock<Regex> = OnceLock::new();
    static HEX: OnceLock<Regex> = OnceLock::new();
    static APOS: OnceLock<Regex> = OnceLock::new();
    let s = s.replace("&quot;", "\"");
    let s = re(&APOS, r"&#0?39;|&apos;")
        .replace_all(&s, "'")
        .into_owned();
    let s = s.replace("&lt;", "<").replace("&gt;", ">");
    let s = re(&DEC, r"&#([0-9]+);")
        .replace_all(&s, |c: &regex::Captures| {
            from_char_code(crate::api::js_number(&c[1]))
        })
        .into_owned();
    let s = re(&HEX, r"(?i)&#x([0-9a-f]+);")
        .replace_all(&s, |c: &regex::Captures| {
            from_char_code(u64::from_str_radix(&c[1], 16).map_or(f64::INFINITY, |v| v as f64))
        })
        .into_owned();
    s.replace("&amp;", "&")
}

/// MP4 du champ `videos` : entrées `disallowed: true`, URL non https et
/// doublons de qualité écartés (le proxy les refuserait de toute façon).
pub fn parse_ok_videos(raw: Option<&Value>) -> Vec<Mp4Source> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut out: Vec<Mp4Source> = Vec::new();
    for v in items {
        let Value::Object(o) = v else { continue };
        if o.get("disallowed") == Some(&Value::Bool(true)) {
            continue;
        }
        let (Some(Value::String(name)), Some(Value::String(url))) = (o.get("name"), o.get("url"))
        else {
            continue;
        };
        if !url.starts_with("https://") || out.iter().any(|m| &m.name == name) {
            continue;
        }
        out.push(Mp4Source {
            name: name.clone(),
            url: url.clone(),
        });
    }
    out
}

/// Valeur « vraie » au sens de JavaScript.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `a ?? b` : absent ou null → `b`.
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    crate::jsval::or_else(a, b).filter(|v| !v.is_null())
}

/// `Number(x)` d'une valeur JSON.
fn js_number_of(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => crate::api::js_number(s),
        Value::Bool(b) => *b as u8 as f64,
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

pub fn parse_ok_embed(html: &str, ok_id: &str) -> OkEmbedInfo {
    static DQ: OnceLock<Regex> = OnceLock::new();
    static SQ: OnceLock<Regex> = OnceLock::new();
    static HLS: OnceLock<Regex> = OnceLock::new();
    static DUR: OnceLock<Regex> = OnceLock::new();
    let mut info = OkEmbedInfo {
        ok_id: ok_id.to_string(),
        title: String::new(),
        duration: None,
        poster: None,
        hls_manifest_url: None,
        mp4: Vec::new(),
        status: String::new(),
    };
    let m = re(&DQ, r#"data-options="([^"]+)""#)
        .captures(html)
        .or_else(|| re(&SQ, r"data-options='([^']+)'").captures(html));
    if let Some(m) = m {
        // Toute erreur de lecture : repli sur les regex ci-dessous.
        if let Ok(opts) = serde_json::from_str::<Value>(&decode_html_entities(&m[1])) {
            let raw = opts.get("flashvars").and_then(|f| f.get("metadata"));
            let md: Option<Value> = match raw {
                Some(Value::String(s)) => serde_json::from_str(s).ok(),
                Some(v) => Some(v.clone()),
                None => None,
            };
            let parsed_ok = !matches!(raw, Some(Value::String(_))) || md.is_some();
            if let Some(md) = md.filter(|m| parsed_ok && truthy(m)) {
                let movie = md.get("movie");
                info.hls_manifest_url =
                    coalesce(md.get("hlsManifestUrl"), md.get("hlsMasterPlaylistUrl"))
                        .map(js_string);
                info.mp4 = parse_ok_videos(md.get("videos"));
                info.duration = movie
                    .and_then(|m| m.get("duration"))
                    .filter(|d| truthy(d))
                    .map(js_number_of);
                info.poster = coalesce(movie.and_then(|m| m.get("poster")), opts.get("poster"))
                    .map(js_string);
                info.title = coalesce(movie.and_then(|m| m.get("title")), None)
                    .map(js_string)
                    .unwrap_or_default();
                info.status = coalesce(movie.and_then(|m| m.get("status")), None)
                    .map(js_string)
                    .unwrap_or_default();
            }
        }
    }
    if info.hls_manifest_url.as_deref().is_none_or(str::is_empty) {
        let decoded = decode_html_entities(html);
        if let Some(u) = re(&HLS, r#""hlsManifestUrl"\s*:\s*"([^"]+)""#).captures(&decoded) {
            info.hls_manifest_url = Some(u[1].replace("\\u0026", "&").replace("\\/", "/"));
        }
    }
    if info.duration.is_none() {
        let decoded = decode_html_entities(html);
        if let Some(d) = re(&DUR, r#""duration"\s*:\s*"?([0-9]+)"?"#).captures(&decoded) {
            info.duration = Some(crate::api::js_number(&d[1]));
        }
    }
    info
}

/// Timestamp d'expiration (ms) contenu dans une URL signée, si présent.
pub fn signed_url_expiry(url: &str) -> Option<f64> {
    static R: OnceLock<Regex> = OnceLock::new();
    let c = re(&R, r"[?&/]expires[=/]([0-9]{10,13})").captures(url)?;
    let n: f64 = c[1].parse().ok()?;
    Some(if n < 1e12 { n * 1000.0 } else { n })
}

/// Une variante HLS (clé QUALITY, URL absolue signée jamais exposée au client).
#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub key: String,
    pub bandwidth: f64,
    pub resolution: String,
    pub url: String,
}

/// Variantes d'une playlist maîtresse, par le parseur canonique de [`hls`] :
/// les clés doivent être EXACTEMENT celles de la playlist réécrite.
pub fn parse_master_variants(text: &str, base_url: &str) -> Result<Vec<Variant>, String> {
    static BW: OnceLock<Regex> = OnceLock::new();
    static RES: OnceLock<Regex> = OnceLock::new();
    Ok(hls::parse_master_variants(text, base_url)?
        .into_iter()
        .map(|v| Variant {
            bandwidth: re(&BW, r"[^-]BANDWIDTH=([0-9]+)")
                .captures(&v.inf)
                .map_or(0.0, |c| crate::api::js_number(&c[1])),
            resolution: re(&RES, r"RESOLUTION=([^,]+)")
                .captures(&v.inf)
                .map(|c| c[1].to_string())
                .unwrap_or_default(),
            key: v.key,
            url: v.url,
        })
        .collect())
}

/// Ordre de préférence des MP4 ok.ru (meilleure qualité d'abord).
pub const MP4_QUALITY_ORDER: [&str; 6] = ["full", "hd", "sd", "low", "lowest", "mobile"];

fn mp4_rank(name: &str) -> usize {
    MP4_QUALITY_ORDER
        .iter()
        .position(|q| *q == name)
        .unwrap_or(MP4_QUALITY_ORDER.len())
}

/// Meilleur MP4 disponible (full > hd > sd > low > lowest > mobile, inconnus
/// en dernier ; tri stable : à rang égal, l'ordre d'ok.ru).
pub fn best_mp4(sources: &[Mp4Source]) -> Option<&Mp4Source> {
    sources.iter().min_by_key(|m| mp4_rank(&m.name))
}

/// Hôtes autorisés pour les médias (anti-SSRF) : `https` exigé, hôtes de
/// média réellement servis par ok.ru.
pub fn is_allowed_media_host(url: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" {
        return false;
    }
    let host = match u.host() {
        Some(url::Host::Domain(d)) => d.to_string(),
        Some(h) => h.to_string(),
        None => return false,
    };
    re(
        &R,
        r"(^|\.)(vkuser\.net|okcdn\.ru|mycdn\.me|ok\.ru|vk\.com|userapi\.com|vkuseraudio\.net|vkuservideo\.net)$",
    )
    .is_match(&host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub const OK_ID: &str = "16668708768428";

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/../tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn signed_mp4(name: &str, exp: i64) -> String {
        crate::video::testkit::signed_mp4(name, exp, "vd123.okcdn.ru")
    }

    #[test]
    fn embed_reel_six_qualites() {
        let info = parse_ok_embed(&fixture("ok-embed.html"), "16656495217324");
        let hls = info.hls_manifest_url.clone().unwrap();
        assert!(hls.contains("video.m3u8"));
        assert!(hls.contains("vkuser.net/video.m3u8") && hls.contains("expires="));
        assert_eq!(
            info.mp4.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            ["mobile", "lowest", "low", "sd", "hd", "full"]
        );
        assert!(info.mp4[0]
            .url
            .starts_with("https://ok6-29.vkuser.net/?expires=1793348942232&"));
        assert!(!info.mp4[0].url.contains("&amp;"));
        assert!(info.duration.unwrap() > 3600.0);
    }

    #[test]
    fn embed_en_traitement_mp4_mobile_seul() {
        let exp = 1_900_000_000_000;
        let html = crate::video::testkit::embed_html(
            None,
            &[("mobile", signed_mp4("mobile", exp), false)],
            false,
        );
        let info = parse_ok_embed(&html, OK_ID);
        assert_eq!(info.hls_manifest_url, None);
        assert_eq!(info.duration, Some(6016.0));
        assert_eq!(
            info.mp4,
            vec![Mp4Source {
                name: "mobile".into(),
                url: signed_mp4("mobile", exp)
            }]
        );
        assert_eq!(info.status, "OK");
    }

    #[test]
    fn metadata_en_chaine_json() {
        let html =
            crate::video::testkit::embed_html(None, &[("sd", signed_mp4("sd", 1), false)], true);
        let info = parse_ok_embed(&html, OK_ID);
        assert_eq!(info.mp4.len(), 1);
        assert_eq!(info.mp4[0].name, "sd");
    }

    #[test]
    fn videos_filtrees() {
        let v = json!([
            { "name": "mobile", "url": "https://a.okcdn.ru/?x=1", "disallowed": false },
            { "name": "hd", "url": "https://a.okcdn.ru/?x=2", "disallowed": true },
            { "name": "sd", "url": "http://a.okcdn.ru/?x=3" },
            { "name": "low" },
            null,
            "full",
        ]);
        assert_eq!(
            parse_ok_videos(Some(&v)),
            vec![Mp4Source {
                name: "mobile".into(),
                url: "https://a.okcdn.ru/?x=1".into()
            }]
        );
        assert_eq!(parse_ok_videos(None), vec![]);
    }

    #[test]
    fn meilleur_mp4() {
        let src: Vec<Mp4Source> = ["mobile", "weird", "low", "hd", "lowest", "sd"]
            .iter()
            .map(|n| Mp4Source {
                name: n.to_string(),
                url: format!("https://x/{n}"),
            })
            .collect();
        assert_eq!(best_mp4(&src).unwrap().name, "hd");
        let two = [
            Mp4Source {
                name: "weird".into(),
                url: "u".into(),
            },
            Mp4Source {
                name: "mobile".into(),
                url: "m".into(),
            },
        ];
        assert_eq!(best_mp4(&two).unwrap().name, "mobile");
        assert_eq!(best_mp4(&[]), None);
    }

    #[test]
    fn embed_duree_affiche_et_repli_regex() {
        let html = r#"<div data-options='{"flashvars":{"metadata":"{\"movie\":{\"duration\":\"8033\",\"poster\":\"https://iv.okcdn.ru/i?r=X\"}}"},"poster":"https://p"}'></div>"#;
        let info = parse_ok_embed(html, "16656495217324");
        assert_eq!(info.duration, Some(8033.0));
        assert_eq!(info.poster.as_deref(), Some("https://iv.okcdn.ru/i?r=X"));
        let html = r#"<script>{"hlsManifestUrl":"https:\/\/ok6-29.vkuser.net\/video.m3u8?cmd=videoPlayerCdn&expires=1793345291075&sig=ABC"}</script>"#;
        let info = parse_ok_embed(html, "1");
        let u = info.hls_manifest_url.unwrap();
        assert!(u.contains("vkuser.net") && u.contains("sig=ABC"));
        assert_eq!(
            u,
            "https://ok6-29.vkuser.net/video.m3u8?cmd=videoPlayerCdn&expires=1793345291075&sig=ABC"
        );
    }

    #[test]
    fn entites_html() {
        assert_eq!(
            decode_html_entities(
                "&quot;a&quot; &#39;b&#039; &apos;c&apos; &lt;&gt; &#65;&#x42;&#X43; &amp;amp;"
            ),
            "\"a\" 'b' 'c' <> ABC &amp;"
        );
    }

    #[test]
    fn expiration_signee() {
        assert_eq!(
            signed_url_expiry("https://h/video.m3u8?expires=1793345291075"),
            Some(1793345291075.0)
        );
        assert_eq!(
            signed_url_expiry("https://h/expires/1793345291/type/2/"),
            Some(1793345291000.0)
        );
        assert_eq!(signed_url_expiry("https://h/video.m3u8?x=1"), None);
    }

    #[test]
    fn identifiant_ok() {
        assert!(is_valid_ok_id("16656495217324"));
        assert!(!is_valid_ok_id("abc"));
        assert!(!is_valid_ok_id(""));
        assert!(!is_valid_ok_id("../../etc"));
        assert!(!is_valid_ok_id("1234"));
        assert!(!is_valid_ok_id("١٢٣٤٥٦"));
    }

    #[test]
    fn hotes_de_media_autorises() {
        assert!(is_allowed_media_host(
            "https://ok6-29.vkuser.net/a/MEDIUM1.ts"
        ));
        assert!(is_allowed_media_host("https://st.okcdn.ru/a/MEDIUM1.ts"));
        assert!(is_allowed_media_host("https://OK.RU/x"));
        assert!(!is_allowed_media_host("https://evil.example.com/a.ts"));
        assert!(!is_allowed_media_host("http://ok6-29.vkuser.net/a.ts"));
        assert!(!is_allowed_media_host("pas une url"));
        assert!(!is_allowed_media_host("https://ok.ru.evil.com/a.ts"));
        assert!(!is_allowed_media_host("https://evilvkuser.net/a.ts"));
    }

    #[test]
    fn variantes_avec_bande_passante() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,AVERAGE-BANDWIDTH=1611076,QUALITY=sd,RESOLUTION=852x480\n/expires/1/type/2/video/\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240\n/expires/1/type/0/video/\n";
        let vs =
            parse_master_variants(master, "https://ok6-29.vkuser.net/video.m3u8?cmd=x").unwrap();
        assert_eq!(vs.len(), 2);
        assert_eq!(vs[0].key, "sd");
        assert_eq!(vs[0].bandwidth, 2003279.0);
        assert_eq!(vs[0].resolution, "852x480");
        assert_eq!(
            vs[0].url,
            "https://ok6-29.vkuser.net/expires/1/type/2/video/"
        );
        let hlsv =
            hls::parse_master_variants(master, "https://ok6-29.vkuser.net/video.m3u8").unwrap();
        assert_eq!(
            hlsv.iter().map(|v| (&v.key, &v.url)).collect::<Vec<_>>(),
            vs.iter().map(|v| (&v.key, &v.url)).collect::<Vec<_>>()
        );
    }
}
