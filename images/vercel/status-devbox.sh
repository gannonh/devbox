#!/usr/bin/env bash
# Image/runtime status checks. This command never prints credential values.
set -euo pipefail

REQUIRED_COMMANDS=(
  pi claude codex opencode gh node bun python chromium
  Xvfb fluxbox x11vnc websockify sudo timeout
)

probe_binary() {
  local binary="$1"
  shift
  local output
  if output="$(timeout 5s "${binary}" "$@" 2>&1)"; then
    printf '[devbox-status] %s=working\n' "${binary}"
    return 0
  fi
  printf '[devbox-status] FAIL: %s probe failed: %s\n' "${binary}" "${output:0:300}" >&2
  return 1
}

check_image() {
  local failed=0
  if [[ "$(id -u)" == "0" ]]; then
    printf '[devbox-status] FAIL: image runs as root\n' >&2
    failed=1
  fi
  if ! sudo -n true >/dev/null 2>&1; then
    printf '[devbox-status] FAIL: passwordless sudo is unavailable\n' >&2
    failed=1
  fi
  for command in "${REQUIRED_COMMANDS[@]}"; do
    if ! command -v "${command}" >/dev/null 2>&1; then
      printf '[devbox-status] FAIL: missing %s\n' "${command}" >&2
      failed=1
    fi
  done
  if [[ "${failed}" -eq 0 ]]; then
    for probe in \
      'pi --version' 'claude --version' 'codex --version' 'opencode --version' \
      'gh --version' 'node --version' 'bun --version' 'python --version' \
      'chromium --version' 'Xvfb -help' 'fluxbox --version' \
      'x11vnc -version' 'websockify --help'; do
      # shellcheck disable=SC2086
      if ! probe_binary ${probe}; then
        failed=1
      fi
    done
  fi
  # Exact declared versions (agents.json is embedded in the image): a stale or
  # partially updated image fails the local contract check. A missing,
  # unreadable, or unparseable manifest fails closed too.
  manifest="/usr/local/share/devbox/agents.json"
  if [[ ! -r "${manifest}" ]]; then
    printf '[devbox-status] FAIL: agent manifest is missing or unreadable\n' >&2
    failed=1
  elif records="$(jq -r '.agents | to_entries[] | [.value.binary, .value.version, .value.versionFlag] | @tsv' "${manifest}")"; then
    if [[ -z "${records}" ]]; then
      printf '[devbox-status] FAIL: agent manifest declares no agents\n' >&2
      failed=1
    else
      while IFS=$'\t' read -r binary version flag; do
        [[ -n "${binary}" && -n "${version}" && -n "${flag}" ]] || continue
        output="$(timeout 5s "${binary}" "${flag}" 2>&1 || true)"
        if ! grep -Fq "${version}" <<<"${output}"; then
          printf '[devbox-status] FAIL: %s version %s not observed (got: %s)\n' \
            "${binary}" "${version}" "${output:0:200}" >&2
          failed=1
        fi
      done <<<"${records}"
    fi
  else
    printf '[devbox-status] FAIL: agent manifest is not valid JSON\n' >&2
    failed=1
  fi
  if [[ "${failed}" -eq 0 ]]; then
    printf '[devbox-status] image checks passed (user=%s uid=%s)\n' "$(id -un)" "$(id -u)"
  fi
  return "${failed}"
}

if [[ "${1:-}" == '--check-image' ]]; then
  if check_image; then
    exit 0
  fi
  exit 1
fi

display_only=false
case "${DEVBOX_STATUS_MODE:-full}" in
  display) display_only=true ;;
  full)
    if ! check_image; then
      exit 1
    fi
    ;;
  *)
    printf '[devbox-status] FAIL: unsupported status mode\n' >&2
    exit 2
    ;;
esac

failed=0
missing=()
for process in Xvfb fluxbox x11vnc websockify; do
  if [[ "${process}" == 'websockify' ]]; then
    process_running="$(pgrep -f '[w]ebsockify' || true)"
  else
    process_running="$(pgrep -x "${process}" || true)"
  fi
  if [[ -n "${process_running}" ]]; then
    if [[ "${display_only}" == false ]]; then
      printf '[devbox-status] %s=running\n' "${process}"
    fi
  else
    missing+=("${process}")
    if [[ "${display_only}" == false ]]; then
      printf '[devbox-status] %s=stopped\n' "${process}"
    fi
    failed=1
  fi
done
if pgrep -f '[n]ovnc-proxy.mjs' >/dev/null 2>&1; then
  if [[ "${display_only}" == false ]]; then
    printf '[devbox-status] auth-proxy=running\n'
  fi
else
  missing+=(auth-proxy)
  if [[ "${display_only}" == false ]]; then
    printf '[devbox-status] auth-proxy=stopped\n'
  fi
  failed=1
fi

write_display_heartbeat() {
  local runtime_dir='/vercel/.devbox/runtime'
  mkdir -p "${runtime_dir}" 2>/dev/null || return 0
  if (umask 077; date +%s > "${runtime_dir}/heartbeat") 2>/dev/null; then
    chmod 600 "${runtime_dir}/heartbeat" 2>/dev/null || true
  fi
}

if [[ "${display_only}" == true ]]; then
  if [[ "${failed}" -eq 0 ]]; then
    # A healthy display poll is user-visible activity. Keep this best effort
    # so a read-only runtime directory never turns a healthy display into a
    # failed status check.
    write_display_heartbeat
    printf '[devbox-status] display=running\n'
  else
    joined="$(IFS=,; printf '%s' "${missing[*]}")"
    printf '[devbox-status] display=stopped missing=%s\n' "${joined}"
  fi
fi

exit "${failed}"
