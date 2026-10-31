//! Fuseau horaire Europe/Paris : mêmes résultats que `src/lib/time.ts`
//! (Intl de Node), sans dépendre d'ICU.

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Offset, SecondsFormat, TimeZone,
    Timelike, Utc, Weekday,
};
use chrono_tz::Europe::Paris;

pub const PARIS_TZ: &str = "Europe/Paris";

/// Analyse une date comme `new Date(chaîne)` pour les formats écrits en base
/// (ISO 8601 UTC, avec ou sans secondes ni millisecondes, ou avec décalage).
pub fn parse_instant(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    // « 2026-10-28T23:30Z » (format ESPN, sans secondes).
    if let Some(body) = s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        for f in [
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M:%S%.f",
        ] {
            if let Ok(n) = NaiveDateTime::parse_from_str(body, f) {
                return Some(Utc.from_utc_datetime(&n));
            }
        }
    }
    // Date seule : minuit UTC (comme Date.parse('2026-10-28')).
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?));
    }
    None
}

/// `Date.prototype.toISOString()` : `2026-10-28T23:30:00.000Z`.
pub fn iso_utc(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Clé de jour `YYYY-MM-DD` à Paris.
pub fn paris_date_key(d: DateTime<Utc>) -> String {
    d.with_timezone(&Paris).format("%Y-%m-%d").to_string()
}

/// Décalage de Paris à un instant : `+01:00` ou `+02:00`.
pub fn paris_offset(d: DateTime<Utc>) -> String {
    let secs = Paris
        .offset_from_utc_datetime(&d.naive_utc())
        .fix()
        .local_minus_utc();
    let sign = if secs < 0 { '-' } else { '+' };
    let a = secs.abs();
    format!("{sign}{:02}:{:02}", a / 3600, (a % 3600) / 60)
}

/// Heure `HH:mm` à Paris.
pub fn paris_time(d: DateTime<Utc>) -> String {
    let p = d.with_timezone(&Paris);
    format!("{:02}:{:02}", p.hour(), p.minute())
}

/// ISO local de Paris avec décalage : `2026-10-29T00:30:00+01:00`.
pub fn paris_iso(d: DateTime<Utc>) -> String {
    format!(
        "{}{}",
        d.with_timezone(&Paris).format("%Y-%m-%dT%H:%M:%S"),
        paris_offset(d)
    )
}

const JOURS: [&str; 7] = [
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
];
const MOIS: [&str; 12] = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];

/// Libellé d'une clé `YYYY-MM-DD` : `mercredi 28 octobre 2026`.
pub fn label_for_date_key(key: &str) -> Option<String> {
    let noon = Utc.from_utc_datetime(
        &NaiveDate::parse_from_str(key, "%Y-%m-%d")
            .ok()?
            .and_hms_opt(12, 0, 0)?,
    );
    let p = noon.with_timezone(&Paris);
    let wd = match p.weekday() {
        Weekday::Mon => 0,
        Weekday::Tue => 1,
        Weekday::Wed => 2,
        Weekday::Thu => 3,
        Weekday::Fri => 4,
        Weekday::Sat => 5,
        Weekday::Sun => 6,
    };
    Some(format!(
        "{} {} {} {}",
        JOURS[wd],
        p.day(),
        MOIS[p.month0() as usize],
        p.year()
    ))
}

/// Instant UTC (ISO, millisecondes) du début du jour `key` à Paris.
/// Même calcul que `parisDayStartUtc` : décalage pris 2 h avant minuit UTC.
pub fn paris_day_start_utc(key: &str) -> Option<String> {
    let naive = NaiveDate::parse_from_str(key, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)?;
    let probe = Utc.from_utc_datetime(&naive) - Duration::hours(2);
    let off = Paris
        .offset_from_utc_datetime(&probe.naive_utc())
        .fix()
        .local_minus_utc();
    Some(iso_utc(
        Utc.from_utc_datetime(&naive) - Duration::seconds(off as i64),
    ))
}

