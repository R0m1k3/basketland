# BasketLand

Application web de replays NBA, conteneurisée pour Unraid : calendrier complet en heure de Paris, replays vidéo en streaming, statistiques de match et de joueurs, et **sous-titres français synchronisés** sur l'audio original de la vidéo.

> **Statut : fonctionnel.** Calendrier, replays, statistiques et VF française sont opérationnels. La spécification technique complète et validée est dans [`docs/SPEC.md`](docs/SPEC.md).

## Ce que fait l'application

| Fonctionnalité | Détail |
|---|---|
| **Calendrier NBA** | Tous les matchs, à venir et terminés, regroupés par date et affichés en **heure de Paris** (Europe/Paris, gestion automatique de l'heure d'été). |
| **Replays** | Streaming HLS des matchs terminés, sans téléchargement, depuis les sources de replays publiques. |
| **Statistiques** | Section « Statistiques du match » affichée **uniquement** quand le match est terminé : boxscore des deux équipes, lignes de chaque joueur (MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, ±), leaders du match. |
| **VF française synchronisée** | Sous-titres en français calés sur la vidéo, générés à partir du play-by-play et alignés sur l'audio original. Export WebVTT. Ajustement manuel du décalage possible. |
| **Classement** | Classement NBA par conférence. |
| **Diffusion en France** | Sur chaque match : **beIN SPORTS** (avec la chaîne pour les matchs à venir, direct ou différé), lu dans le guide des programmes public [XMLTV Fr](https://xmltvfr.fr) toutes les 4 h, et **Prime Video** (matchs dont Prime Video est diffuseur chez ESPN, matchs joués en Europe). Le guide couvre environ 5 jours : la chaîne d'un match apparaît dans les jours qui précèdent, et reste affichée une fois le match joué. `BL_TV_GUIDE_URL` : autre guide XMLTV (vide : désactivé). |
| **NBA Cup** | Fond doré pour les matchs du tournoi partout dans l'application, et onglet `/nba-cup` : matchs à venir, résultats, classements des groupes (reconstitués d'après les rencontres) et phase finale (quarts, demies, finale, « à déterminer » tant que l'affiche n'est pas connue). L'onglet ne montre que la saison en cours : il repart de zéro chaque saison. |
| **Euroleague** | Onglet `/euroleague` : deux prochaines journées (heure de Paris), résultats des deux dernières journées et classement officiel (zones playoffs et play-in, forme sur 5 matchs). Données lues dans l'API publique de l'Euroleague (`api-live.euroleague.net`), gardées 10 min en cache ; si l'API ne répond pas, le dernier état connu reste affiché. |
| **Page équipe** | `/equipes/[abbr]` : prochain match, derniers résultats, replays disponibles et bilan de la saison. Les noms d'équipes de la fiche match y mènent. |

## Architecture

```
basketland-server (Rust) ── port 3012 : API, files médias, cron, SQLite
        │                  sert aussi l'interface : export statique Next.js 15
        │                  (React, TypeScript, Tailwind) dans out/
        │
        ├── API ESPN           matchs, calendrier, boxscores, play-by-play
        ├── basketball-video   découverte des replays
        └── ok.ru (HLS)        résolution du flux, proxy segmenté
```

- **Serveur en Rust** ([`docs/migration-rust.md`](docs/migration-rust.md)) : le binaire `server/` sert toutes les API et l'interface (fichiers statiques produits par Next) ; plus de Node.js dans l'image.
- **Aucun service externe à maintenir** : une seule image Docker, SQLite dans le volume `/data`.
- **Pas de dépendance LLM à l'exécution** : la VF française est produite par un générateur déterministe embarqué.
- **Le proxy vidéo re-résout le flux à chaque requête** : les URL de stream signées expirent, elles ne sont jamais stockées.

## Déploiement sur Unraid

L'API GraphQL d'Unraid ne sait pas *créer* de conteneur (elle sait seulement démarrer/arrêter/redémarrer un conteneur existant) : aucune mutation `createContainer` n'existe. Deux chemins possibles.

### Prérequis : la carte NVIDIA

La traduction des commentateurs (Whisper + TranslateGemma) tourne **dans le
conteneur**, sur la carte graphique. Une seule fois sur le NAS :

1. **Apps** → installer le plugin **Nvidia Driver** (ich777), choisir la
   dernière version du pilote, redémarrer le NAS.
2. Vérifier dans **Terminal** : `nvidia-smi` doit afficher la carte.

Sans carte NVIDIA, tout fonctionne aussi, mais la traduction tourne sur le
processeur (bien plus lente : plusieurs heures par match).

**Plusieurs cartes** (p. ex. RTX 5060 Ti + RTX 3060) : tout le travail
(Ollama, Whisper) tourne sur **la carte 0**, au
sens de `nvidia-smi` (ordre du bus PCI). Variable `CUDA_VISIBLE_DEVICES` :
`0` par défaut, `1` pour l'autre carte, vide pour les laisser toutes visibles.
Le journal `[commentaires] Ollama embarqué prêt (GPU)` confirme qu'Ollama
voit la carte.

### Option A — une commande (le plus rapide)

Dans **Unraid → Terminal**, collez :

```bash
mkdir -p /mnt/user/appdata/basketland && \
docker run -d \
  --name basketland \
  --restart unless-stopped \
  --runtime=nvidia \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -p 3012:3012 \
  -e TZ=Europe/Paris \
  -v /mnt/user/appdata/basketland:/data \
  ghcr.io/r0m1k3/basketland:latest
```

> **Mémoire du NAS protégée sans réglage** : une traduction ne
> démarre que s'il reste au moins 1,5 Go (ou 12 % de la RAM) de libre sur le
> NAS, et s'interrompt sous 400 Mo (ou 4 %) — ses processus s'arrêtent, il
> reprend plus tard (`[mémoire] …` dans le journal). Si la mémoire manque
> malgré tout, le noyau arrête d'abord Whisper ou Ollama, jamais
> les services du NAS. `MEM_GUARD=0` désactive l'attente et l'interruption.

