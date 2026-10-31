//! Proxy vidéo ok.ru (équivalent de `src/lib/videoProxy.ts`, avec le cache
//! de résolution de `src/lib/okru.ts`) : HLS et MP4 progressif.
//!
//! Fluidité de lecture (le NAS relaie tout le flux) :
//!  - le flux signé reste en cache jusqu'à peu avant son expiration, et se
//!    rafraîchit en arrière-plan avant ;
//!  - les playlists média (VOD, immuables) sont gardées en mémoire ;
//!  - préchargement profond (≈ 90 s de vidéo au-delà du dernier segment
//!    demandé par le lecteur), du segment le plus urgent au plus lointain, qui
//!    suit la qualité réellement lue (un changement de qualité abandonne
//!    l'ancienne) et qu'aucune requête ne peut annuler ;
//!  - les segments passent par un cache borné en octets qui garde en priorité
//!    les segments À VENIR de chaque lecture ;
//!  - chaque téléchargement amont est surveillé : sans un octet pendant
//!    SEGMENT_STALL_MS (ou nettement trop lent), il est coupé et repris là où
//!    il en était (requête Range) sur une connexion neuve, sans que le
//!    lecteur voie la coupure ;
//!  - téléchargements en vol partagés, connexions persistantes vers ok.ru.
//!
//! Toute la logique synchrone (caches, curseurs, préchargement) vit sous un
//! seul verrou, jamais tenu pendant une attente : c'est l'équivalent de la
//! boucle d'événements unique de Node. Les téléchargements et résolutions
//! tournent dans des tâches à part : comme les promesses de Node, ils vont
//! au bout même si le client qui les a demandés s'en va.

use crate::db::Db;
use crate::hls::{self, DEFAULT_SEGMENT_SEC};
use crate::okru::{self, Mp4Source, Variant};
use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::{Stream, StreamExt};
use indexmap::IndexMap;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::watch;

// ------------------------------------------------------------------ erreurs

/// Erreur du proxy. `status` présent : `ProxyError` (statut choisi) ;
/// absent : erreur ordinaire (réseau, base…), rendue en 502 comme côté Node.
#[derive(Debug, Clone, PartialEq)]
pub struct VErr {
    pub status: Option<u16>,
    pub msg: String,
}

impl VErr {
    pub fn proxy(status: u16, msg: impl Into<String>) -> Self {
        VErr {
            status: Some(status),
            msg: msg.into(),
        }
    }
    pub fn plain(msg: impl Into<String>) -> Self {
        VErr {
            status: None,
            msg: msg.into(),
        }
    }
    pub fn http_status(&self) -> u16 {
        self.status.unwrap_or(502)
    }
    /// `proxyErrorResponse`.
    pub fn response(&self) -> Response {
        crate::api::error(
            StatusCode::from_u16(self.http_status()).unwrap_or(StatusCode::BAD_GATEWAY),
            &self.msg,
        )
    }
}

type VResult<T> = Result<T, VErr>;

// ------------------------------------------------------------------ constantes

/// Le flux résolu est gardé jusqu'à `expiresAt - STREAM_EXPIRY_MARGIN_MS`.
pub const STREAM_EXPIRY_MARGIN_MS: f64 = 5.0 * 60_000.0;
/// Rafraîchissement en arrière-plan quand il reste moins que ça.
pub const STREAM_REFRESH_BEFORE_MS: f64 = 30.0 * 60_000.0;
/// Un flux MP4 seul est revérifié plus souvent (le HLS finit par apparaître).
pub const MP4_ONLY_REFRESH_MS: f64 = 10.0 * 60_000.0;
/// Une résolution forcée réutilise un flux résolu il y a moins que ça.
pub const FORCE_DEDUP_MS: f64 = 10_000.0;
/// Un HLS annoncé mais momentanément illisible est retenté après ce délai.
pub const HLS_ERROR_RETRY_MS: f64 = 30_000.0;
/// Durée de vie supposée quand l'URL ne porte pas de champ `expires`.
const DEFAULT_LIFETIME_MS: f64 = 3_600_000.0;
const STREAMS_PURGE_AT: usize = 200;

const PLAYLIST_CACHE_MAX: usize = 100;
/// Budget par défaut du cache de segments (Mo).
pub const DEFAULT_SEGMENT_CACHE_MB: f64 = 512.0;
/// Plafond de la fenêtre de préchargement, quelle que soit la durée des segments.
pub const PREFETCH_MAX_SEGMENTS: i64 = 30;
/// Part du cache que les segments à venir peuvent occuper.
pub const PREFETCH_BUDGET_SHARE: f64 = 0.6;
/// Au-delà de ce multiple de sa durée, un segment est repris sur une connexion neuve (une fois).
const SLOW_RESTART_FACTOR: f64 = 2.5;
/// Pause avant de retenter après une erreur réseau ou un 5xx.
const RETRY_DELAY_MS: u64 = 300;
/// Sans demande depuis plus longtemps, un curseur n'est plus préchargé.
const CURSOR_ACTIVE_MS: f64 = 30_000.0;
/// Au-delà, il est oublié : ses segments à venir ne sont plus protégés.
const CURSOR_TTL_MS: f64 = 3.0 * 60_000.0;
const CURSOR_MAX: usize = 32;
/// Changement de qualité : un curseur d'une autre variante à moins de N segments est le même lecteur.
const SWITCH_TOLERANCE: i64 = 3;
/// Un segment dont le préchargement a échoué n'est pas retenté avant ce délai.
const PREFETCH_FAIL_COOLDOWN_MS: f64 = 30_000.0;
/// Petites tables par variante : bornées.
const PER_GROUP_MAX: usize = 256;
/// Un segment plus lent que ça est signalé dans les logs.
const SLOW_SEGMENT_MS: f64 = 4_000.0;
/// Qualité MP4 épinglée tant qu'elle est utilisée.
const MP4_PIN_IDLE_MS: f64 = 15.0 * 60_000.0;

// ------------------------------------------------------------------ outils JavaScript

/// `Math.round`.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

use crate::js::to_fixed1;

/// `Number(entête)` positif et fini, sinon `None` (`content-length`).
fn positive_len(v: Option<&str>) -> Option<u64> {
    let n = crate::api::js_number(v.unwrap_or(""));
    (n.is_finite() && n > 0.0).then_some(n as u64)
}

fn num_header(v: Option<&str>) -> f64 {
    crate::api::js_number(v.unwrap_or(""))
}

// ------------------------------------------------------------------ attente partagée

/// Résultat d'une tâche partagé par plusieurs attentes (promesse dédoublonnée).
#[derive(Clone)]
struct Flight<T: Clone>(watch::Receiver<Option<T>>);

impl<T: Clone + Send + Sync + 'static> Flight<T> {
    fn new() -> (watch::Sender<Option<T>>, Self) {
        let (tx, rx) = watch::channel(None);
        (tx, Flight(rx))
    }
    fn ready(v: T) -> Self {
        let (_tx, rx) = watch::channel(Some(v));
        Flight(rx)
    }
    async fn wait(mut self) -> Option<T> {
        let r = self.0.wait_for(|v| v.is_some()).await.map(|v| v.clone());
        match r {
            Ok(v) => v,
            Err(_) => self.0.borrow().clone(),
        }
    }
}

async fn wait_result<T: Clone + Send + Sync + 'static>(f: Flight<VResult<T>>) -> VResult<T> {
    f.wait()
        .await
        .unwrap_or_else(|| Err(VErr::plain("tâche interrompue")))
}

// ------------------------------------------------------------------ cache borné en octets

/// Cache borné en OCTETS (un segment 1080p pèse dix fois un segment 240p).
/// Une entrée plus grosse que le budget n'est pas mise en cache.
///
/// Éviction : sans fonction de rang, l'entrée la moins récemment lue part la
/// première (LRU). Avec `rank`, l'entrée de rang le plus BAS part la
/// première, et à rang égal la moins récemment lue : le proxy s'en sert pour
/// garder les segments à venir d'une lecture.
pub struct ByteLru<V> {
    max_bytes: u64,
    map: HashMap<String, (V, u64, u64)>,
    order: BTreeMap<u64, String>,
    next: u64,
    used: u64,
}

impl<V: Clone> ByteLru<V> {
    pub fn new(max_bytes: u64) -> Self {
        ByteLru {
            max_bytes,
            map: HashMap::new(),
            order: BTreeMap::new(),
            next: 0,
            used: 0,
        }
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    /// Lecture ; l'entrée passe en tête (la plus récente).
    pub fn get(&mut self, key: &str) -> Option<V> {
        let seq = self.next;
        let e = self.map.get_mut(key)?;
        self.order.remove(&e.2);
        e.2 = seq;
        self.next += 1;
        self.order.insert(seq, key.to_string());
        Some(e.0.clone())
    }

    /// Présence, sans modifier l'ordre d'éviction.
    pub fn has(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// Taille d'une entrée, sans modifier l'ordre d'éviction.
    pub fn size_of(&self, key: &str) -> Option<u64> {
        self.map.get(key).map(|e| e.1)
    }

    /// Range l'entrée (éviction LRU) ; `false` si elle n'est pas gardée.
    pub fn set(&mut self, key: &str, v: V, size: u64) -> bool {
        self.set_ranked(key, v, size, None)
    }

    /// Range l'entrée ; `false` si elle n'est pas gardée (trop grosse, ou la moins prioritaire de toutes).
    pub fn set_ranked(
        &mut self,
        key: &str,
        v: V,
        size: u64,
        rank: Option<&dyn Fn(&str) -> f64>,
    ) -> bool {
        self.delete(key);
        if size > self.max_bytes {
            return false;
        }
        let seq = self.next;
        self.next += 1;
        self.map.insert(key.to_string(), (v, size, seq));
        self.order.insert(seq, key.to_string());
        self.used += size;
        while self.used > self.max_bytes {
            let Some(k) = self.victim(rank) else { break };
            self.delete(&k);
        }
        self.map.contains_key(key)
    }

    /// Prochaine entrée à évincer.
    fn victim(&self, rank: Option<&dyn Fn(&str) -> f64>) -> Option<String> {
        let mut keys = self.order.values();
        let first = keys.next()?;
        let Some(rank) = rank else {
            return Some(first.clone());
        };
        let mut best = first;
        let mut best_rank = rank(first);
        if best_rank <= 0.0 {
            return Some(best.clone());
        }
        for k in keys {
            let r = rank(k);
            if r < best_rank {
                best = k;
                best_rank = r;
                if r <= 0.0 {
                    break;
                }
            }
        }
        Some(best.clone())
    }

    pub fn delete(&mut self, key: &str) {
        if let Some((_, size, seq)) = self.map.remove(key) {
            self.order.remove(&seq);
            self.used -= size;
        }
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.used = 0;
    }

    pub fn bytes(&self) -> u64 {
        self.used
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

// ------------------------------------------------------------------ téléchargement partagé

/// Téléchargement d'un segment partagé entre plusieurs lecteurs : le corps
/// amont est lu UNE fois, chaque requête cliente (et le cache) relit les
/// morceaux reçus au fil de l'eau. Une reprise après blocage continue
/// d'alimenter le même objet : les lecteurs ne voient qu'une pause.
pub struct SharedDownload {
    pub content_length: Option<u64>,
    inner: Mutex<DlInner>,
    tx: watch::Sender<u64>,
}

struct DlInner {
    chunks: Vec<Bytes>,
    received: u64,
    done: bool,
    error: Option<VErr>,
}

impl SharedDownload {
    pub fn new(content_length: Option<u64>) -> Self {
        SharedDownload {
            content_length,
            inner: Mutex::new(DlInner {
                chunks: Vec::new(),
                received: 0,
                done: false,
                error: None,
            }),
            tx: watch::channel(0).0,
        }
    }

    fn lock(&self) -> MutexGuard<'_, DlInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn push(&self, chunk: Bytes) {
        {
            let mut g = self.lock();
            g.received += chunk.len() as u64;
            g.chunks.push(chunk);
        }
        self.tx.send_modify(|v| *v += 1);
    }

    pub fn finish(&self, err: Option<VErr>) {
        {
            let mut g = self.lock();
            if g.done {
                return;
            }
            if err.is_some() {
                g.error = err;
            }
            g.done = true;
        }
        self.tx.send_modify(|v| *v += 1);
    }

    pub fn received(&self) -> u64 {
        self.lock().received
    }

    pub fn is_done(&self) -> bool {
        self.lock().done
    }

    pub fn error(&self) -> Option<VErr> {
        self.lock().error.clone()
    }

    /// Fin du téléchargement (succès ou échec).
    pub async fn settled(&self) {
        let mut rx = self.tx.subscribe();
        let _ = rx.wait_for(|_| self.is_done()).await;
    }

    /// Lecture depuis le début ; autant de fois que nécessaire.
    pub fn stream(self: &Arc<Self>) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
        let rx = self.tx.subscribe();
        futures_util::stream::unfold((self.clone(), 0usize, rx), |(dl, i, mut rx)| async move {
            if i == usize::MAX {
                return None;
            }
            loop {
                rx.borrow_and_update();
                {
                    let g = dl.lock();
                    if i < g.chunks.len() {
                        let c = g.chunks[i].clone();
                        drop(g);
                        return Some((Ok(c), (dl, i + 1, rx)));
                    }
                    if g.done {
                        let e = g.error.clone();
                        drop(g);
                        return e
                            .map(|e| (Err(std::io::Error::other(e.msg)), (dl, usize::MAX, rx)));
                    }
                }
                if rx.changed().await.is_err() {
                    return None;
                }
            }
        })
    }

    /// Corps complet (après `settled`, sans erreur).
    pub fn bytes(&self) -> Bytes {
        let g = self.lock();
        let mut out = Vec::with_capacity(g.received as usize);
        for c in &g.chunks {
            out.extend_from_slice(c);
        }
        Bytes::from(out)
    }
}

// ------------------------------------------------------------------ flux résolu

/// Flux ok.ru résolu (URL signées : jamais exposées au client).
#[derive(Debug, Clone)]
pub struct OkStream {
    pub ok_id: String,
    /// URL de la playlist maîtresse ; vide quand ok.ru n'a pas (encore) de HLS.
    pub master_url: String,
    /// Contenu de la playlist maîtresse ; vide sans HLS.
    pub master_text: String,
    pub expires_at: f64,
    pub fetched_at: f64,
    pub variants: Vec<Variant>,
    pub mp4: Vec<Mp4Source>,
    /// HLS annoncé mais playlist illisible : MP4 en attendant, retenté vite.
    pub hls_error: bool,
    pub duration: Option<f64>,
    pub poster: Option<String>,
    /// Manifeste DASH d'ok.ru (son seul disponible), s'il est annoncé.
    pub dash_url: Option<String>,
}

pub fn pick_variant<'a>(stream: &'a OkStream, key: Option<&str>) -> Option<&'a Variant> {
    let key = key.filter(|k| !k.is_empty())?;
    stream.variants.iter().find(|v| v.key == key)
}

