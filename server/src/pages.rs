//! Données des pages (étape 8a de `docs/migration-rust.md`) : pour chaque
//! page de `src/app/**/page.tsx` (et le layout racine), ce que le composant
//! serveur calcule aujourd'hui — les props de ses composants client et ce
//! qu'il écrit lui-même (titres, textes qui dépendent du serveur) — afin que
//! l'étape 8b en fasse des composants client qui lisent `/api/pages/…`.
//!
//! Fonctions synchrones sur une connexion, l'instant présent et l'état de
//! Node passés en paramètres ([`PageCtx`]) : les tests les comparent aux
//! sorties du code TypeScript à un instant fixé
//! (`tests/node-fixtures-pages.mts`).
//!
//! Reste côté client (8b) la mise en forme pure : libellés de dates
//! (`components/schedule/dates.ts`), compte à rebours, couleurs et noms
//! d'équipe (`teams.ts`, déjà importé par les composants client),
//! `seasonLabel`, liens.

use crate::api::js_num_value;
use crate::auth::Session;
use crate::db::{self, sql_to_json};
use crate::present::to_dto;
use crate::queries::{self as q, TeamRecord};
use crate::settings::{self, Settings};
use crate::teams;
use crate::time;
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};

/// État des files médias (traduction, doublage, activité), lu par
/// `routes_pages::media_state`.
#[derive(Debug, Clone, Default)]
pub struct MediaState {
    /// `commentaryRunningMatchId()`.
    pub running_match_id: Option<i64>,
    /// `currentActivity()`, tel quel.
    pub activity: Value,
    /// `commentaryDisabledReason()`.
    pub commentary_disabled_reason: Option<String>,
    /// `await dubDisabledReason()` (demandé pour la page Paramètres seule).
    pub dub_disabled_reason: Option<String>,
}

/// Contexte d'une page : instant présent, cookie « scores masqués », session,
/// état des files médias.
pub struct PageCtx<'a> {
    pub now: DateTime<Utc>,
    /// `spoilerMode()` : `"show"` ou `"hide"` (cookie `bl_spoilers`).
    pub spoilers: &'static str,
    pub session: Option<&'a Session>,
    pub media: &'a MediaState,
}

/// Page introuvable (`notFound()` côté Next) : réponse 404 avec ce corps.
#[derive(Debug, Clone, PartialEq)]
pub struct NotFound(pub Value);

pub type PageResult = rusqlite::Result<Result<Value, NotFound>>;

fn user_json(s: &Session) -> Value {
    json!({ "id": s.user_id, "username": s.username, "role": s.role })
}

fn str_of<'a>(g: &'a Value, k: &str) -> &'a str {
    g[k].as_str().unwrap_or("")
}

// ---------------------------------------------------------------- session (layout, /login, /setup)

/// `GET /api/pages/session?next=…` : layout racine (en-tête complet ou réduit
/// au logo, menu de l'utilisateur), `/login` (`next` nettoyé par
/// `safeNextPath`, redirections) et `/setup`.
pub fn session(
    c: &Connection,
    session: Option<&Session>,
    next: Option<&str>,
) -> rusqlite::Result<Value> {
    // Avec une session valide, un compte existe forcément (comme le middleware).
    let has_users = session.is_some() || crate::accounts::count_users(c)? > 0;
    Ok(json!({
        "has_users": has_users,
        "user": session.map(user_json),
        "next": crate::auth::safe_next_path(next),
    }))
}

// ---------------------------------------------------------------- accueil

