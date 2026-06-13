# SKILL: Build / modify UlanziDeck (Ulanzi Studio) plugins

Repeatable guide for building plugins for **Ulanzi Studio 3.x** (D200 family) in
this repo. Pinned to: **Ulanzi JS Plugin Development Protocol V2.1.2**, **Ulanzi
Studio 3.0.11**, **Node.js v20**. Source of truth:
<https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK> (README.md,
manifest.md, `common-node/`, `common-html/`, `demo/`).

> **License note:** the SDK is **Apache-2.0** (per its `LICENSE` and README), not
> AGPL. Keep the SDK's Apache-2.0 notices when redistributing `common-node` /
> `common-html`. Your own plugin code can be any compatible license.

## 1. Naming & UUID rules (strict — host distinguishes by segment count)

- Plugin **folder / package**: `com.ulanzi.{name}.ulanziPlugin`
- **Main service UUID**: `com.ulanzi.ulanzistudio.{name}` — **exactly 4** dot segments
- **Action UUID**: `com.ulanzi.ulanzistudio.{name}.{action}` — **5+** segments
- The main UUID is what `app.js` calls `$UD.connect(MAIN_UUID)` with; action
  UUIDs appear in `manifest.json > Actions[].UUID`.

## 2. Folder layout

```
com.ulanzi.{name}.ulanziPlugin/
├── manifest.json                 # required
├── package.json                  # "type":"module", deps: { ws }
├── en.json / zh_CN.json          # optional i18n (data-localize keys)
├── resources/                    # icon.png + per-action icons (PNG/SVG/JPG)
├── plugin/
│   ├── app.js                    # Node main service entry (CodePath)
│   └── plugin-common-node/       # copied SDK (see §6)
├── property-inspector/
│   ├── inspector.html
│   └── inspector.js
└── libs/                         # copied common-html (PI runtime: constants/eventEmitter/timers/utils/ulanziApi + css)
```

## 3. manifest.json — required fields

Top-level required: `Author`, `Name`, `Icon`, `Version`, `CodePath`,
`Type` (fixed `"JavaScript"`), `UUID` (4-segment), `Actions`. Useful optional:
`Description`, `Category`/`CategoryIcon`, `Software.MinVersion` (`"3.0.11"`),
`OS`, `Inspect` (`--inspect=127.0.0.1:PORT`, unique per plugin, needs
`--nodeRemoteDebug`).

Per action required: `Name`, `Icon`, `UUID` (5+ seg), `States` (array of
`{Image}`). Common optional: `PropertyInspectorPath`, `Tooltip`, `Controllers`
(`["Keypad"]` and/or `["Encoder"]`; default Keypad), `Devices` (`[]` = all;
`["D200X"]`; `["~Dial"]` to exclude), `SupportedInMultiActions`,
`DisableAutomaticStates`, `Encoder.layout` (`$UA1`/`$UA2`/custom json).

`CodePath` ending `.js` → Node main service; ending `.html` → WebView main
service. The Property Inspector is **always** HTML using `common-html`.

## 4. Node vs HTML main service

- **Node.js** (`common-node`): system integration, filesystem, child processes,
  network, heavy logic. Background process that stays connected. **Use this**
  for anything reading local files / shelling out.
- **HTML** (`common-html`): UI-rich, Canvas drawing in the page, simple logic,
  no Node APIs.

Either way the Property Inspector is HTML (`common-html`) and the `$UD` event
API is the same.

## 5. Core `$UD` API we rely on

Set a key's icon (push from main service):
- `setStateIcon(context, stateIndex, text)` — use a `States[]` entry from manifest.
- `setPathIcon(context, 'resources/x.png', text)` — local file, relative to plugin root.
- `setBaseDataIcon(context, dataUrl, text)` — **base64 data URL**; SVG works
  (`data:image/svg+xml;base64,...`) → render tiles with **zero canvas/PNG deps**.
- `setGifPathIcon` / `setGifDataIcon` — animated.

Lifecycle / events (main service):
- `onAdd(msg)` — action dropped on a key; `msg.context` unique, `msg.param` = saved settings.
- `onSetActive(msg)` — `msg.active` true/false; **start/stop per-key work here**.
- `onRun(msg)` — tap (single click confirmed); main trigger.
- `onClear(msg)` — removed; **`context` is in each item of `msg.param` array**, loop it.
- `onParamFromApp(msg)` / `onParamFromPlugin(msg)` — host pushes config; `msg.param`.
- `onKeyDown`/`onKeyUp`; encoder: `onDial*`.