/// Clé de jour décalée de `days` jours (midi UTC, comme `addDays(new Date(key T12:00Z), n)`).
pub fn shift_key(key: &str, days: i64) -> Option<String> {
    let noon = Utc.from_utc_datetime(
        &NaiveDate::parse_from_str(key, "%Y-%m-%d")
            .ok()?
            .and_hms_opt(12, 0, 0)?,
    );
    Some(paris_date_key(noon + Duration::days(days)))
}

/// Jour UTC suivant d'une clé (`new Date(Date.parse(key T12:00Z) + 1 j).toISOString().slice(0, 10)`).
pub fn next_utc_day(key: &str) -> Option<String> {
    let d = NaiveDate::parse_from_str(key, "%Y-%m-%d").ok()?;
    Some(d.succ_opt()?.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        parse_instant(s).unwrap()
    }

    // Valeurs relevées avec src/lib/time.ts (Node 22, ICU).
    #[test]
    fn heures_de_paris_comme_node() {
        let cases = [
            (
                "2026-10-28T23:30:00.000Z",
                "2026-10-29",
                "00:30",
                "2026-10-29T00:30:00+01:00",
            ),
            (
                "2026-03-29T00:59:00.000Z",
                "2026-03-29",
                "01:59",
                "2026-03-29T01:59:00+01:00",
            ),
            (
                "2026-03-29T01:00:00.000Z",
                "2026-03-29",
                "03:00",
                "2026-03-29T03:00:00+02:00",
            ),
            (
                "2026-10-25T00:30:00.000Z",
                "2026-10-25",
                "02:30",
                "2026-10-25T02:30:00+02:00",
            ),
            (
                "2026-10-25T01:30:00.000Z",
                "2026-10-25",
                "02:30",
                "2026-10-25T02:30:00+01:00",
            ),
            (
                "2026-01-01T23:05:09.000Z",
                "2026-01-02",
                "00:05",
                "2026-01-02T00:05:09+01:00",
            ),
            (
                "2026-06-30T22:00:00.000Z",
                "2026-07-01",
                "00:00",
                "2026-07-01T00:00:00+02:00",
            ),
        ];
        for (input, key, time, iso) in cases {
            let d = at(input);
            assert_eq!(paris_date_key(d), key, "{input}");
            assert_eq!(paris_time(d), time, "{input}");
            assert_eq!(paris_iso(d), iso, "{input}");
        }
    }

    #[test]
    fn debut_de_journee_et_libelles_comme_node() {
        let cases = [
            (
                "2026-03-29",
                "2026-03-28T23:00:00.000Z",
                "dimanche 29 mars 2026",
            ),
            (
                "2026-10-25",
                "2026-10-24T22:00:00.000Z",
                "dimanche 25 octobre 2026",
            ),
            (
                "2026-11-01",
                "2026-10-31T23:00:00.000Z",
                "dimanche 1 novembre 2026",
            ),
            (
                "2026-07-14",
                "2026-07-13T22:00:00.000Z",
                "mardi 14 juillet 2026",
            ),
            (
                "2027-02-01",
                "2027-01-31T23:00:00.000Z",
                "lundi 1 février 2027",
            ),
        ];
        for (key, start, label) in cases {
            assert_eq!(paris_day_start_utc(key).unwrap(), start, "{key}");
            assert_eq!(label_for_date_key(key).unwrap(), label, "{key}");
        }
        assert_eq!(paris_day_start_utc("2026-13-45"), None);
    }

    #[test]
    fn formats_de_date_en_base() {
        assert_eq!(iso_utc(at("2026-10-28T23:30Z")), "2026-10-28T23:30:00.000Z");
        assert_eq!(
            iso_utc(at("2026-10-28T23:30:05Z")),
            "2026-10-28T23:30:05.000Z"
        );
        assert_eq!(
            iso_utc(at("2026-10-28T23:30:05.123Z")),
            "2026-10-28T23:30:05.123Z"
        );
        assert_eq!(shift_key("2026-10-31", -3).unwrap(), "2026-10-28");
        assert_eq!(next_utc_day("2026-12-31").unwrap(), "2027-01-01");
    }
}
