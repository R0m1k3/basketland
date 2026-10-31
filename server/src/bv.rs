//! Scraping de basketball-video.com (équivalent de `src/lib/bv.ts`), en HTML
//! pur, sans navigateur.
//!
//! 1. Listes : /2026-27, /2026-27?page2… → liens contenant `-vs-` et `nba-full-game-replay`.
//! 2. Page match : blocs « Server #N (LABEL) » suivis d'un lien <a href>.
//! 3. Page cible de chaque serveur : PREMIER <iframe src="//ok.ru/videoembed/<id>"> = la bonne vidéo.
//!    Tous les serveurs sont essayés (pas seulement le #1) ; le premier embed
//!    lisible (HLS, sinon MP4) d'un match complet est retenu.
//!
//! User-Agent navigateur obligatoire + 1 requête / 2 s (`BV_RATE_MS`). Les
//! requêtes passent par le client du proxy vidéo ([`Video::fetch_text`],
//! [`Video::fetch_ok_embed`]) : même code d'embed ok.ru que l'étape 4.

use crate::api::js_number;
use crate::js::{jsre, trim};
use crate::jsval::js_number_string;
use crate::okru::OkEmbedInfo;
use crate::video::Video;
use chrono::{Datelike, Duration as Days, NaiveDate, TimeZone, Utc};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use unicode_normalization::UnicodeNormalization;

pub const BV_BASE: &str = "https://basketball-video.com";

/// Durée minimale pour considérer un match complet (vs teaser).
pub const FULL_GAME_MIN_SEC: f64 = 3600.0;

/// Durée de vie d'une entrée du cache des listes : un replay publié doit être
/// vu au plus 10 min plus tard (le job vidéo passe toutes les 20 min).
pub const LISTING_TTL_MS: f64 = 10.0 * 60_000.0;

/// Relecture forcée de la 1re page (recherche à la demande) : pas plus d'une
/// fois par minute et par saison.
pub const FIRST_PAGE_REFRESH_MS: f64 = 60_000.0;

/// Pages de liste parcourues au plus (`maxPages`).
pub const MAX_PAGES: f64 = 15.0;

// ------------------------------------------------------------------ analyse des pages

/// Bloc « Server #N (LABEL) » et premier lien qui le suit.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerBlock {
    pub n: f64,
    pub label: String,
    pub href: String,
}

impl ServerBlock {
    pub fn to_json(&self) -> Value {
        json!({ "n": crate::api::js_num_value(self.n), "label": self.label, "href": self.href })
    }
}