Settings / config:
- `setSettings(data, context)` / `getSettings(context)` → `onDidReceiveSettings`.
- `setGlobalSettings` / `getGlobalSettings` → `onDidReceiveGlobalSettings`.
- `sendParamFromPlugin(params, context)`, `sendToPlugin`/`sendToPropertyInspector`.

System:
- `logMessage(msg, level)` — `'info'|'debug'|'warn'|'error'`; writes plugin log file.
- `toast(msg)`, `showAlert(context)`, `hotkey('⌘C')`, `openUrl`, `openView`,
  `selectFileDialog`/`selectFolderDialog` → `onSelectdialog`.

`context` = `uuid + '___' + key + '___' + actionid`. Same action on N keys = N
contexts. `encodeContext(msg)` / `decodeContext(ctx)`.

Utils (both runtimes): `Utils.getPluginPath()` (plugin root, host-Node safe),
`getSystemType()`, `parseJson()`, `debounce(fn, wait)`,
`getFormValue('#form')`/`setFormValue(json, '#form')` (PI form binding).

`RandomPort` (Node): **only** needed if a PI page connects directly to a
WebSocket/HTTP server you host in the main service, bypassing the host. Normal
param flow (PI → host → `onParamFromApp`) needs no port management.

## 6. Install the SDK into a plugin

```bash
cp -r common-node ./plugin/plugin-common-node      # Node main service SDK
cp -r common-html/libs ./libs                       # Property Inspector runtime + css
npm install ws                                       # only hard dependency
```

Import in `app.js`: `import UlanziApi, { Utils, RandomPort } from './plugin-common-node/index.js';`
Connection params come from `process.argv[2]` address, `[3]` port (default
`3906`), `[4]` lang — `$UD.connect(MAIN_UUID)` reads them. (A complete copy of
`plugin-common-node` + `libs` already exists in any installed plugin, e.g.
`com.claude.usage`, if the upstream `common-node` submodule isn't fetched.)

## 7. Critical caveats

- **Settings/context only valid while the action is active.** `setSettings` is a
  no-op when inactive; do per-key work between `onSetActive(true)` and
  `onSetActive(false)`/`onClear`. Track a `Map<context, instance>` and tear it
  down on clear.
- **Key canvas is 196×196.** Render at that size (SVG `viewBox="0 0 196 196"`).
- **`onClear` context is per-item:** iterate `msg.param[].context`.
- Never let a read/render throw — wrap in try/catch and skip the cycle, or the
  main service can die and all keys go stale.
- Dedupe pushes: only call `setBaseDataIcon` when the rendered output changed.

## 8. Test

**Simulator** (no desktop app needed):
```bash
cd UlanziDeckSimulator && npm install && npm start   # UI at http://127.0.0.1:39069
node path/to/plugin/app.js                            # start Node main service yourself
```
Copy plugin into `UlanziDeckSimulator/plugins/`, *Refresh Plugin List*, drag
action onto a key, click key for the PI, right-click for manual events.
Limitations: Node main service must be started manually; `openview`/`openurl`
can't open local files; actions not auto-loaded.

**Desktop debug** (macOS):
```bash
open /Applications/Ulanzi\ Studio.app --args --log --nodeRemoteDebug
```
Node plugins: `chrome://inspect` → find plugin → *inspect*. HTML plugins: add
`--webRemoteDebug`, open `localhost:9292`. (`open --args` can drop Accessibility
perms / break hotkeys; launch the binary directly if so.)

**Headless logic test:** import the pure modules (file readers, renderers)
directly in a `node x.mjs` script and assert outputs — don't need the host for
non-`$UD` logic.

**Install path (macOS):**
`~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.{name}.ulanziPlugin`
then restart Ulanzi Studio.

## 9. Reference implementation in this repo

`plugins/com.ulanzi.deckstatus.ulanziPlugin/` — Node main service that polls
local `deck_state/` files and renders them as SVG tiles. Good template for:
per-key `Map` instances, ~2s polling with debounce, SVG→`setBaseDataIcon`,
counter reset on `onRun`, lifecycle via `onSetActive`/`onClear`.
