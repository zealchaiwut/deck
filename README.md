# deck

Launcher scripts and key icons for a Ulanzi Stream Deck D200 on macOS.

## Scripts

| Script | What it does |
|---|---|
| `scripts/chrome-chaiwut.command` | Opens a new Google Chrome window with the **Chaiwut** profile |
| `scripts/chrome-ibmdt.command` | Opens a new Google Chrome window with the **IBMDT** profile |

Each script runs:

```zsh
open -na "Google Chrome" --args --profile-directory="<folder>"
```

`-n` opens a new instance and `-a` targets the Chrome app; `--profile-directory`
takes Chrome's **internal folder name**, not the display name.

## Profile folder mapping

Chrome stores the folder → display-name mapping in
`~/Library/Application Support/Google/Chrome/Local State`
(JSON, under `profile.info_cache`). On this machine:

| Folder | Display name | Used by |
|---|---|---|
| `Default` | Person 2 | — |
| `Profile 6` | IBMDT | `chrome-ibmdt.command` |
| `Profile 7` | Annun | — |
| `Profile 8` | Chaiwut | `chrome-chaiwut.command` |

If you add, remove, or rename Chrome profiles, the folder names can change —
re-check `Local State` and update the scripts.

## Icons

196×196 px PNGs for the deck keys, in `icons/`:

- `icons/chrome-chaiwut.png` — purple accent, "C" badge
- `icons/chrome-ibmdt.png` — blue accent, "I" badge

Both use an original four-color browser-circle motif on a dark card so they sit
well on a dark key background. Regenerate with:

```bash
python3 tools/make_icons.py   # requires Pillow
```

## Ulanzi Stream Deck setup

1. Open the Ulanzi deck software and select a key.
2. Assign an **Open** (launch file/application) action to the key.
3. Point it at the `.command` file, e.g.
   `~/dev/deck/scripts/chrome-chaiwut.command`.
4. Set the key image to the matching PNG from `icons/`.

### Gatekeeper note

If macOS blocks a `.command` file the first time it runs ("cannot be opened
because it is from an unidentified developer"), right-click the file in Finder
and choose **Open** once to clear it. After that it runs normally, including
from the deck.
