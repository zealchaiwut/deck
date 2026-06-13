#!/bin/bash
# antigravity-count.command — Ulanzi U-Studio deck key.
#
# Double-click (or deck key) to check how many Antigravity commits happened
# since you last checked, fire a banner, then reset the counter to 0.
#
# Runs standalone on double-click: absolute shebang, no interactive-shell deps.
# Safe if the counter file is missing (treated as 0). Never errors out.

# Resolve state dir from DECK_TOOLS_HOME, fallback to the deck-tools default.
STATE="${DECK_TOOLS_HOME:-$HOME/dev/deck/scripts}/deck_state"
COUNT_FILE="$STATE/antigravity_count.txt"

# Read count; missing/garbage => 0.
N="$(cat "$COUNT_FILE" 2>/dev/null)"
case "$N" in
  ''|*[!0-9]*) N=0 ;;
esac

if [ "$N" -gt 0 ]; then
  BODY="$N commit(s) since last check — resetting to 0"
  SOUND="Pop"
else
  BODY="Nothing new"
  SOUND="Pop"
fi

# Escape double quotes for AppleScript.
AS_BODY="${BODY//\"/\\\"}"
osascript -e "display notification \"$AS_BODY\" with title \"Antigravity\" sound name \"$SOUND\"" \
  >/dev/null 2>&1 || printf 'antigravity-count: banner failed (notifications may be blocked)\n' >&2

# Reset counter to 0 (create dir/file if needed).
mkdir -p "$STATE" 2>/dev/null
printf '0\n' > "$COUNT_FILE" 2>/dev/null || printf 'antigravity-count: failed to reset counter\n' >&2

exit 0
