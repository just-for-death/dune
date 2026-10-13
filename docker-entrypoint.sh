#!/bin/sh
# Entrypoint script to fix permissions at runtime
set -e

# Fix permissions on data directory (mounted at runtime)
mkdir -p /app/backend/data/saves /app/backend/data/hltb-cache
chown -R dune:dune /app/backend/data

# Drop to dune user
exec /sbin/tini -- su-exec dune node dist/server.js