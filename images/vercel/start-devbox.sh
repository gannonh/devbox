#!/usr/bin/env bash
# Start every devbox service explicitly.  Vercel Sandbox does not run a
# Dockerfile ENTRYPOINT or CMD, so smoke tests and callers invoke this script.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_WIDTH="${SCREEN_WIDTH:-1600}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-1000}"
SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_INTERNAL_PORT="${DEVBOX_NOVNC_INTERNAL_PORT:-6080}"
NOVNC_PORT="${DEVBOX_NOVNC_PORT:-6081}"
PID_DIR="${DEVBOX_PID_DIR:-${TMPDIR:-/tmp}/devbox}"
LOG_DIR="${DEVBOX_LOG_DIR:-${TMPDIR:-/tmp}/devbox}"
mkdir -p "${PID_DIR}" "${LOG_DIR}"

log() { printf '[devbox-start] %s\n' "$*" >&2; }

running() {
  local name="$1"
  [[ -f "${PID_DIR}/${name}.pid" ]] || return 1
  local pid
  pid="$(<"${PID_DIR}/${name}.pid")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

start_detached() {
  local name="$1"
  shift
  if running "${name}"; then
    log "${name} already running"
    return
  fi
  rm -f "${PID_DIR}/${name}.pid"
  log "starting ${name}"
  setsid "$@" </dev/null >"${LOG_DIR}/${name}.log" 2>&1 &
  echo "$!" >"${PID_DIR}/${name}.pid"
}

wait_for_display() {
  for _ in $(seq 1 30); do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  log "X display ${DISPLAY} did not become ready"
  return 1
}

wait_for_port() {
  local port="$1"
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  log "port ${port} did not become ready"
  return 1
}

: "${DEVBOX_NOVNC_PASSWORD:?DEVBOX_NOVNC_PASSWORD must be supplied at runtime}"

start_detached xvfb Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac -nolisten tcp
wait_for_display
start_detached fluxbox env DISPLAY="${DISPLAY}" fluxbox
start_detached x11vnc x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -localhost -shared -forever -nopw
wait_for_port "${VNC_PORT}"
start_detached websockify websockify --web=/usr/share/novnc "127.0.0.1:${NOVNC_INTERNAL_PORT}" "127.0.0.1:${VNC_PORT}"
wait_for_port "${NOVNC_INTERNAL_PORT}"
start_detached auth-proxy env \
  DEVBOX_NOVNC_PORT="${NOVNC_PORT}" \
  DEVBOX_NOVNC_INTERNAL_PORT="${NOVNC_INTERNAL_PORT}" \
  DEVBOX_NOVNC_USER="${DEVBOX_NOVNC_USER:-devbox}" \
  DEVBOX_NOVNC_PASSWORD="${DEVBOX_NOVNC_PASSWORD}" \
  node /usr/local/lib/devbox/basic-auth-proxy.mjs
wait_for_port "${NOVNC_PORT}"

log "display ready on ${DISPLAY}; authenticated noVNC is exposed on port ${NOVNC_PORT}"
