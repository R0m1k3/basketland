# BasketLand — Spécification technique

Application web conteneurisée sur Unraid : replays NBA, calendrier complet, statistiques, et sous-titres français synchronisés sur l'audio original.

## Décisions validées

| Sujet | Choix | Raison |
|---|---|---|
| Déploiement | Image Docker construite par GitHub Actions, poussée sur GHCR (`ghcr.io/r0m1k3/basketland`), installée dans l'UI Unraid | L'API Unraid ne sait pas créer de conteneur ; pas de Docker local dans l'environnement de dev |
| Voix | **Audio original de la vidéo + texte français synchronisé** (sous-titres) | Pas de TTS, pas de latence, coût zéro |
| Base de données | SQLite local (volume `/data`) | Mono-conteneur, pas de service externe à maintenir |
| Langue de l'UI | Français | Utilisateur francophone |
| Fuseau horaire | `Europe/Paris` pour tous les horaires affichés | Exigence utilisateur |
| Stack | Next.js 15 (App Router) + TypeScript + Tailwind + `node:sqlite` | Standard, build Docker simple avec `output: 'standalone'` |

## Sources de données (validées par tests réels)

### 1. Matchs, stats, play-by-play — API ESPN (gratuite, sans clé)

Base : `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/`

| Besoin | Endpoint | Constat |
|---|---|---|
| Calendrier saison | `scoreboard?dates=2026&limit=1000` | 1000 matchs, dates UTC |
| Matchs du jour | `scoreboard?dates=20261030&limit=50` | MATCH à venir + statut live (période, chrono) |
| Stats match | `summary?event=<id>` | Boxscore équipe + joueurs (MIN/PTS/FG/3PT/FT/REB/AST/TO/STL/BLK/OREB/DREB/PF/±), leaders, 464-511 événements play-by-play |
| Classement | `apis/v2/sports/basketball/nba/standings?season=2026` | 200 OK |
| Effectif | `teams/<abbr>/roster` | 200 OK |
| Stats joueur | `apis/common/v3/sports/basketball/nba/athletes/<id>/stats` | 200 OK |

Champs critiques du play-by-play : `wallclock` (heure UTC réelle de chaque action), `clock.displayValue` (chrono de jeu), `period.number`, `text`, `awayScore`, `homeScore`, `scoringPlay`, `participants`.

**`wallclock` est la clé de la synchronisation** : c'est l'horodatage réel du monde, indépendant de la vidéo.

### 2. Replays — basketball-video.com → ok.ru → HLS

Chaîne validée bout en bout (HTTP pur, pas de navigateur nécessaire) :

```
1. GET https://basketball-video.com/<slug-match>
   → parse HTML : blocs "Server #N (LABEL)" suivis d'un lien <a href>
2. GET <lien du Server #1>
   → parse HTML : <iframe src="//ok.ru/videoembed/<id>">
   → PREMIER iframe = la bonne vidéo (vérifié visuellement sur 3 matchs)
3. GET https://ok.ru/videoembed/<id>
   → JSON embarqué : "duration" (secondes), "poster", et URL m3u8 signée
   → m3u8 : https://ok6-29.vkuser.net/video.m3u8?cmd=videoPlayerCdn&expires=...&sig=...
4. GET <m3u8 maître>
   → 6 variantes : mobile 256x144, lowest 426x240, low 640x360,
     sd 852x480, hd 1280x720, full 1920x1080
   → chaque variante donne une playlist de segments .ts (1339 segments pour 8033 s)
```

Points d'attention :
- **L'URL m3u8 est signée et expire** (`expires=`). Il faut la résoudre à la demande, pas la stocker. Le proxy vidéo doit ré-résoudre le m3u8 quand un client le demande.
- **Les segments .ts sont servis par un autre host** que le m3u8 (`ok6-29.vkuser.net` → chemin `/expires/.../sig/.../video/MEDIUM00000.ts`). Le proxy doit réécrire les URLs des playlists pour pointer vers lui-même.
- Le `Referer: https://ok.ru/` est nécessaire pour télécharger les segments.
- Durée typique observée : 8033 s (2 h 14) = match complet + pré/post-game.
- Les vidéos commencent par un contenu promo (ex. teaser NBA sur NBC) avant le match.

### 3. Le problème de synchronisation (CONTRAINTE MAJEURE)

