#!/usr/bin/env bash
# claude-sessions.sh — read or simulate Claude Code hook session state as JSON.
#
# Inspect layer only — feeds Claude cycle tile later. See scripts/inspect/README.md.
#
# No HTTP server; pipe to jq or save to a file. Tile code is untouched.
#
# Usage:
#   ./scripts/claude-sessions.sh              # all sessions on disk
#   ./scripts/claude-sessions.sh --active     # working | waiting | done | live-idle
#   ./scripts/claude-sessions.sh --raw        # per-file hook JSON (no aggregation)
#   ./scripts/claude-sessions.sh simulate working  [session_id] [cwd]
#   ./scripts/claude-sessions.sh simulate waiting  [session_id] [cwd]
#   ./scripts/claude-sessions.sh simulate done     [session_id] [cwd]
#   ./scripts/claude-sessions.sh simulate idle     [session_id] [cwd]
#   ./scripts/claude-sessions.sh simulate end      [session_id] [cwd]
#
# Hook states written by cc-hook.sh:
#   idle     — SessionStart (chat open, no prompt yet)
#   working  — UserPromptSubmit
#   waiting  — Notification (needs you)
#   done     — Stop (turn finished)
#   end      — SessionEnd (file deleted)
#
# Display state: working | completed | idle  (cycle tile buckets)
# status:       working | needs you | completed | open  (finer hook view)
#
# runningTime = how long in the *current hook state* (working turn, waiting, etc.)
# processUptime = how long the claude tab/process has been open (separate field)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
SESS_DIR="$STATE_DIR/cc_sessions"
HOOK="$SCRIPT_DIR/cc-hook.sh"

simulate() {
  local state="${1:?state required: working|waiting|done|idle|end}"
  local sid="${2:-test-$(date +%s)}"
  local cwd="${3:-$HOME/dev/commander/coder}"
  local payload
  payload="$(printf '{"session_id":"%s","cwd":"%s"}' "$sid" "$cwd")"
  printf '%s' "$payload" | "$HOOK" "$state"
  echo "simulated $state -> $SESS_DIR/$sid.json" >&2
  [ -f "$SESS_DIR/$sid.json" ] && cat "$SESS_DIR/$sid.json" >&2 || true
}

