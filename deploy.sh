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
  backup)
    # Usage: ./deploy.sh backup [dest-dir]
    # Crash-consistent tarball of the data dir (atomic tmp+rename writes
    # mean no partial JSON is ever archived; *.tmp.* excluded explicitly).
    # For guaranteed-consistent backups, stop the server first (./deploy.sh down).
    src="${DATA_DIR:-./data}"
    dest="${2:-./backups}"
    if [ ! -d "$src" ]; then
      echo "error: data dir not found: $src (override with DATA_DIR=...)" >&2
      exit 1
    fi
    mkdir -p "$dest"
    start=$(date +%s)
    stamp=$(date +%Y%m%d-%H%M%S)
    archive="$dest/dune-data-$stamp.tar.gz"
    parent=$(dirname "$src")
    base=$(basename "$src")
    tar czf "$archive" --exclude='*.tmp.*' -C "$parent" "$base"
    (cd "$dest" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
    count=$(tar -tzf "$archive" | wc -l)
    size=$(du -h "$archive" | cut -f1)
    elapsed=$(( $(date +%s) - start ))
    # Verify the archive reads back cleanly
    tar -tzf "$archive" >/dev/null
    echo "backup OK: $archive ($size, $count entries, ${elapsed}s)"
    echo "sha256: $(cut -d' ' -f1 "$archive.sha256")"
    ;;
  restore)
    # Usage: ./deploy.sh restore <archive.tar.gz> [dest-data-dir]
    # Safety-first: snapshots current data to ./backups/pre-restore-<ts>.tar.gz
    # before touching anything, stops the server if running, restores,
    # then restarts it and waits for /ready.
    archive="${2:?usage: ./deploy.sh restore <archive.tar.gz> [dest-data-dir]}"
    dest="${3:-${DATA_DIR:-./data}}"
    if [ ! -f "$archive" ]; then
      echo "error: archive not found: $archive" >&2
      exit 1
    fi
    if ! tar -tzf "$archive" >/dev/null 2>&1; then
      echo "error: archive is corrupt or unreadable: $archive" >&2
      exit 1
    fi
    if ! (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256") >/dev/null 2>&1; then
      echo "warn: sha256 sidecar missing/mismatch — continuing (archive itself verified readable)"
    fi
    running=""
    if docker compose ps --services --filter "status=running" 2>/dev/null | grep -q "^dune-server$"; then
      running=1
      echo "==> Stopping dune-server for restore…"
      docker compose stop dune-server
    fi
    if [ -d "$dest" ]; then
      echo "==> Snapshotting current data first…"
      DATA_DIR="$dest" ./deploy.sh backup ./backups >/dev/null
      # Rename latest backup as the pre-restore snapshot
      stamp="pre-restore-$(date +%Y%m%d-%H%M%S)"
      latest=$(ls -t ./backups/dune-data-*.tar.gz | head -1)
      mv "$latest" "./backups/$stamp.tar.gz"
      mv "$latest.sha256" "./backups/$stamp.tar.gz.sha256" 2>/dev/null || true
    fi
    echo "==> Extracting $archive → $dest …"
    mkdir -p "$dest"
    # Backups always have a single top-level dir (e.g. data/); strip it so
    # dest ends up holding dune.json/saves directly. Multi-root archives
    # extract as-is to avoid clobbering unrelated paths.
    tops=$(tar -tzf "$archive" | cut -d/ -f1 | sort -u | grep -cv '^$')
    if [ "$tops" -eq 1 ] && tar -tzf "$archive" | head -1 | grep -q /; then
      tar xzf "$archive" -C "$dest" --strip-components=1
    else
      tar xzf "$archive" -C "$dest"
    fi
    if [ -n "$running" ]; then
      echo "==> Restarting dune-server…"
      docker compose start dune-server
      echo "==> Waiting for /ready (30s)…"
      for i in $(seq 1 30); do
        if wget -qO- http://127.0.0.1:3023/ready 2>/dev/null | grep -q '"ready":true'; then
          echo "restore OK: server reports ready"
          exit 0
        fi
        sleep 1
      done
      echo "error: server did not report ready within 30s — check ./deploy.sh logs" >&2
      exit 1
    fi
    echo "restore OK: extracted to $dest (server was not running)"
    ;;
  help|*)
    echo "Usage: ./deploy.sh [install|build|test|lint|docker:build|up|down|logs|backup [dest]|restore <archive> [dest]]"
    ;;
esac
