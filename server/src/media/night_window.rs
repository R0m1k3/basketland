//! Fenêtre des tâches de fond lourdes (traduction des commentaires, analyse
//! vidéo OCR), en heures de Paris (équivalent de `nightWindow.ts`) :
//! `COMMENTARY_NIGHT_WINDOW`, « always » par défaut, « 2-6 » pour de 2 h à
//! 6 h seulement, « off » pour ne traiter que les matchs qu'on ouvre.
//!
//! La fenêtre est FERMÉE quand la « Traduction automatique » est désactivée
//! (/parametres). Les demandes explicites ne passent pas par la fenêtre.

use crate::js::jsre;
use crate::settings::{auto_translate_enabled, Settings};
use chrono::{DateTime, Timelike, Utc};

fn spec() -> String {
    let raw = std::env::var("COMMENTARY_NIGHT_WINDOW").unwrap_or_else(|_| "always".into());
    crate::js::trim(&raw).to_lowercase()
}

/// Plage `h-h` (heures modulo 24).
fn range(spec: &str) -> Option<(u32, u32)> {
    let m = jsre!(r"^(\d{1,2})\s*-\s*(\d{1,2})$").captures(spec)?;
    let from = m[1].parse::<u32>().ok()? % 24;
    let to = m[2].parse::<u32>().ok()? % 24;
    Some((from, to))
}

/// `inScheduleWindow` : plage horaire seule, sans le réglage « Traduction automatique ».
pub fn in_schedule_window(now: DateTime<Utc>) -> bool {
    let spec = spec();
    if spec == "off" || spec == "0" || spec.is_empty() {
        return false;
    }
    if spec == "always" || spec == "on" {
        return true;
    }
    let Some((from, to)) = range(&spec) else {
        return false;
    };
    let h = now.with_timezone(&chrono_tz::Europe::Paris).hour();
    if from <= to {
        h >= from && h < to
    } else {
        h >= from || h < to
    }
}

/// `inNightWindow` : plage horaire ouverte ET traduction automatique activée
/// (base illisible : activée, comme Node).
pub fn in_night_window(settings: &Settings, now: DateTime<Utc>) -> bool {
    in_schedule_window(now) && auto_translate_enabled(settings)
}

/// `nightWindowLabel` : « en continu », « chaque nuit de 2 h à 6 h », ou `None`.
pub fn night_window_label() -> Option<String> {
    let spec = spec();
    if spec == "always" || spec == "on" {
        return Some("en continu".into());
    }
    range(&spec).map(|(a, b)| format!("chaque nuit de {a} h à {b} h"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{restore_env, set_env, ENV_LOCK};
    use crate::settings::keys;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn fenetre_en_heures_de_paris() {
        let _g = ENV_LOCK.blocking_lock();
        let saved = set_env(&[("COMMENTARY_NIGHT_WINDOW", None)]);
        let on = Settings::default();
        assert!(in_night_window(&on, at("2026-10-31T12:00:00Z")));
        assert_eq!(night_window_label().as_deref(), Some("en continu"));
        let off = Settings::from_pairs([(keys::AUTO_TRANSLATE, "0")]);
        assert!(!in_night_window(&off, at("2026-10-31T12:00:00Z")));
        assert!(in_night_window(
            &Settings::unreadable(),
            at("2026-10-31T12:00:00Z")
        ));

        std::env::set_var("COMMENTARY_NIGHT_WINDOW", " 2 - 6 ");
        // 01:30 UTC = 02:30 à Paris (heure d'hiver le 31 octobre 2026).
        assert!(in_schedule_window(at("2026-10-31T01:30:00Z")));
        assert!(!in_schedule_window(at("2026-10-31T05:30:00Z")));
        assert_eq!(
            night_window_label().as_deref(),
            Some("chaque nuit de 2 h à 6 h")
        );
        std::env::set_var("COMMENTARY_NIGHT_WINDOW", "22-26");
        assert!(in_schedule_window(at("2026-10-31T00:30:00Z")));
        assert!(!in_schedule_window(at("2026-10-31T12:00:00Z")));
        std::env::set_var("COMMENTARY_NIGHT_WINDOW", "OFF");
        assert!(!in_schedule_window(at("2026-10-31T12:00:00Z")));
        assert_eq!(night_window_label(), None);
        std::env::set_var("COMMENTARY_NIGHT_WINDOW", "n'importe");
        assert!(!in_schedule_window(at("2026-10-31T12:00:00Z")));
        restore_env(saved);
    }
}
