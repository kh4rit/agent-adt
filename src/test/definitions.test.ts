import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callTool } from "../server.js"
import { AbapSystem } from "../connection.js"
import { findMethod } from "../services/source.js"
import { FakeHttp, testConfig, type Call } from "./fake.js"
import * as fx from "./fixtures.js"

const tool = (fake: FakeHttp, name: string, args: Record<string, unknown>) =>
  callTool({ systems: [testConfig], defaultSystem: "TST" }, name, args, c => new AbapSystem(c, fake))

/** Lock / unlock answers for an object url, recording the transport check. */
const lockable = (fake: FakeHttp, url: string, corrnr = "NPLK900010") =>
  fake
    .on("POST", url, (c: Call) => (c.qs._action === "LOCK" ? fx.lockResult(corrnr) : ""))
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())

test("data elements: the XML definition is written back without read-only parts and without a syntax check", async () => {
  let saved = ""
  const fake = lockable(new FakeHttp(), fx.DTEL_URL)
    .on("GET", fx.DTEL_URL, { body: fx.dataElementXml, headers: { "content-type": "application/vnd.sap.adt.dataelements.v2+xml; charset=utf-8" } })
    .on("PUT", fx.DTEL_URL, (c: Call) => {
      saved = c.body ?? ""
      return ""
    })
  const edit = await tool(fake, "abap_edit_source", { uri: fx.DTEL_URL, edits: [{ oldText: "<dtel:shortFieldLabel>Pallet No.</dtel:shortFieldLabel>", newText: "<dtel:shortFieldLabel>Pallet</dtel:shortFieldLabel>" }] })
  assert.equal(edit.isError, false, edit.text)
  assert.match(edit.text, /Saved DTEL\/DE ZDEMO_PALLET_NO \(inactive version\) in transport NPLK900010/)
  const [put] = fake.find("PUT", fx.DTEL_URL)
  assert.equal(put.headers["Content-Type"], "application/vnd.sap.adt.dataelements.v2+xml")
  assert.equal(put.qs.lockHandle, "H4NDLE")
  assert.equal(put.qs.corrNr, "NPLK900010")
  assert.match(saved, /<dtel:shortFieldLabel>Pallet<\/dtel:shortFieldLabel>/)
  assert.doesNotMatch(saved, /atom:link/)
  assert.equal(fake.find("POST", "/sap/bc/adt/checkruns").length, 0)

  const wrong = await tool(fake, "abap_write_source", { uri: fx.DTEL_URL, source: fx.dataElementXml.replace(/ZDEMO_PALLET_NO"/, 'ZOTHER"') })
  assert.equal(wrong.isError, true)
  assert.match(wrong.text, /describes ZOTHER, not ZDEMO_PALLET_NO; nothing was saved/)
})

test("writing the testclasses include of a class without one creates it first", async () => {
  let hasTests = false
  let testSource = ""
  const fake = lockable(new FakeHttp(), fx.CLASS_URL)
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, () => (hasTests ? fx.classStructure : fx.classStructureWithoutTests))
    .on("POST", /^\/sap\/bc\/adt\/oo\/classes\/zcl_demo\/includes$/i, () => {
      hasTests = true
      return ""
    })
    .on("PUT", fx.CLASS_TEST_URL, (c: Call) => {
      testSource = c.body ?? ""
      return ""
    })
    .on("POST", "/sap/bc/adt/checkruns", fx.syntaxClean)
  const read = await tool(fake, "abap_read_source", { name: "ZCL_DEMO", include: "testclasses" })
  assert.match(read.text, /has no testclasses include.*abap_write_source with include testclasses creates it/)
  const r = await tool(fake, "abap_write_source", { name: "ZCL_DEMO", include: "testclasses", source: "CLASS ltc_demo DEFINITION FOR TESTING. ENDCLASS." })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /^Created the test class include of ZCL_DEMO in transport NPLK900010\.\nSaved CLAS\/OC ZCL_DEMO \(testclasses\)/)
  assert.equal(testSource, "CLASS ltc_demo DEFINITION FOR TESTING. ENDCLASS.")
  const [create] = fake.find("POST", /\/includes$/)
  assert.equal(create.qs.lockHandle, "H4NDLE")
})

test("method reads, saveTo and sourceFile", async () => {
  assert.deepEqual(findMethod(fx.classSource, "RUN"), { start: 7, end: 9 })
  assert.equal(findMethod(fx.classSource, "nope"), undefined)
  let saved = ""
  const fake = lockable(new FakeHttp(), fx.CLASS_URL)
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("GET", fx.CLASS_SOURCE_URL, fx.classSource)
    .on("PUT", fx.CLASS_SOURCE_URL, (c: Call) => {
      saved = c.body ?? ""
      return ""
    })
  const method = await tool(fake, "abap_read_source", { name: "ZCL_DEMO", method: "run" })
  assert.equal(method.text, "CLAS/OC ZCL_DEMO [inactive] lines 7-9 of 11\n7|   METHOD run.\n8|     rv_result = 'hello'.\n9|   ENDMETHOD.")
  const missing = await tool(fake, "abap_read_source", { name: "ZCL_DEMO", method: "other" })
  assert.match(missing.text, /No METHOD other .*Implemented methods: run/)
  const part = await tool(fake, "abap_read_source", { name: "ZCL_DEMO", endLine: 3 })
  assert.match(part.text, /\n\.\.\. 8 more lines: continue with startLine=4$/)

  const dir = mkdtempSync(join(tmpdir(), "adt-src-"))
  const file = join(dir, "out", "zcl_demo.abap")
  const save = await tool(fake, "abap_read_source", { name: "ZCL_DEMO", saveTo: file })
  assert.match(save.text, /CLAS\/OC ZCL_DEMO \[inactive\] 11 lines saved to .*zcl_demo\.abap$/)
  assert.equal(readFileSync(file, "utf8"), fx.classSource)

  writeFileSync(file, "﻿CLASS zcl_demo DEFINITION.\nENDCLASS.")
  const write = await tool(fake, "abap_write_source", { name: "ZCL_DEMO", sourceFile: file, checkSyntax: false })
  assert.equal(write.isError, false, write.text)
  assert.equal(saved, "CLASS zcl_demo DEFINITION.\nENDCLASS.")
  const both = await tool(fake, "abap_write_source", { name: "ZCL_DEMO", source: "x", sourceFile: file })
  assert.match(both.text, /Pass either source or sourceFile/)
})

test("function module processing type: update module with task kind, read-only parts dropped", async () => {
  let body = ""
  const fake = lockable(new FakeHttp(), fx.FM_URL)
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="${fx.FM_URL}" adtcore:type="FUGR/FF" adtcore:name="Z_DEMO_POST"/></adtcore:objectReferences>`)
    .on("GET", fx.FM_URL, { body: fx.functionModuleXml, headers: { "content-type": "application/vnd.sap.adt.functions.fmodules.v3+xml; charset=utf-8" } })
    .on("PUT", fx.FM_URL, (c: Call) => {
      body = c.body ?? ""
      return ""
    })
  const r = await tool(fake, "abap_set_processing_type", { name: "Z_DEMO_POST", processingType: "update", updateTaskKind: "startDelayed" })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /Set the processing type of FUGR\/FF Z_DEMO_POST to update \(startDelayed\) in transport NPLK900010/)
  assert.match(body, /fmodule:processingType="update"/)
  assert.match(body, /fmodule:updateTaskKind="startDelayed"/)
  assert.doesNotMatch(body, /rfcScope|rfcVersion|atom:link/)
  assert.match(body, /<adtcore:containerRef /)
  assert.equal(fake.find("PUT", fx.FM_URL)[0].headers["Content-Type"], "application/vnd.sap.adt.functions.fmodules.v3+xml")
  const bad = await tool(fake, "abap_set_processing_type", { name: "Z_DEMO_POST", processingType: "rfc", updateTaskKind: "startDelayed" })
  assert.match(bad.text, /updateTaskKind only applies to processingType update/)
})

test("lock status: free objects are locked and released at once; held locks name the user", async () => {
  let held = false
  const fake = new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("POST", fx.CLASS_URL, (c: Call) =>
      c.qs._action === "LOCK" && held
        ? { status: 403, statusText: "Forbidden", body: fx.adtError("User OTHER is currently editing ZCL_DEMO") }
        : c.qs._action === "LOCK"
          ? fx.lockResult("NPLK900010")
          : ""
    )
  const free = await tool(fake, "abap_lock_status", { name: "ZCL_DEMO" })
  assert.match(free.text, /CLAS\/OC ZCL_DEMO is not locked: the tool locked it and released it again at once\. It is recorded in transport NPLK900010/)
  assert.equal(fake.calls.filter(c => c.qs._action === "UNLOCK").length, 1)
  held = true
  const locked = await tool(fake, "abap_lock_status", { name: "ZCL_DEMO" })
  assert.equal(locked.isError, false)
  assert.match(locked.text, /CLAS\/OC ZCL_DEMO is locked by OTHER\.\nAnother user is editing it/)
})
