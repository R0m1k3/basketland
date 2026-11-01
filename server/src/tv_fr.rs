//! Diffusion des matchs à la télévision française.
//!
//! - **beIN SPORTS** : lue dans le guide des programmes XMLTV public de
//!   [XMLTV Fr](https://xmltvfr.fr) (chaînes beIN SPORTS 1, 2, 3 et MAX 4 à
//!   10, environ 5 jours de programmes). Un programme de basket dont le texte
//!   cite les deux équipes, et qui commence autour de l'heure du match, est
//!   un direct ; plus tard, un différé. Le résultat est écrit dans la colonne
//!   `matches.tv_fr` (liste JSON) et conservé une fois le match passé (le
//!   guide ne garde pas les jours écoulés).
//! - **Prime Video** : en France, Prime Video diffuse les matchs de son
//!   affiche américaine (vendredis de NBA Cup, phase finale de la NBA Cup,
//!   play-in…) : un match dont les diffuseurs ESPN citent « Prime Video » est
//!   annoncé sur Prime Video, comme les matchs de saison régulière joués en
//!   Europe (Paris, Londres, Berlin, Manchester), exclusifs Prime Video en
//!   France. Calculé à la lecture ([`tv_fr_json`]), rien n'est stocké.
//!
//! `BL_TV_GUIDE_URL` : autre adresse du guide (XMLTV, brut ou gzip) ; vide,
//! la recherche beIN SPORTS est désactivée.

use crate::db::{self, Db, MatchRow};
use crate::ingest::{run_logged, JobResult};
use crate::teams;
use crate::time::{iso_utc, parse_instant};
use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};

/// Guide complet de la France métropolitaine (≈ 9 Mo compressé, mis à jour
/// chaque nuit).
pub const DEFAULT_GUIDE_URL: &str = "https://xmltvfr.fr/xmltv/xmltv_fr.xml.gz";

fn guide_url() -> Option<String> {
    match std::env::var("BL_TV_GUIDE_URL") {
        Ok(s) if s.trim().is_empty() => None,
        Ok(s) => Some(s.trim().to_string()),
        Err(_) => Some(DEFAULT_GUIDE_URL.to_string()),
    }
}

/// Programme de basket d'une chaîne beIN SPORTS.
#[derive(Debug, Clone, PartialEq)]
pub struct Programme {
    pub channel: String,
    pub start: DateTime<Utc>,
    pub stop: DateTime<Utc>,
    /// Titre, sous-titre et description, en minuscules.
    pub text: String,
}

/// Programmes beIN SPORTS du guide et période qu'il couvre.
#[derive(Debug, Clone, Default)]
pub struct Guide {
    pub programmes: Vec<Programme>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    /// Premier début et dernière fin de programme de chaque chaîne.
    spans: std::collections::HashMap<String, (DateTime<Utc>, DateTime<Utc>)>,
}

/// `beINSPORTS1.fr` → `beIN SPORTS 1` ; `beINSPORTSMAX4.fr` → `beIN SPORTS MAX 4`.
pub fn channel_name(id: &str) -> Option<String> {
    let rest = id.strip_prefix("beINSPORTS")?;
    let rest = rest.split('.').next().unwrap_or("");
    let (max, num) = match rest.strip_prefix("MAX") {
        Some(n) => (true, n),
        None => (false, rest),
    };
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(if max {
        format!("beIN SPORTS MAX {num}")
    } else {
        format!("beIN SPORTS {num}")
    })
}

/// Heure XMLTV `20261101110000 +0100`.
pub fn parse_xmltv_time(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    let (dt, tz) = match s.split_once(' ') {
        Some((d, z)) => (d, z.trim()),
        None => (s, "+0000"),
    };
    let naive = NaiveDateTime::parse_from_str(dt.get(..14)?, "%Y%m%d%H%M%S").ok()?;
    let sign = match tz.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let h: i32 = tz.get(1..3)?.parse().ok()?;
    let m: i32 = tz.get(3..5)?.parse().ok()?;
    let off = FixedOffset::east_opt(sign * (h * 3600 + m * 60))?;
    Some(naive.and_local_timezone(off).single()?.with_timezone(&Utc))
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')?;
    Some(&tag[i..i + j])
}

