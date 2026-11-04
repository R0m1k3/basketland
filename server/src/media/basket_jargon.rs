//! Jargon du basket que les commentateurs français gardent en anglais
//! (« close-out », « pick-and-roll », « step-back »…).
//!
//! Deux usages :
//! - [`jargon_in`] repère ces termes dans une ligne anglaise : ils sont
//!   rappelés au traducteur avec la ligne (`"jargon"` dans la requête), pour
//!   qu'il les recopie au lieu de les traduire mot à mot (« écran et
//!   roulement », « fermeture »…) ;
//! - [`strip_jargon`] les retire d'une traduction avant de chercher l'anglais
//!   resté : « pick and roll » n'est pas une phrase restée en anglais, même
//!   avec son « and ».

use crate::js::jsre;
use regex::Regex;
use std::sync::OnceLock;

/// Un terme : sa forme d'usage en français, et les formes anglaises qui le
/// désignent (expressions régulières, insensibles à la casse ; `SEP` entre
/// les mots : espace, tiret ou rien).
struct Term {
    fr: &'static str,
    en: &'static [&'static str],
}

/// Séparateur entre les mots d'un terme : « pick and roll », « pick-and-roll »,
/// « pick n roll », « closeout ».
const SEP: &str = r"[\s\-‐]*";

/// Termes gardés en anglais par les commentateurs français. Le sens ne
/// change jamais : un terme n'est rappelé que pour une forme sans ambiguïté
/// (« close out the game » = plier le match, pas un close-out).
const TERMS: &[Term] = &[
    Term {
        fr: "pick-and-roll",
        en: &[r"pick_(?:and|n|&)_rolls?", r"p_&_r"],
    },
    Term {
        fr: "pick-and-pop",
        en: &[r"pick_(?:and|n|&)_pops?"],
    },
    Term {
        fr: "close-out",
        en: &[
            r"closeouts?",
            r"close-outs?",
            r"(?:the|a|hard|bad|late|long|great|good|short) close_outs?",
        ],
    },
    Term {
        fr: "step-back",
        en: &[r"step_backs?", r"stepped_back three", r"steps_back"],
    },
    Term {
        fr: "crossover",
        en: &[r"cross_overs?", r"crossed (?:him|her) over"],
    },
    Term {
        fr: "alley-oop",
        en: &[r"alley_oops?"],
    },
    Term {
        fr: "catch-and-shoot",
        en: &[r"catch_(?:and|n)_shoot"],
    },
    Term {
        fr: "give-and-go",
        en: &[r"give_(?:and|n)_go"],
    },
    Term {
        fr: "pull-up",
        en: &[r"pull_ups?", r"pulls_up", r"pulled_up", r"pulling_up"],
    },
    Term {
        fr: "fadeaway",
        en: &[r"fade_aways?", r"fades away"],
    },
    Term {
        fr: "floater",
        en: &[r"floaters?", r"floats? (?:it|one) up"],
    },
    Term {
        fr: "euro step",
        en: &[r"euro_steps?"],
    },
    Term {
        fr: "spin move",
        en: &[r"spin_moves?"],
    },
    Term {
        fr: "hesitation",
        en: &[r"hesitation dribble", r"hesi"],
    },
    Term {
        fr: "no-look",
        en: &[r"no_look"],
    },
    Term {
        fr: "backdoor",
        en: &[r"back_door"],
    },
    Term {
        fr: "and-one",
        en: &[r"and_one", r"and_1"],
    },
    Term {
        fr: "buzzer-beater",
        en: &[r"buzzer_beaters?"],
    },
    Term {
        fr: "game-winner",
        en: &[r"game_winners?", r"game_winning shot"],
    },
    Term {
        fr: "clutch",
        en: &[r"clutch"],
    },
    Term {
        fr: "box-out",
        en: &[r"box_outs?", r"boxe[ds]_out", r"boxing_out"],
    },
    Term {
        fr: "hand-off",
        en: &[r"hand_offs?", r"dribble hand_offs?"],
    },
    Term {
        fr: "switch",
        en: &[r"switch(?:es|ed|ing)?"],
    },
    Term {
        fr: "drop",
        en: &[r"drop coverage"],
    },
    Term {
        fr: "hedge",
        en: &[r"hedge[ds]?", r"hedging"],
    },
    Term {
        fr: "blitz",
        en: &[r"blitz(?:es|ed|ing)?"],
    },
    Term {
        fr: "spacing",
        en: &[r"spacing"],
    },
    Term {
        fr: "iso",
        en: &[r"iso", r"isos"],
    },
    Term {
        fr: "post-up",
        en: &[r"post_ups?", r"posts_up", r"posting_up", r"posted_up"],
    },
    Term {
        fr: "small ball",
        en: &[r"small_ball"],
    },
    Term {
        fr: "stretch four",
        en: &[r"stretch_(?:four|4)s?"],
    },
    Term {
        fr: "playmaker",
        en: &[r"playmakers?", r"playmaking"],
    },
    Term {
        fr: "mismatch",
        en: &[r"mismatch(?:es)?"],
    },
    Term {
        fr: "lob",
        en: &[r"lobs?"],
    },
    Term {
        fr: "poster",
        en: &[r"posterize[ds]?", r"posterizing", r"poster dunk"],
    },
    Term {
        fr: "trash-talk",
        en: &[r"trash_talk(?:ing)?"],
    },
    Term {
        fr: "flop",
        en: &[r"flops?", r"flopp(?:ed|ing)"],
    },
    Term {
        fr: "heat check",
        en: &[r"heat_checks?"],
    },
    Term {
        fr: "back-to-back",
        en: &[r"back_to_backs?"],
    },
    Term {
        fr: "box-and-one",
        en: &[r"box_(?:and|n)_one"],
    },
    Term {
        fr: "turnaround",
        en: &[r"turn_arounds?"],
    },
    Term {
        fr: "3-and-D",
        en: &[r"(?:3|three)_(?:and|n)_d"],
    },
    Term {
        fr: "airball",
        en: &[r"air_balls?", r"air_balled"],
    },
    Term {
        fr: "goaltending",
        en: &[r"goaltending", r"goal_tending"],
    },
    Term {
        fr: "rookie",
        en: &[r"rookies?"],
    },
    Term {
        fr: "mid-range",
        en: &[r"mid_range", r"midrange"],
    },
];