struct StreamEntry {
    stream: Option<Arc<OkStream>>,
    /// Résolution en cours : une seule à la fois par okId.
    inflight: Option<(u64, Flight<VResult<Arc<OkStream>>>)>,
}

fn should_refresh(s: &OkStream, now: f64) -> bool {
    if s.expires_at - now < STREAM_REFRESH_BEFORE_MS {
        return true;
    }
    if s.hls_error {
        return now - s.fetched_at > HLS_ERROR_RETRY_MS;
    }
    s.master_text.is_empty() && now - s.fetched_at > MP4_ONLY_REFRESH_MS
}

// ------------------------------------------------------------------ état

/// Playlist média en cache, déjà réécrite vers le proxy.
pub struct CachedPlaylist {
    pub text: String,
    /// Segments de la playlist : bornent le préchargement.
    pub names: HashSet<String>,
    /// Durée moyenne d'un segment (s).
    pub seg_sec: f64,
    pub expires_at: f64,
}

/// Position d'un lecteur dans une variante : le dernier segment demandé.
#[derive(Clone, Debug)]
struct Cursor {
    ok_id: String,
    key: String,
    group: String,
    name: String,
    idx: i64,
    seen: f64,
    born: f64,
}

#[derive(Default)]
struct Prefetch {
    cursors: Vec<Cursor>,
    active: usize,
    gen: u64,
    failed: HashMap<String, f64>,
    ends: IndexMap<String, i64>,
    sizes: IndexMap<String, f64>,
}

struct Mp4Pin {
    name: String,
    last_used: f64,
}

type PlaylistFlight = Flight<VResult<Arc<CachedPlaylist>>>;
type SegmentFlight = Flight<VResult<Arc<SharedDownload>>>;

struct State {
    streams: HashMap<String, StreamEntry>,
    playlists: IndexMap<String, Arc<CachedPlaylist>>,
    playlist_inflight: HashMap<String, (u64, PlaylistFlight)>,
    seg_cache: ByteLru<Bytes>,
    seg_inflight: HashMap<String, (u64, SegmentFlight)>,
    prefetch: Prefetch,
    mp4_pins: HashMap<String, Mp4Pin>,
}

#[derive(Default)]
struct Logs {
    last_slow: f64,
    last_resume: f64,
    last_fail: f64,
    last_catch_up: f64,
    captured: Option<Vec<String>>,
}

/// Réglages de test : amont simulé et environnement isolé.
#[derive(Default, Clone)]
pub struct TestConfig {
    /// `http://127.0.0.1:port` : toute requête amont y est envoyée (chemin et
    /// requête d'origine conservés, hôte d'origine dans `x-upstream-host`).
    /// Les contrôles d'hôte (allow-list, https) portent toujours sur l'URL
    /// d'origine — comme dans les tests Node, qui remplacent `fetch`.
    pub upstream: Option<String>,
    /// Variables d'environnement du proxy (au lieu de celles du processus).
    pub env: HashMap<String, String>,
}

/// En-tête portant l'hôte d'origine vers l'amont simulé (tests).
pub const TEST_HOST_HEADER: &str = "x-upstream-host";

struct Inner {
    follow: reqwest::Client,
    manual: reqwest::Client,
    test_upstream: Option<String>,
    env: Option<Mutex<HashMap<String, String>>>,
    clock_offset: AtomicI64,
    t0: Instant,
    ids: AtomicU64,
    st: Mutex<State>,
    logs: Mutex<Logs>,
}

/// Proxy vidéo (état partagé par toutes les requêtes).
#[derive(Clone)]
pub struct Video(Arc<Inner>);

impl Default for Video {
    fn default() -> Self {
        Self::new()
    }
}

/// Requête amont et URL qu'elle vise réellement (après redirection suivie à la main).
struct Up {
    resp: reqwest::Response,
    url: String,
}

impl Up {
    fn status(&self) -> u16 {
        self.resp.status().as_u16()
    }
    fn ok(&self) -> bool {
        (200..300).contains(&self.status())
    }
    fn header(&self, name: &str) -> Option<String> {
        self.resp
            .headers()
            .get(name)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
    }
    /// `Response.text()` : UTF-8 (remplacement des octets invalides), BOM retiré.
    async fn text(self) -> VResult<String> {
        let b = self.resp.bytes().await.map_err(body_error)?;
        let s = String::from_utf8_lossy(&b);
        Ok(s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
    }
}

fn fetch_error(e: reqwest::Error) -> VErr {
    VErr::plain(if e.is_timeout() {
        "The operation was aborted due to timeout"
    } else {
        "fetch failed"
    })
}

fn body_error(e: reqwest::Error) -> VErr {
    VErr::plain(if e.is_timeout() {
        "The operation was aborted due to timeout"
    } else {
        "terminated"
    })
}

/// Options d'une requête amont (`UpstreamOpts`).
#[derive(Clone, Copy)]
struct Opts {
    /// Délai total (corps compris) ; en mode `streaming`, délai d'arrivée des en-têtes.
    timeout_ms: u64,
    retries: u32,
    /// Corps de durée illimitée : le délai ne porte que sur les en-têtes.
    streaming: bool,
}

const DEFAULT_OPTS: Opts = Opts {
    timeout_ms: 60_000,
    retries: 1,
    streaming: false,
};

struct SegTarget {
    ok_id: String,
    key: String,
    s: String,
    ck: String,
    group: String,
}

enum ReadOutcome {
    End,
    Stall,
    Slow(f64),
    Error(String),
}

fn seg_key(ok_id: &str, key: &str, s: &str) -> String {
    format!("{ok_id}|{key}|{s}")
}

/// Index numérique final d'un nom de segment (`MEDIUM00042.ts` → 42).
fn seg_index(name: &str) -> Option<i64> {
    let stem = name.strip_suffix(".ts")?;
    let digits: String = stem
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if digits.is_empty() {
        return None;
    }
    let n: f64 = digits.parse().ok()?;
    (n <= 9_007_199_254_740_991.0).then_some(n as i64)
}

fn seg_label(ck: &str) -> String {
    ck.split('|').skip(1).collect::<Vec<_>>().join(" ")
}

fn mb(bytes: f64) -> f64 {
    js_round(bytes / (1024.0 * 1024.0))
}

fn is_playlist_type(ctype: &str) -> bool {
    let c = ctype.to_lowercase();
    c.contains("mpegurl") || c.contains("m3u8")
}

/// Début de plage d'un en-tête `Content-Range: bytes a-b/c`.
fn content_range_start(v: Option<&str>) -> Option<f64> {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let c = R
        .get_or_init(|| regex::Regex::new(r"(?i)^bytes\s+([0-9]+)-").expect("regex"))
        .captures(v?)?;
    Some(crate::api::js_number(&c[1]))
}

/// `Range` accepté tel quel (`bytes=…`) ; tout autre format est ignoré.
fn sanitize_range(range: Option<&str>) -> Option<&str> {
    let r = range?;
    let rest = r.strip_prefix("bytes=")?;
    (!rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_whitespace() || c == ',' || c == '-'))
    .then_some(r)
}

fn describe_outcome(out: &ReadOutcome, stall_ms: f64) -> String {
    match out {
        ReadOutcome::Stall => format!("aucun octet depuis {} s", to_fixed1(stall_ms / 1000.0)),
        ReadOutcome::Slow(kbps) => format!("trop lent ({kbps} kb/s)"),
        ReadOutcome::End => "coupé avant la fin".into(),
        ReadOutcome::Error(m) => {
            format!("erreur réseau ({})", m.chars().take(80).collect::<String>())
        }
    }
}

const VARIANT_KEY_MAX: usize = 32;

/// Clé de variante telle que produite par le parseur (QUALITY nettoyé).
fn valid_variant_key(k: &str) -> bool {
    (1..=VARIANT_KEY_MAX).contains(&k.len())
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn header_value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn segment_headers(res: &mut Response, len: Option<u64>) {
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    if let Some(l) = len {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(l));
    }
}

fn with_status(status: u16, body: Body) -> Response {
    let mut r = Response::new(body);
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    r
}

/// Réponse d'une playlist (`M3U8_HEADERS`).
pub fn m3u8_response(text: String) -> Response {
    let mut r = Response::new(Body::from(text));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    r
}

impl Video {
    pub fn new() -> Self {
        Self::build(None)
    }