/// `parseServerBlocks` : blocs « Server #N (LABEL) », triés par numéro, un par numéro.
pub fn parse_server_blocks(html: &str) -> Vec<ServerBlock> {
    let re = jsre!(r"Server\s*#\s*(\d+)\s*(?:\(([^)<]*)\))?", "i");
    let marks: Vec<(f64, String, usize, usize)> = re
        .captures_iter(html)
        .filter_map(|c| {
            let all = c.get(0)?;
            let label = c.get(2).map_or("", |m| m.as_str());
            Some((
                js_number(&c[1]),
                trim(label).to_string(),
                all.start(),
                all.end(),
            ))
        })
        .collect();
    let a_re = jsre!(r#"<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']"#, "i");
    let mut out: Vec<ServerBlock> = Vec::new();
    for (i, (n, label, _, end)) in marks.iter().enumerate() {
        let stop = marks.get(i + 1).map_or(html.len(), |m| m.2);
        let segment = &html[*end..stop];
        if let Some(a) = a_re.captures(segment) {
            if !out.iter().any(|o| o.n == *n) {
                out.push(ServerBlock {
                    n: *n,
                    label: label.clone(),
                    href: a[1].to_string(),
                });
            }
        }
    }
    // Tri stable, comme `Array.prototype.sort`.
    out.sort_by(|a, b| a.n.partial_cmp(&b.n).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn ok_iframe_re() -> &'static regex::Regex {
    jsre!(
        r#"<iframe\b[^>]*\bsrc\s*=\s*["']((?:https?:)?//(?:www\.)?ok\.ru/videoembed/(\d+)[^"']*)["']"#,
        "i"
    )
}

/// `parseFirstOkIframe` : premier iframe ok.ru de la page (c'est le bon match).
pub fn parse_first_ok_iframe(html: &str) -> Option<String> {
    ok_iframe_re().captures(html).map(|c| c[2].to_string())
}

/// `parseOkIframes` : tous les iframes ok.ru de la page, dans l'ordre, sans doublon.
pub fn parse_ok_iframes(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in ok_iframe_re().captures_iter(html) {
        if !out.iter().any(|x| x == &c[2]) {
            out.push(c[2].to_string());
        }
    }
    out
}

/// Entrée de la liste d'une saison.
#[derive(Debug, Clone, PartialEq)]
pub struct ListingEntry {
    pub url: String,
    pub slug: String,
    pub away_slug: String,
    pub home_slug: String,
    /// Date US (YYYY-MM-DD) indiquée dans le slug.
    pub date: Option<String>,
}

impl ListingEntry {
    pub fn to_json(&self) -> Value {
        json!({ "url": self.url, "slug": self.slug, "awaySlug": self.away_slug, "homeSlug": self.home_slug, "date": self.date })
    }
}

/// Slug d'un replay analysé (`Omit<ListingEntry, 'url'>`).
#[derive(Debug, Clone, PartialEq)]
pub struct SlugInfo {
    pub slug: String,
    pub away_slug: String,
    pub home_slug: String,
    pub date: Option<String>,
}

impl SlugInfo {
    pub fn to_json(&self) -> Value {
        json!({ "slug": self.slug, "awaySlug": self.away_slug, "homeSlug": self.home_slug, "date": self.date })
    }
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// `parseReplaySlug` :
/// 'portland-trail-blazers-vs-los-angeles-lakers-nba-full-game-replay-october-27-2026'.
pub fn parse_replay_slug(slug: &str) -> Option<SlugInfo> {
    let clean = slug.trim_matches('/').trim_end_matches('-');
    let m =
        jsre!(r"^(.+?)-vs-(.+?)-nba-(?:[a-z0-9-]*?-)?full-game-replay-([a-z]+)-(\d{1,2})-(\d{4})")
            .captures(clean)?;
    let mon = &m[3][..m[3].len().min(3)];
    let date = MONTHS
        .iter()
        .position(|x| *x == mon)
        .map(|i| format!("{}-{:02}-{:0>2}", &m[5], i + 1, &m[4]));
    Some(SlugInfo {
        slug: clean.to_string(),
        away_slug: m[1].to_string(),
        home_slug: m[2].to_string(),
        date,
    })
}

/// `parseListing` : entrées (une par slug, la première vue) et nombre de pages.
/// `Err` : URL invalide (`new URL` lève).
pub fn parse_listing(html: &str) -> Result<(Vec<ListingEntry>, f64), String> {
    let re = jsre!(
        r#"href\s*=\s*["']([^"']*-vs-[^"']*nba-[^"']*full-game-replay[^"']*)["']"#,
        "i"
    );
    let base = url::Url::parse(BV_BASE).map_err(|e| e.to_string())?;
    let mut entries: IndexMap<String, ListingEntry> = IndexMap::new();
    for c in re.captures_iter(html) {
        let href = &c[1];
        let path = jsre!(r"^https?://[^/]+").replace(href, "");
        let Some(p) = parse_replay_slug(&path) else {
            continue;
        };
        let url = base
            .join(&path)
            .map_err(|_| "Invalid URL".to_string())?
            .to_string();
        if !entries.contains_key(&p.slug) {
            entries.insert(
                p.slug.clone(),
                ListingEntry {
                    url,
                    slug: p.slug,
                    away_slug: p.away_slug,
                    home_slug: p.home_slug,
                    date: p.date,
                },
            );
        }
    }
    let mut max_page = 1.0f64;
    for p in jsre!(r"\?page(\d+)").captures_iter(html) {
        max_page = crate::js::max(max_page, js_number(&p[1]));
    }
    Ok((entries.into_values().collect(), max_page))
}

/// `teamSlug` : nom d'équipe ESPN → slug du site ('LA Clippers' → 'la-clippers').
pub fn team_slug(name: &str) -> String {
    let nfd: String = name
        .to_lowercase()
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    let dashed = jsre!(r"[^a-z0-9]+").replace_all(&nfd, "-");
    let s = dashed.strip_prefix('-').unwrap_or(&dashed);
    s.strip_suffix('-').unwrap_or(s).to_string()
}

/// `usDateKey` : date US (fuseau New York) d'un match ESPN, format YYYY-MM-DD.
pub fn us_date_key(iso_utc: &str) -> Result<String, String> {
    let d = crate::time::parse_instant(iso_utc).ok_or("Invalid time value")?;
    Ok(d.with_timezone(&chrono_tz::America::New_York)
        .format("%Y-%m-%d")
        .to_string())
}

/// `Date.parse(`${key}T00:00:00Z`)` : comme V8, un jour 29 à 31 déborde sur le mois suivant.
fn day_ms(key: &str) -> Option<f64> {
    let b = key.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = &key[r];
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(y as i32, m, 1)?;
    let day = first + Days::days(i64::from(d) - 1);
    Some(
        Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0)?)
            .timestamp_millis() as f64,
    )
}

fn day_diff(a: &str, b: &str) -> f64 {
    match (day_ms(a), day_ms(b)) {
        (Some(x), Some(y)) => (x - y).abs() / 86_400_000.0,
        _ => f64::NAN,
    }
}

/// Match cherché (`MatchLike & { season }`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayMatch {
    pub home_name: String,
    pub away_name: String,
    pub date_utc: String,
    pub season: f64,
}

