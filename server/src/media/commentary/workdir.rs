//! Dossier de travail d'une vidéo (`${dataDir()}/commentary/<okId>/`) et son
//! complet du match partagé entre traduction et doublage (`startFullAudio`,
//! `waitFullAudio`, `sliceFullAudio`, `dropFullAudio` de `commentary.ts`).

use super::{BoxFut, Commentary};
use crate::media::abort::{sleep, AbortSignal};
use crate::media::audio::{ExtractOptions, SourceHeaders};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

/// `workDir` : `<données>/commentary/<okId>` (caractères hors `[\w-]` remplacés par `_`).
pub fn work_dir(ok_id: &str) -> PathBuf {
    let mut safe = String::with_capacity(ok_id.len());
    for c in ok_id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            safe.push(c);
        } else {
            // Remplacement par unité UTF-16, comme `String.replace` de JavaScript.
            for _ in 0..c.len_utf16() {
                safe.push('_');
            }
        }
    }
    crate::media::local_ai::data_dir()
        .join("commentary")
        .join(safe)
}

/// Fichier du son complet d'une vidéo.
pub fn full_audio_file(ok_id: &str) -> PathBuf {
    work_dir(ok_id).join("full.ogg")
}

/// `fullAudioWanted` : `COMMENTARY_FULL_AUDIO=0` : extraction tronçon par tronçon.
pub fn full_audio_wanted() -> bool {
    std::env::var("COMMENTARY_FULL_AUDIO").ok().as_deref() != Some("0")
}

pub(crate) fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// `readJson` : contenu JSON d'un fichier, `None` s'il est absent ou illisible.
pub(crate) fn read_json(file: &Path) -> Option<Value> {
    let s = std::fs::read_to_string(file).ok()?;
    crate::jsval::js_parse(&s)
}

/// `writeJson` : écrit `<fichier>.part` puis renomme.
pub(crate) fn write_json(file: &Path, value: &Value) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.part", file.display()));
    std::fs::write(&tmp, value.to_string())?;
    std::fs::rename(&tmp, file)
}

/// `pruneWorkDirs` : supprime les dossiers de travail non modifiés depuis
/// `max_age_ms` (10 jours par défaut), sauf ceux de `keep`. Rend leur nombre.
pub fn prune_work_dirs(max_age_ms: Option<f64>, keep: &[PathBuf]) -> usize {
    let max_age = max_age_ms.unwrap_or(10.0 * 24.0 * 3_600_000.0);
    let root = crate::media::local_ai::data_dir().join("commentary");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return 0;
    };
    let mut n = 0;
    for e in entries.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = root.join(e.file_name());
        if keep.contains(&dir) {
            continue;
        }
        let Ok(mtime) = std::fs::metadata(&dir).and_then(|m| m.modified()) else {
            continue; // dossier disparu entre-temps
        };
        let age = SystemTime::now()
            .duration_since(mtime)
            .map_or(0.0, |d| d.as_millis() as f64);
        if age > max_age && std::fs::remove_dir_all(&dir).is_ok() {
            n += 1;
        }
    }
    n
}

// ---------------------------------------------------------------- son complet

/// État d'une extraction du son complet (`FullAudioState`).
#[derive(Debug, Clone, PartialEq)]
pub struct FullAudioState {
    /// Fichier en cours d'écriture, puis fichier final une fois complet.
    pub path: String,
    /// Secondes déjà extraites (∞ : complet).
    pub done_sec: f64,
    pub complete: bool,
    pub failed: Option<String>,
    pub running: bool,
}

pub(crate) type FullAudio = Arc<Mutex<FullAudioState>>;

/// Son complet d'une vidéo en une passe (`extractFull` de [`super::CommentaryDeps`]).
pub type ExtractFullFn = Arc<
    dyn Fn(
            String,
            String,
            ExtractOptions,
            Arc<dyn Fn(f64) + Send + Sync>,
        ) -> BoxFut<Result<(), String>>
        + Send
        + Sync,
>;

fn lock(s: &FullAudio) -> std::sync::MutexGuard<'_, FullAudioState> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

fn complete_state(file: &Path) -> FullAudioState {
    FullAudioState {
        path: path_str(file),
        done_sec: f64::INFINITY,
        complete: true,
        failed: None,
        running: false,
    }
}

/// Résultat de [`Commentary::wait_full_audio`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FullAudioWait {
    Ready,
    Failed,
    /// Position demandée encore loin (> 10 min) devant l'extraction.
    Far,
}

