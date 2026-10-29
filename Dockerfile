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

# `node:sqlite` est intégré à Node 22 : aucune compilation native, aucun
# toolchain dans l'image finale. C'est le choix qui garde l'image slim.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs basketland

# ffmpeg sert uniquement à l'analyse audio (détection des coupures) pour
# calibrer la synchronisation des sous-titres. Il est optionnel : l'appli
# fonctionne sans, et l'utilisateur peut recaler la VF à la main.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=nodejs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nodejs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nodejs:nodejs /app/public ./public
RUN mkdir -p /data && chown nodejs:nodejs /data
VOLUME ["/data"]

USER nodejs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
