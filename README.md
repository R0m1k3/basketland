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

### Option A — une commande (le plus rapide)

Dans **Unraid → Terminal**, collez :

```bash
mkdir -p /mnt/user/appdata/basketland && \
docker run -d \
  --name basketland \
  --restart unless-stopped \
  -p 3012:3012 \
  -e TZ=Europe/Paris \
  -v /mnt/user/appdata/basketland:/data \
  ghcr.io/r0m1k3/basketland:latest
```

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
    ports:
      - '3012:3012'
    environment:
      TZ: Europe/Paris
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
  -p 3012:3012 -e TZ=Europe/Paris \
  -v /mnt/user/appdata/basketland:/data \
  ghcr.io/r0m1k3/basketland:latest
```

Le volume `/data` (base SQLite, jeton, cache) est conservé : `docker rm`
sans `-v` ne touche pas au dossier hôte.

> Si tu as installé le conteneur via l'interface Unraid, un **Update** dans
> l'onglet Docker fait la même chose (téléchargement de la nouvelle image
> puis redémarrage), sans ligne de commande.

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
| `sync-videos` | Découvre les replays sur basketball-video.com. |
| `sync-subtitles` | Régénère la VF française et recalcule la synchronisation. |

Le jeton d'ingestion est soit défini par la variable d'environnement
`INGEST_TOKEN`, soit généré automatiquement dans `/data/ingest_token`.

### Calibration automatique de la VF

La synchronisation se fait **toute seule** : toutes les 10 minutes, les
matchs terminés depuis moins de 10 jours qui ont un replay sont mis en file
d'analyse (une analyse à la fois, 3 à 6 min chacune). Ouvrir la fiche d'un
match le fait passer en tête de file. L'état est affiché sous le lecteur
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
que disent les commentateurs** du replay, produite entièrement en local par
deux services du NAS (carte NVIDIA) :

```
audio du replay ──ffmpeg──▶ tronçons de 10 min (Opus mono 16 kHz, 24 kb/s)
   ──speaches (Whisper)──▶ texte anglais horodaté au mot
   ──filtre des hallucinations, découpage en sous-titres (≤ 84 car., 1,2-6 s)
   ──Ollama (MiLMMT-46, modèle de traduction)──▶ français, phrase par phrase
   ──▶ table commentary_cues ──▶ GET /api/matches/[id]/subtitles (+ .vtt)
```

- **Un travail à la fois** (le GPU est partagé). Toutes les 10 min, les
  matchs terminés depuis ≤ 10 jours avec replay (HLS ou MP4 « mobile » :
  l'audio suffit) sont mis en file ; ouvrir la fiche d'un match le met en
  tête de file.
- **Reprise** : tronçons audio, transcriptions et traductions déjà faites
  sont gardés dans `/data/commentary/<okId>/` jusqu'au succès ; un serveur
  éteint ou un flux coupé ne fait pas tout recommencer.
- **Échecs** : flux vidéo ou service local injoignable → nouvel essai
  automatique rapide (15 min → 6 h) ; autre échec → 1 h, 4 h, 16 h, 24 h puis
  abandon tant que la vidéo ne change pas (`POST /api/matches/[id]/commentary`
  avec `{"action":"retry"}` relance à la main). Une ligne que le LLM ne
  sait pas traduire reste en anglais (marquée `untranslated` en base) sans
  bloquer le match.
- **Nouvelle vidéo** (autre identifiant ok.ru) : la piste est refaite.
- Le play-by-play ESPN reste utilisé pour les statistiques, l'onglet
  « Actions » et le calage des actions dans la vidéo ; il ne produit plus les
  sous-titres affichés.

| Variable | Défaut | Rôle |
|---|---|---|
| `TRANSCRIBE_URL` | — | Base de l'API compatible OpenAI de speaches, ex. `http://192.168.1.16:8000/v1` (appel : `POST …/audio/transcriptions`). **Sans elle, la fonctionnalité est inactive.** |
| `TRANSCRIBE_MODEL` | `Systran/faster-distil-whisper-large-v3` | Modèle Whisper demandé à speaches. |
| `TRANSCRIBE_API_KEY` | — | Jeton `Bearer`, si speaches est protégé par `API_KEY`. |
| `TRANSCRIBE_TIMEOUT_MS` | `1200000` (20 min) | Délai max de transcription d'un tronçon. |
| `TRANSLATE_URL` | — | Adresse d'Ollama, ex. `http://192.168.1.16:11434/v1` (MiLMMT : `POST /api/generate` en complétion brute ; LLM généraliste : `POST …/chat/completions`). **Sans elle, la fonctionnalité est inactive.** |
| `TRANSLATE_MODEL` | `hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0` | Modèle Ollama de traduction (à installer avec `ollama pull`). Par défaut **MiLMMT-46-4B v1.0** (Xiaomi), modèle spécialisé en traduction. |
| `TRANSLATE_ENGINE` | auto | `mt` (modèle de traduction pur : gabarit officiel, une phrase à la fois) ou `chat` (LLM généraliste : lots JSON + prompt système). Auto : `mt` si le nom du modèle contient « milmmt », sinon `chat`. |
| `TRANSLATE_PARALLEL` | `2` | Requêtes de traduction simultanées en mode `mt` (Ollama : régler `OLLAMA_NUM_PARALLEL` en conséquence). |
| `TRANSLATE_BATCH` | `20` | Sous-titres par lot (1 à 60). |
| `TRANSLATE_PROMPT_FILE` | — | Fichier texte remplaçant le prompt système par défaut (`TRANSLATE_SYSTEM_PROMPT` dans `src/lib/commentaryAi.ts`). Il doit demander la sortie `{"t":[{"i":<id>,"fr":"…"}]}`. |
| `TRANSLATE_API_KEY` | — | Jeton `Bearer` éventuel du serveur de traduction. |
| `TRANSLATE_TIMEOUT_MS` | `300000` (5 min) | Délai max d'une requête de traduction. |
| `COMMENTARY_CHUNK_SEC` | `600` | Durée d'un tronçon audio. |
| `COMMENTARY_TIMEOUT_MS` | `21600000` (6 h) | Durée max d'un travail complet : au-delà, il est interrompu et la file continue. |
| `COMMENTARY_DISABLED` | — | `1` désactive la fonctionnalité. |

**Mode `mt` (MiLMMT, par défaut)** : le modèle traduit une phrase à la fois,
avec son gabarit officiel (`Translate this from English to French: …`) et un
décodage glouton. Les sous-titres d'une même phrase sont d'abord regroupés
(jusqu'à la ponctuation finale, 4 lignes max) pour ne pas traduire des bouts
de phrase hors contexte, puis le français est réparti sur ces sous-titres au
prorata de l'anglais, en coupant entre deux mots. Le prompt système ne
s'applique pas à ce mode.

**Mode `chat` (LLM généraliste)** : un lot de 20 lignes tient dans ~2 000
jetons, le contexte par défaut d'Ollama suffit. Pour Qwen3, `/no_think` est
ajouté automatiquement.

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
