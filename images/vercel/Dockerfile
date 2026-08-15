# syntax=docker/dockerfile:1.7
#
# Devbox's Vercel Sandbox image.  The digest is supplied by the checked-in
# base-image pin and by the candidate workflow; there is deliberately no
# floating Universal tag or runtime package installation path.
ARG UNIVERSAL_BASE_DIGEST
FROM vcr.vercel.com/vercel/sandbox/universal@sha256:${UNIVERSAL_BASE_DIGEST}

USER root
ARG DEBIAN_FRONTEND=noninteractive
# Reviewed 2026-08-14 against the Ubuntu-based Universal source; update this
# date only with a deliberate base-distro/package-set review.
ARG UBUNTU_SNAPSHOT=20260801T000000Z

# Universal already supplies the agents, runtimes, git, gh, sudo, and common
# utilities.  This layer adds only the headed display and authenticated noVNC
# path needed by devbox.  The dated snapshot freezes both package metadata and
# package payload selection for this pinned Universal base.
RUN set -eux; \
    . /etc/os-release; \
    test "${ID}" = 'ubuntu'; \
    test -n "${VERSION_CODENAME}"; \
    test "$(dpkg --print-architecture)" = 'amd64'; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; \
    printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME} main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME}-updates main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} ${VERSION_CODENAME}-security main restricted universe multiverse" \
      > /etc/apt/sources.list.d/devbox-snapshot.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fluxbox \
      netcat-openbsd \
      novnc \
      websockify \
      x11-utils \
      x11-xserver-utils \
      x11vnc \
      xdg-utils \
      xvfb; \
    rm -rf /var/lib/apt/lists/*

# Chromium is launched by the explicit display script.  Keep the browser
# usable in Firecracker without relying on an image ENTRYPOINT or CMD.
RUN if [ -x /usr/bin/chromium ]; then \
      mv /usr/bin/chromium /usr/bin/chromium.real; \
      printf '%s\n' '#!/bin/sh' 'exec /usr/bin/chromium.real --no-sandbox --disable-gpu --test-type "$@"' > /usr/bin/chromium; \
      chmod 0755 /usr/bin/chromium; \
    fi

COPY basic-auth-proxy.mjs /usr/local/lib/devbox/basic-auth-proxy.mjs
COPY start-devbox.sh /usr/local/bin/devbox-start
COPY status-devbox.sh /usr/local/bin/devbox-status
RUN chmod 0755 /usr/local/lib/devbox/basic-auth-proxy.mjs \
      /usr/local/bin/devbox-start /usr/local/bin/devbox-status \
    && install -d -o ubuntu -g ubuntu /var/log/devbox

ENV DISPLAY=:99 \
    SCREEN_WIDTH=1600 \
    SCREEN_HEIGHT=1000 \
    SCREEN_DEPTH=24 \
    VNC_PORT=5900 \
    DEVBOX_NOVNC_INTERNAL_PORT=6080 \
    DEVBOX_NOVNC_PORT=6081 \
    DEVBOX_NOVNC_USER=devbox \
    BROWSER=chromium

# Vercel Sandbox intentionally ignores Docker ENTRYPOINT and CMD.  Runtime
# behavior starts only when the smoke workflow calls /usr/local/bin/devbox-start.
USER ubuntu
