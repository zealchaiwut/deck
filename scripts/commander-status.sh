#!/usr/bin/env bash
# commander-status.sh — Commander dashboard sprint/project/agent status as JSON.
#
# Inspect layer only — feeds sprint/agents tiles later. See scripts/inspect/README.md.
#
# API base (first match wins):
#   1. --api URL          one-shot
#   2. COMMANDER_API env
#   3. deck_state/commander_api.txt (one line)
#   4. http://127.0.0.1:8001
#
# Usage:
#   ./scripts/commander-status.sh
#   ./scripts/commander-status.sh --api http://100.103.104.41:8000
#   ./scripts/commander-status.sh --set-api http://100.103.104.41:8000
#   ./scripts/commander-status.sh --sprints | jq '.sprints'
#   ./scripts/commander-status.sh --agents  | jq '.agents'
#
# Display state on each row: working | completed | idle
# runningSec / runningTime = sprint elapsed or agent time since last_seen.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
API_FILE="$STATE_DIR/commander_api.txt"
DEFAULT_API="${COMMANDER_API_DEFAULT:-http://127.0.0.1:8001}"
CURL_TIMEOUT="${COMMANDER_CURL_TIMEOUT:-8}"
API_OVERRIDE=""
MODE="all"
SET_API=""

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_OVERRIDE="${2:?URL required}"; shift 2 ;;
    --set-api) SET_API="${2:?URL required}"; shift 2 ;;
    --sprints|--agents|--projects) MODE="${1#--}"; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$STATE_DIR"

if [ -n "$SET_API" ]; then
  printf '%s\n' "$SET_API" > "$API_FILE"
  echo "wrote $API_FILE -> $SET_API" >&2
fi

resolve_api() {
  if [ -n "$API_OVERRIDE" ]; then printf '%s' "$API_OVERRIDE"; return; fi
  if [ -n "${COMMANDER_API:-}" ]; then printf '%s' "$COMMANDER_API"; return; fi
  if [ -f "$API_FILE" ]; then tr -d '[:space:]' < "$API_FILE"; return; fi
  printf '%s' "$DEFAULT_API"
}

API="$(resolve_api)"
API="${API%/}"

curl_json() {
  curl -sf -m "$CURL_TIMEOUT" "${API}$1" 2>/dev/null || echo ""
}

HOME_JSON="$(curl_json /api/home)"
SPRINT_JSON="$(curl_json /api/sprint-status)"
ISSUES_JSON="$(curl_json /api/issues)"
AGENTS_JSON="$(curl_json /api/agents)"

# Per-repo sprint progress for running projects (nav-pill source).
PROG_JSON='{}'
if [ -n "$HOME_JSON" ]; then
  PROG_JSON="$(HOME_JSON="$HOME_JSON" API="$API" CURL_TIMEOUT="$CURL_TIMEOUT" python3 - <<'PY'
import json, os, subprocess, urllib.parse
home = json.loads(os.environ.get("HOME_JSON") or "{}")
api = os.environ["API"].rstrip("/")
timeout = os.environ.get("CURL_TIMEOUT", "8")
out = {}
for p in home.get("projects") or []:
    repo = str(p.get("repo") or "")
    status = str(p.get("status") or "")
    if status != "running" and not p.get("sprint_running"):
        continue
    if not repo:
        continue
    q = urllib.parse.urlencode({"repo": repo, "project": repo})
    r = subprocess.run(
        ["curl", "-sf", "-m", timeout, f"{api}/api/sprint-progress?{q}"],
        capture_output=True, text=True,
    )
    if r.returncode == 0 and r.stdout.strip():
        try:
            out[repo] = json.loads(r.stdout)
        except json.JSONDecodeError:
            pass
print(json.dumps(out))
PY
)"
fi

export API MODE HOME_JSON SPRINT_JSON ISSUES_JSON AGENTS_JSON PROG_JSON
python3 - <<'PY'
import json, os, re, sys
from datetime import datetime, timezone

api = os.environ["API"]
mode = os.environ.get("MODE", "all")
home_raw = os.environ.get("HOME_JSON") or ""
sprint_raw = os.environ.get("SPRINT_JSON") or ""
issues_raw = os.environ.get("ISSUES_JSON") or ""
agents_raw = os.environ.get("AGENTS_JSON") or ""
prog_raw = os.environ.get("PROG_JSON") or "{}"
DONE_COL = re.compile(r"done|merged|approved|uat|complete|closed", re.I)

def parse(raw):
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None

def format_age(sec):
    s = max(0, int(sec))
    if s < 5: return "now"
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s//60}m"
    if s < 86400: return f"{s//3600}h"
    return f"{s//86400}d"

def display_sprint_state(run_state, project_status, done, total):
    if run_state == "finished" or (total and done >= total):
        return "completed"
    if run_state == "running" or project_status == "running":
        return "working"
    return "idle"

def display_agent_state(status):
    st = (status or "").lower()
    if st == "working":
        return "working"
    if st in ("completed", "done"):
        return "completed"
    return "idle"

now = datetime.now(timezone.utc)
home = parse(home_raw)

