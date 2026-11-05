//! Matchs NBA diffusés par Prime Video en France.
//!
//! Prime Video France a sa propre programmation : en plus de l'affiche
//! américaine de Prime (que les diffuseurs ESPN signalent), des matchs du
//! dimanche soir, de l'heure de grande écoute européenne, etc., qu'aucune API
//! ne publie. La liste est lue sur le calendrier des diffusions de
//! BleuBlancDunk ([`SOURCE_URL`], page HTML) : chaque match y est un
//! `<article class="diffusions-game" data-provider="prime">` portant
//! l'identifiant `AAAAMMJJ_VIS_DOM` (jour américain, abréviations NBA.com).
//!
//! - lecture au plus une fois par [`REFRESH_MS`], depuis le job `sync-tv-fr` ;
//! - liste gardée dans `kv_cache` ([`KEY`]) : union des lectures (le site
//!   peut retirer les matchs passés), entrées de plus de 400 jours écartées ;
//! - page injoignable ou sans aucun match lisible (mise en page changée) :
//!   la liste précédente est gardée et le message du job le signale ;
//! - en mémoire pour la présentation des matchs ([`listed`]), chargée au
//!   démarrage ([`load`]).
//!
//! `BL_PRIME_FR_URL` : autre adresse de la page ; vide, la lecture est
//! désactivée (la liste déjà connue reste utilisée).

use crate::db::{self, Db};
use crate::teams;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

pub const SOURCE_URL: &str = "https://bleublancdunk.com/diffusions";

/// Clé `kv_cache` : `{"games": ["AAAA-MM-JJ VIS DOM", …]}`.
pub const KEY: &str = "tv_fr:prime";

/// Une lecture par jour suffit (annonces de Prime espacées).
pub const REFRESH_MS: i64 = 20 * 3_600_000;

/// Âge maximal d'une entrée gardée.
const KEEP_DAYS: i64 = 400;

fn source_url() -> Option<String> {
    match std::env::var("BL_PRIME_FR_URL") {
        Ok(s) if s.trim().is_empty() => None,
        Ok(s) => Some(s.trim().to_string()),
        Err(_) => Some(SOURCE_URL.to_string()),
    }
}

/// Abréviation ESPN d'une abréviation NBA.com.
fn espn_abbr(nba: &str) -> &str {
    match nba {
        "NYK" => "NY",
        "GSW" => "GS",
        "SAS" => "SA",
        "NOP" => "NO",
        "UTA" => "UTAH",
        "WAS" => "WSH",
        x => x,
    }
}

/// Entrée de la liste : jour du match à New York, visiteur, domicile (ESPN).
pub fn entry(day: &str, away: &str, home: &str) -> String {
    format!(
        "{day} {} {}",
        away.to_ascii_uppercase(),
        home.to_ascii_uppercase()
    )
}

