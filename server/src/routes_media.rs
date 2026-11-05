//! Routes des files médias (étapes 6b et 7), équivalents des routes Next :
//! - `GET /api/matches/[id]/subtitles` et `/subtitles.vtt` : sous-titres de la traduction ;
//! - `GET` / `POST /api/matches/[id]/commentary` : statut, lancement, relance ;
//! - `POST /api/matches/[id]/watching` : signe de vie du lecteur ;
//! - `GET` / `POST /api/matches/[id]/sync` : calage et analyse vidéo ;
//! - `GET /api/activity` : panneau « En cours de traitement ».
//!
//! Toutes exigent une session (`guarded`). Les services médias lisent la base
//! de façon synchrone : ils sont appelés par `spawn_blocking`.

use crate::api::{error, js_num_value, js_number, json_response, ok, Query};
use crate::db::{self, MatchRow};
use crate::media::commentary::EnqueueOptions;
use crate::media::commentary_cues::wrap_two_lines;
use crate::routes::{db_error, guarded};
use crate::routes_auth::require_admin;
use crate::routes_match::parse_id;
use crate::settings::{self, Settings};
use crate::state::{AppState, Media};
use crate::writes::{allowed_origins, is_json_content_type, is_origin_allowed};
use axum::body::Body;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

/// Exécute `f` sur les services médias hors du runtime (lectures synchrones de la base).
async fn blocking<T: Send + 'static>(
    st: &AppState,
    f: impl FnOnce(&Media) -> T + Send + 'static,
) -> Result<T, Response> {
    let media = st.media.clone();
    tokio::task::spawn_blocking(move || f(&media))
        .await
        .map_err(|e| db_error(e.to_string()))
}

/// Identifiant valide et match existant, sinon la réponse d'erreur (400 / 404).
async fn match_of(st: &AppState, raw: &str) -> Result<MatchRow, Response> {
    let Some(id) = parse_id(raw) else {
        return Err(error(StatusCode::BAD_REQUEST, "id invalide"));
    };
    match st.db.run(move |c| db::get_match(c, id)).await {
        Ok(Some(m)) => Ok(m),
        Ok(None) => Err(error(StatusCode::NOT_FOUND, "match introuvable")),
        Err(e) => Err(db_error(e)),
    }
}

/// Garde-fous d'une écriture : origine (403), Content-Type JSON (415), corps JSON (400).
async fn json_write(headers: &HeaderMap, body: Body) -> Result<Value, Response> {
    if !is_origin_allowed(headers, &allowed_origins()) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "origine non autorisée pour cette écriture",
        ));
    }
    if !is_json_content_type(headers) {
        return Err(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type application/json requis",
        ));
    }
    // `await req.json()` : tout JSON valide est accepté, BOM retiré au décodage.
    axum::body::to_bytes(body, 1 << 20)
        .await
        .ok()
        .and_then(|b| {
            let s = String::from_utf8_lossy(&b);
            serde_json::from_str::<Value>(s.strip_prefix('\u{feff}').unwrap_or(&s)).ok()
        })
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "JSON invalide"))
}

fn status_of(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::OK)
}

// ---------------------------------------------------------------- sous-titres

