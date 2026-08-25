#!/usr/bin/env bash
# Re-render saved slice reports without an LLM run, for eyeballing the page.
#
#   scripts/rerender.sh [--out-dir DIR] [pr-review flags...] slices-*.json...
#
# Each slices-<repo>-pr<n>.json becomes <out-dir>/review-<repo>-pr<n>.html
# (default out-dir: pane-preview/). Extra flags go straight to pr-review;
# --debug-marks is on by default so the page can explain its marks (hold
# Shift). The PR's checkout is cached under $TMPDIR/deep-review, so the
# first run per PR needs GitHub access.
set -euo pipefail
cd "$(dirname "$0")/.."

out_dir="pane-preview"
flags=(--debug-marks --no-open)
inputs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --*) flags+=("$1"); shift ;;
    *) inputs+=("$1"); shift ;;
  esac
done
[ ${#inputs[@]} -gt 0 ] || { echo "usage: $0 [--out-dir DIR] [flags] slices-*.json..." >&2; exit 1; }
mkdir -p "$out_dir"

for slices in "${inputs[@]}"; do
  name=$(basename "$slices" .json)
  out="$out_dir/review-${name#slices-}.html"
  echo "→ $out" >&2
  pnpm exec tsx src/cli.ts --slices "$slices" --out "$out" "${flags[@]}"
done
