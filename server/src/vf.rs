//! Générateur de VF française déterministe (équivalent de `src/lib/vf.ts`) :
//! classement des actions ESPN, traduction par gabarits, sélection des
//! lignes. Les lignes produites sont identiques à celles de Node.

use crate::espn_events::PlayRow;
use crate::js::{self, jsre};
use crate::jsval::js_number_string;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Jumpball,
    MadeFg,
    MissedFg,
    BlockedFg,
    FtMade,
    FtMissed,
    ReboundOff,
    ReboundDef,
    Turnover,
    FoulPersonal,
    FoulShooting,
    FoulOffensive,
    FoulTechnical,
    FoulFlagrant,
    Timeout,
    Substitution,
    PeriodStart,
    PeriodEnd,
    GameEnd,
    Challenge,
    Review,
    Violation,
    Ejection,
    Other,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        use Category::*;
        match self {
            Jumpball => "jumpball",
            MadeFg => "made_fg",
            MissedFg => "missed_fg",
            BlockedFg => "blocked_fg",
            FtMade => "ft_made",
            FtMissed => "ft_missed",
            ReboundOff => "rebound_off",
            ReboundDef => "rebound_def",
            Turnover => "turnover",
            FoulPersonal => "foul_personal",
            FoulShooting => "foul_shooting",
            FoulOffensive => "foul_offensive",
            FoulTechnical => "foul_technical",
            FoulFlagrant => "foul_flagrant",
            Timeout => "timeout",
            Substitution => "substitution",
            PeriodStart => "period_start",
            PeriodEnd => "period_end",
            GameEnd => "game_end",
            Challenge => "challenge",
            Review => "review",
            Violation => "violation",
            Ejection => "ejection",
            Other => "other",
        }
    }
}

/// `classifyPlay`.
pub fn classify_play(event_type: &str, text: &str, scoring: bool) -> Category {
    use Category::*;
    let t = format!("{event_type} {text}").to_lowercase();
    let t = t.as_str();
    let has = |re: &regex::Regex| re.is_match(t);
    if has(jsre!("end (of )?game")) {
        return GameEnd;
    }
    if has(jsre!(
        r"^end period|end of the \d|end of (the )?(\d+(st|nd|rd|th) )?(quarter|half|overtime|ot)"
    )) {
        return PeriodEnd;
    }
    if has(jsre!(
        r"^start period|start of the \d|start of (the )?(\d+(st|nd|rd|th) )?(quarter|half|overtime|ot)"
    )) {
        return PeriodStart;
    }
    if has(jsre!("jump ?ball")) {
        return Jumpball;
    }
    if has(jsre!("ejected|ejection")) {
        return Ejection;
    }
    if t.contains("review") {
        return Review;
    }
    if t.contains("challenge") {
        return Challenge;
    }
    if t.contains("timeout") {
        return Timeout;
    }
    if has(jsre!("substitution|enters the game")) {
        return Substitution;
    }
    if t.contains("free throw") {
        if has(jsre!(r"\bmisses\b")) {
            return FtMissed;
        }
        return if scoring || has(jsre!(r"\bmakes\b")) {
            FtMade
        } else {
            FtMissed
        };
    }
    if t.contains("rebound") {
        return if t.contains("offensive") {
            ReboundOff
        } else {
            ReboundDef
        };
    }
    if has(jsre!("turnover|traveling|bad pass|lost ball|steps out|out of bounds|shot clock|backcourt|double dribble|palming|discontinue")) {
        return Turnover;
    }
    if t.contains("flagrant") {
        return FoulFlagrant;
    }
    if has(jsre!(
        "technical|3-seconds|three seconds|flopping|delay of game"
    )) && !t.contains("offensive 3")
    {
        return FoulTechnical;
    }
    if has(jsre!(r"offensive charge|offensive foul|charge\b")) {
        return FoulOffensive;
    }
    if has(jsre!("shooting foul|shooting block foul")) {
        return FoulShooting;
    }
    if t.contains("foul") {
        return FoulPersonal;
    }
    if has(jsre!(
        "goaltending|kicked ball|violation|lane|jump ball violation"
    )) {
        return Violation;
    }
    if has(jsre!(r"\bblocks\b")) {
        return BlockedFg;
    }
    if scoring || has(jsre!(r"\bmakes\b")) {
        return MadeFg;
    }
    if has(jsre!(r"\bmisses\b")) {
        return MissedFg;
    }
    Other
}