Mesures réelles sur le match Portland @ Lakers du 27/10/2026 (ESPN event `401909880`) :

```
Durée vidéo                : 8033 s  (2 h 13 min)
Span réel du match (wallclock ESPN, tipoff → end of game) : 9826 s (2 h 43 min)
ÉCART                       : -1793 s  (~30 minutes de contenu ABSENT de la vidéo)
```

**Les replays coupent une partie du contenu (pubs, temps morts, transitions) : la durée varie selon la diffusion. certaines coupent les timeouts, d'autres non.**

Décision d'architecture : **ne PAS tenter de mapping linéaire wallclock → vidéo.**

À la place, aligner sur des **ancres d'événements** :
1. L'ESPN fournit, pour chaque action, `clock.displayValue` + `period.number` + `wallclock`.
2. Extraire de la vidéo les instants où le **chrono de jeu à l'écran** change de période (le scoreboard est visible sur certaines frames).
3. Construire une table d'ancres : `(period, clock) → video_ts`.
4. Pour chaque action ESPN, interpoler entre les ancres voisines pour obtenir `video_ts`.

Implémentation pragmatique et robuste retenue :
- **Phase A (automatique, obligatoire)** : détecter l'offset de démarrage en comparant le chrono de jeu affiché à l'écran avec le chrono ESPN.
- **Phase B (robuste, implémentée)** : utiliser l'**énergie audio** pour repérer les coupures. Les commentaires et la foule ont un niveau sonore élevé et continu pendant le jeu ; les coupures publicitaires ont un niveau très bas / silence. Le profil RMS de l'audio donne les frontières.
- **Phase C (interface utilisateur, obligatoire)** : permettre un **ajustement manuel de l'offset** (± un offset global et un décalage par quart) stocké en base. C'est la garantie que l'utilisateur peut toujours recaler sa VF, même si l'auto-détection se trompe sur un match particulier.

Cibles de précision : ± 2 s sur l'auto-alignement, et l'ajustement manuel doit permettre n'importe quelle correction.

## Modèle de données (SQLite)

```sql
-- Matchs
CREATE TABLE matches (
  id INTEGER PRIMARY KEY,          -- event id ESPN
  espn_id TEXT UNIQUE NOT NULL,
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,       -- 'regular', 'post', 'preseason'
  date_utc TEXT NOT NULL,          -- ISO 8601 UTC
  home_abbr TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_abbr TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL,            -- 'scheduled' | 'live' | 'final'
  period INTEGER DEFAULT 0,
  clock_display TEXT DEFAULT '',
  venue TEXT DEFAULT '',
  broadcast TEXT DEFAULT '',
  slug TEXT,                       -- slug basketball-video.com
  video_ok_id TEXT,                -- id ok.ru
  video_duration INTEGER,          -- secondes
  video_available INTEGER DEFAULT 0,
  video_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_matches_date ON matches(date_utc);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_video ON matches(video_available);

-- Statistiques joueur par match
CREATE TABLE player_stats (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_abbr TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  position TEXT DEFAULT '',
  jersey TEXT DEFAULT '',
  starter INTEGER DEFAULT 0,
  stats_json TEXT NOT NULL,        -- {MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, "+/-"}
  PRIMARY KEY (match_id, player_id)
);

-- Statistiques équipe par match
CREATE TABLE team_stats (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_abbr TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (match_id, team_abbr)
);

-- Actions (play-by-play) pour la VF synchronisée
CREATE TABLE plays (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  period INTEGER NOT NULL,
  clock_display TEXT NOT NULL,
  clock_sec INTEGER NOT NULL,      -- secondes restantes dans le quart
  wallclock TEXT NOT NULL,
  event_type TEXT NOT NULL,
  text_en TEXT NOT NULL,
  actor TEXT DEFAULT '',
  team_abbr TEXT DEFAULT '',
  home_score INTEGER,
  away_score INTEGER,
  scoring INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0,        -- panier, timeout, changement de quart, fin de match
  PRIMARY KEY (match_id, seq)
);

-- Sous-titres français (générés + synchronisés)
CREATE TABLE subtitles (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  video_ts REAL NOT NULL,          -- position en secondes dans la vidéo
  end_ts REAL,
  text_fr TEXT NOT NULL,
  speaker TEXT DEFAULT '',
  kind TEXT DEFAULT 'action',      -- 'action' | 'banniere' | 'score'
  PRIMARY KEY (match_id, seq)
);

-- Ancrages de synchronisation (video_ts ↔ chrono de jeu)
CREATE TABLE sync_anchors (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  period INTEGER NOT NULL,
  clock_sec INTEGER NOT NULL,
  video_ts REAL NOT NULL,
  method TEXT DEFAULT 'manual',    -- 'auto' | 'manual' | 'audio'
  PRIMARY KEY (match_id, period, clock_sec)
);

-- Réglages par match (offset global, décalages)
CREATE TABLE sync_settings (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  global_offset REAL NOT NULL DEFAULT 0,
  quarter_offsets_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Journal d'ingestion
CREATE TABLE ingest_log (
  id INTEGER PRIMARY KEY,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER DEFAULT 0,
  detail TEXT DEFAULT ''
);
```

