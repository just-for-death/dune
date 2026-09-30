#!/usr/bin/env bash
# Dune monorepo — build, test, deploy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

cmd="${1:-help}"

case "$cmd" in
  install)
    echo "==> Installing workspace dependencies…"
    npm install
    ;;
  build)
    echo "==> Building @dune/shared…"
    npm run build --workspace=@dune/shared
    echo "==> Building @dune/server…"
    npm run build --workspace=@dune/server
    echo "==> Building @dune/client (vite)…"
    npm run build --workspace=@dune/client
    ;;
  test)
    echo "==> Running server tests…"
    npm run test --workspace=@dune/server
    ;;
  lint)
    echo "==> Linting server…"
    npm run lint --workspace=@dune/server || true
    ;;
  docker:build)
    echo "==> Building docker images…"
    docker compose build
    ;;
  up|deploy)
    echo "==> Starting stack (server + ollama)…"
    docker compose up -d --build
    docker compose ps
    echo "Server: http://localhost:3023  |  tRPC: http://localhost:3023/trpc  |  Ollama: http://localhost:11434"
    ;;
  down)
    docker compose down
    ;;
  logs)
    docker compose logs -f "${2:-dune-server}"
    ;;
  help|*)
    echo "Usage: ./deploy.sh [install|build|test|lint|docker:build|up|down|logs]"
    ;;
esac
