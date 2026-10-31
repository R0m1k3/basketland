//! Référentiel statique des 30 franchises NBA (abréviations ESPN), équivalent
//! de `src/lib/teams.ts` : couleurs, conférence, division, nom court.
//! `accent` est la couleur lisible sur fond sombre.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamInfo {
    pub abbr: String,
    pub city: String,
    pub nick: String,
    /// « Est » ou « Ouest ».
    pub conference: String,
    pub division: String,
    pub primary: String,
    pub accent: String,
}

impl TeamInfo {
    /// Objet tel que l'écrit `JSON.stringify` (ordre des clés de `T(…)`).
    pub fn to_json(&self) -> Value {
        json!({
            "abbr": self.abbr,
            "city": self.city,
            "nick": self.nick,
            "conference": self.conference,
            "division": self.division,
            "primary": self.primary,
            "accent": self.accent,
        })
    }
}

type Row = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
);

/// `TEAMS`, dans le même ordre.
pub const TEAMS: [Row; 30] = [
    (
        "ATL", "Atlanta", "Hawks", "Est", "Sud-Est", "#C8102E", "#FF4D5A",
    ),
    (
        "BOS",
        "Boston",
        "Celtics",
        "Est",
        "Atlantique",
        "#007A33",
        "#2FBF6B",
    ),
    (
        "BKN",
        "Brooklyn",
        "Nets",
        "Est",
        "Atlantique",
        "#111111",
        "#E8E8E8",
    ),
    (
        "CHA",
        "Charlotte",
        "Hornets",
        "Est",
        "Sud-Est",
        "#1D1160",
        "#21B3C6",
    ),
    (
        "CHI", "Chicago", "Bulls", "Est", "Centrale", "#CE1141", "#FF3D63",
    ),
    (
        "CLE",
        "Cleveland",
        "Cavaliers",
        "Est",
        "Centrale",
        "#860038",
        "#FDBB30",
    ),
    (
        "DET", "Detroit", "Pistons", "Est", "Centrale", "#C8102E", "#4F8CFF",
    ),
    (
        "IND", "Indiana", "Pacers", "Est", "Centrale", "#002D62", "#FDBB30",
    ),
    (
        "MIA", "Miami", "Heat", "Est", "Sud-Est", "#98002E", "#F9A01B",
    ),
    (
        "MIL",
        "Milwaukee",
        "Bucks",
        "Est",
        "Centrale",
        "#00471B",
        "#5FBF5A",
    ),
    (
        "NY",
        "New York",
        "Knicks",
        "Est",
        "Atlantique",
        "#006BB6",
        "#F58426",
    ),
    (
        "ORL", "Orlando", "Magic", "Est", "Sud-Est", "#0077C0", "#3DA9FF",
    ),
    (
        "PHI",
        "Philadelphie",
        "76ers",
        "Est",
        "Atlantique",
        "#006BB6",
        "#ED174C",
    ),
    (
        "TOR",
        "Toronto",
        "Raptors",
        "Est",
        "Atlantique",
        "#CE1141",
        "#FF3D63",
    ),
    (
        "WSH",
        "Washington",
        "Wizards",
        "Est",
        "Sud-Est",
        "#002B5C",
        "#E31837",
    ),
    (
        "DAL",
        "Dallas",
        "Mavericks",
        "Ouest",
        "Sud-Ouest",
        "#00538C",
        "#2E9BFF",
    ),
    (
        "DEN",
        "Denver",
        "Nuggets",
        "Ouest",
        "Nord-Ouest",
        "#0E2240",
        "#FEC524",
    ),
    (
        "GS",
        "Golden State",
        "Warriors",
        "Ouest",
        "Pacifique",
        "#1D428A",
        "#FFC72C",
    ),
    (
        "HOU",
        "Houston",
        "Rockets",
        "Ouest",
        "Sud-Ouest",
        "#CE1141",
        "#FF3D63",
    ),
    (
        "LAC",
        "Los Angeles",
        "Clippers",
        "Ouest",
        "Pacifique",
        "#C8102E",
        "#3D8BFF",
    ),
    (
        "LAL",
        "Los Angeles",
        "Lakers",
        "Ouest",
        "Pacifique",
        "#552583",
        "#FDB927",
    ),
    (
        "MEM",
        "Memphis",
        "Grizzlies",
        "Ouest",
        "Sud-Ouest",
        "#12173F",
        "#7D9BD6",
    ),
    (
        "MIN",
        "Minnesota",
        "Timberwolves",
        "Ouest",
        "Nord-Ouest",
        "#0C2340",
        "#78BE20",
    ),
    (
        "NO",
        "La Nouvelle-Orléans",
        "Pelicans",
        "Ouest",
        "Sud-Ouest",
        "#0C2340",
        "#C8A86B",
    ),
    (
        "OKC",
        "Oklahoma City",
        "Thunder",
        "Ouest",
        "Nord-Ouest",
        "#007AC1",
        "#EF5B3A",
    ),
    (
        "PHX",
        "Phoenix",
        "Suns",
        "Ouest",
        "Pacifique",
        "#1D1160",
        "#E56020",
    ),
    (
        "POR",
        "Portland",
        "Trail Blazers",
        "Ouest",
        "Nord-Ouest",
        "#E03A3E",
        "#FF5A5E",
    ),
    (
        "SA",
        "San Antonio",
        "Spurs",
        "Ouest",
        "Sud-Ouest",
        "#000000",
        "#C4CED4",
    ),
    (
        "SAC",
        "Sacramento",
        "Kings",
        "Ouest",
        "Pacifique",
        "#5A2D81",
        "#A974E6",
    ),
    (
        "UTAH",
        "Utah",
        "Jazz",
        "Ouest",
        "Nord-Ouest",
        "#3E2680",
        "#9B7BFF",
    ),
];