> `--runtime=nvidia` et `NVIDIA_VISIBLE_DEVICES=all` donnent la carte au
> conteneur. Whisper et Ollama sont **dans l'image** : rien d'autre à
> installer. Au premier match traduit, les modèles sont téléchargés dans
> `/mnt/user/appdata/basketland/models` (~1,6 Go pour Whisper, ~8,1 Go
> pour TranslateGemma 12B) puis réutilisés.

> Les droits du volume sont gérés automatiquement : au démarrage, le
> conteneur rend `/data` à l'utilisateur `node` (uid 1000) puis lâche les
> privilèges root. Aucun `chown` manuel n'est nécessaire, même si le dossier
> hôte appartient à `root` ou à `nobody:users`.

L'image est **publique** : aucun jeton n'est nécessaire. Le premier
tirage télécharge l'image (une à deux minutes), puis le conteneur démarre.

Vérification :

```bash
docker logs -f basketland          # doit afficher « Ready »
curl -s http://localhost:3012/api/health
```

Puis l'application est accessible sur `http://<IP-DU-NAS>:3012`.

> Si le port 3012 est déjà pris sur le NAS, remplacez `-p 3012:3012` par
> `-p 3013:3012` et accédez à `http://<IP-DU-NAS>:3013`.

### Option B — l'interface web

Dans Unraid : **Docker → Add Container**

| Champ | Valeur |
|---|---|
| Name | `basketland` |
| Repository | `ghcr.io/r0m1k3/basketland` |
| Repository : Access Token | *(vide — l'image est publique)* |
| Network Type | `bridge` |
| Port (HTTP) | `3012` |
| Variable d'environnement | `TZ` = `Europe/Paris` |
| Variable d'environnement | `NVIDIA_VISIBLE_DEVICES` = `all` |
| Variable d'environnement (plusieurs cartes) | `CUDA_VISIBLE_DEVICES` = `0` (numéro `nvidia-smi` de la carte à utiliser) |
| Extra Parameters (vue avancée) | `--runtime=nvidia` |
| Path / Volume | `/mnt/user/appdata/basketland` → `/data` |

Puis **Apply**.

### Image

L'image est construite automatiquement par GitHub Actions à chaque push sur `main` :

```
ghcr.io/r0m1k3/basketland:latest
```

Une seule image : l'application, Ollama (CUDA 12) et Whisper. Le doublage
(voix de synthèse) et NVIDIA Parakeet ont été retirés, ainsi que l'ancienne
variante `:full`. Au démarrage, leurs modèles restés dans
`/data/models` (Qwen3-TTS, Fish S2 Pro, Parakeet, empreintes vocales,
cache `hf/xet`) et les pistes doublées (`/data/dub`) sont effacés
(`[serveur] modèles retirés … effacés` dans le journal).

**Mises à jour légères** : les couches lourdes (système, Ollama, Python et
CUDA) sont dans une image de base (`Dockerfile.base`) reconstruite seulement
quand elle change. Une nouvelle version de l'application ne change que les
dernières couches (serveur, interface : ~100 Mo) : le NAS garde le reste. Le
tout premier tirage après ce changement télécharge encore la base une fois.

L'image est **publique** : aucun jeton n'est nécessaire sur le NAS, Unraid la
tire directement. (Le dépôt GitHub et le paquet GHCR sont publics, comme les
autres dépôts et paquets du compte.)

### Alternative docker-compose

```yaml
services:
  basketland:
    image: ghcr.io/r0m1k3/basketland:latest
    container_name: basketland
    restart: unless-stopped
    runtime: nvidia
    ports:
      - '3012:3012'
    environment:
      TZ: Europe/Paris
      NVIDIA_VISIBLE_DEVICES: all
      # Carte utilisée (numéro `nvidia-smi`), s'il y en a plusieurs.
      CUDA_VISIBLE_DEVICES: '0'
    volumes:
      - /mnt/user/appdata/basketland:/data
```

> **Contrôle de santé** : ne mettez pas de bloc `healthcheck:` dans le
> compose, l'image a le sien (`basketland-server health`). L'ancien contrôle
> `node -e "fetch(...)"` reste accepté : Node n'est plus dans l'image, mais
> un faux `node` le redirige vers `basketland-server health`. Le compose manager d'Unraid garde sa
> propre copie du fichier (`/boot/config/plugins/compose.manager/projects/basketland/`) :
> elle ne suit pas ce dépôt, mieux vaut y retirer le bloc dans **Docker → Compose →
> basketland → Edit Stack**. Raison d'un échec :
> `docker inspect --format '{{json .State.Health}}' basketland`.

### Mettre à jour le conteneur

L'image est reconstruite et republiée automatiquement par la CI à chaque
push sur `main`. Pour reprendre la nouvelle version sur le NAS :

```bash
docker pull ghcr.io/r0m1k3/basketland:latest && \
docker stop basketland && docker rm basketland && \
docker run -d --name basketland --restart unless-stopped \
  --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all \
  -p 3012:3012 -e TZ=Europe/Paris \
  -v /mnt/user/appdata/basketland:/data \
  ghcr.io/r0m1k3/basketland:latest
```

Le volume `/data` (base SQLite, jeton, cache, modèles de traduction) est conservé : `docker rm`
sans `-v` ne touche pas au dossier hôte.

Après une mise à jour, `docker image prune -f` supprime les anciennes
versions de l'image (sinon chacune reste sur le disque du NAS).

> Si tu as installé le conteneur via l'interface Unraid, un **Update** dans
> l'onglet Docker fait la même chose (téléchargement de la nouvelle image
> puis redémarrage), sans ligne de commande. Unraid ne propose « Update »
> qu'après sa vérification des mises à jour (« Check for Updates ») ; à
> défaut, « Force Update » dans le menu du conteneur (mode avancé).

**Vérifier la version en service** : le bas de la page Paramètres affiche
« Version <commit> · image construite le <date> ». Le commit doit être celui
du dernier merge sur `main` (onglet *Actions* du dépôt) ; sinon, le NAS tourne
encore sur l'ancienne image.

## Connexion et utilisateurs

Tout le site (pages et API) est réservé aux comptes connectés. Restent publics :
`/api/health` (healthcheck Docker) et `/api/ingest` (protégé par son propre jeton).

- **Premier démarrage** : tant qu'aucun compte n'existe, toute page mène à
  `/setup`, qui crée le compte **administrateur** (identifiant + mot de passe de
  8 caractères minimum). Cette page disparaît ensuite.
