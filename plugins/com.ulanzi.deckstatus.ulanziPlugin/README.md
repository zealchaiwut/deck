# Deck Status — UlanziDeck plugin

Renders live status from your local `deck_state/` files onto Ulanzi D200 keys.
The files are written by **other** scripts (e.g. `notify-coding.sh`, the
`post-commit` Antigravity counter); this plugin only **reads** them — the one
exception is resetting an `*_count.txt` counter to `0` when you tap its key.

- **Type:** Node.js main service (`plugin/app.js`), Node v20, SDK protocol V2.1.2, Ulanzi Studio 3.0.11+
- **Rendering:** pure-JS SVG → base64 data URL → `setBaseDataIcon` (no canvas/PNG dependency)
- **Only dependency:** `ws`

## File formats it reads (under STATE_DIR, default `~/dev/deck/scripts/deck_state`)

| Binding (`source`)         | Resolves to                          | Shown |
|----------------------------|--------------------------------------|-------|
| `coding_antigravity`       | `tile_coding_antigravity.json` then `.txt` | `value` + accent from `color` |
| `antigravity_count.txt`    | `antigravity_count.txt` (integer)    | the number; tap resets to `0` |
| `sub/foo.json`             | direct relative path                 | `value` + `color` |

`tile_<name>.json` = `{"value","color","state","label"}`. `color` ∈
`green|amber|red|blue|grey` (default grey). A `.txt` whose value is `0`/empty,
or a missing file, renders a dim neutral `0`/`—` tile.

## Action: "Antigravity" (Keypad, all devices)

Bind a key to a **project path** (a git repo). The tile shows that repo's latest
commit **short hash** and **how long since it** (e.g. `5d4500e` / `6m ago`),
recomputed via `git -C <path> log -1` every ~30s. Accent color by recency:
green < 1h, amber < 1d, grey older. Not a repo / bad path → dim `—` `no repo`.
Tap the key to refresh immediately. Self-contained — needs no counter file or
git hook.

Property Inspector field: **Project path** (absolute or `~`, e.g.
`~/dev/commander/prd`).

## Action: "Status Tile" (Keypad, all devices)

Property Inspector fields:
- **Source** — tile name or relative path (datalist suggests the common ones).
- **State dir** — override STATE_DIR (supports `~`). Blank = default.

Each active key polls its bound file every ~2s (debounced; overlapping reads
skipped). Reads are wrapped in try/catch — a missing/locked/partial file just
skips that cycle, never crashes. Tap = reset if bound to a counter, else force
an immediate refresh. Polling stops on deactivate/clear.

## Install into Ulanzi Studio (macOS)

Copy the plugin folder into the UlanziDeck plugins directory, then restart
Ulanzi Studio:

```
~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.deckstatus.ulanziPlugin
```

(Ship `node_modules/ws` with it, or run `npm install` inside the installed
folder.) The host launches `plugin/app.js` with Node and passes the WebSocket
address/port/lang as `process.argv[2..4]`.

## Run the main service for the simulator

The simulator does **not** auto-start Node main services — run it yourself:

```bash
cd "com.ulanzi.deckstatus.ulanziPlugin"
npm install            # first time only (installs ws)
node plugin/app.js     # connects to 127.0.0.1:3906 by default
```

Simulator UI: <http://127.0.0.1:39069> (copy the plugin into
`UlanziDeckSimulator/plugins/`, click *Refresh Plugin List*, drag the action
onto a key).

## Debug in the desktop app

```bash
open /Applications/Ulanzi\ Studio.app --args --log --nodeRemoteDebug
```

Then open `chrome://inspect` in Chrome, find this plugin, click *inspect*.
Logs also go to the plugin log file via `$UD.logMessage`.

## Test (green "9" → flip)

1. A test tile already exists: `~/dev/deck/scripts/deck_state/tile_test.json`
   = `{"value":"9","color":"green"}`.
2. In the simulator/app, add **Status Tile** to a key, open its Property
   Inspector, set **Source** = `test`. The key shows a green **9**.
3. Flip it and watch the key update within ~2s:
   ```bash
   printf '%s' '{"value":"3","color":"red"}' > ~/dev/deck/scripts/deck_state/tile_test.json
   ```
4. Bind another key to `antigravity_count.txt` — it shows the commit count and
   tapping it resets to `0`.

## License

Apache-2.0. Built on the UlanziDeckPlugin-SDK (`plugin-common-node`,
`libs/`), which is licensed Apache-2.0 — see SDK `LICENSE`. Keep the SDK
notices intact when redistributing.
