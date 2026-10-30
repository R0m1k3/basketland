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
Next.js 15 (App Router) · TypeScript · Tailwind · SQLite
        │
        ├── API ESPN           matchs, calendrier, boxscores, play-by-play
        ├── basketball-video   découverte des replays
        └── ok.ru (HLS)        résolution du flux, proxy segmenté
```

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
> puis redémarrage), sans ligne de commande.

## Connexion et utilisateurs

Tout le site (pages et API) est réservé aux comptes connectés. Restent publics :
`/api/health` (healthcheck Docker) et `/api/ingest` (protégé par son propre jeton).

- **Premier démarrage** : tant qu'aucun compte n'existe, toute page mène à
  `/setup`, qui crée le compte **administrateur** (identifiant + mot de passe de
  8 caractères minimum). Cette page disparaît ensuite.
- **Connexion** : `/login`. La session (cookie httpOnly) dure 30 jours et se
  prolonge tant qu'elle sert. 5 échecs de connexion → 1 minute d'attente.
- **Paramètres** (`/parametres`, icône d'engrenage en haut à droite) : chacun y
  change son mot de passe et se déconnecte. Un administrateur y gère aussi les
  comptes (ajout, rôle, réinitialisation du mot de passe, suppression — le
  dernier administrateur ne peut être ni supprimé ni rétrogradé).
- **Traduction via OpenAI (option)** : dans Paramètres › « Traduction des
  commentaires », un administrateur peut enregistrer une clé API OpenAI et un
  modèle (ex. `gpt-5.4-mini`). La traduction passe alors par l'API OpenAI au lieu
  d'Ollama ; la transcription (Whisper) reste locale. La clé se crée sur
  platform.openai.com et est facturée à l'usage (ce n'est pas l'abonnement
  ChatGPT) ; elle n'est jamais réaffichée en entier.
- **Mot de passe perdu** : depuis le NAS,

  ```bash
  docker exec -it basketland node scripts/reset-password.mjs <identifiant> <nouveau-mot-de-passe>
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
| `SEGMENT_CACHE_MB` | `192` | Cache mémoire des segments vidéo préchargés (0 le désactive). |
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
position (en haut / en bas) se règlent dans le menu ⚙ du lecteur. Les
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
  abandon tant que la vidéo ne change pas (`POST /api/matches/[id]/commentary`
  avec `{"action":"retry"}` relance à la main). Une ligne que le LLM ne
  sait pas traduire reste en anglais (marquée `untranslated` en base) sans
  bloquer le match.
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
| `TRANSCRIBE_API_KEY` | — | Jeton `Bearer`, si speaches est protégé par `API_KEY`. |
| `TRANSCRIBE_TIMEOUT_MS` | `1200000` (20 min) | Délai max de transcription d'un tronçon. |
| `TRANSLATE_URL` | — (Ollama embarqué) | Ollama EXTERNE, ex. `http://192.168.1.16:11434/v1`. Vide : Ollama embarqué dans le conteneur (127.0.0.1, non exposé). |
| `WHISPER_DEVICE` | `auto` | `cuda`, `cpu` ou `auto` (GPU si visible, sinon processeur). |
| `MODELS_DIR` | `/data/models` | Dossier des modèles Whisper et Ollama. |
| `TRANSLATE_MODEL` | `translategemma:12b` | Modèle Ollama de traduction (téléchargé au premier usage par l'Ollama embarqué). Par défaut **TranslateGemma 12B** (Q4_K_M, ≈ 8,1 Go), le modèle de traduction de Google (voir plus bas). Alternatives : `gemma4:e4b` (1er du banc d'essai, plus léger), `gemma4:12b`, `mistral-nemo:12b` ; `hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0` reste possible (moteur `mt`). |
| `TRANSLATE_ENGINE` | auto | `mt` (modèle de traduction pur : gabarit officiel, une phrase à la fois) ou `chat` (LLM généraliste : lots JSON + prompt système). Auto : `mt` si le nom du modèle contient « milmmt », sinon `chat`. |
| `TRANSLATE_PARALLEL` | `2` | Lots (ou phrases en mode `mt`) traduits en même temps. L'Ollama embarqué règle `OLLAMA_NUM_PARALLEL` pareil ; pour un Ollama externe, le régler soi-même. |
| `TRANSLATE_BATCH` | `14` | Sous-titres par lot (1 à 60). 12 à 15 recommandé : au-delà, les modèles fusionnent ou décalent plus souvent des lignes. |
| `TRANSLATE_JSON_SCHEMA` | auto | `1` / `0` : impose ou non le schéma JSON de sortie (Ollama embarqué). Auto : oui pour Gemma 4 E2B/E4B, non sinon (Gemma 4 12B décale des lignes sous schéma imposé ; TranslateGemma passe par son gabarit brut, sans schéma). |
| `TRANSLATE_PROMPT_FILE` | — | Fichier texte remplaçant le prompt système par défaut (`TRANSLATE_SYSTEM_PROMPT` dans `src/lib/commentaryAi.ts`). Il doit demander la sortie `{"t":[{"i":<id>,"fr":"…"}]}`. |
| `TRANSLATE_API_KEY` | — | Jeton `Bearer` éventuel du serveur de traduction. |
| `TRANSLATE_TIMEOUT_MS` | `300000` (5 min) | Délai max d'une requête de traduction. |
| `COMMENTARY_CHUNK_SEC` | `120` | Durée d'un tronçon audio (s) : plus court = premiers sous-titres plus tôt, plus long = moins de requêtes et plus de contexte pour Whisper. |
| `COMMENTARY_NIGHT_WINDOW` | `always` | Travail de fond (traduction et analyse vidéo des replays disponibles), toujours en pause pendant une lecture : `always` = dès que le replay est disponible, `2-6` = seulement de 2 h à 6 h (heure de Paris), `off` = jamais (seulement à l'ouverture d'un match). |
| `COMMENTARY_MAX_LEAD_SEC` | `300` (5 min) | Quand quelqu'un regarde, la traduction ne prend pas plus d'avance que cela sur la lecture : elle attend, au lieu de télécharger le flux ok.ru en concurrence avec le lecteur. |
| `BACKGROUND_NICE` | `10` | Priorité processeur des tâches lourdes (ffmpeg, Whisper, Ollama, OCR) : 0 à 19, plus haut = plus discret. La lecture vidéo garde la main. |
| `COMMENTARY_VIEWER_IDLE_MS` | `180000` (3 min) | Sans signe de vie de la fiche pendant ce délai, la traduction se met en pause et décharge les modèles. |
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
en deux ; une ligne vraiment intraduisible reste en anglais. Pour Qwen3,
`/no_think` est ajouté automatiquement.

