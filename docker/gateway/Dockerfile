# Pinned: openclaw 2026.9.4 requires node >=24.16.0 <25 (or >=26.1.0).
# The floating node:24 tag would satisfy that today but is not reproducible.
FROM node:24.18
RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
# GitHub CLI for agents, from GitHub's apt repo (Debian's own gh is years old).
# Pinned; bump deliberately. Its config (incl. auth written by `gh auth login`)
# lives under the mounted state dir so it survives a redeploy — nothing outside
# /root/.openclaw does.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh=2.101.0 && rm -rf /var/lib/apt/lists/*
ENV GH_CONFIG_DIR=/root/.openclaw/gh
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
# gog — Google Workspace CLI (Drive/Gmail/Calendar/...) with OAuth, by the
# OpenClaw author. Its config (OAuth client + per-account refresh tokens) is
# rooted at GOG_HOME, pointed into the mounted state dir so logins survive a
# redeploy. Pair with the ClawHub skill @steipete/gog so agents know the CLI.
RUN brew install gogcli && brew cleanup -s && rm -rf /home/linuxbrew/.cache/Homebrew
ENV GOG_HOME=/root/.openclaw/gog
RUN npm install -g openclaw@2026.9.4
# Default the Control UI language to English (see patch-control-ui.sh).
COPY patch-control-ui.sh /patch-control-ui.sh
RUN sh /patch-control-ui.sh && rm /patch-control-ui.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
