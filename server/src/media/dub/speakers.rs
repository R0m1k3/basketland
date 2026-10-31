//! Locuteurs et voix (fonctions pures de `dub.ts`) : regroupement en ligne
//! des répliques par empreinte vocale, genre (classifieur du moteur),
//! attribution des voix, et l'état `SpeakerState` gardé en base
//! (`dub_tracks.speakers`) — relu et réécrit avec l'ordre des clés de Node.

use super::text::env_num;
use crate::js;
use serde_json::{Map, Value};

/// Voix du moteur : A commentateur principal, B4 consultant, B1 troisième
/// voix, F voix féminine (facultative).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VoiceRole {
    A,
    B4,
    B1,
    F,
}

impl VoiceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceRole::A => "A",
            VoiceRole::B4 => "B4",
            VoiceRole::B1 => "B1",
            VoiceRole::F => "F",
        }
    }

    pub fn parse(s: &str) -> Option<VoiceRole> {
        Some(match s {
            "A" => VoiceRole::A,
            "B4" => VoiceRole::B4,
            "B1" => VoiceRole::B1,
            "F" => VoiceRole::F,
            _ => return None,
        })
    }

    /// `ROLE_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            VoiceRole::A => "Commentateur",
            VoiceRole::B4 => "Consultant",
            VoiceRole::B1 => "Troisième voix",
            VoiceRole::F => "Voix féminine",
        }
    }
}

/// `ROLE_ORDER`.
pub const ROLE_ORDER: [VoiceRole; 4] = [VoiceRole::A, VoiceRole::B4, VoiceRole::B1, VoiceRole::F];

/// `speakerSimThreshold` : similarité cosinus minimale pour rattacher une
/// réplique à un locuteur connu (`DUB_SPEAKER_SIM`, 0,6).
pub fn speaker_sim_threshold() -> f64 {
    env_num("DUB_SPEAKER_SIM", 0.6)
}

/// `femaleProbMin` : probabilité « voix de femme » moyenne à partir de
/// laquelle un locuteur prend la voix F (`DUB_FEMALE_PROB`, 0,85 ; > 1 : détection désactivée).
pub fn female_prob_min() -> f64 {
    env_num("DUB_FEMALE_PROB", 0.85)
}

/// Parole classée homme/femme (s) nécessaire avant de donner F à un locuteur.
pub const FEMALE_MIN_SEC: f64 = 10.0;
/// Seules les répliques des 30 premières secondes de parole d'un locuteur comptent pour son genre.
pub const FEMALE_WINDOW_SEC: f64 = 30.0;

/// `femaleF0Hz` : hauteur médiane (Hz) à partir de laquelle un NOUVEAU
/// locuteur que le classifieur n'a pas assez entendu prend F
/// (`DUB_FEMALE_F0`, désactivé par défaut).
pub fn female_f0_hz() -> f64 {
    env_num("DUB_FEMALE_F0", f64::INFINITY)
}

/// `minNewSpeakerSec` : une réplique plus courte ne crée jamais de nouveau locuteur (`DUB_MIN_NEW_SPEAKER_SEC`, 2 s).
pub fn min_new_speaker_sec() -> f64 {
    env_num("DUB_MIN_NEW_SPEAKER_SEC", 2.0)
}

/// `maxSpeakers` : locuteurs au plus par match (`DUB_MAX_SPEAKERS`, 4, au moins 1).
pub fn max_speakers() -> f64 {
    js::max(1.0, env_num("DUB_MAX_SPEAKERS", 4.0).trunc())
}

/// Clés d'un locuteur créé par `assignSpeakers`, dans l'ordre de Node.
const BASE_KEYS: [&str; 5] = ["id", "centroid", "n", "talk", "f0"];

