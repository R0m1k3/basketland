//! Tableau des scores par période (« linescore »), calculé depuis le
//! play-by-play (équivalent de `src/lib/linescore.ts`) : le score cumulé à la
//! dernière action de chaque période, puis la différence avec la période
//! précédente.

use crate::api::js_num_value;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Action réduite à ce qui sert au calcul (`LinescorePlay`).
#[derive(Debug, Clone, Copy)]
pub struct LinescorePlay {
    pub period: f64,
    pub home_score: Option<f64>,
    pub away_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinescorePeriod {
    pub period: i64,
    pub label: String,
    pub away: f64,
    pub home: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Linescore {
    pub periods: Vec<LinescorePeriod>,
    pub away: f64,
    pub home: f64,
}

impl Linescore {
    pub fn to_json(&self) -> Value {
        json!({
            "periods": self.periods.iter().map(|p| json!({
                "period": p.period,
                "label": p.label,
                "away": js_num_value(p.away),
                "home": js_num_value(p.home),
            })).collect::<Vec<_>>(),
            "away": js_num_value(self.away),
            "home": js_num_value(self.home),
        })
    }
}

/// `periodShortLabel` : « 1 » … « 4 », « P1 », « P2 »…
pub fn period_short_label(period: i64) -> String {
    if period <= 4 {
        period.to_string()
    } else {
        format!("P{}", period - 4)
    }
}

/// `periodName` : « Q1 » … « Q4 », « Prol. », « Prol. 2 ».
pub fn period_name(period: i64) -> String {
    if period <= 4 {
        format!("Q{period}")
    } else if period == 5 {
        "Prol.".into()
    } else {
        format!("Prol. {}", period - 4)
    }
}

/// `computeLinescore` : `None` si le play-by-play ne contient aucun score
/// exploitable. Les périodes sans action (trou de données) reprennent le
/// cumul précédent, soit 0 point.
pub fn compute_linescore(plays: &[LinescorePlay]) -> Option<Linescore> {
    let mut last_by_period: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
    for p in plays {
        // `Number.isInteger(p.period) && p.period >= 1`.
        if !(p.period.is_finite() && p.period.fract() == 0.0 && p.period >= 1.0) {
            continue;
        }
        let (Some(home), Some(away)) = (p.home_score, p.away_score) else {
            continue;
        };
        if !home.is_finite() || !away.is_finite() {
            continue;
        }
        // Les actions sont dans l'ordre chronologique : la dernière vue gagne.
        last_by_period.insert(p.period as i64, (home, away));
    }
    let last_played = *last_by_period.keys().next_back()?;
    let max_period = last_played.max(4);
    let mut periods = Vec::new();
    let mut prev = (0.0, 0.0);
    for period in 1..=max_period {
        let cum = last_by_period.get(&period).copied();
        // Période pas encore jouée (match en cours) : on s'arrête.
        if cum.is_none() && period > last_played {
            break;
        }
        let cur = cum.unwrap_or(prev);
        periods.push(LinescorePeriod {
            period,
            label: period_short_label(period),
            away: (cur.1 - prev.1).max(0.0),
            home: (cur.0 - prev.0).max(0.0),
        });
        prev = cur;
    }
    Some(Linescore {
        periods,
        away: prev.1,
        home: prev.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cas de tests/linescore.test.ts.
    fn p(period: f64, away: Option<f64>, home: Option<f64>) -> LinescorePlay {
        LinescorePlay {
            period,
            home_score: home,
            away_score: away,
        }
    }
    fn s(period: f64, away: f64, home: f64) -> LinescorePlay {
        p(period, Some(away), Some(home))
    }

    #[test]
    fn points_par_quart_depuis_le_score_cumule() {
        let ls = compute_linescore(&[
            s(1.0, 0.0, 0.0),
            s(1.0, 12.0, 10.0),
            s(1.0, 28.0, 25.0),
            s(2.0, 30.0, 25.0),
            s(2.0, 55.0, 50.0),
            s(3.0, 80.0, 77.0),
            s(4.0, 103.0, 87.0),
        ])
        .unwrap();
        let got: Vec<(f64, f64)> = ls.periods.iter().map(|x| (x.away, x.home)).collect();
        assert_eq!(
            got,
            [(28.0, 25.0), (27.0, 25.0), (25.0, 27.0), (23.0, 10.0)]
        );
        assert_eq!((ls.away, ls.home), (103.0, 87.0));
    }

    #[test]
    fn prolongations_et_scores_nuls_ignores() {
        let ls = compute_linescore(&[
            s(1.0, 20.0, 20.0),
            s(2.0, 50.0, 50.0),
            p(3.0, None, None),
            s(3.0, 75.0, 75.0),
            s(4.0, 100.0, 100.0),
            s(5.0, 112.0, 110.0),
        ])
        .unwrap();
        let labels: Vec<&str> = ls.periods.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(labels, ["1", "2", "3", "4", "P1"]);
        assert_eq!((ls.periods[4].away, ls.periods[4].home), (12.0, 10.0));
    }

    #[test]
    fn arret_a_la_derniere_periode_jouee() {
        let ls = compute_linescore(&[s(1.0, 20.0, 18.0), s(2.0, 40.0, 41.0)]).unwrap();
        assert_eq!(ls.periods.len(), 2);
    }

    #[test]
    fn trou_de_donnees_et_periodes_invalides() {
        // Q2 sans action : 0 point, cumul repris.
        let ls = compute_linescore(&[
            s(1.0, 20.0, 18.0),
            s(3.0, 60.0, 50.0),
            s(0.0, 99.0, 99.0),
            s(1.5, 1.0, 1.0),
        ])
        .unwrap();
        let got: Vec<(i64, f64, f64)> = ls
            .periods
            .iter()
            .map(|x| (x.period, x.away, x.home))
            .collect();
        assert_eq!(got, [(1, 20.0, 18.0), (2, 0.0, 0.0), (3, 40.0, 32.0)]);
        assert_eq!(
            serde_json::to_string(&ls.to_json()).unwrap(),
            r#"{"periods":[{"period":1,"label":"1","away":20,"home":18},{"period":2,"label":"2","away":0,"home":0},{"period":3,"label":"3","away":40,"home":32}],"away":60,"home":50}"#
        );
    }

    #[test]
    fn sans_score() {
        assert!(compute_linescore(&[]).is_none());
        assert!(compute_linescore(&[p(1.0, None, None)]).is_none());
    }

    #[test]
    fn libelles_de_periode() {
        assert_eq!(period_short_label(3), "3");
        assert_eq!(period_short_label(6), "P2");
        assert_eq!(period_name(4), "Q4");
        assert_eq!(period_name(5), "Prol.");
        assert_eq!(period_name(6), "Prol. 2");
    }
}
