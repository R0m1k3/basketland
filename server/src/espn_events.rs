//! Calendrier et fiche d'un match ESPN (équivalent de `fetchScoreboard`,
//! `fetchScoreboardRange`, `fetchSummary` et de leurs parseurs dans
//! `src/lib/espn.ts`) : mêmes champs, mêmes valeurs, mêmes replis.

use crate::api::js_num_value;
use crate::js::{self, items, jsre, prop, str_or_empty, string_of, to_number, truthy};
use crate::jsval::{js_normalize, js_number_string, js_string, or_else};
use crate::time::{iso_utc, parse_instant};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const ESPN_SITE: &str = "https://site.api.espn.com/apis/site/v2/sports/basketball";

/// Base de l'API (`BL_ESPN_SITE` : autre adresse, pour les tests hors réseau).
fn site() -> String {
    std::env::var("BL_ESPN_SITE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ESPN_SITE.to_string())
}

/// Match normalisé issu d'ESPN (avant écriture en base). Les nombres sont
/// ceux de JavaScript (`Number(...)`, NaN compris).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMatch {
    pub id: f64,
    pub espn_id: String,
    pub league: String,
    pub season: f64,
    pub season_type: &'static str,
    /// `None` : date absente (`undefined` côté Node).
    pub date_utc: Option<String>,
    pub home_abbr: String,
    pub home_name: String,
    pub away_abbr: String,
    pub away_name: String,
    pub home_score: Option<f64>,
    pub away_score: Option<f64>,
    pub status: &'static str,
    pub status_detail: String,
    pub period: f64,
    pub clock_display: String,
    pub venue: String,
    pub broadcast: String,
}

impl ParsedMatch {
    /// Objet tel que `JSON.stringify` l'écrirait.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), js_num_value(self.id));
        m.insert("espn_id".into(), self.espn_id.clone().into());
        m.insert("league".into(), self.league.clone().into());
        m.insert("season".into(), js_num_value(self.season));
        m.insert("season_type".into(), self.season_type.into());
        if let Some(d) = &self.date_utc {
            m.insert("date_utc".into(), d.clone().into());
        }
        m.insert("home_abbr".into(), self.home_abbr.clone().into());
        m.insert("home_name".into(), self.home_name.clone().into());
        m.insert("away_abbr".into(), self.away_abbr.clone().into());
        m.insert("away_name".into(), self.away_name.clone().into());
        m.insert("home_score".into(), opt_num(self.home_score));
        m.insert("away_score".into(), opt_num(self.away_score));
        m.insert("status".into(), self.status.into());
        m.insert("status_detail".into(), self.status_detail.clone().into());
        m.insert("period".into(), js_num_value(self.period));
        m.insert("clock_display".into(), self.clock_display.clone().into());
        m.insert("venue".into(), self.venue.clone().into());
        m.insert("broadcast".into(), self.broadcast.clone().into());
        Value::Object(m)
    }
}

fn opt_num(v: Option<f64>) -> Value {
    v.map(js_num_value).unwrap_or(Value::Null)
}

/// Action du play-by-play (`PlayRow`). `score_value` et `participants` ne
/// sont pas en base : absents (`undefined`) sur une action relue.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayRow {
    pub match_id: f64,
    pub seq: f64,
    pub period: f64,
    pub clock_display: String,
    pub clock_sec: f64,
    pub wallclock: String,
    pub event_type: String,
    pub text_en: String,
    pub actor: String,
    pub team_abbr: String,
    pub home_score: Option<f64>,
    pub away_score: Option<f64>,
    pub scoring: f64,
    pub is_key: f64,
    pub score_value: Option<f64>,
    pub participants: Option<Vec<String>>,
}

