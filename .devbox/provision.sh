#!/usr/bin/env bash
# =============================================================================
# provision.sh — repo + agent setup, run once at container create
# (devcontainer.json postCreateCommand). Idempotent.
#
# This is a GENERIC provision script. Repo-specific steps go in
# .devbox/post-create.sh (run below after deps + agent setup).
#
# -----------------------------------------------------------------------------
# AGENT SWITCHING
# -----------------------------------------------------------------------------
# This file ships with the Pi agent active by default. To switch to Claude Code
# or Codex instead:
#
#   1. Comment out the Pi block (section 4a).
#   2. Uncomment the Claude Code block (4b) or Codex block (4c).
#   3. Remove the ~/.pi mount from .devcontainer/devcontainer.json — it is
#      inert when a non-Pi block is active, and ~/.pi is ~1.3GB, so removing
#      it avoids a wasteful mount.
#
# =============================================================================
set -euo pipefail

cd /workspace
log() { printf '[provision] %s\n' "$*" >&2; }

# --- 1. Repo dependencies -----------------------------------------------------
# node_modules persists in the bind-mounted worktree, so skip when populated.
if [[ -f bun.lock && ! -d node_modules/bun ]]; then
  log "bun install"
  bun install
elif [[ -f bun.lock ]]; then
  log "node_modules present, skipping bun install"
elif [[ -f pnpm-lock.yaml && ! -d node_modules/.pnpm ]]; then
  log "pnpm install"
  pnpm install --frozen-lockfile
elif [[ -f package-lock.json && ! -d node_modules/.package-lock.json ]]; then
  log "npm ci"
  npm ci
fi

# --- 2. Electron runtime (conditional) ----------------------------------------
# If the repo's package.json defines an "ensure:electron" script, run it. This
# is a generic conditional — any repo with that script gets the Electron
# runtime set up; repos without it are unaffected.
if [[ -f package.json ]] && grep -q '"ensure:electron"' package.json; then
  log "ensuring Electron runtime"
  bun run ensure:electron || log "warn: ensure:electron failed (Electron GUI may not launch)"
fi

# --- 3. .env link -------------------------------------------------------------
if [[ -f "${HOME}/.env" ]] && [[ ! -e /workspace/.env ]]; then
  ln -s "${HOME}/.env" /workspace/.env
  log "linked .env -> ${HOME}/.env"
fi

# --- 4. Agent setup -----------------------------------------------------------
# Only ONE block should be active. See the AGENT SWITCHING comment at the top.

# --- 4a. Pi (active default) --------------------------------------------------
# Copy the host ~/.pi (mounted read-only at /tmp/host-pi) into the box, EXCLUDING
# the bulky / macOS-native dirs (sessions, npm node_modules, cache). Then replay
# the user's extension set from settings.json so they build Linux-native.
HOST_PI=/tmp/host-pi
BOX_PI="${HOME}/.pi"
if [[ -d "${HOST_PI}" ]] && [[ ! -d "${BOX_PI}" ]]; then
  log "copying Pi config from host (excluding sessions/npm/cache)"
  mkdir -p "${BOX_PI}"
  # rsync preserves the tree while pruning the heavy dirs.
  rsync -a \
    --exclude 'agent/sessions/' \
    --exclude 'agent/npm/' \
    --exclude 'agent/cache/' \
    "${HOST_PI}/" "${BOX_PI}/"

  # Replay extensions from settings.json .packages[] (Linux-native rebuild).
  SETTINGS="${BOX_PI}/agent/settings.json"
  if [[ -f "${SETTINGS}" ]] && command -v pi >/dev/null 2>&1; then
    mapfile -t specs < <(jq -r '.packages[]?' "${SETTINGS}" 2>/dev/null || true)
    if [[ "${#specs[@]}" -gt 0 ]]; then
      log "reinstalling ${#specs[@]} Pi extensions"
      for spec in "${specs[@]}"; do
        [[ -z "${spec}" ]] && continue
        log "  pi install ${spec}"
        pi install "${spec}" --approve >/tmp/pi-install.log 2>&1 \
          || log "  warn: failed to install ${spec} (see /tmp/pi-install.log)"
      done
    fi
  fi
else
  log "Pi config already present or host ~/.pi not mounted — skipping"
fi

# --- 4b. Claude Code (commented out — uncomment to use) -----------------------
# Claude Code uses the Anthropic API by default. Set ANTHROPIC_API_KEY in your
# .env file or pass it via devcontainer.json containerEnv. No config-dir copy
# needed — Claude Code reads the env var directly.
# log "installing Claude Code"
# npm install -g @anthropic-ai/claude-code

# --- 4c. Codex (commented out — uncomment to use) -----------------------------
# Codex (OpenAI) can auth via OPENAI_API_KEY in your .env, or via `codex --login`
# which opens a browser (works in-box via the Chromium display stack).
# log "installing Codex"
# npm install -g @openai/codex

# --- 5. Opt-in hook -----------------------------------------------------------
# Repo-specific setup lives in .devbox/post-create.sh. If it exists and is
# executable, run it after deps + agent setup. Absent or non-executable = skip.
if [[ -x .devbox/post-create.sh ]]; then
  log "running .devbox/post-create.sh"
  bash .devbox/post-create.sh || log "warn: post-create.sh exited non-zero"
fi

# --- 6. Start the headed display now (first run) ------------------------------
# postStartCommand also starts it on every boot, but kick it here so the box is
# viewable immediately after `devcontainer up` without waiting for a restart.
# setsid detaches it so it survives this provisioning shell exiting.
if [[ -x /usr/local/bin/devbox-start-display ]]; then
  setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true
  log "display stack starting (noVNC :6080)"
fi

log "provisioning complete"
