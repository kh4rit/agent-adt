#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ConfigError, loadConfig } from "./config.js"
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
import { errorMessage } from "./format.js"

const HELP = `${SERVER_NAME} ${SERVER_VERSION} - ABAP Development Tools MCP server

Usage: abap-adt-mcp [--config <file>] [--check | --sso-login] [--system <name>]

  --config <file>  JSON configuration with one or more SAP systems (or set ABAP_ADT_CONFIG)
  --check          log on to every configured system, print the result and exit
  --sso-login      open the browser to log on to the sso systems, cache the SAP cookies and exit
  --system <name>  restrict --check / --sso-login to one system
  --help           show this help

Without --config a single system is read from SAP_URL, SAP_USER and SAP_PASSWORD, or SAP_AUTH=sso
for browser single sign-on (optional SAP_CLIENT, SAP_LANGUAGE, SAP_ALLOW_SELF_SIGNED, SAP_CA_CERT,
SAP_NO_PROXY, SAP_SYSTEM_NAME, SAP_READ_ONLY, SAP_SSO_BROWSER, SAP_SSO_PROFILE_DIR, SAP_SSO_HEADLESS).
The server speaks MCP over stdio; register it in your agent (VS Code / Copilot mcp.json, Claude Code, Cursor ...).`

const describeCookies = (names: string[]) => (names.length ? names.join(", ") : "none")

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return
  }
  const config = loadConfig(argv, process.env)
  const { server, systems } = createServer(config)
  const only = argv.indexOf("--system") >= 0 ? argv[argv.indexOf("--system") + 1] : undefined
  const selected = only ? [systems.get(only)] : systems.list()

  if (argv.includes("--sso-login") || argv.includes("--check")) {
    let failed = 0
    for (const system of selected) {
      const c = system.config
      if (argv.includes("--sso-login")) {
        if (!system.sso) {
          console.log(`${c.name}: auth is ${system.auth}, nothing to do`)
          continue
        }
        console.log(`${c.name}: opening the browser for ${system.sso.loginUrl}`)
        try {
          system.sso.forget()
          await system.sso.logon(true)
          const cached = system.sso.cached()
          console.log(`${c.name}: cookies ${describeCookies(cached?.cookies.map(k => k.name) ?? [])} cached in ${system.sso.cacheFile}`)
        } catch (e) {
          failed++
          console.log(`${c.name}: browser logon FAILED\n   ${errorMessage(e)}`)
          continue
        }
      }
      process.stdout.write(`${c.name}: ${c.url} client ${c.client ?? "default"} user ${c.username} auth ${system.auth} ... `)
      try {
        await system.login()
        const hits = await system.reader.searchObject("CL_ABAP_TYPEDESCR", "CLAS", 1)
        console.log(`OK${hits.length ? "" : " (logged on, but the object search returned nothing)"}${c.readOnly ? " [read-only]" : ""}`)
      } catch (e) {
        failed++
        console.log(`FAILED\n   ${errorMessage(e)}`)
      }
    }
    process.exitCode = failed ? 1 : 0
    return
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready: ${systems.list().map(s => s.name).join(", ")}`)
}

main().catch(e => {
  console.error(e instanceof ConfigError ? e.message : errorMessage(e))
  process.exit(1)
})
