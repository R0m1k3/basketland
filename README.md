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
| Extra Parameters (vue avancée) | `--runtime=nvidia` |
| Path / Volume | `/mnt/user/appdata/basketland` → `/data` |

Puis **Apply**.

### Image

L'image est construite automatiquement par GitHub Actions à chaque push sur `main` :

```
ghcr.io/r0m1k3/basketland:latest
```

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
    volumes:
      - /mnt/user/appdata/basketland:/data
```

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
  commentateurs », un administrateur choisit Whisper (par défaut : reçoit la
  liste des joueurs, les noms propres sont les mieux reconnus) ou NVIDIA
  Parakeet TDT 0.6B (bien plus rapide sur la carte graphique : la traduction
  prend plus d'avance sur la lecture ; les noms sont corrigés après coup).
  Modèle téléchargé au premier usage dans `/data/models`. Vaut pour les
  prochaines traductions (« Relancer la traduction » refait une piste).
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
| `SEGMENT_CACHE_MB` | `512` | Cache mémoire des segments vidéo (0 le désactive). Les segments **à venir** de chaque lecture sont gardés en priorité, les segments déjà lus partent les premiers. 90 s de 1080p pèsent ~70 Mo. |
| `PREFETCH_AHEAD_SEC` | `90` | Avance du préchargement côté serveur, en secondes de vidéo au-delà du dernier segment demandé par le lecteur (lui-même garde 90 à 180 s d'avance). Bornée à 30 segments et à 60 % du cache. Le préchargement suit la qualité réellement lue. 0 le désactive. |
| `PREFETCH_CONCURRENCY` | `3` | Segments préchargés en parallèle depuis ok.ru (1 à 8), en plus de ceux que le lecteur demande. |
| `SEGMENT_STALL_MS` | `5000` | Un téléchargement ok.ru qui ne reçoit plus un octet pendant ce délai (ou dont les en-têtes tardent 1,6 fois plus) est coupé et repris là où il s'était arrêté, sur une connexion neuve, sans que le lecteur voie la coupure. Avant, une connexion bloquée gelait la lecture jusqu'à 60 s. |
| `SEGMENT_RETRIES` | `4` | Reprises au plus par segment (blocage, coupure, erreur réseau ou 5xx ; une signature expirée déclenche en plus une nouvelle résolution du flux). |
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
(`SEGMENT_CACHE_MB`, 512 Mo) garde en priorité les segments à venir. Si
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
fiche affiche alors les boutons **« Sous-titrer ce match »** et **« Doubler
ce match »** (pour tout utilisateur connecté). Moins de charge pour le
serveur.

**Version française** (Paramètres, administrateurs) : **Sous-titres** (par
défaut) ou **Doublage voix**. Le doublage part des sous-titres : la
traduction est faite dans les deux modes. **Une traduction ne lance jamais
le doublage** (ni la traduction automatique, ni « Sous-titrer ce match », ni
« Relancer la traduction ») : un match n'est doublé que sur **« Doubler ce
match »** (tout utilisateur connecté), qui lance aussi la traduction s'il le
faut. Le mode Doublage voix met ce bouton en avant et fait partir le lecteur
en « VF doublée » tant que l'utilisateur n'a rien choisi. Un doublage demandé
va jusqu'au bout même si l'on quitte la fiche (en pause pendant la lecture
d'un autre match et pendant une traduction). **« Arrêter le doublage »**
(tout utilisateur, pendant le doublage ou son attente) le retire de la file
ou l'interrompt, par exemple pour passer à une autre vidéo : les passages
déjà doublés restent, la traduction continue, et « Reprendre le doublage »
le relance. Les administrateurs ont en plus « Relancer le doublage » (efface
le doublage et le refait).

**Mémoire GPU** : pendant un travail, Whisper (large-v3-turbo, fp16 ≈ 1,6 Go)
et le modèle de traduction (TranslateGemma 12B Q4_K_M ≈ 8,1 Go, plus le
contexte) sont chargés ensemble : il faut une carte de 12 Go. Sur une carte
plus petite, `TRANSLATE_PARALLEL=1` réduit la mémoire du contexte, ou
`TRANSLATE_MODEL=gemma4:e4b` (≈ 6,6 Go) revient au modèle précédent. Avec
une clé OpenAI, Ollama n'est pas démarré du tout.

- **Un travail à la fois** (le GPU est partagé).
- **Reprise** : tronçons audio, transcriptions et traductions déjà faites
  sont gardés dans `/data/commentary/<okId>/` jusqu'au succès ; un serveur
  éteint ou un flux coupé ne fait pas tout recommencer. Une piste partielle
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
  WebVTT, ni doublage) : pas d'anglais au milieu de la VF. Elle est retentée
  à la fin du travail suivant sur ce match, et une piste complète qui en
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
| `WHISPER_COMPUTE_TYPE` | auto | Précision de Whisper. Auto : `int8_float16` sur carte NVIDIA (~1,2-1,5 Go de VRAM au lieu de ~2-2,5 Go), `int8` sur processeur. |
| `TRANSCRIBE_API_KEY` | — | Jeton `Bearer`, si speaches est protégé par `API_KEY`. |
| `TRANSCRIBE_TIMEOUT_MS` | `1200000` (20 min) | Délai max de transcription d'un tronçon. |
| `TRANSLATE_URL` | — (Ollama embarqué) | Ollama EXTERNE, ex. `http://192.168.1.16:11434/v1`. Vide : Ollama embarqué dans le conteneur (127.0.0.1, non exposé). |
| `WHISPER_DEVICE` | `auto` | `cuda`, `cpu` ou `auto` (GPU si visible, sinon processeur). |
| `WHISPER_BATCH_SIZE` | `0` | Transcription par lots (mode « batched » de faster-whisper, p. ex. `8` sur GPU, ou `auto` : 8 sur carte NVIDIA, 0 sur processeur) : nettement plus rapide avec le même modèle, **mais** faster-whisper désactive alors le filtre des hallucinations pendant les silences (`hallucination_silence_threshold`) et les nouvelles tentatives à d'autres températures : plus de risque de phrases inventées pendant les pauses. `0` : mode séquentiel (par défaut). |
| `WHISPER_BEAM_SIZE` | `1` | Largeur du faisceau de Whisper (1 à 10). `1` (décodage glouton) : 1,5 à 2 fois plus rapide que `5`, presque aussi juste. |
| `PARAKEET_PYTHON` | `/opt/parakeet/bin/python` | Python du moteur « NVIDIA Parakeet » (Paramètres › Transcription des commentateurs). |
| `PARAKEET_QUANTIZATION` | `auto` | Précision de Parakeet : `auto` (modèle d'origine sur carte NVIDIA, `int8` sur processeur), `int8` ou `fp32`. |
| `PARAKEET_BATCH_SIZE` | `8` | Passages de parole transcrits ensemble par Parakeet. |
| `MODELS_DIR` | `/data/models` | Dossier des modèles Whisper et Ollama (et des voix du doublage, cache Hugging Face `hf/`). |
| `TRANSLATE_MODEL` | `translategemma:12b` | Modèle Ollama de traduction (téléchargé au premier usage par l'Ollama embarqué). Par défaut **TranslateGemma 12B** (Q4_K_M, ≈ 8,1 Go), le modèle de traduction de Google (voir plus bas). Alternatives : `gemma4:e4b` (1er du banc d'essai, plus léger), `gemma4:12b`, `mistral-nemo:12b` ; `hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0` reste possible (moteur `mt`). |
| `TRANSLATE_ENGINE` | auto | `mt` (modèle de traduction pur : gabarit officiel, une phrase à la fois) ou `chat` (LLM généraliste : lots JSON + prompt système). Auto : `mt` si le nom du modèle contient « milmmt », sinon `chat`. |
| `TRANSLATE_PARALLEL` | `2` (`8` en ligne) | Lots (ou phrases en mode `mt`) traduits en même temps : 2 avec Ollama (embarqué ou externe), 8 avec une API en ligne (MiniMax, OpenAI ; 1 à 16). L'Ollama embarqué règle `OLLAMA_NUM_PARALLEL` pareil ; pour un Ollama externe, le régler soi-même. |
| `TRANSLATE_BATCH` | `14` | Sous-titres par lot (1 à 60). 12 à 15 recommandé : au-delà, les modèles fusionnent ou décalent plus souvent des lignes. |
| `TRANSLATE_JSON_SCHEMA` | auto | `1` / `0` : impose ou non le schéma JSON de sortie (Ollama embarqué). Auto : oui pour Gemma 4 E2B/E4B, non sinon (Gemma 4 12B décale des lignes sous schéma imposé ; TranslateGemma passe par son gabarit brut, sans schéma). |
| `TRANSLATE_PROMPT_FILE` | — | Fichier texte remplaçant le prompt système par défaut (`TRANSLATE_SYSTEM_PROMPT` dans `src/lib/commentaryAi.ts`). Il doit demander la sortie `{"t":[{"i":<id>,"fr":"…"}]}`. |
| `TRANSLATE_API_KEY` | — | Jeton `Bearer` éventuel du serveur de traduction. |
| `TRANSLATE_TIMEOUT_MS` | `300000` (5 min) | Délai max d'une requête de traduction. |
| `COMMENTARY_CHUNK_SEC` | `120` | Durée d'un tronçon audio (s) : plus court = premiers sous-titres plus tôt, plus long = moins de requêtes et plus de contexte pour Whisper. |
| `COMMENTARY_NIGHT_WINDOW` | `always` | Travail de fond (traduction et analyse vidéo des replays disponibles), toujours en pause pendant une lecture : `always` = dès que le replay est disponible, `2-6` = seulement de 2 h à 6 h (heure de Paris), `off` = jamais (seulement à l'ouverture d'un match). |
| `COMMENTARY_MAX_LEAD_SEC` | `0` | Avance maximale de la traduction sur la lecture (s). `0` (défaut) : aucune, la traduction va au bout du match d'une traite (utile pour doubler ensuite). Une valeur, p. ex. `300` : pendant la lecture, la traduction attend quand elle a cette avance. |
| `COMMENTARY_OVERLAP` | `1` | Le tronçon suivant est transcrit pendant que le courant se traduit (la transcription n'attend plus le traducteur). `0` : l'un après l'autre. |
| `COMMENTARY_PARALLEL_FETCH` | `1` | Audio de chaque tronçon téléchargé segment par segment sur plusieurs connexions en même temps (ok.ru bride chaque connexion à quelques centaines de kb/s : un seul ffmpeg extrayait moins vite que le temps réel), puis découpé sur place. Un segment qui cale est repris sur une connexion neuve. `0` : ancienne extraction par ffmpeg (et son complet, ci-dessous). |
| `COMMENTARY_FETCH_PARALLEL` | `16` | Connexions simultanées vers ok.ru par tronçon (1 à 32), quand rien n'est choisi dans Paramètres › Téléchargement de l'audio (le choix de la page l'emporte). |
| `COMMENTARY_FETCH_STALL_MS` | `6000` | Sans un octet pendant ce délai, un segment est repris sur une connexion neuve. |
| `COMMENTARY_FULL_AUDIO` | `1` | Sans le téléchargement parallèle seulement (`COMMENTARY_PARALLEL_FETCH=0`) : le son de tout le match est extrait en une seule passe dès le début de la traduction ; traduction et doublage en découpent leurs tronçons sur place. `0` : extraction tronçon par tronçon. |
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

## Doublage (voix françaises)

Le doublage fait dire les sous-titres traduits par des **voix françaises
synthétisées dans le conteneur**, sur la carte NVIDIA : Qwen3-TTS
(Apache-2.0, modèle `Qwen/Qwen3-TTS-12Hz-0.6B-Base`) **clone** l'une des
voix figées livrées dans `assets/voices/` (un enregistrement de référence de
7-8 s à 24 kHz, `reference.wav`, et sa transcription, `reference.txt`) :

| Voix | Rôle |
|---|---|
| `A` | Commentateur (play-by-play) |
| `B4` | Consultant principal |
| `B1` | Troisième voix (2e consultant, bord du terrain, interview) |
| `F` | Voix féminine (reporter au bord du terrain, consultante) |

Ces voix ont été **créées** par Qwen3-TTS VoiceDesign à partir d'une
description (aucune voix réelle n'est imitée) puis validées à l'écoute ;
`voice.json` garde leur fiche de création. Pour attribuer chaque ligne au bon
commentateur, le même moteur calcule l'**empreinte vocale** des passages
(SpeechBrain ECAPA, `speechbrain/spkrec-ecapa-voxceleb`), la hauteur
médiane de la voix (F0) et la **probabilité que ce soit une voix de femme**
(classifieur `JaesungHuh/voice-gender-classifier`, licence MIT : un
ECAPA-TDNN affiné sur VoxCeleb2, 62 Mo ; architecture dans
`scripts/voice_gender.py`).

Le moteur (`scripts/voice_worker.py`, environnement Python `/opt/tts` de
l'image, piloté par `src/lib/voiceAi.ts`) est démarré à la demande puis
arrêté à la fin, comme Whisper. Modèles téléchargés au premier usage dans
`/data/models/hf` (≈ 2,5 Go pour Qwen3-TTS, ≈ 85 Mo pour ECAPA, 62 Mo pour
le classifieur homme/femme), jamais dans l'image. Ce téléchargement se fait
à part (`voice_worker.py --download-only`), sans la carte graphique : il
commence dès qu'un doublage est mis en file, continue pendant que le doublage
attend le GPU (traduction ou analyse en cours) et n'est jamais interrompu
quand le doublage cède la place ; la fiche du match affiche sa progression,
puis l'étape en cours (extraction, chargement du moteur, reconnaissance des
voix, synthèse des répliques n / N, montage). Qwen3-TTS peut parfois ne
pas finir sa phrase : chaque synthèse est plafonnée en longueur
(proportionnelle au texte) et en temps, une prise ratée (plafond atteint,
délai dépassé, durée absurde) est refaite une fois, puis signalée en erreur.

**Mémoire GPU** : Qwen3-TTS 0.6B en bf16 ≈ **3 à 4 Go** (estimation, pas
mesurée sur carte : 1,8 Go de poids et 0,7 Go de codec, plus le cache et les
activations ; ECAPA et le classifieur homme/femme ≈ 0,2 Go de plus). Le
doublage passe **après** la traduction : Whisper et TranslateGemma sont déchargés avant, ils ne tournent
jamais en même temps. bf16 à partir des RTX 30xx, float16 sur les RTX 20xx
(les builds CUDA 12.8 de torch exigent une carte Turing ou plus récente).
Sans carte, le moteur tourne sur le processeur en float32, environ 8 fois
plus lentement que le temps réel (mesuré sur 4 cœurs libres, bien plus
lent sur un processeur occupé) : bon pour un essai, pas pour un match entier. L'environnement `/opt/tts` (torch 2.8 CUDA 12.8)
ajoute ≈ 2,6 Go compressés à l'image ; cuBLAS et cuDNN sont partagés avec
Whisper.

**Déroulement** (`src/lib/dub.ts`) : un match est doublé **tronçon par
tronçon** dès que ses sous-titres français existent (piste en cours ou
complète), dans une file à part, un match à la fois. Pour chaque tronçon :
l'audio est réextrait, chaque réplique reçoit son locuteur (empreintes ECAPA
regroupées sur tout le match, seuil `DUB_SPEAKER_SIM`), puis sa voix — une
locutrice prend **F** (voir ci-dessous), les autres par temps de parole : le
1er locuteur prend **A**, le 2e **B4**, les suivants **B1** ; une voix
attribuée ne change plus de tout le match (sauf la bascule unique vers F).
Chaque réplique est dite (« ! » ajouté sur les moments forts : l'intonation
suit la ponctuation), accélérée si elle déborde de sa place (×1,35 au plus, sinon la
suivante est repoussée : deux voix ne parlent jamais en même temps), puis le
tronçon est monté en AAC (`/data/dub/<match>/chunk-N.m4a`). Le doublage **ne
tourne jamais en même temps qu'une traduction ou une analyse** (la carte
graphique est partagée) : il s'arrête à la réplique suivante et reprend
après. Il ne part que sur un clic « Doubler ce match » (`POST
/api/matches/[id]/dub`), jamais après une traduction ni en tâche de fond.
Comme la traduction, il s'efface pendant la lecture d'un autre match, et le
doublage demandé du match regardé passe devant (`GET /api/matches/[id]/dub` :
manifeste des tronçons ; `/dub/<n>` : l'audio). Il suit la traduction en
cours tronçon par tronçon jusqu'au doublage complet.

**Voix féminine automatique** : une locutrice (reporter au bord du terrain,
consultante) prend la voix **F**. Pour chaque réplique d'au moins 1 s, le
classifieur donne la probabilité d'une voix de femme ; un locuteur prend F
quand au moins **10 s** de ses répliques ont été classées et que leur
probabilité moyenne (pondérée par la durée) atteint `DUB_FEMALE_PROB`
(**0,85**). Seules ses **30 premières secondes** de parole comptent : un
locuteur vu d'abord trop brièvement reçoit une voix d'homme provisoire, puis
bascule **une seule fois** vers F si les preuves arrivent dans ces 30 s
(journal : « locuteur #n reconnu comme une femme ») ; ensuite son genre est
figé, jamais de changement de voix en plein match. La hauteur de voix ne
décide pas : sur le son diffusé, un commentateur qui s'emballe parle à
230-250 Hz, autant qu'une femme.

Mesures (CPU, petit échantillon, octobre 2026) :

- **commentateurs NBA réels** (5 extraits de 3,5 min, 292 répliques, dont
  60 emballées à 200-380 Hz) : P(femme) médiane 0,005, une seule réplique
  au-dessus de 0,5 (1,1 s à 0,52), moyenne ≤ 0,09 sur toute fenêtre de 6 s ;
- **reporter réelle** (bord du terrain, dans l'un de ces extraits,
  38 s) : 0,995 à 0,997 sur chacune de ses 10 répliques ;
- **voix de synthèse** : A, B4, B1 ≤ 0,003 ; F et les candidates F2, F3
  ≥ 0,99 ;
- **livres audio français** (MLS, CC BY 4.0 : 7 lectrices, 9 lecteurs,
  découpés en répliques de 3 s, aussi mêlés au bruit de salle à 10 et 5 dB) :
  sur n'importe quelles 30 s, moyenne ≥ 0,87 pour 6 lectrices sur 7 ;
  ≤ 0,3 pour les lecteurs sans bruit, jusqu'à 0,57 pour l'un d'eux noyé dans
  le bruit. Mais sur 6 s, un lecteur qui **imite une voix de femme**
  (fausset) monte à 0,97, le lecteur noyé dans le bruit à 0,93 : d'où
  10 s minimum et 0,85 (pire homme 0,83 sur 10 s, bruit à 5 dB). En
  contrepartie, une lectrice à la voix grave (0,65 à 0,89 sur 30 s selon le
  passage) n'est pas toujours reconnue.

Une femme qui ne parle que par bribes (moins de 10 s de répliques d'au moins
1 s dans ses 30 premières secondes) garde une voix d'homme. Sans réseau au
premier usage, le classifieur manque : pas de voix F automatique pendant ce
doublage, le reste continue.

**Dans le lecteur** : menu ⚙ → « Voix » : « Originale (VO) » / « VF
doublée » (mémorisé ; par défaut, VF doublée en mode Doublage voix). La voix française est calée sur l'image (saut, pause,
gel, reprise) ; pendant qu'elle parle, le son d'origine est baissé à 20 % —
la foule reste audible entre les phrases. Les passages pas encore doublés
restent en VO (« bientôt disponible ici »). À une vitesse autre que ×1, la
VF doublée se tait (elle serait déformée). Les sous-titres restent
indépendants.

**Limites connues** : la répartition des répliques entre commentateurs est
juste pour ~85-90 % des lignes sur l'extrait testé ; la voix féminine
automatique est validée sur peu de voix (une seule reporter réelle en son
diffusé) et un commentateur qui imiterait une femme en fausset plus de 10 s
d'affilée dès ses premières répliques la prendrait ; certains noms (Shai,
Jokic) gagneraient à un lexique de prononciation.

**Voix MiniMax (en ligne, facultatif)** : avec une clé API MiniMax
(page **Paramètres → MiniMax**, ou variable `MINIMAX_API_KEY` ; la page
l'emporte, et y règle aussi le modèle et la voix de chaque rôle), les répliques sont dites par les **voix françaises du
catalogue MiniMax** (`speech-2.8-hd` par défaut) au lieu de Qwen3-TTS :
meilleure qualité, rien à télécharger (2,5 Go en moins) et surtout **plus de
carte graphique** pour la synthèse. Le doublage tourne alors en même temps
que les traductions au lieu de leur céder la place. L'analyse des voix
(empreintes, genre), qui répartit les répliques entre les commentateurs,
reste locale, sur le processeur (`voice_worker.py --embed-only`, ~150 Mo de
modèles). Voix par défaut : `A` commentateur `French_Male_Speech_New`,
`B4` consultant `French_MaleNarrator`, `B1` troisième voix
`French_CasualMan`, `F` voix féminine `French_FemaleAnchor`. La
consommation se compte en caractères (abonnement ou crédit MiniMax) : de
l'ordre de 60 000 à 100 000 caractères par match doublé.

| Variable | Défaut | Rôle |
|---|---|---|
| `DUB_DISABLED` | — | `1` désactive le doublage. |
| `MINIMAX_API_KEY` | — | Clé API MiniMax : voix du doublage par MiniMax (voir plus haut). Sans clé (ni ici ni dans la page Paramètres), Qwen3-TTS embarqué. Clé, modèle et voix enregistrés dans la page Paramètres l'emportent sur les variables. |
| `TTS_ENGINE` | auto | `minimax` ou `local` (Qwen3-TTS). Auto : MiniMax si `MINIMAX_API_KEY` est défini. |
| `MINIMAX_TRANSLATE` | — | `1` : traduction des commentaires par MiniMax (même clé), comme l'interrupteur de la page Paramètres (qui l'emporte). Passe devant OpenAI et le modèle local ; Whisper reste local. |
| `MINIMAX_TRANSLATE_MODEL` | `MiniMax-M3.1-Flash` | Modèle texte MiniMax de la traduction (`MiniMax-M3` : plus soigné, plus lent). |
| `MINIMAX_TTS_MODEL` | `speech-2.8-hd` | Modèle de voix MiniMax (`speech-2.8-turbo` : plus rapide et moins cher). |
| `MINIMAX_VOICE_A`, `MINIMAX_VOICE_B4`, `MINIMAX_VOICE_B1`, `MINIMAX_VOICE_F` | voix françaises ci-dessus | `voice_id` MiniMax de chaque rôle (liste « System Voice ID » de la documentation MiniMax) ; vide : rôle retiré (repli sur une autre voix). |
| `MINIMAX_EMOTIONS` | `1` | Moments forts : ton imposé à MiniMax (emphase 2 → « surprised », 1 → « happy »). `0` : le modèle choisit seul. |
| `TTS_EMBED_THREADS` | `2` | Avec MiniMax : cœurs du processeur pour l'analyse des voix. |
| `MINIMAX_TTS_SPEED` | `1` | Débit de parole MiniMax (0,5 à 2). |
| `MINIMAX_API_URL` | `https://api.minimax.io` | Serveur de l'API (p. ex. `https://api-uw.minimax.io`). |
| `TTS_EMBED_DEVICE` | `cpu` | Avec MiniMax : appareil de l'analyse des voix (`cpu`, ou `cuda`, le doublage attend alors de nouveau le GPU). |
| `TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Modèle Qwen3-TTS (dépôt Hugging Face ou dossier local), de type « Base » (clonage de voix). |
| `TTS_DEVICE` | `auto` | `cuda`, `cpu` ou `auto` (GPU si visible, sinon processeur). |
| `VOICES_DIR` | `/app/assets/voices` | Dossier des voix : un sous-dossier par voix avec `reference.wav`, `reference.txt` et `voice.json`. |
| `TTS_PYTHON` | `/opt/tts/bin/python` | Python du moteur de voix. Hors Docker : `python3`, avec torch 2.8, `qwen-tts==0.1.1`, `speechbrain==1.1.2` et `soundfile` (liste complète : `scripts/voice-requirements.txt`). |
| `TTS_LOAD_TIMEOUT_MS` | `600000` (10 min) | Délai de démarrage du moteur **sans nouvelles** de sa part : chaque étape du téléchargement du modèle le relance. |
| `TTS_SYNTH_TIMEOUT_SEC` | auto | Délai max d'une prise (s). Auto : 20 s + 3 × la durée plausible maximale de la ligne sur GPU, 60 s + 60 × sur processeur. |
| `DUB_SPEAKER_SIM` | `0.6` | Similarité (cosinus) minimale pour rattacher une réplique à un locuteur déjà connu ; en dessous, nouveau locuteur. |
| `DUB_MIN_NEW_SPEAKER_SEC` | `2` | Une réplique plus courte ne crée jamais de nouveau locuteur (empreinte peu fiable). |
| `DUB_MAX_SPEAKERS` | `4` | Locuteurs au plus par match ; au-delà, une réplique rejoint le locuteur le plus proche. |
| `DUB_FEMALE_PROB` | `0.85` | Probabilité moyenne « voix de femme » (classifieur, sur au moins 10 s de répliques dans les 30 premières secondes du locuteur) à partir de laquelle un locuteur prend la voix féminine `F`. Une valeur > 1 désactive la voix F automatique. |
| `DUB_FEMALE_F0` | — (désactivé) | Repli si le classifieur manque (ou n'a pas assez entendu un nouveau locuteur) : hauteur de voix médiane (Hz) à partir de laquelle il prend `F`. Jamais contre le classifieur. |
| `DUB_TIMEOUT_MS` | `21600000` (6 h) | Durée max d'un travail de doublage. |

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
