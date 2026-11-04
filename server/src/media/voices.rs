//! Qui parle ? Reconnaissance des commentateurs, pour donner une couleur à
//! chacun dans les sous-titres.
//!
//! Le worker Whisper (`scripts/whisper_worker.py`) joint à chaque tronçon
//! l'EMPREINTE de voix de chaque prise de parole ([`VoiceTurn`] : vecteur
//! normé de 256 nombres, modèle WeSpeaker). Deux prises de parole d'une même
//! personne ont des empreintes proches (cosinus ~0,6), celles de deux
//! personnes différentes non (~0,1 à 0,2).
//!
//! [`VoiceRegistry`] regroupe ces empreintes sur TOUT le match, tronçon après
//! tronçon (les tronçons ne sont pas faits dans l'ordre : on suit le
//! spectateur) :
//!  1. dans le tronçon, les prises de parole d'au moins 1 s sont regroupées
//!     (regroupement hiérarchique, centroïdes pondérés par la durée) tant
//!     que deux groupes se ressemblent assez ([`LOCAL_SIM`]) ;
//!  2. chaque groupe, du plus long au plus court, est rattaché à la voix
//!     connue la plus proche si elle ressemble assez ([`KNOWN_SIM`]), sinon
//!     devient une nouvelle voix s'il dure au moins [`NEW_VOICE_SEC`] ;
//!  3. les prises de parole courtes (ou d'un groupe trop court) prennent la
//!     voix connue la plus proche, si elle ressemble assez.
//!
//! Les voix sont numérotées dans l'ordre où elles apparaissent (0, 1, 2…) ;
//! le registre et les étiquettes de chaque tronçon sont gardés dans le
//! dossier de travail du match (`voices.json`) : une reprise donne les mêmes
//! numéros. Réglages mesurés sur VoxConverse (débats télévisés, 2 à 17
//! intervenants) : 98 % du temps de parole attribué au bon intervenant.

use super::commentary_cues::{AsrWord, Transcript};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Ressemblance minimale de deux groupes d'un même tronçon pour les fondre.
pub const LOCAL_SIM: f32 = 0.55;
/// Ressemblance minimale avec une voix déjà connue pour y être rattaché.
pub const KNOWN_SIM: f32 = 0.5;
/// Durée de parole minimale (s) d'un groupe pour créer une nouvelle voix.
pub const NEW_VOICE_SEC: f64 = 4.0;
/// Prise de parole assez longue pour une empreinte fiable (s).
const RELIABLE_SEC: f64 = 1.0;
/// Poids maximal d'un groupe dans le centre d'une voix : un long monologue
/// n'écrase pas tout ce qui a été entendu avant.
const MAX_WEIGHT: f64 = 30.0;

/// Prise de parole et empreinte de la voix (horodatage dans le tronçon).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VoiceTurn {
    pub start: f64,
    pub end: f64,
    pub emb: Vec<f32>,
}

impl VoiceTurn {
    pub fn to_json(&self) -> Value {
        json!({ "start": self.start, "end": self.end, "emb": self.emb })
    }

    /// Lecture tolérante : `None` si un champ manque ou n'est pas un nombre.
    pub fn from_json(v: &Value) -> Option<VoiceTurn> {
        let start = v.get("start")?.as_f64()?;
        let end = v.get("end")?.as_f64()?;
        let emb = v
            .get("emb")?
            .as_array()?
            .iter()
            .map(|x| x.as_f64().map(|f| f as f32))
            .collect::<Option<Vec<f32>>>()?;
        (start.is_finite() && end.is_finite() && !emb.is_empty()).then_some(VoiceTurn {
            start,
            end: end.max(start),
            emb,
        })
    }

    fn duration(&self) -> f64 {
        self.end - self.start
    }
}

/// `voices` d'une réponse de Whisper (absent : aucune).
pub fn parse_voices(raw: Option<&Value>) -> Vec<VoiceTurn> {
    raw.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(VoiceTurn::from_json).collect())
        .unwrap_or_default()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn normed(v: &[f32]) -> Vec<f32> {
    let n = dot(v, v).sqrt();
    if n > 0.0 {
        v.iter().map(|x| x / n).collect()
    } else {
        v.to_vec()
    }
}