    /// Proxy de test : amont simulé, environnement isolé, logs capturés.
    pub fn for_tests(cfg: TestConfig) -> Self {
        Self::build(Some(cfg))
    }

    fn build(test: Option<TestConfig>) -> Self {
        let client = |follow: bool| {
            let mut b = reqwest::Client::builder()
                .http1_only()
                // Connexions persistantes vers ok.ru (30 s, comme l'agent dédié de Node).
                .pool_idle_timeout(Duration::from_secs(30))
                .redirect(if follow {
                    reqwest::redirect::Policy::limited(20)
                } else {
                    reqwest::redirect::Policy::none()
                });
            if test.is_some() {
                b = b.no_proxy();
            }
            b.build().expect("client HTTP")
        };
        let env = test.as_ref().map(|t| Mutex::new(t.env.clone()));
        let inner = Inner {
            follow: client(true),
            manual: client(false),
            test_upstream: test.as_ref().and_then(|t| t.upstream.clone()),
            env,
            clock_offset: AtomicI64::new(0),
            t0: Instant::now(),
            ids: AtomicU64::new(1),
            st: Mutex::new(State {
                streams: HashMap::new(),
                playlists: IndexMap::new(),
                playlist_inflight: HashMap::new(),
                seg_cache: ByteLru::new(0),
                seg_inflight: HashMap::new(),
                prefetch: Prefetch::default(),
                mp4_pins: HashMap::new(),
            }),
            logs: Mutex::new(Logs {
                captured: test.is_some().then(Vec::new),
                ..Default::default()
            }),
        };
        let max = inner.segment_cache_bytes();
        inner.state().seg_cache = ByteLru::new(max);
        Video(Arc::new(inner))
    }

    // -------------------------------------------------------------- tests et diagnostic

    /// Change une variable d'environnement du proxy de test.
    pub fn set_env(&self, name: &str, value: Option<&str>) {
        if let Some(env) = &self.0.env {
            let mut g = env.lock().unwrap_or_else(|e| e.into_inner());
            match value {
                Some(v) => g.insert(name.to_string(), v.to_string()),
                None => g.remove(name),
            };
        }
    }