/// `matchListingEntry` : entrée correspondant à un match (équipes + date ± 1 j).
pub fn match_listing_entry(
    entries: &[ListingEntry],
    m: &ReplayMatch,
) -> Result<Option<ListingEntry>, String> {
    let home = team_slug(&m.home_name);
    let away = team_slug(&m.away_name);
    let date = us_date_key(&m.date_utc)?;
    let mut candidates: Vec<&ListingEntry> = entries
        .iter()
        .filter(|e| {
            let teams_ok = (e.home_slug == home && e.away_slug == away)
                || (e.home_slug == away && e.away_slug == home);
            teams_ok && e.date.as_deref().is_none_or(|d| day_diff(d, &date) <= 1.0)
        })
        .collect();
    let key = |e: &ListingEntry| e.date.as_deref().map_or(2.0, |d| day_diff(d, &date));
    candidates.sort_by(|a, b| {
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(candidates.first().map(|e| (*e).clone()))
}

/// `seasonLabel` : 2026 → '2026-27'.
pub fn season_label(start_year: f64) -> String {
    format!(
        "{}-{:0>2}",
        js_number_string(start_year),
        js_number_string((start_year + 1.0) % 100.0)
    )
}

fn season_page_url(season: f64, page: f64) -> String {
    let base = format!("{BV_BASE}/{}", season_label(season));
    if page == 1.0 {
        base
    } else {
        format!("{base}?page{}", js_number_string(page))
    }
}

/// Résultat d'une recherche de replay (`ReplayLookup`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayLookup {
    pub slug: Option<String>,
    pub ok_id: Option<String>,
    pub duration: Option<f64>,
    pub available: bool,
    /// Flux lisible retenu : HLS (traitement ok.ru terminé) ou MP4 progressif seul.
    pub kind: Option<&'static str>,
    pub reason: Option<String>,
}

impl ReplayLookup {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "slug": self.slug,
            "okId": self.ok_id,
            "duration": self.duration.map(crate::api::js_num_value),
            "available": self.available,
            "kind": self.kind,
        });
        if let Some(r) = &self.reason {
            v["reason"] = Value::from(r.as_str());
        }
        v
    }

    fn missing(slug: Option<String>, reason: &str) -> Self {
        ReplayLookup {
            slug,
            ok_id: None,
            duration: None,
            available: false,
            kind: None,
            reason: Some(reason.into()),
        }
    }
}

/// `embedKind` : HLS si présent, sinon MP4 progressif, sinon rien.
pub fn embed_kind(embed: &OkEmbedInfo) -> Option<&'static str> {
    if embed
        .hls_manifest_url
        .as_deref()
        .is_some_and(|u| !u.is_empty())
    {
        Some("hls")
    } else if !embed.mp4.is_empty() {
        Some("mp4")
    } else {
        None
    }
}

