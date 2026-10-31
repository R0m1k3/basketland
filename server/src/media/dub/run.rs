//! Exécution d'un travail de doublage (`runDub` de `dub.ts`) : les tronçons
//! traduits pas encore doublés (ou retraduits depuis), à partir de la
//! position du spectateur, chacun publié dès qu'il est monté. Le moteur de
//! voix est ouvert au premier besoin et fermé à la fin, sur erreur ou quand
//! le travail cède la place.

use super::speakers::{
    assign_roles, assign_speakers, parse_speakers, roles_used, serialize_speakers, voice_for,
    AssignOptions, SpeakerState, VoiceRole,
};
use super::text::{
    cues_signature, emphasize, fit_cue, group_cues, js_json, next_dub_chunk, num, place_clips,
    speech_ranges, to_fixed, SLOT_TAIL_SEC,
};
use super::{
    clock, dub_dir, short, AssembleClip, Dub, DubControl, DubDeps, DubFailureKind, DubJob,
    DubOutcome, DubProgress, DubProgressFn, DubVoiceSession, DubYield,
};
use crate::commentary_db::{self as cdb, commentary_key, CommentaryCueRow};
use crate::dub_db::{self as ddb, DubChunkInput};
use crate::js;
use crate::jsval::js_number_string;
use crate::media::abort::AbortSignal;
use crate::media::audio::{ExtractOptions, SourceHeaders};
use crate::media::commentary::{audio_sources, ExtractRequest, StreamInfo};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Tronçon traduit publié, ses sous-titres, et s'il est déjà doublé (à jour) (`PlannedChunk`).
struct PlannedChunk {
    idx: i64,
    keep_from: f64,
    /// Fin de la zone du tronçon ; +∞ pour le dernier.
    keep_to: f64,
    cues: Vec<CommentaryCueRow>,
    sig: String,
    done: bool,
}

/// Fin anormale d'un travail : céder la place, flux inaccessible, moteur
/// de voix indisponible, ou autre erreur (exception de Node).
enum Stop {
    Yield(DubYield),
    Stream(String),
    Voice(String),
    Other(String),
}

impl From<String> for Stop {
    fn from(e: String) -> Self {
        Stop::Other(e)
    }
}