/// `GET /api/matches/[id]/subtitles?t=` : sous-titres publiés et statut ;
/// signe de vie du spectateur, ne lance pas la traduction.
pub async fn subtitles(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let q = Query::parse(uri.query());
    // `Number(searchParams.get('t'))` : sans `t`, `Number(null)` vaut 0.
    let t = q.get("t").map_or(0.0, js_number);
    let fut = async {
        let m = match match_of(&st, &raw).await {
            Ok(m) => m,
            Err(r) => return r,
        };
        let id = m.id;
        let admin = require_admin(&st, &headers).await.is_ok();
        let r = blocking(&st, move |md| {
            let c = &md.commentary;
            c.touch_viewer_by(id, t.is_finite().then_some(t), admin);
            // En file derrière le match d'une fiche quittée : celui-ci cède la place.
            c.nudge(id);
            (c.served_cues(id), c.status(id).to_json())
        })
        .await;
        let (cues, status) = match r {
            Ok(v) => v,
            Err(r) => return r,
        };
        let subs: Vec<Value> = cues
            .iter()
            .map(|c| {
                let mut o = json!({
                    "seq": c.seq,
                    "video_ts": js_num_value(c.start_ts),
                    "end_ts": js_num_value(c.end_ts),
                    "text": c.text_fr,
                    "speaker": "",
                    "kind": "voice",
                });
                if c.emphasis != 0 {
                    o["emphasis"] = Value::from(c.emphasis);
                }
                // Commentateur (n° de voix) : une couleur par commentateur à l'écran.
                if let Some(k) = c.speaker {
                    o["voice"] = Value::from(k);
                }
                o
            })
            .collect();
        ok(json!({
            "match_id": id,
            "count": subs.len(),
            "subtitles": subs,
            "commentary": status,
        }))
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `vttTimestamp`.
pub fn vtt_timestamp(sec: f64) -> String {
    let ms = crate::js::max(0.0, crate::js::round(sec * 1000.0));
    let ms = if ms.is_finite() { ms as u64 } else { 0 };
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        (ms % 3_600_000) / 60_000,
        (ms % 60_000) / 1000,
        ms % 1000
    )
}

fn escape_vtt(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace("-->", "→")
}

/// Ligne d'un export WebVTT (`seq`, `video_ts`, `end_ts`, `text_fr`, `speaker`).
pub struct VttCue {
    pub seq: i64,
    pub video_ts: f64,
    pub end_ts: Option<f64>,
    pub text_fr: String,
    pub speaker: String,
}

/// `toWebVtt` : en-tête, note de titre facultative, sous-titres triés par
/// position puis par numéro.
pub fn to_web_vtt(subs: &[VttCue], title: &str) -> String {
    let mut out = vec!["WEBVTT".to_string()];
    if !title.is_empty() {
        out.push(format!("NOTE {}", title.replace("-->", "→")));
    }
    out.push(String::new());
    let mut sorted: Vec<&VttCue> = subs.iter().collect();
    sorted.sort_by(|a, b| {
        let d = a.video_ts - b.video_ts;
        let d = if d.is_nan() { 0.0 } else { d };
        d.partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.seq.cmp(&b.seq))
    });
    for (i, s) in sorted.iter().enumerate() {
        let end = crate::js::max(s.end_ts.unwrap_or(s.video_ts + 3.0), s.video_ts + 0.5);
        out.push((i + 1).to_string());
        out.push(format!(
            "{} --> {}",
            vtt_timestamp(s.video_ts),
            vtt_timestamp(end)
        ));
        out.push(if s.speaker.is_empty() {
            escape_vtt(&s.text_fr)
        } else {
            format!("<v {}>{}", escape_vtt(&s.speaker), escape_vtt(&s.text_fr))
        });
        out.push(String::new());
    }
    out.join("\n")
}

/// `GET /api/matches/[id]/subtitles.vtt` : export WebVTT des sous-titres publiés.
pub async fn subtitles_vtt(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        let m = match match_of(&st, &raw).await {
            Ok(m) => m,
            Err(r) => return r,
        };
        let id = m.id;
        let cues = match blocking(&st, move |md| md.commentary.served_cues(id)).await {
            Ok(c) => c,
            Err(r) => return r,
        };
        let subs: Vec<VttCue> = cues
            .into_iter()
            .map(|c| VttCue {
                seq: c.seq,
                video_ts: c.start_ts,
                end_ts: Some(c.end_ts),
                text_fr: wrap_two_lines(&c.text_fr, 42),
                // `<v Commentateur 1>` : les lecteurs WebVTT peuvent les distinguer.
                speaker: c
                    .speaker
                    .map(|k| format!("Commentateur {}", k + 1))
                    .unwrap_or_default(),
            })
            .collect();
        let body = to_web_vtt(
            &subs,
            &format!("BasketLand VF — {} @ {}", m.away_name, m.home_name),
        );
        let mut res = (StatusCode::OK, body).into_response();
        let h = res.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/vtt; charset=utf-8"),
        );
        if let Ok(v) =
            HeaderValue::from_str(&format!("inline; filename=\"basketland-{id}-fr.vtt\""))
        {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        res
    };
    guarded(&st, &uri, &headers, fut).await
}