/// `idleText` de l'accueil : ligne du panneau « En cours de traitement » quand
/// rien ne tourne ni n'attend.
fn idle_text(media: &MediaState, auto: bool, untranslated: bool, now: DateTime<Utc>) -> String {
    let none = "Aucun traitement en cours";
    if media.commentary_disabled_reason.is_some() {
        return format!("{none} — traduction des commentaires non configurée.");
    }
    if !auto {
        return format!(
            "{none} — traduction à la demande : « Sous-titrer ce match » sur la fiche d’un match."
        );
    }
    if !crate::media::night_window::in_schedule_window(now) {
        return match crate::media::night_window::night_window_label() {
            Some(hours) => format!("{none} — traduction automatique {hours}."),
            None => format!("{none} — un match est traduit dès qu’on le regarde."),
        };
    }
    if untranslated {
        format!("{none}.")
    } else {
        format!("{none} — tous les replays disponibles sont traités.")
    }
}

/// `nightTitle`.
fn night_title(night: &str, today: &str) -> &'static str {
    if night == today || night == q::shift_key(today, -1) {
        "Cette nuit"
    } else if night == q::shift_key(today, 1) {
        "Demain soir"
    } else {
        "Prochaine nuit"
    }
}

fn starts_after(g: &Value, now: DateTime<Utc>) -> bool {
    time::parse_instant(str_of(g, "date_utc")).is_some_and(|d| d > now)
}

/// `GET /api/pages/home`.
pub fn home(c: &Connection, ctx: &PageCtx) -> rusqlite::Result<Value> {
    let running = ctx.media.running_match_id;
    let now = ctx.now;
    let today = q::today_key(now);
    let season = q::latest_season(c)?;
    let live = q::live_games(c, running)?;
    let replays = q::latest_replays(c, 9, running)?;
    let hero_night = replays
        .first()
        .map(|h| q::night_key_of(str_of(h, "date_utc")));
    let night = q::next_night_key(c, now)?;
    let night_games = match &night {
        Some(k) => q::games_of_night(c, k, running)?,
        None => Vec::new(),
    };
    let next_up = night_games
        .iter()
        .find(|g| str_of(g, "status") == "scheduled" && starts_after(g, now));
    let last_night_day = night_games.iter().fold(today.clone(), |m, g| {
        let d = str_of(g, "day_paris");
        if d > m.as_str() {
            d.to_string()
        } else {
            m
        }
    });
    let days = q::upcoming_days(c, &q::shift_key(&last_night_day, 1), 4, now, running)?;
    let standings = q::cached_standings(c)?;
    let s = Settings::load(c)?;
    let auto = settings::auto_translate_enabled(&s);
    let count = |state: &str| replays.iter().filter(|g| g["vf"]["state"] == state).count();
    let (ready, running_n, partial, todo) = (
        count("ready"),
        count("running"),
        count("partial"),
        count("none"),
    );
    Ok(json!({
        "spoilers": ctx.spoilers,
        "today": today,
        "season": season,
        "live": live,
        "replays": replays,
        "hero_night": hero_night,
        "night": night,
        "night_title": night.as_deref().map(|n| night_title(n, &today)),
        "night_games": night_games,
        "next_up_id": next_up.map(|g| g["id"].clone()),
        "days": days.into_iter().map(|(key, games)| json!({ "key": key, "games": games })).collect::<Vec<_>>(),
        "standings": standings,
        "auto_translate": auto,
        "activity": ctx.media.activity,
        "vf_count": { "ready": ready, "running": running_n, "partial": partial, "todo": todo },
        "idle_text": idle_text(ctx.media, auto, todo + partial > 0, now),
        "night_window_label": crate::media::night_window::night_window_label(),
    }))
}

// ---------------------------------------------------------------- calendrier

fn records_json(r: &std::collections::BTreeMap<String, TeamRecord>) -> Value {
    q::object_of(r, |x| x.to_json())
}