// ------------------------------------------------------------------ client et caches

/// Liste d'une saison en cache, avec la date la plus ancienne couverte par
/// le parcours : le cache ne sert QUE s'il couvre la date demandée.
#[derive(Debug, Clone)]
struct CachedListing {
    at: f64,
    entries: Vec<ListingEntry>,
    oldest_covered: String,
    first_page_at: f64,
}

struct Inner {
    video: Video,
    /// `BV_RATE_MS` (2000 par défaut), lu à la création comme au chargement du module Node.
    rate_ms: f64,
    /// Prochaine requête permise ; le verrou (équitable) range les requêtes à la file.
    next: tokio::sync::Mutex<Option<Instant>>,
    /// Par saison, dans l'ordre d'insertion (`Map`).
    listings: Mutex<IndexMap<String, CachedListing>>,
}

/// Client basketball-video : limiteur de débit et cache des listes, partagés.
#[derive(Clone)]
pub struct Bv(Arc<Inner>);

impl Bv {
    pub fn new(video: Video) -> Self {
        let rate = std::env::var("BV_RATE_MS")
            .map(|v| js_number(&v))
            .unwrap_or(2000.0);
        Self::with_rate(video, rate)
    }

    pub fn with_rate(video: Video, rate_ms: f64) -> Self {
        Bv(Arc::new(Inner {
            video,
            rate_ms,
            next: tokio::sync::Mutex::new(None),
            listings: Mutex::new(IndexMap::new()),
        }))
    }

    /// `Date.now()` (horloge du proxy vidéo, avançable en test).
    pub fn now_ms(&self) -> f64 {
        self.0.video.now_ms()
    }

    pub fn video(&self) -> &Video {
        &self.0.video
    }

    fn listings(&self) -> std::sync::MutexGuard<'_, IndexMap<String, CachedListing>> {
        self.0.listings.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `clearListingCache`.
    pub fn clear_listing_cache(&self) {
        self.listings().clear();
    }

    /// `bvFetch` : au plus une requête toutes les `BV_RATE_MS`, Referer du site, 25 s.
    pub async fn fetch(&self, url: &str) -> Result<String, String> {
        {
            let mut next = self.0.next.lock().await;
            if let Some(t) = *next {
                tokio::time::sleep_until(t.into()).await;
            }
            let r = self.0.rate_ms;
            *next = (r.is_finite() && r > 0.0)
                .then(|| Instant::now() + std::time::Duration::from_secs_f64(r / 1000.0));
        }
        self.0
            .video
            .fetch_text(url, vec![("Referer", format!("{BV_BASE}/"))], 25_000)
            .await
    }

