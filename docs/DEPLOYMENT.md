# Deployment Guide

Deploys the Dune server + Ollama stack. Last verified: 2026-10-14 (compose build + GHCR image + `/ready` checks).

## What runs where

| Service | Image | Ports | Data |
|---|---|---|---|
| `dune-server` | `ghcr.io/just-for-death/dune-server:latest` (or local build) | `3023:3030` | `./data` → `/app/backend/data` |
| `ollama` | `ollama/ollama:latest` | `11434:11434` | `ollama-data` volume (models) |

Health: compose polls `GET /ready` every 30s (fails → container marked unhealthy, still serving; `restart: unless-stopped` covers crashes).

## Fresh deploy

```bash
git clone https://github.com/just-for-death/dune && cd dune
cp .env.example .env   # optional; defaults work out of the box
# Edit .env: set API_KEY_SECRET (min 16 chars) BEFORE first boot,
# and ALLOWED_ORIGINS if accessing via LAN IP / hostname.
docker compose up -d --build
curl localhost:3023/ready   # expect {"ready":true,...}
```

On first boot the server prints a one-time default API key to its logs — grab it, register your own via `apiKeys.add`, then delete the default:
```bash
docker compose logs dune-server | grep -i "default api key"
```

## Configuration

All server settings come from environment (see `.env.example` for the full list):
`PORT`, `ALLOWED_ORIGINS`, `API_KEY_SECRET`, `MAX_UPLOAD_MB` (default 500),
`MAX_FILES_PER_GAME` (default 5000), `LOG_LEVEL`. Compose loads `./.env`
automatically if present (`required: false`, so absence is fine).

## LAN access

The server binds `0.0.0.0:3023`. For access from other machines:
1. Add the origin to `ALLOWED_ORIGINS`, e.g. `ALLOWED_ORIGINS=http://192.168.1.50:3023`.
2. Open the firewall for 3023/tcp (UFW: `sudo ufw allow 3023/tcp`), scoped to your LAN if possible.
3. Prefer binding to a LAN-only interface via an override file (`docker-compose.override.yml` is auto-loaded):
```yaml
services:
  dune-server:
    ports: ["192.168.1.50:3023:3030"]
```

## Reverse proxy + TLS (Caddy example)

```caddy
dune.home.example {
    reverse_proxy 127.0.0.1:3023
}
```
Then set `ALLOWED_ORIGINS=https://dune.home.example` and restart. (Nginx equivalent: `proxy_pass http://127.0.0.1:3023;` + certbot.)

## Updating

See `UPGRADING.md`. Short version: `docker compose pull && docker compose up -d`, then check `/ready`.

## Backups

See `BACKUP_RESTORE.md`. Minimum viable schedule: nightly `./deploy.sh backup` via cron, keep 7 days.
