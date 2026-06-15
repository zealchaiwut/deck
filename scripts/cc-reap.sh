#!/bin/bash
# cc-reap.sh — purge stale Claude Code session files from deck_state.
#
# Applies the same reap rules as the deckstatus plugin. Safe to run anytime;
# always exits 0.
#
# Usage: ./cc-reap.sh

STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cc_sessions"

SESSION_FRESH_SEC=$((20 * 60))
DONE_VISIBLE_SEC=$((30 * 60))
IDLE_REAP_SEC=$((2 * 60 * 60))
SESSION_REAP_SEC=$((6 * 60 * 60))

NOW="$(date +%s)"
reaped=0

[ -d "$SESS_DIR" ] || exit 0

for f in "$SESS_DIR"/*.json; do
  [ -f "$f" ] || continue
  state="$(grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
  ts="$(grep -oE '"ts"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*//')"
  label="$(grep -oE '"label"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
  cwd="$(grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
  [ -z "$ts" ] && ts=0
  age=$((NOW - ts))
  delete=0

  if [ -z "$label" ] && [ -z "$cwd" ]; then delete=1; fi
  if [ "$age" -gt "$SESSION_REAP_SEC" ]; then delete=1; fi
  if [ "$delete" -eq 0 ] && { [ "$state" = "working" ] || [ "$state" = "waiting" ]; } && [ "$age" -gt "$SESSION_FRESH_SEC" ]; then delete=1; fi
  if [ "$delete" -eq 0 ] && [ "$state" = "done" ] && [ "$age" -gt "$DONE_VISIBLE_SEC" ]; then delete=1; fi
  if [ "$delete" -eq 0 ] && [ "$state" = "idle" ] && [ "$age" -gt "$IDLE_REAP_SEC" ]; then delete=1; fi

  if [ "$delete" -eq 1 ]; then
    rm -f "$f" 2>/dev/null && reaped=$((reaped + 1))
  fi
done

echo "cc-reap: removed $reaped stale session file(s) from $SESS_DIR"
exit 0
