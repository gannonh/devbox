#!/usr/bin/env bash
# Start, verify, and stop the per-app-port relays inside a Vercel Sandbox.
#
# One relay process owns one immutable `relayPort -> localhost:logicalPort`
# mapping, so a changed selection adds or removes processes instead of
# reconfiguring a live one. Readiness is positive evidence: `start` only
# succeeds once the relay has published the port the kernel gave it, and
# `status` re-checks PID and process start time before calling one healthy.
#
# Records live in ${DEVBOX_RELAY_DIR} as `<logicalPort>.pid`:
#   <pid> <start-time> app-relay.mjs <logicalPort> <relayPort>
set -euo pipefail

RELAY_DIR="${DEVBOX_RELAY_DIR:-/vercel/.devbox/runtime/relays}"
RELAY_SCRIPT="${DEVBOX_RELAY_SCRIPT:-/vercel/.devbox/runtime/app-relay.mjs}"
LOG_DIR="${DEVBOX_RELAY_LOG_DIR:-${RELAY_DIR}/logs}"
EXPECTED='app-relay.mjs'
READY_ATTEMPTS="${DEVBOX_RELAY_READY_ATTEMPTS:-200}"

mkdir -p "${RELAY_DIR}" "${LOG_DIR}"
chmod 700 "${RELAY_DIR}" "${LOG_DIR}" 2>/dev/null || true

log() { printf '[devbox-relay-control] %s\n' "$*" >&2; }

proc_start_time() {
  local stat_line
  stat_line="$(<"/proc/$1/stat")" || return 1
  stat_line="${stat_line##*) }"
  # shellcheck disable=SC2086
  set -- ${stat_line}
  printf '%s\n' "${20:-}"
}

process_matches() {
  local pid="$1" started="$2" command_line
  [[ -n "${pid}" && -n "${started}" ]] || return 1
  [[ "$(proc_start_time "${pid}" 2>/dev/null)" == "${started}" ]] || return 1
  command_line="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "${command_line}" == *"${EXPECTED}"* ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

read_record() {
  pid=''; started=''; recorded=''; logical=''; relay=''
  IFS=' ' read -r pid started recorded logical relay <"$1" || return 1
  [[ "${recorded}" == "${EXPECTED}" ]]
}

# A record is healthy only when its own process is still the one behind it.
record_healthy() {
  read_record "$1" || return 1
  process_matches "${pid}" "${started}"
}

stop_one() {
  local logical="$1"
  local pid_file="${RELAY_DIR}/${logical}.pid"
  if [[ -r "${pid_file}" ]] && record_healthy "${pid_file}"; then
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 50); do
      process_matches "${pid}" "${started}" || break
      sleep 0.02
    done
    process_matches "${pid}" "${started}" && kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${pid_file}" "${RELAY_DIR}/${logical}.json" "${RELAY_DIR}/${logical}.json.pending"
}

start_one() {
  local logical="$1"
  local preferred="$2"
  local forbidden="$3"
  [[ "${preferred}" == '-' ]] && preferred=''
  [[ "${forbidden}" == '-' ]] && forbidden=''

  stop_one "${logical}"
  local state_file="${RELAY_DIR}/${logical}.json"
  local pid_file="${RELAY_DIR}/${logical}.pid"
  local pending_pid_file="${pid_file}.pending"
  rm -f "${pending_pid_file}"

  # `env -u` keeps display credentials out of a relay's environment: this
  # process gets its one target and nothing else about the box.
  setsid sh -c 'printf "%s\n" "$$" >"$1"; shift; exec "$@"' sh "${pending_pid_file}" \
    env -u DEVBOX_NOVNC_PASSWORD -u DEVBOX_NOVNC_PORT -u DEVBOX_NOVNC_INTERNAL_PORT \
      DEVBOX_RELAY_TARGET_PORT="${logical}" \
      DEVBOX_RELAY_LISTEN_PORT="${preferred}" \
      DEVBOX_RELAY_FORBIDDEN_PORTS="${forbidden}" \
      DEVBOX_RELAY_STATE_PATH="${state_file}" \
      node "${RELAY_SCRIPT}" \
    </dev/null >"${LOG_DIR}/${logical}.log" 2>&1 &
  local launcher_pid="$!"

  local pid=''
  for _ in $(seq 1 100); do
    if [[ -r "${pending_pid_file}" ]]; then
      pid="$(<"${pending_pid_file}")"
      [[ -n "${pid}" ]] && break
    fi
    sleep 0.01
  done
  local started=''
  if [[ -n "${pid}" ]]; then
    for _ in $(seq 1 100); do
      started="$(proc_start_time "${pid}" 2>/dev/null || true)"
      [[ -n "${started}" ]] && break
      sleep 0.01
    done
  fi
  rm -f "${pending_pid_file}"
  if [[ -z "${pid}" || -z "${started}" ]]; then
    kill -KILL "${launcher_pid}" 2>/dev/null || true
    log "relay for ${logical} did not start"
    return 1
  fi

  # Publication waits for the listener: the bound socket is held from here on,
  # so the port cannot be handed to anything else before the route is updated.
  local relay_port=''
  for _ in $(seq 1 "${READY_ATTEMPTS}"); do
    if [[ -r "${state_file}" ]]; then
      relay_port="$(sed -n 's/.*"relayPort":\([0-9]*\).*/\1/p' "${state_file}")"
      [[ -n "${relay_port}" ]] && break
    fi
    process_matches "${pid}" "${started}" || break
    sleep 0.05
  done
  if [[ -z "${relay_port}" ]]; then
    kill -KILL "${pid}" 2>/dev/null || true
    rm -f "${state_file}"
    log "relay for ${logical} never published a listener port"
    return 1
  fi

  printf '%s %s %s %s %s\n' "${pid}" "${started}" "${EXPECTED}" "${logical}" "${relay_port}" >"${pid_file}"
  printf '{"logicalPort":%s,"relayPort":%s,"pid":%s}\n' "${logical}" "${relay_port}" "${pid}"
}

status_all() {
  local pid_file
  for pid_file in "${RELAY_DIR}"/*.pid; do
    [[ -r "${pid_file}" ]] || continue
    if record_healthy "${pid_file}"; then
      printf '{"logicalPort":%s,"relayPort":%s,"pid":%s,"running":true}\n' "${logical}" "${relay}" "${pid}"
    else
      logical="$(basename "${pid_file}" .pid)"
      printf '{"logicalPort":%s,"relayPort":0,"pid":0,"running":false}\n' "${logical}"
    fi
  done
}

command="${1:-}"
shift || true
case "${command}" in
  start)
    start_one "${1:?logical port is required}" "${2:--}" "${3:--}"
    ;;
  status)
    status_all
    ;;
  stop)
    for logical in "$@"; do stop_one "${logical}"; done
    ;;
  stop-all)
    for pid_file in "${RELAY_DIR}"/*.pid; do
      [[ -e "${pid_file}" ]] || continue
      stop_one "$(basename "${pid_file}" .pid)"
    done
    rm -rf "${LOG_DIR}"
    ;;
  *)
    log "unsupported command: ${command}"
    exit 2
    ;;
esac
