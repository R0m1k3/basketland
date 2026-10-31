use basketland_server::{app, cron, db, node, proxy, state, video};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3012);
    let host = std::env::var("BL_LISTEN_HOST")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "0.0.0.0".into());
    let node_url = std::env::var("BL_NODE_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", node::node_port()));

    let st = state::AppState {
        db: db::Db::new(db::default_db_path()),
        upstream: proxy::Upstream::new(&node_url),
        video: video::Video::new(),
    };
    // Vérifications lentes faites une fois, hors des requêtes.
    tokio::task::spawn_blocking(|| {
        state::ffmpeg_available();
        state::node_version();
    });

    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[serveur] adresse d'écoute invalide {host}:{port} : {e}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[serveur] écoute impossible sur {addr} : {e}");
            std::process::exit(1);
        }
    };
    // Node n'est lancé qu'une fois le port public obtenu : jamais d'application orpheline.
    let mut child = match node::NodeConfig::from_env() {
        Some(cfg) => match node::spawn(&cfg) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!(
                    "[serveur] impossible de lancer l'application Node ({}) : {e}",
                    cfg.cmd.join(" ")
                );
                std::process::exit(1);
            }
        },
        None => None,
    };

    println!(
        "[serveur] Basketland (Rust {}) sur http://{addr}, application Node relayée sur {node_url}",
        env!("CARGO_PKG_VERSION")
    );

    let mut term = signal(SignalKind::terminate()).expect("signal SIGTERM");
    let mut int = signal(SignalKind::interrupt()).expect("signal SIGINT");
    // Jobs d'ingestion portés (calendrier, stats, VF) ; Node ne les lance plus.
    cron::start(st.db.clone());
    let server = axum::serve(listener, app(st));

    let code = tokio::select! {
        r = server => {
            if let Err(e) = r { eprintln!("[serveur] arrêt sur erreur : {e}"); }
            1
        }
        status = async { match child.as_mut() { Some(c) => c.wait().await.ok(), None => std::future::pending().await } } => {
            // Node arrêté : le conteneur redémarre le tout (restart: unless-stopped).
            eprintln!("[serveur] l'application Node s'est arrêtée ({status:?}) : arrêt du serveur");
            1
        }
        _ = term.recv() => 0,
        _ = int.recv() => 0,
    };
    if let Some(c) = child.as_mut() {
        node::stop(c, Duration::from_secs(10)).await;
    }
    std::process::exit(code);
}
