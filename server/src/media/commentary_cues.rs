//! Transcription des commentateurs → sous-titres lisibles (module PUR, sans
//! E/S), équivalent de `commentaryCues.ts`.
//!
//! Entrée : la réponse `verbose_json` de Whisper, tronçon par tronçon
//! ([`parse_verbose_json`]). Étapes :
//!  1. [`filter_transcript`] — retire les hallucinations classiques de Whisper ;
//!  2. [`shift_transcript`] / [`merge_transcripts`] — remet chaque tronçon à
//!     sa place dans la vidéo (un mot n'est gardé que dans le tronçon qui
//!     contient son milieu) ;
//!  3. [`build_cues`] — regroupe les mots en sous-titres COURTS, calés sur la
//!     voix, avec un niveau d'`emphasis` (0 à 2).
//!
//! Longueurs, coupes et expressions régulières suivent la sémantique de
//! JavaScript (unités UTF-16, `\s`, `\b`, `Math.round`) : mêmes sorties que
//! Node, vérifiées sur des cas produits par le code TypeScript.

use crate::api::js_num_value;
use crate::js::{self, jsre};
use serde_json::{Map, Value};
use std::cmp::Ordering;

/// Mot horodaté.
#[derive(Debug, Clone, PartialEq)]
pub struct AsrWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
    /// Intensité de la voix sur ce mot, en dB par rapport au niveau habituel
    /// du tronçon (0 = ton normal, +6 = nettement plus fort).
    pub energy: Option<f64>,
}

impl AsrWord {
    pub fn new(word: &str, start: f64, end: f64) -> Self {
        AsrWord {
            word: word.into(),
            start,
            end,
            energy: None,
        }
    }

    /// Forme JSON de Node : `{ word, start, end, energy? }`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("word".into(), Value::from(self.word.clone()));
        m.insert("start".into(), js_num_value(self.start));
        m.insert("end".into(), js_num_value(self.end));
        if let Some(e) = self.energy {
            m.insert("energy".into(), js_num_value(e));
        }
        Value::Object(m)
    }
}

/// Segment de Whisper.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AsrSegment {
    pub id: Option<f64>,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub avg_logprob: Option<f64>,
    pub no_speech_prob: Option<f64>,
    pub compression_ratio: Option<f64>,
    /// Certains serveurs imbriquent les mots dans les segments.
    pub words: Option<Vec<AsrWord>>,
}

impl AsrSegment {
    pub fn new(start: f64, end: f64, text: &str) -> Self {
        AsrSegment {
            start,
            end,
            text: text.into(),
            ..Default::default()
        }
    }

    /// Forme JSON de Node (ordre des clés de `parseVerboseJson`).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("start".into(), js_num_value(self.start));
        m.insert("end".into(), js_num_value(self.end));
        m.insert("text".into(), Value::from(self.text.clone()));
        for (k, v) in [
            ("id", self.id),
            ("avg_logprob", self.avg_logprob),
            ("no_speech_prob", self.no_speech_prob),
            ("compression_ratio", self.compression_ratio),
        ] {
            if let Some(v) = v {
                m.insert(k.into(), js_num_value(v));
            }
        }
        if let Some(w) = &self.words {
            m.insert(
                "words".into(),
                Value::Array(w.iter().map(AsrWord::to_json).collect()),
            );
        }
        Value::Object(m)
    }
}

/// Transcript d'un tronçon (ou d'une vidéo entière).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Transcript {
    pub segments: Vec<AsrSegment>,
    /// Mots horodatés (niveau supérieur) ; vide si le serveur n'en donne pas.
    pub words: Vec<AsrWord>,
}

