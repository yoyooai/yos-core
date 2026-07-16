# ────────────────────────────────────────────────────────────────────────────
# YOS — Official Dockerfile
#
# Build:  docker build -t yos .
# Run:    docker compose up -d   (see docker-compose.yml)
#
# This image installs YOS and its dependencies, then starts all PM2-managed
# services (scheduler, web-console, c4-dispatcher, activity-monitor, channels).
# The AI loop (Claude Code) runs inside a persistent tmux session so it can
# receive heartbeat / message commands through the c4-dispatcher bridge.
# ────────────────────────────────────────────────────────────────────────────

FROM node:22-slim

LABEL org.opencontainers.image.description="YOS — autonomous AI agent infrastructure"

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      tmux \
      bash \
      ca-certificates \
      # Needed by some Claude Code operations
      procps \
      # For `yos doctor` network checks
      dnsutils \
    && rm -rf /var/lib/apt/lists/*

# ── Global npm tools ──────────────────────────────────────────────────────────
RUN npm install -g pm2@latest

# ── Create yos user (non-root) ──────────────────────────────────────────────
RUN useradd -m -s /bin/bash yos \
    && mkdir -p /home/yos/.local/bin /home/yos/.npm-global \
    && chown -R yos:yos /home/yos
USER yos
ENV HOME=/home/yos
ENV NPM_CONFIG_PREFIX=/home/yos/.npm-global
ENV PATH="/home/yos/.npm-global/bin:/home/yos/.local/bin:/usr/local/bin:${PATH}"

# ── Install YOS from local source ──────────────────────────────────────────
# COPY the repo (filtered by .dockerignore) and install from it, so the image
# always matches the exact commit/tag being built.
WORKDIR /home/yos
COPY --chown=yos:yos . /tmp/yos-source
RUN npm install -g --install-links /tmp/yos-source \
    && rm -rf /tmp/yos-source \
    && yos --version

# ── Workspace directories ─────────────────────────────────────────────────────
# ~/yos is mounted as a single volume in docker-compose.yml.
# Creating subdirectories here ensures correct ownership in the image.
RUN mkdir -p \
      /home/yos/yos/pm2 \
      /home/yos/.claude

# ── Copy PM2 ecosystem config ─────────────────────────────────────────────────
COPY --chown=yos:yos templates/pm2/ecosystem.config.cjs /home/yos/yos/pm2/ecosystem.config.cjs

# ── Copy entrypoint ───────────────────────────────────────────────────────────
COPY --chown=yos:yos docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Ports ─────────────────────────────────────────────────────────────────────
# Web console (web-console service, default 3456)
EXPOSE 3456
# Caddy / reverse proxy (optional, enabled via .env)
EXPOSE 8080

# Healthcheck is defined in docker-compose.yml (start_period=600s for slow init).
# No HEALTHCHECK here to avoid a conflicting override.

ENTRYPOINT ["/entrypoint.sh"]
