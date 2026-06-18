# Deck inspect scripts (JSON → tiles later)

Read-only CLI tools that dump normalized JSON for testing before wiring Ulanzi tiles.

| # | Script | Source | Tile (planned) |
|---|--------|--------|----------------|
| 1 | `../cursor-sessions.sh` | `deck_state/cursor_sessions/*.json` (Cursor hooks) | Cursor cycle |
| 2 | `../commander-status.sh` | Commander dashboard HTTP API | Sprint / agents cycle |
| 3 | `../claude-sessions.sh` | `deck_state/cc_sessions/*.json` (Claude Code hooks) | Claude cycle |
| — | `../mock-tiles.sh` | all three inspect scripts | Preview before tile rebuild |

Shared row shape: `name`, `project`, `state` (`working` \| `completed` \| `idle`), `runningSec`, `runningTime`.

Do not change tile render code until inspect output matches what you want on the deck.
