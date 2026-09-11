import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../server.js"
import { AbapSystem } from "../connection.js"
import { FakeHttp, testConfig } from "./fake.js"
import * as fx from "./fixtures.js"

const EXPECTED_TOOLS = [
  "abap_list_systems",
  "abap_search_objects",
  "abap_get_object",
  "abap_read_source",
  "abap_write_source",
  "abap_edit_source",
  "abap_syntax_check",
  "abap_activate",
  "abap_inactive_objects",
  "abap_transport_info",
  "abap_list_transports",
  "abap_create_transport",
  "abap_create_object",
  "abap_find_usages",
  "abap_package_contents",
  "abap_object_outline",
  "abap_run_unit_tests"
]

async function connect(fake: FakeHttp) {
  const { server } = createServer({ systems: [testConfig], defaultSystem: "TST" }, c => new AbapSystem(c, fake))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n")

test("MCP server exposes the tools and answers a search", async () => {
  const fake = new FakeHttp().on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
  const client = await connect(fake)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(t => t.name).sort(), [...EXPECTED_TOOLS].sort())
  const search = await client.callTool({ name: "abap_search_objects", arguments: { query: "zcl_demo" } })
  assert.equal(search.isError, undefined)
  assert.match(text(search), /CLAS\/OC ZCL_DEMO {2}Demo class {2}\[ZDEMO\] {2}\/sap\/bc\/adt\/oo\/classes\/zcl_demo/)
  assert.equal(fake.find("GET", "/sap/bc/adt/repository/informationsystem/search")[0].qs.query, "ZCL_DEMO*")
  const systems = await client.callTool({ name: "abap_list_systems", arguments: {} })
  assert.match(text(systems), /TST \(default\): http:\/\/fake client 001 user developer/)
  await client.close()
})

test("MCP server reports errors as tool errors instead of protocol failures", async () => {
  const fake = new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("GET", fx.CLASS_SOURCE_URL, fx.classSource)
    .on("POST", fx.CLASS_URL, c => (c.qs._action === "LOCK" ? fx.lockResult("") : ""))
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
  const client = await connect(fake)
  const read = await client.callTool({ name: "abap_read_source", arguments: { name: "ZCL_DEMO", lineNumbers: true } })
  assert.match(text(read), /1\| CLASS zcl_demo DEFINITION/)
  const write = await client.callTool({ name: "abap_write_source", arguments: { name: "ZCL_DEMO", source: "x" } })
  assert.equal(write.isError, true)
  assert.match(text(write), /needs a transport request/)
  const missing = await client.callTool({ name: "abap_read_source", arguments: { name: "ZCL_DEMO", system: "PRD" } })
  assert.equal(missing.isError, true)
  assert.match(text(missing), /Unknown system "PRD"/)
  const edit = await client.callTool({ name: "abap_edit_source", arguments: { name: "ZCL_DEMO", edits: [{ oldText: "nope", newText: "x" }] } })
  assert.equal(edit.isError, true)
  assert.match(text(edit), /not found/)
  await client.close()
})
