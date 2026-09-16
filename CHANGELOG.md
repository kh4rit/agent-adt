# Changelog

## 0.3.0

- `abap_deploy_ui5_app`: deploy a built SAPUI5 / Fiori app (dist folder or zip) to the SAPUI5
  ABAP repository through the OData service `fiori deploy` uses, with the server's logon
  (basic, SSO cookies, bearer). Test mode by default, transport rules as for source changes
  (never created automatically), SAP message log returned verbatim, safe mode conflicts and
  inactive service reported with guidance
- `abap_ui5_app_info`: package, description, URL and file inventory of a deployed app
- Dependency-free zip writer / reader

## 0.2.0

- Authentication modes: `basic`, `sso` (browser single sign-on for SAML / Entra ID systems),
  `cookie` (static cookie header) and `bearer` (OAuth token)
- SSO: Edge/Chrome is driven over the DevTools protocol, SAP cookies are cached with owner-only
  permissions, expired sessions (401 or SAML redirect) trigger a silent re-logon and one retry
- `--sso-login` and `--system` CLI options; `--check` reports the auth mode
- `noProxy` / `SAP_NO_PROXY` to bypass corporate proxies for the SAP host
- Documentation of proxy and TLS interception caveats

## 0.1.0

First public release.

- MCP server over stdio for GitHub Copilot (VS Code), Claude Code, Cursor and other clients
- Search, object details, read source (active / inactive, line ranges)
- Write and edit source with lock, transport request recording, unlock and syntax check
- Syntax check of unsaved code, activation with parsed activation log
- Inactive objects, transport info, transport list, create transport, create object
- Where-used, package contents, class outline, ABAP Unit
- Multi-system configuration file with `${env:...}` placeholders, read-only mode
- Offline test-suite replaying ADT response formats