## Backend (routes API Next.js)

| Route | Méthode | Rôle |
|---|---|---|
| `/api/matches` | GET | Liste paginée + filtres (`?status=final&season=2026&team=LAL&limit=50&offset=0`) |
| `/api/matches/[id]` | GET | Détail d'un match (équipes, score, statut, disponibil vidéo) |
| `/api/matches/[id]/stats` | GET | Stats équipe + joueurs (renvoie `available: false` si match non terminé) |
| `/api/matches/[id]/subtitles` | GET | Sous-titres FR avec `video_ts` |
| `/api/matches/[id]/sync` | GET/POST | Lit / écrit les ancrages et l'offset manuel |
| `/api/schedule` | GET | Calendrier : matchs à venir + récents, groupés par date **Europe/Paris** |
| `/api/video/[okId]/master.m3u8` | GET | Proxy : ré-résout le m3u8 ok.ru (les signatures expirent) et réécrit les URLs de variantes vers le proxy |
| `/api/video/[okId]/playlist.m3u8` | GET | Proxy : réécrit les URLs de segments vers le proxy |
| `/api/video/[okId]/segment.ts` | GET | Proxy : stream un segment .ts depuis ok.ru (avec `Referer: https://ok.ru/`) |
| `/api/ingest` | POST | Lance une synchronisation (matchs, stats, actions) — protégé, appelé par cron interne |
| `/api/health` | GET | Sonde de santé (DB accessible, dernière synchro) |

### Proxy vidéo — points critiques

