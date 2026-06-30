# syntax=docker/dockerfile:1
# =============================================================================
# Kata Agents — headed dev box (devcontainer)
#
# Built on the official Microsoft TypeScript-Node devcontainer base — the same
# generic Node/TS image family Codespaces and Cursor build on. We layer the
# dev CLIs (bun, gh, ripgrep/fd/fzf/tmux), the headed display stack
# (Xvfb/x11vnc/noVNC/fluxbox), and the Pi coding agent on top.
#
# This image is intentionally generic. Repo-specific setup (deps, build,
# Electron, Pi config) happens at container start via the devcontainer.json
# postCreateCommand -> .devbox/provision.sh, not baked into the image.
# =============================================================================
FROM mcr.microsoft.com/devcontainers/typescript-node:22

ENV DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
# System packages: dev CLIs + headed display stack.
#
# Display: Xvfb (virtual framebuffer), x11vnc (VNC server), novnc + websockify
# (browser viewer at :6080), fluxbox (window manager so Electron windows paint).
# Electron runtime libs: gtk/nss/xss/etc. so the GUI launches under Xvfb.
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      fd-find \
      fzf \
      tmux \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fluxbox \
      x11-utils \
      x11-xserver-utils \
      libgtk-3-0 \
      libnotify4 \
      libnss3 \
      libxss1 \
      libxtst6 \
      xdg-utils \
      libatspi2.0-0 \
      libdrm2 \
      libgbm1 \
      libasound2 \
      fonts-liberation \
      chromium \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# Make the newer /usr/local/bin/git (2.54, from the base image) the git every
# caller sees — PATH-independent. The apt /usr/bin/git is 2.47, too old for the
# `relativeWorktrees` extension that --relative-paths worktrees use; agents and
# subprocesses hitting /usr/bin/git fail on commit. Done after apt install so
# the apt git binary isn't reinstated over the symlink.
RUN ln -sf /usr/local/bin/git /usr/bin/git

# -----------------------------------------------------------------------------
# GitHub CLI (official apt repo).
# -----------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Bun (primary runtime + package manager for this repo). Installed to /opt so
# every user sees the same binary.
# -----------------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
    && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
    && printf 'export BUN_INSTALL=/opt/bun\nexport PATH=$BUN_INSTALL/bin:$PATH\n' \
      > /etc/profile.d/bun.sh

# -----------------------------------------------------------------------------
# Pi coding agent (global). Extensions are reinstalled per-box from the user's
# settings.json at provision time so they build Linux-native.
# -----------------------------------------------------------------------------
RUN npm install -g @earendil-works/pi-coding-agent

# Chromium needs --no-sandbox under Xvfb in a container (same SUID issue as
# Electron). Wrap the real binary in place so EVERY caller — xdg-open (via the
# chromium.desktop entry that hardcodes /usr/bin/chromium), Electron's
# shell.openExternal, and direct `chromium` invocations — launches a working
# browser.
RUN mv /usr/bin/chromium /usr/bin/chromium.real \
    && printf '#!/bin/sh\nexec /usr/bin/chromium.real --no-sandbox --disable-gpu --test-type "$@"\n' \
       > /usr/bin/chromium \
    && chmod +x /usr/bin/chromium

# Display defaults (overridable via devcontainer.json containerEnv).
# BROWSER makes xdg-open (and thus Electron's shell.openExternal) launch Chromium.
ENV DISPLAY=:99 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    SCREEN_WIDTH=1600 \
    SCREEN_HEIGHT=1000 \
    SCREEN_DEPTH=24 \
    BROWSER=chromium

# The display launcher runs as a postStartCommand (see devcontainer.json), so it
# does not need to be the entrypoint. Copy it where provision can find it.
COPY .devbox/start-display.sh /usr/local/bin/devbox-start-display
RUN chmod +x /usr/local/bin/devbox-start-display

USER node
