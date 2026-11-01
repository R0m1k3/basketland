//! NBA Cup (tournoi de début de saison) : repérage des matchs par les notes
//! ESPN (colonne `competition`), et données de l'onglet « NBA Cup »
//! (`GET /api/pages/nba-cup`) : groupes et leurs classements, phase finale
//! (quarts, demies, finale), matchs à venir et résultats.
//!
//! Tout est calculé pour la saison la plus récente en base : l'onglet repart
//! de zéro à chaque nouvelle saison.
//!
//! ESPN ne donne pas la lettre des groupes : ils sont reconstitués à partir
//! des rencontres de la phase de groupes (chaque équipe n'y affronte que les
//! quatre autres équipes de son groupe : un groupe est donc une composante
//! connexe du graphe des rencontres).

use crate::db::match_row;
use crate::pages::PageCtx;
use crate::queries as q;
use crate::teams;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Phase d'un match de NBA Cup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Round {
    Group,
    Quarter,
    Semi,
    Final,
}

impl Round {
    pub fn key(self) -> &'static str {
        match self {
            Round::Group => "group",
            Round::Quarter => "quarter",
            Round::Semi => "semi",
            Round::Final => "final",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Round::Group => "Phase de groupes",
            Round::Quarter => "Quart de finale",
            Round::Semi => "Demi-finale",
            Round::Final => "Finale",
        }
    }
}

/// Phase de NBA Cup d'après les notes ESPN (« NBA Cup - Group Play »,
/// « NBA Cup - Quarterfinals », « NBA Cup - Semifinals », « NBA Cup
/// Championship » ; « In-Season Tournament » les premières saisons).
pub fn round_of(note: &str) -> Option<Round> {
    let n = note.to_ascii_lowercase();
    if !(n.contains("nba cup") || n.contains("in-season tournament")) {
        return None;
    }
    Some(if n.contains("quarterfinal") {
        Round::Quarter
    } else if n.contains("semifinal") {
        Round::Semi
    } else if n.contains("championship") || n.contains("final") {
        Round::Final
    } else {
        Round::Group
    })
}

/// Champ `cup` d'un match (`None` hors NBA Cup).
pub fn cup_json(note: &str) -> Option<Value> {
    round_of(note).map(|r| json!({ "round": r.key(), "label": r.label() }))
}

/// Condition SQL des matchs de NBA Cup (sur `competition`).
const CUP_SQL: &str = "(competition LIKE '%NBA Cup%' OR competition LIKE '%In-Season Tournament%')";

/// Ligne d'un classement de groupe.
#[derive(Debug, Clone, Default)]
struct Line {
    abbr: String,
    wins: i64,
    losses: i64,
    pf: i64,
    pa: i64,
}

impl Line {
    fn diff(&self) -> i64 {
        self.pf - self.pa
    }
}

fn score(g: &Value, side: &str) -> Option<i64> {
    g[side]["score"].as_f64().map(|f| f as i64)
}

fn abbr(g: &Value, side: &str) -> String {
    g[side]["abbr"].as_str().unwrap_or("").to_string()
}

/// Composantes connexes des équipes de la phase de groupes.
fn groups_of(games: &[&Value]) -> Vec<BTreeSet<String>> {
    let mut parent: BTreeMap<String, String> = BTreeMap::new();
    fn find(p: &mut BTreeMap<String, String>, x: &str) -> String {
        let up = p.get(x).cloned().unwrap_or_else(|| x.to_string());
        if up == x {
            return up;
        }
        let root = find(p, &up);
        p.insert(x.to_string(), root.clone());
        root
    }
    for g in games {
        let (a, h) = (abbr(g, "away"), abbr(g, "home"));
        if a.is_empty() || h.is_empty() {
            continue;
        }
        parent.entry(a.clone()).or_insert_with(|| a.clone());
        parent.entry(h.clone()).or_insert_with(|| h.clone());
        let (ra, rh) = (find(&mut parent, &a), find(&mut parent, &h));
        if ra != rh {
            parent.insert(ra, rh);
        }
    }
    let keys: Vec<String> = parent.keys().cloned().collect();
    let mut by_root: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for k in keys {
        let r = find(&mut parent, &k);
        by_root.entry(r).or_default().insert(k);
    }
    by_root.into_values().collect()
}

