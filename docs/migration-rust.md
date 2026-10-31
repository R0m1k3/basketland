# Migration du serveur en Rust

Objectif : tout le **serveur** en Rust (API, files de traduction et de
doublage, proxy vidéo, cron, OCR) ; l'**interface React reste telle
quelle**, compilée en fichiers statiques servis par le binaire Rust. À la
fin, plus de Node.js dans l'image.

Méthode : **par étapes**. Le binaire Rust (`server/`) a écouté sur le port
public et repris les routes une à une, en relayant ce qui n'était pas
encore porté à l'application Next.js, lancée par lui en sous-processus sur
`127.0.0.1:3013`. Chaque étape a été une PR déployable : l'application
marchait à tout moment. **Migration terminée (étape 8b)** : Rust sert tout,
l'interface est un export statique de Next, Node ne sert plus qu'au build
de l'interface et aux tests de référence.

```
navigateur ──► basketland-server (Rust, :3012)
                 ├── /api/… : API, files médias, cron (SQLite)
                 └── le reste : export statique de l'interface (BL_STATIC_DIR=out/)
```

Le relais vers Node reste dans le binaire pour le développement de
l'interface (`next dev` derrière Rust, sans `BL_STATIC_DIR`).

## Règles de la migration

- **Même contrat** : une route portée rend la même réponse que Node (statut,
  en-têtes utiles, JSON à l'octet près, ordre des clés compris). Chaque
  étape est vérifiée en comparant Node et Rust sur une même base.
- **Une seule base** : Rust et Node ouvrent le même fichier SQLite (WAL,
  `busy_timeout` 5 s). Le schéma et ses migrations restent côté Node
  jusqu'à la dernière étape ; Rust ne crée jamais la base.
- **Même sécurité** : les routes portées appliquent les mêmes règles d'accès
  que `src/middleware.ts` (session `bl_session`, renouvellement glissant,
  401 JSON) ; les routes relayées passent toujours par le middleware Node.
- **Relais transparent** : `Host` conservé (contrôles d'origine des
  écritures), corps en flux dans les deux sens (vidéo, segments HLS), les
  redirections de Next vers son adresse interne réécrites en relatif.
- Les routes Node déjà portées **restent en place** jusqu'à l'étape 8 : revenir
  en arrière sur une route se fait en retirant une ligne du routeur Rust.
- Une route portée qui dépend d'un traitement encore côté Node (récupération
  ESPN à la volée, files en mémoire…) **relaie ce cas à Node** plutôt que de
  le réimplémenter à moitié.

## Étapes

| # | Contenu | État |
|---|---------|------|
| 1 | Passerelle (relais, lancement et arrêt de Node), sessions, `GET /api/health`, `GET /api/schedule`, `GET /api/matches` | ✅ |
| 2 | Lecture seule : `GET /api/matches/[id]`, `/stats` (stats pas encore récupérées : relayé à Node), `/clips`, `/api/standings` (client ESPN, cache 30 min) | ✅ |
| 3 | Comptes : `/api/auth/login`, `/logout`, `/setup`, `/api/account/password`, `/api/admin/users` (scrypt au même format, limitation des tentatives) | ✅ |
| 4 | Proxy vidéo ok.ru `/api/video/[okId]/…` (`master.m3u8`, `playlist.m3u8`, `segment.ts`, `asset.ts`, `file.mp4`) : flux résolu en cache et rafraîchi avant expiration, cache de segments et préchargement, reprise des téléchargements bloqués, mêmes réglages (`SEGMENT_CACHE_MB`, `PREFETCH_*`, `SEGMENT_STALL_MS`, `SEGMENT_RETRIES`) | ✅ |
| 5a | Synchronisation ESPN (calendrier, saison, stats + play-by-play), VF déterministe (`vf.ts`, `sync.ts`, `regenerateSubtitles`), cron interne de ces jobs, `POST /api/ingest` (`sync-videos` relayé à Node), `/stats` récupérées à la volée en Rust | ✅ |
| 5b | Recherche des replays basketball-video (`findReplay` et ses caches, `searchReplay`, `syncVideos`), `POST /api/matches/[id]/replay`, `sync-videos` en Rust (cron et `/api/ingest`) ; replays apparus mis en file de traduction et d'analyse (par Node jusqu'à 6b, par Rust depuis) | ✅ |
| 6a | Fondations médias en bibliothèque Rust : sous-titres (`commentaryCues.ts`), noms des joueurs, fenêtre de nuit, spectateurs, priorité CPU, audio et extractions ffmpeg, Whisper et Ollama embarqués, clients de transcription et de traduction (Ollama, OpenAI, MiniMax), voix (MiniMax, Qwen3-TTS), réglages, planification du balayage vidéo ; `GET/POST /api/admin/settings` servi par Rust | ✅ |
| 6b | Files de traduction et de doublage, spectateurs et activité (`commentary.ts`, `dub.ts`, `viewers.ts`, `activity.ts`) et leurs routes (`/subtitles`, `/subtitles.vtt`, `/commentary`, `/watching`, `/dub`, `/dub/[idx]`, `/api/activity`), branchées ensemble avec l'étape 7 : les trois files tournent dans Rust, avec les jobs de fond | ✅ |
| 7 | Analyse vidéo et OCR du bandeau de score (`analysis.ts`, `ocr.ts`, `scoreboard.ts`, calage de `/api/matches/[id]/sync`) ; Tesseract natif dans l'image | ✅ |
| 8a | Données de chaque page en JSON servies par Rust (`GET /api/pages/…`) : portage de `queries.ts`, `teams.ts`, `linescore.ts`, `version.ts`, `currentSession`, `safeNextPath` ; état des files lu dans les services Rust | ✅ |
| 8b | Pages en composants client lisant `/api/pages/…`, interface en fichiers statiques (export Next) servis par Rust (règles d'accès des pages comprises), migrations SQL et récupération d'accès en Rust, `/api/diag/stall`, Node retiré de l'image | ✅ |

## Développement

```bash
cargo test --manifest-path server/Cargo.toml   # tests du serveur Rust
npm run build                                  # export statique de l'interface (out/)
BL_STATIC_DIR=out server/target/debug/basketland-server   # ou `npm start`
# interface avec rechargement à chaud : Next en développement derrière Rust
npm run dev & BL_NODE_CMD= server/target/debug/basketland-server
```

Variables du serveur Rust :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `3012` | Port public. |
| `BL_LISTEN_HOST` | `0.0.0.0` | Interface d'écoute. |
| `BL_STATIC_DIR` | | Dossier de l'export statique de l'interface (`/app/out` dans l'image) : Rust le sert et ne lance pas Node. Sans lui, tout ce qui n'est pas routé est relayé à Node (développement). |
| `BL_NODE_PORT` | `3013` | Port interne de Next.js. |
| `BL_NODE_CMD` | `node --disable-warning=ExperimentalWarning server.js` | Sans `BL_STATIC_DIR` : commande de l'application Node relayée ; vide : Node lancé à part (`npm run dev`, sur 3013). |
| `BL_NODE_URL` | `http://127.0.0.1:$BL_NODE_PORT` | Adresse de l'application Node relayée. |
| `DB_PATH`, `DATA_DIR` | comme Node | Emplacement de la base SQLite. |
| `DISABLE_CRON` | | `1` : le cron ne tourne pas. |
| `INGEST_TOKEN` | fichier `$DATA_DIR/ingest_token` | Jeton de `POST /api/ingest`, comme Node. |
| `BL_ESPN_SITE` | API ESPN | Autre adresse de l'API ESPN (tests hors réseau). |
| `BV_RATE_MS` | `2000` | Délai entre deux requêtes vers basketball-video, comme Node. |
| `TESSDATA_PREFIX` | dossier de libtesseract | Dossier de `eng.traineddata` pour l'OCR natif (`/usr/share/basketland/tessdata` dans l'image, modèle de tesseract.js). |
| `OMP_THREAD_LIMIT` | | `1` dans l'image : un seul fil OpenMP pour libtesseract (lu au lancement du processus). |

### Jobs d'ingestion (étape 5a)

Le cron Rust lance `sync-season` (base de moins de 50 matchs, 2 s après le
démarrage), `sync-schedule` (toutes les 15 min, dès 5 s), `sync-stats`
(5 min, dès 60 s) et `sync-subtitles` (60 min, dès 10 min), avec le même
journal `ingest_log` et la même règle « déjà en cours » que Node. Il pose
`BL_RUST_JOBS=sync-schedule,sync-season,sync-stats,sync-videos,sync-subtitles,analyses,commentaries`
pour l'application Node, dont le planificateur saute alors ces jobs (depuis
l'étape 6b, il n'en lance plus aucun : `analyses` et `commentaries` sont les
mises en file de fond des analyses vidéo et des pré-traductions, voir plus
bas). Node lancé à part (`BL_NODE_CMD=` vide) : poser soi-même
`BL_RUST_JOBS` pour éviter que les jobs tournent deux fois.

