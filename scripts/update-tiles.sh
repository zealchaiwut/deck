#!/bin/bash
# update-tiles.sh — emit styled tile_<name>.json into deck_state from live
# sources, so the plugin's "Status Tile" (agent/gauge/ring/timestat) can render
# real data. Read-only on every source; only writes tile_*.json. Always exits 0.
#
# Sources: commander dashboard API, the antigravity git project, Claude Code
# sessions (cc_sessions), Cursor AI-code DB, GitHub API rate limit.

SD="${DECK_STATE_DIR:-$HOME/dev/deck/scripts/deck_state}"
mkdir -p "$SD" 2>/dev/null

w() { # w <name> <json>
  printf '%s' "$2" > "$SD/tile_$1.json.tmp" 2>/dev/null && mv -f "$SD/tile_$1.json.tmp" "$SD/tile_$1.json" 2>/dev/null
}

# --- commander sprint -> ring (closed/total) --------------------------------
# sprint-status reports 0/0 for running sprints, so derive closed/total from the
# issues carrying the sprint's exact label (e.g. "sprint-66.5").
{
  API="$(cat "$SD/commander_api.txt" 2>/dev/null || echo http://127.0.0.1:8001)"
  sj="$(curl -s -m3 "$API/api/sprint-status" 2>/dev/null)"
  ij="$(curl -s -m6 "$API/api/issues" 2>/dev/null)"  # GitHub-backed, can be slow
  if [ -n "$sj" ]; then
    line="$(SJ="$sj" IJ="$ij" python3 -c 'import os,json
try:
 d=json.loads(os.environ["SJ"]); r=(d.get("running_sprints") or [{}])[0]
 full=r.get("sprint_label") or ""; p=r.get("progress") or {}
 closed=p.get("closed",0) or 0; total=p.get("total",0) or 0
 if not total:
  try:
   iss=json.loads(os.environ.get("IJ") or "[]")
   rows=[i for i in iss if any(((l.get("name") if isinstance(l,dict) else l)==full) for l in (i.get("labels") or []))]
   done=("done","merged","approved","uat","complete","closed")
   total=len(rows); closed=sum(1 for i in rows if i.get("state")=="closed" or (i.get("column") or "") in done)
  except Exception: pass
 print(closed, total, full.replace("sprint-",""))
except Exception: print(0,0,"")' 2>/dev/null)"
    set -- $line; closed="${1:-0}"; total="${2:-0}"; label="${3:-}"
    st="running"; [ "$total" != "0" ] && [ "$closed" = "$total" ] && st="done"
    [ -n "$label" ] && w sprint "{\"count\":\"$closed/$total\",\"state\":\"$st\",\"label\":\"s$label\"}"
  fi
} 2>/dev/null

# --- antigravity -> timestat (latest commit age + hash) ---------------------
{
  PROJ="$(cat "$SD/antigravity_project.txt" 2>/dev/null || echo "$HOME/dev/commander/prd")"
  PROJ="${PROJ/#\~/$HOME}"
  if git -C "$PROJ" rev-parse >/dev/null 2>&1; then
    set -- $(git -C "$PROJ" log -1 --format='%h %ct' 2>/dev/null); h="$1"; ct="$2"
    now="$(date +%s)"; age=$(( now - ${ct:-now} ))
    if   [ "$age" -lt 3600 ];  then v="$((age/60))m"
    elif [ "$age" -lt 86400 ]; then v="$((age/3600))h"
    else v="$((age/86400))d"; fi
    st="running"; [ "$age" -gt 86400 ] && st="idle"
    w antigravity "{\"value\":\"$v\",\"label\":\"$h\",\"state\":\"$st\"}"
  fi
} 2>/dev/null

# --- claude sessions -> agent (working/total, pulse when working) -----------
{
  CC="$SD/cc_sessions"
  if [ -d "$CC" ]; then
    total=0; work=0
    for f in "$CC"/*.json; do
      [ -f "$f" ] || continue; total=$((total+1))
      grep -q '"state":"working"' "$f" && work=$((work+1))
    done
    st="idle"; [ "$work" -gt 0 ] && st="running"
    w claude "{\"count\":\"$work/$total\",\"state\":\"$st\",\"label\":\"claude\"}"
  fi
} 2>/dev/null

# --- cursor -> agent (AI snippets today, pulse when generating) -------------
{
  DB="$HOME/.cursor/ai-tracking/ai-code-tracking.db"
  SQ="$(command -v sqlite3 || echo /usr/bin/sqlite3)"
  if [ -f "$DB" ]; then
    now_ms=$(( $(date +%s) * 1000 )); rec=$(( now_ms - 900000 ))
    mid=$(( $(date -v0H -v0M -v0S +%s) * 1000 ))
    out="$("$SQ" -readonly "$DB" "SELECT (SELECT COUNT(*) FROM ai_code_hashes WHERE source='composer' AND createdAt>=$rec),(SELECT COUNT(*) FROM ai_code_hashes WHERE source='composer' AND createdAt>=$mid);" 2>/dev/null)"
    recent="${out%%|*}"; today="${out##*|}"
    st="idle"; [ "${recent:-0}" -gt 0 ] && st="running"
    w cursor "{\"value\":\"${today:-0}\",\"state\":\"$st\",\"label\":\"cursor\"}"
  fi
} 2>/dev/null

# --- github -> gauge (REST rate-limit % used) -------------------------------
{
  GH="$(command -v gh || echo /opt/homebrew/bin/gh)"
  rl="$("$GH" api /rate_limit 2>/dev/null)"
  if [ -n "$rl" ]; then
    pct="$(printf '%s' "$rl" | python3 -c 'import sys,json
c=json.load(sys.stdin)["resources"]["core"];print(round(c["used"]/c["limit"]*100))' 2>/dev/null)"
    [ -n "$pct" ] && w github "{\"value\":\"$pct\",\"label\":\"gh api\"}"
  fi
} 2>/dev/null

exit 0