/// Somme pondérée `acc += v × w`.
fn add_scaled(acc: &mut Vec<f32>, v: &[f32], w: f64) {
    if acc.len() != v.len() {
        *acc = vec![0.0; v.len()];
    }
    for (a, x) in acc.iter_mut().zip(v) {
        *a += x * w as f32;
    }
}

/// Voix connue : somme pondérée des empreintes (sa direction est le centre).
#[derive(Debug, Clone, PartialEq)]
struct Voice {
    sum: Vec<f32>,
    /// Durée de parole totale (s).
    seconds: f64,
}

/// Groupe de prises de parole d'un tronçon.
struct Group {
    members: Vec<usize>,
    sum: Vec<f32>,
    seconds: f64,
}

/// Voix entendues dans un match.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VoiceRegistry {
    voices: Vec<Voice>,
    /// Étiquettes déjà données, par tronçon (une reprise les retrouve telles quelles).
    chunks: HashMap<usize, Vec<Option<u32>>>,
}

impl VoiceRegistry {
    /// Nombre de voix connues.
    pub fn len(&self) -> usize {
        self.voices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.voices.is_empty()
    }

    /// Voix connue la plus proche et sa ressemblance.
    fn nearest(&self, v: &[f32]) -> Option<(u32, f32)> {
        self.voices
            .iter()
            .enumerate()
            .map(|(k, s)| (k as u32, dot(&normed(&s.sum), v)))
            .max_by(|a, b| a.1.total_cmp(&b.1))
    }

    fn feed(&mut self, k: u32, center: &[f32], seconds: f64) {
        let voice = &mut self.voices[k as usize];
        add_scaled(&mut voice.sum, center, seconds.min(MAX_WEIGHT));
        voice.seconds += seconds;
    }

    /// Voix (n°) de chaque prise de parole du tronçon `chunk` ; `None` : voix
    /// non reconnue. Un tronçon déjà étiqueté garde ses étiquettes.
    pub fn label_chunk(&mut self, chunk: usize, turns: &[VoiceTurn]) -> Vec<Option<u32>> {
        if let Some(l) = self.chunks.get(&chunk).filter(|l| l.len() == turns.len()) {
            return l.clone();
        }
        let embs: Vec<Vec<f32>> = turns.iter().map(|t| normed(&t.emb)).collect();
        let mut labels: Vec<Option<u32>> = vec![None; turns.len()];

        // 1. Regroupement des prises de parole fiables du tronçon.
        let mut groups: Vec<Group> = turns
            .iter()
            .enumerate()
            .filter(|(_, t)| t.duration() >= RELIABLE_SEC)
            .map(|(i, t)| {
                let mut sum = Vec::new();
                add_scaled(&mut sum, &embs[i], t.duration());
                Group {
                    members: vec![i],
                    sum,
                    seconds: t.duration(),
                }
            })
            .collect();
        loop {
            let centers: Vec<Vec<f32>> = groups.iter().map(|g| normed(&g.sum)).collect();
            let mut best: Option<(usize, usize, f32)> = None;
            for i in 0..groups.len() {
                for j in i + 1..groups.len() {
                    let s = dot(&centers[i], &centers[j]);
                    if best.is_none_or(|b| s > b.2) {
                        best = Some((i, j, s));
                    }
                }
            }
            let Some((i, j, _)) = best.filter(|b| b.2 >= LOCAL_SIM) else {
                break;
            };
            let g = groups.remove(j);
            let into = &mut groups[i];
            into.members.extend(g.members);
            add_scaled(&mut into.sum, &g.sum, 1.0);
            into.seconds += g.seconds;
        }

        // 2. Rattachement aux voix connues, les groupes les plus longs d'abord.
        groups.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
        for g in &groups {
            let center = normed(&g.sum);
            let voice = match self.nearest(&center) {
                Some((k, s)) if s >= KNOWN_SIM => Some(k),
                _ if g.seconds >= NEW_VOICE_SEC => {
                    self.voices.push(Voice {
                        sum: Vec::new(),
                        seconds: 0.0,
                    });
                    Some(self.voices.len() as u32 - 1)
                }
                _ => None,
            };
            if let Some(k) = voice {
                self.feed(k, &center, g.seconds);
                for &m in &g.members {
                    labels[m] = Some(k);
                }
            }
        }

        // 3. Prises de parole courtes (ou restées sans voix) : la plus proche.
        for (i, e) in embs.iter().enumerate() {
            if labels[i].is_none() {
                labels[i] = self
                    .nearest(e)
                    .filter(|(_, s)| *s >= KNOWN_SIM)
                    .map(|(k, _)| k);
            }
        }
        self.chunks.insert(chunk, labels.clone());
        labels
    }

