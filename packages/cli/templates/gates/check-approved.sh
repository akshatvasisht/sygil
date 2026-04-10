#!/usr/bin/env bash
# Gate: passes if review/verdict.txt contains APPROVED
VERDICT_FILE="${1:-review/verdict.txt}"
if [ ! -f "$VERDICT_FILE" ]; then
  echo "verdict file not found: $VERDICT_FILE" >&2
  exit 1
fi
grep -q "APPROVED" "$VERDICT_FILE"
