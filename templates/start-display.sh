#!/usr/bin/env bash
# =============================================================================
# start-display.sh — bring up the headed display stack (postStartCommand).
#
# Idempotent: safe to run on every container start. Starts Xvfb, fluxbox,
# x11vnc, and noVNC if they aren't already running, then returns (the caller
# backgrounds it). Electron renders to the Xvfb display; you view it in a
# browser at http://localhost:<novnc>/vnc.html.
# =============================================================================
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_W="${SCREEN_WIDTH:-1600}"
SCREEN_H="${SCREEN_HEIGHT:-1000}"
SCREEN_D="${SCREEN_DEPTH:-24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

log() { printf '[display] %s\n' "$*" >&2; }

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "Xvfb ${DISPLAY} (${SCREEN_W}x${SCREEN_H}x${SCREEN_D})"
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN_W}x${SCREEN_H}x${SCREEN_D}" -ac -nolisten tcp &
  for _ in $(seq 1 10); do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

if ! pgrep -x fluxbox >/dev/null 2>&1; then
  log "fluxbox"
  (DISPLAY="${DISPLAY}" fluxbox >/tmp/fluxbox.log 2>&1 &)
fi

if ! pgrep -x x11vnc >/dev/null 2>&1; then
  log "x11vnc :${VNC_PORT}"
  (x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -shared -forever -nopw \
          >/tmp/x11vnc.log 2>&1 &)
fi

if ! pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null 2>&1; then
  log "noVNC http://localhost:${NOVNC_PORT}/vnc.html"
  (websockify --web=/usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
          >/tmp/novnc.log 2>&1 &)
fi

log "display ready"