emit_json() {
  local mode="${1:-all}"
  python3 - "$SESS_DIR" "$mode" <<'PY'
import json, os, re, subprocess, sys, time

sess_dir, mode = sys.argv[1], sys.argv[2]
now = int(time.time())
FRESH = 20 * 60

def format_age(sec):
    s = max(0, int(sec))
    if s < 5: return "now"
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s//60}m"
    if s < 86400: return f"{s//3600}h"
    return f"{s//86400}d"

def status_word(state):
    return {
        "working": "working",
        "waiting": "needs you",
        "done": "completed",
        "idle": "open",
    }.get(state, state)

def bucket_state(state):
    if state == "working":
        return "working"
    if state == "done":
        return "completed"
    return "idle"

def display_project(cwd):
    parts = [p for p in cwd.rstrip("/").split("/") if p]
    try:
        i = parts.index("dev")
        if i + 1 < len(parts):
            return parts[i + 1]
    except ValueError:
        pass
    return "-"

def parse_etime(raw):
    t = (raw or "").strip()
    if not t:
        return None
    days = 0
    clock = t
    if "-" in t:
        d, clock = t.split("-", 1)
        days = int(d) if d.isdigit() else 0
    parts = [int(x) for x in clock.split(":") if x.isdigit()]
    h = m = s = 0
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        m, s = parts
    elif len(parts) == 1:
        s = parts[0]
    return days * 86400 + h * 3600 + m * 60 + s

def live_processes():
    """All local claude PIDs: cwd, optional --resume session id, process uptime."""
    procs = []
    try:
        pids = subprocess.check_output(["pgrep", "-x", "claude"], text=True).strip().splitlines()
    except subprocess.CalledProcessError:
        return procs
    for pid in pids:
        pid = pid.strip()
        if not pid:
            continue
        try:
            lsof = subprocess.check_output(
                ["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], text=True, stderr=subprocess.DEVNULL
            )
            cwd = next((ln[1:] for ln in lsof.splitlines() if ln.startswith("n")), "")
            args = subprocess.check_output(
                ["ps", "-p", pid, "-o", "args="], text=True, stderr=subprocess.DEVNULL
            ).strip()
            resume = None
            m = re.search(r"--resume\s+([0-9a-f-]{8,})", args, re.I)
            if m:
                resume = m.group(1)
            etime = subprocess.check_output(["ps", "-p", pid, "-o", "etime="], text=True, stderr=subprocess.DEVNULL)
            elapsed = parse_etime(etime)
            started = now - elapsed if elapsed is not None else now
            procs.append({
                "pid": pid,
                "cwd": cwd,
                "resumeId": resume,
                "processStartedAt": started,
                "processUptimeSec": elapsed if elapsed is not None else 0,
            })
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    return procs

def match_process(session_id, cwd, procs):
    for p in procs:
        rid = p.get("resumeId")
        if session_id and rid and rid == session_id:
            return p
    for p in procs:
        pc = p.get("cwd") or ""
        if not pc or not cwd:
            continue
        if cwd == pc or cwd.startswith(pc + "/") or pc.startswith(cwd + "/"):
            return p
    return None

def running_sec(obj, age):
    """Seconds in the current hook state — not process/tab uptime."""
    state = str(obj.get("state") or "")
    ts = int(obj.get("ts") or 0)
    if state == "working":
        t = int(obj.get("turnStartedAt") or 0) or ts
        return max(0, now - t) if t else age
    if state in ("waiting", "done", "idle"):
        return age if ts else 0
    return age

procs = live_processes()
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
        sid = fn[:-5]
        state = str(obj.get("state") or "")
        ts = int(obj.get("ts") or 0)
        age = now - ts if ts else 0
        cwd = str(obj.get("cwd") or "")
        role = str(obj.get("label") or "") or os.path.basename(cwd.rstrip("/")) or "session"
        project = display_project(cwd)
        proc = match_process(sid, cwd, procs)
        process_open = proc is not None
        proc_uptime = int(proc["processUptimeSec"]) if proc else 0
        stale = state in ("working", "waiting") and age > FRESH and not process_open
        bucket = bucket_state(state)
        run_sec = 0 if bucket == "idle" else running_sec(obj, age)

        if mode == "active":
            if state in ("working", "waiting", "done"):
                pass
            elif state == "idle" and process_open:
                pass
            else:
                continue

        sessions.append({
            "id": sid,
            "name": role,
            "role": role,
            "project": project,
            "cwd": cwd,
            "hookState": state,
            "status": status_word(state),
            "state": bucket,
            "processOpen": process_open,
            "live": process_open,
            "runningSec": run_sec,
            "runningTime": "0" if bucket == "idle" else format_age(run_sec),
            "processUptimeSec": proc_uptime,
            "processUptime": format_age(proc_uptime),
            "pid": proc["pid"] if proc else None,
            "ts": ts,
            "startedAt": int(obj.get("startedAt") or ts or 0),
            "turnStartedAt": int(obj.get("turnStartedAt") or 0) or None,
            "stale": stale,
        })

def rank(s):
    if s["hookState"] == "working":
        return 0
    if s["hookState"] == "waiting":
        return 1
    if s["hookState"] == "idle" and s["processOpen"]:
        return 2
    if s["hookState"] == "done":
        return 3
    return 4

sessions.sort(key=lambda s: (rank(s), -s["runningSec"]))

out = {
    "source": "cc_sessions",
    "stateDir": sess_dir,
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
    "count": len(sessions),
    "liveProcesses": [
        {
            "pid": p["pid"],
            "cwd": p["cwd"],
            "resumeId": p.get("resumeId"),
            "processUptimeSec": p.get("processUptimeSec"),
            "processUptime": format_age(p.get("processUptimeSec") or 0),
        }
        for p in procs
    ],
    "sessions": sessions,
    "hooks": {
        "idle": ["SessionStart"],
        "working": ["UserPromptSubmit"],
        "waiting": ["Notification"],
        "done": ["Stop"],
        "end": ["SessionEnd"],
    },
    "note": "runningTime = seconds in current hook state; processUptime = tab open duration",
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
    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown command: $1 (try --help)" >&2
    exit 1
    ;;
esac
