//! API ESPN (équivalent des parties de `src/lib/espn.ts` déjà portées).

use crate::api::{js_num_value, js_number};
use crate::jsval::{js_string, or_else};
use serde_json::{json, Map, Value};

pub const ESPN_V2: &str = "https://site.api.espn.com/apis/v2/sports/basketball";

fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(x) => js_string(x),
    }
}

/// `parseStandings` : conférences et classement, triés par tête de série puis victoires.
pub fn parse_standings(json: &Value) -> Value {
    let mut out = Vec::new();
    let empty = Vec::new();
    for conf in json
        .get("children")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        let name = str_of(conf.get("name"))
            .replacen("Eastern Conference", "Conférence Est", 1)
            .replacen("Western Conference", "Conférence Ouest", 1);
        let entries = conf
            .get("standings")
            .and_then(|s| s.get("entries"))
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let mut rows: Vec<(f64, f64, Value)> = entries
            .iter()
            .map(|e| {
                let stats = e.get("stats").and_then(Value::as_array).unwrap_or(&empty);
                // s[name ?? type] = String(displayValue ?? value ?? '') ; byType[type] = String(displayValue ?? '')
                let mut s: Map<String, Value> = Map::new();
                let mut by_type: Map<String, Value> = Map::new();
                for st in stats {
                    // String(undefined) = "undefined", String(null) = "null".
                    let key = match or_else(st.get("name"), st.get("type")) {
                        None => "undefined".to_string(),
                        Some(v) => js_string(v),
                    };
                    let val = str_of(or_else(st.get("displayValue"), st.get("value")));
                    s.insert(key, Value::from(val));
                }
                for st in stats {
                    if let Some(t) = st.get("type").filter(|t| !t.is_null() && js_truthy(t)) {
                        by_type.insert(js_string(t), Value::from(str_of(st.get("displayValue"))));
                    }
                }
                let sget = |k: &str| s.get(k).and_then(Value::as_str).map(str::to_string);
                let bget = |k: &str| by_type.get(k).and_then(Value::as_str).map(str::to_string);
                let num = |k: &str| sget(k).map(|v| js_number(&v)).unwrap_or(0.0);
                let wins = num("wins");
                let seed = num("playoffSeed");
                let team = e.get("team");
                let row = json!({
                    "conference": name,
                    "abbr": str_of(team.and_then(|t| t.get("abbreviation"))),
                    "name": str_of(team.and_then(|t| t.get("displayName"))),
                    "wins": js_num_value(wins),
                    "losses": js_num_value(num("losses")),
                    "pct": sget("winPercent").unwrap_or_default(),
                    "gb": sget("gamesBehind").unwrap_or_default(),
                    "streak": sget("streak").unwrap_or_default(),
                    "home": sget("Home").or_else(|| bget("home")).unwrap_or_default(),
                    "road": sget("Road").or_else(|| bget("road")).unwrap_or_default(),
                    "last10": sget("Last Ten Games").or_else(|| bget("lasttengames")).unwrap_or_default(),
                    "seed": js_num_value(seed),
                    "diff": sget("differential").unwrap_or_default(),
                });
                (seed, wins, row)
            })
            .collect();
        // (a.seed || 99) - (b.seed || 99) || b.wins - a.wins ; tri stable (NaN de victoires compté 0).
        let or99 = |x: f64| if x == 0.0 || x.is_nan() { 99.0 } else { x };
        let w = |x: f64| if x.is_nan() { 0.0 } else { x };
        rows.sort_by(|a, b| {
            or99(a.0)
                .total_cmp(&or99(b.0))
                .then_with(|| w(b.1).total_cmp(&w(a.1)))
        });
        out.push(json!({ "conference": name, "rows": rows.into_iter().map(|r| r.2).collect::<Vec<_>>() }));
    }
    Value::Array(out)
}

/// Valeur « vraie » au sens de JavaScript.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub async fn fetch_standings(league: &str) -> Result<Value, String> {
    let json = crate::http::fetch_json(&format!("{ESPN_V2}/{league}/standings")).await?;
    Ok(parse_standings(&json))
}

#[cfg(test)]
mod tests {
    // Réponse ESPN réelle et sortie de `parseStandings` (Node) sur cette réponse.
    #[test]
    fn classement_comme_node() {
        let raw = include_str!("../tests/fixtures/espn-standings.json");
        let expected = include_str!("../tests/fixtures/espn-standings.expected.json");
        let got = super::parse_standings(&crate::jsval::js_parse(raw).unwrap());
        assert_eq!(serde_json::to_string(&got).unwrap(), expected);
    }
}
