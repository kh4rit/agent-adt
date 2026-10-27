import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callTool } from "../server.js"
import { AbapSystem, Systems } from "../connection.js"
import { checkQuery } from "../services/data.js"
import { parseTransport } from "../services/transports.js"
import { metadataPath, summarizeMetadata } from "../services/odata.js"
import { FakeHttp, makeSystem, testConfig } from "./fake.js"
import * as fx from "./fixtures.js"

const config = { systems: [testConfig], defaultSystem: "TST" }
const tool = (fake: FakeHttp, name: string, args: Record<string, unknown>, extra: Partial<typeof testConfig> = {}) =>
  callTool({ systems: [{ ...testConfig, ...extra }], defaultSystem: "TST" }, name, args, c => new AbapSystem(c, fake))

test("abap_sql_query runs a SELECT through data preview and formats the rows", async () => {
  const fake = new FakeHttp().on("POST", "/sap/bc/adt/datapreview/freestyle", fx.dataPreview([
    { TRKORR: "NPLK900010", AS4TEXT: "Demo | transport" },
    { TRKORR: "NPLK900020", AS4TEXT: "Other" }
  ]))
  const r = await tool(fake, "abap_sql_query", { query: "SELECT trkorr, as4text FROM e07t WHERE trkorr LIKE 'NPLK%'.", maxRows: 2 })
  assert.equal(r.isError, false)
  assert.match(r.text, /^TST client 001: 2 rows \(row limit 2 reached, more rows may exist/)
  assert.match(r.text, /\| TRKORR \| AS4TEXT \|\n\|---\|---\|\n\| NPLK900010 \| Demo \\\| transport \|\n\| NPLK900020 \| Other \|/)
  const [call] = fake.find("POST", "/sap/bc/adt/datapreview/freestyle")
  assert.equal(call.body, "SELECT trkorr, as4text FROM e07t WHERE trkorr LIKE 'NPLK%'")
  assert.equal(`${call.qs.rowNumber}`, "2")
})

test("abap_sql_query refuses non-SELECT statements and systems with allowSql false, without calling SAP", async () => {
  assert.throws(() => checkQuery("DELETE FROM e070"), /Only SELECT/)
  assert.throws(() => checkQuery("  "), /must not be empty/)
  assert.equal(checkQuery("* comment line\nSELECT * FROM t000;"), "* comment line\nSELECT * FROM t000")
  assert.equal(checkQuery("WITH +x AS ( SELECT mandt FROM t000 ) SELECT * FROM +x"), "WITH +x AS ( SELECT mandt FROM t000 ) SELECT * FROM +x")
  const fake = new FakeHttp()
  const update = await tool(fake, "abap_sql_query", { query: "UPDATE e070 SET trstatus = 'R'" })
  assert.equal(update.isError, true)
  const off = await tool(fake, "abap_sql_query", { query: "SELECT * FROM t000" }, { allowSql: false })
  assert.equal(off.isError, true)
  assert.match(off.text, /switched off for system TST/)
  assert.equal(fake.find("POST", /datapreview/).length, 0)
  const systems = await tool(fake, "abap_list_systems", {}, { allowSql: false })
  assert.match(systems.text, /SQL off/)
})

test("parseTransport reads request, tasks with owners and the object list", () => {
  const t = parseTransport(fx.transportDocument)
  assert.equal(t.number, "NPLK900060")
  assert.equal(t.owner, "OTHER")
  assert.equal(t.description, "Demo app & package")
  assert.equal(t.status, "Modifiable")
  assert.equal(t.changedAt, "2026-10-15 13:14:45")
  assert.deepEqual(
    t.tasks.map(x => [x.number, x.owner, x.objects.length]),
    [["NPLK900061", "OTHER", 2], ["NPLK900062", "DEVELOPER", 0]]
  )
  assert.deepEqual(
    t.objects.map(o => `${o.pgmid} ${o.type} ${o.name}`),
    ["R3TR WAPA ZDEMO_APP", "R3TR DEVC ZDEMO"]
  )
})

test("abap_read_transport shows a request of another owner and explains task numbers", async () => {
  const fake = new FakeHttp().on("GET", /^\/sap\/bc\/adt\/cts\/transportrequests\/NPLK90006[01]$/, fx.transportDocument)
  const r = await tool(fake, "abap_read_transport", { number: "nplk900060" })
  assert.equal(r.isError, false)
  assert.match(r.text, /^Request NPLK900060 {2}Demo app & package\nworkbench request {2}owner OTHER {2}status Modifiable {2}target \/NPL\/ {2}last changed 2026-10-15 13:14:45/)
  assert.match(r.text, /Tasks \(2\):\n {2}NPLK900061 {2}owner OTHER {2}Modifiable {2}2 objects\n {2}NPLK900062 {2}owner DEVELOPER {2}Modifiable {2}0 objects/)
  assert.match(r.text, /Objects \(2\):\n {2}R3TR WAPA ZDEMO_APP {2}\(BSP \(Business Server Pages\) Application\) {2}Demo app\n {2}R3TR DEVC ZDEMO {2}\(Package\) {2}Demo package$/)
  const task = await tool(fake, "abap_read_transport", { number: "NPLK900061", withObjects: false })
  assert.match(task.text, /^NPLK900061 is a task of request NPLK900060\./)
  assert.doesNotMatch(task.text, /R3TR WAPA/)
  const bad = await tool(fake, "abap_read_transport", { number: "NPL" })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /not a transport request number/)
})

