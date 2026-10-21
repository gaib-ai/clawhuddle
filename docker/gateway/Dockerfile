# Pinned: openclaw 2026.9.4 requires node >=24.16.0 <25 (or >=26.1.0).
# The floating node:24 tag would satisfy that today but is not reproducible.
FROM node:24.18
RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
# Homebrew (Linuxbrew). Homebrew refuses to run as root and the gateway runs
# as root, so it is installed under a dedicated `linuxbrew` user and exposed
# through a /usr/local/bin/brew wrapper that re-executes as that user via sudo.
# Formulae land in /home/linuxbrew/.linuxbrew, which is on PATH for root too.
# NOTE: that prefix is inside the container filesystem, not the mounted state
# dir — packages installed at runtime with `brew install` do not survive a
# redeploy. Bake anything permanent into this image instead.
RUN apt-get update && apt-get install -y build-essential procps curl file sudo \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash linuxbrew \
    && echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/linuxbrew \
    && chmod 0440 /etc/sudoers.d/linuxbrew \
    && sudo -u linuxbrew -H env NONINTERACTIVE=1 HOMEBREW_NO_ANALYTICS=1 \
         bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    && printf '#!/bin/sh\n# Homebrew will not run as root; re-exec as the linuxbrew user.\nif [ "$(id -u)" = "0" ]; then\n  exec sudo -u linuxbrew -H env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 /home/linuxbrew/.linuxbrew/bin/brew "$@"\nfi\nexec /home/linuxbrew/.linuxbrew/bin/brew "$@"\n' > /usr/local/bin/brew \
    && chmod 0755 /usr/local/bin/brew
# Homebrew dirs go LAST so /usr/local/bin/brew (the wrapper) shadows the real
# brew binary, and apt-installed tools keep precedence over formulae.
ENV PATH=$PATH:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin \
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
# gh — GitHub CLI for agents. Its config (incl. auth written by `gh auth login`)
# lives under the mounted state dir so it survives a redeploy — nothing outside
# /root/.openclaw does. Homebrew installs the formula current at build time.
# gog — Google Workspace CLI (Drive/Gmail/Calendar/...) with OAuth, by the
# OpenClaw author. Its config (OAuth client + per-account refresh tokens) is
# rooted at GOG_HOME, pointed into the mounted state dir so logins survive a
# redeploy. Pair with the ClawHub skill @steipete/gog so agents know the CLI.
RUN brew install gh gogcli && brew cleanup -s && rm -rf /home/linuxbrew/.cache/Homebrew
ENV GH_CONFIG_DIR=/root/.openclaw/gh \
    GOG_HOME=/root/.openclaw/gog
RUN npm install -g openclaw@2026.10.3
# Chromium for OpenClaw's browser tool. OpenClaw drives it over CDP through the
# playwright-core it bundles, so install the matching build with that CLI (same
# step as the official image's OPENCLAW_INSTALL_BROWSER). It lives inside the
# image, not the mounted state dir: a browser a member installs at runtime is
# wiped on every redeploy. /usr/bin/chromium is a stable path for
# browser.executablePath. The gateway runs as root, so members need
# browser.noSandbox=true (and headless=true; there is no display — Xvfb is here
# only for headed one-shots).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb \
    && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && node /usr/local/lib/node_modules/openclaw/node_modules/playwright-core/cli.js install --with-deps chromium \
    && ln -s "$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome -path '*chrome-linux*' | head -1)" /usr/bin/chromium \
    && /usr/bin/chromium --version \
    && rm -rf /var/lib/apt/lists/*
# ntn — the official Notion CLI the bundled `notion` skill prefers (it falls
# back to curl without it). Baked in because an `npm install -g` done at
# runtime lands in the container fs and is wiped on redeploy. The token comes
# from the member's secret store (skills.entries.notion.apiKey SecretRef).
RUN npm install -g ntn@0.23.21
# Default the Control UI language to English (see patch-control-ui.sh).
COPY patch-control-ui.sh /patch-control-ui.sh
RUN sh /patch-control-ui.sh && rm /patch-control-ui.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