/// « Action clé » : panier, temps mort, changement de quart, fin de match.
pub fn is_key_category(c: Category) -> bool {
    use Category::*;
    matches!(
        c,
        MadeFg | FtMade | Timeout | PeriodStart | PeriodEnd | GameEnd | Jumpball
    )
}

// ------------------------------------------------------------------ lexique

fn ordinal_fr(n: f64, feminine: bool) -> String {
    if n == 1.0 {
        return if feminine { "1re" } else { "1er" }.into();
    }
    format!("{}e", js_number_string(n))
}

fn period_label(period: f64) -> String {
    if period <= 4.0 {
        format!("{} quart", ordinal_fr(period, false))
    } else {
        format!("{} prolongation", ordinal_fr(period - 4.0, true))
    }
}

fn with_article(period: f64) -> String {
    if period <= 4.0 {
        format!("du {}", period_label(period))
    } else {
        format!("de la {}", period_label(period))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShotKind {
    Dunk,
    Layup,
    Hook,
    Tip,
    Floater,
    Jumper,
    Generic,
}

#[derive(Debug, Clone, Copy)]
struct ShotInfo {
    kind: ShotKind,
    three: bool,
    alley_oop: bool,
    step_back: bool,
    bank: bool,
    meters: Option<f64>,
}

/// `parseShot` ; `score_value` : `undefined` → 0 (paramètre par défaut).
fn parse_shot(phrase: &str, score_value: Option<f64>) -> ShotInfo {
    let p = phrase.to_lowercase();
    let p = p.as_str();
    let meters = jsre!(r"(\d+)-foot")
        .captures(p)
        .map(|m| js::round(crate::api::js_number(&m[1]) * 0.3048));
    let kind = if p.contains("dunk") {
        ShotKind::Dunk
    } else if p.contains("tip") {
        ShotKind::Tip
    } else if jsre!("layup|lay-up|finger roll").is_match(p) {
        ShotKind::Layup
    } else if p.contains("hook") {
        ShotKind::Hook
    } else if p.contains("float") {
        ShotKind::Floater
    } else if jsre!("jump|jumper|pullup|fade|shot").is_match(p) && !p.contains("two point shot") {
        ShotKind::Jumper
    } else {
        ShotKind::Generic
    };
    ShotInfo {
        kind,
        three: jsre!("three point|3-pt|three-point").is_match(p)
            || score_value.unwrap_or(0.0) == 3.0,
        alley_oop: p.contains("alley oop"),
        step_back: jsre!("step ?back").is_match(p),
        bank: p.contains("bank"),
        meters: meters.filter(|m| *m >= 2.0),
    }
}

fn meters_str(m: f64) -> String {
    js_number_string(m)
}

fn made_shot_fr(actor: &str, s: ShotInfo, assist: Option<&str>) -> String {
    let servi = assist
        .map(|a| format!(", passe décisive de {a}"))
        .unwrap_or_default();
    if s.kind == ShotKind::Dunk {
        return format!(
            "Dunk de {actor}{}{} !",
            if s.alley_oop { " sur alley-oop" } else { "" },
            assist
                .map(|a| format!(", servi par {a}"))
                .unwrap_or_default()
        );
    }
    if s.three {
        return format!(
            "{actor} marque à trois points{}{servi} !",
            s.meters
                .map(|m| format!(" ({} m)", meters_str(m)))
                .unwrap_or_default()
        );
    }
    let at = s
        .meters
        .map(|m| format!(" à {} m", meters_str(m)))
        .unwrap_or_default();
    match s.kind {
        ShotKind::Layup => format!("{actor} marque en lay-up{servi}"),
        ShotKind::Tip => format!("{actor} marque en claquette{servi}"),
        ShotKind::Hook => format!("{actor} marque en bras roulé{servi}"),
        ShotKind::Floater => format!("{actor} marque en floater{at}{servi}"),
        ShotKind::Jumper => format!(
            "{actor} marque sur un shoot{}{at}{}{servi}",
            if s.step_back { " en step-back" } else { "" },
            if s.bank { " avec la planche" } else { "" }
        ),
        _ => format!(
            "{actor} marque à deux points{}{servi}",
            s.meters
                .map(|m| format!(" ({} m)", meters_str(m)))
                .unwrap_or_default()
        ),
    }
}

fn shot_noun_fr(s: ShotInfo) -> &'static str {
    if s.kind == ShotKind::Dunk {
        return "dunk";
    }
    if s.three {
        return "shoot à trois points";
    }
    match s.kind {
        ShotKind::Layup => "lay-up",
        ShotKind::Tip => "claquette",
        ShotKind::Hook => "bras roulé",
        ShotKind::Floater => "floater",
        ShotKind::Jumper => {
            if s.step_back {
                "shoot en step-back"
            } else {
                "shoot"
            }
        }
        _ => "tir à deux points",
    }
}

/// Type de perte de balle (`TURNOVER_KINDS`), dans l'ordre de recherche.
fn turnover_kind(lower: &str) -> Option<&'static str> {
    let kinds: [(&regex::Regex, &str); 12] = [
        (jsre!("bad pass"), "mauvaise passe"),
        (jsre!("lost ball"), "ballon perdu"),
        (jsre!("traveling"), "marcher"),
        (jsre!("offensive foul"), "faute offensive"),
        (jsre!("steps out|step turnover"), "sortie de terrain"),
        (jsre!("out of bounds"), "sortie de balle"),
        (jsre!("shot clock"), "24 secondes"),
        (jsre!("backcourt"), "retour en zone"),
        (jsre!("double dribble|discontinue"), "reprise de dribble"),
        (jsre!("palming"), "ballon porté"),
        (jsre!("3 second|3-second"), "3 secondes"),
        (jsre!("8 second"), "8 secondes"),
    ];
    kinds
        .iter()
        .find(|(re, _)| re.is_match(lower))
        .map(|(_, k)| *k)
}