/// Formes françaises tolérées en plus des termes (anglicismes d'usage, déjà
/// connus de la consigne) : ne comptent pas comme de l'anglais resté.
const EXTRA_FR: &[&str] = &[
    "lay-up",
    "layup",
    "dunk",
    "money time",
    "triple-double",
    "double-double",
    "corner",
    "all-star",
    "putback",
    "tip-in",
    "shooteur",
    "shoot",
    "timing",
];

/// `motif` du terme : `_` devient le séparateur souple, bornes de mot autour.
fn compile(pattern: &str) -> String {
    format!(r"\b(?:{})\b", pattern.replace('_', SEP))
}

struct Compiled {
    /// (forme française, motif des formes anglaises).
    terms: Vec<(&'static str, Regex)>,
    /// Toutes les formes françaises et anglaises, pour [`strip_jargon`].
    any: Regex,
}

fn compiled() -> &'static Compiled {
    static C: OnceLock<Compiled> = OnceLock::new();
    C.get_or_init(|| {
        let terms = TERMS
            .iter()
            .map(|t| {
                let alt =
                    t.en.iter()
                        .map(|p| compile(p))
                        .collect::<Vec<_>>()
                        .join("|");
                let re = Regex::new(&format!("(?i){alt}")).expect("motif du jargon");
                (t.fr, re)
            })
            .collect();
        let mut all: Vec<String> = TERMS
            .iter()
            .flat_map(|t| t.en.iter().map(|p| compile(p)))
            .collect();
        for fr in TERMS.iter().map(|t| t.fr).chain(EXTRA_FR.iter().copied()) {
            let words: Vec<String> = jsre!(r"[\s\-]+").split(fr).map(regex::escape).collect();
            all.push(format!(r"\b{}\b", words.join(SEP)));
        }
        let any = Regex::new(&format!("(?i){}", all.join("|"))).expect("motif du jargon");
        Compiled { terms, any }
    })
}

/// Termes du jargon présents dans ces lignes anglaises (forme française
/// d'usage, sans doublon, dans l'ordre de la liste).
pub fn jargon_in<S: AsRef<str>>(lines: &[S]) -> Vec<&'static str> {
    let c = compiled();
    c.terms
        .iter()
        .filter(|(_, re)| lines.iter().any(|l| re.is_match(l.as_ref())))
        .map(|(fr, _)| *fr)
        .collect()
}

/// Texte sans ses termes de jargon (remplacés par un blanc).
pub fn strip_jargon(s: &str) -> String {
    compiled().any.replace_all(s, " ").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reperage() {
        assert_eq!(
            jargon_in(&["Great closeout by Smart, and now the pick and roll."]),
            ["pick-and-roll", "close-out"]
        );
        assert_eq!(jargon_in(&["Step-back three, bang!"]), ["step-back"]);
        assert_eq!(jargon_in(&["He pulls up from deep"]), ["pull-up"]);
        assert_eq!(jargon_in(&["and one!"]), ["and-one"]);
        assert_eq!(jargon_in(&["they switch everything"]), ["switch"]);
        assert_eq!(jargon_in(&["catch and shoot three"]), ["catch-and-shoot"]);
        // Sens courant : pas de jargon.
        assert!(jargon_in(&["They need to close out the game."]).is_empty());
        assert!(jargon_in(&["He's one of the best in the league."]).is_empty());
        assert!(jargon_in(&["Isolated on the wing"]).is_empty());
    }

    #[test]
    fn retrait() {
        let s = strip_jargon("Le pick and roll, puis un catch and shoot dans le corner.");
        assert!(!s.contains("and"), "{s}");
        assert!(!strip_jargon("Un and-one !").contains("and"));
        assert!(strip_jargon("Bon close-out de Smart").contains("Smart"));
    }
}
