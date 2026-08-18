# syntax=docker/dockerfile:1.7
#
# Devbox mirrors the audited open-source Vercel Sandbox Universal recipe rather
# than using the managed Universal VMI as an OCI base. Every external image and
# downloaded runtime is pinned; the display/auth layer is added below.

FROM docker.io/library/ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03 AS ubuntu-base

ENV LANG=C.UTF-8

USER root
ARG DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_SNAPSHOT=20260801T000000Z
RUN set -eux; \
    . /etc/os-release; \
    test "${ID}" = 'ubuntu'; \
    test "$(dpkg --print-architecture)" = 'amd64'; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; \
    printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME} main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME}-updates main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME}-security main restricted universe multiverse" \
      > /etc/apt/sources.list.d/devbox-snapshot.list; \
    # The minimal pinned Ubuntu base has no CA bundle. Bootstrap only that
    # signed snapshot package with TLS peer verification disabled, then require
    # normal TLS verification for every subsequent package operation.
    apt-get -o Acquire::https::Verify-Peer=false update; \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends sudo; \
    rm -rf /var/lib/apt/lists/*

RUN printf '%s\n' \
      'Defaults always_set_home' \
      'Defaults !env_reset' \
      'Defaults !fqdn' \
      'ubuntu ALL=(ALL) NOPASSWD:ALL' \
      > /etc/sudoers.d/sandbox; \
    chmod 0440 /etc/sudoers.d/sandbox; \
    install -d -o ubuntu -g ubuntu /vercel; \
    usermod --home /vercel ubuntu; \
    chown -R ubuntu:ubuntu /vercel

ENV HOME=/vercel
USER ubuntu
WORKDIR /vercel

FROM ubuntu-base AS node
USER root
ENV HOME=/root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl libarchive-tools && \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    tarball="node-v24.19.0-linux-x64.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v24.19.0/${tarball}" -o "/tmp/${tarball}"; \
    echo "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  /tmp/${tarball}" | sha256sum -c -; \
    mkdir -p /opt/node; \
    bsdtar -xJ --strip-components=1 -C /opt/node -f "/tmp/${tarball}"; \
    rm -f "/tmp/${tarball}" /opt/node/CHANGELOG.md /opt/node/LICENSE /opt/node/README.md

FROM docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun

FROM ubuntu-base
USER root
ENV HOME=/root
ARG DEBIAN_FRONTEND=noninteractive
ARG PYTHON_MAJOR=3.14
ARG UBUNTU_SNAPSHOT=20260801T000000Z

COPY --from=node /opt/node /usr/local
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN set -eux; \
    ln -s bun /usr/local/bin/bunx; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl gnupg; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bzip2 \
      curl \
      dnsutils \
      file \
      fzf \
      gh=2.97.0 \
      git \
      git-lfs \
      gnupg \
      iproute2 \
      iputils-ping \
      jq \
      less \
      libatomic1 \
      lsof \
      nano \
      netcat-openbsd \
      openssl \
      procps \
      "python${PYTHON_MAJOR}" \
      "python${PYTHON_MAJOR}-venv" \
      python-is-python3 \
      python3-pip \
      ripgrep \
      rsync \
      sqlite3 \
      tmux \
      tree \
      unzip \
      vim \
      wget \
      xz-utils \
      zip; \
    rm -f /usr/lib/python3*/EXTERNALLY-MANAGED; \
    python -m pip install --no-cache-dir "pip==25.1.1" "uv==0.12.2"; \
    rm -rf /root/.cache/pip /var/lib/apt/lists/*; \
    git lfs install --system; \
    npm install -g \
      npm@11.17.0 \
      pnpm@11.20.0 \
      opencode-ai@1.18.15 \
      @anthropic-ai/claude-code@2.1.224 \
      @openai/codex@0.147.0 \
      @earendil-works/pi-coding-agent@0.84.1; \
    npm cache clean --force; \
    node --version | grep -F 'v24.19.0'; \
    npm --version | grep -F '11.17.0'; \
    pnpm --version | grep -F '11.20.0'; \
    bun --version | grep -F '1.3.14'; \
    python --version | grep -F 'Python 3.14.4'; \
    pip --version | grep -F '25.1.1'; \
    uv --version | grep -F '0.12.2'; \
    gh --version | grep -F 'gh version 2.97.0'; \
    opencode --version | grep -F '1.18.15'; \
    claude --version | grep -F '2.1.224'; \
    codex --version | grep -F '0.147.0'; \
    pi --version | grep -F '0.84.1'

RUN chown -R ubuntu:ubuntu /vercel

ENV HOME=/vercel
USER ubuntu
WORKDIR /vercel

RUN mkdir -p ~/.global/npm ~/.global/pnpm && \
    npm config set prefix ~/.global/npm && \
    pnpm config set global-dir ~/.global/pnpm && \
    pnpm config set global-bin-dir ~/.global/pnpm/bin

ENV PATH="/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:${PATH}"

# Add the display/auth layer after the mirrored Universal recipe.
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      chromium \
      fluxbox \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libnspr4 \
      libnss3 \
      libxkbcommon0 \
      netcat-openbsd \
      novnc \
      websockify \
      x11-utils \
      x11-xserver-utils \
      x11vnc \
      xdg-utils \
      xvfb; \
    rm -rf /var/lib/apt/lists/*

ARG CHROMIUM_VERSION=152.0.7977.42
ARG CHROMIUM_SHA256=cb77f4781cad7d5e06fcc78b4476e6a6375616e7278dc313abaa9db22ed4674e
RUN set -eux; \
    archive=/tmp/chrome-linux64.zip; \
    curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.42/linux64/chrome-linux64.zip" -o "${archive}"; \
    echo "${CHROMIUM_SHA256}  ${archive}" | sha256sum -c -; \
    install -d /opt/chromium; \
    unzip -q "${archive}" -d /opt/chromium; \
    rm -f "${archive}" /usr/bin/chromium /usr/bin/chromium-browser; \
    printf '%s\n' '#!/bin/sh' 'exec /opt/chromium/chrome-linux64/chrome --no-sandbox --disable-gpu --test-type "$@"' > /usr/local/bin/chromium; \
    chmod 0755 /usr/local/bin/chromium; \
    chromium --version | grep -F "${CHROMIUM_VERSION}"

COPY provenance.json /usr/local/share/devbox/universal-provenance.json
COPY basic-auth-proxy.mjs /usr/local/lib/devbox/basic-auth-proxy.mjs
COPY start-devbox.sh /usr/local/bin/devbox-start
COPY status-devbox.sh /usr/local/bin/devbox-status
RUN chmod 0755 /usr/local/lib/devbox/basic-auth-proxy.mjs \
      /usr/local/bin/devbox-start /usr/local/bin/devbox-status \
    && install -d -o ubuntu -g ubuntu /var/log/devbox \
    && chown ubuntu:ubuntu /usr/local/share/devbox/universal-provenance.json

ENV DISPLAY=:99 \
    SCREEN_WIDTH=1600 \
    SCREEN_HEIGHT=1000 \
    SCREEN_DEPTH=24 \
    VNC_PORT=5900 \
    DEVBOX_NOVNC_INTERNAL_PORT=6081 \
    DEVBOX_NOVNC_PORT=6080 \
    BROWSER=chromium

# Clear Ubuntu's inherited shell command. Vercel Sandbox still starts all
# runtime behavior explicitly through /usr/local/bin/devbox-start.
USER ubuntu
CMD []
