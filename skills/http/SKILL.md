---
name: http
description: Caddy-based web server providing web console hosting, file sharing, and health check endpoints. Use when configuring HTTP access, setting up file sharing, or troubleshooting web connectivity.
---

# HTTP Layer (C6)

User-space Caddy web server providing:
- HTTPS with automatic Let's Encrypt certificates
- File sharing via `~/yos/http/public/`
- Health check endpoint
- Component reverse proxy routes (auto-configured by `yos add`)

## Architecture

| Component | Path |
|-----------|------|
| Binary | `~/yos/bin/caddy` |
| Caddyfile | `~/yos/http/Caddyfile` |
| Public files | `~/yos/http/public/` |
| Access log | `~/yos/http/caddy-access.log` |
| Domain config | `~/yos/.yos/config.json` |

Caddy runs as a PM2 service (user-space, no sudo needed for daily operations).

## Setup

Caddy is set up automatically during `yos init`:
1. Downloads Caddy binary to `~/yos/bin/caddy`
2. Prompts for domain, stores in `config.json`
3. Generates Caddyfile
4. Sets port binding capability (`setcap`, one-time sudo)
5. Starts via PM2

To re-run setup: `yos init`

## Endpoints

| Path | Description |
|------|-------------|
| `/` | File listing or index.html |
| `/*.md` | Markdown documents (served as plain text) |

## File Sharing

Place files in `~/yos/http/public/` to share:

```bash
cp document.md ~/yos/http/public/
# Access at: https://your.domain.com/document.md
```

## Component Routes

Components declare `http_routes` in SKILL.md frontmatter. Routes are auto-managed via marker blocks in the Caddyfile by `yos add/upgrade/remove`.

## Troubleshooting

```bash
# Check Caddy status
pm2 logs caddy

# Validate Caddyfile
~/yos/bin/caddy validate --config ~/yos/http/Caddyfile --adapter caddyfile

# Reload after manual Caddyfile edits
pm2 reload caddy

# Access logs
tail -f ~/yos/http/caddy-access.log
```

## Port Binding

On Linux, Caddy needs `CAP_NET_BIND_SERVICE` to bind ports 80/443:

```bash
sudo setcap cap_net_bind_service=+ep ~/yos/bin/caddy
```

This is set automatically during `yos init`. If the binary is replaced (e.g., after an update), re-run the command above.
