//! Processus enfants des tâches lourdes : priorité CPU basse
//! (`procPriority.ts`), arrêt propre (`stopChild` de `localAi.ts`), et
//! processus de travail Python qui parlent JSON, une ligne par message, sur
//! stdin/stdout (Whisper, voix) — protocole de `scripts/whisper_worker.py`
//! et `scripts/voice_worker.py`.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, watch};

/// `lowerPriority` : passe un processus en priorité CPU basse (`nice`,
/// `BACKGROUND_NICE`, 10 par défaut) ; sans effet si le système le refuse.
pub fn lower_priority(pid: Option<u32>) {
    // `Number(undefined)` → NaN (10) ; `Number('')` → 0.
    let n = std::env::var("BACKGROUND_NICE")
        .ok()
        .map_or(f64::NAN, |v| crate::api::js_number(&v));
    let nice = if n.is_finite() {
        n.trunc().clamp(0.0, 19.0) as i32
    } else {
        10
    };
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return;
    };
    if nice == 0 {
        return;
    }
    // SAFETY: appel système sans pointeur ; un échec est ignoré (droits, plateforme).
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, nice);
    }
}

/// Message d'erreur de lancement comme Node (`spawn <commande> ENOENT`).
pub fn spawn_error_text(cmd: &str, e: &std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => match e.raw_os_error() {
            Some(libc::ENOTDIR) => "ENOTDIR".into(),
            _ => e.to_string(),
        },
    };
    format!("spawn {cmd} {code}")
}

/// Nom d'un signal (`SIGTERM`…), comme `signalCode` de Node.
pub fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGILL => "SIGILL".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGFPE => "SIGFPE".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGALRM => "SIGALRM".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGUSR1 => "SIGUSR1".into(),
        libc::SIGUSR2 => "SIGUSR2".into(),
        n => format!("SIG{n}"),
    }
}

/// Fin d'un processus comme l'écrit Node : `SIGKILL`, sinon `code 1`.
pub fn exit_text(status: Option<&ExitStatus>) -> String {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Some(s) => match (s.signal(), s.code()) {
            (Some(sig), _) => signal_name(sig),
            (None, Some(c)) => format!("code {c}"),
            (None, None) => "code null".into(),
        },
        None => "code null".into(),
    }
}

/// Code de sortie comme `close` de Node (`null` si tué par un signal).
pub fn exit_code_text(status: Option<&ExitStatus>) -> String {
    match status.and_then(ExitStatus::code) {
        Some(c) => c.to_string(),
        None => "null".into(),
    }
}

/// Garde la fin d'un texte (`(tail + s).slice(-max)`), à une frontière de caractère.
pub fn keep_tail(buf: &mut String, add: &str, max: usize) {
    buf.push_str(add);
    let n = buf.chars().count();
    if n > max {
        let cut = buf.char_indices().nth(n - max).map(|(i, _)| i).unwrap_or(0);
        buf.drain(..cut);
    }
}

/// Deux dernières lignes non vides d'une fin de journal, séparées par « | ».
pub fn last_two_lines(tail: &str) -> String {
    let lines: Vec<&str> = tail.split('\n').filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(2)..].join(" | ")
}

// ---------------------------------------------------------------- processus surveillé

/// Processus enfant dont la fin est suivie par une tâche (qui le récupère).
#[derive(Clone)]
pub struct Supervised {
    pid: Option<u32>,
    exit: watch::Receiver<Option<Option<ExitStatus>>>,
}