/// Entités XML de base et numériques.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Textes des éléments `<title>`, `<sub-title>` et `<desc>` d'un programme.
fn texts(block: &str) -> String {
    let mut out = String::new();
    for tag in ["title", "sub-title", "desc"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let mut rest = block;
        while let Some(i) = rest.find(&open) {
            let after = &rest[i + open.len()..];
            // `<title…>` mais pas `<titlex>`.
            if !after.starts_with(['>', ' ']) {
                rest = after;
                continue;
            }
            let Some(gt) = after.find('>') else { break };
            let body = &after[gt + 1..];
            let Some(end) = body.find(&close) else { break };
            out.push_str(&unescape(&body[..end]));
            out.push(' ');
            rest = &body[end + close.len()..];
        }
    }
    out.to_lowercase()
}

/// Programme NBA (« NBA », pas « WNBA »).
fn is_nba(text: &str) -> bool {
    let b = text.as_bytes();
    let mut from = 0;
    while let Some(i) = text[from..].find("nba") {
        let at = from + i;
        let before = at == 0 || !b[at - 1].is_ascii_alphanumeric();
        let after = at + 3 >= b.len() || !b[at + 3].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = at + 3;
    }
    false
}

/// Lit le guide XMLTV (texte brut) : programmes NBA des chaînes beIN SPORTS
/// et période couverte par ces chaînes.
pub fn parse_guide<R: Read>(r: R) -> std::io::Result<Guide> {
    let mut g = Guide::default();
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    let mut block = String::new();
    let mut inside = false;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let mut rest: &str = &line;
        loop {
            if !inside {
                let Some(i) = rest.find("<programme") else {
                    break;
                };
                rest = &rest[i..];
                inside = true;
                block.clear();
            }
            match rest.find("</programme>") {
                Some(j) => {
                    block.push_str(&rest[..j]);
                    handle(&block, &mut g);
                    inside = false;
                    rest = &rest[j + "</programme>".len()..];
                }
                None => {
                    block.push_str(rest);
                    break;
                }
            }
        }
    }
    // Période couverte par toutes les chaînes à la fois.
    g.from = g.spans.values().map(|s| s.0).max();
    g.to = g.spans.values().map(|s| s.1).min();
    Ok(g)
}

fn handle(block: &str, g: &mut Guide) {
    let tag_end = block.find('>').unwrap_or(block.len());
    let tag = &block[..tag_end];
    let Some(channel) = attr(tag, "channel").and_then(channel_name) else {
        return;
    };
    let (Some(start), Some(stop)) = (
        attr(tag, "start").and_then(parse_xmltv_time),
        attr(tag, "stop").and_then(parse_xmltv_time),
    ) else {
        return;
    };
    let span = g.spans.entry(channel.clone()).or_insert((start, stop));
    span.0 = span.0.min(start);
    span.1 = span.1.max(stop);
    let text = texts(block);
    if is_nba(&text) {
        g.programmes.push(Programme {
            channel,
            start,
            stop,
            text,
        });
    }
}

/// Lit le guide, compressé (gzip) ou non.
pub fn parse_guide_bytes(bytes: &[u8]) -> std::io::Result<Guide> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        parse_guide(flate2::read::MultiGzDecoder::new(bytes))
    } else {
        parse_guide(bytes)
    }
}

/// Le texte du programme cite l'équipe (surnom : « Lakers », « Trail Blazers »…).
fn mentions(text: &str, abbr: &str) -> bool {
    let nick = teams::team_info(abbr).nick.to_lowercase();
    !nick.is_empty() && text.contains(&nick)
}

/// Une diffusion française d'un match.
#[derive(Debug, Clone, PartialEq)]
pub struct Airing {
    pub name: String,
    pub live: bool,
}

/// Diffusions beIN SPORTS d'un match dans le guide : les directs (début du
/// programme entre 1 h avant et 30 min après l'heure du match) ; à défaut,
/// le premier différé (dans les 30 h).
pub fn airings(guide: &Guide, start: DateTime<Utc>, home: &str, away: &str) -> Vec<Airing> {
    let mut live: Vec<Airing> = Vec::new();
    let mut later: Option<(DateTime<Utc>, String)> = None;
    for p in &guide.programmes {
        if !mentions(&p.text, home) || !mentions(&p.text, away) {
            continue;
        }
        let d = p.start - start;
        if d >= -Duration::minutes(60) && d <= Duration::minutes(30) {
            if !live.iter().any(|a| a.name == p.channel) {
                live.push(Airing {
                    name: p.channel.clone(),
                    live: true,
                });
            }
        } else if d > Duration::minutes(30)
            && d <= Duration::hours(30)
            && later.as_ref().is_none_or(|(t, _)| p.start < *t)
        {
            later = Some((p.start, p.channel.clone()));
        }
    }
    if live.is_empty() {
        if let Some((_, name)) = later {
            return vec![Airing { name, live: false }];
        }
    }
    live
}

