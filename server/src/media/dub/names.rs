//! Prononciation des noms dans le doublage : une voix française lit
//! « Jalen », « Shai » ou « Curry » à la française (« Jalène », « Chè »,
//! « Curé »). Avant la synthèse, chaque nom connu est remplacé par une
//! orthographe que la voix prononce comme un commentateur français.
//!
//! Entièrement automatique : à chaque doublage, les joueurs et entraîneurs
//! des deux équipes (effectifs complets d'ESPN et feuille de stats) dont la
//! prononciation n'est pas encore connue sont demandés au modèle de
//! traduction, puis gardés dans une MÉMOIRE commune à tous les matchs
//! (`kv_cache`, clé [`AUTO_KEY`]) : une équipe déjà vue ne coûte plus rien.
//!
//! Seul le texte DIT change : les sous-titres gardent la vraie orthographe.

use crate::js;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// Clé `kv_cache` des orthographes phonétiques déjà demandées (nom → prononciation).
pub const AUTO_KEY: &str = "dub-name-spellings";

/// Noms demandés au plus par requête au modèle.
pub const SPELL_BATCH: usize = 40;

/// Suffixes et mots qui ne se prononcent pas autrement.
const SKIP: [&str; 8] = ["jr", "sr", "ii", "iii", "iv", "v", "de", "la"];

/// Mots des noms complets (prénoms, noms), sans doublon ni suffixe (« Jr. »).
pub fn name_words<S: AsRef<str>>(names: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        for w in n.as_ref().split_whitespace() {
            let w = w.trim_matches(|c: char| !c.is_alphanumeric());
            if w.chars().count() < 2 || SKIP.contains(&w.to_lowercase().as_str()) {
                continue;
            }
            if !out.iter().any(|o| o.to_lowercase() == w.to_lowercase()) {
                out.push(w.to_string());
            }
        }
    }
    out
}

/// Remplacements à appliquer au texte dit.
#[derive(Debug, Clone, Default)]
pub struct Pronunciations {
    re: Option<Regex>,
    say: HashMap<String, String>,
}

impl Pronunciations {
    /// Les noms les plus longs d'abord (« Gilgeous-Alexander » avant
    /// « Alexander ») ; une entrée identique au nom est ignorée.
    pub fn new(entries: &[(String, String)]) -> Pronunciations {
        let mut say: HashMap<String, String> = HashMap::new();
        let mut names: Vec<String> = Vec::new();
        for (n, s) in entries {
            let k = n.to_lowercase();
            if say.contains_key(&k) || js::trim(s).is_empty() || s.to_lowercase() == k {
                continue;
            }
            say.insert(k, s.clone());
            names.push(n.clone());
        }
        if names.is_empty() {
            return Pronunciations::default();
        }
        names.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then(a.cmp(b)));
        let alt: Vec<String> = names.iter().map(|n| regex::escape(n)).collect();
        let re = Regex::new(&format!(
            r"(?i)(^|[^\p{{L}}\p{{N}}])({})($|[^\p{{L}}\p{{N}}])",
            alt.join("|")
        ))
        .ok();
        Pronunciations { re, say }
    }

    pub fn is_empty(&self) -> bool {
        self.say.is_empty()
    }

    /// Texte à dire : chaque nom connu remplacé par sa prononciation (en une passe).
    pub fn apply(&self, text: &str) -> String {
        let Some(re) = &self.re else {
            return text.to_string();
        };
        // Deux noms collés (« Jalen Williams Curry ») partagent le séparateur :
        // on reprend la recherche juste après le nom remplacé.
        let mut out = String::with_capacity(text.len() + 16);
        let mut at = 0;
        while at <= text.len() {
            let Some(c) = re.captures_at(text, at) else {
                break;
            };
            let (pre, name) = (c.get(1).unwrap(), c.get(2).unwrap());
            out.push_str(&text[at..pre.end()]);
            match self.say.get(&name.as_str().to_lowercase()) {
                Some(s) => out.push_str(s),
                None => out.push_str(name.as_str()),
            }
            at = name.end();
        }
        out.push_str(&text[at.min(text.len())..]);
        out
    }
}