/// Classement d'un groupe : victoires, puis différence de points, puis
/// points marqués (départage simplifié de la NBA).
fn standings(teams_in: &BTreeSet<String>, games: &[&Value]) -> Vec<Line> {
    let mut lines: BTreeMap<String, Line> = teams_in
        .iter()
        .map(|t| {
            (
                t.clone(),
                Line {
                    abbr: t.clone(),
                    ..Default::default()
                },
            )
        })
        .collect();
    for g in games.iter().filter(|g| g["status"] == "final") {
        let (a, h) = (abbr(g, "away"), abbr(g, "home"));
        let (Some(sa), Some(sh)) = (score(g, "away"), score(g, "home")) else {
            continue;
        };
        if !teams_in.contains(&a) || !teams_in.contains(&h) {
            continue;
        }
        for (me, mine, theirs) in [(&a, sa, sh), (&h, sh, sa)] {
            if let Some(l) = lines.get_mut(me) {
                l.pf += mine;
                l.pa += theirs;
                if mine > theirs {
                    l.wins += 1;
                } else {
                    l.losses += 1;
                }
            }
        }
    }
    let mut v: Vec<Line> = lines.into_values().collect();
    v.sort_by(|x, y| {
        y.wins
            .cmp(&x.wins)
            .then(y.diff().cmp(&x.diff()))
            .then(y.pf.cmp(&x.pf))
            .then(x.abbr.cmp(&y.abbr))
    });
    v
}

/// Matchs de NBA Cup de la saison, du plus ancien au plus récent.
fn cup_games(c: &Connection, season: i64, running: Option<i64>) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare(&format!(
        "SELECT * FROM matches WHERE league = 'nba' AND season = ?1 AND {CUP_SQL} ORDER BY date_utc ASC, id ASC"
    ))?;
    let rows: Vec<_> = st
        .query_map([season], match_row)?
        .collect::<rusqlite::Result<_>>()?;
    q::to_views(c, &rows, running)
}

fn round_key(g: &Value) -> &str {
    g["cup"]["round"].as_str().unwrap_or("")
}

/// Cases d'un tour de la phase finale : les matchs connus, puis des cases
/// vides (`null`) jusqu'à `slots`.
fn slots(games: &[&Value], slots: usize) -> Vec<Value> {
    let mut out: Vec<Value> = games.iter().map(|g| (*g).clone()).collect();
    while out.len() < slots {
        out.push(Value::Null);
    }
    out
}