impl Supervised {
    /// Prend en charge `child` : sa fin est publiée dès qu'il s'arrête.
    pub fn new(mut child: Child) -> Supervised {
        let pid = child.id();
        let (tx, rx) = watch::channel(None);
        tokio::spawn(async move {
            let st = child.wait().await.ok();
            let _ = tx.send(Some(st));
        });
        Supervised { pid, exit: rx }
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Processus terminé (`exitCode !== null || signalCode !== null`).
    pub fn has_exited(&self) -> bool {
        self.exit.borrow().is_some()
    }

    /// Attend la fin ; rend le statut (absent s'il n'a pas pu être lu).
    pub async fn wait(&self) -> Option<ExitStatus> {
        let mut rx = self.exit.clone();
        loop {
            if let Some(st) = *rx.borrow() {
                return st;
            }
            if rx.changed().await.is_err() {
                return None;
            }
        }
    }

    /// Envoie un signal tant que le processus tourne.
    pub fn signal(&self, sig: i32) {
        if self.has_exited() {
            return;
        }
        if let Some(pid) = self.pid {
            // SAFETY: simple envoi de signal au processus enfant encore suivi.
            unsafe {
                libc::kill(pid as libc::pid_t, sig);
            }
        }
    }

    /// `stopChild` : SIGTERM, puis SIGKILL au bout de `grace`.
    pub async fn stop(&self, grace: Duration) {
        if self.has_exited() {
            return;
        }
        self.signal(libc::SIGTERM);
        if tokio::time::timeout(grace, self.wait()).await.is_err() {
            self.signal(libc::SIGKILL);
            self.wait().await;
        }
    }
}

// ---------------------------------------------------------------- processus de travail JSON

/// Description d'un processus de travail JSON.
pub struct WorkerSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Variables ajoutées à l'environnement hérité.
    pub env: Vec<(String, String)>,
    /// Chaque morceau lu sur stderr (journaux du processus).
    pub on_stderr: Box<dyn FnMut(&str) + Send>,
    /// Fin de lecture de stderr (dernière ligne sans saut de ligne).
    pub on_stderr_end: Box<dyn FnOnce() + Send>,
    /// Message d'échec du chargement (`{"event":"error","error":…}`) → texte.
    pub ready_error: fn(Option<&Value>) -> String,
    /// Fin du processus (`SIGKILL` ou `code 1`, deux dernières lignes de stderr) → texte.
    pub exit_message: fn(&str, &str) -> String,
}

type Reply = Result<Map<String, Value>, String>;

struct WorkerInner {
    sup: Supervised,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    ready: Mutex<Option<oneshot::Sender<Reply>>>,
    /// Raison de la fin du processus, une fois arrêté.
    exit_error: Mutex<Option<String>>,
    stderr_tail: Mutex<String>,
    last_activity: Mutex<Instant>,
    next_id: AtomicU64,
}

/// Processus de travail : `{"event":"ready",…}` à l'ouverture, puis une
/// réponse `{"id":n,…}` par requête `{"id":n,…}`. Les lignes de stdout qui
/// ne sont pas du JSON sont ignorées.
#[derive(Clone)]
pub struct JsonWorker {
    inner: Arc<WorkerInner>,
}

impl JsonWorker {
    /// Lance le processus ; rend aussi l'attente de `ready` (message reçu, ou
    /// échec du chargement, ou fin du processus avant d'être prêt).
    pub fn spawn(mut spec: WorkerSpec) -> std::io::Result<(JsonWorker, oneshot::Receiver<Reply>)> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        let mut child = cmd.spawn()?;
        lower_priority(child.id());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (ready_tx, ready_rx) = oneshot::channel();
        let inner = Arc::new(WorkerInner {
            sup: Supervised::new(child),
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            ready: Mutex::new(Some(ready_tx)),
            exit_error: Mutex::new(None),
            stderr_tail: Mutex::new(String::new()),
            last_activity: Mutex::new(Instant::now()),
            next_id: AtomicU64::new(1),
        });