/// Matchs Prime Video de la page, et identifiants écartés (équipe inconnue).
pub fn parse_page(html: &str) -> (Vec<String>, usize) {
    let mut out: Vec<String> = Vec::new();
    let mut skipped = 0;
    for card in html.split("<article").skip(1) {
        let card = card.split("</article>").next().unwrap_or("");
        let tag = &card[..card.find('>').unwrap_or(card.len())];
        if !tag.contains("diffusions-game") || !tag.contains("data-provider=\"prime\"") {
            continue;
        }
        // « Match BBD · 20261108_PHI_CHI » : identifiant à partir du premier chiffre.
        let Some(rest) = card.split("Match BBD").nth(1) else {
            continue;
        };
        let Some(i) = rest.find(|c: char| c.is_ascii_digit()) else {
            continue;
        };
        let id: String = rest[i..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let mut parts = id.split('_');
        let (Some(d), Some(a), Some(h), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(day) = NaiveDate::parse_from_str(d, "%Y%m%d") else {
            continue;
        };
        let (a, h) = (espn_abbr(a), espn_abbr(h));
        if !teams::is_nba_team(a) || !teams::is_nba_team(h) {
            skipped += 1;
            continue;
        }
        let e = entry(&day.format("%Y-%m-%d").to_string(), a, h);
        if !out.contains(&e) {
            out.push(e);
        }
    }
    (out, skipped)
}

/// Union de l'ancienne et de la nouvelle liste, sans les entrées trop vieilles.
pub fn merge(prev: &[String], new: &[String], now: DateTime<Utc>) -> Vec<String> {
    let oldest = (now - Duration::days(KEEP_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    prev.iter()
        .chain(new)
        .filter(|e| e.get(..10).is_some_and(|d| d >= oldest.as_str()))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn games_of(v: &Value) -> Vec<String> {
    v["games"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

/// Jour du coup d'envoi à New York.
fn us_day(start: DateTime<Utc>) -> String {
    start
        .with_timezone(&chrono_tz::America::New_York)
        .format("%Y-%m-%d")
        .to_string()
}

/// Le match figure dans `list` ; la paire est comparée dans les deux sens
/// (ordre visiteur / domicile d'une source tierce).
pub fn listed_in(list: &BTreeSet<String>, start: DateTime<Utc>, away: &str, home: &str) -> bool {
    let day = us_day(start);
    list.contains(&entry(&day, away, home)) || list.contains(&entry(&day, home, away))
}

fn memory() -> &'static RwLock<Arc<BTreeSet<String>>> {
    static M: std::sync::OnceLock<RwLock<Arc<BTreeSet<String>>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

fn set_memory(list: &[String]) {
    let set: BTreeSet<String> = list.iter().cloned().collect();
    if let Ok(mut m) = memory().write() {
        *m = Arc::new(set);
    }
}

/// Le match est sur Prime Video en France d'après la liste connue.
pub fn listed(start: DateTime<Utc>, away: &str, home: &str) -> bool {
    let list = memory().read().map(|m| m.clone()).unwrap_or_default();
    listed_in(&list, start, away, home)
}

/// Charge en mémoire la liste gardée dans `kv_cache` (démarrage).
pub async fn load(db: &Db) {
    match db.run(|c| db::kv_get_at(c, KEY, None, Utc::now())).await {
        Ok(Some(v)) => set_memory(&games_of(&v)),
        Ok(None) => {}
        Err(e) => eprintln!("[prime-fr] liste illisible : {e}"),
    }
}

/// Résumé pour le message du job : taille de la liste et matchs à venir.
fn summary(list: &[String], now: DateTime<Utc>) -> String {
    let today = us_day(now);
    let upcoming = list
        .iter()
        .filter(|e| e.get(..10).is_some_and(|d| d >= today.as_str()))
        .count();
    format!("{} matchs ({upcoming} à venir)", list.len())
}

/// Relit la page si la liste a plus de [`REFRESH_MS`] ; rend une phrase pour
/// le message du job (commence par « attention » si la lecture a échoué).
pub async fn refresh(db: &Db) -> String {
    let now = Utc::now();
    let stored = db
        .run(|c| db::kv_get_at(c, KEY, None, Utc::now()))
        .await
        .ok()
        .flatten();
    let prev = stored.as_ref().map(games_of).unwrap_or_default();
    let fresh = db
        .run(move |c| db::kv_get_at(c, KEY, Some(REFRESH_MS), now))
        .await
        .ok()
        .flatten()
        .is_some();
    set_memory(&prev);
    if fresh {
        return format!("Prime Video : {}", summary(&prev, now));
    }
    let Some(url) = source_url() else {
        return format!(
            "Prime Video : lecture désactivée (BL_PRIME_FR_URL vide), {}",
            summary(&prev, now)
        );
    };
    let html = match fetch_text(&url).await {
        Ok(h) => h,
        Err(e) => {
            return format!(
                "attention, liste Prime Video non relue ({e}) : {} gardés",
                summary(&prev, now)
            )
        }
    };
    let (found, skipped) = parse_page(&html);
    if found.is_empty() {
        return format!(
            "attention, aucun match Prime Video lu sur {url} (page changée ?) : {} gardés",
            summary(&prev, now)
        );
    }
    let list = merge(&prev, &found, now);
    let v = json!({ "games": list, "source": url, "read": found.len() });
    if let Err(e) = db.run(move |c| db::kv_set(c, KEY, &v)).await {
        return format!("attention, liste Prime Video non enregistrée : {e}");
    }
    set_memory(&list);
    let skipped = if skipped > 0 {
        format!(", {skipped} identifiants ignorés")
    } else {
        String::new()
    };
    format!(
        "Prime Video : {} lus, {}{skipped}",
        found.len(),
        summary(&list, now)
    )
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let res = crate::http::get_with_retry(url, "text/html", 2).await?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::parse_instant;

    /// Extrait de la page réelle (2026-11-05), un match par diffuseur.
    const PAGE: &str = r#"
<h3 class="diffusions-day" data-day-label="Dimanche 8 novembre">Dimanche 8 novembre</h3>
<article class="diffusions-game has-french" data-game-card data-french="1" data-upcoming="1" data-past="0" data-provider="prime" data-date="2026-11-08">
  <div class="diffusions-game__time"><strong>21:30</strong><small>Heure de Paris</small></div>
  <div class="diffusions-team"><span><b>Philadelphia 76ers</b><small>PHI · extérieur</small></span></div>
  <div class="diffusions-team"><span><b>Chicago Bulls</b><small>CHI · domicile</small></span></div>
  <a class="diffusions-provider" href="https://www.primevideo.com"><span>Prime Video</span></a>
  <span class="diffusions-game__id" title="Identifiant de match BBD">Match BBD · 20261108_PHI_CHI</span>
</article>
<article class="diffusions-game" data-game-card data-provider="bein" data-date="2026-11-09">
  <span class="diffusions-game__id">Match BBD · 20261108_LAL_DET</span>
</article>
<article class="diffusions-game" data-game-card data-provider="prime" data-date="2026-11-14">
  <span class="diffusions-game__id">Match BBD · 20261113_GSW_SAS</span>
</article>
<article class="diffusions-game" data-provider="prime"><span>Match BBD · 20261113_GSW_SAS</span></article>
<article class="diffusions-game" data-provider="prime"><span>Match BBD · 20261201_XXX_SAS</span></article>
<article class="autre" data-provider="prime"><span>Match BBD · 20261201_NYK_BOS</span></article>
"#;

    #[test]
    fn page_lue() {
        let (games, skipped) = parse_page(PAGE);
        // beIN écarté, doublon fusionné, abréviations ESPN, équipe inconnue ignorée.
        assert_eq!(games, ["2026-11-08 PHI CHI", "2026-11-13 GS SA"]);
        assert_eq!(skipped, 1);
        assert_eq!(parse_page("<html>autre mise en page</html>").0.len(), 0);
    }

    #[test]
    fn jour_a_new_york_dans_les_deux_sens() {
        let list: BTreeSet<String> = parse_page(PAGE).0.into_iter().collect();
        // Dimanche 8 novembre 21:30 à Paris (15:30 à New York).
        let at = parse_instant("2026-11-08T20:30:00.000Z").unwrap();
        assert!(listed_in(&list, at, "PHI", "CHI"));
        assert!(listed_in(&list, at, "CHI", "PHI"));
        assert!(!listed_in(&list, at, "LAL", "DET"));
        // Match de nuit : samedi 01:30 à Paris, vendredi à New York.
        let night = parse_instant("2026-11-14T01:30:00.000Z").unwrap();
        assert!(listed_in(&list, night, "GS", "SA"));
        // Paris Game (jeudi 14 janvier 20:00 à Paris) : même jour à New York.
        assert_eq!(
            us_day(parse_instant("2027-01-14T19:00:00.000Z").unwrap()),
            "2027-01-14"
        );
    }

    #[test]
    fn fusion_garde_les_anciens_matchs() {
        let now = parse_instant("2026-11-10T12:00:00.000Z").unwrap();
        let prev = vec![
            "2026-10-23 NY BOS".to_string(),
            "2025-01-01 NY BOS".to_string(),
        ];
        let new = vec![
            "2026-11-13 GS SA".to_string(),
            "2026-10-23 NY BOS".to_string(),
        ];
        assert_eq!(
            merge(&prev, &new, now),
            ["2026-10-23 NY BOS", "2026-11-13 GS SA"]
        );
        assert_eq!(
            summary(&merge(&prev, &new, now), now),
            "2 matchs (1 à venir)"
        );
    }
}
