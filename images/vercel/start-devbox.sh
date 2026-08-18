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

proc_start_time() {
  local stat_line
  stat_line="$(<"/proc/$1/stat")" || return 1
  stat_line="${stat_line##*) }"
  set -- ${stat_line}
  printf '%s\n' "${20:-}"
}

process_matches() {
  local pid="$1"
  local started="$2"
  local expected="$3"
  local command_line
  [[ -n "${pid}" && -n "${started}" && -n "${expected}" ]] || return 1
  [[ "$(proc_start_time "${pid}" 2>/dev/null)" == "${started}" ]] || return 1
  command_line="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "${command_line}" == *"${expected}"* ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

running() {
  local name="$1"
  local expected="$2"
  local pid started recorded
  [[ -f "${PID_DIR}/${name}.pid" ]] || return 1
  IFS=' ' read -r pid started recorded <"${PID_DIR}/${name}.pid" || return 1
  [[ "${recorded}" == "${expected}" ]] || return 1
  process_matches "${pid}" "${started}" "${expected}"
}

start_detached() {
  local name="$1"
  local expected="$2"
  shift 2
  if running "${name}" "${expected}"; then
    log "${name} already running"
    return
  fi
  local pid_file="${PID_DIR}/${name}.pid"
  local pending_pid_file="${pid_file}.pending"
  rm -f "${pid_file}" "${pending_pid_file}"
  log "starting ${name}"
  setsid sh -c 'printf "%s\n" "$$" >"$1"; shift; exec "$@"' sh "${pending_pid_file}" "$@" \
    </dev/null >"${LOG_DIR}/${name}.log" 2>&1 &
  local launcher_pid="$!"
  local pid=''
  for _ in $(seq 1 50); do
    if [[ -r "${pending_pid_file}" ]]; then
      pid="$(<"${pending_pid_file}")"
      [[ -n "${pid}" ]] && break
    fi
    sleep 0.01
  done
  local started=''
  for _ in $(seq 1 50); do
    started="$(proc_start_time "${pid}" 2>/dev/null || true)"
    [[ -n "${started}" ]] && break
    sleep 0.01
  done
  if [[ -z "${pid}" || -z "${started}" ]]; then
    kill -KILL "${launcher_pid}" 2>/dev/null || true
    rm -f "${pending_pid_file}"
    return 1
  fi
  printf '%s %s %s\n' "${pid}" "${started}" "${expected}" >"${pid_file}"
  rm -f "${pending_pid_file}"
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

start_detached xvfb Xvfb Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac -nolisten tcp
wait_for_display
start_detached fluxbox fluxbox env DISPLAY="${DISPLAY}" fluxbox
start_detached x11vnc x11vnc x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -localhost -shared -forever -nopw
wait_for_port "${VNC_PORT}"
start_detached websockify websockify websockify --web=/usr/share/novnc "127.0.0.1:${NOVNC_INTERNAL_PORT}" "127.0.0.1:${VNC_PORT}"
wait_for_port "${NOVNC_INTERNAL_PORT}"
start_detached auth-proxy basic-auth-proxy.mjs env \
  DEVBOX_NOVNC_PORT="${NOVNC_PORT}" \
  DEVBOX_NOVNC_INTERNAL_PORT="${NOVNC_INTERNAL_PORT}" \
  DEVBOX_NOVNC_USER="${DEVBOX_NOVNC_USER:-devbox}" \
  DEVBOX_NOVNC_PASSWORD="${DEVBOX_NOVNC_PASSWORD}" \
  node /usr/local/lib/devbox/basic-auth-proxy.mjs
wait_for_port "${NOVNC_PORT}"

log "display ready on ${DISPLAY}; authenticated noVNC is exposed on port ${NOVNC_PORT}"