/// Consigne donnée au modèle de traduction pour les orthographes phonétiques.
pub const SPELL_PROMPT: &str = "Tu prépares le texte lu par une voix de synthèse FRANÇAISE qui double un commentateur de basket NBA. Lue telle quelle, l'orthographe anglaise d'un nom est prononcée à la française, ce qui sonne faux (« Jalen » lu « Jalène », « Shai » lu « Chè », « Curry » lu « Curé »). Pour chaque nom de la liste (prénom ou nom de famille de joueurs et d'entraîneurs NBA), écris une orthographe française phonétique qui, lue par une voix française, donne la prononciation qu'emploient les commentateurs français à la télé (en général la prononciation américaine). Exemples : Jalen → Djaleune ; Shai → Chaï ; Curry → Keuri ; LeBron → Leubronne ; Giannis → Yannisse ; Joel → Djoël ; Tatum → Téïteum ; Brown → Braoune ; Morant → Moranntt ; Wembanyama → Wembanyama ; Nikola → Nikola. Si le nom se lit déjà correctement en français, recopie-le tel quel. Un seul mot par nom quand c'est possible, sans tiret de syllabe, sans alphabet phonétique. Réponds uniquement avec ce JSON : {\"n\":{\"<nom>\":\"<orthographe>\"}}";

/// Message de la requête : la liste des noms.
pub fn spell_message(words: &[String]) -> String {
    format!(
        "Noms : {}\nRéponds uniquement avec le JSON demandé.",
        Value::from(words.to_vec())
    )
}

/// Réponse du modèle → (nom, orthographe) pour les noms demandés seulement.
pub fn parse_spellings(content: &str, asked: &[String]) -> Vec<(String, String)> {
    let re = Regex::new(r"(?s)<think>.*?</think>").unwrap();
    let s = re.replace_all(content, "");
    let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) else {
        return Vec::new();
    };
    if b <= a {
        return Vec::new();
    }
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&s[a..=b]) else {
        return Vec::new();
    };
    let map: Map<String, Value> = match o.get("n") {
        Some(Value::Object(m)) => m.clone(),
        _ => o,
    };
    let mut out = Vec::new();
    for w in asked {
        let found = map
            .iter()
            .find(|(k, _)| k.to_lowercase() == w.to_lowercase())
            .and_then(|(_, v)| v.as_str())
            .map(|v| js::trim(v).to_string());
        if let Some(v) = found {
            // Garde-fou : une « orthographe » qui n'est pas un nom (phrase, symbole) est ignorée.
            let ok = !v.is_empty()
                && v.chars().count() <= 40
                && v.split_whitespace().count() <= 3
                && v.chars().all(|c| c.is_alphabetic() || " -'’".contains(c));
            if ok {
                out.push((w.clone(), v));
            }
        }
    }
    out
}

/// Cache des orthographes (JSON `{ nom: orthographe }`) → liste.
pub fn cache_entries(v: Option<&Value>) -> Vec<(String, String)> {
    match v {
        Some(Value::Object(m)) => m
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &str, b: &str) -> (String, String) {
        (a.into(), b.into())
    }

    #[test]
    fn mots_des_noms() {
        let names = [
            "Jaren Jackson Jr.",
            "Shai Gilgeous-Alexander",
            "Jalen Williams",
            "Jaylin Williams",
        ];
        assert_eq!(
            name_words(&names),
            [
                "Jaren",
                "Jackson",
                "Shai",
                "Gilgeous-Alexander",
                "Jalen",
                "Williams",
                "Jaylin"
            ]
        );
    }

    #[test]
    fn noms_remplaces_dans_le_texte_dit() {
        let say = Pronunciations::new(&[
            p("Jalen", "Djaleune"),
            p("Williams", "Ouilliamz"),
            p("Shai", "Chaï"),
            p("Gilgeous-Alexander", "Guilgeuss-Alexandeur"),
            p("Alexander", "Alexandeur"),
            p("Curry", "Keuri"),
            p("Nikola", "Nikola"),
        ]);
        assert_eq!(
            say.apply("Shai Gilgeous-Alexander pour Jalen Williams, dedans ! jalen encore, Curry-Shai."),
            "Chaï Guilgeuss-Alexandeur pour Djaleune Ouilliamz, dedans ! Djaleune encore, Keuri-Chaï."
        );
        // Un nom à l'intérieur d'un autre mot n'est pas touché.
        assert_eq!(say.apply("Shaine et Currys"), "Shaine et Currys");
        assert!(Pronunciations::new(&[p("Nikola", "nikola")]).is_empty());
    }

    #[test]
    fn reponse_du_modele() {
        let asked = vec!["Jalen".to_string(), "Shai".to_string(), "Curry".to_string()];
        let r = parse_spellings(
            "<think>…</think>```json\n{\"n\":{\"jalen\":\"Djaleune\",\"Shai\":\"Chaï\",\"Curry\":\"C'est un joueur des Warriors, il se prononce Keuri.\",\"Autre\":\"X\"}}\n```",
            &asked,
        );
        assert_eq!(r, [p("Jalen", "Djaleune"), p("Shai", "Chaï")]);
        assert!(parse_spellings("rien", &asked).is_empty());
    }
}