/// Un locuteur (`Speaker`).
#[derive(Debug, Clone, PartialEq)]
pub struct Speaker {
    pub id: i64,
    /// Moyenne courante des empreintes (non normée).
    pub centroid: Vec<f64>,
    pub n: f64,
    /// Temps de parole cumulé (s).
    pub talk: f64,
    /// Hauteurs de voix des dernières répliques (Hz).
    pub f0: Vec<f64>,
    /// Parole classée homme/femme (s) pendant les `FEMALE_WINDOW_SEC` premières secondes.
    pub female_sec: Option<f64>,
    /// Probabilité « voix de femme » moyenne de cette parole.
    pub female_p: Option<f64>,
    /// Voix attribuée, stable pour tout le match (sauf bascule unique vers F).
    pub role: Option<VoiceRole>,
    /// Voix portée avant la bascule vers F.
    pub role_before: Option<VoiceRole>,
    /// Ordre des clés de l'objet JavaScript (création, puis première affectation).
    keys: Vec<String>,
    /// Champs relus en base que le doublage ne connaît pas, gardés tels quels.
    extra: Map<String, Value>,
}

impl Speaker {
    pub fn new(id: i64, centroid: Vec<f64>) -> Speaker {
        Speaker {
            id,
            centroid,
            n: 1.0,
            talk: 0.0,
            f0: Vec::new(),
            female_sec: None,
            female_p: None,
            role: None,
            role_before: None,
            keys: BASE_KEYS.iter().map(|k| k.to_string()).collect(),
            extra: Map::new(),
        }
    }

    fn touch(&mut self, key: &str) {
        if !self.keys.iter().any(|k| k == key) {
            self.keys.push(key.to_string());
        }
    }

    fn set_female(&mut self, p: f64, sec: f64) {
        self.female_p = Some(p);
        self.touch("femaleP");
        self.female_sec = Some(sec);
        self.touch("femaleSec");
    }

    fn set_role(&mut self, r: VoiceRole) {
        self.role = Some(r);
        self.extra.shift_remove("role");
        self.touch("role");
    }

    fn set_role_before(&mut self, r: VoiceRole) {
        self.role_before = Some(r);
        self.extra.shift_remove("roleBefore");
        self.touch("roleBefore");
    }
}

/// `SpeakerState` : locuteurs reconnus d'un match.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SpeakerState {
    pub next_id: i64,
    pub speakers: Vec<Speaker>,
}

/// `emptySpeakers`.
pub fn empty_speakers() -> SpeakerState {
    SpeakerState::default()
}

/// `cosine` : similarité cosinus ; -1 si longueurs différentes, vide ou nul.
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return -1.0;
    }
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na != 0.0 && nb != 0.0 && !na.is_nan() && !nb.is_nan() {
        dot / (na * nb).sqrt()
    } else {
        -1.0
    }
}

/// `median`.
pub fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() >> 1;
    Some(if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    })
}

/// Réglages de `assignSpeakers` (absents : variables d'environnement).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AssignOptions {
    pub threshold: Option<f64>,
    pub min_new_sec: Option<f64>,
    pub max_speakers: Option<f64>,
}