test("abap_list_versions and abap_read_source with revision read stored versions", async () => {
  const fake = new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchAmbiguous)
    .on("GET", fx.PROG_URL, fx.programStructureWithVersions)
    .on("GET", `${fx.PROG_URL}/source/main/versions`, fx.versionFeed)
    .on("GET", `${fx.PROG_URL}/source/main/versions/20261026143135/00000/content`, "REPORT zdemo_report.\nWRITE 'first'.")
  const list = await tool(fake, "abap_list_versions", { name: "ZDEMO", type: "PROG/P" })
  assert.equal(list.isError, false)
  assert.match(list.text, /^2 stored versions of PROG\/P ZDEMO_REPORT/)
  assert.match(list.text, /- 00001 {2}2026-10-26 14:31:35 {2}OTHER {2}NPLK900071 {2}Second change\n- 00000 {2}2026-10-22 06:29:43 {2}DEVELOPER {2}NPLK900070 {2}First version/)
  const old = await tool(fake, "abap_read_source", { name: "ZDEMO", type: "PROG/P", revision: "0", lineNumbers: true })
  assert.match(old.text, /^PROG\/P ZDEMO_REPORT \[stored version 00000, 2026-10-22T06:29:43Z, DEVELOPER, NPLK900070\] 2 lines\n1\| REPORT zdemo_report\.\n2\| WRITE 'first'\./)
  const missing = await tool(fake, "abap_read_source", { name: "ZDEMO", type: "PROG/P", revision: "00007" })
  assert.equal(missing.isError, true)
  assert.match(missing.text, /no stored version "00007"[\s\S]*00001/)
  const noHistory = new FakeHttp().on("GET", fx.PROG_URL, fx.programStructure)
  const none = await tool(noHistory, "abap_list_versions", { uri: fx.PROG_URL })
  assert.match(none.text, /no version history/)
})

