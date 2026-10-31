//! Recherche des replays (équivalent de `searchReplay`, `runReplaySearch` et
//! `syncVideos` de `src/lib/ingest.ts`, de `src/lib/replayCheck.ts` et de la
//! part serveur de `src/lib/replayCadence.ts`).
//!
//! - Une recherche par match à la fois : le job périodique et une demande
//!   depuis la fiche partagent la même recherche (dédoublonnage en vol).
//! - Un replay déjà trouvé (MP4 revérifié pour passer en HLS) n'est jamais
//!   rétrogradé par une recherche qui échoue.
//! - Un replay qui vient d'apparaître est mis en file de traduction (et
//!   d'analyse, après le job) par l'appelant : voir `crate::scheduler`.

use crate::bv::{Bv, ReplayLookup, ReplayMatch};
use crate::db::{self, Db, MatchRow};
use crate::ingest::{self, JobResult};
use crate::ingest_db::{self as idb, ReplayRecheckWindow, VideoUpdate};
use crate::jsval::js_number_string;
use crate::present::to_dto;
use chrono::TimeZone;
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

// ------------------------------------------------------------------ cadence (replayCadence.ts)

const MIN: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MIN;

/// Période du job `sync-videos`.
pub const VIDEO_JOB_INTERVAL_MS: f64 = 20.0 * MIN;
/// Fenêtre de recherche : matchs terminés depuis au plus 21 jours.
pub const REPLAY_SEARCH_DAYS: f64 = 21.0;
/// Durée estimée d'un match (coup d'envoi → fin), faute d'heure de fin en base.
pub const GAME_LENGTH_EST_MS: f64 = 2.5 * HOUR;
/// Un match est « récent » s'il s'est terminé il y a moins de 12 h.
pub const RECENT_FINAL_MS: f64 = 12.0 * HOUR;
/// Revérification d'un match récent sans replay.
pub const RECENT_RECHECK_MS: f64 = 20.0 * MIN;
/// Revérification des autres (plus vieux, ou MP4 en attente du HLS).
pub const RECHECK_MS: f64 = 2.0 * HOUR;
/// Tolérance : `video_checked_at` est posé APRÈS le début du passage du job.
pub const JOB_SLACK_MS: f64 = 5.0 * MIN;
/// Délai minimal entre deux recherches à la demande d'un même match.
pub const MANUAL_CHECK_COOLDOWN_MS: f64 = 2.0 * MIN;
/// Au-delà, la réponse part (202) et la recherche continue en arrière-plan.
pub const REPLAY_CHECK_WAIT_MS: u64 = 20_000;

fn iso_ms(ms: f64) -> String {
    chrono::Utc
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(crate::time::iso_utc)
        .unwrap_or_default()
}

/// `replayRecheckWindow`.
pub fn replay_recheck_window(now: f64) -> ReplayRecheckWindow {
    ReplayRecheckWindow {
        since: iso_ms(now - REPLAY_SEARCH_DAYS * 24.0 * HOUR),
        recent_since: iso_ms(now - RECENT_FINAL_MS - GAME_LENGTH_EST_MS),
        recent_recheck_before: iso_ms(now - (RECENT_RECHECK_MS - JOB_SLACK_MS)),
        recheck_before: iso_ms(now - (RECHECK_MS - JOB_SLACK_MS)),
    }
}

// ------------------------------------------------------------------ recherche

/// Résultat d'une recherche de replay pour un match (job ou demande).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplaySearchResult {
    /// `None` si la recherche a échoué (réseau…).
    pub lookup: Option<ReplayLookup>,
    /// Replay lisible après la recherche (nouveau ou déjà connu).
    pub available: bool,
    /// Un replay vient d'apparaître ou a changé (autre vidéo, MP4 → HLS…).
    pub changed: bool,
    /// Ligne de journal (`ingest_log`).
    pub line: String,
}

fn sql_num(v: &SqlValue) -> f64 {
    match v {
        SqlValue::Integer(i) => *i as f64,
        SqlValue::Real(f) => *f,
        SqlValue::Text(s) => crate::api::js_number(s),
        _ => f64::NAN,
    }
}

/// `r.duration === m.video_duration`.
fn same_duration(d: Option<f64>, col: &SqlValue) -> bool {
    match (d, col) {
        (None, SqlValue::Null) => true,
        (Some(d), SqlValue::Integer(i)) => d == *i as f64,
        (Some(d), SqlValue::Real(f)) => d == *f,
        _ => false,
    }
}

