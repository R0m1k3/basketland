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
| 4 | Proxy vidéo ok.ru : résolution du flux, playlists, segments, MP4 (le plus gros trafic) | à faire |
| 5 | Synchronisation ESPN et basketball-video, cron interne, `/api/ingest` | à faire |
| 6 | Sous-titres et file de traduction (Whisper, Ollama/MiniMax, ffmpeg), `/api/activity`, `/api/admin/settings` | à faire |
| 7 | Doublage (voix Qwen3-TTS / MiniMax) et OCR du bandeau de score | à faire |
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

Si Node s'arrête, le serveur Rust s'arrête aussi (le conteneur redémarre le
tout) ; un arrêt du serveur, même brutal, arrête Node.
