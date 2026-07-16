FROM node:22-slim

# tmux is a hard `yos init` prerequisite (init exits non-zero without it),
# matching the production image. The golden-init bake (below) needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash curl git tmux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

# pm2 is a `yos init` prerequisite (init exits non-zero if it cannot find or
# install pm2), and matches the production image which installs it globally.
RUN npm install -g pm2@latest \
  && npm install -g --install-links . \
  && yos --version

# ── Golden post-init workspace ────────────────────────────────────────────────
# Bake one real `yos init` workspace into the image so scenarios that need a
# post-init state (SETUP=init) can clone it instead of re-running init every
# time. init's auth probe is made to resolve without network via a throwaway
# `claude` stub on PATH (the Docker build itself still installs apt/npm packages
# — only the auth probe is offline). The stub answers only `claude auth status`
# (what isClaudeAuthenticated() calls) and lives at a build-only path that is
# absent from the runtime PATH, so it never shadows the real test shims mounted
# at /runtime/bin.
#
# CRITICAL: init is run with YOS_DIR == $HOME/yos (the production invariant).
# Generated artifacts — notably pm2/ecosystem.config.cjs — resolve skill paths
# from $HOME/yos, ignoring $YOS_DIR. Baking the golden under that invariant
# (and run.sh cloning it back to $HOME/yos) is what makes the cloned workspace
# actually usable (PM2 script paths resolve), not just config-readable. The
# `test -f` gate fails the build if init silently produced an incomplete
# workspace (init swallows PM2/DB warnings and still exits 0).
RUN mkdir -p /opt/yos-buildbin /opt/yos-buildhome \
  && printf '%s\n' \
       '#!/usr/bin/env bash' \
       'if [ "${1:-}" = "auth" ]; then echo "{\"loggedIn\":true}"; fi' \
       'exit 0' \
       > /opt/yos-buildbin/claude \
  && chmod +x /opt/yos-buildbin/claude \
  && PATH="/opt/yos-buildbin:$PATH" HOME=/opt/yos-buildhome YOS_DIR=/opt/yos-buildhome/yos \
       yos init --yes --quiet --timezone UTC --runtime claude \
  && test -f /opt/yos-buildhome/yos/pm2/ecosystem.config.cjs \
  && test -f /opt/yos-buildhome/yos/.claude/skills/scheduler/scripts/daemon.js \
  && mv /opt/yos-buildhome/yos /opt/yos-golden \
  && rm -rf /opt/yos-buildhome /opt/yos-buildbin

# ── Optional: real runtime CLIs (for `run.sh real-smoke`) ─────────────────────
# OFF by default so the standard offline image stays lean and identical to
# before. `run.sh real-smoke` builds a separate `yos-runtime-test:real` image
# with --build-arg INSTALL_REAL_RUNTIMES=1, which installs the genuine CLIs so a
# real-mode scenario (no fake shim on PATH) drives the actual Claude/Codex API.
ARG INSTALL_REAL_RUNTIMES=0
RUN if [ "$INSTALL_REAL_RUNTIMES" = "1" ]; then \
      npm install -g @anthropic-ai/claude-code @openai/codex; \
    fi

WORKDIR /work