- **Connexion** : `/login`. La session (cookie httpOnly) dure 30 jours et se
  prolonge tant qu'elle sert. 5 échecs de connexion → 1 minute d'attente.
- **Paramètres** (`/parametres`, icône d'engrenage en haut à droite) : chacun y
  change son mot de passe et se déconnecte, et voit en bas la version en
  service (commit et date de l'image). Un administrateur y gère aussi les
  comptes (ajout, rôle, réinitialisation du mot de passe, suppression — le
  dernier administrateur ne peut être ni supprimé ni rétrogradé).
- **Traduction via OpenAI (option)** : dans Paramètres › « Traduction des
  commentaires », un administrateur peut enregistrer une clé API OpenAI et un
  modèle (ex. `gpt-5.4-mini`). La traduction passe alors par l'API OpenAI au lieu
  d'Ollama ; la transcription (Whisper) reste locale. La clé se crée sur
  platform.openai.com et est facturée à l'usage (ce n'est pas l'abonnement
  ChatGPT) ; elle n'est jamais réaffichée en entier.
- **Traduction d'un match** : lancée à la lecture (ou par « Sous-titrer ce
  match »), elle va jusqu'au bout, même si la vidéo est mise en pause ou la
  fiche fermée ; elle ne cède la place qu'à la lecture d'un autre match.
  « Arrêter la traduction » l'interrompt (les sous-titres déjà traduits
  restent) et la lecture ne la relance plus ; « Reprendre la traduction » la
  termine.
- **Moteur de transcription** : dans Paramètres › « Transcription des
  commentateurs », un administrateur choisit Whisper turbo (par défaut :
  reçoit la liste des joueurs, les noms propres sont bien reconnus), Whisper
  large-v3 complet (`Systran/faster-whisper-large-v3`, ~1,6 Go de carte en
  int8 : plus précis quand le public couvre les commentateurs, 2 à 3 fois
  plus lent).
  Modèle téléchargé au premier usage dans `/data/models`. Vaut pour les
  prochaines traductions (« Relancer la traduction » refait une piste).
- **Moteur de traduction** : dans Paramètres › « Moteur de traduction »,
  Embarqué (Ollama), MiniMax ou OpenAI, et le modèle embarqué :
  TranslateGemma 12B (défaut), Gemma 4 E4B, Hunyuan-MT 7B de Tencent
  (`hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q8_0`, ou `:Q4_K_M` plus léger),
  ou tout autre modèle Ollama. Téléchargé au premier usage. Hunyuan-MT est
  un modèle de traduction pur : traduit phrase par phrase (gabarit officiel),
  sans les consignes basket du prompt. Le choix l'emporte sur
  `TRANSLATE_MODEL` ; un serveur externe (`TRANSLATE_URL`) doit avoir le
  modèle installé.
- **Quota épuisé** (MiniMax, OpenAI) : la file de traduction se met en
  pause `QUOTA_PAUSE_MIN` minutes (60) au lieu
  d'enchaîner les matchs ; la fiche l'indique, et un changement de clé, de
  modèle ou de moteur lève la pause.
- **Mot de passe perdu** : depuis le NAS,

  ```bash
  docker exec -it basketland basketland-server reset-password <identifiant> <nouveau-mot-de-passe>
  ```

  redéfinit le mot de passe (et crée le compte en administrateur s'il n'existe
  pas), puis ferme ses sessions ouvertes.

## Synchronisation des données

Les matchs, statistiques et replays sont récupérés par jobs. Le premier
lancement se fait manuellement :

```bash
# Dans le conteneur (ou via l'API d'ingestion)
curl -X POST http://localhost:3012/api/ingest \
  -H "Authorization: Bearer <INGEST_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"jobs":["sync-schedule","sync-stats","sync-videos"]}'
```

| Job | Rôle |
|---|---|
| `sync-schedule` | Calendrier : matchs à venir et récents (7 jours avant / après). |
| `sync-season` | Saison complète, mois par mois. |
| `sync-stats` | Boxscores, joueurs, leaders et play-by-play des matchs terminés. |
| `sync-videos` | Découvre les replays sur basketball-video.com (toutes les 20 min ; un match fini depuis moins de 12 h est revérifié à chaque passage, les autres toutes les 2 h). La fiche d’un match terminé lance aussi une recherche à l’ouverture et se met à jour seule dès que le replay est trouvé. |
| `sync-subtitles` | Régénère la VF française et recalcule la synchronisation. |

Le jeton d'ingestion est soit défini par la variable d'environnement
`INGEST_TOKEN`, soit généré automatiquement dans `/data/ingest_token`.

### Calibration automatique de la VF

La synchronisation se fait **toute seule**, en tâche de fond, dès que le
replay d'un match (terminé depuis moins de 10 jours) est disponible. Chaque
analyse (3 à 6 min) télécharge le flux en haute qualité et sollicite fort le
processeur, ce qui ferait geler une lecture en cours : elle **se met en
pause tant que quelqu'un regarde une vidéo** et reprend ensuite.
`COMMENTARY_NIGHT_WINDOW=2-6` la limite à la nuit (2 h à 6 h). L'état est affiché sous le lecteur
(« Synchro automatique en cours · 34 % », « VF calée », « Synchro estimée »…).

Le replay coupe une trentaine de minutes de contenu : le décalage entre le
temps réel du match et la position dans la vidéo n'est donc pas uniforme.
L'application le calcule en trois temps :

1. **Ancres** — le bandeau de score est d'abord **localisé** sur quelques
   images (sa position change selon le diffuseur), puis le chrono et la
   période y sont lus par OCR (`tesseract.js`) sur toute la vidéo et recoupés
   avec le play-by-play ESPN. Résultat : des points de calage
   `(période, chrono) → position vidéo` répartis sur les quatre quarts.
2. **Interpolation** — entre deux ancres, le temps de jeu avance à vitesse
   réelle, les temps morts sont comprimés.
3. **Réglage manuel** — si la VF reste décalée, le panneau « La VF est
   décalée ? » sous le lecteur permet de la décaler de ±0,5 à ±5 s, ou
   d'indiquer le chrono affiché à l'écran (« Q2 7:43 ») pour caler la VF à
   cet instant.

