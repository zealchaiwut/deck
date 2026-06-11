#!/bin/zsh
# Switch to the "Chaiwut" Chrome profile (folder: Profile 8).
# If Chrome is running, clicks Chrome's native Profiles menu: this focuses an
# existing window of the profile if one is open, otherwise Chrome opens one.
# Requires Accessibility permission for Terminal; falls back to opening a new
# window with the profile if that is denied.

PROFILE_NAME="Chaiwut"
PROFILE_DIR="Profile 8"

if ! pgrep -xq "Google Chrome"; then
  open -na "Google Chrome" --args --profile-directory="$PROFILE_DIR"
  exit 0
fi

if osascript >/dev/null 2>&1 <<EOF
tell application "Google Chrome" to activate
tell application "System Events"
  tell process "Google Chrome"
    click menu item "$PROFILE_NAME" of menu "Profiles" of menu bar 1
  end tell
end tell
EOF
then
  exit 0
fi

# Fallback: no Accessibility permission (or menu item not found).
open -na "Google Chrome" --args --profile-directory="$PROFILE_DIR"
