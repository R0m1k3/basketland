//! Noms des joueurs (équivalent de `rosterNames.ts`) : Whisper écorche
//! volontiers les noms propres (« Edie » pour Edey, « Kata » pour Queta…).
//! Avec l'effectif du match, on corrige ce qui est presque sûr AVANT la
//! traduction, et on donne la liste au LLM pour le reste.
//!
//! Corrections, de la plus sûre à la moins sûre : nom composé coupé en deux
//! (« Gilgeous Alexander » → Gilgeous-Alexander), nom de famille à une ou deux
//! lettres près (« Morrant » → Morant), prénom à une lettre près (« Jaylin »
//! → Jalen, s'il est seul de son espèce), puis nom qui SONNE pareil
//! (« Edie » → Edey, « Kata » → Queta) — ce dernier seulement au milieu d'une
//! phrase, où la majuscule montre que Whisper a entendu un nom propre.

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

/// Surnoms d'équipes et villes NBA : des noms propres, jamais des joueurs.
const TEAMS: &str = "hawks celtics nets hornets bulls cavaliers cavs mavericks mavs nuggets pistons warriors dubs rockets pacers clippers clips lakers grizzlies grizz heat bucks timberwolves wolves pelicans pels knicks thunder magic sixers blazers kings spurs raptors jazz wizards suns atlanta boston brooklyn charlotte chicago cleveland dallas denver detroit golden state houston indiana angeles memphis miami milwaukee minnesota orleans york oklahoma orlando philadelphia philly phoenix portland sacramento antonio toronto utah washington";

fn is_common(w: &str) -> bool {
    COMMON.split(' ').any(|x| x == w) || TEAMS.split(' ').any(|x| x == w)
}

/// Noms de famille NBA qui sont aussi des mots anglais courants : en tête de
/// phrase, « Smart play » ou « Green light » ne désignent pas forcément le joueur.
const NAME_WORDS: &str = "green white brown black smart love rose young holiday battle hart banks bridges price wall walker king rivers house hill strong wells payne porter carter mann little ball";

/// Index de l'effectif du match.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RosterIndex {
    /// Nom de famille plié → orthographe exacte (ordre d'insertion).
    pub surnames: IndexMap<String, String>,
    /// Noms complets, pour le prompt de traduction.
    pub full: Vec<String>,
    /// Prénom plié (≥ 4 lettres) → orthographe exacte.
    pub firsts: IndexMap<String, String>,
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
    let mut firsts = IndexMap::new();
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
        if parts.len() >= 2 {
            let f = fold_name(parts[0]);
            if js::utf16_len(&f) >= 4 {
                firsts.entry(f).or_insert_with(|| parts[0].to_string());
            }
        }
    }
    RosterIndex {
        surnames,
        full,
        firsts,
    }
}

/// Clé phonétique d'un nom plié : premier son gardé, puis les consonnes
/// seules (voyelles, `h`, `w` et `y` muets), lettres doublées réduites ;
/// `ph` = `f`, `c`/`q`/`ck` = `k` (`s` devant e, i, y), `z` = `s`, `x` = `ks`.
/// « Edie » et « Edey » donnent `ed` ; « Kata » et « Queta », `kt`.
pub fn phonetic_key(folded: &str) -> String {
    let s = sound_spelling(folded);
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut last = '\0';
    for (i, &c) in chars.iter().enumerate() {
        let c = match c {
            'c' if matches!(chars.get(i + 1), Some('e' | 'i' | 'y')) => 's',
            'c' => 'k',
            other => other,
        };
        if i > 0 && matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y' | 'h' | 'w') {
            last = '\0';
            continue;
        }
        if c == last {
            continue;
        }
        out.push(c);
        last = c;
    }
    out
}

/// Graphies équivalentes à l'oreille ramenées à une seule (`ph` → `f`,
/// `qu` → `k`…) : « Queta » s'écrit alors `keta`, à une lettre de « Kata ».
fn sound_spelling(folded: &str) -> String {
    folded
        .replace("ph", "f")
        .replace("ck", "k")
        .replace("qu", "k")
        .replace('q', "k")
        .replace('x', "ks")
        .replace('z', "s")
}

