# abap-adt-mcp

[![CI](https://github.com/kh4rit/agent-adt/actions/workflows/ci.yml/badge.svg)](https://github.com/kh4rit/agent-adt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

ABAP Development Tools for AI agents. An [MCP](https://modelcontextprotocol.io) server that gives
GitHub Copilot, Claude Code, Cursor and any other MCP client the core ADT workflow against a
real SAP system:

- **log on** with user/password **or single sign-on** (SAML / Entra ID) through your browser session
- **search** repository objects by name pattern
- **read** the source of classes, programs, includes, function modules, CDS views ...
- **edit / write** source, recorded in a **transport request** when the package is transportable
- **syntax check** unsaved code
- **activate** objects and read the **activation errors** (object, include, line, message)
- list inactive objects, transports, package contents, where-used, class outline, run ABAP Unit
- create transport requests and new objects
- **deploy built SAPUI5 / Fiori apps** to the SAPUI5 ABAP repository (BSP applications) through
  the same service `fiori deploy` uses, with the server's logon (works where the Fiori tools
  cannot log on, e.g. SAML single sign-on systems)

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

### Authentication modes

| `auth` / `SAP_AUTH` | Credentials | When to use |
|---|---|---|
| `basic` (default) | `password` / `SAP_PASSWORD` | Systems that accept user + password on `/sap/bc/adt` |
| `sso` | none: the server logs on through a browser | Systems that redirect ADT to a SAML identity provider (Microsoft Entra ID, SAP IAS, ADFS ...) and reject passwords |
| `cookie` | `cookie` / `SAP_COOKIE`: a cookie header such as `MYSAPSSO2=...; SAP_SESSIONID_DEV_100=...` | Quick tests: paste the cookies of a logged-on browser (DevTools > Application > Cookies). No automatic refresh |
| `bearer` | `bearerToken` / `SAP_BEARER_TOKEN` | Systems with OAuth 2.0 for ADT |

`username` is needed in every mode: it is not used to log on with sso/cookie/bearer but for the
transport list default and for display.

#### Single sign-on through the browser (`auth: "sso"`)

How it works: the server starts Microsoft Edge or Google Chrome with a dedicated profile on the
ADT discovery URL of the system. SAP redirects to the identity provider, the browser completes
the logon (silently when the identity provider already knows the device or user; otherwise a
window opens and you log on as usual, including MFA) and lands on the SAP host again. The
server watches the browser's cookie store, copies the SAP cookies (`SAP_SESSIONID_<SID>_<client>`,
`MYSAPSSO2`), closes the browser and uses the cookies for all ADT calls. When SAP later rejects
them (HTTP 401 or the SAML redirect page instead of ADT data) the logon runs again, silently
first, and the failed call is retried once. Cookies are cached in
`~/.abap-adt-mcp/<system>.cookies.json` (`%USERPROFILE%\.abap-adt-mcp` on Windows, owner-only
permissions) so restarts of the MCP server do not need a new logon. The browser profile
`~/.abap-adt-mcp/browser-profile` keeps the identity provider session.

Setup:

```powershell
$env:SAP_URL="https://sap-dev.example.com"; $env:SAP_CLIENT="100"; $env:SAP_USER="MYUSER"; $env:SAP_AUTH="sso"
node dist\index.js --sso-login     # opens the browser, log on once, cookies are cached
node dist\index.js --check         # verifies ADT access with the cached cookies
```

After the logon the browser may briefly show or offer to download the ADT discovery XML; that
is expected, the window closes on its own once the cookies are captured.

`--sso-login` is optional: the first tool call opens the browser as well. Requires Node.js 22+
(the browser is driven over the DevTools protocol with Node's built-in WebSocket) and a
Chromium based browser. Settings (config file `sso: { ... }` or environment):

| Setting | Env | Meaning |
|---|---|---|
| `browser` | `SAP_SSO_BROWSER` | Path of `msedge.exe` / `chrome.exe`; auto-detected when omitted |
| `profileDir` | `SAP_SSO_PROFILE_DIR` | Browser profile directory keeping the identity provider session |
| `cacheFile` | `SAP_SSO_CACHE_FILE` | Where the SAP cookies are cached |
| `loginUrl` | `SAP_SSO_LOGIN_URL` | URL to open; default `<url>/sap/bc/adt/discovery?sap-client=<client>` |
| `headless` | `SAP_SSO_HEADLESS` | `false` to always open a visible window (default: try silently first, 30 s) |
| `timeout` | `SAP_SSO_TIMEOUT` | Seconds to wait for the interactive logon (default 300) |
| `maxAgeHours` | `SAP_SSO_MAX_AGE_HOURS` | Re-logon after this many hours even without a rejection (default 8) |

In sso and cookie mode reads and writes share one SAP session (the library cannot clone a
client with an injected HTTP layer); tool calls are handled sequentially anyway.

#### Corporate network caveats (proxy, TLS interception)

- **Proxy:** if `HTTPS_PROXY` is set (or Node runs with `NODE_USE_ENV_PROXY=1`), requests to an
  internal SAP host go through the proxy and typically fail with `ERR_PROXY_TUNNEL` / 502. Add the
  SAP host to `NO_PROXY`, or set `noProxy: true` / `SAP_NO_PROXY=true` and the server does it.
- **TLS interception (Zscaler and similar):** Node then reports
  `self-signed certificate in certificate chain`. Export the corporate root certificates to a PEM
  file and point `caCert` / `SAP_CA_CERT` (or `NODE_EXTRA_CA_CERTS`) at it. `allowSelfSigned`
  works too but disables certificate checks entirely.
- Always use the URL you use in Eclipse / the browser (usually the web dispatcher); direct ICM
  ports are often firewalled.

### Several systems via a JSON file

Point `ABAP_ADT_CONFIG` (or `--config <file>`) to a file like
[examples/abap-adt-mcp.example.json](examples/abap-adt-mcp.example.json):

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": { "url": "https://sap-dev:44300", "client": "100", "username": "DEVELOPER", "password": "${env:SAP_DEV_PASSWORD}", "allowSelfSigned": true },
    "PRD": { "url": "https://sap-prd.example.com", "client": "100", "username": "MYUSER", "auth": "sso", "caCert": "C:\\certs\\corp-ca.pem", "noProxy": true },
    "QAS": { "url": "https://sap-qas:44300", "client": "100", "username": "DEVELOPER", "password": "${env:SAP_QAS_PASSWORD}", "readOnly": true }
  }
}
```

`${env:NAME}` placeholders are replaced from the environment, so passwords never have to be in
the file. Tools take an optional `system` parameter; without it the default system is used.

## Using it with GitHub Copilot CLI

Follow the [GitHub Copilot CLI setup guide](docs/github-copilot-cli.md) for
Windows/PowerShell instructions covering system configuration, browser SSO, corporate
CA certificates, MCP registration, optional skill registration and troubleshooting.
The [ABAP ADT agent behavior guide](skills/abap-adt/SKILL.md) covers tool selection,
transports, source changes, activation and testing.

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
   For several systems use [examples/vscode-mcp-multi-system.json](examples/vscode-mcp-multi-system.json);
   for a system with single sign-on (no password at all) use
   [examples/vscode-mcp-sso.json](examples/vscode-mcp-sso.json) and read
   [Authentication modes](#authentication-modes).
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
| `abap_deploy_ui5_app` | Upload a built SAPUI5 / Fiori app (dist folder or zip) to the SAPUI5 ABAP repository; test mode by default |
| `abap_ui5_app_info` | Package, description, URL and file inventory of a deployed SAPUI5 app |

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

### Deploying SAPUI5 / Fiori apps

`abap_deploy_ui5_app` does what `fiori deploy` (the `deploy-to-abap` task behind
`npm run deploy` in SAP Business Application Studio) does, with the server's SAP session instead
of the Fiori tools' own logon. That matters for systems behind SAML single sign-on, where
`fiori deploy` only gets the identity provider's HTML page and its user/password prompt is
useless, and for `ui5-deploy.yaml` files that target a BAS destination that does not resolve
outside BAS.

The requests are the ones the official tooling sends (`@sap-ux/deploy-tooling` /
`@sap-ux/axios-extension`): the zipped build result goes in **one** call to the OData service
`/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV` (`POST Repositories` for a new application,
`PUT Repositories('NAME')` for an existing one) with `TransportRequest`, `TestMode` and
`SafeMode` as URL parameters, after the same ADT transport check. The service has to be active
in `SICF` (it is wherever `fiori deploy` already works).

Workflow for an agent:

1. `npm run build` in the app project (the tool uploads the build result, it does not build).
2. Take `app.name`, `app.package`, `app.transport`, `app.description` and `exclude` from
   `ui5-deploy.yaml` and call `abap_deploy_ui5_app` with `source` = the `dist` folder (or a zip
   whose root contains `manifest.json`). `testMode` defaults to **true**: SAP checks the upload
   and returns its message log, nothing is changed.
3. Read the log, then call again with `testMode: false`. The result contains the SAP messages,
   the transport the change was recorded in and the app URL.
4. `abap_ui5_app_info` lists the deployed files with sizes (on releases that support the
   download, otherwise through the ADT filestore); `abap_package_contents` shows the BSP
   application (`WAPA`) in its package.

Rules: transportable packages need `transport` (the tool never creates one, and refuses a
request other than the one the application is already recorded in); an existing application
keeps its package; SAP messages are returned verbatim with their severity; an application built
from a different `sap.app/id` is only overwritten with `safeMode: false`. Adaptation projects
(`manifest.appdescr_variant`, layered repository) are not supported, and there is no undeploy.

### Safety

- `readOnly: true` / `SAP_READ_ONLY=true` turns a system into a browse-only connection.
- The server never deletes objects and never releases transports.
- Passwords: use `${input:...}` prompts in VS Code or `${env:...}` placeholders in the config
  file instead of plain text.
- Everything the agent saves is an inactive version until it explicitly activates it.
- `abap_deploy_ui5_app` only simulates the upload unless it is called with `testMode: false`.

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
- `src/connection.ts` ADT client, authentication modes, stateful locking session, per-system serialisation
- `src/cookieHttp.ts` cookie based HTTP layer with expiry detection and re-logon
- `src/sso.ts` browser single sign-on (DevTools protocol) and cookie cache
- `src/objects.ts` name / URI resolution to source, lock and activation URLs
- `src/services/` read, write, activation, transports, object creation, navigation, UI5 deployment
- `src/zip.ts` zip writer / reader used for the UI5 build result
- `src/tools.ts` MCP tool definitions
- `src/index.ts` CLI entry point (stdio transport)

## Limitations

- Only object types with plain ABAP source can be written (classes, interfaces, programs,
  includes, function modules, CDS/DDL sources). DDIC objects (tables, data elements) can be
  read as XML but not changed.
- UI5 deployment covers BSP applications in the SAPUI5 ABAP repository; adaptation projects
  (layered repository) and undeployment are not implemented.
- SSO logon needs a Chromium based browser on the machine running the server and Node.js 22+.
  Kerberos/SPNEGO and X.509 client certificates are not implemented; a static `cookie` or a
  `bearer` token can be used instead.
