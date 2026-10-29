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
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# L'image officielle `node` fournit déjà l'utilisateur `node` (uid 1000) :
# on l'utilise plutôt que d'en créer un — `chown user:group` exige que le
# premier soit bien un utilisateur, sinon chown échoue.
#
# ffmpeg sert uniquement à l'analyse audio (détection des coupures) pour
# calibrer la synchronisation des sous-titres. Il est optionnel : l'appli
# fonctionne sans, et l'utilisateur peut recaler la VF à la main.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