impl PlayRow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("match_id".into(), js_num_value(self.match_id));
        m.insert("seq".into(), js_num_value(self.seq));
        m.insert("period".into(), js_num_value(self.period));
        m.insert("clock_display".into(), self.clock_display.clone().into());
        m.insert("clock_sec".into(), js_num_value(self.clock_sec));
        m.insert("wallclock".into(), self.wallclock.clone().into());
        m.insert("event_type".into(), self.event_type.clone().into());
        m.insert("text_en".into(), self.text_en.clone().into());
        m.insert("actor".into(), self.actor.clone().into());
        m.insert("team_abbr".into(), self.team_abbr.clone().into());
        m.insert("home_score".into(), opt_num(self.home_score));
        m.insert("away_score".into(), opt_num(self.away_score));
        m.insert("scoring".into(), js_num_value(self.scoring));
        m.insert("is_key".into(), js_num_value(self.is_key));
        if let Some(v) = self.score_value {
            m.insert("score_value".into(), js_num_value(v));
        }
        if let Some(p) = &self.participants {
            m.insert("participants".into(), json!(p));
        }
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeamStatRow {
    pub team_abbr: String,
    /// Objet `Record<string, string>`, clés dans l'ordre de JavaScript.
    pub stats: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerStatRow {
    pub team_abbr: String,
    pub player_id: String,
    pub player_name: String,
    pub position: String,
    pub jersey: String,
    pub starter: f64,
    pub stats: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LeaderRow {
    pub team_abbr: String,
    pub category: String,
    pub label: String,
    pub player: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSummary {
    pub match_id: f64,
    pub game: Option<ParsedMatch>,
    pub teams: Vec<TeamStatRow>,
    pub players: Vec<PlayerStatRow>,
    pub leaders: Vec<LeaderRow>,
    pub plays: Vec<PlayRow>,
}

impl ParsedSummary {
    pub fn to_json(&self) -> Value {
        let id = js_num_value(self.match_id);
        json!({
            "match": self.game.as_ref().map(ParsedMatch::to_json),
            "teams": self.teams.iter().map(|t| json!({ "match_id": id, "team_abbr": t.team_abbr, "stats": t.stats })).collect::<Vec<_>>(),
            "players": self.players.iter().map(|p| json!({
                "match_id": id, "team_abbr": p.team_abbr, "player_id": p.player_id, "player_name": p.player_name,
                "position": p.position, "jersey": p.jersey, "starter": js_num_value(p.starter), "stats": p.stats,
            })).collect::<Vec<_>>(),
            "leaders": self.leaders.iter().map(|l| json!({
                "team_abbr": l.team_abbr, "category": l.category, "label": l.label, "player": l.player, "value": l.value,
            })).collect::<Vec<_>>(),
            "plays": self.plays.iter().map(PlayRow::to_json).collect::<Vec<_>>(),
        })
    }
}

// ------------------------------------------------------------------ utilitaires

/// `parseClock` : `'11:43'` → 703 ; `'4.9'` → 5 ; `'0.0'` → 0.
pub fn parse_clock(display: Option<&Value>) -> f64 {
    if !truthy(display) {
        return 0.0;
    }
    let raw = string_of(display);
    let s = js::trim(&raw);
    if let Some(m) = jsre!(r"^(\d+):(\d{1,2})(?:\.(\d+))?$").captures(s) {
        return crate::api::js_number(&m[1]) * 60.0 + crate::api::js_number(&m[2]);
    }
    let n = crate::api::js_number(s);
    if n.is_finite() {
        js::round(n)
    } else {
        0.0
    }
}

/// `mapStatus` : `in` → live ; `post` → final (sauf reporté/annulé) ; sinon scheduled.
pub fn map_status(state: Option<&Value>, name: Option<&Value>) -> &'static str {
    match state {
        Some(Value::String(s)) if s == "in" => "live",
        Some(Value::String(s)) if s == "post" => {
            if truthy(name)
                && jsre!("POSTPONED|CANCELED|CANCELLED|SUSPENDED").is_match(&string_of(name))
            {
                "scheduled"
            } else {
                "final"
            }
        }
        _ => "scheduled",
    }
}

pub fn map_season_type(kind: Option<&Value>, slug: Option<&Value>) -> &'static str {
    let t = to_number(kind);
    let slug = slug.and_then(Value::as_str);
    if t == 1.0 || slug == Some("preseason") {
        "preseason"
    } else if t == 3.0 || t == 5.0 || matches!(slug, Some("post-season" | "play-in-season")) {
        "post"
    } else {
        "regular"
    }
}

/// `Date.parse(x)` en millisecondes (formats ISO rencontrés chez ESPN et en base).
fn date_parse(v: &Value) -> Option<DateTime<Utc>> {
    match v {
        Value::String(s) => parse_instant(s),
        Value::Null => None,
        other => parse_instant(&js_string(other)),
    }
}

/// `normalizeIsoUtc` : `'2026-10-27T23:30Z'` → ISO complet ; illisible : tel quel.
fn normalize_iso_utc(v: Option<&Value>) -> Option<String> {
    let v = v?;
    match date_parse(v) {
        Some(d) => Some(iso_utc(d)),
        None => match v {
            Value::String(s) => Some(s.clone()),
            Value::Null => None,
            other => Some(js_string(other)),
        },
    }
}

/// `new Date(x).getUTCFullYear()`.
fn utc_year(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n
            .as_f64()
            .and_then(|ms| Utc.timestamp_millis_opt(ms.trunc() as i64).single())
            .map(|d| f64::from(d.year()))
            .unwrap_or(f64::NAN),
        Some(Value::String(s)) => parse_instant(s)
            .map(|d| f64::from(d.year()))
            .unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `intOrNull`.
fn int_or_null(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        x => Some(to_number(x)).filter(|n| n.is_finite()),
    }
}

fn broadcast_names(comp: &Value) -> String {
    // `Set` : ordre d'insertion, sans doublon.
    fn add(names: &mut Vec<String>, n: String) {
        if !names.contains(&n) {
            names.push(n);
        }
    }
    let mut names: Vec<String> = Vec::new();
    for b in items(comp.get("broadcasts")) {
        for n in items(b.get("names")) {
            add(&mut names, js_string(&n));
        }
    }
    for g in items(comp.get("geoBroadcasts")) {
        let short = prop(prop(Some(&g), "media"), "shortName");
        if truthy(short) {
            add(&mut names, string_of(short));
        }
    }
    if names.is_empty() {
        if let Some(Value::String(b)) = comp.get("broadcast") {
            if !b.is_empty() {
                add(&mut names, b.clone());
            }
        }
    }
    names.join(", ")
}

fn competitor<'a>(comp: &'a Value, side: &str) -> Option<&'a Value> {
    comp.get("competitors")?
        .as_array()?
        .iter()
        .find(|c| c.get("homeAway").and_then(Value::as_str) == Some(side))
}