    /// Avance l'horloge murale du proxy (équivalent de `vi.setSystemTime`).
    pub fn advance_clock(&self, ms: i64) {
        self.0.clock_offset.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn now_ms(&self) -> f64 {
        self.0.now_ms()
    }

    /// Lignes de log émises (proxy de test).
    pub fn logs(&self) -> Vec<String> {
        self.0.logs().captured.clone().unwrap_or_default()
    }

    /// Vide le cache des flux (`clearOkStreamCache`).
    pub fn clear_stream_cache(&self) {
        self.0.state().streams.clear();
    }

    /// Vide les caches du proxy et relit SEGMENT_CACHE_MB (`clearProxyCaches`).
    pub fn clear_proxy_caches(&self) {
        let max = self.0.segment_cache_bytes();
        let mut st = self.0.state();
        st.seg_cache = ByteLru::new(max);
        st.seg_inflight.clear();
        st.playlists.clear();
        st.playlist_inflight.clear();
        let gen = st.prefetch.gen + 1;
        st.prefetch = Prefetch {
            gen,
            ..Default::default()
        };
        st.mp4_pins.clear();
        drop(st);
        let mut l = self.0.logs();
        l.last_slow = 0.0;
        l.last_resume = 0.0;
        l.last_fail = 0.0;
        l.last_catch_up = 0.0;
    }

    /// Attend la fin des préchargements en cours (`prefetchIdle`).
    pub async fn prefetch_idle(&self) {
        loop {
            let (segs, pls, active) = {
                let st = self.0.state();
                (
                    st.seg_inflight
                        .values()
                        .map(|(_, f)| f.clone())
                        .collect::<Vec<_>>(),
                    st.playlist_inflight
                        .values()
                        .map(|(_, f)| f.clone())
                        .collect::<Vec<_>>(),
                    st.prefetch.active,
                )
            };
            if active == 0 && segs.is_empty() && pls.is_empty() {
                return;
            }
            for f in segs {
                if let Some(Ok(dl)) = f.wait().await {
                    dl.settled().await;
                }
            }
            for f in pls {
                let _ = f.wait().await;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    /// État du cache de segments : (octets, budget, entrées, curseurs, préchargements).
    pub fn segment_cache_stats(&self) -> (u64, u64, usize, usize, usize) {
        let st = self.0.state();
        (
            st.seg_cache.bytes(),
            st.seg_cache.max_bytes(),
            st.seg_cache.len(),
            st.prefetch.cursors.len(),
            st.prefetch.active,
        )
    }

    pub fn prefetch_settings(&self) -> (f64, usize) {
        self.0.prefetch_settings()
    }

    pub fn prefetch_window(&self, seg_sec: f64) -> i64 {
        self.0.prefetch_window(seg_sec)
    }

    /// (stallMs, headersMs, retries)
    pub fn download_settings(&self) -> (f64, u64, u32) {
        self.0.download_settings()
    }

    // -------------------------------------------------------------- pages et embeds

    /// `fetchText` par le client du proxy (et son amont simulé en test) :
    /// pages de basketball-video.
    pub async fn fetch_text(
        &self,
        url: &str,
        extra: Vec<(&'static str, String)>,
        timeout_ms: u64,
    ) -> Result<String, String> {
        self.0
            .fetch_text(url, extra, timeout_ms)
            .await
            .map_err(|e| e.msg)
    }

    /// `fetchOkEmbed` : embed ok.ru lu à chaque appel, hors du cache des flux
    /// (comme `findReplay` côté Node, qui ne passe pas par `resolveOkStream`).
    pub async fn fetch_ok_embed(&self, ok_id: &str) -> Result<okru::OkEmbedInfo, String> {
        self.0.fetch_embed(ok_id).await.map_err(|e| e.msg)
    }

    // -------------------------------------------------------------- routes

    /// `resolveOkStream`.
    pub async fn resolve_ok_stream(&self, ok_id: &str, force: bool) -> VResult<Arc<OkStream>> {
        self.0.resolve_ok_stream(ok_id, force).await
    }

    /// Vérifie qu'un `okId` est bien formé et correspond à un replay connu de
    /// la base (sinon le proxy relaierait N'IMPORTE QUEL flux ok.ru).
    pub async fn assert_known(&self, db: &Db, ok_id: &str) -> VResult<()> {
        if !okru::is_valid_ok_id(ok_id) {
            return Err(VErr::proxy(400, "okId invalide"));
        }
        let id = ok_id.to_string();
        // Toutes ligues confondues (`leagueAny`) : un replay WNBA est valide aussi.
        let known = db
            .run(move |c| crate::db::video_ok_id_known(c, &id))
            .await
            .map_err(VErr::plain)?;
        if known {
            Ok(())
        } else {
            Err(VErr::proxy(404, "replay inconnu"))
        }
    }

    /// Master : flux en cache tant que la signature est valable, variantes réécrites vers le proxy.
    pub async fn master(&self, db: &Db, ok_id: &str) -> VResult<String> {
        self.assert_known(db, ok_id).await?;
        let i = &self.0;
        let mut stream = i.resolve_ok_stream(ok_id, false).await?;
        // Flux en cache sans HLS alors que la base en annonce : ok.ru a fini le traitement.
        if stream.master_text.is_empty() {
            stream = i.resolve_ok_stream(ok_id, true).await?;
        }
        if stream.master_text.is_empty() {
            return Err(VErr::proxy(404, "pas de flux HLS (MP4 seul)"));
        }
        if !hls::is_valid_playlist(&stream.master_text) {
            return Err(VErr::proxy(502, "playlist maître invalide"));
        }
        hls::rewrite_master_playlist(&stream.master_text, &stream.master_url, ok_id)
            .map_err(VErr::plain)
    }

    /// Playlist média : segments réécrits vers /segment.ts (cache + dédoublonnage).
    pub async fn media(&self, db: &Db, ok_id: &str, key: Option<&str>) -> VResult<String> {
        self.assert_known(db, ok_id).await?;
        let f = {
            let mut st = self.0.state();
            self.0.load_playlist(&mut st, ok_id, key)
        };
        Ok(wait_result(f).await?.text.clone())
    }

    /// Ressource HLS annexe (clé `#EXT-X-KEY`, segment d'initialisation `#EXT-X-MAP`).
    pub async fn asset(
        &self,
        db: &Db,
        ok_id: &str,
        key: Option<&str>,
        asset: Option<&str>,
    ) -> VResult<Response> {
        self.assert_known(db, ok_id).await?;
        let Some(asset) = asset.filter(|a| !a.is_empty()) else {
            return Err(VErr::proxy(400, "paramètre a manquant"));
        };
        // Un nom de fichier simple : pas de chemin, pas de traversée.
        if !hls::asset_name_re().is_match(asset) {
            return Err(VErr::proxy(400, "nom de ressource invalide"));
        }
        let i = &self.0;
        let (_, variant) = i.variant_for(ok_id, key, false).await?;
        let url = format!("{}{asset}", hls::dir_of(&variant.url));
        if !okru::is_allowed_media_host(&url) {
            return Err(VErr::proxy(400, "hôte non autorisé"));
        }
        let resp = i
            .follow_manual(&url, okru::ok_headers(), DEFAULT_OPTS)
            .await?;
        if !resp.ok() {
            return Err(VErr::proxy(502, format!("amont HTTP {}", resp.status())));
        }
        // ok.ru renvoie la playlist pour un nom inconnu : ce n'est pas la ressource.
        let ctype = resp
            .header("content-type")
            .unwrap_or_default()
            .to_lowercase();
        if is_playlist_type(&ctype) {
            return Err(VErr::proxy(404, "ressource introuvable"));
        }
        let status = resp.status();
        let len = resp.header("content-length");
        let mut r = with_status(status, Body::from_stream(resp.resp.bytes_stream()));
        let h = r.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            header_value(if ctype.is_empty() {
                "application/octet-stream"
            } else {
                &ctype
            }),
        );
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        if let Some(l) = len.filter(|l| !l.is_empty()) {
            h.insert(header::CONTENT_LENGTH, header_value(&l));
        }
        Ok(r)
    }

    /// Segment .ts : sans Range, depuis le cache, le téléchargement en vol, ou
    /// téléchargé et mis en cache (position du lecteur notée, suivants
    /// préchargés) ; avec Range, relais direct.
    pub async fn segment(
        &self,
        db: &Db,
        ok_id: &str,
        key: Option<&str>,
        s: Option<&str>,
        range: Option<&str>,
    ) -> VResult<Response> {
        self.assert_known(db, ok_id).await?;
        let Some(s) = s.filter(|s| !s.is_empty()) else {
            return Err(VErr::proxy(400, "paramètre s manquant"));
        };
        if !hls::is_segment_name(s) {
            return Err(VErr::proxy(400, format!("nom de segment invalide: {s}")));
        }
        if let Some(range) = range.filter(|r| !r.is_empty()) {
            return self.0.passthrough_segment(ok_id, key, s, range).await;
        }
        let Some(key) = key.filter(|k| valid_variant_key(k)) else {
            return Err(VErr::proxy(
                404,
                format!("variante inconnue: {}", key.unwrap_or("null")),
            ));
        };
        let i = &self.0;
        let ck = seg_key(ok_id, key, s);
        let (cached, pending) = {
            let mut st = i.state();
            let (born, continued) = i.touch_cursor(&mut st, ok_id, key, s);
            let cached = st.seg_cache.get(&ck);
            let mut pending = None;
            if cached.is_none() {
                let inflight = st.seg_inflight.contains_key(&ck);
                // Ouvert AVANT les préchargements : le segment attendu passe en premier.
                pending = Some(i.segment_download(&mut st, ok_id, key, s));
                if continued && born.is_some_and(|b| i.perf_now() - b > 30_000.0) {
                    let (bytes, max) = (st.seg_cache.bytes(), st.seg_cache.max_bytes());
                    i.log_catch_up(&ck, inflight, bytes, max);
                }
            }
            i.schedule_prefetch(&mut st, ok_id, key);
            (cached, pending)
        };
        if let Some(c) = cached {
            let len = c.len() as u64;
            let mut r = with_status(200, Body::from(c));
            segment_headers(&mut r, Some(len));
            return Ok(r);
        }
        let dl = wait_result(pending.expect("téléchargement")).await?;
        let mut r = with_status(200, Body::from_stream(dl.stream()));
        segment_headers(&mut r, dl.content_length);
        Ok(r)
    }

    /// MP4 progressif : meilleure qualité (épinglée pendant la lecture), Range
    /// relayé dans les deux sens. Le téléchargement amont s'arrête quand le
    /// client s'en va (le corps relayé est abandonné avec la réponse).
    pub async fn mp4(&self, db: &Db, ok_id: &str, range_in: Option<&str>) -> VResult<Response> {
        self.assert_known(db, ok_id).await?;
        let i = &self.0;
        let range = sanitize_range(range_in);
        for attempt in 0..2 {
            let stream = i.resolve_ok_stream(ok_id, attempt > 0).await?;
            let Some(src) = i.choose_mp4(ok_id, &stream) else {
                return Err(VErr::proxy(404, "pas de MP4 pour ce replay"));
            };
            if !okru::is_allowed_media_host(&src.url) {
                return Err(VErr::proxy(502, "hôte non autorisé"));
            }
            let mut headers = okru::ok_headers();
            if let Some(r) = range {
                headers.push(("Range", r.to_string()));
            }
            // Corps de plusieurs Go lu au rythme du lecteur : pas de délai total.
            let resp = i
                .follow_manual(
                    &src.url,
                    headers,
                    Opts {
                        timeout_ms: 20_000,
                        retries: 1,
                        streaming: true,
                    },
                )
                .await?;
            if resp.ok() {
                let ctype = resp
                    .header("content-type")
                    .unwrap_or_default()
                    .to_lowercase();
                let status = resp.status();
                let (len, cr) = (resp.header("content-length"), resp.header("content-range"));
                let mut r = with_status(status, Body::from_stream(resp.resp.bytes_stream()));
                let h = r.headers_mut();
                h.insert(
                    header::CONTENT_TYPE,
                    header_value(if ctype.starts_with("video/") {
                        &ctype
                    } else {
                        "video/mp4"
                    }),
                );
                h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                // La qualité servie peut changer d'une session à l'autre : pas de cache navigateur.
                h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                h.insert(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    HeaderValue::from_static("*"),
                );
                if let Some(l) = len.filter(|v| !v.is_empty()) {
                    h.insert(header::CONTENT_LENGTH, header_value(&l));
                }
                if let Some(c) = cr.filter(|v| !v.is_empty()) {
                    h.insert(header::CONTENT_RANGE, header_value(&c));
                }
                return Ok(r);
            }
            let status = resp.status();
            let cr = resp.header("content-range");
            drop(resp);
            if status == 416 {
                let mut r = with_status(416, Body::empty());
                let h = r.headers_mut();
                h.insert(header::CONTENT_RANGE, header_value(&cr.unwrap_or_default()));
                h.insert(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    HeaderValue::from_static("*"),
                );
                return Ok(r);
            }
            if !(status == 403 || status == 410) || attempt > 0 {
                return Err(VErr::proxy(502, format!("amont HTTP {status}")));
            }
        }
        Err(VErr::proxy(502, "MP4 indisponible"))
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn logs(&self) -> MutexGuard<'_, Logs> {
        self.logs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `Date.now()`.
    fn now_ms(&self) -> f64 {
        let real = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        (real + self.clock_offset.load(Ordering::SeqCst)) as f64
    }

    /// `performance.now()`.
    fn perf_now(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    fn next_id(&self) -> u64 {
        self.ids.fetch_add(1, Ordering::SeqCst)
    }

    fn log(&self, line: String) {
        println!("{line}");
        if let Some(c) = self.logs().captured.as_mut() {
            c.push(line);
        }
    }

    // -------------------------------------------------------------- réglages

    fn env_var(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(m) => m
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(name)
                .cloned(),
            None => std::env::var(name).ok(),
        }
    }

    /// Nombre lu dans l'environnement ; défaut si absent, invalide ou sous le minimum.
    fn env_number(&self, name: &str, def: f64, min: f64, max: f64) -> f64 {
        let Some(raw) = self.env_var(name) else {
            return def;
        };
        if hls::js_trim(&raw).is_empty() {
            return def;
        }
        let n = crate::api::js_number(&raw);
        if !n.is_finite() || n < min {
            return def;
        }
        n.min(max)
    }

    /// Budget du cache de segments (octets) : SEGMENT_CACHE_MB ; 0 le désactive.
    fn segment_cache_bytes(&self) -> u64 {
        (self.env_number("SEGMENT_CACHE_MB", DEFAULT_SEGMENT_CACHE_MB, 0.0, 16_384.0)
            * 1024.0
            * 1024.0)
            .floor() as u64
    }

    /// (aheadSec, concurrency), relus à chaque usage.
    fn prefetch_settings(&self) -> (f64, usize) {
        (
            self.env_number("PREFETCH_AHEAD_SEC", 90.0, 0.0, 900.0),
            self.env_number("PREFETCH_CONCURRENCY", 3.0, 1.0, 8.0)
                .floor() as usize,
        )
    }

    fn prefetch_window(&self, seg_sec: f64) -> i64 {
        window_for(self.prefetch_settings().0, seg_sec)
    }

    /// (stallMs, headersMs, retries), relus à chaque segment.
    fn download_settings(&self) -> (f64, u64, u32) {
        let stall = self.env_number("SEGMENT_STALL_MS", 5_000.0, 100.0, 60_000.0);
        (
            stall,
            js_round(stall * 1.6) as u64,
            self.env_number("SEGMENT_RETRIES", 4.0, 0.0, 10.0).floor() as u32,
        )
    }

    // -------------------------------------------------------------- requêtes amont

    /// URL réellement contactée (amont simulé en test) et hôte d'origine.
    fn target(&self, url: &str) -> VResult<(String, Option<String>)> {
        let Some(base) = &self.test_upstream else {
            return Ok((url.to_string(), None));
        };
        let u = url::Url::parse(url).map_err(|_| VErr::plain("fetch failed"))?;
        let mut pq = u.path().to_string();
        if let Some(q) = u.query() {
            pq.push('?');
            pq.push_str(q);
        }
        Ok((
            format!("{}{pq}", base.trim_end_matches('/')),
            u.host_str().map(str::to_string),
        ))
    }

    fn request(
        &self,
        client: &reqwest::Client,
        url: &str,
        headers: &[(&'static str, String)],
    ) -> VResult<reqwest::RequestBuilder> {
        let (target, host) = self.target(url)?;
        let mut b = client.get(target);
        for (k, v) in headers {
            b = b.header(*k, v.as_str());
        }
        if let Some(h) = host {
            b = b.header(TEST_HOST_HEADER, h);
        }
        Ok(b)
    }

    /// URL finale d'une réponse (redirections suivies par le client).
    fn final_url(&self, resp: &reqwest::Response, requested: &str) -> String {
        if self.test_upstream.is_some() {
            requested.to_string()
        } else {
            resp.url().to_string()
        }
    }

    /// `fetchWithRetry` : UA navigateur, délai total, nouvelles tentatives sur
    /// erreur réseau ou 5xx (pause de 500 ms × n, y compris après la dernière).
    async fn fetch_with_retry(
        &self,
        follow: bool,
        url: &str,
        extra: Vec<(&'static str, String)>,
        timeout_ms: u64,
        retries: u32,
    ) -> VResult<Up> {
        let mut headers: Vec<(&'static str, String)> = vec![
            ("User-Agent", crate::http::BROWSER_UA.to_string()),
            ("Accept-Language", "en-US,en;q=0.9".to_string()),
        ];
        for (k, v) in extra {
            headers.retain(|(h, _)| *h != k);
            headers.push((k, v));
        }
        let client = if follow { &self.follow } else { &self.manual };
        let mut last = VErr::plain("fetch failed");
        for attempt in 0..=retries {
            let req = self
                .request(client, url, &headers)?
                .timeout(Duration::from_millis(timeout_ms));
            match req.send().await {
                Ok(res) if res.status().is_server_error() && attempt < retries => {
                    last = VErr::plain(format!("HTTP {} pour {url}", res.status().as_u16()));
                }
                Ok(res) => {
                    let u = self.final_url(&res, url);
                    return Ok(Up { resp: res, url: u });
                }
                Err(e) => last = fetch_error(e),
            }
            tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
        Err(last)
    }

    /// Requête sans suivi de redirection, délai limité à l'arrivée des en-têtes.
    async fn fetch_headers_timeout(
        &self,
        url: &str,
        headers: &[(&'static str, String)],
        timeout_ms: u64,
    ) -> VResult<Up> {
        let mut h: Vec<(&'static str, String)> =
            vec![("User-Agent", crate::http::BROWSER_UA.to_string())];
        for (k, v) in headers {
            h.retain(|(x, _)| x != k);
            h.push((k, v.clone()));
        }
        let req = self.request(&self.manual, url, &h)?;
        match tokio::time::timeout(Duration::from_millis(timeout_ms), req.send()).await {
            Err(_) => Err(VErr::plain("délai amont dépassé")),
            Ok(Err(e)) => Err(fetch_error(e)),
            Ok(Ok(res)) => Ok(Up {
                resp: res,
                url: url.to_string(),
            }),
        }
    }

    async fn upstream_fetch(
        &self,
        url: &str,
        headers: &[(&'static str, String)],
        opts: Opts,
        retries: u32,
    ) -> VResult<Up> {
        if opts.streaming {
            return self
                .fetch_headers_timeout(url, headers, opts.timeout_ms)
                .await;
        }
        let mut up = self
            .fetch_with_retry(false, url, headers.to_vec(), opts.timeout_ms, retries)
            .await?;
        up.url = url.to_string();
        Ok(up)
    }

    /// Suit une redirection en validant la destination AVANT de l'émettre :
    /// une seule, vers un hôte autorisé ; une seconde est refusée.
    async fn follow_manual(
        &self,
        url: &str,
        headers: Vec<(&'static str, String)>,
        opts: Opts,
    ) -> VResult<Up> {
        let mut resp = self
            .upstream_fetch(url, &headers, opts, opts.retries)
            .await?;
        if (300..400).contains(&resp.status()) {
            let Some(loc) = resp.header("location") else {
                return Err(VErr::proxy(502, "redirection sans cible"));
            };
            let next = hls::resolve_url(&loc, url).map_err(VErr::plain)?;
            if !okru::is_allowed_media_host(&next) {
                return Err(VErr::proxy(502, "redirection refusée"));
            }
            // Corps de la 3xx inutile : abandonné (connexion libérée).
            drop(resp);
            resp = self.upstream_fetch(&next, &headers, opts, 0).await?;
            if (300..400).contains(&resp.status()) {
                return Err(VErr::proxy(502, "redirection refusée"));
            }
        }
        if !okru::is_allowed_media_host(&resp.url) {
            return Err(VErr::proxy(502, "redirection refusée"));
        }
        Ok(resp)
    }

    // -------------------------------------------------------------- résolution du flux

    /// `fetchText` : texte d'une URL (redirections suivies, 2 nouvelles
    /// tentatives), erreur `HTTP <statut> pour <url>` hors 2xx.
    async fn fetch_text(
        &self,
        url: &str,
        extra: Vec<(&'static str, String)>,
        timeout_ms: u64,
    ) -> VResult<String> {
        let res = self
            .fetch_with_retry(true, url, extra, timeout_ms, 2)
            .await?;
        if !res.ok() {
            return Err(VErr::plain(format!("HTTP {} pour {url}", res.status())));
        }
        res.text().await
    }

    /// `fetchOkEmbed` : page d'embed ok.ru lue et analysée.
    async fn fetch_embed(&self, ok_id: &str) -> VResult<okru::OkEmbedInfo> {
        if !okru::is_valid_ok_id(ok_id) {
            return Err(VErr::plain(format!("okId invalide: {ok_id}")));
        }
        let url = format!("https://ok.ru/videoembed/{ok_id}");
        let html = self
            .fetch_text(
                &url,
                vec![("Referer", "https://basketball-video.com/".into())],
                20_000,
            )
            .await?;
        Ok(okru::parse_ok_embed(&html, ok_id))
    }

    /// Page d'embed puis playlist maîtresse.
    async fn do_resolve(&self, ok_id: &str) -> VResult<OkStream> {
        let embed = self.fetch_embed(ok_id).await?;
        let mut master_text = String::new();
        let mut master_url = String::new();
        let mut variants = Vec::new();
        let mut hls_error = false;
        let hls_url = embed.hls_manifest_url.clone().filter(|u| !u.is_empty());
        if let Some(hls_url) = &hls_url {
            let r: VResult<(String, String, Vec<Variant>)> = async {
                let res = self
                    .fetch_with_retry(true, hls_url, okru::ok_headers(), 20_000, 2)
                    .await?;
                if !res.ok() {
                    return Err(VErr::plain(format!(
                        "HTTP {} pour master.m3u8",
                        res.status()
                    )));
                }
                let u = if res.url.is_empty() {
                    hls_url.clone()
                } else {
                    res.url.clone()
                };
                let text = res.text().await?;
                let vs = okru::parse_master_variants(&text, &u).map_err(VErr::plain)?;
                Ok((text, u, vs))
            }
            .await;
            match r {
                Ok((t, u, v)) => {
                    master_text = t;
                    master_url = u;
                    variants = v;
                }
                // Sans MP4 de repli, un master illisible est fatal ; sinon on sert le MP4.
                Err(e) if embed.mp4.is_empty() => return Err(e),
                Err(_) => hls_error = true,
            }
        } else if embed.mp4.is_empty() {
            return Err(VErr::plain(format!(
                "Pas de flux pour ok.ru/{ok_id}, ni HLS ni MP4 (statut: {})",
                if embed.status.is_empty() {
                    "inconnu"
                } else {
                    &embed.status
                }
            )));
        }
        let signed = match &embed.hls_manifest_url {
            Some(u) => u.clone(),
            None => embed.mp4.first().map(|m| m.url.clone()).unwrap_or_default(),
        };
        let now = self.now_ms();
        Ok(OkStream {
            ok_id: ok_id.to_string(),
            master_url,
            master_text,
            expires_at: okru::signed_url_expiry(&signed).unwrap_or(now + DEFAULT_LIFETIME_MS),
            fetched_at: now,
            variants,
            mp4: embed.mp4,
            hls_error,
            duration: embed.duration,
            poster: embed.poster,
            dash_url: embed.dash_manifest_url,
        })
    }

    fn entry_for<'a>(&self, st: &'a mut State, ok_id: &str) -> &'a mut StreamEntry {
        if !st.streams.contains_key(ok_id) {
            // Purge des flux expirés : la table vit aussi longtemps que le processus.
            if st.streams.len() >= STREAMS_PURGE_AT {
                let now = self.now_ms();
                st.streams.retain(|_, v| {
                    v.inflight.is_some() || v.stream.as_ref().is_some_and(|s| s.expires_at > now)
                });
            }
            st.streams.insert(
                ok_id.to_string(),
                StreamEntry {
                    stream: None,
                    inflight: None,
                },
            );
        }
        st.streams.get_mut(ok_id).expect("entrée")
    }

    /// Lance UNE résolution pour cet okId (ou rejoint celle en cours).
    fn start_resolve(
        self: &Arc<Self>,
        st: &mut State,
        ok_id: &str,
    ) -> Flight<VResult<Arc<OkStream>>> {
        let e = self.entry_for(st, ok_id);
        if let Some((_, f)) = &e.inflight {
            return f.clone();
        }
        let id = self.next_id();
        let (tx, f) = Flight::new();
        e.inflight = Some((id, f.clone()));
        let me = self.clone();
        let ok_id = ok_id.to_string();
        tokio::spawn(async move {
            let r = me.do_resolve(&ok_id).await.map(Arc::new);
            {
                let mut st = me.state();
                if let Some(e) = st.streams.get_mut(&ok_id) {
                    if e.inflight.as_ref().is_some_and(|(i, _)| *i == id) {
                        // Un échec ne vide pas `stream` : un flux encore valable reste servi.
                        if let Ok(s) = &r {
                            e.stream = Some(s.clone());
                        }
                        e.inflight = None;
                    }
                }
            }
            tx.send_replace(Some(r));
        });
        f
    }

    /// Flux signé, en cache jusqu'à peu avant l'expiration de la signature :
    /// servi tout de suite (rafraîchi en fond s'il approche de l'expiration ou
    /// n'a que du MP4) ; `force` (segment en 403) contourne le cache mais
    /// rejoint une résolution en cours et réutilise un flux de moins de 10 s.
    async fn resolve_ok_stream(
        self: &Arc<Self>,
        ok_id: &str,
        force: bool,
    ) -> VResult<Arc<OkStream>> {
        let flight = {
            let mut st = self.state();
            let now = self.now_ms();
            let e = self.entry_for(&mut st, ok_id);
            let s = e.stream.clone();
            let inflight = e.inflight.as_ref().map(|(_, f)| f.clone());
            if force {
                if let Some(f) = inflight {
                    f
                } else if let Some(s) = s.filter(|s| now - s.fetched_at < FORCE_DEDUP_MS) {
                    return Ok(s);
                } else {
                    self.start_resolve(&mut st, ok_id)
                }
            } else if let Some(s) = s.filter(|s| now < s.expires_at - STREAM_EXPIRY_MARGIN_MS) {
                if should_refresh(&s, now) {
                    let _ = self.start_resolve(&mut st, ok_id);
                }
                return Ok(s);
            } else {
                self.start_resolve(&mut st, ok_id)
            }
        };
        wait_result(flight).await
    }

    async fn variant_for(
        self: &Arc<Self>,
        ok_id: &str,
        key: Option<&str>,
        force: bool,
    ) -> VResult<(Arc<OkStream>, Variant)> {
        let mut stream = self.resolve_ok_stream(ok_id, force).await?;
        let mut variant = pick_variant(&stream, key).cloned();
        // Variante absente d'un flux en cache sans HLS : une re-résolution avant d'échouer.
        if variant.is_none() && !force && stream.master_text.is_empty() {
            stream = self.resolve_ok_stream(ok_id, true).await?;
            variant = pick_variant(&stream, key).cloned();
        }
        match variant {
            Some(v) => Ok((stream, v)),
            None => Err(VErr::proxy(
                404,
                format!("variante inconnue: {}", key.unwrap_or("null")),
            )),
        }
    }

    // -------------------------------------------------------------- playlists média

    /// Lit la playlist média amont (redirection validée avant d'être suivie).
    async fn fetch_media_playlist(
        self: &Arc<Self>,
        ok_id: &str,
        key: Option<&str>,
    ) -> VResult<CachedPlaylist> {
        for attempt in 0..2 {
            let (stream, variant) = self.variant_for(ok_id, key, attempt > 0).await?;
            let r = self
                .follow_manual(
                    &variant.url,
                    okru::ok_headers(),
                    Opts {
                        timeout_ms: 20_000,
                        retries: 2,
                        streaming: false,
                    },
                )
                .await?;
            if r.ok() {
                let text = r.text().await?;
                if !hls::is_valid_playlist(&text) {
                    return Err(VErr::proxy(502, "playlist média invalide"));
                }
                return Ok(CachedPlaylist {
                    text: hls::rewrite_media_playlist(&text, ok_id, &variant.key),
                    names: hls::segment_names(&text).into_iter().collect(),
                    seg_sec: hls::average_segment_sec(&text),
                    expires_at: stream.expires_at - STREAM_EXPIRY_MARGIN_MS,
                });
            }
            let status = r.status();
            drop(r);
            if ![400, 403, 404, 410].contains(&status) || attempt > 0 {
                return Err(VErr::proxy(502, format!("amont HTTP {status}")));
            }
        }
        Err(VErr::proxy(502, "playlist indisponible"))
    }

    /// Playlist média depuis le cache, ou lue une seule fois chez ok.ru.
    fn load_playlist(
        self: &Arc<Self>,
        st: &mut State,
        ok_id: &str,
        key: Option<&str>,
    ) -> PlaylistFlight {
        let ck = format!("{ok_id}|{}", key.unwrap_or(""));
        if let Some(hit) = st.playlists.get(&ck) {
            if hit.expires_at > self.now_ms() {
                return Flight::ready(Ok(hit.clone()));
            }
        }
        if let Some((_, f)) = st.playlist_inflight.get(&ck) {
            return f.clone();
        }
        let id = self.next_id();
        let (tx, f) = Flight::new();
        st.playlist_inflight.insert(ck.clone(), (id, f.clone()));
        let me = self.clone();
        let (ok_id, key) = (ok_id.to_string(), key.map(str::to_string));
        tokio::spawn(async move {
            let r = me
                .fetch_media_playlist(&ok_id, key.as_deref())
                .await
                .map(Arc::new);
            {
                let mut st = me.state();
                if let Ok(pl) = &r {
                    st.playlists.shift_remove(&ck);
                    if st.playlists.len() >= PLAYLIST_CACHE_MAX {
                        st.playlists.shift_remove_index(0);
                    }
                    st.playlists.insert(ck.clone(), pl.clone());
                }
                if st.playlist_inflight.get(&ck).is_some_and(|(i, _)| *i == id) {
                    st.playlist_inflight.remove(&ck);
                }
            }
            tx.send_replace(Some(r));
        });
        f
    }

    // -------------------------------------------------------------- positions de lecture

    fn group_window(&self, st: &State, ahead_sec: f64, group: &str) -> i64 {
        window_for(
            ahead_sec,
            st.playlists
                .get(group)
                .map_or(DEFAULT_SEGMENT_SEC, |p| p.seg_sec),
        )
    }

    /// Enregistre une demande du lecteur : (naissance du curseur, `continued`
    /// = la demande prolonge une lecture suivie, ni saut ni début).
    fn touch_cursor(
        &self,
        st: &mut State,
        ok_id: &str,
        key: &str,
        name: &str,
    ) -> (Option<f64>, bool) {
        let Some(idx) = seg_index(name) else {
            return (None, false);
        };
        let now = self.perf_now();
        let group = format!("{ok_id}|{key}");
        st.prefetch.cursors.retain(|c| {
            now - c.seen <= CURSOR_TTL_MS
                // Changement de qualité (ABR) : l'ancienne variante est abandonnée.
                && !(c.ok_id == ok_id && c.key != key && (c.idx - idx).abs() <= SWITCH_TOLERANCE)
        });
        let w = self.group_window(st, self.prefetch_settings().0, &group);
        let mut best: Option<usize> = None;
        for (i, c) in st.prefetch.cursors.iter().enumerate() {
            // Un pas en avant dans la fenêtre, ou un léger retour (nouvelle tentative).
            if c.group != group || idx < c.idx - 2 || idx > c.idx + w + 1 {
                continue;
            }
            if best.is_none_or(|b| (idx - c.idx).abs() < (idx - st.prefetch.cursors[b].idx).abs()) {
                best = Some(i);
            }
        }
        if let Some(b) = best {
            let c = &mut st.prefetch.cursors[b];
            c.idx = idx;
            c.name = name.to_string();
            c.seen = now;
            return (Some(c.born), true);
        }
        st.prefetch.cursors.push(Cursor {
            ok_id: ok_id.to_string(),
            key: key.to_string(),
            group,
            name: name.to_string(),
            idx,
            seen: now,
            born: now,
        });
        if st.prefetch.cursors.len() > CURSOR_MAX {
            st.prefetch.cursors.sort_by(|a, b| {
                b.seen
                    .partial_cmp(&a.seen)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            st.prefetch.cursors.truncate(CURSOR_MAX);
        }
        (Some(now), false)
    }

    // -------------------------------------------------------------- segments

    /// Ouvre la requête amont d'un segment à partir de l'octet `from` (Range).
    ///  - erreur réseau, en-têtes trop lents ou 5xx : nouvelle tentative (budget) ;
    ///  - 400/403/404/410 (signature expirée) : une re-résolution, puis abandon ;
    ///  - réponse « playlist » (nom inconnu chez ok.ru) : 404.
    async fn open_upstream(
        self: &Arc<Self>,
        t: &SegTarget,
        from: u64,
        budget: &mut u32,
    ) -> VResult<Up> {
        let (_, headers_ms, _) = self.download_settings();
        let mut forced = false;
        loop {
            let (_, variant) = self.variant_for(&t.ok_id, Some(&t.key), forced).await?;
            let url =
                hls::resolve_segment_url(&t.s, &variant.url).map_err(|m| VErr::proxy(400, m))?;
            if !okru::is_allowed_media_host(&url) {
                return Err(VErr::proxy(400, "hôte non autorisé"));
            }
            let mut headers = okru::ok_headers();
            if from > 0 {
                headers.push(("Range", format!("bytes={from}-")));
            }
            let opts = Opts {
                timeout_ms: headers_ms,
                retries: 1,
                streaming: true,
            };
            let failure = match self.follow_manual(&url, headers, opts).await {
                Ok(resp) => {
                    let status = resp.status();
                    if resp.ok() {
                        // ok.ru répond par la playlist (200) pour un nom inconnu.
                        if is_playlist_type(&resp.header("content-type").unwrap_or_default()) {
                            return Err(VErr::proxy(404, "segment introuvable"));
                        }
                        return Ok(resp);
                    }
                    // Reprise demandée au-delà de la fin : l'appelant conclut.
                    if status == 416 && from > 0 {
                        return Ok(resp);
                    }
                    drop(resp);
                    if [400, 403, 404, 410].contains(&status) {
                        if forced {
                            return Err(VErr::proxy(502, format!("amont HTTP {status}")));
                        }
                        forced = true;
                        continue;
                    }
                    if status < 500 && status != 429 {
                        return Err(VErr::proxy(502, format!("amont HTTP {status}")));
                    }
                    format!("amont HTTP {status}")
                }
                Err(e) if e.status.is_some() => return Err(e),
                // Réseau, ou en-têtes trop lents.
                Err(e) => e.msg,
            };
            if *budget == 0 {
                return Err(VErr::proxy(502, failure));
            }
            *budget -= 1;
            tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
        }
    }

    /// Lit un corps amont dans le téléchargement partagé, sous surveillance
    /// (blocage, lenteur, coupure). Les `skip` premiers octets sont ignorés
    /// (amont qui ignore Range). Le flux est abandonné par l'appelant : une
    /// connexion bloquée n'est ni gardée ni réutilisée.
    async fn read_body(
        &self,
        dl: &SharedDownload,
        body: &mut (impl Stream<Item = reqwest::Result<Bytes>> + Unpin),
        skip: u64,
        t0: f64,
        seg_sec: f64,
        slow_check: bool,
    ) -> ReadOutcome {
        let (stall_ms, _, _) = self.download_settings();
        let start = self.perf_now();
        let mut last = start;
        let mut to_skip = skip;
        let mut raw = 0u64;
        let period = Duration::from_secs_f64((stall_ms / 4.0).clamp(25.0, 500.0) / 1000.0);
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let now = self.perf_now();
                    if now - last >= stall_ms {
                        return ReadOutcome::Stall;
                    }
                    let Some(cl) = dl.content_length else { continue };
                    if !slow_check || now - start < stall_ms {
                        continue;
                    }
                    let rate = raw as f64 / (now - start); // octets par ms
                    let remaining = (cl as f64 - dl.received() as f64 + to_skip as f64) / rate.max(1e-3);
                    if remaining > stall_ms && now - t0 + remaining > SLOW_RESTART_FACTOR * seg_sec * 1000.0 {
                        return ReadOutcome::Slow(js_round(rate * 8.0));
                    }
                }
                r = body.next() => match r {
                    None => return ReadOutcome::End,
                    Some(Err(e)) => return ReadOutcome::Error(body_error(e).msg),
                    Some(Ok(mut chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }
                        last = self.perf_now();
                        raw += chunk.len() as u64;
                        if to_skip > 0 {
                            let n = to_skip.min(chunk.len() as u64);
                            to_skip -= n;
                            chunk = chunk.slice(n as usize..);
                            if chunk.is_empty() {
                                continue;
                            }
                        }
                        dl.push(chunk);
                    }
                }
            }
        }
    }

    /// Lit le segment amont jusqu'au bout, puis le range au cache. Sur
    /// blocage, lenteur, coupure ou erreur réseau, reprend à l'octet atteint
    /// (`Range: bytes=N-`) sur une connexion neuve.
    async fn pump(
        self: &Arc<Self>,
        dl: &Arc<SharedDownload>,
        first: Up,
        t: &SegTarget,
        mut budget: u32,
    ) {
        let t0 = self.perf_now();
        let mut resumes = 0u32;
        let r: VResult<()> = async {
            let mut resp = first;
            let mut skip = 0u64;
            let mut slow_restarts = 0u32;
            loop {
                let seg_sec = self
                    .state()
                    .playlists
                    .get(&t.group)
                    .map_or(DEFAULT_SEGMENT_SEC, |p| p.seg_sec);
                let mut body = Box::pin(resp.resp.bytes_stream());
                let out = self
                    .read_body(dl, &mut body, skip, t0, seg_sec, slow_restarts == 0)
                    .await;
                drop(body);
                let received = dl.received();
                if matches!(out, ReadOutcome::End) {
                    match dl.content_length {
                        None => break,
                        Some(cl) if received == cl => break,
                        Some(cl) if received > cl => {
                            return Err(VErr::plain(format!(
                                "segment trop long ({received}/{cl} octets)"
                            )))
                        }
                        _ => {}
                    }
                }
                if matches!(out, ReadOutcome::Slow(_)) {
                    slow_restarts += 1;
                }
                let (stall_ms, _, _) = self.download_settings();
                if budget == 0 {
                    return Err(VErr::plain(format!(
                        "{} ({received}/{} octets)",
                        describe_outcome(&out, stall_ms),
                        dl.content_length.map_or("?".to_string(), |c| c.to_string())
                    )));
                }
                budget -= 1;
                resumes += 1;
                self.log_resume(t, &out, dl, resumes, stall_ms);
                resp = self.open_upstream(t, received, &mut budget).await?;
                let status = resp.status();
                if status == 416 {
                    // Taille inconnue et tout est déjà là : le corps précédent était complet.
                    if dl.content_length.is_none() {
                        break;
                    }
                    return Err(VErr::plain("reprise refusée (HTTP 416)"));
                }
                if status == 206
                    && content_range_start(resp.header("content-range").as_deref())
                        == Some(received as f64)
                {
                    skip = 0;
                } else if status == 200 {
                    // Range ignoré : le corps repart de zéro, on saute ce qui est déjà reçu.
                    let len = num_header(resp.header("content-length").as_deref());
                    if let Some(cl) = dl.content_length {
                        if len > 0.0 && len != cl as f64 {
                            return Err(VErr::plain(format!(
                                "segment modifié en amont ({} ≠ {cl} octets)",
                                crate::jsval::js_number_string(len)
                            )));
                        }
                    }
                    skip = received;
                } else {
                    return Err(VErr::plain(format!("reprise refusée (HTTP {status})")));
                }
            }
            Ok(())
        }
        .await;
        match r {
            Ok(()) => {
                let received = dl.received();
                {
                    let mut st = self.state();
                    record_segment_size(&mut st.prefetch, &t.group, received as f64);
                    // Rangé AVANT `finish` : une requête qui suit trouve le segment en cache.
                    let ahead = self.prefetch_settings().0;
                    let now = self.perf_now();
                    let State {
                        seg_cache,
                        prefetch,
                        playlists,
                        ..
                    } = &mut *st;
                    let rank = |ck: &str| segment_rank(prefetch, playlists, ahead, now, ck);
                    seg_cache.set_ranked(&t.ck, dl.bytes(), received, Some(&rank));
                }
                dl.finish(None);
                self.log_slow_segment(&t.ck, received as f64, self.perf_now() - t0, resumes);
            }
            Err(e) => {
                dl.finish(Some(e.clone()));
                self.log_segment_failure(t, &e, resumes);
            }
        }
    }

    /// Ouvre le segment chez ok.ru, rend le téléchargement dès les en-têtes
    /// valides, puis le mène à son terme.
    async fn open_segment(
        self: &Arc<Self>,
        t: SegTarget,
        tx: watch::Sender<Option<VResult<Arc<SharedDownload>>>>,
    ) {
        let mut budget = self.download_settings().2;
        match self.open_upstream(&t, 0, &mut budget).await {
            Err(e) => {
                tx.send_replace(Some(Err(e)));
            }
            Ok(resp) => {
                let dl = Arc::new(SharedDownload::new(positive_len(
                    resp.header("content-length").as_deref(),
                )));
                tx.send_replace(Some(Ok(dl.clone())));
                self.pump(&dl, resp, &t, budget).await;
            }
        }
    }

    /// Téléchargement du segment, partagé avec celui déjà en vol s'il existe.
    fn segment_download(
        self: &Arc<Self>,
        st: &mut State,
        ok_id: &str,
        key: &str,
        s: &str,
    ) -> SegmentFlight {
        let ck = seg_key(ok_id, key, s);
        if let Some((_, f)) = st.seg_inflight.get(&ck) {
            return f.clone();
        }
        let id = self.next_id();
        let (tx, f) = Flight::new();
        st.seg_inflight.insert(ck.clone(), (id, f.clone()));
        let me = self.clone();
        let t = SegTarget {
            ok_id: ok_id.to_string(),
            key: key.to_string(),
            s: s.to_string(),
            ck: ck.clone(),
            group: format!("{ok_id}|{key}"),
        };
        tokio::spawn(async move {
            me.open_segment(t, tx).await;
            let mut st = me.state();
            if st.seg_inflight.get(&ck).is_some_and(|(i, _)| *i == id) {
                st.seg_inflight.remove(&ck);
            }
            // Une place s'est libérée, ou la taille des segments est désormais connue.
            me.drain_prefetch(&mut st);
        });
        f
    }

    /// Relais direct d'une requête partielle (Range), sans cache.
    async fn passthrough_segment(
        self: &Arc<Self>,
        ok_id: &str,
        key: Option<&str>,
        s: &str,
        range: &str,
    ) -> VResult<Response> {
        for attempt in 0..2 {
            let (_, variant) = self.variant_for(ok_id, key, attempt > 0).await?;
            let url = hls::resolve_segment_url(s, &variant.url).map_err(|m| VErr::proxy(400, m))?;
            if !okru::is_allowed_media_host(&url) {
                return Err(VErr::proxy(400, "hôte non autorisé"));
            }
            let mut headers = okru::ok_headers();
            headers.push(("Range", range.to_string()));
            let resp = self.follow_manual(&url, headers, DEFAULT_OPTS).await?;
            let status = resp.status();
            if resp.ok() || status == 206 {
                let (len, cr) = (resp.header("content-length"), resp.header("content-range"));
                let mut r = with_status(status, Body::from_stream(resp.resp.bytes_stream()));
                segment_headers(&mut r, None);
                let h = r.headers_mut();
                if let Some(l) = len.filter(|v| !v.is_empty()) {
                    h.insert(header::CONTENT_LENGTH, header_value(&l));
                }
                if let Some(c) = cr.filter(|v| !v.is_empty()) {
                    h.insert(header::CONTENT_RANGE, header_value(&c));
                }
                return Ok(r);
            }
            let cr = resp.header("content-range");
            drop(resp);
            if status == 416 {
                let mut r = with_status(416, Body::empty());
                r.headers_mut()
                    .insert(header::CONTENT_RANGE, header_value(&cr.unwrap_or_default()));
                return Ok(r);
            }
            if ![400, 403, 404, 410].contains(&status) || attempt > 0 {
                return Err(VErr::proxy(502, format!("amont HTTP {status}")));
            }
        }
        Err(VErr::proxy(502, "segment indisponible"))
    }

    // -------------------------------------------------------------- préchargement

    /// Lance les préchargements utiles, dans la limite de la concurrence :
    /// candidats recalculés depuis les curseurs actifs, le plus proche d'une
    /// tête de lecture d'abord, segments à venir bornés à 60 % du cache.
    fn drain_prefetch(self: &Arc<Self>, st: &mut State) {
        let (ahead, concurrency) = self.prefetch_settings();
        if st.prefetch.active >= concurrency || st.seg_cache.max_bytes() == 0 {
            return;
        }
        let now = self.perf_now();
        if st.prefetch.failed.len() > 500 {
            st.prefetch
                .failed
                .retain(|_, at| now - *at <= PREFETCH_FAIL_COOLDOWN_MS);
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut cands: Vec<(Cursor, String, i64)> = Vec::new();
        let mut committed = 0f64;
        for c in &st.prefetch.cursors {
            if now - c.seen > CURSOR_ACTIVE_MS {
                continue;
            }
            // Playlist en cours de lecture : on attend ses bornes.
            if st.playlist_inflight.contains_key(&c.group) {
                continue;
            }
            let pl = st.playlists.get(&c.group);
            let end = st.prefetch.ends.get(&c.group).copied();
            let w = self.group_window(st, ahead, &c.group);
            for d in 1..=w {
                let Some(name) = hls::next_segment_name(&c.name, d) else {
                    break;
                };
                if pl.is_some_and(|p| !p.names.contains(&name))
                    || end.is_some_and(|e| c.idx + d >= e)
                {
                    break;
                }
                let ck = seg_key(&c.ok_id, &c.key, &name);
                if !seen.insert(ck.clone()) {
                    continue;
                }
                if let Some(size) = st.seg_cache.size_of(&ck) {
                    committed += size as f64;
                } else if st.seg_inflight.contains_key(&ck) {
                    committed += est_segment_bytes(&st.prefetch, &c.group);
                } else if st
                    .prefetch
                    .failed
                    .get(&ck)
                    .is_none_or(|at| now - at >= PREFETCH_FAIL_COOLDOWN_MS)
                {
                    cands.push((c.clone(), name, d));
                }
            }
        }
        // Le plus urgent d'abord : distance à la tête de lecture, puis lecteur le plus récent.
        cands.sort_by(|a, b| {
            a.2.cmp(&b.2).then(
                b.0.seen
                    .partial_cmp(&a.0.seen)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        });
        let budget = st.seg_cache.max_bytes() as f64 * PREFETCH_BUDGET_SHARE;
        for (c, name, _) in cands {
            if st.prefetch.active >= concurrency {
                break;
            }
            let est = est_segment_bytes(&st.prefetch, &c.group);
            if committed + est > budget {
                break;
            }
            committed += est;
            self.start_prefetch(st, &c, &name);
        }
    }

    fn start_prefetch(self: &Arc<Self>, st: &mut State, c: &Cursor, name: &str) {
        let gen = st.prefetch.gen;
        let ck = seg_key(&c.ok_id, &c.key, name);
        st.prefetch.active += 1;
        let f = self.segment_download(st, &c.ok_id, &c.key, name);
        let me = self.clone();
        let (group, name) = (c.group.clone(), name.to_string());
        tokio::spawn(async move {
            let err = match wait_result(f).await {
                Ok(dl) => {
                    dl.settled().await;
                    dl.error()
                }
                Err(e) => Some(e),
            };
            let mut st = me.state();
            if gen != st.prefetch.gen {
                return;
            }
            if let Some(e) = err {
                let now = me.perf_now();
                st.prefetch.failed.insert(ck, now);
                // Au-delà du dernier segment (ok.ru renvoie la playlist) : fin du flux apprise.
                if let (Some(404), Some(idx)) = (e.status, seg_index(&name)) {
                    let prev = st.prefetch.ends.get(&group).copied().unwrap_or(i64::MAX);
                    set_bounded(&mut st.prefetch.ends, &group, prev.min(idx));
                }
            }
            st.prefetch.active -= 1;
            me.drain_prefetch(&mut st);
        });
    }

    /// Après une demande du lecteur : précharge, en lisant d'abord la playlist
    /// si elle n'est pas en mémoire (bornes de la fenêtre, durée des segments).
    fn schedule_prefetch(self: &Arc<Self>, st: &mut State, ok_id: &str, key: &str) {
        let group = format!("{ok_id}|{key}");
        if st.playlists.contains_key(&group)
            || st.seg_cache.max_bytes() == 0
            || self.prefetch_settings().0 <= 0.0
        {
            self.drain_prefetch(st);
            return;
        }
        // Playlist illisible récemment : on n'insiste pas à chaque segment.
        let fail_key = format!("pl|{group}");
        if st
            .prefetch
            .failed
            .get(&fail_key)
            .is_some_and(|at| self.perf_now() - at < PREFETCH_FAIL_COOLDOWN_MS)
        {
            self.drain_prefetch(st);
            return;
        }
        let gen = st.prefetch.gen;
        let f = self.load_playlist(st, ok_id, Some(key));
        let me = self.clone();
        tokio::spawn(async move {
            let r = wait_result(f).await;
            let mut st = me.state();
            if r.is_err() && gen == st.prefetch.gen {
                let now = me.perf_now();
                st.prefetch.failed.insert(fail_key, now);
            }
            me.drain_prefetch(&mut st);
        });
    }

    // -------------------------------------------------------------- MP4

    /// Qualité MP4 épinglée par okId : les requêtes Range successives d'une
    /// lecture doivent viser le MÊME fichier ; après 15 min sans requête, on
    /// reprend la meilleure.
    fn choose_mp4(&self, ok_id: &str, stream: &OkStream) -> Option<Mp4Source> {
        let now = self.now_ms();
        let mut st = self.state();
        if let Some(pin) = st.mp4_pins.get_mut(ok_id) {
            if now - pin.last_used < MP4_PIN_IDLE_MS {
                if let Some(same) = stream.mp4.iter().find(|m| m.name == pin.name) {
                    pin.last_used = now;
                    return Some(same.clone());
                }
            }
        }
        let best = okru::best_mp4(&stream.mp4).cloned();
        if let Some(b) = &best {
            if st.mp4_pins.len() >= 200 {
                st.mp4_pins
                    .retain(|_, v| now - v.last_used < MP4_PIN_IDLE_MS);
            }
            st.mp4_pins.insert(
                ok_id.to_string(),
                Mp4Pin {
                    name: b.name.clone(),
                    last_used: now,
                },
            );
        }
        best
    }

    // -------------------------------------------------------------- diagnostics

    /// Segment arrivé en plus de 4 s (au plus une ligne toutes les 20 s).
    fn log_slow_segment(&self, ck: &str, bytes: f64, ms: f64, resumes: u32) {
        let now = self.now_ms();
        {
            let mut l = self.logs();
            if ms < SLOW_SEGMENT_MS || now - l.last_slow < 20_000.0 {
                return;
            }
            l.last_slow = now;
        }
        let kbps = js_round(bytes * 8.0 / ms);
        let suffix = if resumes > 0 {
            format!(" · {resumes} reprise{}", if resumes > 1 { "s" } else { "" })
        } else {
            String::new()
        };
        self.log(format!(
            "[vidéo] segment lent depuis ok.ru : {} Ko en {} s ({kbps} kb/s) — {}{suffix}",
            js_round(bytes / 1024.0),
            to_fixed1(ms / 1000.0),
            seg_label(ck)
        ));
    }

    /// Reprise d'un téléchargement bloqué ou coupé (au plus une ligne toutes les 10 s).
    fn log_resume(
        &self,
        t: &SegTarget,
        out: &ReadOutcome,
        dl: &SharedDownload,
        n: u32,
        stall_ms: f64,
    ) {
        let now = self.now_ms();
        {
            let mut l = self.logs();
            if now - l.last_resume < 10_000.0 {
                return;
            }
            l.last_resume = now;
        }
        let total = match dl.content_length {
            Some(c) if c > 0 => format!("/{}", js_round(c as f64 / 1024.0)),
            _ => String::new(),
        };
        self.log(format!(
            "[vidéo] flux ok.ru {} : reprise n° {n} à {}{total} Ko sur une connexion neuve — {} {}",
            describe_outcome(out, stall_ms),
            js_round(dl.received() as f64 / 1024.0),
            t.key,
            t.s
        ));
    }

    /// Segment perdu malgré les reprises (au plus une ligne toutes les 10 s).
    fn log_segment_failure(&self, t: &SegTarget, e: &VErr, resumes: u32) {
        // Préchargement au-delà de la fin (playlist inconnue) : attendu, pas une panne.
        if e.status == Some(404) {
            return;
        }
        let now = self.now_ms();
        {
            let mut l = self.logs();
            if now - l.last_fail < 10_000.0 {
                return;
            }
            l.last_fail = now;
        }
        self.log(format!(
            "[vidéo] segment abandonné après {resumes} reprise(s) : {} — {} {}",
            e.msg, t.key, t.s
        ));
    }

    /// Le lecteur rattrape le préchargement (au plus une ligne toutes les 20 s).
    fn log_catch_up(&self, ck: &str, inflight: bool, bytes: u64, max: u64) {
        let now = self.now_ms();
        {
            let mut l = self.logs();
            if now - l.last_catch_up < 20_000.0 {
                return;
            }
            l.last_catch_up = now;
        }
        self.log(format!(
            "[vidéo] le lecteur rattrape le préchargement ({}) — {} · cache {}/{} Mo",
            if inflight {
                "segment encore en téléchargement"
            } else {
                "segment pas encore préchargé"
            },
            seg_label(ck),
            mb(bytes as f64),
            mb(max as f64)
        ));
    }
}

/// Taille de la fenêtre (en segments) pour des segments de `seg_sec` secondes.
fn window_for(ahead_sec: f64, seg_sec: f64) -> i64 {
    if ahead_sec <= 0.0 {
        return 0;
    }
    let sec = if seg_sec.is_finite() && seg_sec > 0.0 {
        seg_sec
    } else {
        DEFAULT_SEGMENT_SEC
    };
    ((ahead_sec / sec).ceil() as i64).clamp(1, PREFETCH_MAX_SEGMENTS)
}

/// Rang de conservation d'un segment en cache (plus haut = gardé plus longtemps) :
/// 0 déjà lu ou hors fenêtre ; ]1, 2] à venir pour un lecteur en pause ;
/// ]2, 3] à venir pour un lecteur actif ; le plus proche de la tête d'abord.
fn segment_rank(
    prefetch: &Prefetch,
    playlists: &IndexMap<String, Arc<CachedPlaylist>>,
    ahead_sec: f64,
    now: f64,
    ck: &str,
) -> f64 {
    let mut parts = ck.split('|');
    let (Some(ok_id), Some(key), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return 0.0;
    };
    let Some(idx) = seg_index(name) else {
        return 0.0;
    };
    let mut rank = 0f64;
    for c in &prefetch.cursors {
        if c.ok_id != ok_id || c.key != key {
            continue;
        }
        let age = now - c.seen;
        if age > CURSOR_TTL_MS {
            continue;
        }
        let d = idx - c.idx;
        let w = window_for(
            ahead_sec,
            playlists
                .get(&c.group)
                .map_or(DEFAULT_SEGMENT_SEC, |p| p.seg_sec),
        );
        if d <= 0 || d > w {
            continue;
        }
        let base = if age <= CURSOR_ACTIVE_MS { 2.0 } else { 1.0 };
        rank = rank.max(base + 1.0 - d as f64 / (w as f64 + 1.0));
    }
    rank
}

/// Taille estimée d'un segment de la variante (moyenne glissante, à défaut celle des autres).
fn est_segment_bytes(prefetch: &Prefetch, group: &str) -> f64 {
    if let Some(own) = prefetch.sizes.get(group).filter(|v| **v != 0.0) {
        return *own;
    }
    if prefetch.sizes.is_empty() {
        return 2.0 * 1024.0 * 1024.0;
    }
    prefetch.sizes.values().sum::<f64>() / prefetch.sizes.len() as f64
}

fn set_bounded<V>(map: &mut IndexMap<String, V>, key: &str, value: V) {
    if !map.contains_key(key) && map.len() >= PER_GROUP_MAX {
        map.shift_remove_index(0);
    }
    map.insert(key.to_string(), value);
}

fn record_segment_size(prefetch: &mut Prefetch, group: &str, bytes: f64) {
    let v = match prefetch.sizes.get(group).filter(|v| **v != 0.0) {
        Some(prev) => prev * 0.8 + bytes * 0.2,
        None => bytes,
    };
    set_bounded(&mut prefetch.sizes, group, v);
}

// ------------------------------------------------------------------ outils de test

/// Faux ok.ru (pages d'embed, URL signées, playlists), comme `tests/helpers/okFake.ts`.
#[doc(hidden)]
pub mod testkit {
    use serde_json::{json, Value};

    pub const OK_ID: &str = "16668708768428";

    pub fn signed_mp4(name: &str, expires_ms: i64, host: &str) -> String {
        let t = match name {
            "mobile" => 4,
            "lowest" => 0,
            "low" => 1,
            "sd" => 2,
            "hd" => 3,
            "full" => 5,
            _ => 9,
        };
        format!("https://{host}/?expires={expires_ms}&srcIp=203.0.113.7&pr=10&srcAg=CHROME&type={t}&sig=SIG&id=19042703182508")
    }

    pub fn signed_master(expires_ms: i64) -> String {
        format!("https://vd123.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&expires={expires_ms}&srcAg=CHROME&type=2&sig=SIG&id=19042703182508")
    }

    /// Page d'embed ok.ru minimale avec `data-options` échappé HTML.
    /// `videos` : (qualité, URL, disallowed).
    pub fn embed_html(
        hls: Option<&str>,
        videos: &[(&str, String, bool)],
        metadata_as_string: bool,
    ) -> String {
        embed_html_with(6016, hls, videos, metadata_as_string)
    }

    /// `embedHtml({ duration, … })`.
    pub fn embed_html_with(
        duration: u64,
        hls: Option<&str>,
        videos: &[(&str, String, bool)],
        metadata_as_string: bool,
    ) -> String {
        let mut md = json!({
            "movie": { "id": OK_ID, "duration": duration.to_string(), "title": ".", "status": "OK", "poster": "https://iv.okcdn.ru/i?x=1" },
            "videos": videos.iter().map(|(n, u, d)| json!({ "seekSchema": 3, "disallowed": d, "name": n, "url": u })).collect::<Vec<_>>(),
        });
        if let Some(h) = hls {
            md["hlsManifestUrl"] = Value::from(h);
        }
        let metadata = if metadata_as_string {
            Value::from(md.to_string())
        } else {
            md
        };
        let opts = json!({ "flashvars": { "metadata": metadata } });
        let attr = opts
            .to_string()
            .replace('&', "&amp;")
            .replace('"', "&quot;");
        format!(
            "<html><body><div data-module=\"OKVideo\" data-options=\"{attr}\"></div></body></html>"
        )
    }

    pub const MASTER: &str = "#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,QUALITY=sd,RESOLUTION=852x480
https://vd123.okcdn.ru/expires/9999999999999/type/2/sig/SIG/id/19042703182508/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240
https://vd123.okcdn.ru/expires/9999999999999/type/0/sig/SIG/id/19042703182508/video/
";

    pub fn media_playlist(n: usize) -> String {
        let mut lines = vec![
            "#EXTM3U".to_string(),
            "#EXT-X-VERSION:3".into(),
            "#EXT-X-TARGETDURATION:7".into(),
        ];
        for i in 0..n {
            lines.push("#EXTINF:6.0,".into());
            lines.push(format!("MEDIUM{i:05}.ts"));
        }
        lines.push("#EXT-X-ENDLIST".into());
        lines.join("\n") + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_par_octets() {
        let mut lru = ByteLru::new(100);
        lru.set("a", "A", 40);
        lru.set("b", "B", 40);
        assert_eq!(lru.get("a"), Some("A"));
        lru.set("c", "C", 40);
        assert!(!lru.has("b"));
        assert!(lru.has("a") && lru.has("c"));
        assert_eq!(lru.bytes(), 80);
    }

    #[test]
    fn lru_evince_plusieurs_refuse_trop_gros() {
        let mut lru = ByteLru::new(100);
        lru.set("a", "A", 30);
        lru.set("b", "B", 30);
        lru.set("c", "C", 30);
        lru.set("d", "D", 90);
        assert_eq!(lru.len(), 1);
        assert_eq!(lru.bytes(), 90);
        assert!(!lru.set("huge", "H", 101));
        assert!(!lru.has("huge"));
        assert_eq!(lru.bytes(), 90);
    }

    #[test]
    fn lru_remplacement_et_has_sans_effet() {
        let mut lru = ByteLru::new(100);
        lru.set("a", "A", 50);
        lru.set("b", "B", 10);
        lru.set("a", "A2", 20);
        assert_eq!(lru.bytes(), 30);
        lru.has("b");
        lru.set("c", "C", 75);
        assert!(!lru.has("b"));
        assert_eq!(lru.get("a"), Some("A2"));
    }

    #[test]
    fn lru_avec_rang() {
        let rank = std::cell::RefCell::new(HashMap::from([
            ("a", 2.9),
            ("c", 2.1),
            ("b", 0.0),
            ("d", 0.0),
            ("e", 0.0),
        ]));
        let f = |k: &str| *rank.borrow().get(k).unwrap_or(&0.0);
        let mut lru = ByteLru::new(100);
        lru.set_ranked("a", "A", 30, Some(&f));
        lru.set_ranked("b", "B", 30, Some(&f));
        lru.set_ranked("c", "C", 30, Some(&f));
        assert_eq!(lru.get("b"), Some("B"));
        assert!(lru.set_ranked("d", "D", 30, Some(&f)));
        assert_eq!(
            [lru.has("a"), lru.has("b"), lru.has("c"), lru.has("d")],
            [true, false, true, true]
        );
        lru.set_ranked("e", "E", 30, Some(&f));
        assert!(!lru.has("d"));
        rank.borrow_mut().insert("e", 3.0);
        lru.set_ranked("f", "F", 30, Some(&f));
        assert!(!lru.has("f"));
        rank.borrow_mut().insert("f", 2.5);
        lru.set_ranked("f", "F", 30, Some(&f));
        assert_eq!(
            [lru.has("a"), lru.has("c"), lru.has("e"), lru.has("f")],
            [true, false, true, true]
        );
    }

    #[test]
    fn reglages_par_defaut_et_environnement() {
        let v = Video::for_tests(TestConfig::default());
        assert_eq!(v.prefetch_settings(), (90.0, 3));
        assert_eq!(v.prefetch_window(6.0), 15);
        assert_eq!(v.prefetch_window(6.006), 15);
        assert_eq!(v.prefetch_window(2.0), PREFETCH_MAX_SEGMENTS);
        assert_eq!(DEFAULT_SEGMENT_CACHE_MB, 512.0);
        assert_eq!(v.segment_cache_stats().1, 512 * 1024 * 1024);
        assert_eq!(v.download_settings(), (5000.0, 8000, 4));
        v.set_env("PREFETCH_AHEAD_SEC", Some("60"));
        v.set_env("PREFETCH_CONCURRENCY", Some("2"));
        v.set_env("SEGMENT_STALL_MS", Some("abc"));
        assert_eq!(v.prefetch_window(6.0), 10);
        assert_eq!(v.prefetch_settings().1, 2);
        assert_eq!(v.download_settings().0, 5000.0);
        v.set_env("PREFETCH_AHEAD_SEC", Some("0"));
        assert_eq!(v.prefetch_window(6.0), 0);
        // Bornes : sous le minimum → défaut ; au-dessus du maximum → maximum.
        v.set_env("SEGMENT_STALL_MS", Some("50"));
        v.set_env("SEGMENT_RETRIES", Some("99"));
        v.set_env("PREFETCH_CONCURRENCY", Some("2.7"));
        assert_eq!(v.download_settings(), (5000.0, 8000, 10));
        assert_eq!(v.prefetch_settings().1, 2);
        v.set_env("SEGMENT_STALL_MS", Some(" 333 "));
        assert_eq!(v.download_settings().1, 533);
        v.set_env("SEGMENT_CACHE_MB", Some("0"));
        v.clear_proxy_caches();
        assert_eq!(v.segment_cache_stats().1, 0);
    }

    #[test]
    fn outils_javascript() {
        assert_eq!(to_fixed1(0.25), "0.3");
        assert_eq!(to_fixed1(4.2), "4.2");
        assert_eq!(to_fixed1(5.0), "5.0");
        assert_eq!(to_fixed1(0.2), "0.2");
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(seg_index("MEDIUM00042.ts"), Some(42));
        assert_eq!(seg_index("MEDIUM.ts"), None);
        assert_eq!(content_range_start(Some("bytes 400-999/1000")), Some(400.0));
        assert_eq!(content_range_start(Some("BYTES  7-9/10")), Some(7.0));
        assert_eq!(content_range_start(Some("bytes */10")), None);
        assert_eq!(content_range_start(None), None);
        assert_eq!(sanitize_range(Some("bytes=0-9")), Some("bytes=0-9"));
        assert_eq!(
            sanitize_range(Some("bytes=0-9, 20-")),
            Some("bytes=0-9, 20-")
        );
        assert_eq!(sanitize_range(Some("items=0-1")), None);
        assert_eq!(sanitize_range(Some("bytes=")), None);
        assert!(valid_variant_key("sd"));
        assert!(!valid_variant_key("sd|x"));
        assert!(!valid_variant_key(""));
        assert_eq!(seg_label("1|sd|MEDIUM00001.ts"), "sd MEDIUM00001.ts");
    }
}