    /// `fetchSeasonListing` : pages de la saison jusqu'à dépasser
    /// `oldest_us_date` (ou `max_pages`), en cache par saison avec la date la
    /// plus ancienne couverte. `refresh_first_page` : relit la 1re page (où
    /// apparaît un replay tout juste publié) malgré un cache frais, au plus
    /// une fois par minute, sans reparcourir la saison.
    pub async fn fetch_season_listing(
        &self,
        season: f64,
        oldest_us_date: &str,
        max_pages: f64,
        refresh_first_page: bool,
    ) -> Result<Vec<ListingEntry>, String> {
        let key = js_number_string(season);
        let cached = self.listings().get(&key).cloned();
        if let Some(c) = cached.filter(|c| {
            self.now_ms() - c.at < LISTING_TTL_MS && c.oldest_covered.as_str() <= oldest_us_date
        }) {
            if !refresh_first_page || self.now_ms() - c.first_page_at < FIRST_PAGE_REFRESH_MS {
                return Ok(c.entries);
            }
            // 1re page seule : les entrées déjà connues (repoussées en page 2
            // par les nouvelles) restent en cache ; `at` n'est pas rafraîchi.
            let (fresh, _) = parse_listing(&self.fetch(&season_page_url(season, 1.0)).await?)?;
            let mut merged: IndexMap<String, ListingEntry> =
                fresh.into_iter().map(|e| (e.slug.clone(), e)).collect();
            for e in c.entries.iter() {
                if !merged.contains_key(&e.slug) {
                    merged.insert(e.slug.clone(), e.clone());
                }
            }
            let entries: Vec<ListingEntry> = merged.into_values().collect();
            let now = self.now_ms();
            self.listings().insert(
                key,
                CachedListing {
                    entries: entries.clone(),
                    first_page_at: now,
                    ..c
                },
            );
            return Ok(entries);
        }

        let mut all: IndexMap<String, ListingEntry> = IndexMap::new();
        let mut max_page = 1.0f64;
        let mut oldest_covered = String::new();
        let mut page = 1.0f64;
        while page <= crate::js::min(max_page, max_pages) {
            let html = self.fetch(&season_page_url(season, page)).await?;
            let (entries, mp) = parse_listing(&html)?;
            max_page = crate::js::max(max_page, mp);
            let dates: Vec<String> = entries.iter().filter_map(|e| e.date.clone()).collect();
            for e in entries {
                all.insert(e.slug.clone(), e);
            }
            if let Some(page_oldest) = dates.iter().min() {
                if oldest_covered.is_empty() || *page_oldest < oldest_covered {
                    oldest_covered = page_oldest.clone();
                }
            }
            if !dates.is_empty() && dates.iter().all(|d| d.as_str() < oldest_us_date) {
                break;
            }
            page += 1.0;
        }
        let entries: Vec<ListingEntry> = all.into_values().collect();
        let at = self.now_ms();
        let mut cache = self.listings();
        // Nombre de saisons gardées borné : la plus ancienne (`at`) part.
        if cache.len() >= 4 {
            let mut oldest: Option<(&String, f64)> = None;
            for (k, v) in cache.iter() {
                if oldest.is_none_or(|(_, a)| v.at < a) {
                    oldest = Some((k, v.at));
                }
            }
            if let Some(k) = oldest.map(|(k, _)| k.clone()) {
                cache.shift_remove(&k);
            }
        }
        cache.insert(
            key,
            CachedListing {
                at,
                entries: entries.clone(),
                oldest_covered: if oldest_covered.is_empty() {
                    oldest_us_date.to_string()
                } else {
                    oldest_covered
                },
                first_page_at: at,
            },
        );
        Ok(entries)
    }

    /// `findReplay` : replay d'un match. `fresh` (recherche à la demande) :
    /// relit la 1re page de liste même si le cache est frais.
    pub async fn find_replay(&self, m: &ReplayMatch, fresh: bool) -> Result<ReplayLookup, String> {
        let us_date = us_date_key(&m.date_utc)?;
        let oldest = day_ms(&us_date)
            .and_then(|ms| {
                Utc.timestamp_millis_opt(ms as i64 - 2 * 86_400_000)
                    .single()
            })
            .map(|d| {
                let d = d.date_naive();
                format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
            })
            .ok_or("Invalid time value")?;
        let entries = self
            .fetch_season_listing(m.season, &oldest, MAX_PAGES, fresh)
            .await?;
        let Some(entry) = match_listing_entry(&entries, m)? else {
            return Ok(ReplayLookup::missing(None, "replay non listé"));
        };
        // Premier candidat rencontré : rapporté (okId, durée, raison) si aucun n'est lisible.
        let mut first: Option<(String, Option<f64>, String)> = None;
        let mut cands = Candidates::new(entry.url.clone());
        while let Some(ok_id) = cands.next(self).await? {
            let embed = match self.0.video.fetch_ok_embed(&ok_id).await {
                Ok(e) => e,
                Err(e) => {
                    first.get_or_insert((ok_id, None, format!("embed ok.ru illisible ({e})")));
                    continue;
                }
            };
            let kind = embed_kind(&embed);
            let duration = embed.duration;
            if kind.is_some() && duration.unwrap_or(0.0) >= FULL_GAME_MIN_SEC {
                return Ok(ReplayLookup {
                    slug: Some(entry.slug),
                    ok_id: Some(ok_id),
                    duration,
                    available: true,
                    kind,
                    reason: None,
                });
            }
            let teaser = duration.is_some_and(|d| d != 0.0 && !d.is_nan() && d < FULL_GAME_MIN_SEC);
            first.get_or_insert((
                ok_id,
                duration,
                if teaser {
                    "vidéo trop courte (teaser)".into()
                } else {
                    "flux indisponible".into()
                },
            ));
        }
        Ok(match first {
            None => ReplayLookup::missing(Some(entry.slug), "iframe ok.ru introuvable"),
            Some((ok_id, duration, reason)) => ReplayLookup {
                slug: Some(entry.slug),
                ok_id: Some(ok_id),
                duration,
                available: false,
                kind: None,
                reason: Some(reason),
            },
        })
    }
}