impl Transcript {
    /// Forme JSON de Node `{ segments, words }` (cache sur disque).
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "segments": self.segments.iter().map(AsrSegment::to_json).collect::<Vec<_>>(),
            "words": self.words.iter().map(AsrWord::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Sous-titre.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub seq: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Mise en relief : 1 voix qui monte, 2 moment fort (absent : ton normal).
    pub emphasis: Option<u8>,
}

impl Cue {
    /// Forme JSON de Node : `{ seq, start, end, text, emphasis? }`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("seq".into(), Value::from(self.seq));
        m.insert("start".into(), js_num_value(self.start));
        m.insert("end".into(), js_num_value(self.end));
        m.insert("text".into(), Value::from(self.text.clone()));
        if let Some(e) = self.emphasis {
            m.insert("emphasis".into(), Value::from(e));
        }
        Value::Object(m)
    }
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// Comparateur `(a, b) => a.start - b.start` (tri stable).
fn by_start<T>(key: impl Fn(&T) -> f64) -> impl Fn(&T, &T) -> Ordering {
    move |a, b| key(a).partial_cmp(&key(b)).unwrap_or(Ordering::Equal)
}

// ---------------------------------------------------------------- lecture tolérante de verbose_json

fn parse_words(raw: Option<&Value>) -> Vec<AsrWord> {
    let Some(Value::Array(a)) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for w in a {
        let Value::Object(o) = w else { continue };
        let (Some(Value::String(word)), Some(start), Some(end)) =
            (o.get("word"), finite(o.get("start")), finite(o.get("end")))
        else {
            continue;
        };
        out.push(AsrWord {
            word: word.clone(),
            start,
            end: js::max(start, end),
            energy: finite(o.get("energy")),
        });
    }
    out
}

/// `parseVerboseJson` : segments sans horodatage écartés, `words` absent
/// toléré, mots imbriqués dans les segments acceptés.
pub fn parse_verbose_json(raw: &Value) -> Transcript {
    let empty = Map::new();
    let o = raw.as_object().unwrap_or(&empty);
    let mut segments = Vec::new();
    if let Some(Value::Array(list)) = o.get("segments") {
        for s in list {
            let Value::Object(r) = s else { continue };
            let (Some(start), Some(end), Some(Value::String(text))) =
                (finite(r.get("start")), finite(r.get("end")), r.get("text"))
            else {
                continue;
            };
            let nested = parse_words(r.get("words"));
            segments.push(AsrSegment {
                id: finite(r.get("id")),
                start,
                end: js::max(start, end),
                text: text.clone(),
                avg_logprob: finite(r.get("avg_logprob")),
                no_speech_prob: finite(r.get("no_speech_prob")),
                compression_ratio: finite(r.get("compression_ratio")),
                words: (!nested.is_empty()).then_some(nested),
            });
        }
    }
    Transcript {
        segments,
        words: parse_words(o.get("words")),
    }
}

// ---------------------------------------------------------------- hallucinations

fn always_bogus(text: &str) -> bool {
    [
        jsre!(r"^(sub)?titles? (by|from)\b"),
        jsre!(r"\bamara\.org\b"),
        jsre!(r"^(transcribed|transcription|captioned|captioning|translated|subtitled) by\b"),
        jsre!(r"^(thanks|thank you) (so much )?for watching\b"),
        jsre!(r"^please (like and )?subscribe\b"),
        jsre!(r"\bsubscribe to (my|our|the) channel\b"),
        jsre!(r"^see you (in the )?next (time|video)\b"),
    ]
    .iter()
    .any(|re| re.is_match(text))
}

fn short_suspect(text: &str) -> bool {
    jsre!(r"^(thank you( very much)?|thanks|you|bye( bye)?|okay|oh|so|yeah|hmm+|uh+|um+|music|applause|silence|i don't see you|i'm sorry)$").is_match(text)
}

fn has_letter_or_digit(s: &str) -> bool {
    jsre!(r"[\p{L}\p{N}]").is_match(s)
}

/// `normText` : minuscules, sans ponctuation ni espaces superflus.
pub fn norm_text(s: &str) -> String {
    let lower: String = s
        .to_lowercase()
        .chars()
        .map(|c| {
            if "♪♫*[](){}\"“”«»".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let kept = jsre!(r"[^\p{L}\p{N}'.\s]").replace_all(&lower, " ");
    // `.replace(/\.(?=\s|$)/g, ' ')` : point suivi d'un blanc ou de la fin.
    let chars: Vec<char> = kept.chars().collect();
    let mut out = String::with_capacity(kept.len());
    for (i, c) in chars.iter().enumerate() {
        if *c == '.' && chars.get(i + 1).is_none_or(|n| js::is_space(*n)) {
            out.push(' ');
        } else {
            out.push(*c);
        }
    }
    js::trim(&jsre!(r"\s+").replace_all(&out, " ")).to_string()
}

/// `isRepetitionLoop` : même suite de 1 à 6 mots répétée (≥ 5 fois pour un
/// mot seul, ≥ 4 fois au-delà).
pub fn is_repetition_loop(text: &str) -> bool {
    let norm = norm_text(text);
    let t: Vec<&str> = norm.split(' ').filter(|w| !w.is_empty()).collect();
    for n in 1..=6usize {
        let need = if n == 1 { 5 } else { 4 };
        if t.len() < n * need {
            continue;
        }
        let mut i = 0;
        while i + n * need <= t.len() {
            let mut reps = 1;
            let mut j = i + n;
            while j + n <= t.len() {
                if (0..n).any(|k| t[j + k] != t[i + k]) {
                    break;
                }
                reps += 1;
                j += n;
            }
            if reps >= need {
                return true;
            }
            i += 1;
        }
    }
    false
}

/// Segment rejeté par le filtre.
#[derive(Debug, Clone, PartialEq)]
pub struct DroppedSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub reason: String,
}

impl DroppedSegment {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "start": js_num_value(self.start),
            "end": js_num_value(self.end),
            "text": self.text,
            "reason": self.reason,
        })
    }
}

