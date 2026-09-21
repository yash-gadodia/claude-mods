#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
write=0; [ "${1:-}" = "--write" ] && write=1
fail=0
for d in */; do
  d=${d%/}
  [ -f "$d/.claude-plugin/plugin.json" ] || continue
  actual=$(claude plugin validate "$d" 2>&1 | grep -E '^[[:space:]]*❯ .* (hooks|calls|env reads):' | sed -E 's/^[[:space:]]*❯ //; s/ \(via [^)]*\)//g' | sort)
  if [ $write = 1 ]; then
    printf '%s\n' "$actual" > "$d/FOOTPRINT"
    echo "wrote $d/FOOTPRINT"
    continue
  fi
  if [ ! -f "$d/FOOTPRINT" ]; then echo "$d: no FOOTPRINT file (run scripts/footprint.sh --write)"; fail=1; continue; fi
  if ! diff <(printf '%s\n' "$actual") "$d/FOOTPRINT" >/dev/null; then
    echo "$d: footprint changed"
    diff <(printf '%s\n' "$actual") "$d/FOOTPRINT" || true
    fail=1
  else
    echo "$d: footprint matches"
  fi
done
exit $fail
