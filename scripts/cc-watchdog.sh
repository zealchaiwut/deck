#!/bin/bash
# cc-watchdog.sh — delete zombie working sessions with no live claude process.
#
# Covers iTerm tab kills where SessionEnd never fires. Matches session cwd to
# a running claude process cwd via lsof. Always exits 0.
#
# Usage: ./cc-watchdog.sh
# Optional launchd: scripts/com.deck.cc-watchdog.plist (every 60s)

STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cc_sessions"
MIN_AGE_SEC=300   # only check working sessions older than 5 min
NOW="$(date +%s)"
removed=0

[ -d "$SESS_DIR" ] || exit 0

# Newline-separated list of cwds with a live claude process.
LIVE_CWDS=""
while IFS= read -r pid; do
  [ -z "$pid" ] && continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [ -n "$cwd" ] && LIVE_CWDS="${LIVE_CWDS}${cwd}"$'\n'
done < <(pgrep -x claude 2>/dev/null || true)

cwd_live() {
  case "$LIVE_CWDS" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

for f in "$SESS_DIR"/*.json; do
  [ -f "$f" ] || continue
  state="$(grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
  [ "$state" = "working" ] || continue
  ts="$(grep -oE '"ts"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*//')"
  cwd="$(grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
  [ -z "$ts" ] && ts=0
  [ -z "$cwd" ] && continue
  age=$((NOW - ts))
  [ "$age" -lt "$MIN_AGE_SEC" ] && continue
  if ! cwd_live "$cwd"; then
    rm -f "$f" 2>/dev/null && removed=$((removed + 1))
  fi
done

[ "$removed" -gt 0 ] && echo "cc-watchdog: removed $removed zombie session(s)"
exit 0
