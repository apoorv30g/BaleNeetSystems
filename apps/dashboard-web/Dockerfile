# dashboard-web — Next.js 14 app router.
#
# IMPORTANT: NEXT_PUBLIC_API_BASE_URL is read by lib/api.js and, because of the NEXT_PUBLIC_
# prefix, is inlined into the client bundle at BUILD time -- not read at runtime. It must be
# passed as a build arg, and changing it requires a rebuild, not just a restart.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend-api/package.json apps/backend-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/worker/package.json apps/worker/package.json

# Dev deps (tailwind/postcss/autoprefixer) are required for the build.
RUN npm ci --workspace dashboard-web

COPY apps/dashboard-web ./apps/dashboard-web

ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/dashboard-web
RUN npm run build


FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY apps/backend-api/package.json apps/backend-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN npm ci --omit=dev --workspace dashboard-web

COPY --from=builder /app/apps/dashboard-web/.next ./apps/dashboard-web/.next
COPY apps/dashboard-web/next.config.js ./apps/dashboard-web/next.config.js

WORKDIR /app/apps/dashboard-web
EXPOSE 3000

CMD ["npm", "run", "start"]