`ingestMatchDetails` et `regenerateSubtitles` sont aussi appelés par
l'analyse vidéo et l'ancrage manuel, servis par Rust depuis l'étape 6b. Vérifié contre Node : parseurs ESPN, VF et
sous-titres sur les captures réelles (`server/tests/fixtures/*.expected.json`,
produits par le code TypeScript), et `sync-schedule` + `sync-stats` en direct
sur deux copies d'une même base (tables identiques à l'octet).

Si Node s'arrête, le serveur Rust s'arrête aussi (le conteneur redémarre le
tout) ; un arrêt du serveur, même brutal, arrête Node.

### Recherche des replays (étape 5b)

`sync-videos` (toutes les 20 min, dès 3 min, mêmes fenêtres de
revérification que `replayCadence.ts`), `POST /api/ingest` et
`POST /api/matches/[id]/replay` (session, origine, Content-Type JSON,
200/202/409/429 avec `Retry-After`) tournent en Rust : scraping de
basketball-video au même rythme (`BV_RATE_MS`), cache des listes par saison
(10 min, couverture des dates, relecture de la 1re page au plus une fois par
minute), un seul scraping par match à la fois (job et demandes partagent la
recherche), embed ok.ru lu par le client du proxy vidéo (étape 4).

Un replay qui vient d'apparaître (ou de passer en HLS) est mis en file :
après un passage du job qui en a trouvé, traductions et analyses des
replays récents (`queueNewReplayWork`, même ligne `[cron] nouveaux replays :
…` que Node) ; après une recherche à la demande, traduction de ce match en
tête de file (`prioritizeFoundReplay`). Jusqu'à l'étape 6b, ces files
tournaient dans Node, prévenu par un appel interne (`POST
/api/internal/replays`, supprimé depuis) ; le serveur Rust ne relaie jamais
`/api/internal/…` depuis l'extérieur (404). Vérifié contre Node :
analyseurs sur les captures réelles et des cas synthétiques
(`server/tests/fixtures/bv.expected.json`, produit par
`server/tests/node-fixtures-bv.mts`), et deux passages de `sync-videos` en
direct sur deux copies d'une même base : colonnes vidéo, sous-titres
régénérés et `ingest_log` identiques.

### Fondations médias (étape 6a)

Les modules du traitement des médias sont portés en bibliothèque
(`server/src/media/`, voir `media/mod.rs` pour la correspondance avec les
fichiers TypeScript), utilisés par les files de traduction, de doublage et
d'analyse (étapes 6b et 7), qui partagent un état en mémoire (spectateurs,
accès au GPU, son complet extrait, activité). `GET/POST /api/admin/settings`
est servie par Rust : elle ne fait que lire et écrire la table `settings`,
relue à chaque usage (`server/src/settings.rs`, `routes_settings.rs`).

