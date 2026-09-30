# ── Stage 1: Build shared + backend TypeScript ──────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /build

# Shared package first (server depends on its types)
COPY packages/shared/package*.json ./packages/shared/
RUN cd packages/shared && npm ci --ignore-scripts

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
RUN cd packages/shared && npx tsc

# Server (uses workspace shared via file: link — install with shared built)
COPY packages/server/package*.json ./packages/server/
RUN cd packages/server && npm ci --ignore-scripts

COPY packages/server/tsconfig.json ./packages/server/
COPY packages/server/src ./packages/server/src
RUN cd packages/server && npx tsc

# ── Stage 2: Production dependencies ────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app/backend

COPY packages/server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Stage 3: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: upgrade + minimal tools (unzip/zip for save extraction)
RUN apk update && apk upgrade --no-cache \
  && apk add --no-cache unzip zip tini \
  && rm -rf /var/cache/apk/*

# Non-root user for security
RUN addgroup -S dune && adduser -S dune -G dune

WORKDIR /app/backend

# Copy production node_modules
COPY --from=deps /app/backend/node_modules ./node_modules

# Copy built backend
COPY --from=backend-builder /build/packages/server/dist ./dist
COPY packages/server/package.json ./

# Copy pre-built web dashboard (optional — API works without it)
COPY packages/server/frontend/dist ./frontend/dist

# Data directories (mounted as volumes in production)
RUN mkdir -p /app/backend/data/saves /app/backend/data/hltb-cache \
  && chown -R dune:dune /app/backend

USER dune

ENV NODE_ENV=production
ENV PORT=3030
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3030/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
