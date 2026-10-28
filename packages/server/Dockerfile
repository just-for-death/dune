# Dune server image — npm-workspaces aware.
# NOTE: `npm ci` only works from the repo root (single root lockfile);
# per-directory installs fail, so all install steps run at /build root.
# Build context is the repo root (see docker-compose.yml).

# ── Stage 1: Install + build TypeScript ─────────────────────────────────
FROM node:22-alpine AS backend-builder

WORKDIR /build

# .npmrc carries legacy-peer-deps (required for a clean install)
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN npm ci --ignore-scripts

# Shared first: server resolves its types through the file: symlink
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
RUN npm run build --workspace=@dune/shared

# Providers next: server imports @dune/providers (outbound integrations)
COPY packages/providers/tsconfig.json ./packages/providers/
COPY packages/providers/src ./packages/providers/src
RUN npm run build --workspace=@dune/providers

COPY packages/server/tsconfig.json ./packages/server/
COPY packages/server/src ./packages/server/src
RUN npm run build --workspace=@dune/server

# Drop devDependencies for the runtime image
RUN npm prune --omit=dev && npm cache clean --force

# ── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Security: upgrade + minimal tools (unzip/zip for save extraction, su-exec for user switching)
RUN apk update && apk upgrade --no-cache \
  && apk add --no-cache unzip zip tini su-exec \
  && rm -rf /var/cache/apk/*

# Non-root user for security
RUN addgroup -S dune && adduser -S dune -G dune

WORKDIR /app/backend

# Hoisted prod node_modules (all workspaces' prod deps; client deps ride
# along — harmless, single-user image; keeps COPY simple and robust)
COPY --from=backend-builder /build/node_modules ./node_modules

# Materialize the file: dependency (a symlink in the build stage that
# would otherwise dangle here)
RUN rm -rf ./node_modules/@dune/shared && mkdir -p ./node_modules/@dune/shared
COPY --from=backend-builder /build/packages/shared/dist ./node_modules/@dune/shared/dist
COPY --from=backend-builder /build/packages/shared/package.json ./node_modules/@dune/shared/package.json
RUN rm -rf ./node_modules/@dune/providers && mkdir -p ./node_modules/@dune/providers
COPY --from=backend-builder /build/packages/providers/dist ./node_modules/@dune/providers/dist
COPY --from=backend-builder /build/packages/providers/package.json ./node_modules/@dune/providers/package.json

# Built backend
COPY --from=backend-builder /build/packages/server/dist ./dist
COPY --from=backend-builder /build/packages/server/package.json ./

# Pre-built web dashboard (optional — API works without it)
COPY packages/server/frontend/dist ./frontend/dist

# Data directories (mounted as volumes in production)
RUN mkdir -p /app/backend/data/saves /app/backend/data/hltb-cache \
  && chown -R dune:dune /app/backend

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3030
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3030/ready || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