/// `hallucinationReason` : raison de rejeter un segment, ou `None` s'il est gardé.
pub fn hallucination_reason(
    seg: &AsrSegment,
    isolated: bool,
    prompt: Option<&str>,
) -> Option<&'static str> {
    let text = norm_text(&seg.text);
    if text.is_empty() || !has_letter_or_digit(&text) {
        return Some("vide ou musique");
    }
    let nsp = seg.no_speech_prob.unwrap_or(0.0);
    let lp = seg.avg_logprob.unwrap_or(0.0);
    if nsp > 0.6 && lp < -1.0 {
        return Some("pas de parole");
    }
    if seg.compression_ratio.unwrap_or(0.0) > 2.4 {
        return Some("texte trop répétitif");
    }
    if always_bogus(&text) {
        return Some("formule parasite");
    }
    if is_repetition_loop(&seg.text) {
        return Some("boucle de répétition");
    }
    if short_suspect(&text) && (isolated || nsp > 0.3 || lp < -0.8) {
        return Some("formule isolée");
    }
    if let Some(p) = prompt.filter(|p| !p.is_empty()) {
        if js::utf16_len(&text) >= 20 && norm_text(p).contains(&text) {
            return Some("recopie du prompt");
        }
    }
    None
}

/// Un segment est isolé si rien n'est dit dans les 2 s qui l'entourent.
const ISOLATION_GAP: f64 = 2.0;

/// `filterTranscript` : retire les segments hallucinés, puis les mots qui
/// leur appartiennent ; un segment identique au précédent est retiré dès la
/// troisième fois (dès la deuxième pour une formule courte suspecte).
pub fn filter_transcript(
    t: &Transcript,
    prompt: Option<&str>,
) -> (Transcript, Vec<DroppedSegment>) {
    let mut segs = t.segments.clone();
    segs.sort_by(by_start(|s: &AsrSegment| s.start));
    let mut kept: Vec<AsrSegment> = Vec::new();
    let mut dropped: Vec<DroppedSegment> = Vec::new();
    let mut last_text = String::new();
    let mut same_run = 0;
    for (i, seg) in segs.iter().enumerate() {
        let prev = i.checked_sub(1).map(|k| &segs[k]);
        let next = segs.get(i + 1);
        let isolated = prev.is_none_or(|p| seg.start - p.end >= ISOLATION_GAP)
            && next.is_none_or(|n| n.start - seg.end >= ISOLATION_GAP);
        let mut reason = hallucination_reason(seg, isolated, prompt);
        let norm = norm_text(&seg.text);
        same_run = if !norm.is_empty() && norm == last_text {
            same_run + 1
        } else {
            0
        };
        last_text = norm.clone();
        if reason.is_none() && (same_run >= 2 || (same_run >= 1 && short_suspect(&norm))) {
            reason = Some("segment répété");
        }
        match reason {
            Some(r) => dropped.push(DroppedSegment {
                start: seg.start,
                end: seg.end,
                text: js::trim(&seg.text).to_string(),
                reason: r.into(),
            }),
            None => kept.push(seg.clone()),
        }
    }
    let mid = |w: &AsrWord| (w.start + w.end) / 2.0;
    let inside = |x: f64, s: f64, e: f64| x >= s - 0.05 && x <= e + 0.05;
    let words = t
        .words
        .iter()
        .filter(|w| {
            let m = mid(w);
            !(dropped.iter().any(|d| inside(m, d.start, d.end))
                && !kept.iter().any(|k| inside(m, k.start, k.end)))
        })
        .cloned()
        .collect();
    (
        Transcript {
            segments: kept,
            words,
        },
        dropped,
    )
}

// ---------------------------------------------------------------- tronçons

fn r3(x: f64) -> f64 {
    js::round(x * 1000.0) / 1000.0
}

/// `shiftTranscript` : décale tous les horodatages de `offset`, puis ne garde
/// que les éléments dont le MILIEU tombe dans `[keep_from, keep_to[`
/// (`f64::NEG_INFINITY` / `f64::INFINITY` : sans borne).
pub fn shift_transcript(t: &Transcript, offset: f64, keep_from: f64, keep_to: f64) -> Transcript {
    let sw = |w: &AsrWord| AsrWord {
        word: w.word.clone(),
        start: r3(w.start + offset),
        end: r3(w.end + offset),
        energy: w.energy,
    };
    let keep = |s: f64, e: f64| {
        let m = (s + e) / 2.0;
        m >= keep_from && m < keep_to
    };
    Transcript {
        segments: t
            .segments
            .iter()
            .map(|s| AsrSegment {
                start: r3(s.start + offset),
                end: r3(s.end + offset),
                words: s
                    .words
                    .as_ref()
                    .map(|ws| ws.iter().map(sw).filter(|w| keep(w.start, w.end)).collect()),
                ..s.clone()
            })
            .filter(|s| keep(s.start, s.end))
            .collect(),
        words: t
            .words
            .iter()
            .map(sw)
            .filter(|w| keep(w.start, w.end))
            .collect(),
    }
}

