#!/usr/bin/env bash
# cursor-hook.sh — Cursor session tracker for the deck.
#
# Called from Cursor hooks (~/.cursor/hooks.json). Cursor pipes the hook event
# JSON on stdin. We record this conversation's state in its own file so the deck
# "Cursor" tile can show working / idle / done per workspace.
#
# Usage (from a hook):   cursor-hook.sh <state>
#   <state> = working | done | start | end
#     working -> beforeSubmitPrompt   done -> stop
#     start   -> sessionStart         end  -> sessionEnd
#
# Per-session file: $STATE/cursor_sessions/<conversation_id>.json
#   {"state","cwd","label","ts"}
#
# Cursor hook protocol: exit 0 = success (we never block). We also emit
# {"passed":true} on stdout so the hook is well-formed.

STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cursor_sessions"
STATE="${1:-}"

{
  mkdir -p "$SESS_DIR" 2>/dev/null
  JSON="$(cat)"

  # If no explicit arg, derive the state from the event name in the payload.
  if [ -z "$STATE" ]; then
    ev="$(printf '%s' "$JSON" | grep -oE '"hook_?[eE]vent_?[nN]ame"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
    case "$ev" in
      beforeSubmitPrompt|afterFileEdit) STATE=working ;;
      stop)         STATE=done ;;
      sessionStart) STATE=done ;;   # present but idle
      sessionEnd)   STATE=end ;;
      *)            STATE=working ;;
    esac
  fi

  # session id: conversation_id (fallback generation id, else workspace path).
  sid="$(printf '%s' "$JSON" | grep -oE '"conversation_?[Ii]d"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
  # workspace path: first /Users/... string in the payload (workspace_roots).
  cwd="$(printf '%s' "$JSON" | grep -oE '/Users/[^"]+' | head -1)"
  [ -z "$sid" ] && sid="$(printf '%s' "$cwd" | tr -c 'A-Za-z0-9._-' '-')"
  [ -z "$sid" ] && sid="cursor"
  label="$(basename "$cwd" 2>/dev/null)"
  ts="$(date +%s)"
  file="$SESS_DIR/$sid.json"

  if [ "$STATE" = "end" ]; then
    rm -f "$file" 2>/dev/null
  else
    esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
    printf '{"state":"%s","cwd":"%s","label":"%s","ts":%s}\n' \
      "$STATE" "$(esc "$cwd")" "$(esc "$label")" "$ts" \
      > "$file.tmp" 2>/dev/null && mv -f "$file.tmp" "$file" 2>/dev/null
  fi
} 2>/dev/null

echo '{"passed":true}'
exit 0
