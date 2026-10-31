//! Spectateurs : qui regarde quel match, et à quelle position (équivalent de
//! `viewers.ts`).
//!
//! La fiche d'un match envoie un signe de vie pendant la lecture (toutes les
//! 20 s) et à chaque interrogation des sous-titres. Sans signe de vie depuis
//! [`viewer_idle_ms`] (3 min par défaut), le spectateur est considéré parti.
//! Sert à donner la PRIORITÉ À LA LECTURE : tant que quelqu'un regarde, les
//! tâches de fond attendent.
//!
//! Table unique du processus : [`viewers`]. Les fonctions `*_at` prennent
//! l'instant (ms depuis l'époque) en paramètre, pour les tests ; les autres
//! lisent l'horloge.

use indexmap::IndexMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq)]
struct Viewer {
    /// Dernier signe de vie (ms).
    at: f64,
    /// Position de lecture (s).
    t: f64,
    /// Dernière fois que la position a avancé (lecture).
    moved_at: Option<f64>,
}

/// Instant courant (ms depuis l'époque), comme `Date.now()`.
pub fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn env_ms(name: &str, def: f64) -> f64 {
    let n = std::env::var(name)
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    if n.is_finite() && n > 0.0 {
        n
    } else {
        def
    }
}

/// `viewerIdleMs` : `COMMENTARY_VIEWER_IDLE_MS`, 3 min par défaut.
pub fn viewer_idle_ms() -> f64 {
    env_ms("COMMENTARY_VIEWER_IDLE_MS", 3.0 * 60_000.0)
}

/// `viewerGoneMs` : fiche considérée QUITTÉE (`COMMENTARY_VIEWER_GONE_MS`, 45 s par défaut).
pub fn viewer_gone_ms() -> f64 {
    env_ms("COMMENTARY_VIEWER_GONE_MS", 45_000.0)
}

/// Durée sans que la position avance au-delà de laquelle la lecture est en pause.
const PLAYING_MS: f64 = 60_000.0;

/// Table des spectateurs (ordre d'arrivée, comme une `Map` JavaScript).
#[derive(Default)]
pub struct Viewers {
    map: Mutex<IndexMap<i64, Viewer>>,
}

/// Table unique du processus (`globalThis.__blViewers`).
pub fn viewers() -> &'static Viewers {
    static V: OnceLock<Viewers> = OnceLock::new();
    V.get_or_init(Viewers::default)
}

impl Viewers {
    fn get(&self, id: i64) -> Option<Viewer> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .copied()
    }

    /// `touchViewer` : signe de vie (position en secondes si connue ; `None` =
    /// `undefined`/`null`). Une position qui change d'au moins 1 s : la vidéo est lue.
    pub fn touch_at(&self, match_id: i64, t: Option<f64>, now: f64) {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let prev = m.get(&match_id).copied();
        let pos = match t {
            Some(x) if x.is_finite() && x >= 0.0 => x,
            _ => prev.map_or(0.0, |p| p.t),
        };
        let moved = prev.is_some_and(|p| t.is_some() && (pos - p.t).abs() >= 1.0);
        let moved_at = if moved {
            Some(now)
        } else {
            prev.and_then(|p| p.moved_at)
        };
        m.insert(
            match_id,
            Viewer {
                at: now,
                t: pos,
                moved_at,
            },
        );
    }

    pub fn touch(&self, match_id: i64, t: Option<f64>) {
        self.touch_at(match_id, t, now_ms());
    }

    /// `viewerPlaying` : spectateur actif ET position qui avance depuis moins d'une minute.
    pub fn playing_at(&self, match_id: i64, now: f64) -> bool {
        self.get(match_id).is_some_and(|v| {
            now - v.at < viewer_idle_ms() && v.moved_at.is_some_and(|m| now - m < PLAYING_MS)
        })
    }

    pub fn playing(&self, match_id: i64) -> bool {
        self.playing_at(match_id, now_ms())
    }

    /// `viewerActive`.
    pub fn active_at(&self, match_id: i64, now: f64) -> bool {
        self.get(match_id)
            .is_some_and(|v| now - v.at < viewer_idle_ms())
    }

    pub fn active(&self, match_id: i64) -> bool {
        self.active_at(match_id, now_ms())
    }

    /// `viewerGone` : fiche regardée puis quittée (plus de signe de vie depuis [`viewer_gone_ms`]).
    pub fn gone_at(&self, match_id: i64, now: f64) -> bool {
        self.get(match_id)
            .is_some_and(|v| now - v.at >= viewer_gone_ms())
    }

    pub fn gone(&self, match_id: i64) -> bool {
        self.gone_at(match_id, now_ms())
    }

    /// `viewerPosition` : position du spectateur actif, sinon `None`.
    pub fn position(&self, match_id: i64) -> Option<f64> {
        if self.active(match_id) {
            Some(self.get(match_id).map_or(0.0, |v| v.t))
        } else {
            None
        }
    }

    /// `activeViewers` : matchs regardés, dans l'ordre d'arrivée.
    pub fn active_ids_at(&self, now: f64) -> Vec<i64> {
        let idle = viewer_idle_ms();
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, v)| now - v.at < idle)
            .map(|(id, _)| *id)
            .collect()
    }

    pub fn active_ids(&self) -> Vec<i64> {
        self.active_ids_at(now_ms())
    }

    /// `someoneWatching` : quelqu'un regarde-t-il un AUTRE match que `except` (ou n'importe lequel) ?
    pub fn someone_watching(&self, except: Option<i64>) -> bool {
        self.active_ids().into_iter().any(|id| Some(id) != except)
    }

    /// Tests : oublie tous les spectateurs.
    pub fn clear(&self) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lecture_en_cours_ou_en_pause() {
        // Comme tests/viewers.test.ts (horloge simulée).
        let v = Viewers::default();
        let mut now = 1_800_000_000_000.0;
        v.touch_at(1, Some(0.0), now);
        assert!(!v.playing_at(1, now)); // premier signe : on ne sait pas encore
        now += 20_000.0;
        v.touch_at(1, Some(20.0), now);
        assert!(v.playing_at(1, now));
        now += 20_000.0;
        v.touch_at(1, Some(20.0), now); // pause : même position
        assert!(v.playing_at(1, now)); // avancé il y a moins d'une minute
        now += 50_000.0;
        v.touch_at(1, Some(20.0), now);
        assert!(!v.playing_at(1, now));
        assert!(v.active_at(1, now));
        v.touch_at(1, None, now); // signe de vie sans position : pas une avancée
        assert!(!v.playing_at(1, now));
    }

    #[test]
    fn actifs_partis_et_ordre() {
        let v = Viewers::default();
        v.touch_at(7, Some(10.0), 0.0);
        v.touch_at(3, None, 1000.0);
        v.touch_at(7, Some(f64::NAN), 2000.0);
        assert_eq!(v.active_ids_at(3000.0), vec![7, 3]);
        assert!(v.gone_at(7, 2000.0 + 45_000.0));
        assert!(!v.gone_at(7, 2000.0 + 44_999.0));
        assert!(!v.gone_at(9, 0.0));
        assert_eq!(v.active_ids_at(1000.0 + 180_000.0), vec![7]);
    }
}