/// Nom de l'effectif qui SONNE comme `word` (même clé phonétique, deux
/// lettres d'écart au plus), s'il est le seul ; mots courants et équipes exclus.
pub fn sounds_like(word: &str, roster: &RosterIndex) -> Option<String> {
    let w = fold_name(word);
    if js::utf16_len(&w) < 4 || is_common(&w) {
        return None;
    }
    let key = phonetic_key(&w);
    if key.len() < 2 {
        return None;
    }
    let ws = sound_spelling(&w);
    let mut found: Option<&String> = None;
    for (k, exact) in roster.surnames.iter().chain(roster.firsts.iter()) {
        if phonetic_key(k) != key || edit_distance(&ws, &sound_spelling(k), 2) > 2 {
            continue;
        }
        match found {
            Some(f) if f != exact => return None,
            _ => found = Some(exact),
        }
    }
    found.cloned()
}

/// Prénom de l'effectif à une lettre près (tolérance des noms de famille,
/// plafonnée à 1), s'il est le seul.
pub fn nearest_first(word: &str, roster: &RosterIndex) -> Option<String> {
    let w = fold_name(word);
    if let Some(exact) = roster.firsts.get(&w) {
        return Some(exact.clone());
    }
    let tol = tolerance(js::utf16_len(&w)).min(1);
    if tol == 0 || is_common(&w) {
        return None;
    }
    let mut found: Option<&String> = None;
    for (k, exact) in &roster.firsts {
        if k.as_bytes().first() != w.as_bytes().first() || edit_distance(&w, k, tol) > tol {
            continue;
        }
        match found {
            Some(f) if f != exact => return None,
            _ => found = Some(exact),
        }
    }
    found.cloned()
}

/// Joueurs de l'effectif nommés dans une ligne anglaise (orthographe
/// exacte) : chaque mot à majuscule égal à un nom de famille, même en tête de
/// phrase, sauf s'il est aussi un mot anglais courant (« Smart play »).
pub fn roster_names_in(en: &str, roster: &RosterIndex) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut prev_ends = true;
    for tok in jsre!(r"\s+").split(en).filter(|t| !t.is_empty()) {
        let first = prev_ends;
        prev_ends = jsre!(r#"[.!?…:"“]$"#).is_match(tok);
        let word = jsre!(r"^[^\p{L}]+|[^\p{L}'’-]+$").replace_all(tok, "");
        let word = jsre!(r"['’]s$", "i").replace(&word, "");
        if !jsre!(r"^\p{Lu}").is_match(&word) {
            continue;
        }
        let f = fold_name(&word);
        let Some(exact) = roster.surnames.get(&f) else {
            continue;
        };
        if first && (is_common(&f) || NAME_WORDS.split(' ').any(|x| x == f)) {
            continue;
        }
        if !out.contains(exact) {
            out.push(exact.clone());
        }
    }
    out
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
    let text = join_compound_names(text, roster);
    jsre!(r"\b(\p{Lu}[\p{L}'’-]{2,})")
        .replace_all(&text, |c: &regex::Captures| {
            let m = &c[0];
            let base = jsre!(r"['’]s$", "i").replace(m, "").into_owned();
            let suffix = &m[base.len()..];
            let at = c.get(0).map_or(0, |g| g.start());
            let near = nearest_surname(&base, roster)
                .or_else(|| nearest_first(&base, roster))
                .or_else(|| {
                    mid_sentence(&text, at)
                        .then(|| sounds_like(&base, roster))
                        .flatten()
                });
            match near {
                Some(near) if near != base => format!("{near}{suffix}"),
                _ => m.to_string(),
            }
        })
        .into_owned()
}

