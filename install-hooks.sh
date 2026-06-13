#!/bin/bash
# install-hooks.sh — install the Antigravity post-commit proxy hook into a repo.
#
# Copies hooks/post-commit into <repo>/.git/hooks/post-commit (chmod +x),
# backing up any existing hook first.
#
# Usage:   ./install-hooks.sh [/path/to/repo]   (default: current repo)
#
# Reminder: the installed hook is INERT unless ANTIGRAVITY_TRACK=1 is set in the
# env (see hooks/post-commit header). To uninstall, restore the printed backup
# over .git/hooks/post-commit, or delete the hook if no backup was made.

set -u

# Resolve dir of this script so we find hooks/post-commit regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/hooks/post-commit"

TARGET_REPO="${1:-.}"

if [ ! -f "$SRC" ]; then
  echo "error: source hook not found at $SRC" >&2
  exit 1
fi

# Find the .git/hooks dir of the target repo (handles worktrees/submodules).
GIT_DIR="$(git -C "$TARGET_REPO" rev-parse --git-dir 2>/dev/null)" || {
  echo "error: '$TARGET_REPO' is not a git repository" >&2
  exit 1
}
# rev-parse may return a relative path; make it absolute.
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$(cd "$TARGET_REPO" && cd "$GIT_DIR" && pwd)" ;;
esac

HOOKS_DIR="$GIT_DIR/hooks"
DEST="$HOOKS_DIR/post-commit"

mkdir -p "$HOOKS_DIR"

# Back up any existing hook before overwriting.
if [ -e "$DEST" ]; then
  BACKUP="$DEST.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$DEST" "$BACKUP"
  echo "backed up existing hook -> $BACKUP"
fi

cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "installed post-commit hook -> $DEST"
echo "enable per-repo/session with: export ANTIGRAVITY_TRACK=1"
