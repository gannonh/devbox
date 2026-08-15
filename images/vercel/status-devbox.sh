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

if ! check_image; then
  exit 1
fi

failed=0
for process in Xvfb fluxbox x11vnc websockify; do
  if [[ "${process}" == 'websockify' ]]; then
    process_running="$(pgrep -f '[w]ebsockify' || true)"
  else
    process_running="$(pgrep -x "${process}" || true)"
  fi
  if [[ -n "${process_running}" ]]; then
    printf '[devbox-status] %s=running\n' "${process}"
  else
    printf '[devbox-status] %s=stopped\n' "${process}"
    failed=1
  fi
done
if pgrep -f '[b]asic-auth-proxy.mjs' >/dev/null 2>&1; then
  printf '[devbox-status] auth-proxy=running\n'
else
  printf '[devbox-status] auth-proxy=stopped\n'
  failed=1
fi

exit "${failed}"
