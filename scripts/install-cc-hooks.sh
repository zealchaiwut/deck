#!/bin/bash
# install-cc-hooks.sh — idempotently wire deck cc-hook.sh into ~/.claude/settings.json.
#
# Merges deck session-tracking hooks without clobbering existing Commander or
# codedb hooks. Backs up settings.json before writing.
#
# Usage: ./install-cc-hooks.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_HOOK="$SCRIPT_DIR/cc-hook.sh"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

if [ ! -x "$CC_HOOK" ]; then
  chmod +x "$CC_HOOK" 2>/dev/null || true
fi

if [ ! -f "$SETTINGS" ]; then
  echo "error: Claude settings not found at $SETTINGS" >&2
  exit 1
fi

BACKUP="$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$SETTINGS" "$BACKUP"
echo "backed up settings -> $BACKUP"

CC_HOOK="$CC_HOOK" SETTINGS="$SETTINGS" python3 <<'PY'
import json, os, sys

hook_path = os.environ["CC_HOOK"]
settings_path = os.environ["SETTINGS"]

deck_cmd = lambda state: {
    "type": "command",
    "command": f"{hook_path} {state}",
}

def event_has_deck_hook(hooks_obj, event, state):
    suffix = f"cc-hook.sh {state}"
    for group in hooks_obj.get(event, []):
        for entry in group.get("hooks", []):
            if entry.get("type") == "command" and entry.get("command", "").endswith(suffix):
                return True
    return False

def ensure_event(hooks_obj, event, state):
    if event_has_deck_hook(hooks_obj, event, state):
        return
    entries = hooks_obj.setdefault(event, [])
    if not entries:
        entries.append({"hooks": []})
    # Prefer appending to the first hook group without a restrictive matcher.
    target = None
    for group in entries:
        if group.get("matcher") in (None, "", ".*"):
            target = group
            break
    if target is None:
        target = {"hooks": []}
        entries.insert(0, target)
    group_hooks = target.setdefault("hooks", [])
    group_hooks.append(deck_cmd(state))

with open(settings_path, encoding="utf-8") as f:
    data = json.load(f)

hooks = data.setdefault("hooks", {})
for event, state in [
    ("UserPromptSubmit", "working"),
    ("Notification", "waiting"),
    ("Stop", "done"),
    ("SessionEnd", "end"),
]:
    ensure_event(hooks, event, state)

# SessionStart: add idle alongside existing hooks (e.g. codedb-warmup).
ensure_event(hooks, "SessionStart", "idle")

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"installed deck cc-hook entries in {settings_path}")
PY

echo "deck hook: $CC_HOOK"
echo "tip: export DECK_SESSION=<name> before launching claude in iTerm for distinct labels"
