#!/usr/bin/env bash
# cursor-hook.sh — Cursor session tracker for the deck.
#
# Called from Cursor hooks (~/.cursor/hooks.json). Cursor pipes the hook event
# JSON on stdin. We record this conversation's state in its own file so the deck
# "Cursor" tile can show working / idle / done per workspace.
#
# Usage (from a hook):   cursor-hook.sh <state>
#   <state> = working | waiting | done | end
#     working  -> beforeSubmitPrompt, afterFileEdit, postToolUse
#     waiting  -> (future) beforeShellExecution ask
#     done     -> stop, sessionStart
#     end      -> sessionEnd
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
      beforeSubmitPrompt|afterFileEdit|postToolUse) STATE=working ;;
      stop|sessionStart) STATE=done ;;
      sessionEnd)   STATE=end ;;
      *)            STATE=working ;;
    esac
  fi

  # sessionStart historically passed "start" — treat as idle/ready.
  [ "$STATE" = "start" ] && STATE=done

  extract() {
    printf '%s' "$JSON" \
      | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -1 \
      | sed -E "s/.*:[[:space:]]*\"(.*)\"/\1/"
  }

  sid="$(extract conversation_id)"
  [ -z "$sid" ] && sid="$(extract conversationId)"

  # Prefer workspace_roots[0], then cwd — never grab arbitrary file paths.
  cwd="$(printf '%s' "$JSON" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    roots = d.get("workspace_roots") or d.get("workspaceRoots") or []
    cwd = d.get("cwd") or (roots[0] if roots else "")
    print(cwd or "")
except Exception:
    print("")
' 2>/dev/null)"
  [ -z "$cwd" ] && cwd="$(extract cwd)"

  [ -z "$sid" ] && sid="$(printf '%s' "$cwd" | tr -c 'A-Za-z0-9._-' '-')"
  [ -z "$sid" ] && sid="cursor"
  # DECK_SESSION wins for disambiguation (same repo, multiple chats).
  label="${DECK_SESSION:-$(basename "$cwd" 2>/dev/null)}"
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