/// `fallbackTranslate` : dictionnaire mot à mot pour les libellés inconnus.
pub fn fallback_translate(text: &str) -> String {
    let lexicon: [(&regex::Regex, &str); 20] = [
        (jsre!(r"\bmakes\b"), "marque"),
        (jsre!(r"\bmisses\b"), "rate"),
        (jsre!(r"\boffensive rebound\b"), "rebond offensif"),
        (jsre!(r"\bdefensive rebound\b"), "rebond défensif"),
        (jsre!(r"\brebound\b"), "rebond"),
        (jsre!(r"\bassists\b"), "passe décisive"),
        (jsre!(r"\bsteals\b"), "interception"),
        (jsre!(r"\bblocks\b"), "contre"),
        (jsre!(r"\bturnover\b"), "perte de balle"),
        (jsre!(r"\bthree point\b"), "à trois points"),
        (jsre!(r"\bfree throw\b"), "lancer franc"),
        (jsre!(r"\btechnical foul\b"), "faute technique"),
        (jsre!(r"\bpersonal foul\b"), "faute personnelle"),
        (jsre!(r"\bfoul\b"), "faute"),
        (jsre!(r"\btimeout\b"), "temps mort"),
        (jsre!(r"\bjump shot\b|\bjumper\b|\bjumpshot\b"), "shoot"),
        (jsre!(r"\blayup\b"), "lay-up"),
        (jsre!(r"\bdunk\b"), "dunk"),
        (jsre!(r"\bviolation\b"), "violation"),
        (jsre!(r"\bof\b"), "sur"),
    ];
    let mut s = text.to_string();
    for (re, fr) in lexicon {
        s = re.replace_all(&s, regex::NoExpand(fr)).into_owned();
    }
    s
}

/// Capture non vide (une capture vide est « fausse » en JavaScript).
fn cap<'a>(m: &regex::Captures<'a>, i: usize) -> Option<&'a str> {
    m.get(i).map(|x| x.as_str()).filter(|s| !s.is_empty())
}

fn first_cap<'a>(re: &regex::Regex, text: &'a str) -> Option<&'a str> {
    re.captures(text).and_then(|m| m.get(1)).map(|x| x.as_str())
}

