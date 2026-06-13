#!/bin/bash
# notify-coding.sh — single entry point all coding-session hooks call to report
# a session state. This is the ONE place that decides what "notify" means
# (deck tile + optional push), so the hooks themselves stay dumb.
#
# Usage:  notify-coding.sh <tool> <state> [label]
#   <tool>  = cursor | antigravity | claude-code | terminal   (the source)
#   <state> = running | done | error
#   [label] = optional free text shown on the tile (branch, repo, exit code, ...)
#
# What it does:
#   - Always writes a deck tile for the tool (one tile per tool):
#       $STATE_DIR/tile_coding_<tool>.txt   short value, e.g. "DONE feat/x"
#       $STATE_DIR/tile_coding_<tool>.json  {"tool","state","label","value","color","ts"}
#     Color map: running->blue, done->green, error->red.
#   - Optionally pushes to ntfy (if NTFY_TOPIC set).
#   - Optionally fires a local macOS banner (if DECK_LOCAL_NOTIFY=1).
#
# Env vars:
#   DECK_STATE_DIR     dir for tile state files       (default ./deck_state/)
#   NTFY_TOPIC         ntfy topic; unset => skip push silently
#   NTFY_SERVER        ntfy base url                  (default https://ntfy.sh)
#   DECK_LOCAL_NOTIFY  "1" => also fire osascript banner (default off)
#
# Safety: safe to call rapidly from git hooks. Never blocks >~2s (curl timeout).
# ALWAYS exits 0 — failures log to stderr so they cannot break a git hook.
#
# Examples:
#   notify-coding.sh cursor running "feat/login"
#   notify-coding.sh claude-code done "main"
#   NTFY_TOPIC=mydeck notify-coding.sh antigravity error "exit 1"

set -u

log() { printf 'notify-coding: %s\n' "$*" >&2; }

# --- args -------------------------------------------------------------------
TOOL="${1:-}"
STATE="${2:-}"
LABEL="${3:-}"

if [ -z "$TOOL" ] || [ -z "$STATE" ]; then
  log "usage: notify-coding.sh <tool> <state> [label]"
  exit 0
fi

case "$TOOL" in
  cursor|antigravity|claude-code|terminal) ;;
  *) log "unknown tool '$TOOL' (expected cursor|antigravity|claude-code|terminal); continuing" ;;
esac

# --- state -> color + short value -------------------------------------------
case "$STATE" in
  running) COLOR="blue";  TAG="RUN" ;;
  done)    COLOR="green"; TAG="DONE" ;;
  error)   COLOR="red";   TAG="ERR" ;;
  *)
    log "unknown state '$STATE' (expected running|done|error); treating as error"
    STATE="error"; COLOR="red"; TAG="ERR"
    ;;
esac

if [ -n "$LABEL" ]; then
  VALUE="$TAG $LABEL"
else
  VALUE="$TAG"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- write deck tile --------------------------------------------------------
STATE_DIR="${DECK_STATE_DIR:-./deck_state}"
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  log "cannot create state dir '$STATE_DIR'"
fi

# JSON-escape a string (backslash, quote, control chars).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\t'/ }"
  s="${s//$'\r'/ }"
  printf '%s' "$s"
}

TXT_FILE="$STATE_DIR/tile_coding_${TOOL}.txt"
JSON_FILE="$STATE_DIR/tile_coding_${TOOL}.json"

# Write atomically-ish: temp then mv, so a poller never reads a half file.
if ! printf '%s\n' "$VALUE" > "$TXT_FILE.tmp" 2>/dev/null; then
  log "failed to write $TXT_FILE"
else
  mv -f "$TXT_FILE.tmp" "$TXT_FILE" 2>/dev/null || log "failed to move $TXT_FILE"
fi

JSON=$(printf '{"tool":"%s","state":"%s","label":"%s","value":"%s","color":"%s","ts":"%s"}\n' \
  "$(json_escape "$TOOL")" \
  "$(json_escape "$STATE")" \
  "$(json_escape "$LABEL")" \
  "$(json_escape "$VALUE")" \
  "$(json_escape "$COLOR")" \
  "$TS")

if ! printf '%s' "$JSON" > "$JSON_FILE.tmp" 2>/dev/null; then
  log "failed to write $JSON_FILE"
else
  mv -f "$JSON_FILE.tmp" "$JSON_FILE" 2>/dev/null || log "failed to move $JSON_FILE"
fi

# --- message text -----------------------------------------------------------
if [ -n "$LABEL" ]; then
  MSG="$TOOL $STATE: $LABEL"
else
  MSG="$TOOL $STATE"
fi

# --- optional ntfy push -----------------------------------------------------
if [ -n "${NTFY_TOPIC:-}" ]; then
  NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
  if [ "$STATE" = "error" ]; then
    PRIO="high"
  else
    PRIO="default"
  fi
  # --max-time 2 keeps us under the ~2s budget; failures are non-fatal.
  if ! curl -fsS --max-time 2 \
        -H "Title: coding/$TOOL" \
        -H "Priority: $PRIO" \
        -H "Tags: $COLOR" \
        -d "$MSG" \
        "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null 2>&1; then
    log "ntfy push failed (server=$NTFY_SERVER topic=$NTFY_TOPIC)"
  fi
fi

# --- optional local macOS banner --------------------------------------------
if [ "${DECK_LOCAL_NOTIFY:-}" = "1" ]; then
  # Escape double quotes for AppleScript string literals.
  AS_MSG="${MSG//\"/\\\"}"
  if ! osascript -e "display notification \"$AS_MSG\" with title \"coding/$TOOL\"" >/dev/null 2>&1; then
    log "osascript banner failed"
  fi
fi

exit 0
