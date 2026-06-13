#!/bin/bash
# cc-hook.sh — Claude Code session tracker for the deck.
#
# Called from Claude Code hooks (settings.json). Claude pipes the hook event
# JSON on stdin; we record this session's state in its own file so many
# concurrent sessions (iterm, commander coder/tester, ...) never clobber each
# other. The deck "Claude Code" tile aggregates these files into one light.
#
# Usage (from a hook):   cc-hook.sh <state>
#   <state> = working | waiting | done | end
#     working  -> UserPromptSubmit (you sent a prompt; Claude is busy)
#     waiting  -> Notification     (Claude is blocked on you: permission/idle)
#     done     -> Stop             (turn finished; this session is idle)
#     end      -> SessionEnd       (session closed; remove its file)
#
# Per-session file: $STATE/cc_sessions/<session_id>.json
#   {"state","cwd","label","ts"}
#
# Hard rule: never block or fail a hook. Always exit 0.

STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cc_sessions"
STATE="${1:-working}"

{
  mkdir -p "$SESS_DIR" 2>/dev/null

  JSON="$(cat)"  # hook event JSON on stdin

  # Pure-bash extraction (Claude Code's JSON values here have no embedded quotes).
  extract() {
    printf '%s' "$JSON" \
      | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -1 \
      | sed -E "s/.*:[[:space:]]*\"(.*)\"/\1/"
  }

  SID="$(extract session_id)"
  [ -z "$SID" ] && SID="unknown"
  CWD="$(extract cwd)"
  # Identity: a custom DECK_SESSION (export before launching `claude`) wins, so
  # two sessions in the SAME repo (e.g. commander coder vs tester) stay distinct;
  # otherwise fall back to the repo folder name.
  LABEL="${DECK_SESSION:-$(basename "$CWD" 2>/dev/null)}"
  TS="$(date +%s)"

  FILE="$SESS_DIR/$SID.json"

  if [ "$STATE" = "end" ]; then
    rm -f "$FILE" 2>/dev/null
  else
    # JSON-escape backslashes/quotes in cwd/label just in case.
    esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
    printf '{"state":"%s","cwd":"%s","label":"%s","ts":%s}\n' \
      "$STATE" "$(esc "$CWD")" "$(esc "$LABEL")" "$TS" \
      > "$FILE.tmp" 2>/dev/null && mv -f "$FILE.tmp" "$FILE" 2>/dev/null
  fi
} 2>/dev/null

exit 0