/// `GET /api/pages/matchs?d=YYYY-MM-DD&team=ABBR` (mêmes paramètres que la
/// page ; le premier si répété).
pub fn matchs(
    c: &Connection,
    ctx: &PageCtx,
    team_param: Option<&str>,
    d_param: Option<&str>,
) -> rusqlite::Result<Value> {
    let running = ctx.media.running_match_id;
    let now = ctx.now;
    let today = q::today_key(now);
    let team = team_param
        .map(str::to_uppercase)
        .filter(|t| !t.is_empty() && teams::is_nba_team(t));
    let selected = match d_param.filter(|d| q::is_date_key(d)) {
        Some(d) => d.to_string(),
        None => q::default_calendar_day(c, now)?,
    };
    let (day, team_view) = match &team {
        None => {
            let counts =
                q::day_counts(c, &q::shift_key(&selected, -7), &q::shift_key(&selected, 7))?;
            let games = q::games_of_day(c, &selected, running)?;
            let records = q::season_records(c, q::latest_season(c)?)?;
            let prev = q::prev_day_with_games(c, &selected)?;
            let next = q::next_day_with_games(c, &selected, true)?;
            let replays = games.iter().filter(|g| g["hasReplay"] == true).count();
            let upcoming = games.iter().filter(|g| q::is_upcoming(g, now)).count();
            let live = games
                .iter()
                .filter(|g| str_of(g, "status") == "live")
                .count();
            // Les matchs d'avant midi se jouent dans la nuit qui précède (heure de Paris).
            let all_night = !games.is_empty()
                && games.iter().all(|g| {
                    crate::api::js_number(
                        &str_of(g, "time_paris").chars().take(2).collect::<String>(),
                    ) < 12.0
                });
            (
                json!({
                    "counts": q::object_of(&counts, |x| x.to_json()),
                    "games": games,
                    "records": records_json(&records),
                    "prev": prev,
                    "next": next,
                    "replays": replays,
                    "upcoming": upcoming,
                    "live": live,
                    "all_night": all_night,
                }),
                Value::Null,
            )
        }
        Some(t) => {
            let all = q::team_games(c, t, running)?;
            let upcoming: Vec<&Value> = all.iter().filter(|g| q::is_upcoming(g, now)).collect();
            let played: Vec<&Value> = all
                .iter()
                .filter(|g| str_of(g, "status") == "final")
                .rev()
                .collect();
            let rec = q::season_records(c, q::latest_season(c)?)?
                .get(t)
                .copied()
                .unwrap_or_default();
            (
                Value::Null,
                json!({ "upcoming": upcoming, "played": played, "record": rec.to_json() }),
            )
        }
    };
    Ok(json!({
        "spoilers": ctx.spoilers,
        "today": today,
        "team": team,
        "selected": selected,
        "day": day,
        "team_view": team_view,
    }))
}

// ---------------------------------------------------------------- fiche d'un match

const PERIOD_CATS: [&str; 3] = ["period_start", "period_end", "game_end"];
const EXTRA_KEY_CATS: [&str; 6] = [
    "blocked_fg",
    "foul_flagrant",
    "foul_technical",
    "ejection",
    "review",
    "challenge",
];

/// `toPlayItems` : play-by-play de l'onglet « Actions » (texte traduit, points marqués).
fn play_items(plays: &[crate::espn_events::PlayRow]) -> Vec<Value> {
    let mut prev_total = 0.0;
    plays
        .iter()
        .map(|p| {
            let total = match (p.home_score, p.away_score) {
                (Some(h), Some(a)) => Some(h + a),
                _ => None,
            };
            let scoring = p.scoring != 0.0 && !p.scoring.is_nan();
            let pts = match total {
                Some(t) if scoring => crate::js::max(0.0, crate::js::min(4.0, t - prev_total)),
                _ => 0.0,
            };
            if let Some(t) = total {
                prev_total = t;
            }
            let cat = crate::vf::classify_play(&p.event_type, &p.text_en, scoring).as_str();
            let mut with_pts = p.clone();
            with_pts.score_value = Some(pts);
            let text = crate::vf::translate_play(&with_pts);
            let is_key = p.is_key != 0.0 && !p.is_key.is_nan();
            json!({
                "seq": js_num_value(p.seq),
                "period": js_num_value(p.period),
                "clock": p.clock_display,
                "text": text,
                "team": p.team_abbr,
                "away": p.away_score.map(js_num_value),
                "home": p.home_score.map(js_num_value),
                "pts": js_num_value(pts),
                "key": is_key || pts > 0.0 || EXTRA_KEY_CATS.contains(&cat),
                "type": if PERIOD_CATS.contains(&cat) { "period" } else { "play" },
            })
        })
        .collect()
}

