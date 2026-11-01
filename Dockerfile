# syntax=docker/dockerfile:1

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

# ---------------------------------------------------------------- Parakeet (NVIDIA)
# Second moteur de transcription, au choix dans les Paramètres : NVIDIA
# Parakeet TDT 0.6B v2 (anglais), exécuté par ONNX Runtime (bibliothèque
# onnx-asr) dans un environnement Python séparé — onnxruntime-gpu remplace le
# paquet onnxruntime (processeur) dont dépend faster-whisper. cuBLAS et cuDNN
# sont ceux de Whisper (liens symboliques, comme pour les voix) ; s'y ajoutent
# les seules bibliothèques CUDA qui leur manquent pour ONNX Runtime (cudart,
# curand, cufft). Le contrôle final charge les bibliothèques CUDA d'ONNX
# Runtime : un lien cassé fait échouer le build, pas la première traduction.
# Modèle téléchargé au premier usage dans /data/models/hf.
FROM whisper AS parakeet
RUN python3 -m venv /opt/parakeet \
 && /opt/parakeet/bin/pip install --no-cache-dir \
      "onnx-asr[hub]==0.12.0" onnxruntime-gpu==1.23.2 \
      nvidia-cuda-runtime-cu12==12.9.79 nvidia-cuda-nvrtc-cu12==12.9.86 nvidia-curand-cu12==10.3.10.19 \
      nvidia-cufft-cu12==11.4.1.4 \
 && SP="$(/opt/parakeet/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["platlib"])')" \
 && WSP="$(/opt/whisper/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["platlib"])')" \
 && ln -s "$WSP/nvidia/cublas" "$SP/nvidia/cublas" \
 && ln -s "$WSP/nvidia/cudnn" "$SP/nvidia/cudnn" \
 && /opt/parakeet/bin/python -c "import ctypes, os, onnxruntime as rt, onnx_asr; rt.preload_dlls(directory=''); ctypes.CDLL(os.path.join(os.path.dirname(rt.__file__), 'capi', 'libonnxruntime_providers_cuda.so')); p = rt.get_available_providers(); print('onnxruntime', rt.__version__, p); assert 'CUDAExecutionProvider' in p"

# ---------------------------------------------------------------- Fish Audio S2 Pro
# Voix au choix dans les Paramètres (« Voix du doublage » › Fish S2 Pro) :
# Fish Audio S2 Pro (5 milliards de paramètres) servi par vLLM-Omni
# (`vllm serve fishaudio/s2-pro --omni`), démarré par le doublage sur la carte
# graphique puis arrêté ; il clone les voix figées de assets/voices.
# Environnement séparé : vLLM impose ses propres torch et bibliothèques CUDA.
# Versions figées (vLLM-Omni 0.22 : moteur Fish S2 Pro avec clonage). Poids
# (~11 Go, Fish Audio Research License : usage non commercial) téléchargés au
# premier usage dans /data/models/hf.
FROM whisper AS omni
RUN python3 -m venv /opt/omni \
 && /opt/omni/bin/pip install --no-cache-dir vllm==0.22.0 vllm-omni==0.22.0 \
 && test -x /opt/omni/bin/vllm \
 && /opt/omni/bin/python -c "import importlib.metadata as m; print('vllm', m.version('vllm'), 'vllm-omni', m.version('vllm-omni'), 'torch', m.version('torch'))"