    /// Forme gardée sur disque (`voices.json`).
    pub fn to_json(&self) -> Value {
        let round = |v: &[f32]| -> Vec<f64> {
            v.iter()
                .map(|x| (f64::from(*x) * 10_000.0).round() / 10_000.0)
                .collect()
        };
        let mut chunks: Vec<(&usize, &Vec<Option<u32>>)> = self.chunks.iter().collect();
        chunks.sort_by_key(|(k, _)| **k);
        json!({
            "voices": self.voices.iter().map(|v| json!({ "sum": round(&v.sum), "seconds": v.seconds })).collect::<Vec<_>>(),
            "chunks": chunks.into_iter().map(|(k, l)| json!({ "index": k, "labels": l })).collect::<Vec<_>>(),
        })
    }

    /// Lecture tolérante : un fichier illisible donne un registre vide.
    pub fn from_json(v: &Value) -> VoiceRegistry {
        let voices = v
            .get("voices")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let sum = x
                            .get("sum")?
                            .as_array()?
                            .iter()
                            .map(|f| f.as_f64().map(|f| f as f32))
                            .collect::<Option<Vec<f32>>>()?;
                        Some(Voice {
                            sum,
                            seconds: x.get("seconds")?.as_f64()?,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let n = voices.len() as u64;
        let chunks = v
            .get("chunks")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let index = usize::try_from(x.get("index")?.as_u64()?).ok()?;
                        let labels = x
                            .get("labels")?
                            .as_array()?
                            .iter()
                            .map(|l| match l {
                                Value::Null => Some(None),
                                l => l.as_u64().filter(|k| *k < n).map(|k| Some(k as u32)),
                            })
                            .collect::<Option<Vec<Option<u32>>>>()?;
                        Some((index, labels))
                    })
                    .collect()
            })
            .unwrap_or_default();
        VoiceRegistry { voices, chunks }
    }
}

/// Voix de chaque mot : celle de la prise de parole qui contient son milieu
/// (les prises de parole sont faites des mots eux-mêmes, à 0,1 s près).
fn word_voice(w: &AsrWord, turns: &[VoiceTurn], labels: &[Option<u32>]) -> Option<u32> {
    let mid = (w.start + w.end) / 2.0;
    turns
        .iter()
        .zip(labels)
        .filter(|(t, _)| mid >= t.start - 0.1 && mid <= t.end + 0.1)
        .min_by(|(a, _), (b, _)| {
            let d = |t: &VoiceTurn| (mid - (t.start + t.end) / 2.0).abs();
            d(a).total_cmp(&d(b))
        })
        .and_then(|(_, l)| *l)
}

