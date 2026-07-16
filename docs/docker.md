# Docker Deployment

YOS can be run inside a Docker container — useful for platforms like Synology NAS, VPS, or any environment where running the native install script is impractical.

## Prerequisites

- Docker 24+
- A Claude Code OAuth token **or** Anthropic API key

## Quick Start

YOS does not publish a public container image yet. Build the image from the
reviewed source checkout so the container always matches the selected commit.

### Option A: Docker Run

```bash
docker build -t yos:local .
docker run -d --name yos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3456:3456 \
  -v yos-data:/home/yos/yos \
  -v claude-config:/home/yos/.claude \
  yos:local
```

Open `http://localhost:3456` to access the web console.

### Option B: Docker Compose

```bash
cd /path/to/reviewed/yos-source
```

Set your token and start:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE
docker compose up -d
```

The compose file supports timezone, channel tokens (Telegram, Lark), web console password, and more — edit it or pass via environment variables.

### Web Console Password

A random password is generated on first boot. Two ways to find it:

**From startup logs:**
```bash
docker logs yos | grep -A2 "Web Console"
```

**Via the Claude shell (after startup completes):**
```bash
docker exec -it yos yos shell
# Then ask: "What's my web console password?"
```

### Talk to Your Agent

```bash
# Interactive CLI — the simplest way to chat
docker exec -it yos yos shell
```

Or open `http://localhost:3456` to use the web console.

### Verify

```bash
# Check services
docker exec yos pm2 status

# Follow logs
docker logs -f yos
```

That's it. YOS initialises its workspace on first boot and starts all services automatically.

## How It Works

On every start, the entrypoint:
1. Validates that an auth token is set
2. Runs `yos init --yes` to create/update the workspace, `.env`, and configure auth
3. Passes through any channel tokens (Telegram, Lark) to `.env`
4. Starts PM2 services and Claude Code in a tmux session

Running `yos init` on every startup ensures that template files (skills, PM2 config) stay in sync when the Docker image is updated. The init command is idempotent — it only creates missing files and syncs templates, never overwrites user data.

## Architecture

```
docker container: yos
├── tmux session: claude-main (or codex-main)  ← AI agent loop (runtime-dependent)
└── PM2 services
    ├── scheduler                   ← cron / heartbeat
    ├── web-console                 ← browser UI (port 3456)
    ├── c4-dispatcher               ← message routing bridge
    ├── activity-monitor            ← liveness / state tracking
    ├── caddy (optional)            ← reverse proxy (port 8080)
    └── channel adapters            ← telegram, lark, etc.
```

## Persistent Data

Two named volumes are created automatically:

| Volume | Mounted at | Contents |
|---|---|---|
| `yos-data` | `~/yos/` | Everything: .env, memory, workspace, logs, components, PM2 config |
| `claude-config` | `~/.claude/` | Claude Code settings and auth tokens. Persists login state so Claude doesn't need to re-authenticate on container restart. Auth is also re-configured by the entrypoint on each boot, so this volume is optional but recommended. |

> **Back up `yos-data`**. It contains the agent's configuration, memory, and workspace. Loss = amnesia + reconfiguration.

## Environment Variables

Set variables in `docker-compose.yml`, a `.env` file alongside `docker-compose.yml`, or via `export` before running `docker compose up`.

### Required (choose one auth method)

| Variable | Description |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code token (Pro/Max subscription) |
| `ANTHROPIC_API_KEY` | Anthropic API key (usage-based billing) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone for scheduler (IANA format, e.g. `Asia/Singapore`) |
| `CLAUDE_BYPASS_PERMISSIONS` | `true` | Run Claude with `--dangerously-skip-permissions` |
| `TELEGRAM_BOT_TOKEN` | — | Telegram channel token |
| `LARK_APP_ID` / `LARK_APP_SECRET` | — | Lark/Feishu app credentials |
| `YOS_WEB_PASSWORD` | — | Web console password (auto-generated if not set) |
| `WEB_CONSOLE_PORT` | `3456` | Host port for web console |
| `HTTP_PORT` | `8080` | Host port for Caddy proxy |

## Mounting Your Own `.env`

Instead of the `environment:` block in `docker-compose.yml`, you can mount a file:

```yaml
volumes:
  - ./yos.env:/home/yos/yos/.env:ro
```

When a mounted `.env` is detected, the entrypoint skips `.env` generation and uses it directly.

## Synology NAS (DSM)

1. Open **Container Manager** → **Project** → **Create**
2. Upload `docker-compose.yml` and set environment variables in the GUI
3. Start the project

Or via SSH:
```bash
ssh admin@<nas-ip>
cd /volume1/docker/yos
docker compose up -d
```

## Updating

Update the source checkout to the reviewed commit before rebuilding.

**Docker Run:**
```bash
docker build --pull -t yos:local .
docker stop yos && docker rm yos
docker run -d --name yos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3456:3456 \
  -v yos-data:/home/yos/yos \
  -v claude-config:/home/yos/.claude \
  yos:local
```

**Docker Compose:**
```bash
docker compose build --pull
docker compose up -d
```

## Troubleshooting

### Claude Code not starting

```bash
# Check tmux session
docker exec -it yos tmux attach -t claude-main   # or codex-main for Codex runtime

# Check Claude auth
docker exec -it yos claude auth status
```

### PM2 services not running

```bash
docker exec -it yos pm2 status
docker exec -it yos pm2 logs --lines 50
```

### Volume location on host

```bash
docker volume inspect yos-core_yos-data
```
