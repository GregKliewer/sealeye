#!/bin/bash
# Turn each failing test in npm test's output into an annotation on the run, so the
# reason can be read from the check run's annotations as well as from its log.
# Usage: annotate-failures.sh <test output file>
set -uo pipefail
file="${1:?usage: annotate-failures.sh <test output file>}"
[ -f "$file" ] || exit 0
n=0
while IFS= read -r line; do
  start="${line%%:*}"
  # The failure and what node --test prints under it, up to 60 lines.
  block="$(sed -n "${start},$((start + 60))p" "$file")"
  title="$(printf '%s' "${line#*:}" | sed 's/^not ok [0-9]* - //')"
  block="${block//'%'/'%25'}"; block="${block//$'\r'/'%0D'}"; block="${block//$'\n'/'%0A'}"
  echo "::error title=${title//[:,]/ }::${block}"
  n=$((n + 1))
  [ "$n" -ge 10 ] && break
done < <(grep -n '^ *not ok ' "$file" | grep -v ' # SKIP')
exit 0