/// `replayCandidates` : identifiants ok.ru candidats d'une page de match, du
/// plus sûr au moins sûr — le PREMIER iframe de chaque serveur (Server #1,
/// #2, …), puis les iframes suivants de ces pages et ceux de la page de
/// match (sur une page cible partagée, ils peuvent être un autre match).
///
/// Paresseux comme le générateur de Node : une page cible n'est téléchargée
/// (au rythme du limiteur) que si les candidats précédents ont échoué.
struct Candidates {
    entry_url: String,
    started: bool,
    servers: VecDeque<ServerBlock>,
    direct: Vec<String>,
    seen: HashSet<String>,
    later: Vec<String>,
    tail: Option<VecDeque<String>>,
}

impl Candidates {
    fn new(entry_url: String) -> Self {
        Candidates {
            entry_url,
            started: false,
            servers: VecDeque::new(),
            direct: Vec::new(),
            seen: HashSet::new(),
            later: Vec::new(),
            tail: None,
        }
    }

    async fn next(&mut self, bv: &Bv) -> Result<Option<String>, String> {
        if !self.started {
            self.started = true;
            let page = bv.fetch(&self.entry_url).await?;
            self.servers = parse_server_blocks(&page).into();
            self.direct = parse_ok_iframes(&page);
            // Sans bloc « Server », certaines pages embarquent directement l'iframe.
            if self.servers.is_empty() {
                if let Some(id) = self.direct.first().cloned() {
                    self.seen.insert(id.clone());
                    return Ok(Some(id));
                }
            }
        }
        while let Some(server) = self.servers.pop_front() {
            let Ok(url) = url::Url::parse(&self.entry_url).and_then(|b| b.join(&server.href))
            else {
                continue;
            };
            if url.scheme() != "https" && url.scheme() != "http" {
                continue;
            }
            // Serveur mort : on passe au suivant.
            let Ok(html) = bv.fetch(url.as_str()).await else {
                continue;
            };
            let mut ids = parse_ok_iframes(&html)
                .into_iter()
                .filter(|id| !self.seen.contains(id));
            let first = ids.next();
            self.later.extend(ids);
            if let Some(id) = first {
                self.seen.insert(id.clone());
                return Ok(Some(id));
            }
        }
        let tail = self.tail.get_or_insert_with(|| {
            self.later
                .iter()
                .chain(self.direct.iter())
                .cloned()
                .collect()
        });
        while let Some(id) = tail.pop_front() {
            if self.seen.insert(id.clone()) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jours_comme_date_parse() {
        // V8 : un 31 février déborde sur mars ; jour 00 et mois 13 invalides.
        assert_eq!(day_ms("2026-02-31"), Some(1_772_496_000_000.0));
        assert_eq!(day_ms("2026-02-30"), Some(1_772_409_600_000.0));
        assert_eq!(day_ms("2026-01-00"), None);
        assert_eq!(day_ms("2026-13-01"), None);
        assert_eq!(day_diff("2026-10-27", "2026-10-28"), 1.0);
        assert!(day_diff("x", "2026-10-28").is_nan());
    }

    #[test]
    fn saison_et_pages() {
        assert_eq!(season_label(2026.0), "2026-27");
        assert_eq!(season_label(2099.0), "2099-00");
        assert_eq!(season_label(2008.0), "2008-09");
        assert_eq!(
            season_page_url(2026.0, 1.0),
            "https://basketball-video.com/2026-27"
        );
        assert_eq!(
            season_page_url(2026.0, 3.0),
            "https://basketball-video.com/2026-27?page3"
        );
    }
}
