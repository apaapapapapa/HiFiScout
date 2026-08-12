#!/usr/bin/env bash
set -euo pipefail
mapfile -t files < <(git ls-files '*.js' '*.mjs' '*.cjs' '*.jsx')
if ((${#files[@]} > 0)); then
  printf 'Tracked first-party JavaScript source/config is forbidden after Phase 2.5:\n' >&2
  printf ' - %s\n' "${files[@]}" >&2
  exit 1
fi
echo 'No tracked first-party JavaScript source/config files found.'