Vérifié contre Node : sorties du code TypeScript (`server/tests/node-fixtures-media.mts`
→ `fixtures/media.expected.json`, 478 cas) — sous-titres, noms des joueurs,
prompts et messages, corps exacts des requêtes de traduction, de
transcription et de voix, réglages et configurations, enveloppe audio,
fenêtre de nuit, planification et balayage vidéo — identiques à l'octet
(`tests/media_node.rs`). Clients face à de faux serveurs locaux, processus
Whisper, voix et Ollama remplacés par de faux processus Python au même
protocole (`server/tests/helpers/*.py`, `python3` requis, test sauté sinon),
extraction audio par le vrai ffmpeg (`tests/media.rs`). `/api/admin/settings`
comparé en direct (Node sur 127.0.0.1:3013, Rust sur 3012, même base) : 31
requêtes (lecture, écritures valides, chaque erreur de validation, accès,
origine, Content-Type), mêmes statuts, corps et lignes écrites.

### Branchement des files médias (étapes 6b et 7)

Les trois files tournent dans le serveur Rust, un service de chaque par
processus (`state::Media` dans `AppState`, construit au démarrage) : la
traduction (`Commentary`), le doublage (`Dub`, branché sur la traduction par
ses crochets) et l'analyse vidéo (`Analysis`, mêmes spectateurs et même
horloge que la traduction), le doublage lisant l'activité de l'analyse (il ne
prend pas le GPU d'une analyse en cours). Node ne traduit, ne double et
n'analyse plus rien.

- **Routes** (`server/src/routes_media.rs`, session exigée) :
  `GET /api/matches/[id]/subtitles?t=` et `/subtitles.vtt` (export WebVTT,
  `toWebVtt` porté), `GET`/`POST /commentary`, `POST /watching`,
  `GET`/`POST /dub`, `GET /dub/[idx]` (Range simple), `GET`/`POST /sync`
  (`sync_route`, étape 7) et `GET /api/activity` (`activity.ts` porté dans
  `server/src/activity.rs`). Autres méthodes relayées à Node (405 de Next).
- **Jobs** (`server/src/cron.rs`, `server/src/scheduler.rs`) : mises en file
  de fond des analyses vidéo (10 min, dès 4 min) et des pré-traductions
  (10 min, dès 6 min), seulement avec la traduction automatique et dans la
  fenêtre de nuit (`queueRecentWork`), mêmes journaux ; replays apparus mis
  en file aussitôt (`queueNewReplayWork`, `prioritizeFoundReplay`). Node les
  saute (`analyses`, `commentaries` dans `BL_RUST_JOBS`).
- **Pages** : leurs données (`/api/pages/…`) lisent les services
  directement (`routes_pages::media_state`). Entre les étapes 6b et 8b, les
  pages encore rendues par Node lisaient cet état chez Rust par un appel
  interne (`POST /api/internal/media-state`), retiré avec Node.
- Appels internes supprimés : `POST /api/internal/replays` et
  `POST /api/internal/page-state` (Node), toujours en 404 depuis l'extérieur.

Vérifié contre Node en direct : Node (seul, sur 127.0.0.1:3013) et Rust
(sur 3012) sur deux copies d'une même base (fixture des pages, plus des
sous-titres et un doublage avec ses fichiers), mêmes 173 requêtes envoyées
aux deux (accès, chaque erreur de validation, sous-titres avec et sans `t`,
exports WebVTT, statuts, manifestes, tronçons doublés et plages Range,
lancements et relances, arrêt et reprise du doublage, signes de vie,
activité, calage, méthodes non servies), une fois traduction non configurée
et une fois configurée (travaux réellement lancés puis en échec réseau) :
statuts, en-têtes utiles et corps identiques à l'octet (seules les dates
d'écriture du calage diffèrent), mêmes journaux des travaux. Pages de Node
lancées par le serveur Rust : état des files lu chez Rust (spectateur vu par
l'accueil, raison du doublage sur la page Paramètres). Tests :
`tests/media_routes.rs` (routes, export WebVTT, plages, mises en file de
fond), `tests/pages.rs` (état des pages, `media-state`), `tests/replays.rs`
(replay trouvé → traduction en tête de file).

### File de traduction (étape 6b)

`commentary.ts` est porté en bibliothèque (`server/src/media/commentary/`,
requêtes des tables de la traduction dans `server/src/commentary_db.rs`) :
découpage en tronçons, son complet partagé (`startFullAudio`,
`waitFullAudio`, `sliceFullAudio`, `dropFullAudio`), dossiers de travail et
leur ménage, enregistrements et backoff (avec `backoffMs`,
`networkBackoffMs`, `MAX_AUTO_FAILURES`, `analysisSources`,
`pickAudioSource` d'`analysis.ts`), file (`enqueueCommentary`, `pump`,
préemption, fiche quittée avec `viewerGone` / `nudgeCommentaryQueue`,
`prioritizeOnView`, `enqueueRecentCommentaries`, garde-fou de durée),
`runCommentary` (tronçons, extraction anticipée, avance maximale pendant la
lecture, rattrapage des lignes restées en anglais, publication), statuts,
sous-titres servis et activité. Mêmes variables (`COMMENTARY_*`,
`WHISPER_PROMPT`, `WHISPER_HOTWORDS`…), mêmes défauts et bornes, mêmes
journaux. Branchée avec les autres files (voir plus haut).

Le service `Commentary` (un par processus, partagé par `Clone`, dans un
runtime Tokio) se construit avec la base et le proxy vidéo
(`Commentary::new(db, video)`) ; tests : `Commentary::with_options` (fausses
dépendances `CommentaryDeps`, table de spectateurs et horloge à part) et
`set_runner` (`__setCommentaryRunnerForTests`), `idle` (`__commentaryIdle`).

Crochets que le portage du doublage doit poser (après construction, en
tenant le doublage par `Weak` pour éviter un cycle d'`Arc`) :

| Crochet | Équivalent Node | Contrat |
|---------|-----------------|---------|
| `set_gpu_gate(Some(Arc<dyn Fn() -> Option<BoxFut<()>>>))` | `globalThis.__commentaryGpuGate` (`releaseGpuForTranslation`) | Appelé de façon synchrone au démarrage de chaque traduction ; `None` : rien à libérer, la traduction part aussitôt ; sinon le doublage en cours a été interrompu et le futur se termine quand sa session de voix est fermée (au plus 20 s côté Node). |
| `set_dub_wants_audio(Some(Arc<dyn Fn(i64) -> bool>))` | `globalThis.__dubWantsAudio` | Doublage en cours ou en file pour ce match : la fin de la traduction garde `full.ogg` dans le dossier de travail (le doublage l'efface avec `drop_full_audio`). Une panique vaut `false`. |

En retour, le doublage appelle `slice_full_audio`, `drop_full_audio`,
`audio_sources`, `activity`, `queue_position`, `ready`, `running_match_id`,
`enqueue`, et doit partager la table des spectateurs et l'horloge du service
(`viewers()`, `now()`, `viewer_active`, `viewer_position`,
`someone_watching`). Les routes appelleront `status`, `served_cues`,
`touch_viewer`, `nudge`, `enqueue`, `prioritize_on_view`, `activity`,
`disabled_reason`, `running_match_id` ; le cron `enqueue_recent`.

Vérifié contre Node (`server/tests/node-fixtures-commentary.mts` →
`fixtures/commentary.expected.json`, `tests/commentary_node.rs`) : schéma
réel de la base, découpages, ordre et couverture des tronçons, sources
audio, backoff et `commentaryRetryAllowed` (216 cas), requêtes des tables,
16 travaux complets avec les faux transcripteur et traducteur des tests de
Node (lignes de la base, avancement, appels, résultat, statut, dossier de
travail identiques) et 17 états de la file (statuts identiques à l'octet,
ordre des clés compris). Cas de `tests/commentary-queue.test.ts` et
`tests/commentary-ondemand.test.ts` portés (`tests/commentary.rs`), son
complet découpé par le vrai ffmpeg.

### Doublage (étape 6b)

`dub.ts` est porté en bibliothèque (`server/src/media/dub/`, requêtes des
tables `dub_tracks` et `dub_chunks` dans `server/src/dub_db.rs`,
`commentaryKey` et `getCommentaryChunks` dans `commentary_db.rs`) :
locuteurs et voix (`assignSpeakers`, `assignRoles`, genre par le
classifieur, bascule unique vers F, état `SpeakerState` relu et réécrit en
base avec l'ordre des clés de Node), texte et calage (`emphasize`, `fitCue`,
`placeClips`, `speechRanges`, `groupCues`, `cuesSignature`), montage ffmpeg
(`assembleChunk`, mêmes arguments), `runDub` (son d'origine découpé dans le
son complet de la traduction ou lu dans le flux, empreintes, synthèse,
montage, publication), file (`enqueueDub`, `pump`, préemption, travail
explicite ou de fond, `waitsForSubtitles`, `hasDubWork`, arrêt et reprise,
GPU rendu à une traduction qui démarre, garde-fou `DUB_TIMEOUT_MS`,
enregistrements `kv_cache` `dub:<id>`), manifeste, activité, moteur de voix
chargé au premier besoin (`__dubEngine`, téléchargement des modèles hors GPU).
Mêmes variables (`DUB_DISABLED`, `DUB_SPEAKER_SIM`, `DUB_FEMALE_PROB`,
`DUB_FEMALE_F0`, `DUB_MIN_NEW_SPEAKER_SEC`, `DUB_MAX_SPEAKERS`,
`DUB_TIMEOUT_MS`, `DUB_REPUMP_MS`, `FFMPEG_PATH`), mêmes défauts et bornes,
mêmes journaux. Branché avec les autres files (voir plus haut).

Le service `Dub` (un par processus, partagé par `Clone`, dans un runtime
Tokio) se construit sur le service de traduction : `Dub::new(commentary,
video)`. Il partage sa base, sa table des spectateurs et son horloge, et
**pose lui-même les deux crochets** de `Commentary` en tenant le doublage par
`Weak` : `set_gpu_gate` → `Dub::release_gpu_for_translation` et
`set_dub_wants_audio` → `Dub::wants_audio`. Un seul `Dub` par `Commentary`
(le dernier construit tient les crochets).

| Méthode de `Dub` | Équivalent Node | Appelée par (branchement) |
|------------------|-----------------|---------------------------|
| `disabled_reason()` / `disabled_reason_sync()` | `dubDisabledReason` / `dubDisabledReasonSync` | GET et POST `/dub`, page des paramètres |
| `manifest(id)` (`.to_json()`) | `dubManifest` | GET et POST `/dub` (contrat du lecteur) |
| `prioritize_on_view(id)` | `prioritizeDubOnView` | GET `/dub?t=` (après `Commentary::touch_viewer`) |
| `request(id, reset)` | `requestDub` | POST `/dub` `start` / `retry` (202 si en file, 409 si relance refusée) |
| `stop(id)` | `stopDub` | POST `/dub` `stop` |
| `chunk_path(id, idx)` | `dubChunkPath` | GET `/dub/[idx]` (Range simple) |
| `activity()` (`.to_json()`) | `dubActivity` | `/api/activity` (`activity.ts`) |
| `enqueue(id, DubEnqueueOptions)` | `enqueueDub` | interne, tests |
| `queue_position`, `running_match_id`, `has_work`, `record`, `gpu_busy` | `dubQueuePosition`, `hasDubWork`, `getDubRecord`, `gpuBusy` | interne, tests |
| `release_gpu_for_translation(max_ms)`, `wants_audio(id)` | `releaseGpuForTranslation`, `__dubWantsAudio` | crochets de `Commentary` |
| `run_dub(job, progress, signal, deps, ctl)` | `runDub` | exécuteur par défaut |
| `set_runner`, `runner_with(deps)`, `set_engine(DubEngine)`, `idle` | `__setDubRunnerForTests`, `viaQueue`, `__setDubEngineForTests`, `__dubIdle` | tests |
| `set_analysis_activity(Some(f))` | `analysisActivity` (import d'`analysis.ts`) | `state::Media::wire` (activité de `Analysis`) |

Crochet de l'analyse vidéo : le doublage lit son activité par `Dub::set_analysis_activity(Some(Arc<dyn
Fn() -> AnalysisActivity>))` : `AnalysisActivity { running: [AnalysisRun {
match_id, phase, done, total }], queued }`, comme `analysisActivity()` ; une
analyse dont la phase est « en pause pendant la lecture » n'occupe pas le
GPU. Sans crochet (défaut), aucune analyse ne tourne : le doublage ne cède la
place qu'aux traductions. Branché par `state::Media::wire` sur l'activité
du service `Analysis`.

Vérifié contre Node (`server/tests/node-fixtures-dub.mts` →
`fixtures/dub.expected.json`, `tests/dub_node.rs`) : fonctions pures (moments
forts, 72 calages, positions, plages de parole, phrases d'une traite,
empreintes, téléchargement en clair, 17 suites d'appels des locuteurs avec
l'état complet après chacun, `voiceFor`), arguments de ffmpeg du montage
(faux ffmpeg qui les écrit, `helpers/fake_ffmpeg.sh`) et métadonnées du
fichier produit par le vrai ffmpeg, 17 scénarios de `runDub` avec le faux
moteur de `tests/dub.test.ts` (résultat, avancement, appels, journaux, lignes
de la base à l'octet, fichiers, manifeste) et 19 états de la file avec la
traduction branchée (manifestes, activités, résultats des demandes,
enregistrements, journaux). Cas de file de `tests/dub.test.ts` et cas du
doublage de `tests/vf-mode.test.ts` portés (`tests/dub.rs`), dont la
traduction et le doublage branchés par leurs crochets (une traduction qui
démarre fait céder le doublage, `full.ogg` gardé pour le doublage puis
effacé par lui) et le montage par le vrai ffmpeg. `tests/dub-player.test.ts`
ne teste que le lecteur (client) : rien à porter côté serveur.

### Interface statique et retrait de Node (étape 8b)

L'interface est un **export statique de Next** (`output: 'export'`,
`next build` → `out/`) : chaque page est un composant client
(`src/components/pages/*Page.tsx`) qui lit ses données dans
`GET /api/pages/…` (étape 8a) par `usePageData` (`src/components/page/pageData.tsx`),
le layout dans `/api/pages/session` (`src/components/layout/SiteShell.tsx`).
Les `page.tsx` ne gardent que les métadonnées statiques ; les titres
dynamiques passent par `document.title` (même gabarit `%s · BasketLand`).
`router.refresh()` (rafraîchissement périodique, match qui commence ou se
termine, replay trouvé) relit le JSON de la page (`useReloadPage`), l'état
des composants restant en place. Une session expirée pendant la visite
(401 d'une route JSON) mène à `/login?next=…`, comme avant.

Routes dynamiques : `generateStaticParams` n'exporte que le paramètre `_`
(`out/matchs/_.html`, `out/equipes/_.html` et leurs `.txt`) ; Rust sert
cette page pour tout identifiant, qui est lu dans l'adresse. Une fiche
introuvable affiche l'interface 404 de Next, mais avec le statut HTTP 200
de la page `_` (404 avant). Navigations client : Next demande
`<chemin>.txt?<paramètres>&_rsc=…` (`/index.txt` pour l'accueil, en-tête
`RSC: 1`), servi en `text/plain` ; toute autre réponse (HTML, 404,
redirection) le fait recharger la page en entier. Sans session,
`/matchs/<id>.txt` est redirigé vers `/login` (un rechargement de plus),
les `.txt` à la racine étant publics comme les autres fichiers à la racine.

Rust (`server/src/static_site.rs`, `BL_STATIC_DIR`) applique les règles
d'accès de l'ancien middleware (`decideAccess` porté) avant de servir un
fichier, avec le renouvellement glissant du cookie ; une méthode non servie
répond 405, une API inconnue 401 (sans session) ou 404. `POST
/api/diag/stall` est porté (`server/src/routes_diag.rs`). L'image finale
part de `debian:bookworm-slim` (même glibc et même Python que les
environnements Whisper et voix), avec l'utilisateur `node` (uid 1000) de
toujours pour les volumes existants ; `HEALTHCHECK` : `basketland-server
health`.

Le code serveur TypeScript reste dans le dépôt comme **référence** : les
gestionnaires de route (`src/api-routes/**`, sortis de `src/app` pour
l'export), le middleware (`src/lib/middleware.ts`) et `src/lib/**`, testés
par vitest et utilisés par les scripts de fixtures (`server/tests/node-fixtures-*.mts`)
qui vérifient Rust contre Node. Ils ne sont plus dans l'image.

Vérifié : interface avant (Next en serveur, derrière Rust) et après (export
statique, `/api` servi par Rust) sur deux copies d'une même base, 46 pages
(administrateur et utilisateur, accueil, calendrier avec date et équipe,
cinq fiches de match dans tous les états, équipes, classement, paramètres,
pages introuvables, scores masqués, connexion et premier démarrage hors
session, redirections) : URL, titres, texte, liens, classes et HTML
(canonique) identiques, captures identiques sauf la phase de l'animation des
points « en direct » ; navigation client sans rechargement (match depuis
l'accueil, retour, jour suivant, filtre équipe, fiche équipe…), session
perdue en cours de visite, 404 dans le layout, replay apparu pendant la
visite (la page passe au lecteur). Tests Rust : `tests/static_site.rs`.

### Schéma de la base et récupération d'accès (étape 8b)

Le serveur Rust crée et migre la base au démarrage, avant de lancer Node
(`server/src/schema.rs`, équivalent d'`openDatabase` et `migrate` de
`db.ts`) : mêmes instructions SQL au caractère près (`sqlite_master` garde
le texte des `CREATE`), mêmes PRAGMA, mêmes migrations de colonnes, mêmes
messages d'erreur quand le volume n'est pas inscriptible. Node applique
encore son propre schéma, identique et idempotent, tant qu'il est là.
Vérifié (`tests/schema.rs`) : une base neuve créée par Rust a exactement le
schéma relevé sur les bases neuves de Node (fixtures de la traduction et des
pages) ; une base d'avant les migrations reçoit les colonnes ajoutées depuis
(pistes anciennes marquées complètes), et rejouer les migrations ne change
rien.

Récupération d'accès : `basketland-server reset-password <identifiant>
<nouveau-mot-de-passe>` (`server/src/reset_password.rs`), même contrat que
`scripts/reset-password.mjs` (compte administrateur créé s'il n'existe pas,
sessions fermées, même empreinte scrypt, mêmes messages et codes de sortie,
identité du propriétaire de la base reprise quand `docker exec` tourne en
root). Test : `tests/reset_password.rs` (vrai binaire). Le script Node reste
dans le dépôt comme référence (testé par vitest), plus dans l'image.

### Données des pages (étape 8a)

Chaque page de `src/app/**/page.tsx` (et le layout racine) est encore un
composant serveur de Next qui lit la base et les modules de `src/lib`. Rust
sert désormais, pour chacune, un JSON qui contient exactement ce que calcule
ce composant : les props de ses composants client et ce qu'il écrit lui-même
(titres de `generateMetadata`, textes qui dépendent du serveur). L'étape 8b
fera des pages des composants client qui lisent ces routes ; **aucune page
n'est encore convertie**. Code : `server/src/pages.rs` (une fonction par
page), `queries.rs`, `teams.rs`, `linescore.rs`, `version.rs`,
`auth::safe_next_path`, routes dans `routes_pages.rs`.

Reste côté client (8b) la mise en forme pure : libellés de dates
(`components/schedule/dates.ts`), comptes à rebours (`now` du navigateur),
couleurs et noms d'équipe (`teams.ts`, déjà importé par les composants
client), `seasonLabel`, liens, classes. Les `Map` de Node (`dayCounts`,
`seasonRecords`) deviennent des objets à clés triées. `GameView` =
`MatchDto` de `GET /api/matches/[id]` + `hasStats`, `hasReplay`, `hasVf`,
`vf` (`{state:'ready'|'none'}` ou `{state:'running'|'partial', pct}`).

Toutes les routes exigent une session (401 `{ error: "non connecté" }`,
renouvellement glissant du cookie), sauf `/api/pages/session`.
`Cache-Control: no-store`. Cookie `bl_spoilers=hide` → `spoilers: "hide"`.

| Route | Page | Réponse |
|-------|------|---------|
| `GET /api/pages/session?next=` (**publique**) | layout, `/login`, `/setup` | `{ has_users, user: {id, username, role} \| null, next }` ; `next` = `safeNextPath(next)`. Layout : en-tête complet si `user`. `/login` : `!has_users` → `/setup`, `user` → `next`. `/setup` : `has_users` → `/login`. Session renouvelée (cookie réémis) comme le faisait le middleware sur ces pages. |
| `GET /api/pages/home` | `/` | `{ spoilers, today, season, live, replays (9, le premier est la une), hero_night (nuit de la une, pour `nightLabel`), night, night_title, night_games, next_up_id, days: [{key, games}], standings (cache, ou null), auto_translate, activity, vf_count: {ready, running, partial, todo}, idle_text, night_window_label }` |
| `GET /api/pages/matchs?d=&team=` | `/matchs` | `{ spoilers, today, team (abréviation NBA validée ou null), selected, day, team_view }` ; vue jour (`team` null) : `day = { counts, games, records, prev, next, replays, upcoming, live, all_night }`, `team_view` null ; vue équipe : `team_view = { upcoming, played (terminés, du plus récent), record }`, `day` null. Titre fixe « Calendrier ». |
| `GET /api/pages/matchs/{id}` | `/matchs/[id]` | `{ title, description, spoilers, match (DTO), linescore, plays (onglet Actions), lite ([seq, period, clock_sec, clock_display]), has_video, positions ([seq, video_ts]), auto_translate, vf_mode, is_admin }` ; **404** `{ error: "match introuvable", title: "Match introuvable" }` (= `notFound()`). |
| `GET /api/pages/equipes` | `/equipes` | `{ season, today, conferences: [{conference, divisions: [{division, teams: [{team, record, next, seed}]}]}] }` (équipes déjà triées comme la page). Titre fixe « Équipes ». |
| `GET /api/pages/equipes/{abbr}` | `/equipes/[abbr]` | `{ title, spoilers, abbr, team, today, upcoming_count, next_game, upcoming_rest (2e à 9e), finished_count, form (10 derniers de saison régulière), recent (10), replays_count, replays (6), summary: {season, total, home, road, streak, streak_win}, seed, pct }` ; **404** `{ error: "équipe introuvable" }` (abréviation mal formée, ou inconnue sans match en base). |
| `GET /api/pages/classement` | `/classement` | `{ conferences }` : cache de 30 min, sinon ESPN, cache périmé si ESPN échoue, `[]` faute de mieux (`loadStandings`). Titre fixe « Classement ». |
| `GET /api/pages/parametres` | `/parametres` | `{ user, admin, admin_data, version: {commit, builtAt}, version_text }` ; `admin_data` (administrateur seul, sinon null) = `{ users, auto_translate, vf_mode, voice_disabled_reason, minimax, openai, openai_model_placeholder }`. Sans session : 401 (la page renvoyait vers `/login?next=/parametres`). |

L'état des files — match en cours de traduction (`commentaryRunningMatchId`,
état de la VF dans `toViews`), `currentActivity()`, `commentaryDisabledReason()`,
`dubDisabledReason()` (page Paramètres d'un administrateur seulement) — est
lu dans les services Rust (`routes_pages::media_state`) par `home`, `matchs`,
`equipes`, `equipes/{abbr}` et `parametres`. Jusqu'à l'étape 6b, ces files
tournaient dans Node et Rust lisait leur état par un appel interne
(`POST /api/internal/page-state`, supprimé depuis).

À savoir pour 8b : côté Node, `defaultCalendarDay` ne prend jamais la branche
« le matin » (`Number('20 h')` vaut NaN : `Intl` en français écrit l'heure
avec « h ») ; Rust reproduit ce comportement, à corriger des deux côtés. Les
règles d'accès des pages (`decideAccess` : redirections vers `/login?next=…`
et `/setup`) devront être appliquées par Rust quand il servira les fichiers
statiques. `components/schedule/dates.ts` importe `shiftKey` de
`queries.ts`, qui ouvre la base : à déplacer pour un composant client.

Vérifié contre Node (`server/tests/node-fixtures-pages.mts` →
`fixtures/pages.expected.json`, `tests/pages_node.rs`) : base au schéma réel
remplie par le code Node (vraie nuit ESPN du 27/10/2026 avec stats et
play-by-play, calendrier de 37 jours, saison passée, présaison, playoffs,
All-Star, matchs en cours, replays HLS et MP4, pistes de traduction dans
tous les états, classement ESPN réel, comptes et réglages), 55 scénarios à
instant figé (toutes les pages, fenêtres de nuit, traduction en cours, non
configurée ou désactivée, dates invalides, identifiants `0x…`, 404, cache du
classement périmé, versions…) : réponses identiques à l'octet, ordre des
clés compris. Routes, accès, 404, cookie, appel interne et Node injoignable
face à une fausse application Node (`tests/pages.rs`). En direct, Node et
Rust lancés sur une base remplie depuis ESPN par le cron Rust (1 273 matchs
de la saison, stats et play-by-play, 20 replays trouvés, analyses vidéo en
cours chez Node) : 18 pages servies par Rust identiques à l'octet au calcul
de Node (`INGEST_TOKEN=… npx -y tsx server/tests/node-fixtures-pages.mts
--live <base> <url de Rust> <jeton de session> <url de Node>`, l'état des
files étant lu chez Node comme le fait Rust).

### Analyse vidéo et OCR (étape 7)

`ocr.ts`, `scoreboard.ts` et `analysis.ts` sont portés en bibliothèque
(`server/src/media/ocr.rs`, `scoreboard.rs`, `analysis.rs`, requêtes dans
`server/src/analysis_db.rs`), ainsi que les gestionnaires de
`GET`/`POST /api/matches/[id]/sync` (`server/src/sync_route.rs`), branchés
avec les autres files médias (voir « Branchement des files médias »).

- `ocr.rs` : parseur du bandeau, scores du play-by-play, intervalle d'un
  chrono arrêté, `selectConsistentObservations`, extraction d'images et
  filtres ffmpeg (`grabFrame`, `filterImage`, `rawGray`, mêmes arguments et
  délais), moteur OCR derrière le trait `OcrEngine`.
- `scoreboard.rs` : jetons des mots, candidats chrono, vote, zones fixes,
  cases claires, empreinte du bandeau, localisation (zones fixes puis bandes),
  lecture « gabarit » (case de période retenue par localisation, comme le
  `WeakMap` de Node), mêmes opérations flottantes (`Math.hypot` de V8 compris).
- `analysis.rs` : file (`enqueueAnalysis`, `pump`, priorité, cooldown,
  backoff et abandon, garde-fou `ANALYSIS_TIMEOUT_MS` hors pauses, pause des
  analyses de fond pendant une lecture, abandon hors de la fenêtre de nuit),
  `runAnalysis` (sonde du flux, balayage `video_scan` avec `OcrScan`, cache
  `scoreboard:<okId>` au même JSON, ancres `auto`, audio, VF recalée par
  `ingest::regenerate_subtitles`, play-by-play manquant récupéré par
  `ingest::ingest_match_details`), statuts et activité. Backoff, sources et
  `MAX_AUTO_FAILURES` repris de `media::commentary` (portés en 6b).

Mêmes variables, défauts et bornes (`ANALYSIS_MAX_PARALLEL`,
`ANALYSIS_MIN_INTERVAL_MS`, `ANALYSIS_TIMEOUT_MS`, `OCR_DISABLED`,
`OCR_STEP_SEC`, `SYNC_WRITE_ORIGINS`, `COMMENTARY_NIGHT_WINDOW`), mêmes
journaux (`[analyse] match … : …`, `[analyse] journalisation impossible : …`).

**Moteur OCR** : Node utilise tesseract.js 7 (Tesseract 5.1 compilé en WASM)
avec `@tesseract.js-data/eng` (`4.0.0_best_int`). Rust appelle libtesseract 5
natif par son API C (`server/src/media/tesseract.rs`, sans `bindgen`), même
moteur (LSTM seul), mêmes paramètres, PNG décodé par Leptonica comme
tesseract.js. Il est derrière la fonction cargo `ocr` (désactivée par défaut :
`cargo test` passe sans libtesseract ; sans elle, l'analyse échoue en « OCR
indisponible »). L'image Docker l'active : étage Rust avec
`libtesseract-dev libleptonica-dev`, `cargo build --features ocr` ; image
finale avec `libtesseract5` et le **même** `eng.traineddata` que tesseract.js
(copié de `node_modules`, décompressé dans `/usr/share/basketland/tessdata`,
`TESSDATA_PREFIX`), et `OMP_THREAD_LIMIT=1` : tesseract.js n'a qu'un fil,
libtesseract en lance plusieurs (OpenMP) qui s'attendent activement sur une
machine chargée (mesuré : 68 s au lieu de 0,5 s pour une bande en psm 11) ;
libgomp ne lit cette limite qu'au chargement du processus, elle doit donc venir
de l'environnement (à poser aussi hors Docker).

API appelée par le branchement :

| Appelant | Rust | Équivalent Node |
|----------|------|-----------------|
| construction | `Analysis::new(db, video, commentary.viewers(), clock)` ou `Analysis::with_options(db, AnalysisDeps::defaults(db, video), AnalysisOptions::shared_with(&commentary))` | `globalThis.__analysisQueue` |
| `GET`/`POST /api/matches/[id]/sync` | `sync_route::get(&db, &analysis, raw_id)`, `sync_route::post(&db, &analysis, raw_id, &headers, &body)` (après la session ; réponse complète) | `route.ts` |
| cron `analyses` | `analysis.enqueue_recent(None, None)` | `enqueueRecentAnalyses()` |
| `/api/activity`, doublage (`gpuHolder`) | `analysis.activity()` (`to_json()` : `{ running: [{ matchId, phase, done, total }], queued }`, phase de pause `PAUSED_PHASE`) | `analysisActivity()` |
| replay trouvé, fiche | `analysis.enqueue(id, EnqueueOptions { … })`, `analysis.status(id)`, `start_video_analysis` | `enqueueAnalysis`, `analysisStatus`, `startVideoAnalysis` |
| tests | `set_runner` (`__setAnalysisRunnerForTests`), `idle` (`__analysisIdle`) | |

La file partage la table des spectateurs et l'horloge du service
`Commentary` (un seul `viewers.ts` et un seul `Date.now()` côté Node).

Vérifié contre Node (`server/tests/node-fixtures-ocr.mts` →
`fixtures/ocr.expected.json`, `tests/ocr_node.rs`) : 2 776 textes et 189
listes de mots réellement lus par tesseract.js (parseur, jetons, périodes et
chronos déformés, candidats, recollage, cases de période), 46 votes, zones
fixes, cases claires et empreintes sur les vignettes des vraies images
(vignettes identiques à l'octet), 60 recadrages, scores et 12 jeux
d'observations sur le play-by-play réel ; puis la localisation et la lecture
des vraies images (`tests/real-frames.test.ts`, trois diffuseurs et les plans
sans bandeau) et des images synthétiques (`tests/scoreboard.test.ts`) en
rejouant les réponses enregistrées de tesseract.js : 537 appels OCR, tous
retrouvés (mêmes images filtrées par ffmpeg), localisations au même JSON à
l'octet, mêmes lectures, même nombre d'appels. Route de calage : 35 requêtes
(`node-fixtures-analysis.mts` → `fixtures/analysis.expected.json`,
`tests/analysis_node.rs`) — lecture, ancres, offsets, décalages, remise à
zéro, chaque erreur de validation, origine, Content-Type, analyses demandées —
mêmes statuts, corps (ordre des clés compris) et lignes `sync_anchors` /
`sync_settings`. File : cas de `tests/analysis.test.ts` et
`tests/sync-route.test.ts` portés (`tests/analysis.rs`), plus des analyses
complètes avec de fausses dépendances (audio seul, flux inaccessible, moteur
OCR absent, play-by-play manquant, pause pendant une lecture).

Tesseract natif (libtesseract 5.3.4 ici ; 5.3.0 dans l'image bookworm) face à
tesseract.js 7 (Tesseract 5.1 WASM), mêmes images et même modèle
(`OMP_THREAD_LIMIT=1 cargo test --features ocr --test ocr_native -- --nocapture`) :
- appel par appel (414 images filtrées distinctes des vraies images) : texte
  identique pour 290 (70 %) — 234/258 en une ligne avec alphabet, 50/100 en
  une ligne sans alphabet, 6/56 en texte épars (psm 11, bandeau entier :
  écarts sur les logos et le bruit surtout) ; les écarts sont des glyphes
  limites (« 1T »/« 17 », « G:57 »/« 6:57 », « 2nD »/« 2n0 ») ;
- localisation : identique sur les 4 images synthétiques ; sur les vraies
  images, même zone et même boîte du chrono, mais boîtes de période et de
  scores différentes pour les trois diffuseurs (JSON du cache différent) ;
- lectures finales : 33/36 (période, chrono) identiques à tesseract.js
  (22 images avec bandeau, 14 plans sans bandeau, tous lus « rien » par les
  deux) ; écarts : nybos t1800 (période non lue en natif), denokc t1700
  (rien lu en natif), denokc t4700 (période 4 lue en natif, pas par
  tesseract.js) ; avec les scores : 25/36 identiques ;
- face à la vérité terrain (règles de `tests/real-frames.test.ts`, toutes
  tenues) : période + chrono 17/19 en natif contre 18/19 pour tesseract.js,
  aucun chrono faux dans les lectures finales, rien sur les plans sans
  bandeau ; parmi les 22 lectures des images de localisation (réutilisées
  comme observations), une lecture fausse en natif (nybos t1800 : 2:43 au
  lieu de 2:13 ; tesseract.js lit 2:13) que la chaîne cohérente doit écarter ;
- vitesse (machine de test chargée, build de débogage) : localisation 15-20 s
  pour 6-9 images, lecture ≈ 1,7 s par image.
