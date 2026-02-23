# Deployment

---

## Docker (recommended)

AgentForge ships with a multi-stage Dockerfile and a docker-compose setup.

### Quick start

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge

# Copy and edit config
cp agentforge.example.yml agentforge.yml

# Start (with optional Ollama for local models)
docker-compose --profile ollama up
# or without Ollama:
docker-compose up
```

The server is available at `http://localhost:4242`.

### Environment variables in Docker

Pass API keys via environment:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
GOOGLE_AI_KEY=AIza... \
docker-compose up
```

Or create a `.env` file (docker-compose loads it automatically):

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_KEY=AIza...
GITHUB_TOKEN=ghp_...
```

### docker-compose.yml overview

```yaml
services:
  agentforge:
    build: .
    ports:
      - "4242:4242"
    volumes:
      - ./agentforge.yml:/app/agentforge.yml:ro
      - agentforge-data:/app/data        # SQLite persistence
    env_file: .env
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    profiles: [ollama]                   # Only started with --profile ollama
    volumes:
      - ollama-models:/root/.ollama
    ports:
      - "11434:11434"
```

When using the `ollama` profile, set:

```yaml
providers:
  ollama:
    endpoint: http://ollama:11434
```

---

## Manual production setup

### 1. Install

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge
npm ci --omit=dev
```

### 2. Configure

```bash
cp agentforge.example.yml agentforge.yml
# Edit agentforge.yml

# Bind to all interfaces
# server:
#   host: 0.0.0.0
#   port: 4242
```

### 3. Environment

Store secrets in the environment, not in agentforge.yml:

```bash
# /etc/agentforge.env (read by systemd, not committed to git)
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_KEY=AIza...
GITHUB_TOKEN=ghp_...
```

### 4. Systemd service

```ini
# /etc/systemd/system/agentforge.service
[Unit]
Description=AgentForge orchestration server
After=network.target

[Service]
Type=simple
User=agentforge
WorkingDirectory=/opt/agentforge
EnvironmentFile=/etc/agentforge.env
ExecStart=/usr/bin/node src/cli.js start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now agentforge
journalctl -u agentforge -f
```

### 5. Reverse proxy (nginx)

Place AgentForge behind nginx to handle TLS and authentication:

```nginx
server {
    listen 443 ssl;
    server_name agentforge.example.com;

    ssl_certificate     /etc/letsencrypt/live/agentforge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agentforge.example.com/privkey.pem;

    # HTTP → REST API
    location /api/ {
        proxy_pass http://127.0.0.1:4242;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket upgrade
    location /ws {
        proxy_pass http://127.0.0.1:4242;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }

    # Static dashboard
    location / {
        proxy_pass http://127.0.0.1:4242;
    }
}
```

---

## Data persistence

AgentForge stores task history, cost logs, and agent metrics in a SQLite database
(`better-sqlite3`, WAL mode) at:

- Default: `./agentforge.db` (relative to `agentforge.yml`)
- Docker: `/app/data/agentforge.db` (bind-mounted volume)

### Backup

```bash
# Hot backup (WAL mode — no lock required)
sqlite3 agentforge.db ".backup agentforge-backup-$(date +%Y%m%d).db"

# Or just copy the file when the server is stopped
cp agentforge.db agentforge-backup.db
```

---

## Cloudflare Tunnel (quick public access)

For temporary public exposure — demos, webhook testing, mobile access — without
configuring a reverse proxy or opening firewall ports:

```bash
bash scripts/start.sh --tunnel
# Prints a public URL, e.g.:
# https://random-words.trycloudflare.com
```

**How it works:**

1. The start script downloads `cloudflared` to `.cache/` on first run (no system install).
2. Starts AgentForge bound to `0.0.0.0` in the background.
3. Waits until `/api/status` responds, then opens a quick tunnel on
   [trycloudflare.com](https://trycloudflare.com).
4. Prints only the public URL to stdout; all other output is suppressed.
5. On `Ctrl+C` both the server and tunnel are cleanly terminated.

**Verbose mode** shows full server logs and cloudflared output, highlighting the URL when it appears:

```bash
bash scripts/start.sh --tunnel --verbose
```

**Capture the URL** for use in scripts or CI:

```bash
TUNNEL_URL=$(bash scripts/start.sh --tunnel)
# Pass to e2e tests, notify a webhook, etc.
```

> **Note:** Quick tunnels are ephemeral (new URL each run) and not suitable for
> production. For stable public URLs use a
> [named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
> or the nginx reverse proxy setup above.

---

## Security considerations

### API exposure

By default the server binds to `127.0.0.1` only. Override with `--host`:

```bash
# Default — localhost only (recommended)
agentforge start

# Behind a reverse proxy — listen on all interfaces
agentforge start --host 0.0.0.0

# Or via agentforge.yml
# server:
#   host: 0.0.0.0
#   port: 4242
```

When exposing to a network:

1. Bind to `0.0.0.0` only behind a reverse proxy.
2. Add HTTP basic auth or an API token header in nginx.
3. Restrict `/api/control/start` and `/api/control/stop` to trusted origins.

### HTTP security headers

[Helmet](https://helmetjs.github.io/) is applied automatically to every
response, adding `X-Frame-Options`, `X-Content-Type-Options`,
`Strict-Transport-Security`, `Content-Security-Policy`, and other safe
defaults.

### Rate limiting

The API enforces per-IP rate limits out of the box:

- **200 req / min** on all routes (read operations)
- **30 req / min** on `POST /api/*` (mutations)

Clients receive standard `RateLimit-*` headers and `429 Too Many Requests`
when the limit is exceeded.

### API keys

- Never commit `agentforge.yml` with literal API keys to version control.
- Use `${ENV_VAR}` syntax and inject keys via environment or a secrets manager.
- The `.gitignore` in the repo already ignores `.env` files.

### GitHub token

The GitHub integration needs a PAT with `repo` scope (classic) or a GitHub App
token. Grant only the minimum scopes required:

- `repo` (branch creation, PR creation)
- `read:org` (if using org repos)

Revoke tokens if they are no longer needed.

### Docker non-root

The Dockerfile runs as a non-root user (`node`). Do not override this with
`--user root` in production.

---

## Upgrading

```bash
# Pull latest
git pull origin master
npm ci --omit=dev

# Docker
docker-compose pull
docker-compose up --build -d
```

The SQLite schema is backward-compatible across patch versions.
Major version upgrades will document any migration steps in the release notes.

---

## Health checks

```bash
# REST — system status
curl http://localhost:4242/api/status

# Process — Node.js health (for container orchestrators)
# docker-compose.yml already defines:
#   healthcheck:
#     test: ["CMD", "curl", "-f", "http://localhost:4242/api/status"]
#     interval: 30s
#     timeout: 10s
#     retries: 3
```