test("metadataPath accepts service paths and URLs of the system only", () => {
  const system = makeSystem(new FakeHttp(), { url: "https://sap.example.com:44300" })
  assert.equal(metadataPath(system, "/sap/opu/odata4/sap/api_demo/srvd_a2x/sap/demo/0001/"), "/sap/opu/odata4/sap/api_demo/srvd_a2x/sap/demo/0001/$metadata")
  assert.equal(metadataPath(system, "sap/opu/odata/sap/ZDEMO_SRV/$metadata?sap-client=001"), "/sap/opu/odata/sap/ZDEMO_SRV/$metadata")
  assert.equal(metadataPath(system, "https://sap.example.com:44300/sap/opu/odata/sap/ZDEMO_SRV"), "/sap/opu/odata/sap/ZDEMO_SRV/$metadata")
  assert.throws(() => metadataPath(system, "https://evil.example.com/sap/opu/odata/sap/ZDEMO_SRV"), /not on the host/)
  assert.throws(() => metadataPath(system, "/sap/bc/adt/discovery"), /not an OData service path/)
})

test("summarizeMetadata lists entity types, keys, navigation, actions and V2 function imports", () => {
  const v4 = summarizeMetadata(fx.odataV4Metadata)
  assert.match(v4, /EDMX version 4\.0/)
  assert.match(v4, /EntityType OrderType {2}keys: Warehouse, OrderId\n {4}properties: Warehouse: String\(4\) key, OrderId: String\(10\) key, CreatedAt: DateTimeOffset\n {4}navigation: _Task -> \[TaskType\]/)
  assert.match(v4, /Action ConfirmTask\(_it: TaskType, Quantity: Decimal\) -> TaskType {2}\[bound\]/)
  assert.match(v4, /EntitySets: Order \(OrderType\), Task \(TaskType\)/)
  const v2 = summarizeMetadata(fx.odataV2Metadata)
  assert.match(v2, /EntityType Product {2}keys: Product/)
  assert.match(v2, /FunctionImport Release POST\(Product: String\) -> Product/)
})

test("abap_odata_metadata fetches $metadata with the system logon and can save it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adt-odata-"))
  const path = "/sap/opu/odata4/sap/api_demo/srvd_a2x/sap/demo/0001/$metadata"
  const fake = new FakeHttp().on("GET", path, fx.odataV4Metadata)
  const file = join(dir, "sub", "demo.xml")
  const r = await tool(fake, "abap_odata_metadata", { service: "/sap/opu/odata4/sap/api_demo/srvd_a2x/sap/demo/0001", saveTo: file })
  assert.equal(r.isError, false)
  assert.match(r.text, /^TST \/sap\/opu\/odata4\/.*\$metadata\nOData metadata, EDMX version 4\.0/)
  assert.match(r.text, /Saved the complete \$metadata \(\d+ KB\) to .*demo\.xml\.$/)
  assert.equal(readFileSync(file, "utf8"), fx.odataV4Metadata)
  assert.equal(fake.find("GET", path)[0].qs["sap-client"], "001")
  const missing = await tool(new FakeHttp(), "abap_odata_metadata", { service: "/sap/opu/odata/sap/ZNOPE_SRV" })
  assert.equal(missing.isError, true)
  assert.match(missing.text, /HTTP 404 .*not published/)
})

test("Systems.update keeps unchanged systems with their session and replaces changed ones", () => {
  const made: string[] = []
  const factory = (c: typeof testConfig) => {
    made.push(c.name)
    return new AbapSystem(c, new FakeHttp())
  }
  const systems = new Systems({ systems: [testConfig, { ...testConfig, name: "QAS" }], defaultSystem: "TST" }, factory)
  const tst = systems.get("TST")
  const result = systems.update({ systems: [testConfig, { ...testConfig, name: "NEW" }, { ...testConfig, name: "QAS", client: "002" }], defaultSystem: "NEW" })
  assert.deepEqual(result, { added: ["NEW"], changed: ["QAS"], removed: [] })
  assert.equal(systems.get("TST"), tst)
  assert.equal(systems.get().name, "NEW")
  assert.equal(systems.get("QAS").config.client, "002")
  assert.deepEqual(systems.update({ systems: [testConfig], defaultSystem: "TST" }).removed, ["NEW", "QAS"])
  assert.throws(() => systems.get("QAS"), /Unknown system/)
  assert.deepEqual(made, ["TST", "QAS", "NEW", "QAS"])
})