/// `translatePlay` : une action ESPN → une ligne française (repli lexical).
pub fn translate_play(play: &PlayRow) -> String {
    use Category::*;
    let text = js::trim(&play.text_en);
    let cat = classify_play(&play.event_type, text, play.scoring != 0.0);
    let lower = text.to_lowercase();
    let lower = lower.as_str();
    match cat {
        GameEnd => "Fin du match".into(),
        PeriodEnd => format!("Fin {}", with_article(play.period)),
        PeriodStart => format!("Début {}", with_article(play.period)),
        Jumpball => {
            match jsre!(r"^(.+?) vs\.? (.+?)(?: \((.+?) gains possession\))?$", "i").captures(text)
            {
                Some(m) => format!(
                    "Entre-deux : {} contre {}{}",
                    &m[1],
                    &m[2],
                    cap(&m, 3)
                        .map(|p| format!(", ballon pour {p}"))
                        .unwrap_or_default()
                ),
                None => "Entre-deux".into(),
            }
        }
        Timeout => {
            if jsre!("official", "i").is_match(text) {
                return "Temps mort officiel".into();
            }
            let team = jsre!(r"^(.+?)\s+(full|20 sec\.?|short|mandatory)?\s*timeout", "i")
                .captures(text)
                .and_then(|m| m.get(1).map(|x| js::trim(x.as_str()).to_string()));
            match team.filter(|t| !t.is_empty()) {
                Some(t) => format!("Temps mort {t}"),
                None => "Temps mort".into(),
            }
        }
        Substitution => match jsre!("^(.+?) enters the game for (.+)$", "i").captures(text) {
            Some(m) => format!("{} remplace {}", &m[1], &m[2]),
            None => "Changement".into(),
        },
        FtMade | FtMissed => {
            if let Some(m) = jsre!(
                r"^(.+?) (makes|misses)\s+(technical |flagrant )?free throw\s*(technical |flagrant |clear path )?(\d) of (\d)",
                "i"
            )
            .captures(text)
            {
                let verb = if m[2].to_lowercase() == "makes" {
                    "marque"
                } else {
                    "rate"
                };
                let tech = js::trim(cap(&m, 3).or(cap(&m, 4)).unwrap_or("")).to_lowercase();
                let qual = match tech.as_str() {
                    "technical" => " (technique)",
                    "flagrant" => " (faute flagrante)",
                    _ => "",
                };
                return format!(
                    "{} {verb} le lancer franc{qual} {} sur {}",
                    &m[1], &m[5], &m[6]
                );
            }
            if let Some(m) =
                jsre!(r"^(.+?) (makes|misses)\s+(technical )?free throw", "i").captures(text)
            {
                return format!(
                    "{} {} le lancer franc{}",
                    &m[1],
                    if m[2].to_lowercase() == "makes" {
                        "marque"
                    } else {
                        "rate"
                    },
                    if cap(&m, 3).is_some() {
                        " technique"
                    } else {
                        ""
                    }
                );
            }
            fallback_translate(text)
        }
        MadeFg => match jsre!(r"^(.+?) makes (.+?)(?: \((.+?) assists\))?$", "i").captures(text) {
            Some(m) => made_shot_fr(&m[1], parse_shot(&m[2], play.score_value), cap(&m, 3)),
            None => fallback_translate(text),
        },
        MissedFg => match jsre!("^(.+?) misses (.+)$", "i").captures(text) {
            Some(m) => format!(
                "{} rate son {}",
                &m[1],
                shot_noun_fr(parse_shot(&m[2], play.score_value))
            ),
            None => fallback_translate(text),
        },
        BlockedFg => {
            if let Some(m) = jsre!("^(.+?) blocks (.+?)'s? (.+)$", "i").captures(text) {
                return format!(
                    "Contre de {} sur le {} de {} !",
                    &m[1],
                    shot_noun_fr(parse_shot(&m[3], None)),
                    &m[2]
                );
            }
            match jsre!("^(.+?) blocks (.+)$", "i").captures(text) {
                Some(m) => format!("Contre de {} sur {} !", &m[1], &m[2]),
                None => fallback_translate(text),
            }
        }
        ReboundOff | ReboundDef => {
            let kind = if cat == ReboundOff {
                "offensif"
            } else {
                "défensif"
            };
            if let Some(t) = first_cap(
                jsre!("^(.+?) (offensive|defensive) team rebound", "i"),
                text,
            ) {
                return format!("Rebond {kind} pour les {t}");
            }
            match first_cap(jsre!("^(.+?) (offensive|defensive)? ?rebound", "i"), text) {
                Some(w) => format!("Rebond {kind} de {w}"),
                None => format!("Rebond {kind}"),
            }
        }
        Turnover => {
            let steal = first_cap(jsre!(r"\((.+?) steals\)", "i"), text).filter(|s| !s.is_empty());
            let who = first_cap(
                jsre!(
                    "^(.+?) (bad pass|lost ball|traveling|offensive foul|steps out|out of bounds|shot clock|backcourt|double dribble|palming|discontinue|3 second|8 second|turnover)",
                    "i"
                ),
                text,
            )
            .filter(|s| !s.is_empty());
            let kind = turnover_kind(lower);
            if lower.contains("shot clock") && who.is_none() {
                return "Violation des 24 secondes".into();
            }
            if let (Some(steal), Some(who)) = (steal, who) {
                return format!(
                    "Interception de {steal} sur {} de {who} !",
                    if kind == Some("mauvaise passe") {
                        "une mauvaise passe"
                    } else {
                        "un ballon perdu"
                    }
                );
            }
            if let (Some("marcher"), Some(who)) = (kind, who) {
                return format!("Marcher de {who}");
            }
            let k = kind.map(|k| format!(" ({k})")).unwrap_or_default();
            match who {
                Some(who) => format!("Perte de balle de {who}{k}"),
                None => format!("Perte de balle{k}"),
            }
        }
        FoulFlagrant => match jsre!(r"^(.+?) flagrant foul type (\d)", "i").captures(text) {
            Some(m) => format!("Faute flagrante {} de {}", &m[2], &m[1]),
            None => "Faute flagrante".into(),
        },
        FoulTechnical => {
            let who = first_cap(
                jsre!("^(.+?) (defensive 3-seconds|technical|flopping|delay)", "i"),
                text,
            );
            if jsre!("3-seconds|three seconds").is_match(lower) {
                return match who {
                    Some(w) => format!("Faute technique de {w} (3 secondes défensives)"),
                    None => "Faute technique (3 secondes défensives)".into(),
                };
            }
            if lower.contains("flopping") {
                return match who {
                    Some(w) => format!("Faute technique de {w} (simulation)"),
                    None => "Faute technique (simulation)".into(),
                };
            }
            if lower.contains("delay") {
                return match who {
                    Some(w) => format!("Retard de jeu : {w}"),
                    None => "Retard de jeu".into(),
                };
            }
            match who {
                Some(w) => format!("Faute technique de {w}"),
                None => "Faute technique".into(),
            }
        }
        FoulOffensive => match jsre!("^(.+?) offensive (charge|foul)", "i").captures(text) {
            Some(m) => {
                if m[2].to_lowercase() == "charge" {
                    format!("Passage en force de {}", &m[1])
                } else {
                    format!("Faute offensive de {}", &m[1])
                }
            }
            None => "Faute offensive".into(),
        },
        FoulShooting => match first_cap(jsre!("^(.+?) shooting( block)? foul", "i"), text) {
            Some(w) => format!("Faute de {w} sur un tir"),
            None => "Faute sur un tir".into(),
        },
        FoulPersonal => {
            let Some(m) = jsre!(
                "^(.+?) (personal take foul|personal foul|loose ball foul|take foul|away from play foul|transition take foul|clear path foul|foul)",
                "i"
            )
            .captures(text) else {
                return "Faute personnelle".into();
            };
            let k = m[2].to_lowercase();
            if k.contains("take") {
                format!("Faute volontaire de {}", &m[1])
            } else if k.contains("loose ball") {
                format!("Faute de {} sur ballon libre", &m[1])
            } else if k.contains("clear path") {
                format!("Faute « clear path » de {}", &m[1])
            } else {
                format!("Faute personnelle de {}", &m[1])
            }
        }
        Challenge => {
            if jsre!("overturned", "i").is_match(text) {
                return "Challenge : décision annulée".into();
            }
            if jsre!("support|stands", "i").is_match(text) {
                return "Challenge : décision confirmée".into();
            }
            match first_cap(jsre!("^(.+?) coach'?s challenge", "i"), text) {
                Some(t) => format!("Challenge demandé par les {t}"),
                None => "Challenge vidéo".into(),
            }
        }
        Review => {
            if jsre!("overturned", "i").is_match(text) {
                "Arbitrage vidéo : décision annulée".into()
            } else if jsre!("support|stands", "i").is_match(text) {
                "Arbitrage vidéo : décision confirmée".into()
            } else {
                "Arbitrage vidéo".into()
            }
        }
        Violation => {
            match jsre!(
                "^(.+?) (defensive goaltending|offensive goaltending|goaltending|kicked ball|lane|jump ball|delay)",
                "i"
            )
            .captures(text)
            {
                Some(m) => {
                    let k = m[2].to_lowercase();
                    if k.contains("goaltending") {
                        format!(
                            "Goaltending {} de {}",
                            if k.contains("offensive") {
                                "offensif"
                            } else {
                                "défensif"
                            },
                            &m[1]
                        )
                    } else if k.contains("kicked") {
                        format!("Ballon touché du pied par {}", &m[1])
                    } else if k.contains("lane") {
                        format!("Violation de zone : {}", &m[1])
                    } else {
                        format!("Violation : {}", &m[1])
                    }
                }
                None => "Violation".into(),
            }
        }
        Ejection => match first_cap(jsre!("^(.+?) (ejected|ejection)", "i"), text) {
            Some(w) => format!("{w} est expulsé !"),
            None => "Expulsion".into(),
        },
        _ => fallback_translate(text),
    }
}