Un replay encore en **qualité mobile** (ok.ru n'a pas fini de produire le
HD : il est alors lu en MP4) n'est pas analysé automatiquement — l'image est
trop petite pour lire le chrono. L'analyse part dès que le HD est disponible.
En cas d'échec, les tentatives automatiques sont espacées (1 h, 4 h, 16 h,
24 h).

| Variable | Défaut | Rôle |
|---|---|---|
| `INGEST_TOKEN` | généré dans `/data/ingest_token` | Jeton d'accès à `POST /api/ingest` et aux jobs de synchronisation. |
| `SYNC_WRITE_ORIGINS` | vide | Origines autorisées à modifier la calibration depuis le navigateur, séparées par des virgules (ex. `192.168.1.16,http://nas.local:3012`). **Vide = seule l'origine du serveur est autorisée** (l'en-tête `Host`) : c'est ce qui bloque le CSRF en configuration par défaut. Une origine différente est refusée en 403. |
| `ANALYSIS_MIN_INTERVAL_MS` | `900000` (15 min) | Délai minimum entre deux analyses automatiques d'un même match. Une analyse coûte 5 à 8 min de CPU : ce garde-fou évite de saturer le NAS. |
| `ANALYSIS_MAX_PARALLEL` | `1` | Nombre d'analyses simultanées. |
| `ANALYSIS_TIMEOUT_MS` | `5400000` (90 min) | Durée maximale d'une analyse : au-delà, elle passe en échec et la file continue. |
| `OCR_DISABLED` | — | `1` désactive la phase OCR. |
| `OCR_STEP_SEC` | `105` | Pas du balayage grossier du chrono à l'écran (un affinage suit là où les ancres manquent). |
| `SEGMENT_CACHE_MB` | `192` | Cache mémoire des segments vidéo (0 le désactive). Les segments **à venir** de chaque lecture sont gardés en priorité, les segments déjà lus partent les premiers. 90 s de 1080p pèsent ~70 Mo. |
| `PREFETCH_AHEAD_SEC` | `90` | Avance du préchargement côté serveur, en secondes de vidéo au-delà du dernier segment demandé par le lecteur (lui-même garde 90 à 180 s d'avance). Bornée à 30 segments et à 60 % du cache. Le préchargement suit la qualité réellement lue. 0 le désactive. |
| `PREFETCH_CONCURRENCY` | `3` | Segments préchargés en parallèle depuis ok.ru (1 à 8), en plus de ceux que le lecteur demande. |
| `SEGMENT_STALL_MS` | `5000` | Un téléchargement ok.ru qui ne reçoit plus un octet pendant ce délai (ou dont les en-têtes tardent 1,6 fois plus) est coupé et repris là où il s'était arrêté, sur une connexion neuve, sans que le lecteur voie la coupure. Avant, une connexion bloquée gelait la lecture jusqu'à 60 s. |
| `SEGMENT_RETRIES` | `4` | Reprises au plus par segment (blocage, coupure, erreur réseau ou 5xx ; une signature expirée déclenche en plus une nouvelle résolution du flux). |
| `MP4_PROXY_CACHE` | `1` | Replays encore en MP4 seul (pas de HLS) : fichier servi par blocs de 2 Mo, avec cache et lecture anticipée sur plusieurs connexions (un seul flux bridé par ok.ru hachait la lecture). `0` : ancien relais direct. |
| `MP4_CACHE_MB` | `128` | Cache mémoire des blocs MP4 (32 à 8192). |
| `VIDEO_CACHE_IDLE_MIN` | `5` | Sans lecture depuis ce nombre de minutes, les caches vidéo (segments et blocs MP4) sont vidés et leur mémoire rendue au système. `0` : jamais. |
| `MP4_PARALLEL` | `6` | Blocs MP4 téléchargés en même temps pour la lecture anticipée (1 à 32) ; le bloc attendu par le lecteur passe toujours devant. |
| `MP4_READAHEAD_BLOCKS` | `12` | Blocs de 2 Mo lus d'avance (12 ≈ 50 s pour un match de 4 Go). |
| `FFMPEG_PATH` | `ffmpeg` | Chemin du binaire ffmpeg. |
| `DISABLE_CRON` | — | `1` désactive les jobs internes. |

## Traduction des commentaires

Les sous-titres français affichés sur le lecteur sont la **traduction de ce
que disent les commentateurs** du replay, produite entièrement en local, **dans
le conteneur**, sur la carte NVIDIA : faster-whisper (transcription) et
Ollama (traduction) sont embarqués dans l'image, démarrés à la demande par
l'application au premier besoin d'un travail, puis arrêtés à la fin. Modèles
téléchargés au premier usage dans `/data/models`. Pour utiliser plutôt des
serveurs externes (speaches, Ollama), définir `TRANSCRIBE_URL` /
`TRANSLATE_URL`.

```
on ouvre un match → travail lancé aussitôt, à partir de la position de lecture :
pour chaque tronçon de 2 min (le passage regardé d'abord, puis la suite) :
   ──ffmpeg──▶ audio du tronçon (Opus mono 16 kHz, 24 kb/s)
   ──Whisper──▶ texte anglais horodaté au mot
   ──ffmpeg──▶ intensité de la voix, mot par mot (dB par rapport au ton habituel)
   ──filtre des hallucinations, découpage en sous-titres courts calés sur la voix
     (≤ 60 car., 1,2-5 s, coupés sur les respirations et les changements de ton)
   ──Ollama (TranslateGemma 12B) ou API OpenAI──▶ français, par lots contrôlés
   ──▶ publiés (commentary_cues + commentary_chunks) ──▶ GET /api/matches/[id]/subtitles
tous les tronçons faits : piste complète (badge « VF », statut « ready »)
```

**Traduction à la demande** : rien n'est traduit pour rien. Ouvrir la fiche
d'un match lance sa traduction dès que la lecture a démarré (le lecteur a
~15 s d'avance chargée, ou au plus tard 20 s après l'ouverture : **la vidéo
passe d'abord**), en mettant en pause un travail de fond éventuel, **à
partir de la position de lecture**, par tronçons de 2 minutes : les premiers sous-titres arrivent ~30-60 s après l'ouverture
(estimation), puis la traduction prend de l'avance sur la lecture (Whisper
turbo et TranslateGemma vont plus vite que le temps réel). Un saut dans
la vidéo réoriente le travail : la fiche envoie sa position à chaque
interrogation (`GET /subtitles?t=…`, toutes les 12 s et après chaque saut)
et un signe de vie toutes les 20 s pendant la lecture (`POST /watching`).
Le bandeau sous le lecteur indique l'avance des sous-titres sur la lecture
(« Sous-titres en direct · 2 min d'avance »).

**Affichage de la VF** : une ligne compacte, **en haut de l'image** par
défaut (le bandeau du score, en bas, reste dégagé) ; taille (S à XL) et
position (en haut / en bas) se règlent dans le menu ⚙ du lecteur, ou dans
Paramètres → « Sous-titres » (mêmes réglages, propres au navigateur, avec
« Réinitialiser la synchro »). Les
sous-titres sont **courts et calés sur la voix** : coupés sur les
respirations du commentateur, la ponctuation et les changements nets de ton
(une exclamation a sa propre ligne), jamais au milieu d'un groupe de sens,
et affichés le temps d'être lus quand le commentateur se tait. S'il enchaîne
trop vite, la ligne précédente reste un instant au-dessus, plus petite et
estompée. Les **moments forts** ressortent : quand la voix monte (≥ +3 dB
par rapport au ton habituel du passage), texte appuyé et liseré orange ;
quand elle explose (≥ +6 dB, ou un « ! »), ligne plus grande et plus chaude
qui « claque » à l'entrée.

**La lecture reste prioritaire** : ffmpeg, Whisper, Ollama et l'OCR
tournent en priorité processeur basse (`nice` 10, `BACKGROUND_NICE`) ;
l'extraction audio réutilise le flux déjà résolu par le lecteur (pas de
nouvelle résolution ok.ru en pleine lecture) ; le tronçon suivant se
télécharge pendant que le GPU traite le courant, et le modèle de traduction
se charge pendant la première transcription. L'analyse vidéo (repères des
quart-temps) télécharge le flux en haute qualité et sature le processeur
(OCR), ce qui figerait la lecture : elle ne tourne que quand personne ne
regarde.