fn nonempty(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

fn js_opt(s: &Option<String>) -> &str {
    s.as_deref().unwrap_or("null")
}

/// Recherche en vol d'un match : résultat partagé par toutes les attentes.
type Flight = watch::Receiver<Option<ReplaySearchResult>>;

struct Inner {
    bv: Bv,
    /// Recherches en cours, par match (`replaySearches`).
    inflight: Mutex<HashMap<i64, Flight>>,
    /// Dernière demande acceptée, par match (ms epoch).
    last_request: Mutex<HashMap<i64, f64>>,
    /// Attente maximale d'une demande avant de répondre 202.
    wait_ms: u64,
}

/// Recherches de replays (état partagé du processus).
#[derive(Clone)]
pub struct Replays(Arc<Inner>);

/// Retire la recherche de la table quoi qu'il arrive (fin, panique).
struct InflightSlot(Replays, i64);
impl Drop for InflightSlot {
    fn drop(&mut self) {
        self.0.inflight().remove(&self.1);
    }
}

impl Replays {
    pub fn new(bv: Bv) -> Self {
        Self::with_wait(bv, REPLAY_CHECK_WAIT_MS)
    }

    /// `waitMs` de `requestReplayCheck` (tests).
    pub fn with_wait(bv: Bv, wait_ms: u64) -> Self {
        Replays(Arc::new(Inner {
            bv,
            inflight: Mutex::new(HashMap::new()),
            last_request: Mutex::new(HashMap::new()),
            wait_ms,
        }))
    }

    pub fn bv(&self) -> &Bv {
        &self.0.bv
    }

    fn inflight(&self) -> std::sync::MutexGuard<'_, HashMap<i64, Flight>> {
        self.0.inflight.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn last_request(&self) -> std::sync::MutexGuard<'_, HashMap<i64, f64>> {
        self.0
            .last_request
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// `replaySearchInProgress`.
    pub fn in_progress(&self, match_id: i64) -> bool {
        self.inflight().contains_key(&match_id)
    }

    /// `__resetReplayChecksForTests`.
    pub fn reset_checks(&self) {
        self.last_request().clear();
    }

    /// `searchReplay` : cherche le replay d'un match et enregistre le résultat
    /// (setVideo / markVideoChecked, `video_kind`). Ne lève jamais. Une
    /// recherche déjà en cours sur ce match est rejointe ; elle va au bout
    /// même si celui qui l'a demandée n'attend plus.
    pub async fn search_replay(&self, db: &Db, m: MatchRow, fresh: bool) -> ReplaySearchResult {
        let id = m.id;
        let mut rx = {
            let mut map = self.inflight();
            match map.get(&id) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    map.insert(id, rx.clone());
                    let me = self.clone();
                    let db = db.clone();
                    tokio::spawn(async move {
                        let slot = InflightSlot(me.clone(), id);
                        let r = me.run_replay_search(&db, &m, fresh).await;
                        // Comme `.finally(() => replaySearches.delete(id))` : plus
                        // « en cours » quand les attentes reçoivent le résultat.
                        drop(slot);
                        let _ = tx.send(Some(r));
                    });
                    rx
                }
            }
        };
        let r = rx.wait_for(|v| v.is_some()).await.map(|v| v.clone());
        match r {
            Ok(Some(r)) => r,
            _ => ReplaySearchResult {
                lookup: None,
                available: false,
                changed: false,
                line: format!("{id}: recherche interrompue"),
            },
        }
    }

    async fn run_replay_search(&self, db: &Db, m: &MatchRow, fresh: bool) -> ReplaySearchResult {
        let was_available = m.video_available && nonempty(&m.video_ok_id);
        let id = m.id;
        let res: Result<ReplaySearchResult, String> = async {
            let rm = ReplayMatch {
                home_name: m.home_name.clone(),
                away_name: m.away_name.clone(),
                date_utc: m.date_utc.clone(),
                season: sql_num(&m.season),
            };
            let r = self.0.bv.find_replay(&rm, fresh).await?;
            // Un replay déjà trouvé n'est jamais rétrogradé par une recherche
            // qui échoue (page ou embed momentanément illisible).
            let upd = (!(was_available && !r.available)
                && (nonempty(&r.ok_id) || nonempty(&r.slug)))
            .then(|| VideoUpdate {
                slug: r.slug.clone(),
                ok_id: r.ok_id.clone(),
                duration: r.duration,
                available: r.available,
                kind: r.kind,
            });
            db.run(move |c| match &upd {
                Some(u) => idb::set_video(c, id, u),
                None => idb::mark_video_checked(c, id),
            })
            .await?;
            let line = format!(
                "{}@{}: {}",
                m.away_abbr,
                m.home_abbr,
                if r.available {
                    format!(
                        "ok.ru/{} {} ({}s)",
                        js_opt(&r.ok_id),
                        r.kind.unwrap_or("null"),
                        r.duration.map_or("null".into(), js_number_string)
                    )
                } else {
                    r.reason.clone().unwrap_or_else(|| "undefined".into())
                }
            );
            // Passage MP4 → HLS sur la même vidéo : mêmes timecodes, rien à recaler.
            let same_video = was_available
                && r.ok_id == m.video_ok_id
                && same_duration(r.duration, &m.video_duration);
            if r.available && !same_video {
                db.run(move |c| ingest::regenerate_subtitles(c, id, None))
                    .await??;
            }
            let prev_kind = if m.video_kind.as_deref() == Some("mp4") {
                "mp4"
            } else {
                "hls"
            };
            let changed = r.available && (!same_video || r.kind.unwrap_or("hls") != prev_kind);
            Ok(ReplaySearchResult {
                available: was_available || r.available,
                lookup: Some(r),
                changed,
                line,
            })
        }
        .await;
        match res {
            Ok(r) => r,
            Err(e) => {
                if let Err(e2) = db.run(move |c| idb::mark_video_checked(c, id)).await {
                    eprintln!("[ingest] sync-videos : {id} non marqué vérifié ({e2})");
                }
                ReplaySearchResult {
                    lookup: None,
                    available: was_available,
                    changed: false,
                    line: format!("{id}: {e}"),
                }
            }
        }
    }

    /// `syncVideos` : job vidéo (toutes les 20 min), cadence de
    /// revérification selon l'âge du match. Rend aussi le nombre de replays
    /// apparus ou changés pendant le passage.
    pub async fn sync_videos(&self, db: &Db, limit: i64) -> (JobResult, usize) {
        let mut changed = 0usize;
        let r = ingest::run_logged(db, "sync-videos", || async {
            let w = replay_recheck_window(self.0.bv.now_ms());
            let todo = db
                .run(move |c| idb::final_matches_needing_video(c, &w, limit))
                .await?;
            let mut out: Vec<String> = Vec::new();
            for m in todo {
                let r = self.search_replay(db, m, false).await;
                if r.changed {
                    changed += 1;
                }
                out.push(r.line);
            }
            Ok(if out.is_empty() {
                "rien à faire".into()
            } else {
                out.join(" | ")
            })
        })
        .await;
        (r, changed)
    }

    // -------------------------------------------------------------- recherche à la demande

    fn remember(&self, match_id: i64, now: f64) {
        let mut m = self.last_request();
        // Borne la mémoire : les entrées plus vieilles que le délai ne servent plus.
        if m.len() > 500 {
            m.retain(|_, at| now - *at < MANUAL_CHECK_COOLDOWN_MS);
        }
        m.insert(match_id, now);
    }

    /// `requestReplayCheck` : contrat de `POST /api/matches/[id]/replay`
    /// (statut et corps). `Err` : base illisible.
    pub async fn request_replay_check(
        &self,
        db: &Db,
        on_found: impl FnOnce(i64) + Send + 'static,
        m: MatchRow,
    ) -> Result<(u16, Value), String> {
        let now = self.0.bv.now_ms();
        let current = to_dto(&m)["video"].clone();
        if m.status != "final" {
            return Ok((
                409,
                json!({ "video": current, "checked": false, "message": "Match pas encore terminé : le replay sera cherché automatiquement après le coup de sifflet final." }),
            ));
        }
        if current["available"] == true && current["kind"] != "mp4" {
            return Ok((
                200,
                json!({ "video": current, "checked": false, "message": "Replay déjà disponible." }),
            ));
        }
        // Une recherche déjà en cours est rejointe sans compter dans le délai.
        if !self.in_progress(m.id) {
            let checked = m
                .video_checked_at
                .as_deref()
                .and_then(crate::time::parse_instant)
                .map_or(0.0, |d| d.timestamp_millis() as f64);
            let last = crate::js::max(
                self.last_request().get(&m.id).copied().unwrap_or(0.0),
                checked,
            );
            let wait = last + MANUAL_CHECK_COOLDOWN_MS - now;
            if wait > 0.0 {
                let s = (wait / 1000.0).ceil();
                return Ok((
                    429,
                    json!({
                        "video": current,
                        "checked": false,
                        "retry_after": crate::api::js_num_value(s),
                        "message": format!("Recherche faite il y a moins de 2 min : nouvelle tentative possible dans {} s.", js_number_string(s)),
                    }),
                ));
            }
        }
        self.remember(m.id, now);

        let id = m.id;
        let fallback = m.clone();
        let (me, d) = (self.clone(), db.clone());
        // Tâche à part : la recherche (et la mise en file de la traduction)
        // va au bout même si la réponse part avant (202).
        let work = tokio::spawn(async move {
            let r = me.search_replay(&d, m, true).await;
            // Replay trouvé : traduction des commentaires en tête de file
            // (`prioritizeFoundReplay` : « Traduction automatique » et backoff
            // des échecs respectés).
            if r.changed {
                on_found(id);
            }
            r
        });
        let r = match tokio::time::timeout(Duration::from_millis(self.0.wait_ms), work).await {
            Err(_) => {
                let video = video_of(db, id, fallback).await?;
                return Ok((
                    202,
                    json!({ "video": video, "checked": true, "pending": true, "message": "Recherche lancée : la page se mettra à jour dès que le replay sera trouvé." }),
                ));
            }
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(format!("recherche interrompue : {e}")),
        };
        let video = video_of(db, id, fallback).await?;
        let message = result_message(&r, &video);
        Ok((
            200,
            json!({ "video": video, "checked": true, "message": message }),
        ))
    }
}

