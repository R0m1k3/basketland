//! Diffusion des matchs à la télévision française.
//!
//! - **beIN SPORTS** : lue dans le guide des programmes XMLTV public de
//!   [XMLTV Fr](https://xmltvfr.fr) (chaînes beIN SPORTS 1, 2, 3 et MAX 4 à
//!   10, environ 5 jours de programmes). Un programme de basket dont le texte
//!   cite les deux équipes, et qui commence autour de l'heure du match, est
//!   un direct ; plus tard, un différé. Le résultat est écrit dans la colonne
//!   `matches.tv_fr` (liste JSON) et conservé une fois le match passé (le
//!   guide ne garde pas les jours écoulés).
//! - **beIN SPORTS, Euroleague** : programmes « Euroligue » du même guide,
//!   appariés aux matchs de la saison Euroleague (voir [`apply_euro`]) ;
//!   résultat dans `kv_cache`, clé `tv_fr:euroleague:<saison>`.
//! - **Prime Video** : un match est annoncé sur Prime Video si les
//!   diffuseurs ESPN citent « Prime Video » (affiche américaine de Prime,
//!   aussi diffusée en France), s'il figure dans la programmation de Prime
//!   Video France ([`crate::prime_fr`], relue chaque jour), ou s'il est joué
//!   en Europe (Paris, Londres, Berlin, Manchester). Calculé à la lecture
//!   ([`tv_fr_json`]).
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
use std::sync::Arc;

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
    /// Titre et sous-titre, normalisés ([`fold`]) : l'affiche, sans la
    /// description (qui peut citer d'autres équipes).
    pub head: String,
}