        let err_task = {
            let inner = inner.clone();
            let mut on_err = std::mem::replace(&mut spec.on_stderr, Box::new(|_| {}));
            let on_end = std::mem::replace(&mut spec.on_stderr_end, Box::new(|| {}));
            tokio::spawn(async move {
                if let Some(mut e) = stderr {
                    let mut buf = vec![0u8; 8192];
                    let mut carry: Vec<u8> = Vec::new();
                    while let Ok(n) = e.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        carry.extend_from_slice(&buf[..n]);
                        // Morceau décodé jusqu'au dernier caractère complet.
                        let cut = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(err) if err.error_len().is_none() => err.valid_up_to(),
                            Err(_) => carry.len(),
                        };
                        let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
                        carry.drain(..cut);
                        *inner
                            .last_activity
                            .lock()
                            .unwrap_or_else(|p| p.into_inner()) = Instant::now();
                        keep_tail(
                            &mut inner.stderr_tail.lock().unwrap_or_else(|p| p.into_inner()),
                            &text,
                            2000,
                        );
                        on_err(&text);
                    }
                }
                on_end();
            })
        };

        let out_task = {
            let inner = inner.clone();
            let ready_error = spec.ready_error;
            tokio::spawn(async move {
                let Some(out) = stdout else { return };
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    match msg.get("event").and_then(Value::as_str) {
                        Some("ready") => {
                            if let Some(tx) =
                                inner.ready.lock().unwrap_or_else(|p| p.into_inner()).take()
                            {
                                let _ = tx.send(Ok(msg));
                            }
                            continue;
                        }
                        Some("error") => {
                            if let Some(tx) =
                                inner.ready.lock().unwrap_or_else(|p| p.into_inner()).take()
                            {
                                let _ = tx.send(Err(ready_error(msg.get("error"))));
                            }
                            continue;
                        }
                        _ => {}
                    }
                    let Some(id) = msg
                        .get("id")
                        .and_then(Value::as_f64)
                        .filter(|f| f.fract() == 0.0 && *f >= 0.0)
                    else {
                        continue;
                    };
                    let tx = inner
                        .pending
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(&(id as u64));
                    if let Some(tx) = tx {
                        let _ = tx.send(Ok(msg));
                    }
                }
            })
        };

        {
            let inner = inner.clone();
            let exit_message = spec.exit_message;
            tokio::spawn(async move {
                let st = inner.sup.wait().await;
                // Les dernières lignes (échec du chargement…) passent avant la fin.
                let _ = tokio::time::timeout(Duration::from_secs(2), out_task).await;
                let _ = tokio::time::timeout(Duration::from_millis(500), err_task).await;
                let tail =
                    last_two_lines(&inner.stderr_tail.lock().unwrap_or_else(|p| p.into_inner()));
                let why = exit_message(&exit_text(st.as_ref()), &tail);
                *inner.exit_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(why.clone());
                if let Some(tx) = inner.ready.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(Err(why.clone()));
                }
                let pending: Vec<_> = inner
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .drain()
                    .collect();
                for (_, tx) in pending {
                    let _ = tx.send(Err(why.clone()));
                }
            });
        }
        Ok((JsonWorker { inner }, ready_rx))
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.sup.pid()
    }

    pub fn has_exited(&self) -> bool {
        self.inner.sup.has_exited()
    }

    /// Raison de l'arrêt du processus, s'il s'est arrêté.
    pub fn exit_error(&self) -> Option<String> {
        self.inner
            .exit_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Dernière nouvelle du processus (lecture sur stderr).
    pub fn last_activity(&self) -> Instant {
        *self
            .inner
            .last_activity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Fin de stderr (2 000 caractères au plus).
    pub fn stderr_tail(&self) -> String {
        self.inner
            .stderr_tail
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Envoie `{"id": n, …fields}` ; rend l'identifiant et l'attente de la réponse.
    pub async fn request(&self, fields: Map<String, Value>) -> (u64, oneshot::Receiver<Reply>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        // Processus arrêté (la raison est posée avant que les attentes soient
        // vidées) : la requête n'attendra jamais de réponse.
        if let Some(why) = self.exit_error() {
            let tx = self
                .inner
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(Err(why));
            }
            return (id, rx);
        }
        let mut msg = Map::new();
        msg.insert("id".into(), Value::from(id));
        msg.extend(fields);
        let line = format!("{}\n", Value::Object(msg));
        let mut stdin = self.inner.stdin.lock().await;
        if let Some(s) = stdin.as_mut() {
            // Processus déjà mort : la réponse viendra de la fin du processus.
            let _ = s.write_all(line.as_bytes()).await;
            let _ = s.flush().await;
        }
        (id, rx)
    }

    /// Oublie une requête en attente (interruption).
    pub fn forget(&self, id: u64) {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    /// Ferme stdin puis arrête le processus (`stopChild`, délai `grace`).
    pub async fn close(&self, grace: Duration) {
        self.inner.stdin.lock().await.take();
        self.inner.sup.stop(grace).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textes_comme_node() {
        let mut t = String::new();
        keep_tail(&mut t, "abcdé", 3);
        assert_eq!(t, "cdé");
        assert_eq!(last_two_lines("a\n\nb\nc\n"), "b | c");
        assert_eq!(last_two_lines(""), "");
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(spawn_error_text("/x/python", &e), "spawn /x/python ENOENT");
        assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
    }

    #[tokio::test]
    async fn arret_propre_puis_force() {
        // Un processus qui ignore SIGTERM est tué au bout du délai.
        let child = Command::new("sh")
            .args(["-c", "trap '' TERM; sleep 30"])
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let s = Supervised::new(child);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let t0 = Instant::now();
        s.stop(Duration::from_millis(300)).await;
        assert!(s.has_exited());
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert_eq!(exit_text(s.wait().await.as_ref()), "SIGKILL");
    }
}