fn airings_json(list: &[Airing]) -> String {
    if list.is_empty() {
        return String::new();
    }
    Value::Array(
        list.iter()
            .map(|a| json!({ "name": a.name, "live": a.live }))
            .collect(),
    )
    .to_string()
}

/// Applique le guide aux matchs NBA de la période qu'il couvre. Un match
/// trouvé est toujours écrit ; un match sans diffusion n'est effacé que si
/// le guide couvre son direct (sinon, ce qu'on savait est gardé).
pub fn apply_guide(c: &Connection, guide: &Guide) -> rusqlite::Result<(usize, usize)> {
    let (Some(from), Some(to)) = (guide.from, guide.to) else {
        return Ok((0, 0));
    };
    let mut st = c.prepare(
        "SELECT * FROM matches WHERE league = 'nba' AND date_utc >= ?1 AND date_utc <= ?2",
    )?;
    let rows: Vec<MatchRow> = st
        .query_map(
            params![
                iso_utc(from - Duration::hours(30)),
                iso_utc(to + Duration::hours(1))
            ],
            db::match_row,
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut up = c.prepare_cached(
        "UPDATE matches SET tv_fr = ?1 WHERE id = ?2 AND IFNULL(tv_fr, '') <> ?1",
    )?;
    let (mut found, mut changed) = (0, 0);
    for m in rows {
        let Some(start) = parse_instant(&m.date_utc) else {
            continue;
        };
        let list = airings(guide, start, &m.home_abbr, &m.away_abbr);
        let covered = start >= from + Duration::hours(1) && start <= to - Duration::hours(3);
        if list.is_empty() && !covered {
            continue;
        }
        if !list.is_empty() {
            found += 1;
        }
        changed += up.execute(params![airings_json(&list), m.id])?;
    }
    Ok((found, changed))
}

/// Client du guide : fichier de plusieurs Mo, délai plus long que l'API.
fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("basketland/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("client HTTP")
    })
}

/// Job `sync-tv-fr` : guide téléchargé, programmes beIN SPORTS appliqués.
pub async fn sync_tv_fr(db: &Db) -> JobResult {
    run_logged(db, "sync-tv-fr", || async {
        let Some(url) = guide_url() else {
            return Ok("désactivé (BL_TV_GUIDE_URL vide)".into());
        };
        let res = client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("guide TV injoignable : {e}"))?;
        if !res.status().is_success() {
            return Err(format!("HTTP {} pour {url}", res.status().as_u16()));
        }
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        let guide = tokio::task::spawn_blocking(move || parse_guide_bytes(&bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("guide TV illisible : {e}"))?;
        let n = guide.programmes.len();
        let (found, changed) = db.run(move |c| apply_guide(c, &guide)).await?;
        Ok(format!(
            "{n} programmes NBA sur beIN SPORTS, {found} matchs diffusés, {changed} mis à jour"
        ))
    })
    .await
}

/// Matchs de saison régulière joués en Europe, exclusifs Prime Video en France.
fn european_game(note: &str) -> bool {
    let n = note.to_ascii_lowercase();
    ["paris", "london", "berlin", "manchester"]
        .iter()
        .any(|c| n.contains(c))
}