// ------------------------------------------------------------------ sélection

/// Ligne de VF (`CommentaryLine`).
#[derive(Debug, Clone, PartialEq)]
pub struct CommentaryLine {
    pub seq: f64,
    pub period: f64,
    pub clock_sec: f64,
    pub wallclock: String,
    pub text_fr: String,
    pub kind: &'static str,
    pub speaker: String,
    pub priority: f64,
    /// Durée suggérée d'affichage (s).
    pub hold: f64,
}

impl CommentaryLine {
    pub fn to_json(&self) -> serde_json::Value {
        use crate::api::js_num_value as n;
        serde_json::json!({
            "seq": n(self.seq), "period": n(self.period), "clock_sec": n(self.clock_sec),
            "wallclock": self.wallclock, "text_fr": self.text_fr, "kind": self.kind,
            "speaker": self.speaker, "priority": n(self.priority), "hold": n(self.hold),
        })
    }
}

fn hold_for(text: &str) -> f64 {
    js::min(6.0, js::max(2.5, 1.5 + js::utf16_len(text) as f64 / 18.0))
}

fn score_line(p: &PlayRow, home: &str, away: &str) -> String {
    match (p.home_score, p.away_score) {
        (Some(h), Some(a)) => format!(
            " · {away} {} – {} {home}",
            js_number_string(a),
            js_number_string(h)
        ),
        _ => String::new(),
    }
}

