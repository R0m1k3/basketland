# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Europe/Paris
ENV PORT=3012
ENV HOSTNAME=0.0.0.0

# L'image officielle `node` fournit déjà l'utilisateur `node` (uid 1000) :
# on l'utilise plutôt que d'en créer un — `chown user:group` exige que le
# premier soit bien un utilisateur, sinon chown échoue.
#
# ffmpeg sert uniquement à l'analyse audio (détection des coupures) pour
# calibrer la synchronisation des sous-titres. Il est optionnel : l'appli
# fonctionne sans, et l'utilisateur peut recaler la VF à la main.
#
# `util-linux` fournit `setpriv`, utilisé par l'entrypoint pour lâcher les
# privilèges root après avoir rendu /data à l'utilisateur `node`.
# ATTENTION : `setpriv` n'est PAS présent dans node:22-bookworm-slim (ni
# `su`, ni `runuser`) — vérifié en inspectant la couche système de l'image
# officielle. Sans ce paquet, l'entrypoint échoue au démarrage et le
# conteneur ne démarre pas du tout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
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