**Mode `mt`** (MiLMMT et autres modèles de traduction purs) : une phrase à
la fois, gabarit officiel du modèle (`Translate this from English to French:
…`), décodage glouton ; le français est réparti sur les sous-titres de la
phrase au prorata de l'anglais. Le prompt système ne s'applique pas.

**Temps estimé** par match (2 h) sur une carte 12 Go : Whisper turbo
~3-6 min + TranslateGemma 12B ~12-20 min avec 2 lots en parallèle, soit
**≈ 20-30 min** (estimation calculée, pas mesurée : à confirmer sur le NAS).

## Développement local

```bash
npm install
npm run dev          # http://localhost:3012
npm run build        # build de production
npm run typecheck    # vérification TypeScript
npm test             # 162 tests (dont 32 sur captures réelles)
```

Le build utilise `output: 'standalone'` (comme l'image Docker). Le serveur
standalone est donc lancé par `npm start` — et **il exige `HOSTNAME=0.0.0.0`**,
sans quoi il écoute sur le nom d'hôte de la machine au lieu de toutes les
interfaces :

```bash
npm run build
npm start
```

`npm start` passe par `scripts/start-standalone.mjs`, qui recopie `.next/static`
et `public` dans `.next/standalone` avant de lancer le serveur : sans cette
étape, les pages étaient servies **sans leur CSS ni leur JavaScript** (404 sur
`/_next/static/...`), donc sans lecteur vidéo ni calibration. Le Dockerfile
fait la même chose à la construction de l'image.

> Après un `npm run build`, il faut **relancer** le serveur : une instance
> déjà lancée continue de servir l'ancien `.next/static` et renvoie `400` sur
> les CSS/JS (le fichier n'existe plus, son nom a changé avec le build).
> C'est le symptôme d'une instance plus ancienne que le build, pas d'un bug
> de l'application.

`npm run start:next` lance `next start` (non compatible avec `standalone` :
Next.js le signale à chaque démarrage).

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — spécification technique : sources de données, schéma SQL, routes API, format des données, critères d'acceptation.
- [`docs/reviews/`](docs/reviews/) — les trois revues de code indépendantes (Claude Opus 5.5) qui ont produit les corrections, avec les preuves `fichier:ligne` et les commandes de vérification.

## Licence

Aucune licence n'est déclarée, comme sur les autres dépôts publics du compte.
Les droits restent réservés par défaut : si tu veux ouvrir le code
(MIT, Apache-2.0…), ajoute un fichier `LICENSE` à la racine.