/// `parseEvent` : un évènement du scoreboard (ou du header de summary).
pub fn parse_event(ev: &Value, league: &str) -> Option<ParsedMatch> {
    let comp = prop(Some(ev), "competitions").and_then(|c| prop(Some(c), "0"));
    if !truthy(comp) {
        return None;
    }
    let comp = comp?;
    let home = competitor(comp, "home")?;
    let away = competitor(comp, "away")?;
    let empty = json!({});
    let status = or_else(ev.get("status"), comp.get("status")).unwrap_or(&empty);
    let stype = prop(Some(status), "type");
    let st = map_status(prop(stype, "state"), prop(stype, "name"));
    let ev_season = ev.get("season");
    let comp_season = comp.get("season");
    let year = match or_else(prop(ev_season, "year"), prop(comp_season, "year")) {
        Some(y) => to_number(Some(y)),
        None => utc_year(ev.get("date")),
    };
    // String(c.team?.abbreviation ?? '') ; String(c.team?.displayName ?? c.team?.name ?? '')
    let abbr = |c: &Value| str_or_empty(prop(c.get("team"), "abbreviation"));
    let name = |c: &Value| {
        let t = c.get("team");
        str_or_empty(or_else(prop(t, "displayName"), prop(t, "name")))
    };
    let score = |c: &Value| {
        if st == "scheduled" {
            None
        } else {
            int_or_null(or_else(prop(c.get("score"), "value"), c.get("score")))
        }
    };
    let id = ev.get("id");
    Some(ParsedMatch {
        id: to_number(id),
        espn_id: string_of(id),
        league: league.to_string(),
        // ESPN numérote la saison par son année de fin (2026-27 → 2027) ; on stocke l'année de début.
        season: year - 1.0,
        season_type: map_season_type(
            or_else(prop(ev_season, "type"), prop(comp_season, "type")),
            prop(ev_season, "slug"),
        ),
        date_utc: normalize_iso_utc(or_else(ev.get("date"), comp.get("date"))),
        home_abbr: abbr(home),
        home_name: name(home),
        away_abbr: abbr(away),
        away_name: name(away),
        home_score: score(home),
        away_score: score(away),
        status: st,
        status_detail: str_or_empty(or_else(prop(stype, "shortDetail"), prop(stype, "detail"))),
        period: to_number(Some(prop(Some(status), "period").unwrap_or(&json!(0)))),
        clock_display: str_or_empty(prop(Some(status), "displayClock")),
        venue: str_or_empty(prop(comp.get("venue"), "fullName")),
        broadcast: broadcast_names(comp),
    })
}

