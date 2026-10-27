#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ConfigError, configFile, loadConfig } from "./config.js"
import { readFileSync, watchFile } from "node:fs"
import { callTool, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
import { errorMessage } from "./format.js"

const HELP = `${SERVER_NAME} ${SERVER_VERSION} - ABAP Development Tools MCP server

Usage: abap-adt-mcp [--config <file>] [--check | --sso-login | --call <tool>] [--system <name>] [--args <json>]

  --config <file>  JSON configuration with one or more SAP systems (or set ABAP_ADT_CONFIG)
  --check          log on to every configured system, print the result and exit
  --sso-login      open the browser to log on to the sso systems, cache the SAP cookies and exit
  --system <name>  restrict --check / --sso-login to one system
  --call <tool>    run one tool without an MCP host and print its result, e.g.
                   --call abap_list_transports --args '{"system":"FE2"}'
  --args <json>    arguments of the tool: inline JSON, @file.json, or - to read stdin (default {})
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
  const callIdx = argv.indexOf("--call")
  if (callIdx >= 0) {
    const tool = argv[callIdx + 1]
    if (!tool || tool.startsWith("--")) throw new Error("--call requires a tool name, e.g. --call abap_list_systems")
    const argsIdx = argv.indexOf("--args")
    let raw = argsIdx >= 0 ? argv[argsIdx + 1] : "{}"
    if (raw === undefined) throw new Error("--args requires inline JSON, @file.json or -")
    if (raw === "-") raw = readFileSync(0, "utf8")
    else if (raw.startsWith("@")) raw = readFileSync(raw.slice(1), "utf8")
    let args: Record<string, unknown>
    try {
      args = JSON.parse(raw.replace(/^\uFEFF/, ""))
    } catch (e) {
      throw new Error(`--args is not valid JSON: ${(e as Error).message}`)
    }
    const result = await callTool(config, tool, args)
    console.log(result.text)
    process.exitCode = result.isError ? 1 : 0
    return
  }
  const { server, systems } = createServer(config)
  const only = argv.indexOf("--system") >= 0 ? argv[argv.indexOf("--system") + 1] : undefined
  const selected = only ? [systems.get(only)] : systems.list()

  if (argv.includes("--sso-login") || argv.includes("--check")) {
    // the CLI has no host timeout: wait for interactive logons to finish
    for (const system of selected) if (system.sso) system.sso.waitSeconds = undefined
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

  // pick up edits of the config file (renamed or added systems) without restarting the host
  const file = configFile(argv, process.env)
  if (file)
    watchFile(file, { interval: 2000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return
      try {
        const { added, changed, removed } = systems.update(loadConfig(argv, process.env))
        const parts = [added.length && `added ${added.join(", ")}`, changed.length && `changed ${changed.join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean)
        console.error(`config ${file} reloaded${parts.length ? `: ${parts.join("; ")}` : ""}`)
      } catch (e) {
        console.error(`config ${file} not reloaded, keeping the previous one: ${e instanceof ConfigError ? e.message : errorMessage(e)}`)
      }
    }).unref()
}

main().catch(e => {
  console.error(e instanceof ConfigError ? e.message : errorMessage(e))
  process.exit(1)
})