impl Commentary {
    fn full_audios(
        &self,
    ) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, FullAudio>> {
        self.0.full_audio.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// État de l'extraction du son complet d'une vidéo (journaux, tests).
    pub fn full_audio_state(&self, ok_id: &str) -> Option<FullAudioState> {
        self.full_audios().get(ok_id).map(|s| lock(s).clone())
    }

    /// `startFullAudio` : extraction du son complet lancée une fois et
    /// partagée (traduction, doublage), indépendante de tout travail. Déjà sur
    /// disque : rien à faire. Échec : extraction tronçon par tronçon.
    pub(crate) fn start_full_audio(
        &self,
        ok_id: &str,
        source_url: &str,
        headers: SourceHeaders,
        extract_full: ExtractFullFn,
    ) -> FullAudio {
        let file = full_audio_file(ok_id);
        let mut map = self.full_audios();
        if let Some(prev) = map.get(ok_id) {
            let p = lock(prev).clone();
            if p.running || (p.complete && Path::new(&p.path).exists()) {
                return prev.clone();
            }
        }
        if file.exists() {
            let s = Arc::new(Mutex::new(complete_state(&file)));
            map.insert(ok_id.to_string(), s.clone());
            return s;
        }
        let _ = std::fs::create_dir_all(work_dir(ok_id));
        let part = PathBuf::from(format!("{}.part", file.display()));
        let _ = std::fs::remove_file(&part);
        let s: FullAudio = Arc::new(Mutex::new(FullAudioState {
            path: path_str(&part),
            done_sec: 0.0,
            complete: false,
            failed: None,
            running: true,
        }));
        map.insert(ok_id.to_string(), s.clone());
        let t0 = Instant::now();
        let st = s.clone();
        let on_progress: Arc<dyn Fn(f64) + Send + Sync> = Arc::new(move |sec: f64| {
            let mut g = lock(&st);
            g.done_sec = crate::js::max(g.done_sec, sec);
        });
        // Appelée sous le verrou, comme la partie synchrone de la fonction de
        // Node : un autre tronçon qui arrive en même temps voit son état.
        let fut = extract_full(
            source_url.to_string(),
            path_str(&part),
            ExtractOptions {
                headers,
                ..Default::default()
            },
            on_progress,
        );
        drop(map);
        let st = s.clone();
        let ok_id = ok_id.to_string();
        tokio::spawn(async move {
            let r = fut.await;
            let r = r.and_then(|_| std::fs::rename(&part, &file).map_err(|e| e.to_string()));
            match r {
                Ok(()) => {
                    {
                        let mut g = lock(&st);
                        g.path = path_str(&file);
                        g.complete = true;
                        g.done_sec = f64::INFINITY;
                    }
                    println!(
                        "[commentaires] son complet de la vidéo {ok_id} extrait en {} s",
                        crate::js::max(
                            1.0,
                            crate::js::round(t0.elapsed().as_millis() as f64 / 1000.0)
                        )
                    );
                }
                Err(e) => {
                    let failed = super::run::short(&e);
                    lock(&st).failed = Some(failed.clone());
                    let _ = std::fs::remove_file(&part);
                    eprintln!(
                        "[commentaires] son complet de la vidéo {ok_id} impossible ({failed}) : extraction tronçon par tronçon"
                    );
                }
            }
            lock(&st).running = false;
        });
        s
    }

    /// `waitFullAudio` : attend que le son complet couvre jusqu'à `end_sec`
    /// (`COMMENTARY_FULL_AUDIO_POLL_MS`, 500 ms entre deux regards).
    pub(crate) async fn wait_full_audio(
        &self,
        s: &FullAudio,
        end_sec: f64,
        signal: &AbortSignal,
    ) -> FullAudioWait {
        loop {
            {
                let g = lock(s);
                if g.complete {
                    return FullAudioWait::Ready;
                }
                if g.done_sec >= end_sec + 2.0 {
                    return FullAudioWait::Ready;
                }
                if !g.running {
                    return FullAudioWait::Failed;
                }
                if end_sec - g.done_sec > 600.0 {
                    return FullAudioWait::Far;
                }
            }
            if signal.is_aborted() {
                return FullAudioWait::Failed;
            }
            let ms = super::env_num_or("COMMENTARY_FULL_AUDIO_POLL_MS", 500.0);
            tokio::time::sleep(std::time::Duration::from_millis(
                crate::js::max(0.0, ms) as u64
            ))
            .await;
        }
    }

    /// `sliceFullAudio` : découpe `length` s du son complet à partir de `start`
    /// (pour le doublage) s'il est là et couvre la plage ; `false` sinon
    /// (l'appelant lit alors le flux).
    pub async fn slice_full_audio(
        &self,
        ok_id: &str,
        start: f64,
        length: f64,
        out_file: &str,
        signal: Option<AbortSignal>,
    ) -> bool {
        let s = {
            let mut map = self.full_audios();
            if !map.contains_key(ok_id) && full_audio_file(ok_id).exists() {
                map.insert(
                    ok_id.to_string(),
                    Arc::new(Mutex::new(complete_state(&full_audio_file(ok_id)))),
                );
            }
            map.get(ok_id).map(|s| lock(s).clone())
        };
        let Some(s) = s else { return false };
        if !(s.complete || s.done_sec >= start + length + 2.0) || !Path::new(&s.path).exists() {
            return false;
        }
        let cut = self.0.deps.cut.clone();
        let r = match cut {
            Some(cut) => cut(s.path.clone(), start, length, out_file.to_string(), signal).await,
            None => crate::media::audio::cut_audio(&s.path, start, length, out_file, signal).await,
        };
        r.is_ok()
    }

    /// `dropFullAudio` : le son complet ne sert plus (traduction et doublage
    /// finis) : effacé, sauf extraction ou traduction en cours sur cette vidéo.
    pub fn drop_full_audio(&self, ok_id: &str) {
        let translating = self.running_ok_id().as_deref() == Some(ok_id);
        let mut map = self.full_audios();
        if map.get(ok_id).is_some_and(|s| lock(s).running) || translating {
            return;
        }
        map.remove(ok_id);
        let _ = std::fs::remove_file(full_audio_file(ok_id));
    }

    /// Oublie l'état du son complet d'une vidéo, sauf extraction en cours
    /// (`if (!fullAudios.get(okId)?.running) fullAudios.delete(okId)`).
    pub(crate) fn forget_full_audio(&self, ok_id: &str) {
        let mut map = self.full_audios();
        if !map.get(ok_id).is_some_and(|s| lock(s).running) {
            map.remove(ok_id);
        }
    }
}

/// Attente sans signal (pause interrompue) réexportée pour `run`.
pub(crate) async fn pause(ms: f64, signal: &AbortSignal) {
    sleep(crate::js::max(0.0, ms) as u64, Some(signal)).await;
}
