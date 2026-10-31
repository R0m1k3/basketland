//! Signal d'interruption partagé (équivalent d'`AbortController` /
//! `AbortSignal`) : un travail en cours (extraction ffmpeg, requête au
//! modèle, session Whisper…) s'arrête dès que le signal est levé.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone, Default, Debug)]
pub struct AbortSignal(Arc<Inner>);

#[derive(Default, Debug)]
struct Inner {
    aborted: AtomicBool,
    notify: Notify,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// `controller.abort()` : lève le signal (définitif).
    pub fn abort(&self) {
        self.0.aborted.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    /// `signal.aborted`.
    pub fn is_aborted(&self) -> bool {
        self.0.aborted.load(Ordering::SeqCst)
    }

    /// Attend que le signal soit levé (immédiat s'il l'est déjà).
    pub async fn aborted(&self) {
        loop {
            let n = self.0.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if self.is_aborted() {
                return;
            }
            n.await;
        }
    }
}

/// `signal?.aborted`.
pub fn is_aborted(signal: Option<&AbortSignal>) -> bool {
    signal.is_some_and(AbortSignal::is_aborted)
}

/// Attend un signal facultatif (absent : jamais).
pub async fn wait_aborted(signal: Option<&AbortSignal>) {
    match signal {
        Some(s) => s.aborted().await,
        None => std::future::pending().await,
    }
}

/// Pause interrompue dès que le signal est levé (comme le `sleep` des modules Node).
pub async fn sleep(ms: u64, signal: Option<&AbortSignal>) {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
        _ = wait_aborted(signal) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn signal_leve_reveille_les_attentes() {
        let s = AbortSignal::new();
        let s2 = s.clone();
        let t = tokio::spawn(async move { s2.aborted().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!is_aborted(Some(&s)));
        s.abort();
        t.await.unwrap();
        assert!(s.is_aborted());
        let t0 = std::time::Instant::now();
        sleep(10_000, Some(&s)).await;
        assert!(t0.elapsed() < Duration::from_secs(1));
    }
}
