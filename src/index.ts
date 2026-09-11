#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ConfigError, loadConfig } from "./config.js"
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
import { errorMessage } from "./format.js"

const HELP = `${SERVER_NAME} ${SERVER_VERSION} - ABAP Development Tools MCP server

Usage: abap-adt-mcp [--config <file>] [--check]

  --config <file>  JSON configuration with one or more SAP systems (or set ABAP_ADT_CONFIG)
  --check          log on to every configured system, print the result and exit
  --help           show this help

Without --config a single system is read from SAP_URL, SAP_USER, SAP_PASSWORD
(optional SAP_CLIENT, SAP_LANGUAGE, SAP_ALLOW_SELF_SIGNED, SAP_CA_CERT, SAP_SYSTEM_NAME, SAP_READ_ONLY).
The server speaks MCP over stdio; register it in your agent (VS Code / Copilot mcp.json, Claude Code, Cursor ...).`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return
  }
  const config = loadConfig(argv, process.env)
  const { server, systems } = createServer(config)

  if (argv.includes("--check")) {
    let failed = 0
    for (const system of systems.list()) {
      const c = system.config
      process.stdout.write(`${c.name}: ${c.url} client ${c.client ?? "default"} user ${c.username} ... `)
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