fn check_aborted(signal: &AbortSignal) -> Result<(), Stop> {
    if signal.is_aborted() {
        Err(Stop::Other("travail interrompu".into()))
    } else {
        Ok(())
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Plage de parole, en JSON de Node.
fn speech_json(ranges: &[[f64; 2]]) -> String {
    js_json(&Value::Array(
        ranges
            .iter()
            .map(|[a, b]| Value::Array(vec![num(*a), num(*b)]))
            .collect(),
    ))
}

/// État d'un travail (variables locales de `runDub`).
struct Work<'a> {
    dub: &'a Dub,
    job: &'a DubJob,
    deps: &'a DubDeps,
    ctl: &'a DubControl,
    signal: AbortSignal,
    progress: DubProgressFn,
    ok_id: String,
    dir: PathBuf,
    tmp: PathBuf,
    state: SpeakerState,
    session: Option<DubVoiceSession>,
    stream: Option<StreamInfo>,
    dubbed: usize,
    overruns: usize,
    failed_cues: usize,
    total: f64,
    current: DubProgress,
}

impl Work<'_> {
    fn report(&mut self, p: DubProgress) {
        self.current = p.clone();
        (self.progress)(p);
    }

    fn step(&mut self, text: &str) {
        let p = DubProgress {
            step: Some(text.to_string()),
            ..self.current.clone()
        };
        self.report(p);
    }

    fn yield_check(&self) -> Result<(), Stop> {
        match (self.ctl.yield_reason)() {
            Some(why) => Err(Stop::Yield(why)),
            None => Ok(()),
        }
    }

    async fn open_session(&mut self) -> Result<DubVoiceSession, Stop> {
        if let Some(s) = &self.session {
            return Ok(s.clone());
        }
        let s = match (self.deps.open_voice)(self.signal.clone()).await {
            Ok(s) => s,
            Err(e) => {
                check_aborted(&self.signal)?;
                return Err(Stop::Voice(short(&e)));
            }
        };
        self.dub.log(&format!(
            "[doublage] match {} : moteur de voix prêt (voix {})",
            self.job.match_id,
            s.voices.join(", ")
        ));
        self.session = Some(s.clone());
        Ok(s)
    }

    async fn close_session(&mut self) {
        if let Some(s) = self.session.take() {
            (s.close)().await;
        }
    }

    /// Audio d'une plage de la vidéo (toutes les sources, puis une re-résolution du flux).
    async fn extract(&mut self, start: f64, length: f64, out: &str) -> Result<(), Stop> {
        let mut last_err = String::new();
        for round in 0..2 {
            if self.stream.is_none() || round == 1 {
                match (self.deps.resolve_stream)(self.ok_id.clone(), round == 1).await {
                    Ok(st) => self.stream = Some(st),
                    Err(e) => {
                        last_err = format!("résolution du flux : {}", short(&e));
                        continue;
                    }
                }
            }
            let sources = self.stream.as_ref().map(audio_sources).unwrap_or_default();
            if sources.is_empty() {
                last_err = "aucune source audio (ni HLS ni MP4)".into();
            }
            for src in sources.iter().take(3) {
                check_aborted(&self.signal)?;
                let req = ExtractRequest {
                    source_url: src.url.clone(),
                    start,
                    length,
                    out_file: out.to_string(),
                    options: ExtractOptions {
                        headers: SourceHeaders {
                            user_agent: Some(crate::http::BROWSER_UA.into()),
                            referer: Some(crate::okru::OK_REFERER.into()),
                        },
                        signal: Some(self.signal.clone()),
                        timeout: None,
                    },
                };
                match (self.deps.extract)(req).await {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = short(&e),
                }
            }
        }
        Err(Stop::Stream(last_err))
    }

    /// Double un tronçon et le publie (fichiers temporaires toujours effacés).
    async fn dub_chunk(
        &mut self,
        ch: &PlannedChunk,
        all_cues: &[CommentaryCueRow],
        rank: usize,
    ) -> Result<(), Stop> {
        let mut files: Vec<PathBuf> = Vec::new();
        let r = self.dub_chunk_files(ch, all_cues, rank, &mut files).await;
        for f in files {
            let _ = std::fs::remove_file(f);
        }
        r
    }

    async fn dub_chunk_files(
        &mut self,
        ch: &PlannedChunk,
        all_cues: &[CommentaryCueRow],
        rank: usize,
        files: &mut Vec<PathBuf>,
    ) -> Result<(), Stop> {
        let id = self.job.match_id;
        let cues = &ch.cues;
        struct Clip {
            file: String,
            start: f64,
            slot_end: f64,
            fitted: f64,
            tempo: f64,
            overrun: bool,
        }
        let mut clips: Vec<Clip> = Vec::new();
        let mut talk: Vec<(i64, f64)> = Vec::new();
        let mut failed = 0usize;
        let mut last_err = String::new();
        if !cues.is_empty() {
            // 1. Audio d'origine du tronçon (empreintes vocales) : découpé dans le
            // son complet du match extrait par la traduction, sinon lu dans le flux.
            let ex_start = js::max(0.0, js::min(ch.keep_from, cues[0].start_ts) - 0.5);
            let mut ex_end = if ch.keep_to.is_finite() {
                ch.keep_to
            } else {
                0.0
            };
            for c in cues {
                ex_end = js::max(ex_end, c.end_ts);
            }
            let ex_end = ex_end + 0.5;
            let ex_len = ((ex_end - ex_start) * 10.0).ceil() / 10.0;
            let audio = self.tmp.join(format!("source-{}.ogg", ch.idx));
            files.push(audio.clone());
            let local = match &self.deps.local_audio {
                Some(f) => {
                    f(
                        self.ok_id.clone(),
                        ex_start,
                        ex_len,
                        s(&audio),
                        self.signal.clone(),
                    )
                    .await
                }
                None => false,
            };
            if !local {
                self.step("extraction du son d’origine");
                self.extract(ex_start, ex_len, &s(&audio)).await?;
            }
            self.yield_check()?;
            if self.session.is_none() {
                self.step("démarrage du moteur de voix");
            }
            let voice = self.open_session().await?;
            self.step("reconnaissance des voix des commentateurs");
            // 2. Empreinte de chaque réplique ; en échec, voix de la précédente.
            let mut embeddings: Vec<Option<Vec<f64>>> = vec![None; cues.len()];
            let mut f0: Vec<Option<f64>> = vec![None; cues.len()];
            let mut female: Vec<Option<f64>> = Vec::new();
            let segments: Vec<(f64, f64)> = cues
                .iter()
                .map(|c| {
                    (
                        js::max(0.0, c.start_ts - ex_start),
                        js::max(0.0, c.end_ts - ex_start),
                    )
                })
                .collect();
            match (voice.embed)(s(&audio), segments, self.signal.clone()).await {
                Ok(r) => {
                    embeddings = (0..cues.len())
                        .map(|i| r.embeddings.get(i).cloned().flatten())
                        .collect();
                    f0 = (0..cues.len())
                        .map(|i| r.f0.get(i).copied().flatten())
                        .collect();
                    if let Some(fe) = &r.female {
                        female = (0..cues.len())
                            .map(|i| fe.get(i).copied().flatten())
                            .collect();
                    }
                }
                Err(e) => {
                    check_aborted(&self.signal)?;
                    self.dub.log_error(&format!(
                        "[doublage] match {id} : empreintes vocales impossibles (tronçon {}) : {}",
                        ch.idx,
                        short(&e)
                    ));
                }
            }
            let _ = std::fs::remove_file(&audio);
            // 3. Locuteurs et voix (stables pour tout le match).
            let durations: Vec<f64> = cues.iter().map(|c| c.end_ts - c.start_ts).collect();
            let speakers = assign_speakers(
                &mut self.state,
                &durations,
                &embeddings,
                &f0,
                &female,
                AssignOptions::default(),
            );
            for sid in assign_roles(&mut self.state, &voice.voices, None, None) {
                if let Some(sp) = self.state.speakers.iter().find(|x| x.id == sid) {
                    self.dub.log(&format!(
                        "[doublage] match {id} : locuteur #{} reconnu comme une femme (P(femme) {} sur {} s) : voix {} → F",
                        sp.id,
                        to_fixed(sp.female_p.unwrap_or(0.0), 2).replace('.', ","),
                        js_number_string(js::round(sp.female_sec.unwrap_or(0.0))),
                        sp.role_before.map_or("undefined", VoiceRole::as_str),
                    ));
                }
            }
            // 4-5. Synthèse et calage : les morceaux d'une même phrase d'une seule traite (intonation).
            let groups = group_cues(cues, &speakers, None, None);
            let to_say = groups.len();
            for (said, g) in groups.iter().enumerate() {
                let first = &cues[g.idx[0]];
                let last_cue = &cues[g.idx[g.idx.len() - 1]];
                self.step(&format!("synthèse des répliques : {} / {to_say}", said + 1));
                self.yield_check()?;
                check_aborted(&self.signal)?;
                let sp_id = speakers.get(g.idx[0]).copied().flatten();
                let sp = sp_id.and_then(|i| self.state.speakers.iter().find(|x| x.id == i));
                let role = sp.and_then(|x| x.role).unwrap_or(VoiceRole::A);
                let sp_id = sp.map(|x| x.id);
                let out = self.tmp.join(format!("cue-{}.wav", first.seq));
                files.push(out.clone());
                let r = (voice.synth)(
                    emphasize(&g.text, Some(g.emphasis)),
                    voice_for(role, &voice.voices),
                    s(&out),
                    self.signal.clone(),
                    Some(g.emphasis),
                )
                .await
                .and_then(|(d, _)| {
                    if d > 0.0 {
                        Ok(d)
                    } else {
                        Err("synthèse vide".to_string())
                    }
                });
                let duration = match r {
                    Ok(d) => d,
                    Err(e) => {
                        check_aborted(&self.signal)?;
                        failed += g.idx.len();
                        last_err = short(&e);
                        self.dub.log_error(&format!(
                            "[doublage] match {id} : réplique {} ignorée ({}) : {last_err}",
                            first.seq,
                            clock(first.start_ts)
                        ));
                        continue;
                    }
                };
                let k = all_cues.iter().position(|x| x.seq == last_cue.seq);
                let next_start = k.and_then(|k| all_cues.get(k + 1)).map(|c| c.start_ts);
                let fit = fit_cue(duration, g.start, g.end, next_start);
                clips.push(Clip {
                    file: s(&out),
                    start: g.start,
                    slot_end: g.start + fit.slot,
                    fitted: fit.fitted,
                    tempo: fit.tempo,
                    overrun: fit.overrun,
                });
                if let Some(sid) = sp_id {
                    match talk.iter_mut().find(|(i, _)| *i == sid) {
                        Some(t) => t.1 += g.end - g.start,
                        None => talk.push((sid, g.end - g.start)),
                    }
                }
            }
            if to_say > 0 && clips.is_empty() {
                return Err(Stop::Other(format!(
                    "synthèse impossible pour tout le tronçon {} ({failed} réplique(s)) : {last_err}",
                    ch.idx
                )));
            }
        }
        // 6. Montage : silence + répliques à leur place, sur toute la zone du
        // tronçon (un peu plus si la première réplique commence juste avant, ou
        // si la dernière déborde).
        let at = place_clips(
            &clips
                .iter()
                .map(|c| (c.start, c.fitted))
                .collect::<Vec<_>>(),
            None,
        );
        let start = if clips.is_empty() {
            ch.keep_from
        } else {
            (js::min(ch.keep_from, at[0]) * 1000.0).floor() / 1000.0
        };
        let last_cue_end = cues
            .last()
            .map_or(ch.keep_from + 1.0, |c| c.end_ts + SLOT_TAIL_SEC);
        let last_clip_end = clips
            .iter()
            .enumerate()
            .map(|(i, c)| at[i] + c.fitted)
            .fold(None, |m: Option<f64>, x| {
                Some(m.map_or(x, |m| js::max(m, x)))
            })
            .unwrap_or(0.0);
        let end = js::round(
            js::max(
                if ch.keep_to.is_finite() {
                    ch.keep_to
                } else {
                    last_cue_end
                },
                last_clip_end,
            ) * 1000.0,
        ) / 1000.0;
        let file = format!("chunk-{}.m4a", ch.idx);
        let out = self.dir.join(&file);
        let part = PathBuf::from(format!("{}.part", out.display()));
        files.push(part.clone());
        check_aborted(&self.signal)?;
        self.step("montage de la piste");
        (self.deps.assemble)(
            clips
                .iter()
                .enumerate()
                .map(|(i, c)| AssembleClip {
                    file: c.file.clone(),
                    at: at[i] - start,
                    tempo: c.tempo,
                })
                .collect(),
            end - start,
            s(&part),
            self.signal.clone(),
        )
        .await?;
        if std::fs::metadata(&part).map_or(0, |m| m.len()) == 0 {
            return Err(Stop::Other(format!("montage vide (tronçon {})", ch.idx)));
        }
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        // 7. Publication.
        let n = clips
            .iter()
            .enumerate()
            .filter(|(i, c)| c.overrun || at[*i] + c.fitted > c.slot_end + 0.01)
            .count();
        self.overruns += n;
        self.failed_cues += failed;
        let speech = speech_ranges(
            &clips
                .iter()
                .enumerate()
                .map(|(i, c)| [at[i], at[i] + c.fitted])
                .collect::<Vec<_>>(),
            None,
        );
        let voices = js_json(&Value::Array(
            roles_used(&self.state)
                .into_iter()
                .map(|r| Value::from(r.as_str()))
                .collect(),
        ));
        let speakers = js_json(&serialize_speakers(&self.state));
        let input = DubChunkInput {
            idx: ch.idx,
            start,
            end,
            file,
            speech_json: speech_json(&speech),
            cues_sig: ch.sig.clone(),
        };
        self.dub
            .db()
            .with(|c| ddb::publish_dub_chunk(c, id, &input, &voices, &speakers))?;
        self.dubbed += 1;
        let mut who = talk.clone();
        who.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let who: Vec<String> = who
            .iter()
            .map(|(sid, secs)| {
                format!(
                    "#{sid}→{} {} s",
                    self.state
                        .speakers
                        .iter()
                        .find(|x| x.id == *sid)
                        .and_then(|x| x.role)
                        .map_or("?", VoiceRole::as_str),
                    js_number_string(js::round(*secs))
                )
            })
            .collect();
        let who = who.join(", ");
        self.dub.log(&format!(
            "[doublage] match {id} : tronçon {rank}/{} ({}) : {} réplique(s){}{}{}",
            js_number_string(self.total),
            clock(ch.keep_from),
            clips.len(),
            if who.is_empty() {
                String::new()
            } else {
                format!(", locuteurs {who}")
            },
            if n > 0 {
                format!(" ; {n} dépassement(s)")
            } else {
                String::new()
            },
            if failed > 0 {
                format!(" ; {failed} réplique(s) en échec")
            } else {
                String::new()
            },
        ));
        Ok(())
    }

    async fn run(&mut self, track_total: f64) -> Result<(), Stop> {
        let mut first = true;
        loop {
            check_aborted(&self.signal)?;
            let (chunks, cues) = self.dub.plan(self.job.match_id);
            let todo: Vec<&PlannedChunk> = chunks.iter().filter(|c| !c.done).collect();
            self.total = js::max(track_total, chunks.len() as f64);
            if todo.is_empty() {
                return Ok(());
            }
            self.yield_check()?;
            let target = (self.ctl.target)();
            let ranges: Vec<(f64, f64)> = todo.iter().map(|c| (c.keep_from, c.keep_to)).collect();
            let Some(k) = next_dub_chunk(&ranges, target) else {
                return Ok(());
            };
            let ch = todo[k];
            if first {
                first = false;
                self.dub.log(&format!(
                    "[doublage] match {} : démarrage ({} tronçon(s) à doubler sur {} traduit(s))",
                    self.job.match_id,
                    todo.len(),
                    chunks.len()
                ));
            }
            let done = chunks.len() - todo.len();
            self.report(DubProgress {
                done: done as f64,
                total: self.total,
                chunk: Some(ch.idx),
                step: None,
            });
            self.dub_chunk(ch, &cues, done + 1).await?;
        }
    }
}

