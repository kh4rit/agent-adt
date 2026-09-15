# Setting up `abap-adt` for GitHub Copilot CLI

How to get ABAP/ADT access into the Copilot CLI on a new machine. Takes ~10 minutes.
The commands below use Windows/PowerShell. On macOS and Linux, adapt the paths
and environment-variable syntax for your shell.

## 1. Prerequisites

- **Node.js 22 or newer** (`node -v`). Node 20 works for password auth, but
  single sign-on needs 22+.
- **A Chromium browser** (Microsoft Edge or Google Chrome) — only for `auth: "sso"`.
- **GitHub Copilot CLI** (`copilot --version`).
- An SAP user with **ADT authorisation** (the same one you use in Eclipse ADT) and
  network access to `/sap/bc/adt` on the application server.

## 2. Build the server

```powershell
git clone https://github.com/kh4rit/agent-adt.git $env:USERPROFILE\tools\agent-adt
cd $env:USERPROFILE\tools\agent-adt
npm install          # also builds, via the prepare script
npm run build        # only needed if you skipped scripts
```

Any location works — just use the same absolute path in step 5.

## 3. Describe your systems

One file holds every system, so the MCP registration never has to change again.

Create the configuration directory, then save the following as
`%USERPROFILE%\.abap-adt-mcp\systems.json`:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.abap-adt-mcp" | Out-Null
```

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": {
      "url": "https://sap-dev.example.com",
      "client": "100",
      "username": "YOURUSER",
      "auth": "sso",
      "caCert": "C:\\Users\\youruser\\tools\\agent-adt\\corp-ca.pem",
      "noProxy": true
    },
    "QAS": {
      "url": "https://sap-qas.example.com",
      "client": "100",
      "username": "YOURUSER",
      "auth": "sso",
      "caCert": "C:\\Users\\youruser\\tools\\agent-adt\\corp-ca.pem",
      "noProxy": true,
      "readOnly": true
    }
  }
}
```

Field notes:

| Field | Meaning |
|---|---|
| `url` | The URL you use in Eclipse / the browser — normally the **web dispatcher**, not a direct ICM port (those are usually firewalled). |
| `username` | Required in every auth mode. With SSO it is not used to log on, only for the transport list default and for display. |
| `auth` | `sso` (browser SAML/Entra ID), `basic` (user + password), `cookie`, `bearer`. |
| `caCert` | Needed behind TLS interception (Zscaler & co.) — see step 3b. |
| `noProxy` | `true` on a corporate network, so requests to the internal SAP host bypass `HTTPS_PROXY`. |
| `readOnly` | `true` makes the system browse-only. **Set this on QA and production.** |

For password auth use `"auth": "basic"` with
`"password": "${env:SAP_DEV_PASSWORD}"` — the `${env:...}` placeholder is resolved
at runtime, so no secret ends up in the file.

### 3b. Corporate CA certificate

If `--check` later fails with `self-signed certificate in certificate chain`, Node
does not trust your corporate TLS-interception CA. Export it once:

```powershell
# Export the corporate root CA from the Windows certificate store (adjust the
# subject filter to your CA), or export the chain your browser shows for the SAP host:
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -like "*YourCorpCA*" -or $_.Subject -like "*Zscaler*" } |
  ForEach-Object {
    "-----BEGIN CERTIFICATE-----"
    [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
    "-----END CERTIFICATE-----"
  } | Set-Content -Encoding ascii $env:USERPROFILE\tools\agent-adt\corp-ca.pem
```

Point `caCert` at that file. (`"allowSelfSigned": true` also works but disables
certificate checking entirely — avoid it.)

## 4. Log on once and verify

```powershell
$env:ABAP_ADT_CONFIG="$env:USERPROFILE\.abap-adt-mcp\systems.json"
node $env:USERPROFILE\tools\agent-adt\dist\index.js --sso-login
node $env:USERPROFILE\tools\agent-adt\dist\index.js --check
```

Expected:

```
[DEV] browser logon to sap-dev.example.com (no valid cached logon)
[DEV] silent logon: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
[DEV] logged on; cached sap-usercontext, SAP_SESSIONID_DEV_100 in ...\DEV.cookies.json
DEV: https://sap-dev.example.com client 100 user YOURUSER auth sso ... OK
```

