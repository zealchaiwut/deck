#!/usr/bin/env bash
# install-cursor-hooks.sh — merge deck Cursor hooks into ~/.cursor/hooks.json
#
# Adds cursor-hook.sh entries for session tracking without removing existing
# hooks (e.g. crg-*). Idempotent: re-running replaces only deck hook entries.
#
# Usage:   ./scripts/install-cursor-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/cursor-hook.sh"
HOOKS_JSON="${HOME}/.cursor/hooks.json"

if [ ! -x "$HOOK_SCRIPT" ]; then
  chmod +x "$HOOK_SCRIPT"
fi

mkdir -p "${HOME}/.cursor"

python3 - "$HOOK_SCRIPT" "$HOOKS_JSON" <<'PY'
import json, sys, os

hook_script = sys.argv[1]
hooks_path = sys.argv[2]
deck_cmd = hook_script

deck_hooks = {
    "beforeSubmitPrompt": [{"command": f"{deck_cmd} working", "timeout": 5}],
    "afterFileEdit": [{"command": f"{deck_cmd} working", "timeout": 5}],
    "postToolUse": [{"command": f"{deck_cmd} working", "timeout": 5}],
    "stop": [{"command": f"{deck_cmd} done", "timeout": 5}],
    "sessionStart": [{"command": f"{deck_cmd} done", "timeout": 5}],
    "sessionEnd": [{"command": f"{deck_cmd} end", "timeout": 5}],
}

def is_deck_hook(entry):
    return "cursor-hook.sh" in entry.get("command", "")

if os.path.isfile(hooks_path):
    with open(hooks_path) as f:
        data = json.load(f)
else:
    data = {"version": 1, "hooks": {}}

data.setdefault("version", 1)
hooks = data.setdefault("hooks", {})

for event, entries in deck_hooks.items():
    existing = hooks.get(event, [])
    kept = [e for e in existing if not is_deck_hook(e)]
    hooks[event] = kept + entries

with open(hooks_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"installed deck cursor hooks -> {hooks_path}")
for event in deck_hooks:
    print(f"  {event}: {deck_cmd}")
PY

echo "restart Cursor if hooks do not appear in Settings -> Hooks"