impl Dub {
    /// `planDub` : tronçons traduits publiés, leurs sous-titres, et s'ils
    /// sont déjà doublés (à jour) ; et tous les sous-titres du match.
    fn plan(&self, match_id: i64) -> (Vec<PlannedChunk>, Vec<CommentaryCueRow>) {
        let cues = self
            .db()
            .with(|c| cdb::get_commentary_cues(c, match_id))
            .unwrap_or_default();
        let mut by_chunk: HashMap<i64, Vec<CommentaryCueRow>> = HashMap::new();
        for c in &cues {
            // Voir `chunk_seq_base`.
            let idx = (c.seq as f64 / 100_000.0).floor() as i64 - 1;
            by_chunk.entry(idx).or_default().push(c.clone());
        }
        let dubbed: HashMap<i64, String> = self
            .db()
            .with(|c| ddb::get_dub_chunks(c, match_id))
            .unwrap_or_default()
            .into_iter()
            .map(|d| (d.idx, d.cues_sig))
            .collect();
        let chunks = self
            .db()
            .with(|c| cdb::get_commentary_chunks(c, match_id))
            .unwrap_or_default()
            .into_iter()
            .map(|r| {
                let mut list = by_chunk.remove(&r.idx).unwrap_or_default();
                list.sort_by(|a, b| {
                    let d = a.start_ts - b.start_ts;
                    let d = if d != 0.0 && !d.is_nan() {
                        d
                    } else {
                        (a.seq - b.seq) as f64
                    };
                    d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
                });
                let sig = cues_signature(&list);
                PlannedChunk {
                    idx: r.idx,
                    keep_from: r.keep_from,
                    keep_to: if r.keep_to >= 1e8 {
                        f64::INFINITY
                    } else {
                        r.keep_to
                    },
                    done: dubbed.get(&r.idx) == Some(&sig),
                    cues: list,
                    sig,
                }
            })
            .collect();
        (chunks, cues)
    }