fn positions(c: &Connection, id: i64) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare("SELECT * FROM subtitles WHERE match_id = ?1 ORDER BY video_ts, seq")?;
    let rows = st.query_map([id], |r| {
        Ok(json!([
            sql_to_json(db::col(r, "seq")),
            sql_to_json(db::col(r, "video_ts"))
        ]))
    })?;
    rows.collect()
}

/// `generateMetadata` de la fiche.
fn match_meta(m: &Value) -> (String, String) {
    let a = teams::team_info(str_of(&m["away"], "abbr")).nick;
    let h = teams::team_info(str_of(&m["home"], "abbr")).nick;
    let what = if str_of(m, "status") == "final" {
        if m["video"]["available"] == true {
            "replay en VF"
        } else {
            "statistiques"
        }
    } else {
        "avant-match"
    };
    let label = time::parse_instant(str_of(m, "date_utc"))
        .and_then(|d| time::label_for_date_key(&time::paris_date_key(d)))
        .unwrap_or_default();
    (
        format!("{a} – {h} · {what}"),
        format!(
            "{} contre {}, {label} à {} (heure de Paris).",
            str_of(&m["away"], "name"),
            str_of(&m["home"], "name"),
            str_of(m, "time_paris")
        ),
    )
}

/// `GET /api/pages/matchs/{id}` ; 404 `{ error, title: "Match introuvable" }`
/// pour un identifiant invalide ou inconnu.
pub fn match_page(c: &Connection, ctx: &PageCtx, raw: &str) -> PageResult {
    let not_found =
        || NotFound(json!({ "error": "match introuvable", "title": "Match introuvable" }));
    let Some(id) = crate::routes_match::parse_id(raw) else {
        return Ok(Err(not_found()));
    };
    let Some(row) = db::get_match(c, id)? else {
        return Ok(Err(not_found()));
    };
    let m = to_dto(&row);
    let (title, description) = match_meta(&m);
    let is_final = row.status == "final";
    let is_live = row.status == "live";
    let upcoming = !is_final && !is_live;
    let plays = if upcoming {
        Vec::new()
    } else {
        crate::ingest_db::get_plays(c, id)?
    };
    let ls: Vec<crate::linescore::LinescorePlay> = plays
        .iter()
        .map(|p| crate::linescore::LinescorePlay {
            period: p.period,
            home_score: p.home_score,
            away_score: p.away_score,
        })
        .collect();
    let linescore = crate::linescore::compute_linescore(&ls).map(|l| l.to_json());
    let items = play_items(&plays);
    let lite: Vec<Value> = plays
        .iter()
        .map(|p| {
            json!([
                js_num_value(p.seq),
                js_num_value(p.period),
                js_num_value(p.clock_sec),
                p.clock_display
            ])
        })
        .collect();
    let has_video =
        is_final && m["video"]["available"] == true && crate::js::truthy(m["video"].get("src"));
    let positions = if has_video {
        positions(c, id)?
    } else {
        Vec::new()
    };
    let s = Settings::load(c)?;
    Ok(Ok(json!({
        "title": title,
        "description": description,
        "spoilers": ctx.spoilers,
        "match": m,
        "linescore": linescore,
        "plays": items,
        "lite": lite,
        "has_video": has_video,
        "positions": positions,
        "auto_translate": settings::auto_translate_enabled(&s),
        "vf_mode": settings::vf_mode(&s),
        "is_admin": ctx.session.is_some_and(|s| s.role == "admin"),
    })))
}

// ---------------------------------------------------------------- équipes