/// Bloc `video` du DTO, relu en base (repli : la ligne connue).
async fn video_of(db: &Db, id: i64, fallback: MatchRow) -> Result<Value, String> {
    let m = db.run(move |c| db::get_match(c, id)).await?;
    Ok(to_dto(&m.unwrap_or(fallback))["video"].clone())
}

/// `humanReplayReason` : raison technique de `findReplay` → phrase pour la fiche.
pub fn human_replay_reason(reason: Option<&str>) -> String {
    match reason {
        None | Some("") | Some("replay non listé") => {
            "pas encore publié sur le site des replays".into()
        }
        Some("iframe ok.ru introuvable") => "la page du replay n’a pas encore de vidéo".into(),
        Some(r) if r.starts_with("vidéo trop courte") => {
            "seul un résumé est en ligne pour l’instant".into()
        }
        Some("flux indisponible") => "la vidéo est encore en cours de traitement".into(),
        Some(r) if r.starts_with("embed ok.ru illisible") => {
            "la vidéo est momentanément illisible".into()
        }
        Some(r) => r.into(),
    }
}

fn result_message(r: &ReplaySearchResult, video: &Value) -> String {
    let Some(lookup) = &r.lookup else {
        return "Recherche impossible pour l’instant (site des replays injoignable). Nouvel essai automatique plus tard.".into();
    };
    let available = video["available"] == true;
    if available && r.changed {
        return if video["kind"] == "mp4" {
            "Replay trouvé ! Version provisoire : la haute définition suivra.".into()
        } else {
            "Replay trouvé !".into()
        };
    }
    if available {
        return "Replay disponible ; la version haute définition n’est pas encore prête.".into();
    }
    format!(
        "Pas encore de replay : {}.",
        human_replay_reason(lookup.reason.as_deref())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenetre_de_revérification() {
        let now = crate::time::parse_instant("2026-10-29T12:00:00.000Z")
            .unwrap()
            .timestamp_millis() as f64;
        let w = replay_recheck_window(now);
        assert_eq!(w.since, "2026-10-08T12:00:00.000Z");
        assert_eq!(w.recent_since, "2026-10-28T21:30:00.000Z");
        assert_eq!(w.recent_recheck_before, "2026-10-29T11:45:00.000Z");
        assert_eq!(w.recheck_before, "2026-10-29T10:05:00.000Z");
    }

    #[test]
    fn raisons_lisibles() {
        assert_eq!(
            human_replay_reason(Some("replay non listé")),
            "pas encore publié sur le site des replays"
        );
        assert_eq!(
            human_replay_reason(None),
            "pas encore publié sur le site des replays"
        );
        assert_eq!(
            human_replay_reason(Some("vidéo trop courte (teaser)")),
            "seul un résumé est en ligne pour l’instant"
        );
        assert_eq!(
            human_replay_reason(Some("embed ok.ru illisible (HTTP 404 pour x)")),
            "la vidéo est momentanément illisible"
        );
        assert_eq!(human_replay_reason(Some("autre")), "autre");
    }
}