A browser window may flash up or offer to download the ADT discovery XML — that is
normal, it closes itself once the cookies are captured. Cookies land in
`%USERPROFILE%\.abap-adt-mcp\<SID>.cookies.json` and are reused across restarts;
the identity-provider session lives in `%USERPROFILE%\.abap-adt-mcp\browser-profile`.

**Do not continue until `--check` prints `OK`.** Debugging this inside the agent is
much harder.

## 5. Register the MCP server with Copilot CLI

```powershell
copilot mcp add abap-adt `
  --env "ABAP_ADT_CONFIG=$env:USERPROFILE\.abap-adt-mcp\systems.json" `
  --timeout 180000 `
  -- node "$env:USERPROFILE\tools\agent-adt\dist\index.js"
```

This writes `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "abap-adt": {
      "type": "local",
      "command": "node",
      "args": ["C:\\Users\\youruser\\tools\\agent-adt\\dist\\index.js"],
      "env": { "ABAP_ADT_CONFIG": "C:\\Users\\youruser\\.abap-adt-mcp\\systems.json" },
      "tools": ["*"],
      "timeout": 180000
    }
  }
}
```

The generous timeout matters: the first call of a session may have to run a browser
logon. Check with `copilot mcp list`, or `/mcp` inside an interactive session.

## 6. Register the skill (optional)

This repository includes the [ABAP ADT agent skill](../skills/abap-adt/SKILL.md).
Register it with the commands below. MCP tools work without it.

The MCP server supplies the *tools*; the skill tells the agent *how to use them*
(transport handling, activation, file layout for downloads, troubleshooting).

```powershell
copilot skill add $env:USERPROFILE\tools\agent-adt\skills\abap-adt\SKILL.md
```

This materialises it into `~/.copilot/skills/abap-adt/SKILL.md`. To keep it in sync
with the repository instead, register the **directory** — it stays a live reference:

```powershell
copilot skill add $env:USERPROFILE\tools\agent-adt\skills
```

For a single project only, use `copilot skill add --project ...`, which installs
into `.github/skills/` of the repository so the whole team gets it.

Verify with `copilot skill list` or `/skills` in a session.

## 7. Smoke test

Start `copilot` and ask:

> Which SAP systems can you reach? List the contents of package `ZMY_PACKAGE`
> and show me the first 40 lines of `ZCL_MY_UTILITY`.

The agent should call `abap_list_systems`, `abap_package_contents` and
`abap_read_source`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `copilot mcp list` shows the server but no tools appear | The server crashed at startup. Run the exact `node ...\dist\index.js` command manually — a config error is printed to stderr. |
| `ERR_PROXY_TUNNEL`, 502, or a hang | Corporate proxy. Set `"noProxy": true`, or add the SAP host to `NO_PROXY`. |
| `self-signed certificate in certificate chain` | See step 3b; or set `NODE_EXTRA_CA_CERTS` to the PEM. |
| SSO opens a window every single time | The browser profile is not persisting. Check write access to `%USERPROFILE%\.abap-adt-mcp\browser-profile`, and that `SAP_SSO_HEADLESS` is not forced to `false`. |
| Logon works, tools return 401 after a while | Normal cookie expiry — the server re-logs on and retries once. Lower `sso.maxAgeHours` if it is disruptive. |
| `Cannot find module ...\dist\index.js` | `npm run build` was not executed, or the path in `mcp-config.json` is wrong. |
| Multiple machines, one config | `systems.json` is portable except for `caCert`. Update the absolute `caCert` path on each machine to point to its local PEM file. |

## Files this setup creates

| Path | Purpose | Contains secrets? |
|---|---|---|
| `~/.abap-adt-mcp/systems.json` | System definitions | No, if you use `sso` or `${env:...}` |
| `~/.abap-adt-mcp/<SID>.cookies.json` | Cached SAP session cookies | **Yes** — owner-only permissions, never commit |
| `~/.abap-adt-mcp/browser-profile/` | Identity-provider session | **Yes** — never commit |
| `~/.copilot/mcp-config.json` | MCP server registration | No |
| `~/.copilot/skills/abap-adt/SKILL.md` | The skill (if materialised) | No |
