---
name: abap-adt
description: Read, search, write, activate, and test ABAP objects through SAP ADT. Use for ABAP source, SAP packages, transports, CDS, function modules, DDIC inspection, ABAP Unit, and downloading source from or updating source in SAP.
---

# ABAP ADT agent behavior

Use the `abap-adt-mcp` tools for repository work in SAP. For installation, MCP
registration and skill registration, follow the
[GitHub Copilot CLI setup guide](../../docs/github-copilot-cli.md).

## Start with the target system

- Call `abap_list_systems` at the start of an ADT task. Use the returned system
  name in subsequent calls; confirm the intended target if it is ambiguous.
  Listing configured systems does not itself verify a live SAP connection.
- Treat QA and production as read-only unless the user explicitly authorizes
  changes there. Respect `READ-ONLY` connections; do not disable that setting
  to work around a rejected operation.
- Never write credentials, bearer tokens or session cookies to source, config,
  documentation or other files. Use environment-variable references or the
  configured browser SSO flow. Let the server manage its own session cache;
  never copy that cache or the browser profile into downloads or version control.

## ADT tool selection

| Task | Tool and guidance |
|---|---|
| Identify systems | `abap_list_systems` returns configured names, defaults and read-only flags. |
| Find objects | `abap_search_objects` searches name patterns such as `ZCL_INV*`; filter by type when needed. It is not a full-text source search. |
| Inspect metadata | `abap_get_object` returns package, version, source URI, class includes and main program. |
| Browse a package | `abap_package_contents` lists objects grouped by type with ADT URIs. |
| Read or download source | `abap_read_source` reads source or a DDIC XML definition; use line ranges for inspection and full source for downloads. |
| Inspect class structure | `abap_object_outline` shows methods, attributes and events. |
| Find dependencies | `abap_find_usages` finds uses of an object or a symbol at a source position. |
| Make a focused edit | `abap_edit_source` applies exact replacements; each `oldText` must occur exactly once. |
| Replace full source | `abap_write_source` replaces the complete object or selected include, then checks syntax by default. |
| Check syntax | `abap_syntax_check` checks current source or a supplied unsaved candidate. |
| Inspect transport requirements | `abap_transport_info` reports the existing request lock and candidate transports. |
| Find a transport | `abap_list_transports` lists modifiable workbench requests and tasks. |
| Create a transport | `abap_create_transport` creates a request for an object or package when needed for the authorized change. |
| Create an object | `abap_create_object` creates a supported empty object; supply the package and transport, and a parent function group where required. Then write and activate its source. |
| Activate changes | `abap_activate` activates specified objects and returns the activation log. |
| Inspect pending activation | `abap_inactive_objects` lists the current user's inactive objects and transports. |
| Test behavior | `abap_run_unit_tests` runs ABAP Unit for the relevant object. |

## Read, change and validate

1. Find the object and use the returned ADT object `uri` in later calls. Do not
   construct guessed URIs, especially for function modules and includes. Use
   metadata to select the correct class include (`main`, `testclasses`,
   `definitions`, `implementations` or `macros`). DDIC objects such as tables and
   data elements can be read as XML; these tools cannot write their definitions.
2. Read the current source before editing. Reads prefer a saved inactive version
   when one exists; request `version: "active"` when inspecting deployed behavior.
   Inspect existing inactive changes and preserve work outside the requested scope.
3. Resolve transport handling before saving. Local objects (`$TMP` or local
   packages) need no transport. For transportable objects, inspect
   `abap_transport_info` and use the existing request or an appropriate modifiable
   request/task from `abap_list_transports`. Honor the user's chosen transport;
   resolve conflicting locks or ambiguous choices before writing. Create a request
   only when needed within the authorized scope, and use its returned number.
4. Prefer `abap_edit_source` for small changes, with enough surrounding text for
   each match to be unique. For `abap_write_source`, supply the complete source
   without line-number prefixes or output headers. Keep syntax checking enabled;
   use `abap_syntax_check` on an unsaved candidate when useful. The save tools
   handle locking, transport recording and unlocking.
5. Activate after saving unless the user requested an inactive draft. Use
   `activate: true` on the save or `abap_activate` with explicit target objects.
   A successful save or syntax check does not prove activation succeeded. Class
   include activation affects the whole class; inspect its pending changes first.
   Avoid `all: true` unless activation of all the user's inactive work is intended.
6. Inspect the activation log. For errors, read the reported object/include and
   line, fix errors within scope, save and activate again. If a dependency,
   authorization issue or repeated error prevents progress, report the blocker
   and remaining inactive objects instead of retrying unchanged operations.
7. Run `abap_run_unit_tests` where relevant after activation, including affected
   class tests. Inspect failures and fix regressions caused by the change. Report
   the system, changed objects, actual transport used, activation outcome and test
   results; distinguish tests that passed from tests that could not run.

## Downloads and updates from local files

For SAP source downloads, use the requested local layout or the repository's
existing convention. Otherwise group files by system, package and object, with
separate files for class includes. Keep ABAP/CDS source and DDIC XML distinct.
Record the object URI, include and active/inactive version separately from source
so a later update can target the same object. Retrieve the complete source with
`lineNumbers: false`; exclude tool status headers from saved source files.

Before updating SAP from a local file, read the current remote version and compare
it with the local change. Then follow the transport, save, activation and test
workflow above. A download request alone does not authorize remote changes.

## Troubleshooting

| Symptom | Agent response |
|---|---|
| SSO logon waits or opens a browser | Allow the user to complete browser logon/MFA. SSO requires Node.js 22+ and Edge or Chrome; an ADT discovery XML download is expected. For persistent failures, use the setup guide's logon and `--check` steps with the configured system file. Never ask the user to paste cookies into chat. |
| Proxy 502 or `ERR_PROXY_TUNNEL` | Check the configured SAP host and corporate network access. Use `noProxy: true` / `SAP_NO_PROXY=true`, or add the SAP host to `NO_PROXY`, when direct access is appropriate. See the setup guide for configuration. |
| TLS certificate-chain error | Use the corporate CA PEM through `caCert` / `SAP_CA_CERT` or `NODE_EXTRA_CA_CERTS`. Keep certificate verification enabled; do not fix this by enabling `allowSelfSigned`. Keep local `corp-ca.pem` out of version control. |
| Authentication expires (401 or SAML HTML) | In SSO mode the server re-logs on and retries once. If it still fails, have the user complete logon and verify the connection. Static cookie/bearer credentials require renewal through the configured authentication mechanism. Before manually retrying a failed mutation, inspect source and transport state to see whether it took effect. |
| Missing transport | The save tool reports that nothing was saved and lists candidate requests. Inspect transport info, select an appropriate request/task or create one within scope, then retry with `transport`. Do not move the object to a local package to bypass this requirement. |
| Read shows changes but runtime behavior is unchanged | Reads default to inactive source when present. Compare with `version: "active"`, inspect metadata or `abap_inactive_objects`, and activate the intended changes after fixing errors. Report an inactive draft accurately. |