/// `assignSpeakers` : regroupement en ligne des répliques d'un tronçon
/// (modifie `state`). Rend le locuteur de chaque réplique (`None` : aucun
/// locuteur connu, la voix principale sera utilisée). `female` peut être
/// plus court que les répliques (classifieur absent).
pub fn assign_speakers(
    state: &mut SpeakerState,
    durations: &[f64],
    embeddings: &[Option<Vec<f64>>],
    f0: &[Option<f64>],
    female: &[Option<f64>],
    o: AssignOptions,
) -> Vec<Option<i64>> {
    let threshold = o.threshold.unwrap_or_else(speaker_sim_threshold);
    let min_new_sec = o.min_new_sec.unwrap_or_else(min_new_speaker_sec);
    let max_count = o.max_speakers.unwrap_or_else(max_speakers);
    let emb = |i: usize| {
        embeddings
            .get(i)
            .and_then(|e| e.as_ref())
            .filter(|e| !e.is_empty())
    };
    let mut ids: Vec<Option<i64>> = Vec::with_capacity(durations.len());
    for (i, dur) in durations.iter().enumerate() {
        let Some(e) = emb(i) else {
            ids.push(None);
            continue;
        };
        let mut best: Option<usize> = None;
        let mut best_sim = f64::NEG_INFINITY;
        for (k, s) in state.speakers.iter().enumerate() {
            let sim = cosine(e, &s.centroid);
            if sim > best_sim {
                best_sim = sim;
                best = Some(k);
            }
        }
        match best {
            Some(k) if best_sim >= threshold => {
                let b = &mut state.speakers[k];
                let n = b.n;
                b.centroid = b
                    .centroid
                    .iter()
                    .enumerate()
                    .map(|(j, x)| (x * n + e.get(j).copied().unwrap_or(f64::NAN)) / (n + 1.0))
                    .collect();
                b.n += 1.0;
                b.touch("n");
                ids.push(Some(b.id));
            }
            Some(k)
                if best_sim > -1.0
                    && (*dur < min_new_sec || state.speakers.len() as f64 >= max_count) =>
            {
                ids.push(Some(state.speakers[k].id));
            }
            _ => {
                let s = Speaker::new(state.next_id, e.clone());
                state.next_id += 1;
                ids.push(Some(s.id));
                state.speakers.push(s);
            }
        }
    }
    // Répliques sans empreinte : locuteur de la précédente, sinon de la suivante.
    let mut prev = None;
    for id in ids.iter_mut() {
        if id.is_none() {
            *id = prev;
        } else {
            prev = *id;
        }
    }
    let mut next = None;
    for id in ids.iter_mut().rev() {
        if id.is_none() {
            *id = next;
        } else {
            next = *id;
        }
    }
    for (i, id) in ids.iter().enumerate() {
        let Some(s) = id.and_then(|id| state.speakers.iter_mut().find(|x| x.id == id)) else {
            continue;
        };
        let d = js::max(0.0, durations[i]);
        // Preuve du genre : seulement une réplique rattachée par son empreinte (pas par voisinage).
        let p = if emb(i).is_some() {
            female.get(i).copied().flatten()
        } else {
            None
        };
        if let Some(p) = p {
            if (0.0..=1.0).contains(&p) && d > 0.0 && s.talk < FEMALE_WINDOW_SEC {
                let sec = s.female_sec.unwrap_or(0.0);
                let fp = (s.female_p.unwrap_or(0.0) * sec + p * d) / (sec + d);
                s.set_female(fp, sec + d);
            }
        }
        s.talk += d;
        s.touch("talk");
        if let Some(hz) = f0.get(i).copied().flatten() {
            if hz.is_finite() && hz > 0.0 {
                s.f0.push(js::round(hz * 10.0) / 10.0);
                if s.f0.len() > 200 {
                    s.f0.remove(0);
                }
            }
        }
    }
    ids
}

/// `heardFemale` : au moins `FEMALE_MIN_SEC` de parole classée et une
/// probabilité moyenne ≥ `min_prob`.
pub fn heard_female(s: &Speaker, min_prob: f64) -> bool {
    s.female_sec.unwrap_or(0.0) >= FEMALE_MIN_SEC && s.female_p.unwrap_or(0.0) >= min_prob
}