const DIVISIONS: [(&str, [&str; 3]); 2] = [
    ("Est", ["Atlantique", "Centrale", "Sud-Est"]),
    ("Ouest", ["Nord-Ouest", "Pacifique", "Sud-Ouest"]),
];

fn win_pct(r: Option<&TeamRecord>) -> f64 {
    match r {
        Some(r) if r.wins + r.losses != 0 => r.wins as f64 / (r.wins + r.losses) as f64,
        _ => 0.0,
    }
}

/// `a.nick.localeCompare(b.nick)` pour les noms de franchises (ASCII, tous
/// distincts) : ordre alphabétique sans casse, chiffres d'abord.
fn nick_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// `GET /api/pages/equipes`.
pub fn equipes(c: &Connection, ctx: &PageCtx) -> rusqlite::Result<Value> {
    let season = q::latest_season(c)?;
    let records = q::season_records(c, season)?;
    let next = q::next_game_by_team(c, ctx.now, ctx.media.running_match_id)?;
    let seeds = q::conference_seeds(c)?;
    let today = q::today_key(ctx.now);
    let all = teams::all_teams();
    let conferences: Vec<Value> = DIVISIONS
        .iter()
        .map(|(conf, divs)| {
            let divisions: Vec<Value> = divs
                .iter()
                .map(|div| {
                    let mut list: Vec<&teams::TeamInfo> = all
                        .iter()
                        .filter(|t| t.conference == *conf && t.division == *div)
                        .collect();
                    // Tri stable, comme `Array.prototype.sort`.
                    list.sort_by(|a, b| {
                        let (ra, rb) = (records.get(&a.abbr), records.get(&b.abbr));
                        let d = win_pct(rb) - win_pct(ra);
                        if d != 0.0 {
                            return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
                        }
                        let w = rb.map_or(0, |r| r.wins) - ra.map_or(0, |r| r.wins);
                        if w != 0 {
                            return w.cmp(&0);
                        }
                        nick_cmp(&a.nick, &b.nick)
                    });
                    let teams: Vec<Value> = list
                        .iter()
                        .map(|t| {
                            json!({
                                "team": t.to_json(),
                                "record": records.get(&t.abbr).map(|r| r.to_json()),
                                "next": next.get(&t.abbr),
                                "seed": seeds.get(&t.abbr),
                            })
                        })
                        .collect();
                    json!({ "division": div, "teams": teams })
                })
                .collect();
            json!({ "conference": conf, "divisions": divisions })
        })
        .collect();
    Ok(json!({ "season": season, "today": today, "conferences": conferences }))
}

#[derive(Default, Clone, Copy)]
struct Split {
    wins: i64,
    losses: i64,
}

impl Split {
    fn to_json(self) -> Value {
        json!({ "wins": self.wins, "losses": self.losses })
    }
}

/// `seasonSummary` : bilan de la SAISON RÉGULIÈRE EN COURS uniquement.
fn season_summary(games: &[Value], team: &str, season: Option<i64>) -> Value {
    let (mut total, mut home, mut road) = (Split::default(), Split::default(), Split::default());
    let mut results: Vec<bool> = Vec::new();
    for g in games {
        let same_season = season.is_some() && g["season"].as_f64() == season.map(|s| s as f64);
        if !(str_of(g, "status") == "final" && same_season && str_of(g, "season_type") == "regular")
        {
            continue;
        }
        let is_home = str_of(&g["home"], "abbr") == team;
        let (mine, theirs) = if is_home {
            (g["home"]["score"].as_f64(), g["away"]["score"].as_f64())
        } else {
            (g["away"]["score"].as_f64(), g["home"]["score"].as_f64())
        };
        let (Some(mine), Some(theirs)) = (mine, theirs) else {
            continue;
        };
        if mine == theirs {
            continue;
        }
        let won = mine > theirs;
        let bucket = if is_home { &mut home } else { &mut road };
        if won {
            total.wins += 1;
            bucket.wins += 1;
        } else {
            total.losses += 1;
            bucket.losses += 1;
        }
        results.push(won);
    }
    // Série en cours : nombre de résultats identiques consécutifs à la fin.
    let last = results.last().copied();
    let streak = results
        .iter()
        .rev()
        .take_while(|r| Some(**r) == last)
        .count();
    json!({
        "season": season,
        "total": total.to_json(),
        "home": home.to_json(),
        "road": road.to_json(),
        "streak": if streak > 0 { format!("{}{streak}", if last == Some(true) { "V" } else { "D" }) } else { "—".into() },
        "streak_win": last,
    })
}

