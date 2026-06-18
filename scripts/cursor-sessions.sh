#!/usr/bin/env bash
# cursor-sessions.sh — read or simulate Cursor hook session state as JSON.
#
# Inspect layer only — feeds Cursor cycle tile later. See scripts/inspect/README.md.
#
# No HTTP server; pipe to jq or save to a file. Tile code is untouched.
#
# Usage:
#   ./scripts/cursor-sessions.sh              # all sessions on disk
#   ./scripts/cursor-sessions.sh --active     # working | waiting | done only
#   ./scripts/cursor-sessions.sh --raw        # per-file hook JSON (no aggregation)
#   ./scripts/cursor-sessions.sh simulate working [name] [cwd]
#   ./scripts/cursor-sessions.sh simulate done    [name] [cwd]
#   ./scripts/cursor-sessions.sh simulate end     [name] [cwd]
#
# Hook states written by cursor-hook.sh:
#   working  — beforeSubmitPrompt, afterFileEdit, postToolUse
#   done     — stop, sessionStart (turn finished / chat ready)
#   end      — sessionEnd (file deleted)
#
# Display state mapping (for cycle tile planning):
#   working  -> working
#   done     -> completed
#   waiting  -> idle   (hook exists in schema; not wired in install-cursor-hooks yet)
#
# Running time = seconds since last hook write (ts). Cursor hook does not yet
# record startedAt / turnStartedAt (unlike cc-hook.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cursor_sessions"
HOOK="$SCRIPT_DIR/cursor-hook.sh"

format_age() {
  python3 - "$1" <<'PY'
import sys
s = max(0, int(sys.argv[1]))
if s < 5: print("now")
elif s < 60: print(f"{s}s")
elif s < 3600: print(f"{s//60}m")
elif s < 86400: print(f"{s//3600}h")
else: print(f"{s//86400}d")
PY
}

hook_to_display() {
  case "$1" in
    working) echo working ;;
    waiting) echo idle ;;
    done)    echo completed ;;
    idle)    echo idle ;;
    *)       echo "$1" ;;
  esac
}

simulate() {
  local state="${1:?state required: working|done|end}"
  local name="${2:-test-$(date +%s)}"
  local cwd="${3:-$HOME/dev/deck}"
  local payload
  payload="$(printf '{"conversation_id":"%s","workspace_roots":["%s"],"cwd":"%s"}' \
    "$name" "$cwd" "$cwd")"
  printf '%s' "$payload" | "$HOOK" "$state"
  echo "simulated $state -> $SESS_DIR/$name.json" >&2
  [ -f "$SESS_DIR/$name.json" ] && cat "$SESS_DIR/$name.json" >&2 || true
}

emit_json() {
  local mode="${1:-all}"
  python3 - "$SESS_DIR" "$mode" <<'PY'
import json, os, sys, time

sess_dir, mode = sys.argv[1], sys.argv[2]
now = int(time.time())
FRESH = 20 * 60
DONE_VIS = 30 * 60

def format_age(sec):
    s = max(0, int(sec))
    if s < 5: return "now"
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s//60}m"
    if s < 86400: return f"{s//3600}h"
    return f"{s//86400}d"

def display_state(state):
    return {"working": "working", "waiting": "idle", "done": "completed", "idle": "idle"}.get(state, state)

def project_from_cwd(cwd):
    parts = [p for p in cwd.rstrip("/").split("/") if p]
    try:
        i = parts.index("dev")
        if i + 1 < len(parts):
            return parts[i + 1]
    except ValueError:
        pass
    return parts[-1] if parts else ""

sessions = []
if os.path.isdir(sess_dir):
    for fn in sorted(os.listdir(sess_dir)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(sess_dir, fn)
        try:
            with open(path) as f:
                obj = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        state = str(obj.get("state") or "")
        ts = int(obj.get("ts") or 0)
        age = now - ts if ts else 0
        cwd = str(obj.get("cwd") or "")
        label = str(obj.get("label") or "") or os.path.basename(cwd) or "session"
        stale = state in ("working", "waiting") and age > FRESH
        if mode == "active" and state not in ("working", "waiting", "done"):
            continue
        sessions.append({
            "id": fn[:-5],
            "name": label,
            "project": project_from_cwd(cwd) or label,
            "cwd": cwd,
            "hookState": state,
            "state": display_state(state),
            "runningSec": age,
            "runningTime": format_age(age),
            "ts": ts,
            "stale": stale,
        })

rank = {"working": 0, "waiting": 1, "done": 2}
sessions.sort(key=lambda s: (rank.get(s["hookState"], 9), s["runningSec"]))

out = {
    "source": "cursor_sessions",
    "stateDir": sess_dir,
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
    "count": len(sessions),
    "sessions": sessions,
    "hooks": {
        "working": ["beforeSubmitPrompt", "afterFileEdit", "postToolUse"],
        "done": ["stop", "sessionStart"],
        "end": ["sessionEnd"],
    },
    "note": "runningSec is time since last hook event (ts), not full chat uptime",
}
print(json.dumps(out, indent=2))
PY
}

case "${1:-list}" in
  simulate)
    shift
    simulate "$@"
    ;;
  --raw)
    mkdir -p "$SESS_DIR"
    if ! ls "$SESS_DIR"/*.json >/dev/null 2>&1; then
      echo '[]'
      exit 0
    fi
    python3 - "$SESS_DIR" <<'PY'
import json, glob, os, sys
paths = sorted(glob.glob(os.path.join(sys.argv[1], "*.json")))
print(json.dumps([json.load(open(p)) for p in paths], indent=2))
PY
    ;;
  --active)
    emit_json active
    ;;
  list|"")
    emit_json all
    ;;
  -h|--help)
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown command: $1 (try --help)" >&2
    exit 1
    ;;
esac