1. L'URL m3u8 expire (`expires=` timestamp). Chaque requête `master.m3u8` doit **re-résoudre** l'embed ok.ru pour obtenir une URL signée fraîche, puis la fetcher.

   *Implémentation réelle* : la résolution est **mise en cache en mémoire** (45 s, et jamais si l'URL expire dans moins de 60 s). Re-résoudre à chaque requête amplifiait le trafic vers ok.ru et le risque de bannissement d'IP ; le cache garantit que l'URL servie n'est jamais expirée.
2. La playlist maître contient des chemins **absolus** vers un host de segments différent. Il faut les réécrire vers `/api/video/[okId]/playlist.m3u8?...`.
3. La playlist média contient des chemins **relatifs** (`MEDIUM00000.ts`). Il faut les résoudre et les réécrire vers `/api/video/[okId]/segment.ts?...`.
4. Le proxy doit supporter les requêtes **Range** pour permettre le seeking.
5. Un cache court (30-60 s) sur la résolution du m3u8 évite de re-résoudre à chaque segment.

Implémentation suggérée : une fonction `resolveOkStream(okId)` qui retourne `{ masterUrl, expiresAt, variants[] }`, un cache mémoire en module scope, et un helper `rewritePlaylist()`.

## Scraping basketball-video.com

- Liste des matchs : pages `/2026-27`, `/2025-26`, ... avec pagination `?pageN`. Extraire les liens `<a href>` contenant `-vs-` et `nba-full-game-replay`.
- Page d'un match : bloc `Server #1 (...)` → premier `<a href>` → page cible → premier `<iframe src="//ok.ru/videoembed/<id>">`.
- **Règle validée : le PREMIER iframe ok.ru de la page cible est le bon match** (vérifié visuellement sur Portland-Lakers, Kings-Spurs, Nets-Celtics).
- Stocker `video_ok_id` + `video_duration`. La durée permet de distinguer un match complet (>1 h) d'un teaser.
- User-Agent navigateur obligatoire, rate-limiting (1 requête / 2 s) pour ne pas se faire bloquer.

## Génération de la VF française

Source : `plays.text` (anglais) + contexte (joueur, équipe, score, période, chrono).

Règles de traduction basketball (français) :
- Actions : `makes` → « marque », `misses` → « rate », `rebound` → « rebond », `assist` → « passe decisive », `steal` → « interception », `block` → « contre », `turnover` → « perte de balle », `dunk` → « dunk », `layup` → « lay-up », `jump shot` → « shoot », `three point` → « à trois points », `free throw` → « lancer franc », `technical foul` → « faute technique », `timeout` → « temps mort ».
- `Start/End of Period` → « Début/Fin du Xe quart ».
- `End of Game` → « Fin du match ».
- Conserver les noms de joueurs **en anglais** (usage français courant) ou les translittérer ? **Garder l'orthographe originale** — c'est la norme en France pour les joueurs NBA.
- Les scores sont déjà dans les données ESPN ; ne pas les redire en double.

La VF doit rester **courte** (une ligne par action notable) : les actions à 3 points, dunks, paniers, fautes importantes, temps morts, changements de quart, fins de match. Toutes les 464 actions ne sont pas necessarily sous-titrées — sinon c'est illisible. Cible : 120-180 sous-titres par match.

**Important** : la VF est **générée par le modèle qui rédige**, pas par un appel LLM à l'exécution. Le contenu doit être produit à l'ingestion et stocké en base. L'implémentation doit donc inclure un générateur de VF déterministe (basé sur des règles/templates) qui produit un français correct à partir des données ESPN, sans dépendance à une API LLM au runtime. C'est ce qui rend le conteneur autonome.

## Interface (pages)

1. **`/` — Accueil** : hero simple, matchs du jour en cours, prochains matchs, derniers replays disponibles.
2. **`/matchs`** — liste complète : filtres par équipe / statut / saison, pagination, **groupement par date en Europe/Paris**.
3. **`/matchs/[id]`** — fiche match :
   - Bandeau : équipes, score, statut, date **heure de Paris**, salle, diffusion TV.
   - Lecteur vidéo HLS (hls.js) si replay disponible, sinon message « replay en attente ».
   - **Panneau de sous-titres français synchronisé** : la ligne active s'affiche sur la vidéo ; lecture/pause synchronisée ; la VF défile avec la vidéo.
   - **Bouton « Statistiques du match »** : actif uniquement si le match est terminé ; ouvre un panneau avec boxscore équipe + joueurs.
   - Si le match est en cours : score live + période + chrono rafraîchis.
4. **`/equipes/[abbr]`** — page équipe : prochain match, derniers résultats, replays.
5. **`/classement`** — classement NBA.

### Lecteur + sous-titres synchronisés

- hls.js chargé côté client.
- Le lecteur expose `currentTime`. Un composant React sous-titre écoute `timeupdate` et affiche la sous-titre dont `video_ts <= currentTime <= end_ts`.
- Contrôle : un bouton « décaler la VF » permet un ajustement fin (± 0,5 s) et la valeur est persistée côté serveur (table `sync_settings`).
- Sous-titres exportables en **WebVTT** (`/api/matches/[id]/subtitles.vtt`) — utile et standard.

## Synchronisation (cron interne)

À l'intérieur du conteneur, un cron (node-cron ou setInterval) ou un job externe :

| Job | Fréquence | Action |
|---|---|---|
| `sync-schedule` | toutes les 15 min | Rafraîchir les matchs des 7 derniers jours + les 7 prochains jours |
| `sync-stats` | après chaque match | Récupérer boxscore + actions quand `status = final` |
| `sync-videos` | toutes les 2 h | Scanner les matchs terminés sans vidéo → scraper basketball-video.com |
| `sync-subtitles` | après `sync-stats` | Générer la VF française + calculer les `video_ts` |

Le scraping vidéo ne doit pas bloquer le refresh du calendrier : tasks séparées, erreurs isolées.

## Déploiement

### Dockerfile
- Stage 1 : build Next.js (`npm ci && npm run build`), `output: 'standalone'`.
- Stage 2 : image runtime `node:22-bookworm-slim` (avec `ffmpeg` installé — le slim
  officiel ne le contient pas).
- **Base de données : `node:sqlite`** (module intégré à Node depuis 22.13), **pas
  `better-sqlite3`**. Décision arrêtée pendant l'implémentation : aucune dépendance
  native, donc aucune toolchain de compilation (`python3`, `make`, `g++`) dans le
  runtime, et le `node:sqlite` émet un simple avertissement d'API expérimentale.
- Utilisateur : `node` (uid 1000) de l'image officielle. Ne pas créer d'utilisateur
  custom — sur Debian, `chown nodejs:nodejs` échoue si `nodejs` n'existe que comme
  groupe.
- Volume : `/data` → SQLite + cache + jeton d'ingestion.
- Port : `3000` (web). Le healthcheck interroge `/api/health` sur le même port
  (`node -e "fetch(...)"`, pas de `curl` dans l'image slim).
- Le serveur standalone **exige `HOSTNAME=0.0.0.0`** : sans lui il écoute sur le nom
  d'hôte de la machine au lieu de toutes les interfaces.
- `HEALTHCHECK` sur `/api/health`.
- User non-root.
- `.dockerignore` : `node_modules`, `.next`, `.git`, `data`.

### GitHub Actions (`.github/workflows/docker.yml`)
Reprendre le modèle de `R0m1k3/LogiFlow/.github/workflows/docker-build.yml` :
- `on: push` sur `main` + `tags: v*`
- `permissions: contents: read, packages: write`
- login GHCR avec `secrets.GITHUB_TOKEN`
- `docker/metadata-action@v5` (tags `latest`, `sha`, `v*`)
- `docker/setup-buildx-action@v3` + `docker/build-push-action@v5`
- cache GHA (`cache-from: type=gha`, `cache-to: type=gha,mode=max`)

L'image doit être **privée** ou publique selon ce que GitHub Actions autorise — le token `GITHUB_TOKEN` peut pousser vers GHCR pour le dépôt propriétaire. Les packages existants de R0m1k3 sont publics.

### Installation Unraid (à documenter dans README)

```
Image       : ghcr.io/r0m1k3/basketland:latest
Ports       : 3000:3000
Variables   : TZ=Europe/Paris
Volumes     : /mnt/user/appdata/basketland:/data
```

L'API Unraid ne permet pas de créer de conteneur → l'installation se fait dans l'UI Unraid (Docker → Add Container). Fournir aussi un `docker-compose.yml` équivalent.

## Contraintes de l'environnement

- Node 22, npm 10 disponibles pour le build local.
- Pas de Docker local dans l'environnement de dev → le build se fait via GitHub Actions. **Le code doit donc compiler et passer ses tests localement** (`npm run build`, `npm test`) avant push.
- Python 3.14 sans `requests` ; `uv` disponible. Le scraping peut être fait en TypeScript (pas de dépendance supplémentaire) — **préférence : tout en TypeScript** pour un conteneur mono-image sans Python.

## Critères d'acceptation

1. `npm run build` passe sans erreur.
2. Les tests couvrent : parsing play-by-play ESPN, parsing blocs « Server #N », réécriture de playlist HLS, génération de VF française, calcul des `video_ts` (interpolation d'ancres).
3. `/api/matches` renvoie les matchs du jour et les à venir avec l'heure **Europe/Paris** correcte (fuseau en October = UTC+1).
4. `/api/matches/[id]/stats` renvoie `available: false` tant que le match n'est pas terminé, puis les vraies stats joueurs.
5. `/api/matches/[id]/subtitles` renvoie des sous-titres FR triés par `video_ts`.
6. Le proxy `/api/video/[okId]/master.m3u8` renvoie une playlist HLS valide dont les URLs pointent vers le proxy (testable sans navigateur).
7. Le proxy `/api/video/[okId]/segment.ts` renvoie des octets TS (magic `0x47`) pour un segment référencé par la playlist.
8. L'UI affiche un bouton « Statistiques » qui n'est actif que sur match terminé.
9. Le Dockerfile build une image qui démarre et répond sur `/api/health`.
10. Le workflow GitHub Actions construit et pousse l'image sur GHCR.

## Hors périmètre (v1)

- Enregistrement personnel de l'utilisateur en français (mentionné par le produit, « on verra plus tard ») → prévoir une table `user_clips` et une route `/api/matches/[id]/clips` pour ne pas fermer la porte.
- WNBA (basketball-video.com en propose) → le code ESPN est générique par ligue, prévoir un paramètre `league` dans les tables.
- Traduction automatique via LLM.
- Téléchargement hors-ligne des replays.