/// Le transcript d'un tronçon, chaque mot (au niveau supérieur et imbriqué)
/// annoté de sa voix (`speaker`).
pub fn with_voices(t: &Transcript, labels: &[Option<u32>]) -> Transcript {
    if t.voices.is_empty() || labels.len() != t.voices.len() {
        return t.clone();
    }
    let tag = |w: &AsrWord| AsrWord {
        speaker: word_voice(w, &t.voices, labels),
        ..w.clone()
    };
    let mut out = t.clone();
    out.words = t.words.iter().map(tag).collect();
    for s in &mut out.segments {
        if let Some(ws) = &s.words {
            s.words = Some(ws.iter().map(tag).collect());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empreinte « pure » de la voix `k` (axe k), un peu bruitée par `noise` sur l'axe 7.
    fn emb(k: usize, noise: f32) -> Vec<f32> {
        let mut v = vec![0.0; 8];
        v[k] = 1.0;
        v[7] = noise;
        v
    }

    fn turn(start: f64, end: f64, k: usize) -> VoiceTurn {
        VoiceTurn {
            start,
            end,
            emb: emb(k, 0.2),
        }
    }

    #[test]
    fn deux_commentateurs_gardent_leur_numero_d_un_troncon_a_l_autre() {
        let mut r = VoiceRegistry::default();
        let a = r.label_chunk(
            0,
            &[turn(0.0, 3.0, 0), turn(3.2, 6.0, 1), turn(6.5, 9.0, 0)],
        );
        assert_eq!(a, vec![Some(0), None, Some(0)]); // voix 1 : 2,8 s, trop peu pour une nouvelle voix
        let b = r.label_chunk(5, &[turn(0.0, 4.5, 1), turn(5.0, 7.0, 0)]);
        assert_eq!(b, vec![Some(1), Some(0)]);
        // Le tronçon 0 repris tel quel ; un tronçon fait plus tard reconnaît les deux voix.
        assert_eq!(
            r.label_chunk(
                0,
                &[turn(0.0, 3.0, 0), turn(3.2, 6.0, 1), turn(6.5, 9.0, 0)]
            ),
            a
        );
        assert_eq!(
            r.label_chunk(2, &[turn(0.0, 2.0, 1), turn(2.1, 2.6, 0)]),
            vec![Some(1), Some(0)]
        );
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn voix_inconnue_et_breve_reste_sans_numero() {
        let mut r = VoiceRegistry::default();
        r.label_chunk(0, &[turn(0.0, 5.0, 0)]);
        assert_eq!(
            r.label_chunk(1, &[turn(0.0, 1.5, 3), turn(2.0, 2.5, 3)]),
            vec![None, None]
        );
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn registre_relu_a_l_identique() {
        let mut r = VoiceRegistry::default();
        r.label_chunk(0, &[turn(0.0, 5.0, 0), turn(5.5, 10.0, 1)]);
        r.label_chunk(3, &[turn(0.0, 0.5, 2)]);
        let back =
            VoiceRegistry::from_json(&serde_json::from_str(&r.to_json().to_string()).unwrap());
        assert_eq!(back.len(), 2);
        assert_eq!(back.chunks, r.chunks);
        assert_eq!(
            VoiceRegistry::from_json(&json!("abîmé")),
            VoiceRegistry::default()
        );
    }

    #[test]
    fn chaque_mot_prend_la_voix_de_sa_prise_de_parole() {
        let t = Transcript {
            words: vec![
                AsrWord::new(" Curry", 0.0, 0.4),
                AsrWord::new(" for", 0.5, 0.7),
                AsrWord::new(" three!", 0.8, 1.2),
                AsrWord::new(" What", 3.0, 3.3),
                AsrWord::new(" a", 9.0, 9.1),
            ],
            voices: vec![turn(0.0, 1.2, 0), turn(3.0, 3.3, 1), turn(9.0, 9.1, 2)],
            ..Default::default()
        };
        let out = with_voices(&t, &[Some(0), Some(1), None]);
        let v: Vec<Option<u32>> = out.words.iter().map(|w| w.speaker).collect();
        assert_eq!(v, vec![Some(0), Some(0), Some(0), Some(1), None]);
        // Étiquettes absentes ou incomplètes : transcript inchangé.
        assert_eq!(with_voices(&t, &[Some(0)]), t);
    }

    #[test]
    fn lecture_tolerante_des_empreintes() {
        let v = parse_voices(Some(&json!([
            { "start": 0.5, "end": 2, "emb": [0.1, 0.2] },
            { "start": 1, "emb": [0.1] },
            { "start": 1, "end": 2, "emb": [] },
            "x"
        ])));
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].emb, vec![0.1, 0.2]);
        assert!(parse_voices(None).is_empty());
    }
}
