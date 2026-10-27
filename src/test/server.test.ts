import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { callTool, createServer } from "../server.js"
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
  "abap_read_transport",
  "abap_list_versions",
  "abap_sql_query",
  "abap_odata_metadata",
  "abap_create_object",
  "abap_find_usages",
  "abap_package_contents",
  "abap_object_outline",
  "abap_run_unit_tests",
  "abap_deploy_ui5_app",
  "abap_ui5_app_info"
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

const transportList = `<?xml version="1.0" encoding="utf-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="displaytransports">
  <tm:workbench><tm:target tm:name="QAS" tm:desc="Quality"><tm:modifiable>
    <tm:request tm:number="NPLK900010" tm:owner="DEVELOPER" tm:desc="Demo transport" tm:status="D" tm:uri="/sap/bc/adt/cts/transportrequests/NPLK900010">
      <tm:task tm:number="NPLK900011" tm:owner="DEVELOPER" tm:desc="Demo transport" tm:status="D"/>
    </tm:request>
  </tm:modifiable><tm:released/></tm:target></tm:workbench>
  <tm:customizing><tm:target tm:name="QAS" tm:desc="Quality"><tm:modifiable>
    <tm:request tm:number="NPLK900030" tm:owner="OTHER" tm:desc="Customizing for demo" tm:status="D" tm:uri="/sap/bc/adt/cts/transportrequests/NPLK900030">
      <tm:task tm:number="NPLK900031" tm:owner="DEVELOPER" tm:desc="Customizing for demo" tm:status="D"/>
    </tm:request>
  </tm:modifiable><tm:released/></tm:target></tm:customizing>
</tm:root>`

test("callTool runs a tool without an MCP host; transport list covers workbench and customizing requests", async () => {
  const fake = new FakeHttp().on("GET", "/sap/bc/adt/cts/transportrequests", transportList)
  const config = { systems: [testConfig], defaultSystem: "TST" }
  const factory = (c: any) => new AbapSystem(c, fake)
  const r = await callTool(config, "abap_list_transports", {}, factory)
  assert.equal(r.isError, false)
  assert.match(r.text, /^Modifiable transport requests of DEVELOPER \(own requests and requests with a task of DEVELOPER\):\nWorkbench requests, target QAS Quality\nNPLK900010 {2}Demo transport {2}owner DEVELOPER {2}status D\n {4}task NPLK900011/)
  assert.match(r.text, /Customizing requests, target QAS Quality\nNPLK900030 {2}Customizing for demo {2}owner OTHER/)
  assert.equal(fake.find("GET", "/sap/bc/adt/cts/transportrequests")[0].qs.user, "DEVELOPER")
  const empty = await callTool(config, "abap_list_transports", { user: "nobody" }, () => new AbapSystem(testConfig, new FakeHttp().on("GET", "/sap/bc/adt/cts/transportrequests", '<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>')))
  assert.match(empty.text, /NOBODY has no modifiable transport requests \(ADT lists the requests NOBODY owns or has a task in\)/)
  const bad = await callTool(config, "abap_read_source", { name: "ZCL_DEMO", system: "PRD" }, factory)
  assert.equal(bad.isError, true)
  assert.match(bad.text, /Unknown system/)
  await assert.rejects(callTool(config, "abap_nope", {}, factory), /Unknown tool "abap_nope"\. Tools: abap_list_systems/)
})
