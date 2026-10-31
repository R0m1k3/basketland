//! Application Next.js lancée en sous-processus, sur un port interne.

use std::process::Stdio;
use tokio::process::{Child, Command};

pub struct NodeConfig {
    /// Commande (`BL_NODE_CMD`), découpée sur les espaces.
    pub cmd: Vec<String>,
    pub port: u16,
    /// Adresse du serveur Rust vue de Node (`BL_RUST_URL`) : ses pages y
    /// lisent l'état des files médias (`/api/internal/media-state`).
    pub rust_url: Option<String>,
}

impl NodeConfig {
    pub fn from_env() -> Option<Self> {
        // `BL_NODE_CMD=` (vide) : Node lancé à part (développement), rien à démarrer.
        let raw = std::env::var("BL_NODE_CMD")
            .unwrap_or_else(|_| "node --disable-warning=ExperimentalWarning server.js".into());
        let cmd: Vec<String> = raw.split_whitespace().map(str::to_string).collect();
        if cmd.is_empty() {
            return None;
        }
        Some(NodeConfig {
            cmd,
            port: node_port(),
            rust_url: None,
        })
    }
}

/// Adresse locale du serveur Rust pour Node : une écoute sur toutes les
/// interfaces est jointe par la boucle locale.
pub fn rust_url(addr: std::net::SocketAddr) -> String {
    let ip = match addr.ip() {
        std::net::IpAddr::V4(v) if v.is_unspecified() => {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        }
        std::net::IpAddr::V6(v) if v.is_unspecified() => {
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        }
        ip => ip,
    };
    format!("http://{}", std::net::SocketAddr::new(ip, addr.port()))
}

/// Port interne de Node (`BL_NODE_PORT`, 3013 par défaut).
pub fn node_port() -> u16 {
    std::env::var("BL_NODE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3013)
}

/// Démarre Node : il n'écoute que sur 127.0.0.1, ses logs vont dans ceux du conteneur.
pub fn spawn(cfg: &NodeConfig) -> std::io::Result<Child> {
    let mut cmd = Command::new(&cfg.cmd[0]);
    // Serveur Rust tué brutalement (SIGKILL) : Node reçoit SIGTERM, il ne reste pas orphelin.
    #[cfg(target_os = "linux")]
    // SAFETY: seul appel entre fork et exec, prctl est async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    cmd.args(&cfg.cmd[1..])
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        // Jobs repris par le cron Rust : le planificateur de Node les saute.
        .env("BL_RUST_JOBS", crate::ingest::RUST_JOBS.join(","))
        .envs(cfg.rust_url.as_ref().map(|u| ("BL_RUST_URL", u.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
}

/// Arrêt propre : SIGTERM, puis SIGKILL après `grace`.
pub async fn stop(child: &mut Child, grace: std::time::Duration) {
    if let Some(pid) = child.id() {
        // SAFETY: envoi d'un signal à notre propre sous-processus.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}
