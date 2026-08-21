#!/usr/bin/env bash
# Assert every path this skill references resolves, and that no reference is
# unresolvable-by-construction (a <placeholder> or a * glob in a link target).
# Run from anywhere; resolves against the skill root.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

miss=0; ok=0; vague=0

check() {
  local src="$1" target="$2"
  case "$target" in http*|\#*) return;; esac
  # `<path-to-skill>/x` is the documented run-time-resolved form. Strip the
  # prefix and validate the rest. Any other placeholder or glob can never be
  # opened as written, so it is a defect even though no file is "missing".
  case "$target" in
    "<path-to-skill>/"*) target="${target#<path-to-skill>/}";;
    *'<'*|*'>'*|*'*'*)
      printf 'UNRESOLVABLE  %-44s -> %s\n' "$src" "$target"; vague=$((vague+1)); return;;
  esac
  local base; base="$(dirname "$src")"
  if [ -e "$base/$target" ] || [ -e "$target" ]; then
    ok=$((ok+1))
  else
    printf 'MISSING       %-44s -> %s\n' "$src" "$target"; miss=$((miss+1))
  fi
}

while IFS= read -r line; do
  check "${line%%:*}" "${line#*:}"
done < <(
  # markdown links: (path.ext) — also matches <> and * so they can be flagged
  grep -rHoE '\((\.{0,2}/)?[A-Za-z0-9_.<>*/-]+\.(md|sh|ts|tsv|json))' \
    --include='*.md' --exclude-dir=node_modules . \
    | sed -E 's/\(([^)]*)\)$/\1/' | sed 's/:(/:/'
  # backticked skill-relative paths: `references/...` `scripts/...`
  grep -rHoE '`(references|scripts)/[A-Za-z0-9_.<>*/-]+`' \
    --include='*.md' --exclude-dir=node_modules . \
    | tr -d '`'
)

echo "---"
echo "resolved: $ok   missing: $miss   unresolvable: $vague"
[ "$miss" -eq 0 ] && [ "$vague" -eq 0 ]
