# worker — BullMQ consumer that dispatches outbound calls.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/backend-api/package.json apps/backend-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN npm ci --omit=dev --workspace worker

COPY apps/worker ./apps/worker

WORKDIR /app/apps/worker

# Matches WORKER_HEALTH_PORT in src/index.js (default 4001).
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