fn line_from(p: &PlayRow, text: String, priority: f64, kind: &'static str) -> CommentaryLine {
    CommentaryLine {
        seq: p.seq,
        period: p.period,
        clock_sec: p.clock_sec,
        wallclock: p.wallclock.clone(),
        hold: hold_for(&text),
        text_fr: text,
        kind,
        speaker: p.team_abbr.clone(),
        priority,
    }
}

fn seq_cmp(a: f64, b: f64) -> std::cmp::Ordering {
    // `a - b` : différence finie (numéros de séquence finis).
    (a - b)
        .partial_cmp(&0.0)
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn seq_key(n: f64) -> u64 {
    if n == 0.0 {
        0
    } else {
        n.to_bits()
    }
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Dest {
    Primary,
    Extras,
}

/// `buildCommentary` : sélectionne et traduit les actions notables (cible
/// 120-180 lignes), séries de lancers francs regroupées, bannière de coup
/// d'envoi en préfixe de la première ligne commentée.
pub fn build_commentary(
    plays: &[PlayRow],
    home_abbr: &str,
    away_abbr: &str,
) -> Vec<CommentaryLine> {
    use Category::*;
    let min_lines = 120usize;
    let max_lines = 180usize;
    let mut sorted: Vec<&PlayRow> = plays.iter().collect();
    sorted.sort_by(|a, b| seq_cmp(a.seq, b.seq));
    let mut primary: Vec<CommentaryLine> = Vec::new();
    let mut extras: Vec<CommentaryLine> = Vec::new();
    let mut first_play_done = false;
    let mut start_banner = String::new();
    let mut consumed: std::collections::HashSet<u64> = std::collections::HashSet::new();

    let push = |dest: Dest,
                primary: &mut Vec<CommentaryLine>,
                extras: &mut Vec<CommentaryLine>,
                start_banner: &mut String,
                p: &PlayRow,
                text: String,
                priority: f64,
                kind: &'static str| {
        let mut text = text;
        let mut kind = kind;
        let mut priority = priority;
        if !start_banner.is_empty() && dest == Dest::Primary {
            text = format!("{start_banner} {text}");
            kind = "banniere";
            priority = js::max(priority, 100.0);
            start_banner.clear();
        }
        let line = line_from(p, text, priority, kind);
        match dest {
            Dest::Primary => primary.push(line),
            Dest::Extras => extras.push(line),
        }
    };

    let mut i = 0usize;
    while i < sorted.len() {
        let p = sorted[i];
        if consumed.contains(&seq_key(p.seq)) {
            i += 1;
            continue;
        }
        let cat = classify_play(&p.event_type, &p.text_en, p.scoring != 0.0);
        let is_first = !first_play_done && p.period == 1.0;
        if is_first {
            first_play_done = true;
            start_banner = "Coup d'envoi du match !".into();
        }
        let primary_before = primary.len();
        let extras_before = extras.len();
        macro_rules! emit {
            ($dest:expr, $text:expr, $prio:expr) => {
                emit!($dest, $text, $prio, "action")
            };
            ($dest:expr, $text:expr, $prio:expr, $kind:expr) => {{
                let text = $text;
                push(
                    $dest,
                    &mut primary,
                    &mut extras,
                    &mut start_banner,
                    p,
                    text,
                    $prio,
                    $kind,
                )
            }};
        }
        match cat {
            GameEnd => emit!(
                Dest::Primary,
                format!("Fin du match{}", score_line(p, home_abbr, away_abbr)),
                100.0,
                "score"
            ),
            PeriodEnd => emit!(
                Dest::Primary,
                format!(
                    "{}{}",
                    translate_play(p),
                    score_line(p, home_abbr, away_abbr)
                ),
                100.0,
                "score"
            ),
            PeriodStart => emit!(Dest::Primary, translate_play(p), 95.0, "banniere"),
            Jumpball => emit!(Dest::Primary, translate_play(p), 60.0),
            Timeout => emit!(Dest::Primary, translate_play(p), 90.0),
            Ejection => emit!(Dest::Primary, translate_play(p), 100.0),
            FoulFlagrant => emit!(Dest::Primary, translate_play(p), 88.0),
            FoulTechnical => {
                let minor = jsre!("3-seconds|flopping|delay", "i").is_match(&p.text_en);
                emit!(
                    if minor { Dest::Extras } else { Dest::Primary },
                    translate_play(p),
                    if minor { 35.0 } else { 80.0 }
                )
            }
            MadeFg => {
                let shot = parse_shot(&p.text_en, p.score_value);
                emit!(
                    Dest::Primary,
                    translate_play(p),
                    if shot.three || shot.kind == ShotKind::Dunk {
                        85.0
                    } else {
                        70.0
                    }
                )
            }
            FtMade | FtMissed => {
                const MAX_GAP_SEC: f64 = 30.0;
                let mut series: Vec<&PlayRow> = vec![p];
                let mut j = i + 1;
                while j < sorted.len() {
                    let q = sorted[j];
                    let qc = classify_play(&q.event_type, &q.text_en, q.scoring != 0.0);
                    if qc == FtMade || qc == FtMissed {
                        let gap = p.clock_sec - q.clock_sec;
                        if !p.actor.is_empty()
                            && q.actor == p.actor
                            && q.period == p.period
                            && (0.0..=MAX_GAP_SEC).contains(&gap)
                        {
                            series.push(q);
                            j += 1;
                            continue;
                        }
                        break;
                    }
                    if (qc == Substitution || qc == Timeout) && q.period == p.period {
                        j += 1;
                        continue;
                    }
                    break;
                }
                let made = series
                    .iter()
                    .filter(|s| {
                        classify_play(&s.event_type, &s.text_en, s.scoring != 0.0) == FtMade
                    })
                    .count();
                let who = if !p.actor.is_empty() {
                    p.actor.clone()
                } else {
                    first_cap(jsre!("^(.+?) (makes|misses)", "i"), &p.text_en)
                        .unwrap_or("")
                        .to_string()
                };
                let text = if series.len() == 1 {
                    translate_play(p)
                } else {
                    format!("{who} : {made}/{} aux lancers francs", series.len())
                };
                emit!(
                    if made > 0 {
                        Dest::Primary
                    } else {
                        Dest::Extras
                    },
                    text,
                    if made > 0 { 60.0 } else { 30.0 }
                );
                for s in &series {
                    consumed.insert(seq_key(s.seq));
                }
                let mut last = i;
                while last + 1 < sorted.len() && consumed.contains(&seq_key(sorted[last + 1].seq)) {
                    last += 1;
                }
                i = last;
            }
            Turnover => {
                if jsre!(r"steals\)", "i").is_match(&p.text_en) {
                    emit!(Dest::Primary, translate_play(p), 50.0)
                } else {
                    extras.push(line_from(p, translate_play(p), 15.0, "action"))
                }
            }
            BlockedFg => emit!(Dest::Primary, translate_play(p), 50.0),
            Challenge | Review => emit!(Dest::Primary, translate_play(p), 55.0),
            FoulOffensive => emit!(Dest::Primary, translate_play(p), 40.0),
            MissedFg => {
                let shot = parse_shot(&p.text_en, p.score_value);
                emit!(
                    Dest::Extras,
                    translate_play(p),
                    if shot.three { 28.0 } else { 12.0 }
                )
            }
            ReboundOff => emit!(Dest::Extras, translate_play(p), 25.0),
            FoulShooting => emit!(Dest::Extras, translate_play(p), 20.0),
            Violation => emit!(Dest::Extras, translate_play(p), 22.0),
            _ => {}
        }

        // 2e temps de la bannière : aucune ligne `primary` pour cette action.
        if is_first && primary.len() == primary_before && !start_banner.is_empty() {
            if extras.len() > extras_before && extras.last().is_some_and(|l| l.seq == p.seq) {
                extras.pop();
            }
            primary.push(line_from(p, start_banner.clone(), 100.0, "banniere"));
            consumed.insert(seq_key(p.seq));
            start_banner.clear();
        }
        i += 1;
    }

    let by_priority = |a: &CommentaryLine, b: &CommentaryLine| {
        let d = b.priority - a.priority;
        if d != 0.0 && !d.is_nan() {
            d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            seq_cmp(a.seq, b.seq)
        }
    };
    let mut lines: Vec<CommentaryLine> = if primary.len() > max_lines {
        let mut idx: Vec<usize> = (0..primary.len()).collect();
        idx.sort_by(|&a, &b| by_priority(&primary[a], &primary[b]));
        let keep: std::collections::HashSet<usize> = idx.into_iter().take(max_lines).collect();
        primary
            .into_iter()
            .enumerate()
            .filter(|(k, _)| keep.contains(k))
            .map(|(_, l)| l)
            .collect()
    } else if primary.len() < min_lines && !extras.is_empty() {
        let need = min_lines - primary.len();
        let mut add = extras;
        add.sort_by(by_priority);
        add.truncate(need);
        primary.extend(add);
        primary
    } else {
        primary
    };

    lines.sort_by(|a, b| seq_cmp(a.seq, b.seq));
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    lines.retain(|l| seen.insert(seq_key(l.seq)));
    lines
}