/// `parseScoreboard` : les évènements dont les deux équipes sont connues.
pub fn parse_scoreboard(json: &Value, league: &str) -> Vec<ParsedMatch> {
    items(json.get("events"))
        .iter()
        .filter_map(|ev| parse_event(ev, league))
        .filter(|m| !m.home_abbr.is_empty() && !m.away_abbr.is_empty())
        .collect()
}

/// `cleanText` : retours à la ligne et blancs multiples ramenés à une espace.
pub fn clean_text(v: Option<&Value>) -> String {
    let s = str_or_empty(v);
    let s = jsre!(r"\s*\n\s*").replace_all(&s, " ");
    let s = jsre!(r"\s+'s\b").replace_all(&s, "'s");
    let s = jsre!(r"\s{2,}").replace_all(&s, " ");
    js::trim(&s).to_string()
}

/// `actorFromText` : nom du joueur principal déduit du texte ESPN (repli
/// pour les lancers francs, dont ESPN ne renseigne pas les participants).
pub fn actor_from_text(text: &str) -> String {
    let clean = clean_text(Some(&Value::from(text)));
    let re = jsre!(
        concat!(
            r"^([A-ZÀ-ÖØ-Þ][\p{L}'’.-]*(?: (?:d[aeiu]|v[ao]n|de|del|della|di|da|dos|las|el|al))?(?: [A-ZÀ-ÖØ-Þ][\p{L}'’.-]*){0,2})",
            r"\s+(?:makes|misses|blocks|steals|grabs|commits|enters|leaves|is called for|tosses|defensive rebound|offensive rebound|turnover|traveling)"
        ),
        "u"
    );
    re.captures(&clean)
        .map(|m| m[1].to_string())
        .unwrap_or_default()
}

/// Clé de `Set` pour un nombre (SameValueZero : `-0` et `+0` confondus).
fn num_key(n: f64) -> u64 {
    if n == 0.0 {
        0
    } else {
        n.to_bits()
    }
}