    /// `runDub` : un travail (voir le module). `Err` : échec qui n'est ni une
    /// panne du flux ni du moteur de voix (exception de Node).
    pub async fn run_dub(
        &self,
        job: &DubJob,
        progress: DubProgressFn,
        signal: AbortSignal,
        deps: &DubDeps,
        ctl: &DubControl,
    ) -> Result<DubOutcome, String> {
        let t0 = Instant::now();
        let Some(ok_id) = self
            .get_match(job.match_id)
            .and_then(|m| m.video_ok_id)
            .filter(|s| !s.is_empty())
        else {
            return Ok(DubOutcome::failed(
                DubFailureKind::Erreur,
                "Doublage impossible : pas de replay",
            ));
        };
        let Some(track) = self.current_track(job.match_id) else {
            return Ok(DubOutcome::ok("aucun sous-titre français à doubler"));
        };
        let key = commentary_key(&track);
        let (reset, opened) = self
            .db()
            .with(|c| ddb::open_dub_track(c, job.match_id, &ok_id, &key))?;
        let dir = dub_dir(job.match_id);
        if reset {
            let _ = std::fs::remove_dir_all(&dir);
            self.log(&format!(
                "[doublage] match {} : la piste traduite a changé, doublage effacé et refait",
                job.match_id
            ));
        }
        let tmp = dir.join("tmp");
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let mut w = Work {
            dub: self,
            job,
            deps,
            ctl,
            signal,
            progress,
            ok_id: ok_id.clone(),
            dir,
            tmp: tmp.clone(),
            state: parse_speakers(Some(&opened.speakers)),
            session: None,
            stream: None,
            dubbed: 0,
            overruns: 0,
            failed_cues: 0,
            total: 0.0,
            current: DubProgress::default(),
        };
        let r = w.run(track.chunks_total.unwrap_or(0.0)).await;
        w.close_session().await;
        let _ = std::fs::remove_dir_all(&tmp);
        match r {
            Ok(()) => {}
            Err(Stop::Yield(why)) => {
                return Ok(DubOutcome::yielded(
                    why,
                    format!(
                        "en pause ({} tronçon(s) doublé(s)) : {}",
                        w.dubbed,
                        why.text()
                    ),
                ))
            }
            Err(Stop::Stream(m)) => {
                return Ok(DubOutcome::failed(
                    DubFailureKind::Reseau,
                    format!(
                        "Flux vidéo inaccessible pour le doublage ({m}) : nouvel essai automatique"
                    ),
                ))
            }
            Err(Stop::Voice(m)) => {
                return Ok(DubOutcome::failed(
                    DubFailureKind::Service,
                    format!("Moteur de voix indisponible : {m} (nouvel essai automatique)"),
                ))
            }
            Err(Stop::Other(m)) => return Err(m),
        }
        // Doublage complet : piste traduite complète et tous ses tronçons doublés.
        let complete = self
            .current_track(job.match_id)
            .is_some_and(|t| t.complete == 1)
            && self.plan(job.match_id).0.iter().all(|c| c.done);
        self.db()
            .with(|c| ddb::set_dub_complete(c, job.match_id, complete))?;
        if complete && deps.local_audio.is_some() {
            // Son complet gardé pour le doublage : il ne sert plus.
            self.commentary().drop_full_audio(&ok_id);
        }
        let minutes = js::max(1.0, js::round(t0.elapsed().as_millis() as f64 / 60_000.0));
        let voices: Vec<&str> = roles_used(&w.state)
            .into_iter()
            .map(VoiceRole::as_str)
            .collect();
        Ok(DubOutcome::ok(format!(
            "{} tronçon(s) doublé(s){} ; voix {}{}{} ; {} min",
            w.dubbed,
            if complete { ", doublage complet" } else { "" },
            if voices.is_empty() {
                "—".to_string()
            } else {
                voices.join(", ")
            },
            if w.overruns > 0 {
                format!(" ; {} dépassement(s)", w.overruns)
            } else {
                String::new()
            },
            if w.failed_cues > 0 {
                format!(" ; {} réplique(s) en échec", w.failed_cues)
            } else {
                String::new()
            },
            js_number_string(minutes)
        )))
    }
}