/// `assignRoles` : voix des locuteurs (modifie `state`) ; rend les ids des
/// locuteurs qui viennent de basculer vers F. `female_hz`, `min_prob` :
/// `None` pour les variables d'environnement.
pub fn assign_roles(
    state: &mut SpeakerState,
    voices: &[String],
    female_hz: Option<f64>,
    min_prob: Option<f64>,
) -> Vec<i64> {
    let female_hz = female_hz.unwrap_or_else(female_f0_hz);
    let min_prob = min_prob.unwrap_or_else(female_prob_min);
    let has_f = voices.iter().any(|v| v == "F");
    let mut switched = Vec::new();
    for s in state.speakers.iter_mut() {
        if let Some(r) = s.role.filter(|r| *r != VoiceRole::F) {
            if has_f && heard_female(s, min_prob) {
                s.set_role_before(r);
                s.set_role(VoiceRole::F);
                switched.push(s.id);
            }
        }
    }
    let mut used: Vec<VoiceRole> = state.speakers.iter().filter_map(|s| s.role).collect();
    let mut fresh: Vec<usize> = (0..state.speakers.len())
        .filter(|&i| state.speakers[i].role.is_none())
        .collect();
    fresh.sort_by(|&a, &b| {
        let (sa, sb) = (&state.speakers[a], &state.speakers[b]);
        let d = sb.talk - sa.talk;
        let d = if d != 0.0 && !d.is_nan() {
            d
        } else {
            (sa.id - sb.id) as f64
        };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    for i in fresh {
        let s = &mut state.speakers[i];
        // Hauteur de voix : seulement faute de parole classée (classifieur absent), jamais contre lui.
        let hz = if s.female_sec.unwrap_or(0.0) < FEMALE_MIN_SEC {
            median(&s.f0)
        } else {
            None
        };
        let female = heard_female(s, min_prob) || hz.is_some_and(|hz| hz >= female_hz);
        let role = if female {
            if has_f {
                VoiceRole::F
            } else {
                VoiceRole::B1
            }
        } else {
            [VoiceRole::A, VoiceRole::B4]
                .into_iter()
                .find(|r| !used.contains(r))
                .unwrap_or(VoiceRole::B1)
        };
        s.set_role(role);
        used.push(role);
    }
    switched
}

/// `voiceFor` : voix réellement disponible pour un rôle (repli si le moteur ne l'a pas).
pub fn voice_for(role: VoiceRole, voices: &[String]) -> String {
    use VoiceRole::*;
    let chain: &[VoiceRole] = match role {
        A => &[A, B4, B1],
        B4 => &[B4, B1, A],
        B1 => &[B1, B4, A],
        F => &[F, B1, B4, A],
    };
    chain
        .iter()
        .find(|r| voices.iter().any(|v| v == r.as_str()))
        .map(|r| r.as_str().to_string())
        .or_else(|| voices.first().cloned())
        .unwrap_or_else(|| role.as_str().to_string())
}

/// `rolesUsed` : rôles utilisés (voix d'avant une bascule vers F comprises), dans l'ordre canonique.
pub fn roles_used(state: &SpeakerState) -> Vec<VoiceRole> {
    ROLE_ORDER
        .into_iter()
        .filter(|r| {
            state
                .speakers
                .iter()
                .any(|s| s.role == Some(*r) || s.role_before == Some(*r))
        })
        .collect()
}

// ---------------------------------------------------------------- état en base

fn nums(v: Option<&Value>) -> Vec<f64> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| js::to_number(Some(x))).collect(),
        _ => Vec::new(),
    }
}

fn opt_num(v: Option<&Value>) -> Option<f64> {
    v.map(|x| js::to_number(Some(x)))
}

fn speaker_from_json(o: &Map<String, Value>) -> Option<Speaker> {
    let id = o
        .get("id")
        .and_then(Value::as_f64)
        .filter(|f| f.fract() == 0.0 && f.is_finite())?;
    if !matches!(o.get("centroid"), Some(Value::Array(_)))
        || !matches!(o.get("f0"), Some(Value::Array(_)))
    {
        return None;
    }
    let num_or_nan = |k: &str| o.get(k).map_or(f64::NAN, |v| js::to_number(Some(v)));
    let role = |k: &str| o.get(k).and_then(Value::as_str).and_then(VoiceRole::parse);
    let known = [
        "id",
        "centroid",
        "n",
        "talk",
        "f0",
        "femaleSec",
        "femaleP",
        "role",
        "roleBefore",
    ];
    let mut extra = Map::new();
    for (k, v) in o {
        let parsed_role = (k == "role" || k == "roleBefore") && role(k).is_some();
        if !known.contains(&k.as_str()) || ((k == "role" || k == "roleBefore") && !parsed_role) {
            extra.insert(k.clone(), v.clone());
        }
    }
    Some(Speaker {
        id: id as i64,
        centroid: nums(o.get("centroid")),
        n: num_or_nan("n"),
        talk: num_or_nan("talk"),
        f0: nums(o.get("f0")),
        female_sec: opt_num(o.get("femaleSec")),
        female_p: opt_num(o.get("femaleP")),
        role: role("role"),
        role_before: role("roleBefore"),
        keys: o.keys().cloned().collect(),
        extra,
    })
}