/// Champ `tv_fr` d'un match : diffusions beIN SPORTS (guide) et Prime Video
/// (`[{"name", "kind": "bein"|"prime", "live"}]`), `None` sans diffusion connue.
pub fn tv_fr_json(m: &MatchRow) -> Option<Value> {
    let mut out: Vec<Value> = Vec::new();
    if let Some(Value::Array(list)) = m
        .tv_fr
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
    {
        for a in list {
            if let Some(name) = a["name"].as_str() {
                out.push(json!({
                    "name": name,
                    "kind": "bein",
                    "live": a["live"].as_bool().unwrap_or(true),
                }));
            }
        }
    }
    let broadcast = m.broadcast.as_deref().unwrap_or("").to_ascii_lowercase();
    let note = m.competition.as_deref().unwrap_or("");
    if broadcast.contains("prime video") || european_game(note) {
        out.push(json!({ "name": "Prime Video", "kind": "prime", "live": true }));
    }
    (!out.is_empty()).then_some(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUIDE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="beINSPORTS1.fr"><display-name>beIN SPORTS 1</display-name></channel>
  <programme start="20261101090000 +0100" stop="20261101100000 +0100" channel="TF1.fr">
    <title lang="fr">NBA : Lakers / Raptors (autre chaîne)</title>
  </programme>
  <programme start="20261102030000 +0100" stop="20261102054500 +0100" channel="beINSPORTS1.fr">
    <title lang="fr">Basket-ball : NBA | Los Angeles Lakers / Toronto Raptors</title>
    <desc lang="fr">Diffusion d&apos;un match de la NBA.</desc>
  </programme>
  <programme start="20261102104500 +0100" stop="20261102124500 +0100" channel="beINSPORTS1.fr">
    <title lang="fr">Basket-ball : NBA</title>
    <sub-title lang="fr">Los Angeles Lakers / Toronto Raptors</sub-title>
  </programme>
  <programme start="20261101010000 +0100" stop="20261101030000 +0100" channel="beINSPORTSMAX4.fr"><title lang="fr">WNBA | Golden State Valkyries / Atlanta Dream</title></programme>
  <programme start="20261108104500 +0100" stop="20261108124500 +0100" channel="beINSPORTS2.fr">
    <title lang="fr">Indiana Pacers / Denver Nuggets</title>
    <sub-title lang="fr">NBA - Saison régulière</sub-title>
  </programme>
</tv>
"#;

    fn at(s: &str) -> DateTime<Utc> {
        parse_instant(s).unwrap()
    }

    #[test]
    fn chaines_et_heures() {
        assert_eq!(
            channel_name("beINSPORTS1.fr").as_deref(),
            Some("beIN SPORTS 1")
        );
        assert_eq!(
            channel_name("beINSPORTSMAX10.fr").as_deref(),
            Some("beIN SPORTS MAX 10")
        );
        assert_eq!(channel_name("TF1.fr"), None);
        assert_eq!(
            parse_xmltv_time("20261102030000 +0100"),
            Some(at("2026-11-02T02:00:00.000Z"))
        );
        assert_eq!(unescape("d&apos;un &amp; &#233;t&#xE9;"), "d'un & été");
    }

    #[test]
    fn programmes_nba_de_bein_seulement() {
        let g = parse_guide(GUIDE.as_bytes()).unwrap();
        // TF1 ignorée, WNBA écartée.
        assert_eq!(g.programmes.len(), 3);
        assert!(g.programmes.iter().all(|p| p.channel.starts_with("beIN")));
        // Période commune aux chaînes : du dernier premier programme
        // (beIN SPORTS 2) à la première fin de guide (beIN SPORTS MAX 4).
        assert_eq!(g.from, Some(at("2026-11-08T09:45:00.000Z")));
        assert_eq!(g.to, Some(at("2026-11-01T02:00:00.000Z")));
        let gz = {
            use std::io::Write;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(GUIDE.as_bytes()).unwrap();
            e.finish().unwrap()
        };
        assert_eq!(parse_guide_bytes(&gz).unwrap().programmes, g.programmes);
    }

    #[test]
    fn direct_puis_differe() {
        let g = parse_guide(GUIDE.as_bytes()).unwrap();
        // Coup d'envoi 02:30 UTC, programme à 02:00 UTC : direct.
        let a = airings(&g, at("2026-11-02T02:30:00.000Z"), "TOR", "LAL");
        assert_eq!(
            a,
            vec![Airing {
                name: "beIN SPORTS 1".into(),
                live: true
            }]
        );
        // Direct non trouvé (heure éloignée) : premier différé.
        let a = airings(&g, at("2026-11-01T23:00:00.000Z"), "TOR", "LAL");
        assert_eq!(
            a,
            vec![Airing {
                name: "beIN SPORTS 1".into(),
                live: false
            }]
        );
        // Le titre seul suffit (affiche dans le titre, « NBA » en sous-titre).
        let a = airings(&g, at("2026-11-08T10:00:00.000Z"), "DEN", "IND");
        assert_eq!(a.len(), 1);
        // Autre affiche : rien.
        assert!(airings(&g, at("2026-11-02T02:30:00.000Z"), "BOS", "LAL").is_empty());
    }
}