fn info(r: &Row) -> TeamInfo {
    TeamInfo {
        abbr: r.0.into(),
        city: r.1.into(),
        nick: r.2.into(),
        conference: r.3.into(),
        division: r.4.into(),
        primary: r.5.into(),
        accent: r.6.into(),
    }
}

/// Toutes les franchises, dans l'ordre de `TEAMS`.
pub fn all_teams() -> Vec<TeamInfo> {
    TEAMS.iter().map(info).collect()
}

fn find(abbr: &str) -> Option<&'static Row> {
    // `toUpperCase()` de JavaScript.
    let up = abbr.to_uppercase();
    TEAMS.iter().find(|r| r.0 == up)
}

/// `teamInfo` : équipe par abréviation ESPN ; repli neutre pour une équipe
/// inconnue (All-Star…).
pub fn team_info(abbr: &str) -> TeamInfo {
    match find(abbr) {
        Some(r) => info(r),
        None => {
            let up = abbr.to_uppercase();
            TeamInfo {
                abbr: up.clone(),
                city: String::new(),
                nick: up,
                conference: "Est".into(),
                division: String::new(),
                primary: "#3A3A44".into(),
                accent: "#B8B8C4".into(),
            }
        }
    }
}

/// `isNbaTeam`.
pub fn is_nba_team(abbr: &str) -> bool {
    find(abbr).is_some()
}

/// `teamLogoUrl`.
pub fn team_logo_url(abbr: &str) -> String {
    format!(
        "https://a.espncdn.com/i/teamlogos/nba/500/{}.png",
        abbr.to_lowercase()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referentiel_comme_teams_ts() {
        assert_eq!(TEAMS.len(), 30);
        let lal = team_info("lal");
        assert_eq!(lal.nick, "Lakers");
        assert_eq!(lal.conference, "Ouest");
        assert!(is_nba_team("utah") && is_nba_team("NY"));
        assert!(!is_nba_team("WEST") && !is_nba_team(""));
        let x = team_info("west");
        assert_eq!(
            (
                x.abbr.as_str(),
                x.nick.as_str(),
                x.city.as_str(),
                x.conference.as_str()
            ),
            ("WEST", "WEST", "", "Est")
        );
        assert_eq!(
            team_logo_url("UTAH"),
            "https://a.espncdn.com/i/teamlogos/nba/500/utah.png"
        );
        assert_eq!(
            serde_json::to_string(&team_info("BOS").to_json()).unwrap(),
            r##"{"abbr":"BOS","city":"Boston","nick":"Celtics","conference":"Est","division":"Atlantique","primary":"#007A33","accent":"#2FBF6B"}"##
        );
    }
}