**Diagnostic des gels** : le lecteur signale chaque gel au serveur, qui
l'écrit dans les journaux du conteneur (`[lecteur] gel de 2.4 s à 31:05 ·
720p (2.8 Mb/s) · débit mesuré … · tampon … s`), ainsi que les segments
vidéo lents à venir d'ok.ru (`[vidéo] segment lent depuis ok.ru …`) : de
quoi distinguer un problème de réseau d'une surcharge du serveur.

**Lecture plus stable** : une connexion ok.ru qui se bloque (plus un octet
pendant 5 s, `SEGMENT_STALL_MS`) est coupée et le segment reprend où il en
était sur une nouvelle connexion (`[vidéo] flux ok.ru … : reprise n° N …`,
jusqu'à `SEGMENT_RETRIES` reprises) ; le serveur précharge ~90 s devant la
position de chaque spectateur, dans la qualité réellement lue
(`PREFETCH_AHEAD_SEC`, 3 téléchargements en parallèle), et son cache
(`SEGMENT_CACHE_MB`, 192 Mo) garde en priorité les segments à venir. Si
`[vidéo] le lecteur rattrape le préchargement` revient souvent, ok.ru est
trop lent pour la qualité choisie (ou le cache trop petit).

**Noms des joueurs** : Whisper écorche souvent les noms (« Edie » pour
Edey). Avec l'effectif du match (feuille de stats ESPN), les écarts d'une ou
deux lettres sont corrigés avant la traduction, et la liste des joueurs est
donnée au modèle de traduction, chargé de remplacer un nom qui ressemble à
un joueur par son orthographe exacte.

**Synchro** : la VF s'affiche 0,5 s après l'horodatage de Whisper (qui tombe
un peu avant la voix) ; menu ⚙ du lecteur → « Synchro de la VF » pour
l'avancer ou la retarder par pas de 0,5 s (mémorisé).

**Pause et déchargement** : sans signe de vie de la fiche pendant 3 min, le
travail se met en pause et les modèles sont **déchargés** de la carte
graphique ; à la fin de chaque travail aussi. Ce qui est traduit reste, et la
reprise continue où elle s'était arrêtée.

**Traitement dès que le replay est disponible** : en tâche de fond, chaque
replay trouvé (match terminé depuis ≤ 10 jours) est traduit puis analysé
(repères des quart-temps), un travail à la fois. **Dès que quelqu'un regarde
une vidéo, le travail de fond s'efface** : celui du match regardé passe
devant, les autres se mettent en pause et reprennent une fois la lecture
finie (ou 3 min sans signe de vie). `COMMENTARY_NIGHT_WINDOW=2-6` limite le
travail de fond à la nuit, `off` le supprime (traduction seulement à
l'ouverture d'un match). La page d'accueil montre **la vidéo en cours de
traitement** (traduction ou analyse, avancement, « en pause pendant la
lecture ») et la file d'attente, ainsi que l'état de chaque replay : « VF »
(prête), « VF en cours », « VF 45 % » (en partie traduit).

**Traduction automatique** (Paramètres, administrateurs ; activée par
défaut) : désactivée, plus rien ne part tout seul — ni travail de fond (ceux
déjà en file sont abandonnés), ni lancement à l'ouverture d'un match. La
fiche affiche alors le bouton **« Sous-titrer ce match »** (pour tout
utilisateur connecté). Moins de charge pour le
serveur.

**Mémoire GPU** : pendant un travail, Whisper (large-v3-turbo, fp16 ≈ 1,6 Go)
et le modèle de traduction (TranslateGemma 12B Q4_K_M ≈ 8,1 Go, plus le
contexte) sont chargés ensemble : il faut une carte de 12 Go. Sur une carte
plus petite, `TRANSLATE_PARALLEL=1` réduit la mémoire du contexte, ou
`TRANSLATE_MODEL=gemma4:e4b` (≈ 6,6 Go) revient au modèle précédent. Avec
une clé OpenAI, Ollama n'est pas démarré du tout.

- **Un travail à la fois** (le GPU est partagé).
- **Reprise** : tronçons audio, transcriptions et traductions déjà faites
  sont gardés dans `/data/commentary/<okId>/` jusqu'au succès ; un serveur
  éteint ou un flux coupé ne fait pas tout recommencer. Après le succès, le
  son est effacé mais les transcriptions restent (10 jours) : « Relancer la
  traduction » retraduit tout sans refaire la transcription. Une piste partielle
  (travail interrompu) reste servie mais n'a pas le badge « VF » : le match
  est remis en file pour être terminé.
- **Échecs** : flux vidéo ou service local injoignable → nouvel essai
  automatique rapide (15 min → 6 h) ; autre échec → 1 h, 4 h, 16 h, 24 h puis
  abandon tant que la vidéo ne change pas (bouton « Réessayer » de la fiche,
  `POST /api/matches/[id]/commentary` avec `{"action":"start","manual":true}`).
  Un administrateur peut aussi **refaire** une piste, même terminée :
  « Relancer la traduction » (`{"action":"retry"}`, 403 pour un simple
  utilisateur). Une ligne que le LLM ne
  sait pas traduire est gardée en anglais en base (marquée `untranslated`)
  sans bloquer le match, mais **jamais affichée** (ni sous-titre, ni export
  WebVTT) : pas d'anglais au milieu de la VF. Elle est retentée
  **dès la fin du même travail** (seconde passe, ligne par ligne avec les
  lignes qui précèdent pour le sens, traducteur encore chargé), et une piste complète qui en
  contient encore (publiée avant ce rattrapage) reçoit un **travail court de
  rattrapage** — sans flux vidéo ni Whisper, les lignes retraduites une à
  une ; la fiche reste « prête » pendant ce temps. Un seul rattrapage par
  piste (replay et modèle de traduction).
- **Nouvelle vidéo** (autre identifiant ok.ru) ou **nouveau modèle de
  traduction** (`TRANSLATE_MODEL`) : la piste est refaite (pour les matchs
  des 10 derniers jours).
- Le play-by-play ESPN reste utilisé pour les statistiques, l'onglet
  « Actions » et le calage des actions dans la vidéo ; il ne produit plus les
  sous-titres affichés.

| Variable | Défaut | Rôle |
|---|---|---|
| `TRANSCRIBE_URL` | — (Whisper embarqué) | Serveur de transcription EXTERNE compatible OpenAI (speaches), ex. `http://192.168.1.16:8000/v1`. Vide : Whisper embarqué dans le conteneur. |
| `TRANSCRIBE_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | Modèle Whisper (embarqué ou speaches). |
| `WHISPER_PROMPT` | — | `1` : donne à Whisper les équipes et les effectifs. Désactivé par défaut : mesuré, cela corrige quelques noms mais produit des segments de 30 s. |
| `WHISPER_HOTWORDS` | activé | Donne l'effectif du match à Whisper embarqué (`hotwords`) : banc d'essai sur 11 min de vrais commentaires, noms justes 61 % → 79 % et WER 8,0 → 6,0 % (avec la correction par l'effectif : 85 % et 5,5 %). Les sous-titres étant recoupés sur les mots, les segments plus longs ne gênent pas. `0` désactive. |
| `WHISPER_COMPUTE_TYPE` | auto | Précision de Whisper. Auto : `float16` sur carte NVIDIA (pleine précision, ~1,6 Go pour turbo, ~3 Go pour large-v3), `int8` sur processeur. `int8_float16` : moitié moins de mémoire, un peu moins juste. |
| `TRANSCRIBE_API_KEY` | — | Jeton `Bearer`, si speaches est protégé par `API_KEY`. |
| `TRANSCRIBE_TIMEOUT_MS` | `1200000` (20 min) | Délai max de transcription d'un tronçon. |
| `TRANSLATE_URL` | — (Ollama embarqué) | Ollama EXTERNE, ex. `http://192.168.1.16:11434/v1`. Vide : Ollama embarqué dans le conteneur (127.0.0.1, non exposé). |
| `CUDA_VISIBLE_DEVICES` | `0` | Carte NVIDIA utilisée par TOUS les moteurs embarqués (Ollama, Whisper), numérotée comme `nvidia-smi` (`CUDA_DEVICE_ORDER=PCI_BUS_ID` dans l'image). `1` : la deuxième carte ; vide : toutes visibles. |
| `WHISPER_DEVICE` | `auto` | `cuda`, `cpu` ou `auto` (GPU si visible, sinon processeur). |
| `WHISPER_BATCH_SIZE` | `0` | Transcription par lots (mode « batched » de faster-whisper, p. ex. `8` sur GPU, ou `auto` : 8 sur carte NVIDIA, 0 sur processeur) : nettement plus rapide avec le même modèle, **mais** faster-whisper désactive alors le filtre des hallucinations pendant les silences (`hallucination_silence_threshold`) et les nouvelles tentatives à d'autres températures : plus de risque de phrases inventées pendant les pauses. `0` : mode séquentiel (par défaut). |
| `WHISPER_BEAM_SIZE` | `5` | Largeur du faisceau de Whisper (1 à 10). `5` : plus juste quand le public couvre les commentateurs ; `1` (décodage glouton) : 1,5 à 2 fois plus rapide, moins juste sur l'audio bruité. |
| `WHISPER_VAD_THRESHOLD` | `0.35` | Seuil de détection de la parole (Silero VAD, 0,5 par défaut chez faster-whisper) : plus bas, moins de passages couverts par le public écartés comme « pas de parole ». |
| `WHISPER_VAD_MIN_SILENCE_MS` | `1000` | Silence (ms) qui sépare deux passages de parole. |
| `WHISPER_VAD_PAD_MS` | `400` | Marge (ms) gardée autour de chaque passage de parole. |
| `MODELS_DIR` | `/data/models` | Dossier des modèles Whisper et Ollama. |
| `TRANSLATE_MODEL` | `translategemma:12b` | Modèle Ollama de traduction (téléchargé au premier usage par l'Ollama embarqué). Par défaut **TranslateGemma 12B** (Q4_K_M, ≈ 8,1 Go), le modèle de traduction de Google (voir plus bas). Alternatives : `gemma4:e4b` (1er du banc d'essai, plus léger), `gemma4:12b`, `mistral-nemo:12b` ; `hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0` reste possible (moteur `mt`). |
| `TRANSLATE_ENGINE` | auto | `mt` (modèle de traduction pur : gabarit officiel, une phrase à la fois) ou `chat` (LLM généraliste : lots JSON + prompt système). Auto : `mt` si le nom du modèle contient « milmmt », sinon `chat`. |
| `TRANSLATE_PARALLEL` | `2` (`8` en ligne) | Lots (ou phrases en mode `mt`) traduits en même temps : 2 avec Ollama (embarqué ou externe), 8 avec une API en ligne (MiniMax, OpenAI ; 1 à 16). L'Ollama embarqué règle `OLLAMA_NUM_PARALLEL` pareil ; pour un Ollama externe, le régler soi-même. Avec Ollama, c'est aussi le nombre de lots en cours **tous tronçons confondus** (les autres attendent leur tour dans Basketland, pas dans la file d'Ollama où l'attente comptait dans `TRANSLATE_TIMEOUT_MS`). Sur une carte de 12 Go ou plus avec `gemma4:e4b`, `4` accélère encore nettement. La réflexion des modèles (Gemma 4, Qwen 3) est coupée (`think: false`) : inutile pour traduire, elle ajoutait des centaines de jetons cachés à chaque lot et pouvait tronquer la réponse (`num_predict`). |
| `OLLAMA_FLASH_ATTENTION` | `1` | Ollama embarqué : attention « flash » (moins de mémoire pour le contexte). |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | Ollama embarqué : cache du contexte en 8 bits, moitié moins de mémoire qu'en `f16` ; le modèle a moins de risque de déborder de la carte vers la RAM du NAS. Le journal `[ollama] … offloaded N/M layers to GPU` dit où il est chargé (N < M : une partie tourne sur le processeur, en RAM). |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | Ollama embarqué : un seul modèle en mémoire à la fois. |
| `TRANSLATE_BATCH` | `14` | Sous-titres par lot (1 à 60). 12 à 15 recommandé : au-delà, les modèles fusionnent ou décalent plus souvent des lignes. |
| `TRANSLATE_JSON_SCHEMA` | auto | `1` / `0` : impose ou non le schéma JSON de sortie (Ollama embarqué). Auto : oui pour Gemma 4 E2B/E4B, non sinon (Gemma 4 12B décale des lignes sous schéma imposé ; TranslateGemma passe par son gabarit brut, sans schéma). |
| `TRANSLATE_PROMPT_FILE` | — | Fichier texte remplaçant le prompt système par défaut (`TRANSLATE_SYSTEM_PROMPT` dans `src/lib/commentaryAi.ts`). Il doit demander la sortie `{"t":[{"i":<id>,"fr":"…"}]}`. |
| `TRANSLATE_API_KEY` | — | Jeton `Bearer` éventuel du serveur de traduction. |
| `TRANSLATE_TIMEOUT_MS` | `300000` (5 min) | Délai max d'une requête de traduction. |
| `COMMENTARY_CHUNK_SEC` | `120` | Durée d'un tronçon audio (s) : plus court = premiers sous-titres plus tôt, plus long = moins de requêtes et plus de contexte pour Whisper. |
| `COMMENTARY_NIGHT_WINDOW` | `always` | Travail de fond (traduction et analyse vidéo des replays disponibles), toujours en pause pendant une lecture : `always` = dès que le replay est disponible, `2-6` = seulement de 2 h à 6 h (heure de Paris), `off` = jamais (seulement à l'ouverture d'un match). |
| `COMMENTARY_MAX_LEAD_SEC` | `0` | Avance maximale de la traduction sur la lecture (s). `0` (défaut) : aucune, la traduction va au bout du match d'une traite. Une valeur, p. ex. `300` : pendant la lecture, la traduction attend quand elle a cette avance. |
| `COMMENTARY_OVERLAP` | `1` | Le tronçon suivant est transcrit pendant que le courant se traduit (la transcription n'attend plus le traducteur). `0` : l'un après l'autre. |
| `TRANSLATE_REPAIR_MODEL` | `MiniMax-M3` (MiniMax) | Modèle qui reprend une à une les lignes que le modèle de traduction a laissées en anglais, avec des caractères chinois ou des mots collés (réglable dans Paramètres › MiniMax › « Reprise des lignes douteuses » ; `aucun` : le modèle de traduction reprend lui-même). Pour OpenAI, seulement par cette variable. |
| `COMMENTARY_TRANSLATE_AHEAD` | `3` | Tronçons traduits en même temps (1 à 8) pendant que les suivants se transcrivent. Un traducteur en ligne (MiniMax-M3 : 1 à 4 min par tronçon) est bien plus lent que la transcription sur GPU (1 s) : un seul à la fois la faisait attendre. Chaque tronçon est publié dès qu'il est traduit ; un échec arrête le travail. |
| `COMMENTARY_PARALLEL_FETCH` | `1` | Audio de chaque tronçon téléchargé segment par segment sur plusieurs connexions en même temps (ok.ru bride chaque connexion à quelques centaines de kb/s : un seul ffmpeg extrayait moins vite que le temps réel), puis découpé sur place. Un segment qui cale est repris sur une connexion neuve. `0` : ancienne extraction par ffmpeg (et son complet, ci-dessous). |
| — | — | Son de chaque tronçon pris d'abord dans le **son seul** d'ok.ru (manifeste DASH `metadataUrl`, piste AAC ≥ 48 kb/s : 5 à 7 fois moins de données que la vidéo HLS, horodatage juste à 20 ms près), fragments téléchargés en parallèle par plages d'octets ; flux vidéo HLS en secours (abandonné pour le travail après deux échecs du son seul). |
| `COMMENTARY_FETCH_PARALLEL` | `16` | Connexions simultanées vers ok.ru par tronçon (1 à 32), quand rien n'est choisi dans Paramètres › Téléchargement de l'audio (le choix de la page l'emporte). |
| `COMMENTARY_FETCH_STALL_MS` | `6000` | Sans un octet pendant ce délai, un segment est repris sur une connexion neuve. |
| `COMMENTARY_FULL_AUDIO` | `1` | Sans le téléchargement parallèle seulement (`COMMENTARY_PARALLEL_FETCH=0`) : le son de tout le match est extrait en une seule passe dès le début de la traduction ; la traduction en découpe ses tronçons sur place. `0` : extraction tronçon par tronçon. |
| `COMMENTARY_AUDIO_READRATE` | — | Vitesse maximale de cette extraction, en multiple du temps réel (ffmpeg `-readrate`), si elle gêne la lecture. |
| `BACKGROUND_NICE` | `10` | Priorité processeur des tâches lourdes (ffmpeg, Whisper, Ollama, OCR) : 0 à 19, plus haut = plus discret. La lecture vidéo garde la main. |
| `COMMENTARY_VIEWER_IDLE_MS` | `180000` (3 min) | Sans signe de vie de la fiche pendant ce délai, la traduction se met en pause et décharge les modèles. |
| `COMMENTARY_VIEWER_GONE_MS` | `45000` (45 s) | Fiche d'un match en cours de traduction sans signe de vie pendant ce délai : sa traduction cède la place au match qu'on vient d'ouvrir (au lieu de le faire attendre jusqu'à 3 min). |
| `OPENAI_API_KEY` | — | Clé API OpenAI : si définie (ou enregistrée dans la page Paramètres, prioritaire), la traduction passe par l'API OpenAI au lieu d'Ollama. La transcription reste locale. Facturée à l'usage par OpenAI (ce n'est pas l'abonnement ChatGPT). |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Modèle OpenAI de traduction. |
| `COMMENTARY_TIMEOUT_MS` | `21600000` (6 h) | Durée max d'un travail complet : au-delà, il est interrompu et la file continue. |
| `COMMENTARY_DISABLED` | — | `1` désactive la fonctionnalité. |

**Pourquoi TranslateGemma 12B** : un modèle Gemma 3 spécialisé par Google
dans la traduction (55 langues), plus fidèle qu'un LLM généraliste sur des
phrases courtes et elliptiques. Il n'accepte qu'un seul message : le prompt
(règles, glossaire du commentaire basket) et les lignes partent dans son
gabarit brut (`/api/generate`, `raw`). Chaque lot porte **le match** (« Knicks
@ Celtics ») et **l'effectif** : tout ce qui est dit est interprété comme du
basket (« he's cooking » → « il est en feu », pas « il cuisine »).

**Banc d'essai précédent (Gemma 4 E4B)** : banc d'essai sur 55 vraies phrases de
commentateurs NBA (plusieurs diffuseurs, jargon, chiffres, noms), 13 modèles
locaux, note sur 110. Gemma 4 E4B 97, Gemma 4 12B 96, Ministral 3 14B 95,
Mistral Nemo 12B 93… MiLMMT-46-4B 66 (« Brunson got a three » → « Brunson a
obtenu une note de 3 » ; Gemma : « Brunson marque un trois points »), NLLB et
Opus-MT ~50. Qwen 3.8 27B ne fait pas mieux et ne tient pas dans 12 Go.

**Mode `chat` (par défaut)** : lots de 14 sous-titres + les 5 lignes
précédentes pour le contexte, le match et l'effectif, prompt système dédié au commentaire basket
(vocabulaire beIN/Canal+ : « la raquette », « les 24 secondes », « contre »…),
température 0,2, `num_ctx` 4096, sortie JSON. Chaque lot est **contrôlé** :
ids exacts, texte non vide et différent de l'anglais, chiffres et noms propres
de chaque ligne retrouvés en français (une traduction décalée d'une ligne
échoue à ce test). Lot douteux → nouvel essai à température 0, puis lot coupé
en deux ; une ligne seule toujours sans traduction est redemandée en **texte
brut** (sans JSON, mêmes consignes basket, deux essais) ; une ligne vraiment
intraduisible reste en anglais en base, sans être affichée. Pour Qwen3,
`/no_think` est ajouté automatiquement.

**Mode `mt`** (MiLMMT et autres modèles de traduction purs) : une phrase à
la fois, gabarit officiel du modèle (`Translate this from English to French:
…`), décodage glouton ; le français est réparti sur les sous-titres de la
phrase au prorata de l'anglais. Le prompt système ne s'applique pas.

**Temps estimé** par match (2 h) sur une carte 12 Go : Whisper turbo
~3-6 min + TranslateGemma 12B ~12-20 min avec 2 lots en parallèle, soit
**≈ 20-30 min** (estimation calculée, pas mesurée : à confirmer sur le NAS).

## Développement local

L'application est un serveur Rust (`server/`) qui sert les API, les files
médias, le cron et l'interface, celle-ci étant un export statique de Next
(`out/`). Node ne sert qu'à construire l'interface et à lancer les tests.

```bash
npm install
npm run build        # export statique de l'interface dans out/
npm start            # serveur Rust sur http://localhost:3012 (cargo run --release, BL_STATIC_DIR=out)
npm run typecheck    # vérification TypeScript
npm test             # tests vitest (code de référence TypeScript)
cargo test --manifest-path server/Cargo.toml   # tests du serveur Rust
```

Pour travailler sur l'interface avec le rechargement à chaud, lancer Next en
mode développement sur le port interne et le serveur Rust devant lui, qui lui
relaie tout ce qu'il ne sert pas lui-même (pages, fichiers de Next) :

```bash
npm run dev          # next dev sur 127.0.0.1:3013
BL_NODE_CMD= cargo run --manifest-path server/Cargo.toml   # http://localhost:3012
```

## Documentation

- [`docs/migration-rust.md`](docs/migration-rust.md) — migration du serveur en Rust : étapes, règles, variables du serveur Rust.
- [`docs/SPEC.md`](docs/SPEC.md) — spécification technique : sources de données, schéma SQL, routes API, format des données, critères d'acceptation.
- [`docs/reviews/`](docs/reviews/) — les trois revues de code indépendantes (Claude Opus 5.5) qui ont produit les corrections, avec les preuves `fichier:ligne` et les commandes de vérification.

## Licence

Aucune licence n'est déclarée, comme sur les autres dépôts publics du compte.
Les droits restent réservés par défaut : si tu veux ouvrir le code
(MIT, Apache-2.0…), ajoute un fichier `LICENSE` à la racine.