/// `mergeTranscripts` : concatène des tronçons déjà décalés, dans l'ordre chronologique.
pub fn merge_transcripts(list: &[Transcript]) -> Transcript {
    let mut segments: Vec<AsrSegment> = list.iter().flat_map(|t| t.segments.clone()).collect();
    segments.sort_by(by_start(|s: &AsrSegment| s.start));
    let mut words: Vec<AsrWord> = list.iter().flat_map(|t| t.words.clone()).collect();
    words.sort_by(by_start(|w: &AsrWord| w.start));
    Transcript { segments, words }
}

// ---------------------------------------------------------------- mots

fn has_punct(s: &str) -> bool {
    s.chars().any(|c| ".,!?;:…".contains(c))
}

fn strip_punct(s: &str) -> String {
    jsre!(r"[^\p{L}\p{N}']")
        .replace_all(&s.to_lowercase(), "")
        .into_owned()
}

/// `text.trim().split(/\s+/).filter(Boolean)`.
fn tokens(text: &str) -> Vec<&str> {
    jsre!(r"\s+")
        .split(js::trim(text))
        .filter(|t| !t.is_empty())
        .collect()
}

/// `punctuateWords` : remet la ponctuation des segments sur des mots qui
/// n'en ont pas (API OpenAI) ; des mots déjà ponctués sont rendus tels quels.
pub fn punctuate_words(words: &[AsrWord], segments: &[AsrSegment]) -> Vec<AsrWord> {
    if words.is_empty() || words.iter().any(|w| has_punct(&w.word)) {
        return words.to_vec();
    }
    let mut out = words.to_vec();
    let mut wi = 0;
    for seg in segments {
        let toks = tokens(&seg.text);
        let mid = |w: &AsrWord| (w.start + w.end) / 2.0;
        while wi < out.len() && mid(&out[wi]) < seg.start - 0.05 {
            wi += 1;
        }
        let mut ti = 0;
        while wi < out.len() && ti < toks.len() && mid(&out[wi]) <= seg.end + 0.05 {
            let a = strip_punct(&out[wi].word);
            if a == strip_punct(toks[ti]) {
                let lead = out[wi].word.chars().next().is_some_and(js::is_space);
                out[wi].word = format!("{}{}", if lead { " " } else { "" }, toks[ti]);
                wi += 1;
                ti += 1;
                continue;
            }
            let end = (ti + 4).min(toks.len());
            let ahead = toks
                .get(ti + 1..end)
                .unwrap_or(&[])
                .iter()
                .position(|tk| strip_punct(tk) == a);
            match ahead {
                Some(k) => ti += k + 1,
                None => wi += 1,
            }
        }
    }
    out
}

/// `wordsFromTranscript` : mots de niveau supérieur, sinon imbriqués, sinon
/// des mots SYNTHÉTIQUES (texte découpé au prorata des caractères).
pub fn words_from_transcript(t: &Transcript) -> Vec<AsrWord> {
    let words: Vec<AsrWord> = if !t.words.is_empty() {
        t.words.clone()
    } else {
        t.segments
            .iter()
            .flat_map(|s| s.words.clone().unwrap_or_default())
            .collect()
    };
    if !words.is_empty() {
        let mut sorted = words;
        sorted.sort_by(by_start(|w: &AsrWord| w.start));
        return punctuate_words(&sorted, &t.segments);
    }
    let mut out = Vec::new();
    for s in &t.segments {
        let toks = tokens(&s.text);
        let total: f64 = toks.iter().map(|tk| js::utf16_len(tk) as f64 + 1.0).sum();
        let mut pos = 0.0;
        let dur = js::max(0.0, s.end - s.start);
        for tk in toks {
            let a = s.start + (dur * pos) / total;
            pos += js::utf16_len(tk) as f64 + 1.0;
            out.push(AsrWord::new(
                tk,
                r3(a),
                js::round((s.start + (dur * pos) / total) * 1000.0) / 1000.0,
            ));
        }
    }
    out
}

// ---------------------------------------------------------------- sous-titres

/// Réglages de [`build_cues`] (`None` : valeur par défaut de Node).
#[derive(Debug, Clone, Copy, Default)]
pub struct CueOptions {
    pub max_chars: Option<f64>,
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
    pub pause_split: Option<f64>,
    pub hard_gap: Option<f64>,
    pub reading_tail: Option<f64>,
    pub reading_cps: Option<f64>,
    pub tone_shift_db: Option<f64>,
}

struct Opts {
    max_chars: f64,
    min_duration: f64,
    max_duration: f64,
    pause_split: f64,
    hard_gap: f64,
    reading_tail: f64,
    reading_cps: f64,
    tone_shift_db: f64,
}

