#!/usr/bin/env bash
# =============================================================================
# post-create.sh — repo-specific post-provision hook
#
# Runs AFTER provision.sh finishes deps install, agent setup, and .env linking.
# Use this for anything specific to YOUR repo that the generic provision.sh
# doesn't handle: building native deps, running migrations, downloading
# datasets, etc.
#
# The generic provision.sh calls this only if it is executable:
#   bash .devbox/post-create.sh
#
# If you don't need any custom setup, leave this file as-is (it's a no-op).
# =============================================================================
set -euo pipefail

log() { printf '[post-create] %s\n' "$*" >&2; }

log "no custom post-create steps"
