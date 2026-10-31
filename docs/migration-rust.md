# Migration du serveur en Rust

Objectif : tout le **serveur** en Rust (API, files de traduction et de
doublage, proxy vidéo, cron, OCR) ; l'**interface React reste telle
quelle**, compilée en fichiers statiques servis par le binaire Rust. À la
fin, plus de Node.js dans l'image.

Méthode : **par étapes**. Le binaire Rust (`server/`) écoute sur le port
public et reprend les routes une à une ; ce qui n'est pas encore porté est
relayé à l'application Next.js, lancée par lui en sous-processus sur
`127.0.0.1:3013`. Chaque étape est une PR déployable : l'application marche
à tout moment.

```
navigateur ──► basketland-server (Rust, :3012)
                 ├── routes portées : servies directement (SQLite partagée)
                 └── tout le reste ──► Next.js (Node, 127.0.0.1:3013)
```

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
| 5b | Recherche des replays basketball-video (`findReplay` et ses caches, `searchReplay`, `syncVideos`), `POST /api/matches/[id]/replay`, `sync-videos` en Rust (cron et `/api/ingest`) ; replays apparus signalés aux files de Node par `POST /api/internal/replays` | ✅ |
| 6a | Fondations médias en bibliothèque Rust, **pas encore branchées** (Node fait toujours tourner les files) : sous-titres (`commentaryCues.ts`), noms des joueurs, fenêtre de nuit, spectateurs, priorité CPU, audio et extractions ffmpeg, Whisper et Ollama embarqués, clients de transcription et de traduction (Ollama, OpenAI, MiniMax), voix (MiniMax, Qwen3-TTS), réglages, planification du balayage vidéo ; `GET/POST /api/admin/settings` servi par Rust | ✅ |
| 6b | Files de traduction et de doublage, spectateurs et activité (`commentary.ts`, `dub.ts`, `viewers.ts`, `/api/activity`…) et leurs routes, basculées ensemble sur les fondations 6a | à faire |
| 7 | Analyse vidéo et OCR du bandeau de score (`analysis.ts`, `ocr.ts`, `scoreboard.ts`) | à faire |
| 8 | Interface en fichiers statiques (export React), migrations SQL en Rust, Node retiré de l'image | à faire |

## Développement

```bash
cargo test --manifest-path server/Cargo.toml   # tests du serveur Rust
npm run build                                  # application Next.js
cd .next/standalone && ../../server/target/debug/basketland-server
```

Variables du serveur Rust :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `3012` | Port public. |
| `BL_LISTEN_HOST` | `0.0.0.0` | Interface d'écoute. |
| `BL_NODE_PORT` | `3013` | Port interne de Next.js. |
| `BL_NODE_CMD` | `node --disable-warning=ExperimentalWarning server.js` | Commande de l'application Node ; vide : Node lancé à part (par ex. `npm run dev -- -p 3013`). |
| `BL_NODE_URL` | `http://127.0.0.1:$BL_NODE_PORT` | Adresse de l'application Node relayée. |
| `DB_PATH`, `DATA_DIR` | comme Node | Emplacement de la base SQLite. |
| `DISABLE_CRON` | | `1` : ni le cron Rust ni celui de Node ne tournent. |
| `INGEST_TOKEN` | fichier `$DATA_DIR/ingest_token` | Jeton de `POST /api/ingest`, comme Node. |
| `BL_ESPN_SITE` | API ESPN | Autre adresse de l'API ESPN (tests hors réseau). |
| `BV_RATE_MS` | `2000` | Délai entre deux requêtes vers basketball-video, comme Node. |

### Jobs d'ingestion (étape 5a)

Le cron Rust lance `sync-season` (base de moins de 50 matchs, 2 s après le
démarrage), `sync-schedule` (toutes les 15 min, dès 5 s), `sync-stats`
(5 min, dès 60 s) et `sync-subtitles` (60 min, dès 10 min), avec le même
journal `ingest_log` et la même règle « déjà en cours » que Node. Il pose
`BL_RUST_JOBS=sync-schedule,sync-season,sync-stats,sync-videos,sync-subtitles`
pour l'application Node, dont le planificateur saute alors ces jobs et garde
les siens (analyses, traductions). Node lancé à part
(`BL_NODE_CMD=` vide) : poser soi-même `BL_RUST_JOBS` pour éviter que les
jobs tournent deux fois.

Node garde ses propres appels à `ingestMatchDetails` et `regenerateSubtitles`
(analyse vidéo, ancrage manuel, replay trouvé) : les deux implémentations
écrivent les mêmes lignes. Vérifié contre Node : parseurs ESPN, VF et
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

Les files de traduction et d'analyse restent côté Node (étapes 6b et 7). Un
replay qui vient d'apparaître (ou de passer en HLS) leur est signalé par
`POST /api/internal/replays`, appel interne avec le jeton d'ingestion :
`{}` après un passage du job qui en a trouvé (`queueNewReplayWork`, même
ligne `[cron] nouveaux replays : …` qu'avant), `{ match_id }` après une
recherche à la demande (`prioritizeFoundReplay`). Le serveur Rust ne relaie
jamais `/api/internal/…` depuis l'extérieur (404). Vérifié contre Node :
analyseurs sur les captures réelles et des cas synthétiques
(`server/tests/fixtures/bv.expected.json`, produit par
`server/tests/node-fixtures-bv.mts`), et deux passages de `sync-videos` en
direct sur deux copies d'une même base : colonnes vidéo, sous-titres
régénérés et `ingest_log` identiques.

### Fondations médias (étape 6a)

Les modules du traitement des médias sont portés en bibliothèque
(`server/src/media/`, voir `media/mod.rs` pour la correspondance avec les
fichiers TypeScript) mais **aucune route ni aucun job ne les appelle encore** :
les files de traduction, de doublage et d'analyse partagent un état en mémoire
(spectateurs, accès au GPU, son complet extrait, activité) et seront basculées
ensemble (étapes 6b et 7). Seule `GET/POST /api/admin/settings` est servie par
Rust : elle ne fait que lire et écrire la table `settings`, que Node relit à
chaque usage (`server/src/settings.rs`, `routes_settings.rs`).

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
