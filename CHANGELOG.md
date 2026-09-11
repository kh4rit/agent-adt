# Changelog

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
