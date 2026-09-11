import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Systems } from "./connection.js"
import { registerTools } from "./tools.js"
import type { Config } from "./config.js"
import { AbapSystem } from "./connection.js"
import type { SystemConfig } from "./config.js"

import { SERVER_NAME, SERVER_VERSION } from "./version.js"

export { SERVER_NAME, SERVER_VERSION }

export function createServer(config: Config, factory?: (c: SystemConfig) => AbapSystem) {
  const systems = new Systems(config, factory)
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "ABAP Development Tools for agents: search, read, edit, save (to transport requests) and activate ABAP objects in SAP systems via ADT.",
        "Typical workflow: abap_search_objects -> abap_read_source -> abap_edit_source or abap_write_source (transport needed for transportable packages; see abap_transport_info / abap_list_transports / abap_create_transport) -> abap_activate -> fix reported errors -> abap_run_unit_tests.",
        "Saving creates an inactive version; nothing is live until activated. Activation errors include object, line and message."
      ].join("\n")
    }
  )
  registerTools(server, systems)
  return { server, systems }
}
