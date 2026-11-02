# syntax=docker/dockerfile:1
#
# Image de l'application : serveur Rust, interface et scripts, posés sur
# l'image de BASE (Dockerfile.base : système, Ollama, Whisper, Qwen3-TTS…,
# plusieurs Go, reconstruite seulement quand elle change). Une mise à jour
# de l'application ne change que les dernières couches (~100 Mo).
# `BASE_IMAGE` : `…/basketland-base:lite` (défaut) ou `…:full` (Fish S2 Pro
# et Parakeet en plus) ; la CI passe l'étiquette exacte (empreinte).
ARG BASE_IMAGE=ghcr.io/r0m1k3/basketland-base:lite

# ---------------------------------------------------------------- interface
# Export statique de Next (`out/`) : pages en fichiers statiques, servies par
# le serveur Rust. Node ne sert qu'au build ; il n'est pas dans l'image finale.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- serveur Rust
# Serveur HTTP (server/) : API, files médias, cron et interface statique.
# Dépendances compilées dans une couche à part : un changement du code seul
# ne refait pas leur compilation.
#
# OCR du bandeau de score (analyse vidéo) : libtesseract 5 natif, lié par son
# API C (fonction cargo `ocr`, voir server/src/media/tesseract.rs).
FROM rust:1.96-slim-bookworm AS rust
RUN apt-get update \
 && apt-get install -y --no-install-recommends libtesseract-dev libleptonica-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && echo '' > src/lib.rs \
 && cargo build --release --locked --features ocr && rm -rf src
COPY server/src ./src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked --features ocr \
 && install -m 755 target/release/basketland-server /basketland-server

# ---------------------------------------------------------------- runtime
FROM ${BASE_IMAGE} AS runner
WORKDIR /app

ENV TZ=Europe/Paris
ENV PORT=3012
# GPU NVIDIA visible du conteneur (avec --runtime=nvidia côté hôte).
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
# Plusieurs cartes (p. ex. RTX 5060 Ti + RTX 3060) : numérotées dans l'ordre
# du bus PCI, comme `nvidia-smi` (CUDA met sinon « la plus rapide » en 0, et
# vLLM avertit d'un ordre ambigu), et TOUT le travail (Ollama, Whisper,
# Parakeet, voix, Fish S2 Pro) sur la carte 0 seulement. `CUDA_VISIBLE_DEVICES=1`
# choisit l'autre carte ; vide, toutes les cartes sont visibles.
ENV CUDA_DEVICE_ORDER=PCI_BUS_ID
ENV CUDA_VISIBLE_DEVICES=0
# Mémoire : deux zones d'allocation au plus par processus (serveur et
# workers Python) au lieu d'une par cœur et par fil — la glibc gardait sinon
# des centaines de Mo réservés et jamais rendus.
ENV MALLOC_ARENA_MAX=2

# OCR du bandeau de score : libtesseract5 (dans la base) avec le MÊME modèle
# de langue que tesseract.js (`eng.traineddata` 4.0.0_best_int).
COPY --from=builder /app/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz /usr/share/basketland/tessdata/
RUN gunzip /usr/share/basketland/tessdata/eng.traineddata.gz
# Un seul fil OpenMP, comme tesseract.js (WASM) : l'analyse est une tâche de
# fond en priorité basse, elle ne doit pas occuper tous les cœurs du NAS.
ENV TESSDATA_PREFIX=/usr/share/basketland/tessdata
ENV OMP_THREAD_LIMIT=1

# Services embarqués (Ollama, Whisper, voix) : dans l'image de base, démarrés
# à la demande, jamais exposés hors du conteneur. Modèles téléchargés au
# premier usage dans /data/models (volume persistant), jamais dans l'image.
COPY --from=rust /basketland-server /usr/local/bin/basketland-server

# Interface : export statique de Next, servi par le serveur Rust.
COPY --from=builder --chown=node:node /app/out ./out
ENV BL_STATIC_DIR=/app/out
COPY --chown=node:node scripts/whisper_worker.py scripts/parakeet_worker.py ./scripts/
COPY --chown=node:node scripts/voice_worker.py scripts/voice_gender.py ./scripts/
# Voix figées du doublage (WAV de référence + transcription + voice.json).
COPY --chown=node:node assets/voices ./assets/voices
# Récupération d'accès : docker exec -it basketland basketland-server reset-password <identifiant> <mot-de-passe>
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Version affichée en bas de la page Paramètres (commit et date de
# l'image, passés par la CI) : pour vérifier qu'un serveur tourne bien sur la
# dernière image. En fin d'étage : un nouveau commit ne refait aucune couche lourde.
ARG GIT_SHA=
ARG BUILD_DATE=
ENV APP_COMMIT=$GIT_SHA APP_BUILT_AT=$BUILD_DATE

# Pas de `USER node` ici : l'entrypoint démarre en root pour rendre le volume
# /data à `node` (le chown du build est perdu au montage), puis lâche les
# privilèges via setpriv avant de lancer le serveur.
EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["basketland-server", "health"]

# tini (PID 1) récupère les processus enfants terminés (workers, ffmpeg).
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
# Le serveur Rust écoute sur PORT (3012) et sert tout : API, files médias,
# cron et interface (`BL_STATIC_DIR`). Plus de Node dans l'image.
CMD ["basketland-server"]
