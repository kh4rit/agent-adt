# abap-adt-mcp

[![CI](https://github.com/kh4rit/agent-adt/actions/workflows/ci.yml/badge.svg)](https://github.com/kh4rit/agent-adt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

ABAP Development Tools for AI agents. An [MCP](https://modelcontextprotocol.io) server that gives
GitHub Copilot, Claude Code, Cursor and any other MCP client the core ADT workflow against a
real SAP system:

- **search** repository objects by name pattern
- **read** the source of classes, programs, includes, function modules, CDS views ...
- **edit / write** source, recorded in a **transport request** when the package is transportable
- **syntax check** unsaved code
- **activate** objects and read the **activation errors** (object, include, line, message)
- list inactive objects, transports, package contents, where-used, class outline, run ABAP Unit
- create transport requests and new objects

It is built on [`abap-adt-api`](https://github.com/marcellourbani/abap-adt-api), the ADT client
library behind the [ABAP remote filesystem](https://github.com/marcellourbani/vscode_abap_remote_fs)
VS Code extension, and follows the same lock / transport / activate flow. No SAP GUI, no
Eclipse: only HTTP(S) access to the ADT services (`/sap/bc/adt`) of the application server.

## Requirements

- Node.js 20 or newer (Windows, macOS or Linux)
- An SAP user with ADT authorisation (the same as for Eclipse ADT) and network access to the
  ICF node `/sap/bc/adt` (activate it in `SICF` if needed)

## Installation

```bash
git clone https://github.com/kh4rit/agent-adt.git abap-adt-mcp
cd abap-adt-mcp
npm install
npm run build
```

`npm install` also compiles the server (via the `prepare` script), so a global install straight
from GitHub works too and puts an `abap-adt-mcp` command on your PATH:

```bash
npm install -g github:kh4rit/agent-adt
```

Check the connection before wiring it into an agent:

```bash
SAP_URL=https://sap-dev.example.com:44300 SAP_CLIENT=100 SAP_USER=DEVELOPER SAP_PASSWORD=secret node dist/index.js --check
```

On Windows (PowerShell):

```powershell
$env:SAP_URL="https://sap-dev.example.com:44300"; $env:SAP_CLIENT="100"; $env:SAP_USER="DEVELOPER"; $env:SAP_PASSWORD="secret"
node dist\index.js --check
```

## Configuration

### One system via environment variables

| Variable | Meaning |
|---|---|
| `SAP_URL` | Base URL of the application server, e.g. `https://host:44300` or `http://host:8000` |
| `SAP_USER`, `SAP_PASSWORD` | Credentials |
| `SAP_CLIENT` | Client, e.g. `100` (optional) |
| `SAP_LANGUAGE` | Logon language, e.g. `EN` (optional) |
| `SAP_ALLOW_SELF_SIGNED` | `true` to accept untrusted TLS certificates |
| `SAP_CA_CERT` | Path to a PEM file with your corporate CA certificate |
| `SAP_SYSTEM_NAME` | Name shown to the agent (default `default`) |
| `SAP_READ_ONLY` | `true` disables every tool that changes the system |
| `SAP_TIMEOUT` | HTTP timeout in ms (default 120000) |

### Several systems via a JSON file

Point `ABAP_ADT_CONFIG` (or `--config <file>`) to a file like
[examples/abap-adt-mcp.example.json](examples/abap-adt-mcp.example.json):

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": { "url": "https://sap-dev:44300", "client": "100", "username": "DEVELOPER", "password": "${env:SAP_DEV_PASSWORD}", "allowSelfSigned": true },
    "QAS": { "url": "https://sap-qas:44300", "client": "100", "username": "DEVELOPER", "password": "${env:SAP_QAS_PASSWORD}", "readOnly": true }
  }
}
```

`${env:NAME}` placeholders are replaced from the environment, so passwords never have to be in
the file. Tools take an optional `system` parameter; without it the default system is used.

## Using it with GitHub Copilot in VS Code (Windows)

1. Build the server as described above, e.g. into `C:\tools\abap-adt-mcp`.
2. Create `.vscode\mcp.json` in your workspace (or add the server through
   *MCP: Add Server* in the command palette). A complete example with a password prompt is in
   [examples/vscode-mcp.json](examples/vscode-mcp.json):

   ```json
   {
     "inputs": [
       { "type": "promptString", "id": "sap-password", "description": "SAP password", "password": true }
     ],
     "servers": {
       "abap": {
         "type": "stdio",
         "command": "node",
         "args": ["C:\\tools\\abap-adt-mcp\\dist\\index.js"],
         "env": {
           "SAP_URL": "https://sap-dev.example.com:44300",
           "SAP_CLIENT": "100",
           "SAP_USER": "DEVELOPER",
           "SAP_PASSWORD": "${input:sap-password}",
           "SAP_ALLOW_SELF_SIGNED": "true"
         }
       }
     }
   }
   ```

   VS Code asks for the password once and stores it in its secret storage.
   For several systems use [examples/vscode-mcp-multi-system.json](examples/vscode-mcp-multi-system.json).
3. Open Copilot Chat in **Agent** mode, click the tools icon and make sure the `abap` tools are
   enabled. Then ask, for example:

   > Find the class ZCL_INVOICE_CALC, read it, add input validation to method CALCULATE,
   > save it to transport DEVK900123 and activate it. Fix any activation errors.

To use the server for every workspace, put the same `servers` block into the user
`mcp.json` (*MCP: Open User Configuration*).

## Using it with Claude Code

```bash
claude mcp add abap --env SAP_URL=https://sap-dev.example.com:44300 --env SAP_CLIENT=100 --env SAP_USER=DEVELOPER --env SAP_PASSWORD=secret -- node /path/to/abap-adt-mcp/dist/index.js
```

or add it to `.mcp.json` in the project:

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/path/to/abap-adt-mcp/dist/index.js", "--config", "/path/to/abap-adt-mcp.json"],
      "env": { "SAP_DEV_PASSWORD": "secret" }
    }
  }
}
```

Cursor, Windsurf, Cline and other clients use the same `command` / `args` / `env` shape.

## Tools

| Tool | What it does |
|---|---|
| `abap_list_systems` | Configured systems and which one is the default |
| `abap_search_objects` | Repository search by name pattern (`ZCL_INV*`, `*PRICING*`), optional type filter |
| `abap_get_object` | Metadata: type, package, active/inactive, last change, includes, main program |
| `abap_read_source` | Source code (inactive version if one exists), optional line range and line numbers |
| `abap_write_source` | Replace the full source: lock, save to transport, unlock, syntax check, optional activate |
| `abap_edit_source` | Search-and-replace edits on the current source, then the same save flow |
| `abap_syntax_check` | Syntax check of given (unsaved) or current source |
| `abap_activate` | Activate objects (or all inactive objects of the user) and return the activation log |
| `abap_inactive_objects` | Inactive objects of the user with their transports |
| `abap_transport_info` | Does the object need a transport, which one locks it, which ones could take it |
| `abap_list_transports` | Modifiable workbench requests and tasks of a user |
| `abap_create_transport` | Create a workbench request for an object or package |
| `abap_create_object` | Create an empty class, interface, program, include, function group/module, CDS view ... |
| `abap_find_usages` | Where-used list of an object or of the symbol at a source position |
| `abap_package_contents` | Objects of a package grouped by type |
| `abap_object_outline` | Methods, attributes, events of a class or interface |
| `abap_run_unit_tests` | Run ABAP Unit and report failures |

Objects are addressed by `name` (plus `type` when the name is ambiguous) or by the ADT `uri`
returned from the search. Classes accept an `include` parameter (`main`, `testclasses`,
`definitions`, `implementations`, `macros`).

### How saving works

`abap_write_source` and `abap_edit_source` reproduce what Eclipse and the VS Code extension do:

1. lock the object in a stateful ADT session (for a class include the whole class is locked)
2. decide the transport: local objects (`$TMP`, local packages) need none; an object that is
   already recorded in one of your requests is saved into that request; otherwise the
   `transport` parameter is required. If it is missing the tool fails **without saving** and
   lists your modifiable requests for the package, so the agent can pick one or create one with
   `abap_create_transport`.
3. `PUT` the new source (this creates the inactive version)
4. unlock and drop the session
5. run a syntax check and report errors with line numbers
6. optionally activate (`activate: true`). Activation errors are returned with object, include,
   line and message text, and the object stays inactive until fixed.

### Safety

- `readOnly: true` / `SAP_READ_ONLY=true` turns a system into a browse-only connection.
- The server never deletes objects and never releases transports.
- Passwords: use `${input:...}` prompts in VS Code or `${env:...}` placeholders in the config
  file instead of plain text.
- Everything the agent saves is an inactive version until it explicitly activates it.

## Status

Early release (0.x). The complete lock / transport / save / activate flow is covered by an
offline test-suite that replays real ADT response formats, and the request sequences follow the
proven VS Code extension. Reports from real systems (different releases, S/4HANA Cloud private
edition, older NetWeaver stacks) are very welcome: please open an issue with the ADT error text
the tool returned.

## Contributing

Issues and pull requests are welcome. Run `npm test` before submitting; CI runs the suite on
Linux and Windows with Node 20 and 22. Keep new tools thin: put the logic in `src/services/`
with a test against the fake HTTP layer in `src/test/`.

## License

[MIT](LICENSE)

## Development

```bash
npm run build     # compile TypeScript to dist/
npm test          # build and run the offline test-suite (no SAP system needed)
node dist/index.js --check   # log on to the configured systems
```

The tests replace the HTTP layer of `abap-adt-api` with canned ADT responses, so the
lock / transport / save / activate flow is verified without a backend. Source layout:

- `src/config.ts` configuration loading
- `src/connection.ts` ADT client, stateful locking session, per-system serialisation
- `src/objects.ts` name / URI resolution to source, lock and activation URLs
- `src/services/` read, write, activation, transports, object creation, navigation
- `src/tools.ts` MCP tool definitions
- `src/index.ts` CLI entry point (stdio transport)

## Limitations

- Only object types with plain ABAP source can be written (classes, interfaces, programs,
  includes, function modules, CDS/DDL sources). DDIC objects (tables, data elements) can be
  read as XML but not changed.
- Basic authentication only. For SSO/certificate logons, front the server with a user that has
  a password, or extend `src/connection.ts` (the underlying library supports bearer tokens).
