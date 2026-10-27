import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../server.js"
import { AbapSystem } from "../connection.js"
import { resolveObject } from "../objects.js"
import { writeSource } from "../services/source.js"
import { FakeHttp, makeSystem, testConfig, type Call } from "./fake.js"
import * as fx from "./fixtures.js"

const EU510 = (user: string) => ({
  status: 403,
  statusText: "Forbidden",
  headers: { "content-type": "application/xml" },
  body: fx.adtError(`User ${user} is currently editing ZCL_DEMO`).replace("<properties/>", `<properties><entry key="T100KEY-ID">EU</entry><entry key="T100KEY-NO">510</entry><entry key="LONGTEXT">&lt;HTML&gt;&lt;BODY&gt;long SAPscript text&lt;/BODY&gt;&lt;/HTML&gt;</entry></properties>`)
})

/**
 * Fake SAP with an enqueue: a second LOCK while the object is locked fails with EU510, as in
 * the real system; UNLOCK or the end of the stateful session release it.
 */
function sapWithEnqueue() {
  let source = fx.classSource
  let locked = false
  const fake = new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("GET", fx.CLASS_SOURCE_URL, () => source)
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("POST", "/sap/bc/adt/checkruns", fx.syntaxClean)
    .on("POST", "/sap/bc/adt/activation", '<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"/>')
    .on("PUT", fx.CLASS_SOURCE_URL, (c: Call) => {
      source = c.body ?? ""
      return ""
    })
    .on("POST", fx.CLASS_URL, (c: Call) => {
      if (c.qs._action === "LOCK") {
        if (locked) return EU510("DEVELOPER")
        locked = true
        return fx.lockResult("NPLK900010")
      }
      if (c.qs._action === "UNLOCK") locked = false
      return ""
    })
  fake.delayMs = 2
  return { fake, source: () => source }
}

async function connect(fake: FakeHttp) {
  const { server } = createServer({ systems: [testConfig], defaultSystem: "TST" }, c => new AbapSystem(c, fake))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n")

test("parallel edits and reads in single-session mode run one after the other: no EU510, both changes saved", async () => {
  const { fake, source } = sapWithEnqueue()
  const client = await connect(fake)
  const [first, second, read] = await Promise.all([
    client.callTool({ name: "abap_edit_source", arguments: { name: "ZCL_DEMO", edits: [{ oldText: "'hello'", newText: "'first'" }], activate: true } }),
    client.callTool({ name: "abap_edit_source", arguments: { name: "ZCL_DEMO", edits: [{ oldText: "VALUE(rv_result) TYPE string", newText: "VALUE(rv_result) TYPE char10" }] } }),
    client.callTool({ name: "abap_read_source", arguments: { name: "ZCL_DEMO" } })
  ])
  assert.equal(first.isError, undefined, text(first))
  assert.equal(second.isError, undefined, text(second))
  assert.equal(read.isError, undefined, text(read))
  assert.match(source(), /'first'/)
  assert.match(source(), /TYPE char10/)
  // between a LOCK and its UNLOCK only the calls of that save happen
  let inLock = false
  for (const c of fake.calls) {
    const action = c.qs._action
    if (action === "LOCK") {
      assert.equal(inLock, false, "a second lock started inside another call's lock")
      inLock = true
    } else if (action === "UNLOCK") inLock = false
    else if (inLock) assert.ok(["POST /sap/bc/adt/cts/transportchecks", `PUT ${fx.CLASS_SOURCE_URL}`].includes(`${c.method} ${c.url}`), `${c.method} ${c.url} ran inside a lock`)
  }
  await client.close()
})

test("a save whose activation fails reports that the source is saved", async () => {
  const { fake, source } = sapWithEnqueue()
  fake.on("POST", "/sap/bc/adt/activation", EU510("DEVELOPER"))
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  const r = await writeSource(system, obj, "CLASS zcl_demo DEFINITION.\nENDCLASS.", { activate: true })
  assert.equal(source(), "CLASS zcl_demo DEFINITION.\nENDCLASS.")
  assert.match(r.text, /^Saved CLAS\/OC ZCL_DEMO \(inactive version\) in transport NPLK900010\./)
  assert.match(r.text, /Activation could not be run: ADT error: HTTP 403 .*currently editing/)
  assert.match(r.text, /Hint: the object is locked by an editor session/)
  assert.match(r.text, /The source IS saved as inactive version; do not repeat the save/)
  assert.doesNotMatch(r.text, /SAPscript|LONGTEXT/)
})

test("a rejected CSRF token is renewed and the save repeated once", async () => {
  const { fake, source } = sapWithEnqueue()
  let rejected = false
  fake.intercept = c => {
    if (c.qs._action === "LOCK" && !rejected) {
      rejected = true
      return { status: 403, statusText: "Forbidden", headers: { "x-csrf-token": "Required" }, body: "CSRF token validation failed" }
    }
    return undefined
  }
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  const before = fake.find("GET", "/sap/bc/adt/compatibility/graph").length
  const r = await writeSource(system, obj, "NEW", { checkSyntax: false })
  assert.match(r.text, /^Saved/)
  assert.equal(source(), "NEW")
  assert.equal(fake.calls.filter(c => c.qs._action === "LOCK").length, 2)
  const refresh = fake.find("GET", "/sap/bc/adt/compatibility/graph").slice(before)
  assert.ok(refresh.some(c => c.headers["x-csrf-token"] === "fetch"), "a new token was fetched")
})

test("abap_activate takes the object directly and activates several objects in one request", async () => {
  const { fake } = sapWithEnqueue()
  fake
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", c => (`${c.qs.query}`.startsWith("ZDEMO_REPORT") ? fx.searchAmbiguous.replace(/ZDEMO"/g, 'ZDEMO_REPORT"') : fx.searchClass))
    .on("GET", fx.PROG_URL, fx.programStructure)
  const client = await connect(fake)
  const one = await client.callTool({ name: "abap_activate", arguments: { name: "ZCL_DEMO" } })
  assert.match(text(one), /Activation of CLAS\/OC ZCL_DEMO: SUCCESS/)
  const before = fake.find("POST", "/sap/bc/adt/activation").length
  const both = await client.callTool({ name: "abap_activate", arguments: { objects: [{ name: "ZCL_DEMO" }, { name: "ZDEMO_REPORT", type: "PROG/P" }] } })
  assert.match(text(both), /Activation of CLAS\/OC ZCL_DEMO, PROG\/P ZDEMO_REPORT: SUCCESS/)
  const calls = fake.find("POST", "/sap/bc/adt/activation").slice(before)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body ?? "", /zcl_demo[\s\S]*zdemo_report/)
  const none = await client.callTool({ name: "abap_activate", arguments: {} })
  assert.equal(none.isError, true)
  await client.close()
})

test("edits given as a JSON string are accepted", async () => {
  const { fake, source } = sapWithEnqueue()
  const client = await connect(fake)
  const r = await client.callTool({ name: "abap_edit_source", arguments: { name: "ZCL_DEMO", edits: JSON.stringify([{ oldText: "'hello'", newText: "'json'" }]), checkSyntax: false } })
  assert.equal(r.isError, undefined, text(r))
  assert.match(source(), /'json'/)
  const bad = await client.callTool({ name: "abap_edit_source", arguments: { name: "ZCL_DEMO", edits: "not json" } })
  assert.equal(bad.isError, true)
  assert.match(text(bad), /edits must be an array/)
  await client.close()
})