fn abbr_shape(abbr: &str) -> bool {
    (2..=4).contains(&abbr.len()) && abbr.bytes().all(|b| b.is_ascii_uppercase())
}

/// `GET /api/pages/equipes/{abbr}` ; 404 `{ error }` pour une abréviation
/// mal formée, ou inconnue sans aucun match en base.
pub fn equipe(c: &Connection, ctx: &PageCtx, raw: &str) -> PageResult {
    let abbr = raw.to_uppercase();
    let not_found = || NotFound(json!({ "error": "équipe introuvable" }));
    if !abbr_shape(&abbr) {
        return Ok(Err(not_found()));
    }
    let all = q::team_games(c, &abbr, ctx.media.running_match_id)?;
    if all.is_empty() && !teams::is_nba_team(&abbr) {
        return Ok(Err(not_found()));
    }
    let t = teams::team_info(&abbr);
    let title = if teams::is_nba_team(&abbr) {
        format!("{} {}", t.city, t.nick)
    } else {
        abbr.clone()
    };
    let now = ctx.now;
    let upcoming: Vec<&Value> = all.iter().filter(|g| q::is_upcoming(g, now)).collect();
    let finished: Vec<&Value> = all
        .iter()
        .filter(|g| str_of(g, "status") == "final")
        .collect();
    let recent: Vec<&Value> = finished.iter().rev().copied().collect();
    let replays: Vec<&Value> = recent
        .iter()
        .copied()
        .filter(|g| g["hasReplay"] == true)
        .collect();
    let summary = season_summary(&all, &abbr, q::latest_season(c)?);
    let regular: Vec<&Value> = finished
        .iter()
        .copied()
        .filter(|g| str_of(g, "season_type") == "regular")
        .collect();
    let form = &regular[regular.len().saturating_sub(10)..];

    let mut seed = Value::Null;
    if let Some(std) = q::cached_standings(c)? {
        let confs = crate::js::items(Some(&std));
        let has = |conf: &Value| {
            q::conference_rows(conf)
                .iter()
                .any(|r| r.get("abbr").and_then(Value::as_str) == Some(abbr.as_str()))
        };
        if let Some(conf) = confs.iter().find(|c| has(c)) {
            let rows = q::conference_rows(conf);
            if let Some(rank) = rows
                .iter()
                .position(|r| r.get("abbr").and_then(Value::as_str) == Some(abbr.as_str()))
            {
                seed = q::seed_or(&rows[rank], rank);
            }
        }
    }
    let wins = summary["total"]["wins"].as_i64().unwrap_or(0);
    let played = wins + summary["total"]["losses"].as_i64().unwrap_or(0);
    let pct = (played != 0).then(|| crate::js::round(wins as f64 / played as f64 * 1000.0) / 10.0);
    Ok(Ok(json!({
        "title": title,
        "spoilers": ctx.spoilers,
        "abbr": abbr,
        "team": t.to_json(),
        "today": q::today_key(now),
        "upcoming_count": upcoming.len(),
        "next_game": upcoming.first(),
        "upcoming_rest": upcoming.iter().skip(1).take(8).collect::<Vec<_>>(),
        "finished_count": finished.len(),
        "form": form,
        "recent": recent.iter().take(10).collect::<Vec<_>>(),
        "replays_count": replays.len(),
        "replays": replays.iter().take(6).collect::<Vec<_>>(),
        "summary": summary,
        "seed": seed,
        "pct": pct.map(js_num_value),
    })))
}