// ---------------------------------------------------------------- traduction

/// `GET /api/matches/[id]/commentary` : statut seul, sans effet de bord.
pub async fn commentary_get(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let fut = async {
        let id = match match_of(&st, &raw).await {
            Ok(m) => m.id,
            Err(r) => return r,
        };
        match blocking(&st, move |md| md.commentary.status(id).to_json()).await {
            Ok(s) => ok(json!({ "commentary": s })),
            Err(r) => r,
        }
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `POST /api/matches/[id]/commentary` : `{ action: 'start' }` (lancement
/// automatique à la lecture, mené jusqu'au bout), `{ action: 'start',
/// manual: true }` (clic « Sous-titrer ce match » ou « Reprendre la
/// traduction »), `{ action: 'stop' }` (« Arrêter la traduction » : plus de
/// relance à la lecture jusqu'à une reprise), `{ action: 'retry' }`
/// (administrateurs : piste refaite).
pub async fn commentary_post(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let fut = async {
        let id = match match_of(&st, &raw).await {
            Ok(m) => m.id,
            Err(r) => return r,
        };
        let body = match json_write(&headers, body).await {
            Ok(b) => b,
            Err(r) => return r,
        };
        let action = body.get("action").and_then(Value::as_str);
        if !matches!(action, Some("start" | "retry" | "stop")) {
            return error(
                StatusCode::BAD_REQUEST,
                "action invalide (attendu : 'start', 'retry' ou 'stop')",
            );
        }
        let enqueue = |opts: EnqueueOptions| {
            blocking(&st, move |md| {
                md.commentary.touch_viewer(id, None);
                let r = md.commentary.enqueue(id, opts);
                let code = if r.queued { 202 } else { 200 };
                (
                    code,
                    json!({ "commentary": md.commentary.status(id).to_json(), "message": r.message }),
                )
            })
        };
        let reply = |r: Result<(u16, Value), Response>| match r {
            Ok((code, v)) => json_response(status_of(code), &v),
            Err(r) => r,
        };
        if action == Some("stop") {
            // « Arrêter la traduction » (tout utilisateur connecté) : ce qui est traduit reste.
            let r = blocking(&st, move |md| {
                let (_, message) = md.commentary.stop(id);
                (
                    200,
                    json!({ "commentary": md.commentary.status(id).to_json(), "message": message }),
                )
            })
            .await;
            return reply(r);
        }
        if action == Some("retry") {
            // Écrase une traduction existante : réservé aux administrateurs (401 / 403 sinon).
            if let Err(r) = require_admin(&st, &headers).await {
                return r;
            }
            return reply(
                enqueue(EnqueueOptions {
                    priority: true,
                    force: true,
                    explicit: true,
                })
                .await,
            );
        }
        if body.get("manual") == Some(&Value::Bool(true)) {
            // Clic explicite : mis en file même pendant le délai d'attente après
            // un échec, et traduit jusqu'au bout même si l'on quitte la fiche.
            return reply(
                enqueue(EnqueueOptions {
                    priority: true,
                    force: false,
                    explicit: true,
                })
                .await,
            );
        }
        let auto = settings::auto_translate_enabled(&Settings::read(&st.db).await);
        let r = blocking(&st, move |md| {
            let c = &md.commentary;
            c.touch_viewer(id, None); // demandé depuis la fiche : quelqu'un regarde
            if !auto {
                // Page ouverte avant le changement de réglage : la fiche affiche alors le bouton.
                return (
                    200,
                    json!({
                        "commentary": c.status(id).to_json(),
                        "autoTranslate": false,
                        "message": "Traduction automatique désactivée : lancez-la avec « Sous-titrer ce match ».",
                    }),
                );
            }
            if c.stopped(id) {
                // Arrêtée à la demande : la lecture ne la relance pas.
                return (
                    200,
                    json!({
                        "commentary": c.status(id).to_json(),
                        "message": "Traduction arrêtée : « Reprendre la traduction » la relance.",
                    }),
                );
            }
            // Lancement à la lecture : en tête de file, sauf piste prête ou
            // backoff après un échec ; puis jusqu'au bout, même si la lecture
            // s'arrête ou que la fiche est quittée (« Arrêter la traduction »
            // l'interrompt).
            let before = c.status(id).status;
            c.prioritize_on_view_with(id, true);
            let after = c.status(id);
            let started = matches!(after.status, "running" | "queued");
            let message = if started {
                "Traduction des commentaires lancée".to_string()
            } else {
                format!("Pas de lancement ({before})")
            };
            (
                if started { 202 } else { 200 },
                json!({ "commentary": after.to_json(), "message": message }),
            )
        })
        .await;
        reply(r)
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `POST /api/matches/[id]/watching` `{ t }` : signe de vie du lecteur pendant la lecture (204).
pub async fn watching(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let fut = async {
        let Some(id) = parse_id(&raw) else {
            return error(StatusCode::BAD_REQUEST, "id invalide");
        };
        if !is_origin_allowed(&headers, &allowed_origins()) {
            return error(StatusCode::FORBIDDEN, "origine non autorisée");
        }
        // Corps facultatif : `JSON.parse(text.slice(0, 500))`, `t` nombre fini.
        let t = axum::body::to_bytes(body, 1 << 20)
            .await
            .ok()
            .and_then(|b| {
                let s = String::from_utf8_lossy(&b);
                let s = crate::js::slice_utf16(s.strip_prefix('\u{feff}').unwrap_or(&s), 500);
                serde_json::from_str::<Value>(&s).ok()
            })
            .and_then(|v| v.get("t").and_then(Value::as_f64))
            .filter(|t| t.is_finite());
        let admin = require_admin(&st, &headers).await.is_ok();
        if let Err(r) = blocking(&st, move |md| {
            let c = &md.commentary;
            c.touch_viewer_by(id, t, admin);
            // Lecture d'un administrateur : un travail explicite en cours
            // sur un autre match cède la place si celui-ci est en file.
            c.nudge(id);
        })
        .await
        {
            return r;
        }
        StatusCode::NO_CONTENT.into_response()
    };
    guarded(&st, &uri, &headers, fut).await
}

// ---------------------------------------------------------------- calage, activité

/// `GET /api/matches/[id]/sync`.
pub async fn sync_get(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let db = st.db.clone();
    let fut = async {
        blocking(&st, move |md| {
            crate::sync_route::get(&db, &md.analysis, &raw)
        })
        .await
        .unwrap_or_else(|r| r)
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `POST /api/matches/[id]/sync`.
pub async fn sync_post(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let db = st.db.clone();
    let fut = async {
        let bytes = axum::body::to_bytes(body, 1 << 20)
            .await
            .map(|b| b.to_vec())
            .unwrap_or_default();
        let h = headers.clone();
        blocking(&st, move |md| {
            crate::sync_route::post(&db, &md.analysis, &raw, &h, &bytes)
        })
        .await
        .unwrap_or_else(|r| r)
    };
    guarded(&st, &uri, &headers, fut).await
}

/// `GET /api/activity` : traductions et analyses en cours ou en attente.
pub async fn activity(
    State(st): State<AppState>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Response {
    let db = st.db.clone();
    let fut = async {
        let r = blocking(&st, move |md| {
            db.with(|c| crate::activity::current_activity(c, md))
        })
        .await;
        match r {
            Ok(Ok(v)) => ok(v),
            Ok(Err(e)) => db_error(e),
            Err(r) => r,
        }
    };
    guarded(&st, &uri, &headers, fut).await
}