/// `parseSpeakers` : état relu en base ; illisible : on repart de zéro.
pub fn parse_speakers(raw: Option<&str>) -> SpeakerState {
    let raw = raw.filter(|s| !s.is_empty()).unwrap_or("{}");
    let Some(Value::Object(v)) = crate::jsval::js_parse(raw) else {
        return empty_speakers();
    };
    let Some(Value::Array(list)) = v.get("speakers") else {
        return empty_speakers();
    };
    let speakers: Vec<Speaker> = list
        .iter()
        .filter_map(|s| s.as_object().and_then(speaker_from_json))
        .collect();
    let mut next_id = v.get("nextId").map_or(f64::NAN, |x| js::to_number(Some(x)));
    if next_id.is_nan() {
        next_id = 0.0;
    }
    for s in &speakers {
        next_id = js::max(next_id, (s.id + 1) as f64);
    }
    SpeakerState {
        next_id: next_id as i64,
        speakers,
    }
}

fn n(x: f64) -> Value {
    crate::api::js_num_value(x)
}

fn r(x: f64, k: f64) -> f64 {
    js::round(x * k) / k
}

/// `serializeSpeakers` : état écrit en base (empreintes au 1e-5, temps au
/// centième, probabilité au 1e-4), clés dans l'ordre de l'objet de Node.
pub fn serialize_speakers(st: &SpeakerState) -> Value {
    speakers_json(st, true)
}

impl SpeakerState {
    /// L'état tel quel (`JSON.stringify(state)`, sans arrondi), clés dans l'ordre de Node.
    pub fn to_json(&self) -> Value {
        speakers_json(self, false)
    }
}

fn speakers_json(st: &SpeakerState, round: bool) -> Value {
    let r = |x: f64, k: f64| if round { r(x, k) } else { x };
    let speakers: Vec<Value> = st
        .speakers
        .iter()
        .map(|s| {
            let mut m = Map::new();
            // `{ ...x, centroid, talk, … }` : `talk` toujours écrit (ajouté à la fin s'il manquait).
            let talk = [String::from("talk")];
            let extra_talk = if round && !s.keys.iter().any(|k| k == "talk") {
                &talk[..]
            } else {
                &[]
            };
            for k in s.keys.iter().chain(extra_talk) {
                let v = match k.as_str() {
                    "id" => Some(Value::from(s.id)),
                    "centroid" => Some(Value::Array(
                        s.centroid.iter().map(|x| n(r(*x, 1e5))).collect(),
                    )),
                    "n" => Some(n(s.n)),
                    "talk" => Some(n(r(s.talk, 100.0))),
                    "f0" => Some(Value::Array(s.f0.iter().map(|x| n(*x)).collect())),
                    "femaleSec" => s.female_sec.map(|x| n(r(x, 100.0))),
                    "femaleP" => s.female_p.map(|x| n(r(x, 1e4))),
                    "role" => s
                        .role
                        .map(|x| Value::from(x.as_str()))
                        .or_else(|| s.extra.get("role").cloned()),
                    "roleBefore" => s
                        .role_before
                        .map(|x| Value::from(x.as_str()))
                        .or_else(|| s.extra.get("roleBefore").cloned()),
                    other => s.extra.get(other).cloned(),
                };
                if let Some(v) = v {
                    m.insert(k.clone(), v);
                }
            }
            Value::Object(m)
        })
        .collect();
    let mut m = Map::new();
    m.insert("nextId".into(), Value::from(st.next_id));
    m.insert("speakers".into(), Value::Array(speakers));
    Value::Object(m)
}