impl CueOptions {
    fn resolve(&self) -> Opts {
        Opts {
            max_chars: self.max_chars.unwrap_or(60.0),
            min_duration: self.min_duration.unwrap_or(1.2),
            max_duration: self.max_duration.unwrap_or(5.0),
            pause_split: self.pause_split.unwrap_or(0.35),
            hard_gap: self.hard_gap.unwrap_or(1.2),
            reading_tail: self.reading_tail.unwrap_or(0.4),
            reading_cps: self.reading_cps.unwrap_or(15.0),
            tone_shift_db: self.tone_shift_db.unwrap_or(6.0),
        }
    }
}

/// Le français fait ~15 % de caractères de plus que l'anglais.
const FR_EXPANSION: f64 = 1.15;

/// `joinWords` : assemble des mots Whisper (« ␣Hello, », « ␣world ») en texte propre.
pub fn join_words<'a>(words: impl IntoIterator<Item = &'a AsrWord>) -> String {
    let mut s = String::new();
    for w in words {
        let raw = jsre!(r"\s+").replace_all(&w.word, " ");
        let t = js::trim(&raw);
        if t.is_empty() {
            continue;
        }
        let glue = !s.is_empty()
            && (jsre!(r"^[.,!?;:…%)]").is_match(t)
                || jsre!(r"^'(s|re|ve|ll|d|m)\b", "i").is_match(t)
                || jsre!(r"^n't\b", "i").is_match(t));
        if !s.is_empty() && !glue {
            s.push(' ');
        }
        s.push_str(t);
    }
    js::trim(&jsre!(r"\s+").replace_all(&s, " ")).to_string()
}

fn len16(s: &str) -> f64 {
    js::utf16_len(s) as f64
}

