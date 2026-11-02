//! Garde-fou de la mémoire du NAS, sans aucun réglage.
//!
//! Le conteneur n'a pas de plafond de mémoire (docker-compose tel quel) : si
//! Whisper, Ollama ou les voix prennent toute la RAM, c'est le NAS entier qui
//! plante. Trois protections :
//!
//! - [`wait_for_room`] : un travail lourd (traduction, doublage) ne démarre
//!   que s'il reste assez de mémoire libre sur le NAS ;
//! - [`watch`] : pendant le travail, la mémoire libre est relue toutes les
//!   2 s ; sous le seuil critique, le travail est interrompu (ses processus
//!   s'arrêtent, il est repris plus tard comme après une panne de service) ;
//! - [`protect_host`] : nos processus lourds sont désignés au noyau comme les
//!   premiers à tuer en cas de manque (`oom_score_adj`), avant les services
//!   du NAS.
//!
//! La mémoire libre est `MemAvailable` de `/proc/meminfo` (celle de l'hôte :
//! le conteneur la voit telle quelle), plus le cache ZFS (ARC) que le noyau
//! peut rendre, s'il existe. `MEM_GUARD=0` désactive les deux premières
//! protections.

use super::abort::{wait_aborted, AbortSignal};
use std::time::Duration;

/// Mémoire du NAS, en Mo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mem {
    pub available_mb: u64,
    pub total_mb: u64,
}

impl Mem {
    /// Seuil de démarrage d'un travail lourd : 1,5 Go ou 12 % de la RAM.
    pub fn start_mb(&self) -> u64 {
        1536.max(self.total_mb * 12 / 100)
    }

    /// Seuil critique (travail interrompu) : 400 Mo ou 4 % de la RAM.
    pub fn critical_mb(&self) -> u64 {
        400.max(self.total_mb * 4 / 100)
    }
}

fn kb_field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let rest = l.strip_prefix(name)?.strip_prefix(':')?;
        rest.split_whitespace().next()?.parse().ok()
    })
}

/// Cache ZFS (ARC) rendable : `size - c_min` de `arcstats`, en octets.
fn zfs_arc_reclaimable(arcstats: &str) -> u64 {
    let field = |name: &str| {
        arcstats.lines().find_map(|l| {
            let mut it = l.split_whitespace();
            (it.next()? == name).then_some(())?;
            it.nth(1)?.parse::<u64>().ok()
        })
    };
    match (field("size"), field("c_min")) {
        (Some(size), Some(min)) => size.saturating_sub(min),
        _ => 0,
    }
}

/// Lit `meminfo` (et `arcstats` s'il y en a) : `None` si illisible.
pub fn parse(meminfo: &str, arcstats: Option<&str>) -> Option<Mem> {
    let total = kb_field(meminfo, "MemTotal")?;
    let avail = kb_field(meminfo, "MemAvailable")?;
    let arc = arcstats.map_or(0, zfs_arc_reclaimable) / 1024;
    Some(Mem {
        available_mb: (avail + arc) / 1024,
        total_mb: total / 1024,
    })
}

fn enabled() -> bool {
    std::env::var("MEM_GUARD").ok().as_deref() != Some("0")
}

/// Mémoire du NAS maintenant (`None` hors Linux ou garde-fou désactivé).
pub fn snapshot() -> Option<Mem> {
    if !enabled() {
        return None;
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let arc = std::fs::read_to_string("/proc/spl/kstat/zfs/arcstats").ok();
    parse(&meminfo, arc.as_deref())
}

/// Attend qu'il reste assez de mémoire pour démarrer un travail lourd
/// (`what` : « traduction », « doublage », pour le journal). Rend tout de
/// suite si le signal est levé.
pub async fn wait_for_room(what: &str, signal: &AbortSignal) {
    let mut logged = false;
    loop {
        let Some(m) = snapshot() else { return };
        if m.available_mb >= m.start_mb() || signal.is_aborted() {
            if logged {
                println!(
                    "[mémoire] {} Mo libres sur le NAS : {what} démarrée",
                    m.available_mb
                );
            }
            return;
        }
        if !logged {
            println!(
                "[mémoire] {what} en attente : {} Mo libres sur le NAS sur {} Mo (il en faut {})",
                m.available_mb,
                m.total_mb,
                m.start_mb()
            );
            logged = true;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(15)) => {}
            _ = wait_aborted(Some(signal)) => return,
        }
    }
}

/// Se termine quand la mémoire libre du NAS reste sous le seuil critique
/// (deux lectures de suite, à 2 s d'écart) ; rend la raison, pour le journal
/// et l'état du travail. Ne se termine jamais si le garde-fou est désactivé.
pub async fn watch() -> String {
    let mut low = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Some(m) = snapshot() else {
            return std::future::pending::<String>().await;
        };
        if m.available_mb < m.critical_mb() {
            low += 1;
            if low >= 2 {
                return format!(
                    "mémoire du NAS presque pleine ({} Mo libres sur {} Mo) : travail interrompu pour protéger le NAS, il reprendra plus tard",
                    m.available_mb, m.total_mb
                );
            }
        } else {
            low = 0;
        }
    }
}

/// Désigne `pid` au noyau comme à tuer en premier si la mémoire manque
/// (`oom_score_adj` = `score`, de -1000 à 1000). Relever son propre score ne
/// demande aucun droit ; un échec est ignoré.
pub fn protect_host(pid: u32, score: i32) {
    let _ = std::fs::write(format!("/proc/{pid}/oom_score_adj"), score.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "MemTotal:        8048576 kB\nMemFree:          204800 kB\nMemAvailable:    1048576 kB\nBuffers:           10240 kB\n";

    #[test]
    fn lecture_de_meminfo_et_seuils() {
        let m = parse(MEMINFO, None).unwrap();
        assert_eq!(
            m,
            Mem {
                available_mb: 1024,
                total_mb: 7859
            }
        );
        // NAS de 8 Go : 1,5 Go pour démarrer, 400 Mo de seuil critique.
        assert_eq!((m.start_mb(), m.critical_mb()), (1536, 400));
        // 64 Go : 12 % et 4 %.
        let big = Mem {
            available_mb: 0,
            total_mb: 65536,
        };
        assert_eq!((big.start_mb(), big.critical_mb()), (7864, 2621));
        assert_eq!(parse("rien", None), None);
    }

    #[test]
    fn cache_zfs_compte_comme_libre() {
        let arc = "13 1 0x01 123 33456 1 2\nname                            type data\nhits                            4    100\nc_min                           4    536870912\nsize                            4    2684354560\n";
        let m = parse(MEMINFO, Some(arc)).unwrap();
        // 1 Go libre + (2,5 Go - 0,5 Go) d'ARC rendable.
        assert_eq!(m.available_mb, 1024 + 2048);
        assert_eq!(zfs_arc_reclaimable("illisible"), 0);
    }
}
