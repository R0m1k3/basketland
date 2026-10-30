# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- Ollama
# Traduction des commentaires : binaire Ollama et ses bibliothèques (CUDA
# comprise) repris de l'image officielle, version figée. Le binaire est
# compilé pour une glibc ancienne : il tourne tel quel sur Debian bookworm.
# Les variantes AMD (ROCm) et Vulkan, inutiles avec une carte NVIDIA, sont
# retirées dans un étage intermédiaire pour ne pas alourdir l'image.
FROM ollama/ollama:0.40.5 AS ollama-src
FROM debian:bookworm-slim AS ollama
COPY --from=ollama-src /usr/bin/ollama /ollama/bin/ollama
COPY --from=ollama-src /usr/lib/ollama /ollama/lib
RUN find /ollama/lib -mindepth 1 -maxdepth 1 \( -iname 'rocm*' -o -iname 'vulkan*' \) -exec rm -rf {} +

# ---------------------------------------------------------------- Whisper
# Transcription des commentaires : faster-whisper (CTranslate2) dans un
# environnement Python dédié, avec cuBLAS et cuDNN installés par pip — pas
# besoin d'image CUDA de base, le pilote est fourni par l'hôte (runtime
# NVIDIA). Versions figées : PyAV 18+ casse faster-whisper 1.2.1
# (« open() got an unexpected keyword argument 'metadata_errors' »).
FROM node:22-bookworm-slim AS whisper
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/whisper \
 && /opt/whisper/bin/pip install --no-cache-dir \
      faster-whisper==1.2.1 ctranslate2==4.8.2 av==17.1.0 \
      nvidia-cublas-cu12==12.9.2.10 nvidia-cudnn-cu12==9.26.1.1

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Europe/Paris
ENV PORT=3012
ENV HOSTNAME=0.0.0.0
# GPU NVIDIA visible du conteneur (avec --runtime=nvidia côté hôte).
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

# L'image officielle `node` fournit déjà l'utilisateur `node` (uid 1000) :
# on l'utilise plutôt que d'en créer un — `chown user:group` exige que le
# premier soit bien un utilisateur, sinon chown échoue.
#
# ffmpeg extrait l'audio des replays (transcription des commentateurs) et les
# images du bandeau de score (positions des actions).
#
# `util-linux` fournit `setpriv`, utilisé par l'entrypoint pour lâcher les
# privilèges root après avoir rendu /data à l'utilisateur `node`.
# ATTENTION : `setpriv` n'est PAS présent dans node:22-bookworm-slim (ni
# `su`, ni `runuser`) — vérifié en inspectant la couche système de l'image
# officielle. Sans ce paquet, l'entrypoint échoue au démarrage et le
# conteneur ne démarre pas du tout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates util-linux python3 \
 && rm -rf /var/lib/apt/lists/*

# Services embarqués de traduction des commentaires (voir src/lib/localAi.ts) :
# démarrés à la demande par l'application, jamais exposés hors du conteneur.
# Modèles téléchargés au premier usage dans /data/models (volume persistant).
COPY --from=ollama /ollama/bin/ollama /usr/bin/ollama
COPY --from=ollama /ollama/lib /usr/lib/ollama
COPY --from=whisper /opt/whisper /opt/whisper

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node scripts/whisper_worker.py ./scripts/whisper_worker.py
# Récupération d'accès : docker exec -it basketland node scripts/reset-password.mjs <identifiant> <mot-de-passe>
COPY --chown=node:node scripts/reset-password.mjs ./scripts/reset-password.mjs
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Pas de `USER node` ici : l'entrypoint démarre en root pour rendre le volume
# /data à `node` (le chown du build est perdu au montage), puis lâche les
# privilèges via setpriv avant de lancer le serveur.
EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3012)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
