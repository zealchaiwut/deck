# Deck Status — UlanziDeck plugin

Renders live status onto Ulanzi D200 keys. Five actions:

| Action | What it shows |
|--------|----------------|
| **Cursor** | Cycle Cursor hook sessions — elapsed time, status, logo. Tap to cycle. |
| **Commander Sprint** | Running sprint `done/total`. Random icon per project. Tap to cycle. |
| **Claude (cycle)** | Cycle Claude sessions (idle skipped). Tap to cycle. |
| **Antigravity** | Latest git commit hash + age for a project path. Tap opens IDE. |
| **GitHub API Usage** | `gh` rate-limit % with meter bar. Tap to refresh. |

- **Type:** Node.js main service (`plugin/app.js`), Node v20, SDK protocol V2.1.2, Ulanzi Studio 3.0.11+
- **Rendering:** pure-JS SVG → base64 data URL → `setBaseDataIcon`
- **Only dependency:** `ws`

## Session tiles (Cursor / Claude / Sprint)

196×196 SVG with accent bar, status label, big value (time or `done/total`), and brand logo top-right (same position as GitHub gauge). Host text overlay: two lines (project + role/slug).

Data sources:
- `deck_state/cursor_sessions/*.json` — Cursor hooks
- `deck_state/cc_sessions/*.json` — Claude Code hooks
- Commander `/api/home` + `/api/sprint-status` + `/api/sprint-progress`

## Antigravity

Bind a key to a **project path** (git repo). Shows latest commit short hash and age, recomputed every ~30s. Accent fades green → grey over 30 minutes. Tap opens Antigravity IDE.

PI field: **Project path** (e.g. `~/dev/commander/prd`). Persisted to `deck_state/antigravity_project.txt`.

## Commander Sprint

PI field: **Dashboard URL** per key (e.g. `http://100.103.104.41:8000`). Saved in `deck_state/commander_keys.json`. Blank = `http://127.0.0.1:8001`.

## Install into Ulanzi Studio (macOS)

```
~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.deckstatus.ulanziPlugin
```

Run `npm install` inside the plugin folder if `node_modules/ws` is missing. Restart Ulanzi Studio after copying.

## Run for simulator

```bash
cd plugins/com.ulanzi.deckstatus.ulanziPlugin
npm install
node plugin/app.js
```

## License

Apache-2.0