/// `parsePlays` : numéros de séquence strictement croissants, wallclock
/// manquant comblé par le précédent connu.
pub fn parse_plays(
    raw: &[Value],
    match_id: f64,
    team_id_to_abbr: &HashMap<String, String>,
    athlete_names: &HashMap<String, String>,
) -> Vec<PlayRow> {
    let mut out: Vec<PlayRow> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    let mut last_seq = 0.0;
    for p in raw {
        let pv = Some(p);
        let espn_seq = to_number(prop(pv, "sequenceNumber"));
        let seq =
            if !espn_seq.is_finite() || seen.contains(&num_key(espn_seq)) || espn_seq <= last_seq {
                last_seq + 1.0
            } else {
                espn_seq
            };
        seen.insert(num_key(seq));
        last_seq = seq;
        let event_type = clean_text(prop(prop(pv, "type"), "text"));
        let text = clean_text(prop(pv, "text"));
        let scoring = if truthy(prop(pv, "scoringPlay")) {
            1.0
        } else {
            0.0
        };
        let participants: Vec<String> = items(prop(pv, "participants"))
            .iter()
            .map(|x| {
                let id = str_or_empty(prop(prop(Some(x), "athlete"), "id"));
                athlete_names.get(&id).cloned().unwrap_or_default()
            })
            .filter(|s| !s.is_empty())
            .collect();
        let category = crate::vf::classify_play(&event_type, &text, scoring != 0.0);
        let clock = prop(prop(pv, "clock"), "displayValue");
        let wallclock = prop(pv, "wallclock");
        let actor = participants
            .first()
            .cloned()
            .unwrap_or_else(|| actor_from_text(&text));
        out.push(PlayRow {
            match_id,
            seq,
            period: to_number(Some(
                prop(prop(pv, "period"), "number").unwrap_or(&json!(0)),
            )),
            clock_display: str_or_empty(clock),
            clock_sec: parse_clock(clock),
            wallclock: if truthy(wallclock) {
                normalize_iso_utc(wallclock).unwrap_or_default()
            } else {
                String::new()
            },
            event_type,
            text_en: text,
            actor,
            team_abbr: team_id_to_abbr
                .get(&str_or_empty(prop(prop(pv, "team"), "id")))
                .cloned()
                .unwrap_or_default(),
            home_score: int_or_null(prop(pv, "homeScore")),
            away_score: int_or_null(prop(pv, "awayScore")),
            scoring,
            is_key: if crate::vf::is_key_category(category) {
                1.0
            } else {
                0.0
            },
            score_value: Some(to_number(Some(
                or_else(prop(pv, "scoreValue"), Some(&json!(0))).unwrap_or(&Value::Null),
            ))),
            participants: Some(participants),
        });
    }
    // Le wallclock est indispensable à la synchro : on comble les trous par le précédent connu.
    let mut last = String::new();
    for p in &mut out {
        if !p.wallclock.is_empty() {
            last = p.wallclock.clone();
        } else {
            p.wallclock = last.clone();
        }
    }
    out
}

/// Objet `Record<string, string>` dans l'ordre des clés de JavaScript.
fn record(pairs: Vec<(String, String)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k, Value::from(v));
    }
    js_normalize(Value::Object(m))
}

