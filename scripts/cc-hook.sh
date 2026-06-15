#!/bin/bash
# cc-hook.sh — Claude Code session tracker for the deck.
#
# Called from Claude Code hooks (settings.json). Claude pipes the hook event
# JSON on stdin; we record this session's state in its own file so many
# concurrent sessions (iterm, commander coder/tester, ...) never clobber each
# other. The deck "Claude Code" tile aggregates these files into one light.
#
# Usage (from a hook):   cc-hook.sh <state>
#   <state> = idle | working | waiting | done | end
#     idle     -> SessionStart   (session opened, no prompt yet)
#     working  -> UserPromptSubmit (you sent a prompt; Claude is busy)
#     waiting  -> Notification     (Claude is blocked on you: permission/idle)
#     done     -> Stop             (turn finished; this session is idle)
#     end      -> SessionEnd       (session closed; remove its file)
#
# Per-session file: $STATE/cc_sessions/<session_id>.json
#   {"state","cwd","label","ts","startedAt","turnStartedAt"}
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

  extract_num() {
    printf '%s' "$JSON" \
      | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" \
      | head -1 \
      | sed -E "s/.*:[[:space:]]*//"
  }

  extract_file() {
    grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$FILE" 2>/dev/null \
      | head -1 | sed -E "s/.*:[[:space:]]*\"(.*)\"/\1/"
  }

  extract_file_num() {
    grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" "$FILE" 2>/dev/null \
      | head -1 | sed -E "s/.*:[[:space:]]*//"
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
    # Skip broken payloads (no real session id and no cwd).
    if { [ -z "$SID" ] || [ "$SID" = "unknown" ]; } && [ -z "$CWD" ]; then
      :
    else
      STARTED_AT="$TS"
      TURN_STARTED=""
      if [ -f "$FILE" ]; then
        existing_started="$(extract_file_num startedAt)"
        [ -n "$existing_started" ] && STARTED_AT="$existing_started"
        if [ -z "$CWD" ]; then
          existing_cwd="$(extract_file cwd)"
          [ -n "$existing_cwd" ] && CWD="$existing_cwd"
        fi
        if [ -z "$LABEL" ]; then
          existing_label="$(extract_file label)"
          [ -n "$existing_label" ] && LABEL="$existing_label"
        fi
      fi

      if [ "$STATE" = "working" ]; then
        TURN_STARTED="$TS"
      elif [ "$STATE" = "done" ]; then
        TURN_STARTED=""
      elif [ -f "$FILE" ]; then
        existing_turn="$(extract_file_num turnStartedAt)"
        [ -n "$existing_turn" ] && TURN_STARTED="$existing_turn"
      fi

      esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
      if [ -n "$TURN_STARTED" ]; then
        printf '{"state":"%s","cwd":"%s","label":"%s","ts":%s,"startedAt":%s,"turnStartedAt":%s}\n' \
          "$STATE" "$(esc "$CWD")" "$(esc "$LABEL")" "$TS" "$STARTED_AT" "$TURN_STARTED" \
          > "$FILE.tmp" 2>/dev/null && mv -f "$FILE.tmp" "$FILE" 2>/dev/null
      else
        printf '{"state":"%s","cwd":"%s","label":"%s","ts":%s,"startedAt":%s}\n' \
          "$STATE" "$(esc "$CWD")" "$(esc "$LABEL")" "$TS" "$STARTED_AT" \
          > "$FILE.tmp" 2>/dev/null && mv -f "$FILE.tmp" "$FILE" 2>/dev/null
      fi
    fi
  fi
} 2>/dev/null

exit 0