if not home or not isinstance(home.get("projects"), list):
    print(json.dumps({
        "source": "commander",
        "apiBase": api,
        "offline": True,
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "projects": [],
        "sprints": [],
        "agents": [],
        "error": "could not reach /api/home",
    }, indent=2))
    sys.exit(0)

sprint_status = parse(sprint_raw) or {}
issues = parse(issues_raw) or []
if not isinstance(issues, list):
    issues = []

running_by_repo = {}
for rs in sprint_status.get("running_sprints") or []:
    repo = str(rs.get("project") or "")
    running_by_repo[repo] = rs

projects = []
sprints = []

# Sprint progress per repo from /api/sprint-progress
prog_cache = parse(prog_raw) or {}
if not isinstance(prog_cache, dict):
    prog_cache = {}

for p in sorted(home["projects"], key=lambda x: str(x.get("slug") or "")):
    slug = str(p.get("slug") or "")
    repo = str(p.get("repo") or "")
    name = str(p.get("name") or slug)
    status = str(p.get("status") or "idle")
    sr = p.get("sprint_running") or {}
    elapsed = int(sr.get("elapsed_sec") or 0)
    rs = running_by_repo.get(repo) or {}
    if not elapsed:
        elapsed = int(rs.get("wall_clock_secs") or 0)

    prog = prog_cache.get(repo) or {}
    has_sprint = bool(prog.get("has_sprint")) or bool(rs) or status == "running"

    done = int(prog.get("done") or 0)
    total = int(prog.get("total") or 0)
    sprint_num = int(prog.get("sprint") or 0) or None
    sprint_label = prog.get("sprint_label") or rs.get("sprint_label") or sr.get("label")
    run_state = str(prog.get("run_state") or ("running" if status == "running" or repo in running_by_repo else ""))

    issue_rows = rs.get("issues") or []
    if not total and issue_rows:
        total = len(issue_rows)
        done = sum(1 for i in issue_rows if str(i.get("status") or "").lower() in ("done", "completed", "closed"))
        if sprint_label:
            m = re.search(r"(\d+)", str(sprint_label))
            if m:
                sprint_num = int(m.group(1))

    if not total and sprint_label and issues:
        rows = [i for i in issues if any(
            (l.get("name") if isinstance(l, dict) else l) == sprint_label
            for l in (i.get("labels") or [])
        )]
        if rows:
            total = len(rows)
            done = sum(
                1 for i in rows
                if i.get("state") == "closed" or DONE_COL.search(str(i.get("column") or ""))
            )

    disp = display_sprint_state(run_state, status, done, total)
    projects.append({
        "name": slug,
        "project": name,
        "repo": repo,
        "status": status,
        "state": disp,
        "uatCount": int(p.get("uat_count") or 0),
        "backlogCount": int(p.get("backlog_count") or 0),
    })

    if has_sprint or status == "running" or repo in running_by_repo:
        sprints.append({
            "name": slug,
            "project": name,
            "repo": repo,
            "sprint": sprint_num or (str(sprint_label or "").replace("sprint-", "") or None),
            "sprintLabel": sprint_label,
            "hookState": run_state or status,
            "state": disp,
            "done": done,
            "total": total,
            "runningSec": elapsed,
            "runningTime": format_age(elapsed),
        })

rank = {"working": 0, "completed": 1, "idle": 2}
sprints.sort(key=lambda s: (rank.get(s["state"], 9), s["name"]))

agents = []
agents_list = parse(agents_raw)
if isinstance(agents_list, list):
    for a in agents_list:
        wd = str(a.get("working_dir") or "")
        parts = str(a.get("name") or "").split("·")
        role = parts[0] if parts else "agent"
        issue = next((p.replace("issue-", "#") for p in parts if p.startswith("issue-")), "")
        status = str(a.get("status") or "")
        last_seen = str(a.get("last_seen") or "")
        try:
            t = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
            age_sec = max(0, int((now - t).total_seconds()))
        except Exception:
            age_sec = 0
        disp = display_agent_state(status)
        if disp == "idle" and age_sec > 15 * 60:
            continue
        agents.append({
            "name": role,
            "role": role,
            "issue": issue,
            "project": "commander" if "commander" in wd.lower() else os.path.basename(wd.rstrip("/")) or role,
            "hookState": status,
            "state": disp,
            "lastTool": str(a.get("last_tool") or ""),
            "runningSec": age_sec,
            "runningTime": format_age(age_sec),
        })
    agents.sort(key=lambda x: (0 if x["state"] == "working" else 1, x["runningSec"]))

out = {
    "source": "commander",
    "apiBase": api,
    "offline": False,
    "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "count": {"projects": len(projects), "sprints": len(sprints), "agents": len(agents)},
    "projects": projects,
    "sprints": sprints,
    "agents": agents,
}

if mode == "projects":
    print(json.dumps({"apiBase": api, "projects": projects}, indent=2))
elif mode == "sprints":
    print(json.dumps({"apiBase": api, "sprints": sprints}, indent=2))
elif mode == "agents":
    print(json.dumps({"apiBase": api, "agents": agents}, indent=2))
else:
    print(json.dumps(out, indent=2))
PY