/// Programmes beIN SPORTS du guide et période qu'il couvre.
#[derive(Debug, Clone, Default)]
pub struct Guide {
    /// Programmes NBA.
    pub programmes: Vec<Programme>,
    /// Matchs d'Euroligue masculine (75 min ou plus : ni avant-match ni résumé).
    pub euro: Vec<Programme>,
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

/// Textes des éléments `<title>` et `<sub-title>` (affiche), puis avec
/// `<desc>` (texte complet, en minuscules) d'un programme.
fn texts(block: &str) -> (String, String) {
    let head = format!(
        "{}{}",
        tag_texts(block, "title"),
        tag_texts(block, "sub-title")
    );
    let text = format!("{head}{}", tag_texts(block, "desc")).to_lowercase();
    (fold(&head), text)
}

/// Minuscules sans accents (« Panathinaïkos » → « panathinaikos »,
/// « München » → « munchen », « İstanbul » → « istanbul »).
pub fn fold(s: &str) -> String {
    use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ı' { 'i' } else { c })
        .collect()
}

/// Textes de tous les éléments `<tag>` d'un programme.
fn tag_texts(block: &str, tag: &str) -> String {
    let mut out = String::new();
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
    out
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
    let (head, text) = texts(block);
    let p = Programme {
        channel,
        start,
        stop,
        text,
        head,
    };
    // Listes indépendantes : la description d'un match d'Euroligue peut
    // citer la NBA (l'appariement NBA exige de toute façon deux franchises).
    if is_euroleague(&p.head, &fold(&p.text)) && p.stop - p.start >= Duration::minutes(75) {
        g.euro.push(p.clone());
    }
    if is_nba(&p.text) {
        g.programmes.push(p);
    }
}

/// Programme d'Euroligue masculine : la compétition est citée quelque part
/// (`text`, normalisé), l'affiche (`head`) n'est ni féminine ni d'EuroCoupe
/// (une description d'Euroligue peut citer l'EuroCoupe).
fn is_euroleague(head: &str, text: &str) -> bool {
    (text.contains("euroligue") || text.contains("euroleague"))
        && !["feminin", "women", "eurocup", "eurocoupe"]
            .iter()
            .any(|w| head.contains(w))
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
    airings_by(&guide.programmes, start, |p| {
        mentions(&p.text, home) && mentions(&p.text, away)
    })
}

/// Diffusions d'un match parmi `programmes` : ceux que `cites` rattache au
/// match, avec les fenêtres de [`airings`].
pub fn airings_by(
    programmes: &[Programme],
    start: DateTime<Utc>,
    cites: impl Fn(&Programme) -> bool,
) -> Vec<Airing> {
    let mut live: Vec<Airing> = Vec::new();
    let mut later: Option<(DateTime<Utc>, String)> = None;
    for p in programmes {
        if !cites(p) {
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

// ---------------------------------------------------------------- Euroleague

/// Noms des clubs dans le guide (normalisés), par code de l'API Euroleague
/// (`code`, pas `tvCode`). À revoir à chaque saison : un club absent passe
/// par [`club_keys`] (nom officiel) et est signalé dans le message du job.
const EURO_ALIASES: &[(&str, &[&str])] = &[
    ("ASV", &["asvel", "villeurbanne"]),
    ("BAR", &["barcelona", "barcelone", "barca"]),
    ("BAS", &["baskonia", "vitoria"]),
    ("BES", &["besiktas"]),
    ("DUB", &["dubai"]),
    ("HTA", &["hapoel"]),
    ("IST", &["efes"]),
    ("MAD", &["real madrid"]),
    ("MIL", &["milan", "olimpia"]),
    ("MUN", &["bayern"]),
    ("OLY", &["olympiacos", "olympiakos"]),
    ("PAM", &["valencia", "valence"]),
    ("PAN", &["panathinaikos"]),
    ("PAR", &["partizan"]),
    ("PRS", &["paris"]),
    ("RED", &["crvena", "zvezda", "etoile rouge"]),
    ("TEL", &["maccabi"]),
    ("ULK", &["fenerbahce"]),
    ("VIR", &["virtus"]),
    ("ZAL", &["zalgiris"]),
];

/// Mots trop communs pour désigner un club à eux seuls.
const COMMON_WORDS: &[&str] = &[
    "basketball",
    "basket",
    "istanbul",
    "belgrade",
    "athens",
    "piraeus",
    "kaunas",
];

/// Mots désignant un club dans l'affiche d'un programme, et vrai si le club
/// est hors de [`EURO_ALIASES`] (repli : nom officiel entier, puis ses mots
/// de 5 lettres ou plus hors [`COMMON_WORDS`]).
pub fn club_keys(code: &str, full: &str) -> (Vec<String>, bool) {
    if let Some((_, keys)) = EURO_ALIASES.iter().find(|(c, _)| *c == code) {
        return (keys.iter().map(|k| k.to_string()).collect(), false);
    }
    let name = fold(full);
    let mut keys = vec![name.clone()];
    for w in name.split(|c: char| !c.is_alphanumeric()) {
        if w.chars().count() >= 5 && !COMMON_WORDS.contains(&w) && !keys.iter().any(|k| k == w) {
            keys.push(w.to_string());
        }
    }
    (keys, true)
}

fn cites(head: &str, keys: &[String]) -> bool {
    keys.iter()
        .any(|k| !k.is_empty() && head.contains(k.as_str()))
}

/// Applique le guide aux matchs de la saison Euroleague (`games`, format
/// [`crate::euroleague::parse_games`]) et met à jour `prev`
/// (`{"<gameCode>": [{name, live}]}`). Même règle que [`apply_guide`] : un
/// match trouvé est écrit ; un match sans diffusion n'est effacé que si le
/// guide couvre son direct, sinon ce qu'on savait est gardé. Rend le nombre
/// de matchs trouvés et les codes des clubs hors de la table de noms.
pub fn apply_euro(
    guide: &Guide,
    games: &[Value],
    prev: &mut serde_json::Map<String, Value>,
) -> (usize, Vec<String>) {
    let mut fallback: Vec<String> = Vec::new();
    let (Some(from), Some(to)) = (guide.from, guide.to) else {
        return (0, fallback);
    };
    let (lo, hi) = (from.min(to), from.max(to));
    let mut found = 0;
    for g in games {
        let (Some(code), Some(start)) = (
            g["code"].as_i64(),
            g["utc"].as_str().and_then(parse_instant),
        ) else {
            continue;
        };
        if start < lo - Duration::hours(30) || start > hi + Duration::hours(1) {
            continue;
        }
        let mut keys = |side: &str| {
            let club = &g[side];
            let c = club["code"].as_str().unwrap_or("");
            let (k, fb) = club_keys(c, club["full"].as_str().unwrap_or(""));
            if fb && !fallback.iter().any(|x| x == c) {
                fallback.push(c.to_string());
            }
            k
        };
        let (home, away) = (keys("home"), keys("away"));
        let list = airings_by(&guide.euro, start, |p| {
            cites(&p.head, &home) && cites(&p.head, &away)
        });
        let covered =
            from <= to && start >= from + Duration::hours(1) && start <= to - Duration::hours(3);
        let key = code.to_string();
        if !list.is_empty() {
            found += 1;
            let v: Vec<Value> = list
                .iter()
                .map(|a| json!({ "name": a.name, "live": a.live }))
                .collect();
            prev.insert(key, Value::Array(v));
        } else if covered {
            prev.remove(&key);
        }
    }
    (found, fallback)
}

/// Clé `kv_cache` des diffusions beIN SPORTS d'une saison Euroleague.
pub fn euro_key(season: &str) -> String {
    format!("tv_fr:euroleague:{season}")
}

/// Champ `tv_fr` d'un match Euroleague (même format que les matchs NBA),
/// `None` sans diffusion connue.
pub fn euro_tv_json(tv: Option<&Value>, code: Option<i64>) -> Option<Value> {
    let list = tv?.get(code?.to_string())?.as_array()?;
    let out: Vec<Value> = list
        .iter()
        .filter_map(|a| {
            Some(json!({
                "name": a["name"].as_str()?,
                "kind": "bein",
                "live": a["live"].as_bool().unwrap_or(true),
            }))
        })
        .collect();
    (!out.is_empty()).then_some(Value::Array(out))
}

/// Partie Euroleague du job : saison en cache (sinon lue sur l'API),
/// diffusions appariées et enregistrées.
async fn sync_euro(db: &Db, guide: Arc<Guide>) -> Result<String, String> {
    let season = crate::euroleague::season_code(Utc::now());
    let games_key = crate::euroleague::cache_key(&season);
    let k = games_key.clone();
    let data = match db
        .run(move |c| db::kv_get_at(c, &k, None, Utc::now()))
        .await?
    {
        Some(v) => v,
        None => {
            let v = crate::euroleague::fetch(&season).await?;
            let (v2, k) = (v.clone(), games_key.clone());
            db.run(move |c| db::kv_set(c, &k, &v2)).await?;
            v
        }
    };
    let games: Vec<Value> = data["games"].as_array().cloned().unwrap_or_default();
    let key = euro_key(&season);
    db.run(move |c| {
        let mut map = match db::kv_get_at(c, &key, None, Utc::now())? {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        let before = Value::Object(map.clone());
        let (found, fallback) = apply_euro(&guide, &games, &mut map);
        let after = Value::Object(map);
        if after != before {
            db::kv_set(c, &key, &after)?;
        }
        let fallback = if fallback.is_empty() {
            String::new()
        } else {
            format!(" (clubs hors table de noms : {})", fallback.join(", "))
        };
        Ok(format!("{found} matchs Euroleague diffusés{fallback}"))
    })
    .await
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

/// Job `sync-tv-fr` : liste Prime Video France relue (une fois par jour),
/// guide téléchargé, programmes beIN SPORTS appliqués aux matchs NBA et
/// Euroleague.
pub async fn sync_tv_fr(db: &Db) -> JobResult {
    run_logged(db, "sync-tv-fr", || async {
        let prime = crate::prime_fr::refresh(db).await;
        let Some(url) = guide_url() else {
            return Ok(format!("guide désactivé (BL_TV_GUIDE_URL vide) ; {prime}"));
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
        let guide = Arc::new(guide);
        let (n, ne) = (guide.programmes.len(), guide.euro.len());
        let g = guide.clone();
        let (found, changed) = db.run(move |c| apply_guide(c, &g)).await?;
        let euro = sync_euro(db, guide)
            .await
            .unwrap_or_else(|e| format!("Euroleague non mise à jour : {e}"));
        Ok(format!(
            "{n} programmes NBA et {ne} d'Euroligue sur beIN SPORTS ; {found} matchs NBA diffusés, {changed} mis à jour ; {euro} ; {prime}"
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
    let listed = || {
        parse_instant(&m.date_utc)
            .is_some_and(|at| crate::prime_fr::listed(at, &m.away_abbr, &m.home_abbr))
    };
    if broadcast.contains("prime video") || european_game(note) || listed() {
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

    /// Extraits réels du guide (2026-11-04/05), durées comprises.
    const EURO_GUIDE: &str = r#"<tv>
  <programme start="20261104204500 +0100" stop="20261104223000 +0100" channel="beINSPORTS1.fr">
    <title lang="fr">Real Madrid / Panathinaïkos</title>
    <sub-title lang="fr">Euroligue masculine - 10e journée</sub-title>
    <desc lang="fr">Le Paris Basketball n'est pas à l'affiche.</desc>
  </programme>
  <programme start="20261105180000 +0100" stop="20261105194500 +0100" channel="beINSPORTS2.fr">
    <title lang="fr">Real Madrid / Panathinaïkos</title>
    <sub-title lang="fr">Euroligue masculine - 10e journée</sub-title>
  </programme>
  <programme start="20261105182000 +0100" stop="20261105200500 +0100" channel="beINSPORTSMAX5.fr">
    <title lang="fr">Anadolu Efes Istanbul / Paris Basketball</title>
    <sub-title lang="fr">Euroligue masculine - 10e journée</sub-title>
    <desc lang="fr">Un ancien joueur de NBA mène Paris, passé par l'EuroCoupe.</desc>
  </programme>
  <programme start="20261105194500 +0100" stop="20261105200000 +0100" channel="beINSPORTS2.fr">
    <title lang="fr">Basket-ball : avant-match</title>
    <sub-title lang="fr">EUROLEAGUE - AVANT MATCH VILLEURBANNE BAYERN</sub-title>
  </programme>
  <programme start="20261105200000 +0100" stop="20261105220000 +0100" channel="beINSPORTS2.fr">
    <title lang="fr">Lyon-Villeurbanne / Bayern Munich</title>
    <sub-title lang="fr">Euroligue masculine - 10e journée</sub-title>
  </programme>
  <programme start="20261106090000 +0100" stop="20261106110000 +0100" channel="beINSPORTS1.fr">
    <title lang="fr">Basket-ball : Euroligue masculine</title>
    <sub-title lang="fr">ASVEL Lyon-Villeurbanne / FC Bayern Munchen</sub-title>
  </programme>
  <programme start="20261105200000 +0100" stop="20261105220000 +0100" channel="beINSPORTSMAX6.fr">
    <title lang="fr">Basket-ball : Euroligue féminine</title>
    <sub-title lang="fr">Fenerbahçe / Valence</sub-title>
  </programme>
</tv>"#;

    fn club(code: &str, full: &str) -> Value {
        json!({ "code": code, "full": full })
    }

    fn euro_game(code: i64, utc: &str, home: Value, away: Value) -> Value {
        json!({ "code": code, "utc": utc, "home": home, "away": away })
    }

    #[test]
    fn euroligue_masculine_seulement() {
        let g = parse_guide(EURO_GUIDE.as_bytes()).unwrap();
        // Avant-match (15 min) et féminines écartés ; un match d'Euroligue
        // dont la description cite la NBA et l'EuroCoupe reste dans l'Euroligue.
        assert_eq!(g.euro.len(), 5);
        assert_eq!(g.programmes.len(), 1);
        assert_eq!(
            g.euro[0].head,
            "real madrid / panathinaikos euroligue masculine - 10e journee "
        );
        assert_eq!(
            fold("Fenerbahçe Dubaï İstanbul München Žalgiris"),
            "fenerbahce dubai istanbul munchen zalgiris"
        );
    }

    #[test]
    fn libelles_du_guide_et_noms_officiels() {
        // Noms officiels de l'API (saison E2026) contre libellés réels du guide.
        let cases = [
            ("ASV", "LDLC ASVEL Villeurbanne", "ASVEL Lyon-Villeurbanne"),
            ("ASV", "LDLC ASVEL Villeurbanne", "Lyon-Villeurbanne"),
            ("MUN", "FC Bayern Munich", "FC Bayern Munchen"),
            ("PAN", "Panathinaikos AKTOR Athens", "Panathinaïkos"),
            ("OLY", "Olympiacos Piraeus", "Olympiakos"),
            ("ULK", "Fenerbahce Tarfin Istanbul", "Fenerbahçe"),
            ("DUB", "Dubai Basketball", "Dubaï"),
            ("IST", "Anadolu Efes Istanbul", "Anadolu Efes Istanbul"),
            ("PRS", "Paris Basketball", "Paris Basketball"),
            ("MAD", "Real Madrid", "Real Madrid"),
            ("TEL", "Maccabi Rapyd Tel Aviv", "Maccabi Tel-Aviv"),
            ("BES", "Besiktas Istanbul", "Besiktas"),
            ("BAR", "FC Barcelona", "FC Barcelone"),
            ("PAM", "Valencia Basket", "Valence"),
            (
                "RED",
                "Crvena Zvezda Meridianbet Belgrade",
                "Etoile Rouge de Belgrade",
            ),
        ];
        for (code, full, label) in cases {
            let (keys, fb) = club_keys(code, full);
            assert!(!fb, "{code} dans la table");
            assert!(cites(&fold(label), &keys), "{code} : « {label} »");
        }
        // Les clubs d'Istanbul ne se confondent pas.
        assert!(!cites(
            &fold("Anadolu Efes Istanbul"),
            &club_keys("ULK", "").0
        ));
        // Club inconnu : nom officiel, puis ses mots distinctifs.
        let (keys, fb) = club_keys("MON", "AS Monaco Basket");
        assert!(fb);
        assert!(cites(&fold("Monaco / Paris"), &keys));
        assert!(!cites(&fold("Basket Istanbul"), &keys));
    }

    #[test]
    fn diffusions_euroleague_ecrites_par_match() {
        let g = parse_guide(EURO_GUIDE.as_bytes()).unwrap();
        let games = vec![
            // Direct beIN SPORTS 1 (20:45 à Paris) ; rediffusion le lendemain ignorée.
            euro_game(
                21,
                "2026-11-04T19:45:00Z",
                club("MAD", "Real Madrid"),
                club("PAN", "Panathinaikos AKTOR Athens"),
            ),
            // Programme 5 min après le coup d'envoi : direct.
            euro_game(
                22,
                "2026-11-05T17:15:00Z",
                club("IST", "Anadolu Efes Istanbul"),
                club("PRS", "Paris Basketball"),
            ),
            // Direct beIN SPORTS 2, l'avant-match ne compte pas.
            euro_game(
                23,
                "2026-11-05T19:00:00Z",
                club("ASV", "LDLC ASVEL Villeurbanne"),
                club("MUN", "FC Bayern Munich"),
            ),
            // Paris cité seulement dans une description : rien.
            euro_game(
                24,
                "2026-11-04T19:45:00Z",
                club("MAD", "Real Madrid"),
                club("PRS", "Paris Basketball"),
            ),
            // Hors de la période du guide : gardé tel quel.
            euro_game(9, "2026-10-01T18:00:00Z", club("ASV", ""), club("PAR", "")),
        ];
        let mut map = serde_json::Map::new();
        map.insert(
            "9".into(),
            json!([{ "name": "beIN SPORTS 3", "live": true }]),
        );
        map.insert(
            "24".into(),
            json!([{ "name": "beIN SPORTS 9", "live": true }]),
        );
        let (found, fallback) = apply_euro(&g, &games, &mut map);
        assert_eq!(found, 3);
        assert!(fallback.is_empty());
        assert_eq!(
            map["21"],
            json!([{ "name": "beIN SPORTS 1", "live": true }])
        );
        assert_eq!(
            map["22"],
            json!([{ "name": "beIN SPORTS MAX 5", "live": true }])
        );
        assert_eq!(
            map["23"],
            json!([{ "name": "beIN SPORTS 2", "live": true }])
        );
        assert_eq!(map["9"], json!([{ "name": "beIN SPORTS 3", "live": true }]));
        // Période commune du guide d'exemple (19:00-19:05 UTC) trop courte
        // pour couvrir un direct : rien n'est effacé.
        assert_eq!(g.to.unwrap() - g.from.unwrap(), Duration::minutes(5));
        assert!(map.contains_key("24"));

        // Champ de la page, au format des matchs NBA.
        let tv = Value::Object(map);
        assert_eq!(
            euro_tv_json(Some(&tv), Some(23)),
            Some(json!([{ "name": "beIN SPORTS 2", "kind": "bein", "live": true }]))
        );
        assert_eq!(euro_tv_json(Some(&tv), Some(99)), None);
        assert_eq!(euro_tv_json(None, Some(23)), None);
    }

    #[test]
    fn match_sans_diffusion_efface_si_le_guide_le_couvre() {
        let mut g = parse_guide(EURO_GUIDE.as_bytes()).unwrap();
        g.from = Some(at("2026-11-04T00:00:00.000Z"));
        g.to = Some(at("2026-11-09T00:00:00.000Z"));
        let games = vec![euro_game(
            30,
            "2026-11-06T19:00:00Z",
            club("VIR", "Virtus Bologna"),
            club("ZAL", "Zalgiris Kaunas"),
        )];
        let mut map = serde_json::Map::new();
        map.insert(
            "30".into(),
            json!([{ "name": "beIN SPORTS 1", "live": true }]),
        );
        let kept = map.clone();
        // Bornes inversées : rien n'est effacé.
        let mut inv = g.clone();
        (inv.from, inv.to) = (g.to, g.from);
        apply_euro(&inv, &games, &mut map);
        assert_eq!(map, kept);
        apply_euro(&g, &games, &mut map);
        assert!(!map.contains_key("30"));
    }
}
