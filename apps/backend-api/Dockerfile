# backend-api — Express + WebSocket voicebot engine.
#
# ffmpeg is installed at OS level because providers/audio.js and services/trainingData.js
# spawn it directly (resolveFfmpegPath falls back to the "ffmpeg" binary on PATH when the
# ffmpeg-static package is unavailable). The telephony hot path has a pure-JS PCM fallback,
# but recording/training-data conversion genuinely needs the binary.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# npm workspaces: the root manifest + lockfile drive installation for every app.
COPY package.json package-lock.json ./
COPY apps/backend-api/package.json apps/backend-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/worker/package.json apps/worker/package.json

# Install only this workspace's production deps.
RUN npm ci --omit=dev --workspace backend-api

COPY apps/backend-api ./apps/backend-api

WORKDIR /app/apps/backend-api
EXPOSE 4000

# Node's built-in fetch; exits non-zero on failure so Docker marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
