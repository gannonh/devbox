#!/usr/bin/env bash
# Install official Cursor pstack into ~/.cursor/plugins/local (no marketplace CLI).
# Override dest with PSTACK_DST=...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSTACK_DST="${PSTACK_DST:-${HOME}/.cursor/plugins/local/pstack}"
SETTINGS="${HOME}/.cursor/settings.json"
RULES_SRC="$ROOT/.cursor/rules/pstack-models.mdc"
RULES_DST="${HOME}/.cursor/rules/pstack-models.mdc"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" remote add origin https://github.com/cursor/plugins.git
git -C "$tmp" sparse-checkout init --cone
git -C "$tmp" sparse-checkout set pstack
git -C "$tmp" fetch -q --depth 1 origin main
git -C "$tmp" checkout -q FETCH_HEAD
sha="$(git -C "$tmp" rev-parse --short HEAD)"
test -f "$tmp/pstack/.cursor-plugin/plugin.json"

mkdir -p "$(dirname "$PSTACK_DST")"
rm -rf "$PSTACK_DST"
cp -R "$tmp/pstack" "$PSTACK_DST"

PSTACK_DST="$PSTACK_DST" SETTINGS="$SETTINGS" node <<'NODE'
const fs = require("fs");
const path = require("path");
const dst = process.env.PSTACK_DST;
const file = process.env.SETTINGS;
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
if (data === null || typeof data !== "object" || Array.isArray(data)) {
  throw new Error(`${file} is not a JSON object`);
}
const plugins =
  data.enabled_plugins && typeof data.enabled_plugins === "object" && !Array.isArray(data.enabled_plugins)
    ? data.enabled_plugins
    : {};
data.enabled_plugins = { ...plugins, pstack: { path: dst } };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
NODE

test -f "$RULES_SRC"
mkdir -p "$(dirname "$RULES_DST")"
cp "$RULES_SRC" "$RULES_DST"

echo "cursor pstack -> $PSTACK_DST ($sha)"
echo "cursor pstack models -> $RULES_DST"