fn ends_sentence(w: &AsrWord) -> bool {
    jsre!(r#"[.!?…]["”»)]?$"#).is_match(js::trim(&w.word))
}

fn ends_clause(w: &AsrWord) -> bool {
    jsre!(r#"[,;:—–-]["”»)]?$"#).is_match(js::trim(&w.word))
}

fn bare(w: &AsrWord) -> String {
    js::trim(&w.word).to_lowercase()
}

/// Mots qui ouvrent une proposition : on coupe volontiers AVANT eux.
const OPENERS: [&str; 13] = [
    "and", "but", "so", "because", "while", "when", "who", "which", "that", "or", "if", "then",
    "as",
];

/// Mots qui ne terminent jamais une ligne.
const WEAK_END: &str = "a an the its his her their our your my of to in on at for by from with into onto over under through past than across behind toward towards against between around and but or is was are he she they we it this";

fn weak_end(w: &str) -> bool {
    WEAK_END.split(' ').any(|x| x == w)
}

/// Meilleur point de coupure dans un groupe trop long (indice du premier mot
/// de la seconde partie).
fn best_split(group: &[AsrWord], o: &Opts) -> usize {
    let mut best: Option<usize> = None;
    let mut best_score = 0.0;
    for k in 1..group.len() {
        let head = join_words(&group[..k]);
        if len16(&head) < o.max_chars * 0.3 {
            continue;
        }
        let prev = &group[k - 1];
        let gap = group[k].start - prev.end;
        let mut score = if ends_sentence(prev) {
            3.0
        } else if ends_clause(prev) {
            2.0
        } else {
            0.0
        };
        if gap > o.pause_split {
            score += 2.0 + gap;
        }
        if let (Some(ea), Some(eb)) = (prev.energy, group[k].energy) {
            if (eb - ea).abs() >= o.tone_shift_db {
                score += 1.0;
            }
        }
        if score == 0.0
            && OPENERS.contains(&bare(&group[k]).as_str())
            && len16(&head) >= o.max_chars * 0.45
        {
            score = 1.0;
        }
        if score >= 1.0 && score + k as f64 / 1000.0 > best_score {
            best_score = score + k as f64 / 1000.0;
            best = Some(k);
        }
    }
    if let Some(b) = best.filter(|b| *b > 0) {
        return b;
    }
    let n = group.len();
    let mut k = n;
    while k + 3 > n && k > 1 && weak_end(&bare(&group[k - 1])) {
        k -= 1;
    }
    k
}

fn mean_energy(g: &[AsrWord]) -> Option<f64> {
    let e: Vec<f64> = g.iter().filter_map(|w| w.energy).collect();
    (!e.is_empty()).then(|| e.iter().sum::<f64>() / e.len() as f64)
}

/// `cueEmphasis` : moyenne de la moitié la plus forte des mots, renforcée par un « ! ».
pub fn cue_emphasis(g: &[AsrWord], text: &str) -> u8 {
    let mut e: Vec<f64> = g.iter().filter_map(|w| w.energy).collect();
    e.sort_by(|a, b| b.partial_cmp(a).unwrap_or(Ordering::Equal));
    let n = ((e.len() as f64) / 2.0).ceil().max(1.0) as usize;
    let top = &e[..n.min(e.len())];
    let loud = if e.is_empty() {
        0.0
    } else {
        top.iter().sum::<f64>() / top.len() as f64
    };
    let mut level: u8 = if loud >= 6.0 {
        2
    } else if loud >= 3.0 {
        1
    } else {
        0
    };
    if text.contains('!') {
        level = (level + 1).clamp(1, 2);
    }
    level
}

/// `buildCues` : regroupe les mots en sous-titres courts, calés sur la voix ;
/// les sous-titres ne se chevauchent jamais.
pub fn build_cues(input: &[AsrWord], opts: &CueOptions) -> Vec<Cue> {
    let o = opts.resolve();
    let mut words: Vec<AsrWord> = input
        .iter()
        .filter(|w| !js::trim(&w.word).is_empty() && w.start.is_finite() && w.end.is_finite())
        .map(|w| AsrWord {
            end: js::max(w.start, w.end),
            ..w.clone()
        })
        .collect();
    words.sort_by(by_start(|w: &AsrWord| w.start));
    let mut groups: Vec<Vec<AsrWord>> = Vec::new();
    let mut cur: Vec<AsrWord> = Vec::new();
    let too_long = |g: &[AsrWord], w: &AsrWord| {
        len16(&join_words(g.iter().chain(std::iter::once(w)))) > o.max_chars
            || w.end - g[0].start > o.max_duration
    };
    for w in words {
        if !cur.is_empty() {
            let prev = &cur[cur.len() - 1];
            let gap = w.start - prev.end;
            let dur = prev.end - cur[0].start;
            let len = len16(&join_words(&cur));
            let level = mean_energy(&cur);
            let tone_shift = match (level, w.energy) {
                (Some(l), Some(e)) => (e - l).abs() >= o.tone_shift_db && gap >= 0.12,
                _ => false,
            };
            if gap >= o.hard_gap {
                groups.push(std::mem::take(&mut cur));
            } else if too_long(&cur, &w) {
                let k = best_split(&cur, &o);
                let tail = cur.split_off(k);
                if !cur.is_empty() {
                    groups.push(std::mem::take(&mut cur));
                }
                cur = tail;
                if !cur.is_empty() && too_long(&cur, &w) {
                    groups.push(std::mem::take(&mut cur));
                }
            } else if (dur >= o.min_duration
                && (ends_sentence(prev) || gap > o.pause_split)
                && len >= 12.0)
                || (len >= 12.0 && (tone_shift || (ends_clause(prev) && gap > 0.2 && len >= 28.0)))
            {
                groups.push(std::mem::take(&mut cur));
            }
        }
        cur.push(w);
    }
    if !cur.is_empty() {
        groups.push(cur);
    }

    let mut cues: Vec<Cue> = Vec::new();
    for g in &groups {
        let text = join_words(g);
        if !has_letter_or_digit(&text) {
            continue;
        }
        let emphasis = cue_emphasis(g, &text);
        cues.push(Cue {
            seq: 0,
            start: g[0].start,
            end: g[g.len() - 1].end,
            text,
            emphasis: (emphasis > 0).then_some(emphasis),
        });
    }
    let r2 = |x: f64| js::round(x * 100.0) / 100.0;
    for i in 0..cues.len() {
        let next_start = cues.get(i + 1).map(|n| n.start);
        let c = &mut cues[i];
        let reading = (len16(&c.text) * FR_EXPANSION) / o.reading_cps;
        let mut end = js::max(
            js::max(c.end + o.reading_tail, c.start + o.min_duration),
            c.start + reading,
        );
        end = js::min(
            end,
            js::max(c.end + o.reading_tail, c.start + o.max_duration),
        );
        if let Some(ns) = next_start {
            end = js::min(end, ns - 0.04);
        }
        if end <= c.start {
            end = match next_start {
                Some(ns) => js::max(c.start + 0.01, js::min(c.end, ns)),
                None => c.start + o.min_duration,
            };
        }
        c.seq = i as u32 + 1;
        c.start = r2(c.start);
        c.end = r2(js::max(end, c.start + 0.01));
        if let Some(ns) = next_start {
            if c.end > r2(ns) {
                c.end = r2(ns);
            }
        }
    }
    cues
}

/// `wrapTwoLines` : deux lignes équilibrées (≤ `max_line` si possible), de
/// préférence après une ponctuation. Pour l'export WebVTT.
pub fn wrap_two_lines(text: &str, max_line: usize) -> String {
    let collapsed = jsre!(r"\s+").replace_all(text, " ");
    let t = js::trim(&collapsed);
    let u: Vec<u16> = t.encode_utf16().collect();
    if u.len() <= max_line {
        return t.to_string();
    }
    let mut best: Option<usize> = None;
    let mut best_score = f64::INFINITY;
    for i in 1..u.len().saturating_sub(1) {
        if u[i] != b' ' as u16 {
            continue;
        }
        let a = i as f64;
        let b = (u.len() - i - 1) as f64;
        let mut score = (a - b).abs();
        if a.max(b) > max_line as f64 {
            score += 1000.0;
        }
        if [',', '.', ';', ':', '!', '?']
            .iter()
            .any(|c| u[i - 1] == *c as u16)
        {
            score -= 8.0;
        }
        if score < best_score {
            best_score = score;
            best = Some(i);
        }
    }
    match best {
        None => t.to_string(),
        Some(b) => format!(
            "{}\n{}",
            String::from_utf16_lossy(&u[..b]),
            String::from_utf16_lossy(&u[b + 1..])
        ),
    }
}

#[cfg(test)]
mod tests {
    //! Cas de tests/commentary-cues.test.ts ; la parité exacte avec Node est
    //! vérifiée par tests/media_node.rs.
    use super::*;
    use serde_json::json;

    fn words(text: &str, t0: f64, step: f64, len: f64) -> Vec<AsrWord> {
        text.split(' ')
            .enumerate()
            .map(|(i, w)| {
                AsrWord::new(
                    &format!(" {w}"),
                    t0 + i as f64 * step,
                    t0 + i as f64 * step + len,
                )
            })
            .collect()
    }

    fn seg(start: f64, end: f64, text: &str) -> AsrSegment {
        AsrSegment {
            avg_logprob: Some(-0.2),
            no_speech_prob: Some(0.05),
            compression_ratio: Some(1.4),
            ..AsrSegment::new(start, end, text)
        }
    }

    fn texts(c: &[Cue]) -> Vec<String> {
        c.iter().map(|c| c.text.clone()).collect()
    }

    #[test]
    fn lecture_verbose_json() {
        let t = parse_verbose_json(&json!({
            "segments": [null, {"start": "x", "end": 1, "text": "a"}, {"start": 1, "end": 2, "text": " ok", "words": [{"word": " ok", "start": 1, "end": 1.4}, {"word": 3}]}],
        }));
        assert!(t.words.is_empty());
        assert_eq!(t.segments.len(), 1);
        assert_eq!(
            t.segments[0].words,
            Some(vec![AsrWord::new(" ok", 1.0, 1.4)])
        );
        assert_eq!(parse_verbose_json(&Value::Null), Transcript::default());
    }

    #[test]
    fn hallucinations() {
        let mut s = seg(0.0, 2.0, "What a pass");
        s.no_speech_prob = Some(0.8);
        s.avg_logprob = Some(-1.3);
        assert_eq!(hallucination_reason(&s, false, None), Some("pas de parole"));
        assert!(is_repetition_loop(
            "Let's go. Let's go. Let's go. Let's go."
        ));
        assert!(is_repetition_loop("the the the the the"));
        assert!(!is_repetition_loop("Let's go, let's go! What a game."));
        assert_eq!(
            hallucination_reason(
                &seg(0.0, 3.0, " Subtitles by the Amara.org community"),
                false,
                None
            ),
            Some("formule parasite")
        );
        assert_eq!(
            hallucination_reason(&seg(0.0, 1.0, " Thank you."), true, None),
            Some("formule isolée")
        );
        assert_eq!(
            hallucination_reason(&seg(0.0, 1.0, " Thank you."), false, None),
            None
        );
        assert_eq!(
            hallucination_reason(&seg(0.0, 1.0, " ♪ ♪"), false, None),
            Some("vide ou musique")
        );
        let prompt = "NBA basketball game commentary: Portland Trail Blazers at Los Angeles Lakers. LeBron James, Deni Avdija.";
        assert_eq!(
            hallucination_reason(
                &seg(0.0, 3.0, " Portland Trail Blazers at Los Angeles Lakers."),
                false,
                Some(prompt)
            ),
            Some("recopie du prompt")
        );
        let t = Transcript {
            segments: vec![
                seg(0.0, 2.0, " Curry pulls up."),
                seg(10.0, 11.0, " Thank you."),
                seg(20.0, 22.0, " Bang! Splash."),
            ],
            words: [
                words("Curry pulls up.", 0.0, 0.3, 0.25),
                words("Thank you.", 10.0, 0.3, 0.25),
                words("Bang! Splash.", 20.0, 0.3, 0.25),
            ]
            .concat(),
        };
        let (kept, dropped) = filter_transcript(&t, None);
        assert_eq!(
            dropped.iter().map(|d| d.text.as_str()).collect::<Vec<_>>(),
            ["Thank you."]
        );
        assert_eq!(join_words(&kept.words), "Curry pulls up. Bang! Splash.");
    }

    #[test]
    fn troncons_et_frontiere() {
        let a = Transcript {
            segments: vec![seg(590.0, 601.0, " end of chunk boundary")],
            words: vec![
                AsrWord::new(" chunk", 598.0, 599.5),
                AsrWord::new(" boundary", 599.8, 600.4),
            ],
        };
        let b = Transcript {
            segments: vec![seg(2.0, 5.0, " boundary next")],
            words: vec![
                AsrWord::new(" boundary", 2.8, 3.4),
                AsrWord::new(" next", 3.5, 4.0),
            ],
        };
        let pa = shift_transcript(&a, 0.0, 0.0, 600.0);
        let pb = shift_transcript(&b, 597.0, 600.0, 1200.0);
        assert_eq!(
            pb.words,
            vec![
                AsrWord::new(" boundary", 599.8, 600.4),
                AsrWord::new(" next", 600.5, 601.0)
            ]
        );
        let merged = merge_transcripts(&[pb, pa]);
        assert_eq!(join_words(&merged.words), "chunk boundary next");
    }

    #[test]
    fn sous_titres() {
        let o = CueOptions::default();
        let cues = build_cues(
            &words("He crosses over, steps back, and drills the three from the corner. That is his fifth of the night", 0.0, 0.3, 0.25),
            &o,
        );
        assert_eq!(
            texts(&cues),
            [
                "He crosses over, steps back,",
                "and drills the three from the corner.",
                "That is his fifth of the night"
            ]
        );
        let w = [
            words("Brown drives to the rim", 0.0, 0.3, 0.25),
            words("and he is fouled hard", 1.85, 0.3, 0.25),
        ]
        .concat();
        assert_eq!(
            texts(&build_cues(&w, &o)),
            ["Brown drives to the rim", "and he is fouled hard"]
        );
        let calm: Vec<AsrWord> =
            words("Brown brings it up the floor, looks inside", 0.0, 0.3, 0.25)
                .into_iter()
                .map(|w| AsrWord {
                    energy: Some(0.0),
                    ..w
                })
                .collect();
        let burst: Vec<AsrWord> = words("and he slams it home!", 2.5, 0.3, 0.25)
            .into_iter()
            .map(|w| AsrWord {
                energy: Some(8.0),
                ..w
            })
            .collect();
        let cues = build_cues(&[calm, burst].concat(), &o);
        assert_eq!(
            texts(&cues),
            [
                "Brown brings it up the floor, looks inside",
                "and he slams it home!"
            ]
        );
        assert_eq!(cues[0].emphasis, None);
        assert_eq!(cues[1].emphasis, Some(2));
        let e = |v: &[f64]| -> Vec<AsrWord> {
            v.iter()
                .enumerate()
                .map(|(i, e)| AsrWord {
                    energy: Some(*e),
                    ..AsrWord::new(&format!(" w{i}"), i as f64, i as f64 + 0.5)
                })
                .collect()
        };
        assert_eq!(cue_emphasis(&e(&[0.0, 1.0, -2.0]), "calme"), 0);
        assert_eq!(cue_emphasis(&e(&[-3.0, 4.0, 4.0, -1.0]), "monte"), 1);
        assert_eq!(cue_emphasis(&e(&[7.0, 6.0, -4.0, -6.0]), "cri"), 2);
        assert_eq!(cue_emphasis(&e(&[]), "Wow!"), 1);
        assert_eq!(cue_emphasis(&e(&[4.0, 3.0]), "Yes!"), 2);
        assert_eq!(
            join_words(&[
                AsrWord::new(" He", 0.0, 0.1),
                AsrWord::new("'s", 0.1, 0.2),
                AsrWord::new(" open", 0.2, 0.3),
                AsrWord::new("!", 0.3, 0.3)
            ]),
            "He's open!"
        );
    }

    #[test]
    fn mots_et_lignes() {
        let w = words_from_transcript(&Transcript {
            segments: vec![seg(10.0, 12.0, " Jokic finds Murray.")],
            words: vec![],
        });
        assert_eq!(
            w.iter().map(|x| x.word.as_str()).collect::<Vec<_>>(),
            ["Jokic", "finds", "Murray."]
        );
        assert_eq!((w[0].start, w[2].end), (10.0, 12.0));
        let segments = [seg(0.0, 2.0, " Curry, from deep. Bang!")];
        let p: Vec<AsrWord> = ["Curry", "from", "deep", "Bang"]
            .iter()
            .enumerate()
            .map(|(i, w)| AsrWord::new(w, i as f64 * 0.5, i as f64 * 0.5 + 0.4))
            .collect();
        assert_eq!(
            join_words(&punctuate_words(&p, &segments)),
            "Curry, from deep. Bang!"
        );
        assert_eq!(wrap_two_lines("Court.", 42), "Court.");
        let w = wrap_two_lines(
            "Il élimine son défenseur, recule et plante le tir à trois points depuis le coin.",
            42,
        );
        assert_eq!(w.split('\n').count(), 2);
        assert!(w.split('\n').all(|l| js::utf16_len(l) <= 42));
    }
}
