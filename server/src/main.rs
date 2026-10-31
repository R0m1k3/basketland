use basketland_server::{app, cron, db, node, proxy, schema, state, video};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};

#[tokio::main]
async fn main() {
    // Récupération d'accès : `basketland-server reset-password <identifiant> <mot-de-passe>`.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("reset-password") {
        std::process::exit(basketland_server::reset_password::run(&args[2..]));
    }
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

    let st = state::AppState::new(
        db::Db::new(db::default_db_path()),
        proxy::Upstream::new(&node_url),
        video::Video::new(),
    );
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
    // Base créée et migrée avant tout (Node la trouve prête ; il applique
    // encore son propre schéma, identique et idempotent).
    let db_path = db::default_db_path();
    match tokio::task::spawn_blocking(move || schema::ensure_schema(&db_path)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("[serveur] {e}"),
        Err(e) => eprintln!("[serveur] schéma de la base : {e}"),
    }
    // Node n'est lancé qu'une fois le port public obtenu : jamais d'application orpheline.
    let local = listener.local_addr().unwrap_or(addr);
    let mut child = match node::NodeConfig::from_env() {
        Some(mut cfg) => {
            cfg.rust_url = Some(node::rust_url(local));
            match node::spawn(&cfg) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!(
                        "[serveur] impossible de lancer l'application Node ({}) : {e}",
                        cfg.cmd.join(" ")
                    );
                    std::process::exit(1);
                }
            }
        }
        None => None,
    };

    println!(
        "[serveur] Basketland (Rust {}) sur http://{addr}, application Node relayée sur {node_url}",
        env!("CARGO_PKG_VERSION")
    );

    let mut term = signal(SignalKind::terminate()).expect("signal SIGTERM");
    let mut int = signal(SignalKind::interrupt()).expect("signal SIGINT");
    // Tous les jobs (calendrier, stats, replays, VF, analyses, pré-traductions) ; Node n'en lance plus.
    cron::start(st.clone());
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
