//! Noms des joueurs (équivalent de `rosterNames.ts`) : Whisper écorche
//! volontiers les noms propres (« Edie » pour Edey, « Kata » pour Queta…).
//! Avec l'effectif du match, on corrige ce qui est presque sûr AVANT la
//! traduction, et on donne la liste au LLM pour le reste.

use crate::js::{self, jsre};
use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

/// `foldName` : minuscules, sans accents ni ponctuation (`[a-z0-9]` seulement).
pub fn fold_name(s: &str) -> String {
    let no_marks: String = s
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    no_marks
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// `editDistance` : distance de Levenshtein (en unités UTF-16, comme
/// JavaScript), plafonnée à `max + 1`.
pub fn edit_distance(a: &str, b: &str, max: usize) -> usize {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        let mut row_min = i;
        for j in 1..=b.len() {
            let sub = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(sub);
            row_min = row_min.min(cur[j]);
        }
        if row_min > max {
            return max + 1;
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Mots anglais courants qui ressemblent à des noms : jamais « corrigés ».
const COMMON: &str = "the and they then them there their this that what when where with while will would could should shot shots ball balls game games team teams play plays good great nice what heat heart hard here have home back down over open free foul fouls line lines lead leads left right time times three point points just jump move moves made make makes take takes rebound board boards block blocks steal steals pass passes drive drives dunk dunks floor court coach bench quarter half third first second fourth final buzzer score scores clock basket bucket miss misses missed run runs hit hits went goes look looks kind call calls side wing post paint lane rim glass deep long short fast break tonight night season year years really still guard guards forward center big little most best well wow yeah okay";

fn is_common(w: &str) -> bool {
    COMMON.split(' ').any(|x| x == w)
}

/// Index de l'effectif du match.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RosterIndex {
    /// Nom de famille plié → orthographe exacte (ordre d'insertion).
    pub surnames: IndexMap<String, String>,
    /// Noms complets, pour le prompt de traduction.
    pub full: Vec<String>,
}

/// `rosterIndex` : noms complets et noms de famille (≥ 4 lettres), suffixes
/// (Jr., III…) ignorés.
pub fn roster_index<S: AsRef<str>>(names: &[S]) -> RosterIndex {
    let mut full: Vec<String> = Vec::new();
    for n in names {
        let t = js::trim(n.as_ref());
        if !t.is_empty() && !full.iter().any(|f| f == t) {
            full.push(t.to_string());
        }
    }
    let mut surnames = IndexMap::new();
    for n in &full {
        let parts: Vec<&str> = jsre!(r"\s+")
            .split(n)
            .filter(|p| !p.is_empty() && !jsre!(r"^(jr|sr|ii|iii|iv)\.?$", "i").is_match(p))
            .collect();
        if let Some(last) = parts.last() {
            let f = fold_name(last);
            if js::utf16_len(&f) >= 4 {
                surnames.insert(f, last.to_string());
            }
        }
    }
    RosterIndex { surnames, full }
}

/// Distance tolérée pour un mot de cette longueur.
fn tolerance(len: usize) -> usize {
    if len >= 8 {
        2
    } else if len >= 5 {
        1
    } else {
        0
    }
}

/// `nearestSurname` (tolérance par défaut selon la longueur du mot).
pub fn nearest_surname(word: &str, roster: &RosterIndex) -> Option<String> {
    nearest_surname_tol(word, roster, tolerance(js::utf16_len(&fold_name(word))))
}

/// `nearestSurname` avec une tolérance donnée.
pub fn nearest_surname_tol(word: &str, roster: &RosterIndex, tol: usize) -> Option<String> {
    let w = fold_name(word);
    if w.is_empty() || roster.surnames.contains_key(&w) {
        return roster.surnames.get(&w).cloned();
    }
    if tol == 0 || is_common(&w) {
        return None;
    }
    let mut best: Option<&String> = None;
    let mut best_d = tol + 1;
    let mut tie = false;
    for (k, exact) in &roster.surnames {
        if k.as_bytes().first() != w.as_bytes().first() && tol < 2 {
            continue;
        }
        let d = edit_distance(&w, k, tol);
        if d < best_d {
            best = Some(exact);
            best_d = d;
            tie = false;
        } else if d == best_d {
            tie = true;
        }
    }
    if best_d <= tol && !tie {
        best.cloned()
    } else {
        None
    }
}

/// `fixRosterNames` : corrige, dans une ligne anglaise, les mots à majuscule
/// presque identiques à un nom de famille de l'effectif ; possessif conservé.
pub fn fix_roster_names(text: &str, roster: &RosterIndex) -> String {
    if roster.surnames.is_empty() {
        return text.to_string();
    }
    jsre!(r"\b(\p{Lu}[\p{L}'’-]{2,})")
        .replace_all(text, |c: &regex::Captures| {
            let m = &c[0];
            let base = jsre!(r"['’]s$", "i").replace(m, "").into_owned();
            let suffix = &m[base.len()..];
            match nearest_surname(&base, roster) {
                Some(near) if near != base => format!("{near}{suffix}"),
                _ => m.to_string(),
            }
        })
        .into_owned()
}

/// `nameRendered` : un nom de la ligne anglaise (5 premières lettres pliées)
/// est-il rendu en français, tel quel ou corrigé vers un joueur proche ?
pub fn name_rendered(token5: &str, fr_folded: &str, roster: Option<&RosterIndex>) -> bool {
    if fr_folded.contains(token5) {
        return true;
    }
    let Some(roster) = roster else { return false };
    roster.surnames.keys().any(|k| {
        let k5 = js::slice_utf16(k, 5);
        fr_folded.contains(k5.as_str()) && edit_distance(token5, &k5, 3) <= 3
    })
}

#[cfg(test)]
mod tests {
    //! Cas de tests/roster-names.test.ts.
    use super::*;

    fn roster() -> RosterIndex {
        roster_index(&[
            "Zach Edey",
            "Ja Morant",
            "Jaren Jackson Jr.",
            "Neemias Queta",
            "Shaedon Sharpe",
            "Deni Avdija",
            "Jerami Grant",
            "Desmond Bane",
        ])
    }

    #[test]
    fn effectif_du_match() {
        let r = roster();
        let mut s: Vec<&str> = r.surnames.values().map(String::as_str).collect();
        s.sort();
        assert_eq!(
            s,
            ["Avdija", "Bane", "Edey", "Grant", "Jackson", "Morant", "Queta", "Sharpe"]
        );
        assert_eq!(edit_distance("edie", "edey", 3), 2);
        assert_eq!(edit_distance("morrant", "morant", 3), 1);
        assert_eq!(nearest_surname("Morrant", &r).as_deref(), Some("Morant"));
        assert_eq!(nearest_surname("Sharp", &r).as_deref(), Some("Sharpe"));
        assert_eq!(nearest_surname("Avdia", &r).as_deref(), Some("Avdija"));
        assert_eq!(nearest_surname("Grant", &r).as_deref(), Some("Grant"));
        assert_eq!(nearest_surname("Edie", &r), None);
        assert_eq!(nearest_surname("Kata", &r), None);
        assert_eq!(
            nearest_surname("Heart", &roster_index(&["Josh Hart"])),
            None
        );
    }

    #[test]
    fn dans_une_ligne() {
        let r = roster();
        assert_eq!(
            fix_roster_names("Morrant's floater, and Sharp with the rebound.", &r),
            "Morant's floater, and Sharpe with the rebound."
        );
        assert_eq!(
            fix_roster_names("Nice pass by Edie to Kata.", &r),
            "Nice pass by Edie to Kata."
        );
        assert_eq!(
            fix_roster_names("Morrant scores.", &roster_index::<&str>(&[])),
            "Morrant scores."
        );
        assert!(name_rendered("kata", " contre de queta", Some(&r)));
        assert!(!name_rendered("kata", " contre de queta", None));
    }
}
