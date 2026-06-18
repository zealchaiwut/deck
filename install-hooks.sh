#!/bin/bash
# Delegates to scripts/install-hooks.sh (canonical post-commit installer).
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install-hooks.sh" "$@"
