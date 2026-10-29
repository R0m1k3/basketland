# BasketLand

Application web de replays NBA, conteneurisée pour Unraid : calendrier complet en heure de Paris, replays vidéo en streaming, statistiques de match et de joueurs, et **sous-titres français synchronisés** sur l'audio original de la vidéo.

> **Statut : fonctionnel.** Calendrier, replays, statistiques et VF française sont opérationnels. La spécification technique complète et validée est dans [`docs/SPEC.md`](docs/SPEC.md).

## Ce que fait l'application

| Fonctionnalité | Détail |
|---|---|
| **Calendrier NBA** | Tous les matchs, à venir et terminés, regroupés par date et affichés en **heure de Paris** (Europe/Paris, gestion automatique de l'heure d'été). |
| **Replays** | Streaming HLS des matchs terminés, sans téléchargement, depuis les sources de replays publiques. |
| **Statistiques** | Bouton « Statistiques du match » actif **uniquement** quand le match est terminé : boxscore des deux équipes, lignes de chaque joueur (MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, ±), leaders du match. |
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

L'API GraphQL d'Unraid ne sait pas *créer* de conteneur (elle sait seulement démarrer/arrêter/redémarrer un conteneur existant). L'installation se fait donc dans l'interface web d'Unraid.

### 1. Image

L'image est construite automatiquement par GitHub Actions à chaque push sur `main` :

```
ghcr.io/r0m1k3/basketland:latest
```

L'image est **publique** : aucun jeton n'est nécessaire sur le NAS, Unraid la
tire directement. (Le dépôt GitHub et le paquet GHCR sont publics, comme les
autres dépôts et paquets du compte.)

### 2. Ajouter le conteneur

Dans Unraid : **Docker → Add Container**

| Champ | Valeur |
|---|---|
| Name | `basketland` |
| Repository | `ghcr.io/r0m1k3/basketland` |
| Repository : Access Token | *(vide — l'image est publique)* |
| Network Type | `bridge` |
| Port (HTTP) | `3000` |
| Variable d'environnement | `TZ` = `Europe/Paris` |
| Path / Volume | `/mnt/user/appdata/basketland` → `/data` |

Puis **Apply**. L'application est accessible sur `http://<IP-DU-NAS>:3000`.

### 3. Alternative docker-compose

```yaml
services:
  basketland:
    image: ghcr.io/r0m1k3/basketland:latest
    container_name: basketland
    restart: unless-stopped
    ports:
      - '3000:3000'
    environment:
      TZ: Europe/Paris
    volumes:
      - /mnt/user/appdata/basketland:/data
```

## Synchronisation des données

Les matchs, statistiques et replays sont récupérés par jobs. Le premier
lancement se fait manuellement :

```bash
# Dans le conteneur (ou via l'API d'ingestion)
curl -X POST http://localhost:3000/api/ingest \
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

Le replay coupe une trentaine de minutes de contenu : le décalage entre le
temps réel du match et la position dans la vidéo n'est donc pas uniforme.
L'application le calcule en trois temps :

1. **Ancres** — le chrono de jeu affiché à l'écran est lu par OCR
   (`tesseract.js`, sans dépendance système) et recoupé avec le play-by-play
   ESPN. C'est ce qui donne les points de calage `(période, chrono) → position
   vidéo`.
2. **Interpolation** — entre deux ancres, le temps de jeu avance à vitesse
   réelle, les temps morts sont comprimés.
3. **Réglage manuel** — décalage global et décalage par quart, persistés.

Dans la fiche d'un match, le bouton **« Calibrer la synchronisation »** permet
de lancer l'analyse, de recaler un quart précis et de poser une ancre
manuellement (en cliquant sur la ligne de VF qui passe à l'instant).

> L'analyse automatique nécessite `ffmpeg`, présent dans l'image Docker. Sans
> lui, l'application reste fonctionnelle : les sous-titres sont générés et
> positionnés à partir d'une estimation, et le réglage manuel prend le relais.

| Variable | Défaut | Rôle |
|---|---|---|
| `INGEST_TOKEN` | généré dans `/data/ingest_token` | Jeton d'accès à `POST /api/ingest` et aux jobs de synchronisation. |
| `SYNC_WRITE_ORIGINS` | vide (toute origine acceptée) | Origines ou IP autorisées à modifier la calibration depuis le navigateur, séparées par des virgules (ex. `192.168.1.16,http://nas.local:3000`). Vide = non restreint, adapté à un usage sur le LAN. |
| `ANALYSIS_MIN_INTERVAL_MS` | `900000` (15 min) | Délai minimum entre deux analyses automatiques d'un même match. Une analyse coûte 5 à 8 min de CPU : ce garde-fou évite de saturer le NAS. |
| `ANALYSIS_MAX_PARALLEL` | `1` | Nombre d'analyses simultanées. |
| `OCR_DISABLED` | — | `1` désactive la phase OCR. |
| `OCR_STEP_SEC` | `60` | Pas de balayage du chrono à l'écran (plus petit = plus précis, plus lent). |
| `FFMPEG_PATH` | `ffmpeg` | Chemin du binaire ffmpeg. |
| `DISABLE_CRON` | — | `1` désactive les jobs internes. |

## Développement local

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # build de production
npm run typecheck    # vérification TypeScript
npm test             # 137 tests (dont 32 sur captures réelles)
```

Le build utilise `output: 'standalone'` (comme l'image Docker). Le serveur
standalone est donc lancé par `npm start` — et **il exige `HOSTNAME=0.0.0.0`**,
sans quoi il écoute sur le nom d'hôte de la machine au lieu de toutes les
interfaces :

```bash
npm run build
HOSTNAME=0.0.0.0 npm start
```

`npm run start:next` lance `next start` (non compatible avec `standalone` :
Next.js le signale à chaque démarrage).

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — spécification technique : sources de données, schéma SQL, routes API, format des données, critères d'acceptation.