# ---------------------------------------------------------------- Voix
# Doublage en français : Qwen3-TTS (clonage des voix figées de assets/voices),
# SpeechBrain ECAPA (empreintes vocales des commentateurs) et le classifieur
# homme/femme de scripts/voice_gender.py (mêmes bibliothèques), dans un
# environnement Python séparé de Whisper (torch et transformers aux versions
# imposées par qwen-tts). Liste complète et figée dans
# scripts/voice-requirements.txt, installée sans résolution (--no-deps).
#
# cuBLAS et cuDNN ne sont pas installés une seconde fois : ceux de Whisper
# (/opt/whisper, mêmes versions majeures que celles attendues par torch 2.8)
# sont reliés par lien symbolique, que torch trouve par son RPATH
# ($ORIGIN/../../nvidia/<bibliothèque>/lib) : ~1,3 Go de moins.
# Le contrôle final charge torch avec ces bibliothèques (sans GPU, pas besoin
# du pilote) : un lien cassé ou un cuDNN incompatible fait échouer le build,
# pas le premier doublage.
FROM whisper AS tts
COPY scripts/voice-requirements.txt /tmp/voice-requirements.txt
RUN python3 -m venv /opt/tts \
 && /opt/tts/bin/pip install --no-cache-dir --no-deps -r /tmp/voice-requirements.txt \
 && SP="$(/opt/tts/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["platlib"])')" \
 && WSP="$(/opt/whisper/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["platlib"])')" \
 && ln -s "$WSP/nvidia/cublas" "$SP/nvidia/cublas" \
 && ln -s "$WSP/nvidia/cudnn" "$SP/nvidia/cudnn" \
 && /opt/tts/bin/python -c "import re, torch, torch.backends.cudnn as cudnn; v = cudnn.version(); libs = sorted(set(re.findall(r'\S+/lib(?:cublas|cudnn)\.so\.\d+', open('/proc/self/maps').read()))); print('torch', torch.__version__, 'CUDA', torch.version.cuda, 'cuDNN', v, libs); assert v and len(libs) == 2 and all(l.startswith('/opt/whisper/') for l in libs), libs" \
 && /opt/tts/bin/python -c "import torchaudio, soundfile, librosa, safetensors.torch, huggingface_hub, speechbrain.inference.speaker, qwen_tts" \
 && rm /tmp/voice-requirements.txt

# ---------------------------------------------------------------- runtime
# Debian seule (la base des images `node`, donc la même glibc et le même
# Python que les environnements /opt/whisper et /opt/tts construits plus haut).
FROM debian:bookworm-slim AS runner
WORKDIR /app

ENV TZ=Europe/Paris
ENV PORT=3012
# GPU NVIDIA visible du conteneur (avec --runtime=nvidia côté hôte).
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

# Utilisateur `node` (uid 1000) : le même que dans les images précédentes,
# basées sur l'image `node`, pour que les volumes /data existants (dont les
# fichiers appartiennent à 1000:1000) restent inscriptibles.
#
# ffmpeg extrait l'audio des replays (transcription des commentateurs) et les
# images du bandeau de score (positions des actions).
#
# `util-linux` fournit `setpriv`, utilisé par l'entrypoint pour lâcher les
# privilèges root après avoir rendu /data à l'utilisateur `node`. Sans ce
# paquet, l'entrypoint échoue et le conteneur ne démarre pas.
#
# `gcc`, `libc6-dev`, `python3-dev` : Fish S2 Pro (vLLM) compile au démarrage
# ses noyaux GPU avec Triton, qui a besoin d'un compilateur C et des en-têtes
# de Python (« Failed to find C compiler » sinon).
#
# `libtesseract5` : OCR natif du serveur Rust (analyse vidéo), avec le MÊME
# modèle de langue que tesseract.js (`eng.traineddata` 4.0.0_best_int de
# @tesseract.js-data/eng, copié plus bas) : pas de paquet tesseract-ocr-eng.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates util-linux python3 libtesseract5 tzdata \
      gcc libc6-dev python3-dev \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 node \
 && useradd --uid 1000 --gid node --create-home --home-dir /home/node --shell /bin/sh node
COPY --from=builder /app/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz /usr/share/basketland/tessdata/
RUN gunzip /usr/share/basketland/tessdata/eng.traineddata.gz
# Un seul fil OpenMP, comme tesseract.js (WASM) : l'analyse est une tâche de
# fond en priorité basse, elle ne doit pas occuper tous les cœurs du NAS.
ENV TESSDATA_PREFIX=/usr/share/basketland/tessdata
ENV OMP_THREAD_LIMIT=1

# Services embarqués de traduction des commentaires (voir src/lib/localAi.ts)
# et voix du doublage (src/lib/voiceAi.ts) : démarrés à la demande par
# l'application, jamais exposés hors du conteneur. Modèles téléchargés au
# premier usage dans /data/models (volume persistant), jamais dans l'image.
# /opt/tts dépend de /opt/whisper (liens symboliques vers cuBLAS et cuDNN).
COPY --from=ollama /ollama/bin/ollama /usr/bin/ollama
COPY --from=ollama /ollama/lib /usr/lib/ollama
COPY --from=whisper /opt/whisper /opt/whisper
COPY --from=tts /opt/tts /opt/tts
COPY --from=parakeet /opt/parakeet /opt/parakeet
COPY --from=omni /opt/omni /opt/omni
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

ENTRYPOINT ["docker-entrypoint.sh"]
# Le serveur Rust écoute sur PORT (3012) et sert tout : API, files médias,
# cron et interface (`BL_STATIC_DIR`). Plus de Node dans l'image.
CMD ["basketland-server"]
