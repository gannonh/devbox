#!/usr/bin/env bash
# Run the deterministic local image contract check.
# Usage: check-local-image.sh <image-reference>
set -euo pipefail

IMAGE_REFERENCE="${1:?usage: $0 <image-reference>}"
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required' >&2; exit 1; }

inspect="$(docker image inspect "${IMAGE_REFERENCE}")"
user="$(jq -r '.[0].Config.User // ""' <<<"${inspect}")"
entrypoint="$(jq -c '.[0].Config.Entrypoint // []' <<<"${inspect}")"
command="$(jq -c '.[0].Config.Cmd // []' <<<"${inspect}")"

if [[ -z "${user}" || "${user}" == '0' || "${user}" == 'root' ]]; then
  echo '[local-image-check] image must declare a non-root user' >&2
  exit 1
fi
if [[ "${entrypoint}" != '[]' && "${entrypoint}" != 'null' ]]; then
  echo '[local-image-check] ENTRYPOINT is forbidden for Sandbox images' >&2
  exit 1
fi
if [[ "${command}" != '[]' && "${command}" != 'null' ]]; then
  echo '[local-image-check] CMD is forbidden for Sandbox images' >&2
  exit 1
fi

# Pass the check command explicitly; no image default command is required.
# The status command runs `sudo -n true` and checks every required binary.
docker run --rm --user "${user}" "${IMAGE_REFERENCE}" /usr/local/bin/devbox-status --check-image
printf '[local-image-check] passed: user=%s, no ENTRYPOINT/CMD\n' "${user}"
