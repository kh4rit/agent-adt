---
name: spro
description: Explore and change SAP customizing (SPRO / IMG activities) fast and scripted through SAP GUI for HTML (Web GUI) in a debuggable browser - find an IMG activity and its SPRO path, read customizing tables by SQL, navigate the IMG tree, copy/create/delete entries and save them to a given customizing request. Use for any SPRO / IMG / SM30-style customizing task (e.g. "create work center X in warehouse Y", "which IMG activity maintains table Z", "what is configured for storage type 9015").
---

# SPRO exploration and editing (Web GUI, scripted)

Tool: `node <repo>/webgui/sapgui.mjs` (setup and full command reference: [webgui/README.md](../../webgui/README.md)).
It drives the logged-on Web GUI tab of a browser with remote debugging (CDP, port 9222) by the **SAP GUI
scripting IDs** Web GUI puts in the page: fields by technical name (`LGTYP`, table cells `LGNUM[0]`), buttons by
function key (`11` Save, `3` Back, `5` New Entries, `6` Copy As, `14` Delete, `0` Enter/Continue) or screen-button
name (`VIM_POSI_PUSH`). No screenshots, no pixel clicks. One step ≈ 0.6–1 s; a full IMG activity change ≈ 10–15 s.
System, client and language come from `webgui/sapgui.config.json` (or `SAP_HOST` / `SAP_CLIENT` / `SAP_LANG`).
The commands need access to `127.0.0.1:9222`; if your agent runs commands in a sandbox, allow that.
Quote arguments containing spaces or `[ ]` (PowerShell: `'LGNUM[0]=0001'`).

## Rules
- Work only in systems and clients the user or the project instructions allow for customizing; never production.
- Change only what the user asked, and **only with the customizing request the user gave** (`save <TR>`). Never
  create requests. If SAP proposes another request it is replaced; if the request is rejected, stop and report.
- **Never leave a maintenance view in change mode**: every change block ends with `leave`, also after errors.
  An open change view locks the table for others.
- *Data locked by user X*: stop and tell the user who holds the lock. No display-only workaround, no retry loop.
- Unexpected popup (unsaved data, dependent entries, …): read it with `state`; ask the user if it changes scope;
  never blindly confirm.
- Login expired (identity-provider page in the tab, or `Failed to fetch` on SQL): ask the user to sign in in the
  browser; never choose an account or enter credentials.
- Before changing anything, show the user the plan (IMG activities in order with SPRO path, templates, key values)
  and wait for the go-ahead unless the user already gave all details and asked to proceed.

## Workflow
1. **Find the activity (offline, ms):** `sapgui.mjs img "<text or activity id>"` → activity id, maintenance
   object (view/table/cluster + tcode), SPRO path. Uses the local cache `webgui/img-tree.json`; uncached areas fall
   back to SQL. Build/extend: `sapgui.mjs cache ["<top-level IMG area>"]` (~15 s).
2. **Read the data first (SQL, ms):** `sapgui.mjs sql "SELECT … FROM <table> WHERE …"` (ADT data preview over
   the browser session). Choose templates and keys from what exists: naming patterns, roles, sections.
   ABAP SQL, one SELECT per call, lines < 255 chars, literals not longer than the field.
3. **Write the change as a script** (one command per line, `#` comments) and run it in one go:
   `sapgui.mjs run <file>` (`-v` = full screen dumps). Typical block:
   ```
   spro "Define Work Center" tree="Extended Warehouse Management"   # IMG tree navigation along the cached path, then execute
   position <WAREHOUSE> <TEMPLATE>      # 'Position...': key values in key order
   selectkey LGNUM=<WAREHOUSE> WORKSTATION=<TEMPLATE>
   press 6                              # Copy As (5 New Entries, 14 Delete, 38/2 Details)
   set WORKSTATION=<NEW> "DESCRIPTION=<text>" LGTYP=<ST> I_SECTION=<SEC>
   press 0                              # Enter / Copy
   save <TR>
   leave
   ```
   New table rows: `press 5`, `set "LGNUM[0]=…" "LGTYP[0]=…"`, `key Enter`. Checkboxes `F=X` / `F=`,
   radio `F=X`, dropdowns by text or key. Unknown field names: `state` (shows `NAME=value «label»`, columns,
   numbered buttons). `tree="<part of the SPRO path>"` disambiguates activities that exist in several IMG areas;
   `spro` lists the candidates otherwise.
4. **Verify by SQL** and report what was created/changed/deleted, keys, request, SPRO path, run time.
5. Deletions in reverse dependency order (e.g. work center → storage section → storage type).

Example: [webgui/examples/work-center.txt](../../webgui/examples/work-center.txt).

## Gotchas
- Synthetic mouse clicks make Web GUI wait ~5 s (drag detection); the tool clicks via DOM/keyboard. Don't drive
  SAP screens with pixel-click helpers.
- Some tables refuse plain SM30 ("only with restrictions"); executing the IMG activity via `spro` avoids that.
- After an IMG activity starts, the dialog arrives in a later roundtrip; `spro` waits for it, so no sleeps.
- The server can end the Web GUI session (timeouts): `state` shows `SESSION ENDED`, locks are released. Re-run
  the block from its `spro` line; check by SQL what was already saved before saving again.
- `shot <file.png>` is for documentation, not for driving.