/// `GET /api/pages/nba-cup`.
pub fn page(c: &Connection, ctx: &PageCtx) -> rusqlite::Result<Value> {
    let running = ctx.media.running_match_id;
    let season = q::latest_season(c)?;
    let games = match season {
        Some(s) => cup_games(c, s, running)?,
        None => Vec::new(),
    };
    let of =
        |r: Round| -> Vec<&Value> { games.iter().filter(|g| round_key(g) == r.key()).collect() };
    let group_games = of(Round::Group);
    let quarters = of(Round::Quarter);
    let semis = of(Round::Semi);
    let finals = of(Round::Final);

    // Qualifiés : les équipes des quarts dès qu'ils sont connus ; sinon,
    // phase de groupes d'une conférence terminée : premiers de groupe et
    // meilleur deuxième.
    let in_quarters: BTreeSet<String> = quarters
        .iter()
        .flat_map(|g| [abbr(g, "away"), abbr(g, "home")])
        .filter(|a| teams::is_nba_team(a))
        .collect();

    let mut confs: Vec<Value> = Vec::new();
    for conf in ["Est", "Ouest"] {
        let comps: Vec<BTreeSet<String>> = groups_of(&group_games)
            .into_iter()
            .filter(|g| {
                g.iter()
                    .next()
                    .is_some_and(|t| teams::team_info(t).conference == conf)
            })
            .collect();
        let conf_games: Vec<&Value> = group_games
            .iter()
            .copied()
            .filter(|g| teams::team_info(&abbr(g, "home")).conference == conf)
            .collect();
        let complete = !conf_games.is_empty() && conf_games.iter().all(|g| g["status"] == "final");
        let tables: Vec<(Vec<Line>, usize, usize)> = comps
            .iter()
            .map(|t| {
                let gg: Vec<&Value> = conf_games
                    .iter()
                    .copied()
                    .filter(|g| t.contains(&abbr(g, "home")))
                    .collect();
                let played = gg.iter().filter(|g| g["status"] == "final").count();
                (standings(t, &gg), played, gg.len())
            })
            .collect();
        // Meilleur deuxième de la conférence (repêché).
        let wildcard: Option<String> = if complete && in_quarters.is_empty() {
            let mut seconds: Vec<&Line> = tables.iter().filter_map(|(l, _, _)| l.get(1)).collect();
            seconds.sort_by(|x, y| {
                y.wins
                    .cmp(&x.wins)
                    .then(y.diff().cmp(&x.diff()))
                    .then(y.pf.cmp(&x.pf))
            });
            seconds.first().map(|l| l.abbr.clone())
        } else {
            None
        };
        let groups: Vec<Value> = tables
            .iter()
            .enumerate()
            .map(|(i, (lines, played, total))| {
                let rows: Vec<Value> = lines
                    .iter()
                    .enumerate()
                    .map(|(rank, l)| {
                        let qualified = if !in_quarters.is_empty() {
                            in_quarters.contains(&l.abbr)
                        } else {
                            complete && (rank == 0 || wildcard.as_deref() == Some(&l.abbr))
                        };
                        json!({
                            "abbr": l.abbr,
                            "wins": l.wins,
                            "losses": l.losses,
                            "pf": l.pf,
                            "pa": l.pa,
                            "diff": l.diff(),
                            "qualified": qualified,
                        })
                    })
                    .collect();
                json!({
                    "name": format!("Groupe {}", i + 1),
                    "played": played,
                    "total": total,
                    "rows": rows,
                })
            })
            .collect();
        confs.push(json!({ "conference": conf, "complete": complete, "groups": groups }));
    }

    let upcoming: Vec<&Value> = games.iter().filter(|g| g["status"] != "final").collect();
    let mut results: Vec<&Value> = games.iter().filter(|g| g["status"] == "final").collect();
    results.reverse();
    let champion = finals.first().and_then(|g| {
        let (Some(a), Some(h)) = (score(g, "away"), score(g, "home")) else {
            return None;
        };
        (g["status"] == "final").then(|| {
            if a > h {
                abbr(g, "away")
            } else {
                abbr(g, "home")
            }
        })
    });

    Ok(json!({
        "spoilers": ctx.spoilers,
        "today": q::today_key(ctx.now),
        "season": season,
        "total": games.len(),
        "conferences": confs,
        "bracket": {
            "quarter": slots(&quarters, 4),
            "semi": slots(&semis, 2),
            "final": slots(&finals, 1),
        },
        "champion": champion,
        "upcoming": upcoming,
        "results": results,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_d_apres_les_notes() {
        assert_eq!(round_of("NBA Cup - Group Play"), Some(Round::Group));
        assert_eq!(round_of("NBA Cup - Quarterfinals"), Some(Round::Quarter));
        assert_eq!(round_of("NBA Cup - Semifinals"), Some(Round::Semi));
        assert_eq!(round_of("NBA Cup Championship"), Some(Round::Final));
        assert_eq!(
            round_of("In-Season Tournament - East Group A"),
            Some(Round::Group)
        );
        assert_eq!(round_of("NBA Mexico City Game 2025"), None);
        assert_eq!(round_of(""), None);
    }

    fn game(away: &str, home: &str, sa: Option<i64>, sh: Option<i64>) -> Value {
        json!({
            "status": if sa.is_some() { "final" } else { "scheduled" },
            "away": { "abbr": away, "score": sa },
            "home": { "abbr": home, "score": sh },
        })
    }

    #[test]
    fn groupes_reconstitues_et_classes() {
        let g = [
            game("BOS", "NY", Some(100), Some(90)),
            game("NY", "PHI", Some(110), Some(100)),
            game("MIA", "ORL", None, None),
            game("ORL", "ATL", Some(95), Some(99)),
        ];
        let refs: Vec<&Value> = g.iter().collect();
        let groups = groups_of(&refs);
        assert_eq!(groups.len(), 2);
        let bos = groups.iter().find(|s| s.contains("BOS")).unwrap();
        assert_eq!(
            bos.iter().cloned().collect::<Vec<_>>(),
            ["BOS", "NY", "PHI"]
        );
        let table = standings(bos, &refs);
        assert_eq!(table[0].abbr, "BOS");
        assert_eq!(
            (
                table[1].abbr.as_str(),
                table[1].wins,
                table[1].losses,
                table[1].diff()
            ),
            ("NY", 1, 1, 0)
        );
        assert_eq!(table[2].abbr, "PHI");
    }
}
