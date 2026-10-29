# BasketLand

Application web de replays NBA, conteneurisée pour Unraid : calendrier complet en heure de Paris, replays vidéo en streaming, statistiques de match et de joueurs, et **sous-titres français synchronisés** sur l'audio original de la vidéo.

> **Statut : en cours de construction.** La spécification technique complète et validée est dans [`docs/SPEC.md`](docs/SPEC.md).

## Ce que fait l'application

| Fonctionnalité | Détail |
|---|---|
| **Calendrier NBA** | Tous les matchs, à venir et terminés, regroupés par date et affichés en **heure de Paris** (Europe/Paris, gestion automatique de l'heure d'été). |
| **Replays** | Streaming HLS des matchs terminés, sans téléchargement, depuis les sources de replays publiques. |
| **Statistiques** | Bouton « Statistiques du match » actif **uniquement** quand le match est terminé : boxscore des deux équipes, lignes de chaque joueur (MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, ±), leaders du match. |
| **VF française synchronisée** | Sous-titres en français calés sur la vidéo, générés à partir du play-by-play et alignés sur l'audio original. Export WebVTT. Ajustement manuel du décalage possible. |
| **Pages équipe / classement** | Prochain match, derniers résultats et replays par équipe ; classement NBA. |

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

### 2. Ajouter le conteneur

Dans Unraid : **Docker → Add Container**

| Champ | Valeur |
|---|---|
| Name | `basketland` |
| Repository | `ghcr.io/r0m1k3/basketland` |
| Network Type | `bridge` |
| Port (HTTP) | `3000` |
| Variable d'environnement | `TZ` = `Europe/Paris` |
| Path / Volume | `/mnt/user/appdata/basketland` → `/data` |

Puis **Apply**. L'application est accessible sur `http://<IP-DU-NAS>:3000`.

> Si l'image est privée, ajouter dans les *Repository* le champ `Access Token` avec un token GitHub possédant le scope `read:packages`.

### 3. Alternative docker-compose

```yaml
services:
  basketland:
    image: ghcr.io/r0m1k3/basketland:latest
    container_name: basketland
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      TZ: Europe/Paris
    volumes:
      - /mnt/user/appdata/basketland:/data
```

## Développement local

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # build de production
npm test             # tests
```

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — spécification technique : sources de données, schéma SQL, routes API, format des données, critères d'acceptation.
