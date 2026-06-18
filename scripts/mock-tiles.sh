#!/usr/bin/env bash
# mock-tiles.sh — preview deck tile content from inspect scripts (no Ulanzi plugin).
#
# Usage:
#   ./scripts/mock-tiles.sh
#   ./scripts/mock-tiles.sh --api http://100.103.104.41:8000
#   ./scripts/mock-tiles.sh --cursor-idx 0 --claude-idx 0 --sprint-idx 0
#
# Tiles mocked:
#   1. Cursor cycle   — runningTime + state (host: project / name)
#   2. Commander sprint — running sprint progress (tap to cycle projects)
#   3. Claude cycle   — skip state=idle; runningTime + status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_IDX=0
CLAUDE_IDX=0
SPRINT_IDX=0
API_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --cursor-idx) CURSOR_IDX="$2"; shift 2 ;;
    --claude-idx) CLAUDE_IDX="$2"; shift 2 ;;
    --sprint-idx) SPRINT_IDX="$2"; shift 2 ;;
    --api) API_ARGS=(--api "$2"); shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown: $1" >&2; exit 1 ;;
  esac
done

export CURSOR_IDX CLAUDE_IDX SPRINT_IDX
CURSOR_JSON="$("$SCRIPT_DIR/cursor-sessions.sh" --active 2>/dev/null || echo '{"sessions":[]}')"
CLAUDE_JSON="$("$SCRIPT_DIR/claude-sessions.sh" --active 2>/dev/null || echo '{"sessions":[]}')"
CMD_JSON="$("$SCRIPT_DIR/commander-status.sh" "${API_ARGS[@]}" --sprints 2>/dev/null || echo '{"sprints":[]}')"

python3 - <<'PY' "$CURSOR_JSON" "$CLAUDE_JSON" "$CMD_JSON"
import json, os, sys

cursor = json.loads(sys.argv[1])
claude = json.loads(sys.argv[2])
cmd = json.loads(sys.argv[3])
ci = int(os.environ.get("CURSOR_IDX", "0"))
ai = int(os.environ.get("CLAUDE_IDX", "0"))
si = int(os.environ.get("SPRINT_IDX", "0"))

ACCENT = {
    "working": "blue",
    "completed": "green",
    "idle": "grey",
}

def bar(color, w=24):
    c = {"blue": "█", "green": "█", "amber": "█", "teal": "█", "grey": "░"}.get(color, "█")
    return c * w

def tile_frame(title, accent, top, center, line1, line2, extra=""):
    w = 26
    print(f"\n{'═' * w}")
    print(f" {title}")
    print(f"{'═' * w}")
    print(f"│{bar(accent, w - 2)}│  ← accent ({accent})")
    print(f"│{' ' * (w - 2)}│")
    top_s = (top or "")[: w - 4]
    cen = (center or "—")[:8]
    print(f"│  {top_s:<{w - 6}}│  ← top label")
    print(f"│{' ' * ((w - 2 - len(cen)) // 2)}{cen}{' ' * (w - 2 - (w - 2 - len(cen)) // 2 - len(cen))}│  ← BIG value")
    print(f"│{' ' * (w - 2)}│")
    print(f"│  host: {line1:<{w - 10}}│")
    print(f"│        {line2:<{w - 10}}│")
    if extra:
        for ln in extra.split("\n"):
            print(f"│  {ln:<{w - 4}}│")
    print(f"{'═' * w}")

# --- 1. Cursor cycle ---
cs = cursor.get("sessions") or []
if cs:
    n = len(cs)
    idx = ci % n
    s = cs[idx]
    pos = f" {idx + 1}/{n}" if n > 1 else ""
    st = s.get("state") or "idle"
    top = f"{st}{pos}"
    tile_frame(
        "TILE 1 · Cursor (cycle)",
        ACCENT.get(st, "grey"),
        top,
        s.get("runningTime") or "0",
        s.get("project") or s.get("name") or "-",
        s.get("name") or "-",
        f"tap → next ({n} sessions)",
    )
else:
    tile_frame("TILE 1 · Cursor (cycle)", "grey", "no session", "—", "-", "-", "no active cursor_sessions")

# --- 2. Commander sprint ---
ss = cmd.get("sprints") or []
api = cmd.get("apiBase") or "?"
if ss:
    n = len(ss)
    idx = si % n
    s = ss[idx]
    pos = f" {idx + 1}/{n}" if n > 1 else ""
    st = s.get("state") or "idle"
    accent = "teal" if st == "working" else "green" if st == "completed" else "grey"
    done, total = s.get("done", 0), s.get("total", 0)
    sprint = s.get("sprint") or "—"
    tile_frame(
        "TILE 2 · Commander sprint",
        accent,
        f"S{sprint}{pos} · {st}",
        f"{done}/{total}",
        s.get("name") or s.get("project") or "-",
        f"running {s.get('runningTime') or '0'}",
        f"api: {api}",
    )
else:
    tile_frame(
        "TILE 2 · Commander sprint",
        "grey",
        "no sprint",
        "—",
        "-",
        "-",
        f"api: {api}\n(use --api or commander_api.txt)",
    )

# --- 3. Claude cycle (skip idle) ---
all_claude = claude.get("sessions") or []
claude_list = [s for s in all_claude if s.get("state") != "idle"]
skipped = len(all_claude) - len(claude_list)

if claude_list:
    n = len(claude_list)
    idx = ai % n
    s = claude_list[idx]
    pos = f" {idx + 1}/{n}" if n > 1 else ""
    status = s.get("status") or s.get("hookState") or "?"
    st = s.get("state") or "idle"
    top = f"{status}{pos}"
    tile_frame(
        "TILE 3 · Claude (cycle, skip idle)",
        ACCENT.get(st, "blue"),
        top,
        s.get("runningTime") or "0",
        s.get("project") or "-",
        s.get("role") or s.get("name") or "-",
        f"cycle: {n} shown, {skipped} idle skipped",
    )
else:
    tile_frame(
        "TILE 3 · Claude (cycle, skip idle)",
        "grey",
        "no active",
        "—",
        "-",
        "-",
        f"{skipped} idle skipped, 0 in cycle",
    )

# Summary JSON for scripting
summary = {
    "cursor": {
        "count": len(cs),
        "index": ci % len(cs) if cs else None,
        "current": cs[ci % len(cs)] if cs else None,
    },
    "sprint": {
        "count": len(ss),
        "index": si % len(ss) if ss else None,
        "current": ss[si % len(ss)] if ss else None,
        "apiBase": api,
    },
    "claude": {
        "total": len(all_claude),
        "cycleCount": len(claude_list),
        "skippedIdle": skipped,
        "index": ai % len(claude_list) if claude_list else None,
        "current": claude_list[ai % len(claude_list)] if claude_list else None,
    },
}
print("\n--- JSON summary ---")
print(json.dumps(summary, indent=2))
PY