// ---------------------------------------------------------------- classement

/// `GET /api/pages/classement` : `loadStandings` (cache de 30 min, ESPN
/// sinon, cache périmé si ESPN ne répond pas, `[]` faute de mieux) ; voir
/// `routes_pages::classement` pour l'appel réseau.
pub fn classement(conferences: Value) -> Value {
    json!({ "conferences": conferences })
}

// ---------------------------------------------------------------- paramètres

fn version_text(v: &crate::version::AppVersion) -> String {
    const MOIS: [&str; 12] = [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ];
    let Some(commit) = &v.commit else {
        return "Numéro de version non renseigné.".into();
    };
    // `Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: PARIS_TZ })`.
    let built = v
        .built_at
        .as_deref()
        .and_then(time::parse_instant)
        .map(|d| {
            use chrono::{Datelike, Timelike};
            let p = d.with_timezone(&chrono_tz::Europe::Paris);
            format!(
                " · image construite le {} {} {}, {:02}:{:02}",
                p.day(),
                MOIS[p.month0() as usize],
                p.year(),
                p.hour(),
                p.minute()
            )
        })
        .unwrap_or_default();
    format!("Version {commit}{built}.")
}

/// `GET /api/pages/parametres` (session requise : sans session, 401 ; la page
/// renvoyait vers `/login?next=/parametres`). `dub_disabled_reason` ne sert
/// qu'à un administrateur.
pub fn parametres(
    c: &Connection,
    session: &Session,
    media: &MediaState,
) -> rusqlite::Result<Value> {
    let admin = session.role == "admin";
    let admin_data = if admin {
        let s = Settings::load(c)?;
        json!({
            "users": crate::accounts::list_users(c)?,
            "auto_translate": settings::auto_translate_enabled(&s),
            "vf_mode": settings::vf_mode(&s),
            "transcribe_engine": settings::transcribe_engine(&s),
            "voice_disabled_reason": media.dub_disabled_reason,
            "minimax": settings::minimax_settings_view(&s),
            "openai": settings::openai_settings_view(&s),
            "openai_model_placeholder": settings::OPENAI_MODEL_PLACEHOLDER,
        })
    } else {
        Value::Null
    };
    let v = crate::version::app_version();
    Ok(json!({
        "user": user_json(session),
        "admin": admin,
        "admin_data": admin_data,
        "version": v.to_json(),
        "version_text": version_text(&v),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texte_de_version() {
        use crate::version::AppVersion;
        let v = |c: Option<&str>, b: Option<&str>| AppVersion {
            commit: c.map(str::to_string),
            built_at: b.map(str::to_string),
        };
        assert_eq!(
            version_text(&v(None, None)),
            "Numéro de version non renseigné."
        );
        assert_eq!(version_text(&v(Some("abc1234"), None)), "Version abc1234.");
        // Valeurs relevées avec Intl de Node 22.
        assert_eq!(
            version_text(&v(Some("abc1234"), Some("2026-10-31T15:23:00.000Z"))),
            "Version abc1234 · image construite le 31 oct. 2026, 16:23."
        );
        assert_eq!(
            version_text(&v(Some("abc1234"), Some("2026-02-15T23:59:00.000Z"))),
            "Version abc1234 · image construite le 16 févr. 2026, 00:59."
        );
    }

    #[test]
    fn tri_des_noms_comme_localecompare() {
        let mut names = [
            "Hawks",
            "Celtics",
            "Nets",
            "76ers",
            "Trail Blazers",
            "Timberwolves",
            "Thunder",
            "Jazz",
            "Nuggets",
        ];
        names.sort_by(|a, b| nick_cmp(a, b));
        assert_eq!(
            names.join(","),
            "76ers,Celtics,Hawks,Jazz,Nets,Nuggets,Thunder,Timberwolves,Trail Blazers"
        );
    }
}