/// Le mot qui commence à l'octet `at` est-il au milieu d'une phrase ?
fn mid_sentence(text: &str, at: usize) -> bool {
    let before = js::trim(&text[..at]);
    !before.is_empty() && !jsre!(r#"[.!?…:"“]$"#).is_match(before)
}

/// Nom composé coupé en deux par Whisper (« Gilgeous Alexander »,
/// « Caldwell Pope ») : recollé avec l'orthographe de l'effectif.
fn join_compound_names(text: &str, roster: &RosterIndex) -> String {
    let compounds: Vec<&String> = roster
        .surnames
        .values()
        .filter(|v| v.contains('-'))
        .collect();
    if compounds.is_empty() {
        return text.to_string();
    }
    // Paires de mots à majuscule voisins (« Shai Gilgeous Alexander » : la
    // seconde paire compte, d'où la recherche mot par mot).
    let words: Vec<regex::Match> = jsre!(r"\p{Lu}[\p{L}'’]+").find_iter(text).collect();
    let mut out = String::new();
    let mut from = 0;
    let mut k = 0;
    while k + 1 < words.len() {
        let (a, b) = (words[k], words[k + 1]);
        let between = &text[a.end()..b.start()];
        let joined = fold_name(&format!("{}{}", a.as_str(), b.as_str()));
        let hit = (jsre!(r"^[\s-]+$").is_match(between) && a.start() >= from)
            .then(|| compounds.iter().find(|v| fold_name(v) == joined))
            .flatten();
        match hit {
            Some(v) => {
                out.push_str(&text[from..a.start()]);
                out.push_str(v);
                from = b.end();
                k += 2;
            }
            None => k += 1,
        }
    }
    out.push_str(&text[from..]);
    out
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
            fix_roster_names("Morrant scores.", &roster_index::<&str>(&[])),
            "Morrant scores."
        );
        assert!(name_rendered("kata", " contre de queta", Some(&r)));
        assert!(!name_rendered("kata", " contre de queta", None));
    }

    #[test]
    fn noms_qui_sonnent_pareil() {
        let r = roster();
        assert_eq!(phonetic_key("edie"), phonetic_key("edey"));
        assert_eq!(phonetic_key("kata"), phonetic_key("queta"));
        assert_eq!(sounds_like("Edie", &r).as_deref(), Some("Edey"));
        assert_eq!(sounds_like("Kata", &r).as_deref(), Some("Queta"));
        // Au milieu d'une phrase seulement : en tête, la majuscule ne dit rien.
        assert_eq!(
            fix_roster_names("Nice pass by Edie to Kata.", &r),
            "Nice pass by Edey to Queta."
        );
        assert_eq!(fix_roster_names("Kata. Edie.", &r), "Kata. Edie.");
        // Équipes et mots courants jamais « corrigés ».
        let r2 = roster_index(&[
            "Mikal Bridges",
            "Josh Hart",
            "Jalen Suggs",
            "Tyrese Haliburton",
        ]);
        assert_eq!(
            fix_roster_names("The Suns and the Heat, Heart of the Knicks.", &r2),
            "The Suns and the Heat, Heart of the Knicks."
        );
    }

    #[test]
    fn prenoms_et_noms_composes() {
        let r = roster_index(&[
            "Shai Gilgeous-Alexander",
            "Kentavious Caldwell-Pope",
            "Jalen Williams",
            "Chet Holmgren",
        ]);
        assert_eq!(
            fix_roster_names("Shai Gilgeous Alexander to Caldwell Pope.", &r),
            "Shai Gilgeous-Alexander to Caldwell-Pope."
        );
        assert_eq!(
            fix_roster_names("Great pass from Jaleen to Chet.", &r),
            "Great pass from Jalen to Chet."
        );
        assert_eq!(
            roster_names_in("Holmgren blocks it! Williams again.", &r),
            ["Holmgren", "Williams"]
        );
        let r2 = roster_index(&["Marcus Smart", "Draymond Green"]);
        assert!(roster_names_in("Smart play by the defense.", &r2).is_empty());
        assert_eq!(roster_names_in("What a pass, Smart!", &r2), ["Smart"]);
    }
}