/// `parseSummary` : match, stats d'équipes et de joueurs, meneurs, actions.
pub fn parse_summary(json: &Value, match_id: f64, league: &str) -> ParsedSummary {
    let mut team_id_to_abbr: HashMap<String, String> = HashMap::new();
    let mut athlete_names: HashMap<String, String> = HashMap::new();
    let empty = json!({});
    let bx = or_else(json.get("boxscore"), None).unwrap_or(&empty);

    for t in items(bx.get("teams")) {
        let id = prop(prop(Some(&t), "team"), "id");
        if truthy(id) {
            team_id_to_abbr.insert(
                string_of(id),
                string_of(prop(prop(Some(&t), "team"), "abbreviation")),
            );
        }
    }
    let header = json.get("header");
    let header_comp = prop(prop(header, "competitions"), "0");
    for c in items(prop(header_comp, "competitors")) {
        let id = prop(prop(Some(&c), "team"), "id");
        if truthy(id) {
            team_id_to_abbr.insert(
                string_of(id),
                string_of(prop(prop(Some(&c), "team"), "abbreviation")),
            );
        }
    }

    let teams: Vec<TeamStatRow> = items(bx.get("teams"))
        .iter()
        .map(|t| {
            let pairs = items(t.get("statistics"))
                .iter()
                .map(|s| {
                    let key = string_of(or_else(
                        or_else(s.get("abbreviation"), s.get("label")),
                        s.get("name"),
                    ));
                    (key, str_or_empty(s.get("displayValue")))
                })
                .collect();
            TeamStatRow {
                team_abbr: str_or_empty(prop(t.get("team"), "abbreviation")),
                stats: record(pairs),
            }
        })
        .collect();

    let mut players: Vec<PlayerStatRow> = Vec::new();
    for group in items(bx.get("players")) {
        let abbr = str_or_empty(prop(group.get("team"), "abbreviation"));
        for block in items(group.get("statistics")) {
            let names = items(or_else(block.get("names"), block.get("labels")));
            for a in items(block.get("athletes")) {
                let athlete = a.get("athlete");
                let id = str_or_empty(prop(athlete, "id"));
                if id.is_empty() {
                    continue;
                }
                let name = str_or_empty(or_else(
                    prop(athlete, "displayName"),
                    prop(athlete, "shortName"),
                ));
                athlete_names.insert(id.clone(), name.clone());
                let mut pairs: Vec<(String, String)> = Vec::new();
                if let Some(Value::Array(stats)) = a.get("stats") {
                    for (i, v) in stats.iter().enumerate() {
                        if let Some(n) = names.get(i).filter(|n| truthy(Some(n))) {
                            pairs.push((js_string(n), str_or_empty(Some(v))));
                        }
                    }
                }
                if truthy(a.get("didNotPlay")) {
                    pairs.push((
                        "DNP".into(),
                        str_or_empty(or_else(a.get("reason"), Some(&json!("DNP")))),
                    ));
                }
                players.push(PlayerStatRow {
                    team_abbr: abbr.clone(),
                    player_id: id,
                    player_name: name,
                    position: str_or_empty(prop(prop(athlete, "position"), "abbreviation")),
                    jersey: str_or_empty(prop(athlete, "jersey")),
                    starter: if truthy(a.get("starter")) { 1.0 } else { 0.0 },
                    stats: record(pairs),
                });
            }
        }
    }

    let mut leaders: Vec<LeaderRow> = Vec::new();
    for tl in items(json.get("leaders")) {
        let abbr = str_or_empty(prop(tl.get("team"), "abbreviation"));
        for cat in items(tl.get("leaders")) {
            let top = prop(cat.get("leaders"), "0");
            if !truthy(top) {
                continue;
            }
            leaders.push(LeaderRow {
                team_abbr: abbr.clone(),
                category: str_or_empty(cat.get("name")),
                label: str_or_empty(or_else(cat.get("displayName"), cat.get("name"))),
                player: str_or_empty(prop(prop(top, "athlete"), "displayName")),
                value: str_or_empty(prop(top, "displayValue")),
            });
        }
    }

    let game = if truthy(header_comp) {
        let hc = header_comp.cloned().unwrap_or(Value::Null);
        let mut comp = match &hc {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        let venue = or_else(prop(json.get("gameInfo"), "venue"), hc.get("venue")).cloned();
        match venue {
            Some(v) => comp.insert("venue".into(), v),
            None => comp.remove("venue"),
        };
        let mut ev = Map::new();
        ev.insert(
            "id".into(),
            or_else(prop(header, "id"), None)
                .cloned()
                .unwrap_or_else(|| js_num_value(match_id)),
        );
        for (k, v) in [
            ("date", hc.get("date")),
            ("season", prop(header, "season")),
            ("status", hc.get("status")),
        ] {
            if let Some(v) = v {
                ev.insert(k.into(), v.clone());
            }
        }
        ev.insert("competitions".into(), json!([Value::Object(comp)]));
        parse_event(&Value::Object(ev), league)
    } else {
        None
    };

    let raw_plays = match json.get("plays") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let plays = parse_plays(&raw_plays, match_id, &team_id_to_abbr, &athlete_names);
    ParsedSummary {
        match_id,
        game,
        teams,
        players,
        leaders,
        plays,
    }
}

// ------------------------------------------------------------------ appels ESPN

/// `fetchScoreboard` : un jour (YYYYMMDD), un mois (YYYYMM) ou une année (YYYY).
pub async fn fetch_scoreboard(
    dates: &str,
    league: &str,
    limit: u32,
) -> Result<Vec<ParsedMatch>, String> {
    if !jsre!(r"^\d{4}$|^\d{6}$|^\d{8}$").is_match(dates) {
        return Err(format!(
            "dates invalide « {dates} » : l'API ESPN n'accepte qu'un jour (YYYYMMDD), \
             un mois (YYYYMM) ou une année (YYYY), pas une plage. \
             Utilisez fetchScoreboardRange(from, to) pour une période."
        ));
    }
    let json = crate::http::fetch_json(&format!(
        "{}/{league}/scoreboard?dates={dates}&limit={limit}",
        site()
    ))
    .await?;
    Ok(parse_scoreboard(&json, league))
}

/// `espnDate` : `YYYYMMDD` (UTC).
pub fn espn_date(d: NaiveDate) -> String {
    format!("{:04}{:02}{:02}", d.year(), d.month(), d.day())
}

/// `fetchScoreboardRange` : moins de 8 jours d'écart, un appel par jour ;
/// sinon un appel par mois. Échec seulement si tous les appels ont échoué
/// sans rien rapporter ; les échecs partiels sont signalés.
pub async fn fetch_scoreboard_range(
    from: NaiveDate,
    to: NaiveDate,
    league: &str,
    limit: u32,
) -> Result<Vec<ParsedMatch>, String> {
    if to < from {
        return Ok(Vec::new());
    }
    let span_days = (to - from).num_days();
    let mut out = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut attempts = 0usize;
    if span_days < 8 {
        let mut d = from;
        while d <= to {
            attempts += 1;
            match fetch_scoreboard(&espn_date(d), league, limit).await {
                Ok(m) => out.extend(m),
                Err(e) => errors.push(format!("{}: {e}", espn_date(d))),
            }
            d += Duration::days(1);
        }
    } else {
        let (mut y, mut m) = (from.year(), from.month());
        while (y, m) <= (to.year(), to.month()) {
            attempts += 1;
            let key = format!("{y}{m:02}");
            match fetch_scoreboard(&key, league, limit).await {
                Ok(list) => out.extend(list),
                Err(e) => errors.push(format!("{key}: {e}")),
            }
            if m == 12 {
                y += 1;
                m = 1;
            } else {
                m += 1;
            }
        }
    }
    if out.is_empty() && attempts > 0 && errors.len() == attempts {
        return Err(errors.join(" | "));
    }
    if !errors.is_empty() {
        eprintln!(
            "[espn] {}/{attempts} période(s) en échec : {}",
            errors.len(),
            errors.join(" | ")
        );
    }
    Ok(out)
}

/// `fetchSummary` : fiche complète d'un match.
pub async fn fetch_summary(event_id: i64, league: &str) -> Result<ParsedSummary, String> {
    let json =
        crate::http::fetch_json(&format!("{}/{league}/summary?event={event_id}", site())).await?;
    Ok(parse_summary(&json, event_id as f64, league))
}

/// Libellé d'une saison pour les journaux (`${season}`).
pub fn season_text(season: f64) -> String {
    js_number_string(season)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrono_comme_parseclock() {
        assert_eq!(parse_clock(Some(&json!("11:43"))), 703.0);
        assert_eq!(parse_clock(Some(&json!("4.9"))), 5.0);
        assert_eq!(parse_clock(Some(&json!("0.0"))), 0.0);
        assert_eq!(parse_clock(Some(&json!(""))), 0.0);
        assert_eq!(parse_clock(None), 0.0);
        assert_eq!(parse_clock(Some(&json!("1:05.3"))), 65.0);
        assert_eq!(parse_clock(Some(&json!("abc"))), 0.0);
    }

    #[test]
    fn statut_comme_mapstatus() {
        assert_eq!(map_status(Some(&json!("in")), None), "live");
        assert_eq!(
            map_status(Some(&json!("post")), Some(&json!("STATUS_FINAL"))),
            "final"
        );
        assert_eq!(
            map_status(Some(&json!("post")), Some(&json!("STATUS_POSTPONED"))),
            "scheduled"
        );
        assert_eq!(map_status(Some(&json!("pre")), None), "scheduled");
        assert_eq!(map_season_type(Some(&json!("3")), None), "post");
        assert_eq!(
            map_season_type(Some(&json!(2)), Some(&json!("preseason"))),
            "preseason"
        );
    }

    #[test]
    fn acteur_deduit_du_texte() {
        assert_eq!(
            actor_from_text("Luka Doncic makes free throw 1 of 2"),
            "Luka Doncic"
        );
        assert_eq!(
            actor_from_text("Tristan da Silva misses free throw 2 of 2"),
            "Tristan da Silva"
        );
        assert_eq!(
            actor_from_text("Pascal Siakam defensive rebound"),
            "Pascal Siakam"
        );
        assert_eq!(actor_from_text("End of the 1st Quarter"), "");
    }
}
