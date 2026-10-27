# sapgui.mjs – scripted SAP GUI for HTML (Web GUI) for agents

`sapgui.mjs` lets an AI agent (GitHub Copilot, Claude Code, …) work in **SAP GUI for HTML** the way SAP GUI
scripting does: fields by technical name, buttons by function key, popups and status messages as text.
It is mainly meant for **customizing (SPRO / IMG activities)**, which ADT does not cover. The agent skill
that uses it is [`skills/spro`](../skills/spro/SKILL.md).

It drives a Web GUI tab in a Chromium browser (Edge, Chrome) that runs with remote debugging (Chrome DevTools
Protocol). Single sign-on works because the agent reuses the session you are logged on with; the tool never
handles passwords or tokens.

- **No pixel clicking.** Web GUI renders the SAP GUI scripting IDs (`wnd[0]/usr/…/ctxt…-LGTYP`) into the page;
  the tool addresses fields, table cells and buttons by them. Buttons are triggered through the DOM, not by
  synthetic mouse events (those make Web GUI wait ~5 s per click for drag detection). One step ≈ 0.6–1 s.
- **SPRO navigation from a local IMG cache.** `cache` dumps an IMG area (activities, SPRO paths, maintenance
  objects) via SQL into `img-tree.json`; `spro "<activity>"` then expands exactly those tree nodes and executes
  the activity, as a user would.
- **Read-only SQL** through ADT data preview over the same browser session (`sql "SELECT …"`), for exploring and
  for verifying changes.
- **Safe saving.** `save <request>` only accepts the customizing request you pass and replaces any request SAP
  proposes; `leave` exits change mode so no table stays locked; foreign locks stop the run.

## Requirements

- Node.js 22+ (uses the built-in `fetch` and `WebSocket`).
- Microsoft Edge or Google Chrome.
- An SAP system with SAP GUI for HTML (`/sap/bc/gui/sap/its/webgui`) and ADT (for `sql`, `img`, `cache`);
  your user needs the usual authorizations for the customizing you do and for ADT data preview.

## Setup

1. **Start a browser with remote debugging**, using a separate profile (the debugging port gives local programs
   control over this browser, so don't use it for unrelated browsing):

   Windows (PowerShell):
   ```powershell
   & "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 `
     --user-data-dir="$env:USERPROFILE\.edge-sapgui"
   ```
   macOS:
   ```sh
   open -na "Microsoft Edge" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.edge-sapgui"
   ```
   Check: `http://127.0.0.1:9222/json/version` returns JSON.

2. **Configure the system**: copy `sapgui.config.example.json` to `sapgui.config.json` (same folder, git-ignored):
   ```json
   { "host": "https://my-sap-host.example.com", "client": "100", "lang": "EN" }
   ```
   (or set `SAP_HOST`, `SAP_CLIENT`, `SAP_LANG`).

3. **Log on once** in that browser: open `https://<host>/sap/bc/gui/sap/its/webgui?sap-client=<client>` and
   complete SSO. The tool reuses this tab.

4. **Build the IMG cache** for the area you customize (default: SCM Extended Warehouse Management):
   ```sh
   node webgui/sapgui.mjs cache
   node webgui/sapgui.mjs cache "Logistics Execution"
   ```

5. Register the skill with your agent (see the main README): GitHub Copilot CLI `copilot skill add <repo>/skills`;
   other agents: copy `skills/spro` into their skills folder.

## Commands

```
node webgui/sapgui.mjs <command> [args]          one command
node webgui/sapgui.mjs [-v] run <file|->          a script, one command per line, '#' comments; stops on the first error
```

| Command | Purpose |
|---|---|
| `img "<text or activity>"` | IMG activity → maintenance object (view/table/cluster, tcode) and SPRO path (cache first, SQL fallback) |
| `cache ["<IMG area>"]` | dump an IMG area to `img-tree.json` |
| `sql "<SELECT …>"` | ADT data preview, ABAP SQL, one SELECT, max 200 rows |
| `spro "<activity>" [tree="<part of path>"] [n=<i>]` | navigate the IMG tree and execute the activity |
| `state [full]` | title, status bar, popup, fields `NAME=value «label»`, table rows, buttons |
| `set F=V …` | set fields: `LGTYP=…`, table cell `"LGNUM[0]=…"`, checkbox `F=X`/`F=`, radio `F=X`, dropdown by text/key |
| `press <n\|NAME\|label>` | press a button: function key number (`11` Save, `3` Back, `5` New Entries, `6` Copy As, `14` Delete, `0` Enter), screen button name or label |
| `key <Enter\|F1..F12\|…>` | send a key |
| `position v1 v2 …` | SM30-style "Position…" by key values |
| `select <row>` / `selectkey F=V …` | mark a table row |
| `save <request>` | save, handling the customizing request prompt |
| `leave` | back out of change mode (releases the lock) |
| `dialog <button text>` | answer a browser-level dialog |
| `shot <file.png>` | screenshot (for documentation) |
| `sm30 <view>`, `sm34 <cluster>`, `tx <tcode> [k=v;…]` | direct start, as a fallback |

Example: [`examples/work-center.txt`](examples/work-center.txt).

Quoting: arguments containing spaces or `[ ]` must be quoted (PowerShell: `'LGNUM[0]=0001'`); inside `run`
scripts quotes work like in a shell (`"DESCRIPTION=My text"`, `tree="Extended Warehouse Management › Master Data"`).

## Environment

| Variable | Default |
|---|---|
| `CDP_PORT` | `9222` |
| `SAPGUI_TAB` | `webgui` (URL substring of the tab to drive) |
| `SAP_HOST`, `SAP_CLIENT`, `SAP_LANG` | from `sapgui.config.json` |
| `SAPGUI_TIME` | set to print the run time |

## Limitations

- Tested with SAP GUI for HTML on S/4HANA 2023 (Fiori theme) and Edge. Classic themes may render differently.
- `spro` relies on the IMG cache; rebuild it after support packages or when you work in another IMG area.
- Tree rows are rendered virtually; if a row is not on screen, `spro` falls back to SPRO's Find dialog.
- The server may end idle Web GUI sessions; `state` then reports `SESSION ENDED` (locks are released) and the
  block has to be re-run from its `spro` line.
