import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveObject } from "../objects.js"
import { applyEdits, EditError, readSource, syntaxCheck, writeSource } from "../services/source.js"
import { TransportRequiredError } from "../services/transports.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

const baseFake = () =>
  new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("GET", fx.CLASS_SOURCE_URL, fx.classSource)
    .on("GET", fx.CLASS_TEST_URL, "*test include*")
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("PUT", fx.CLASS_SOURCE_URL, "")
    .on("POST", "/sap/bc/adt/checkruns", fx.syntaxClean)
    .on("POST", fx.CLASS_URL, c => (c.qs._action === "LOCK" ? fx.lockResult("NPLK900010") : ""))

test("readSource picks the inactive version of inactive objects and slices lines", async () => {
  const fake = baseFake()
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  const r = await readSource(system, obj, { startLine: 2, endLine: 3, lineNumbers: true })
  assert.equal(r.version, "inactive")
  assert.equal(fake.find("GET", fx.CLASS_SOURCE_URL)[0].qs.version, "inactive")
  assert.match(r.text, /lines 2-3 of 11/)
  assert.match(r.text, /^ ?2\| {3}PUBLIC SECTION\./m)
  const tests = await resolveObject(system, { name: "ZCL_DEMO", include: "testclasses" })
  const t = await readSource(system, tests)
  assert.equal(t.version, "active")
  assert.equal(fake.find("GET", fx.CLASS_TEST_URL)[0].qs.version, undefined)
  assert.match(t.text, /\(testclasses\) \[active\]/)
})

test("applyEdits requires unique matches", () => {
  const src = "a\nb\nc\nb\n"
  assert.equal(applyEdits(src, [{ oldText: "a\nb", newText: "x" }]).result, "x\nc\nb\n")
  assert.throws(() => applyEdits(src, [{ oldText: "b", newText: "x" }]), /more than once/)
  assert.throws(() => applyEdits(src, [{ oldText: "zzz", newText: "x" }]), /not found/)
  assert.throws(() => applyEdits(src, [{ oldText: "", newText: "x" }]), EditError)
  assert.equal(applyEdits("a\r\nb", [{ oldText: "a\nb", newText: "c" }]).result, "c")
})

test("writeSource locks, saves in the locking transport, unlocks and checks syntax", async () => {
  const fake = baseFake()
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  fake.calls.length = 0
  const r = await writeSource(system, obj, "CLASS zcl_demo DEFINITION.\r\nENDCLASS.\n")
  assert.equal(r.transport, "NPLK900010")
  const seq = fake.calls.map(c => `${c.method} ${c.url}${c.qs._action ? `?${c.qs._action}` : ""}`)
  assert.deepEqual(seq, [
    `POST ${fx.CLASS_URL}?LOCK`,
    "POST /sap/bc/adt/cts/transportchecks",
    `PUT ${fx.CLASS_SOURCE_URL}`,
    `POST ${fx.CLASS_URL}?UNLOCK`,
    "GET /sap/bc/adt/compatibility/graph",
    "POST /sap/bc/adt/checkruns"
  ])
  const [lock, , put, unlock, drop] = fake.calls
  assert.equal(lock.headers["X-sap-adt-sessiontype"], "stateful")
  assert.equal(put.headers["X-sap-adt-sessiontype"], "stateful")
  assert.equal(put.qs.lockHandle, "H4NDLE")
  assert.equal(put.qs.corrNr, "NPLK900010")
  assert.equal(put.body, "CLASS zcl_demo DEFINITION.\nENDCLASS.\n")
  assert.equal(unlock.qs.lockHandle, "H4NDLE")
  assert.equal(drop.headers["X-sap-adt-sessiontype"], "stateless")
  assert.match(r.text, /Saved CLAS\/OC ZCL_DEMO \(inactive version\) in transport NPLK900010/)
  assert.match(r.text, /no errors or warnings/)
  assert.match(r.text, /abap_activate/)
})

test("writeSource refuses transportable objects without a transport and still unlocks", async () => {
  const fake = baseFake().on("POST", fx.CLASS_URL, c => (c.qs._action === "LOCK" ? fx.lockResult("") : ""))
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  fake.calls.length = 0
  await assert.rejects(writeSource(system, obj, "x"), (e: Error) => e instanceof TransportRequiredError && /NPLK900010 {2}Demo transport/.test(e.message) && /NPLK900020/.test(e.message))
  assert.equal(fake.find("PUT", fx.CLASS_SOURCE_URL).length, 0)
  assert.equal(fake.calls.filter(c => c.qs._action === "UNLOCK").length, 1)
  assert.equal(fake.find("GET", "/sap/bc/adt/compatibility/graph").length, 1)
})

test("writeSource uses the requested transport and skips the transport check for local objects", async () => {
  const fake = baseFake().on("POST", fx.CLASS_URL, c => (c.qs._action === "LOCK" ? fx.lockResult("") : ""))
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  await writeSource(system, obj, "x", { transport: "nplk900020", checkSyntax: false })
  assert.equal(fake.find("PUT", fx.CLASS_SOURCE_URL)[0].qs.corrNr, "NPLK900020")
  assert.equal(fake.find("POST", "/sap/bc/adt/checkruns").length, 0)

  const local = baseFake().on("POST", fx.CLASS_URL, c => (c.qs._action === "LOCK" ? fx.lockResult("", "X") : ""))
  const localSystem = makeSystem(local)
  const localObj = await resolveObject(localSystem, { name: "ZCL_DEMO" })
  const r = await writeSource(localSystem, localObj, "x", { transport: "NPLK900020" })
  assert.equal(r.transport, "")
  assert.equal(local.find("POST", "/sap/bc/adt/cts/transportchecks").length, 0)
  assert.equal(local.find("PUT", fx.CLASS_SOURCE_URL)[0].qs.corrNr, undefined)
})

test("writeSource with activate reports activation errors; read-only systems refuse writes", async () => {
  const fake = baseFake().on("POST", "/sap/bc/adt/activation", fx.activationErrors).on("POST", "/sap/bc/adt/checkruns", fx.syntaxErrors)
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  const r = await writeSource(system, obj, "x", { activate: true })
  assert.equal(r.activation?.success, false)
  assert.match(r.text, /Syntax check: 1 error/)
  assert.match(r.text, /\[E\] line 8, col 4: Field "LV_UNKNOWN" is unknown\./)
  assert.match(r.text, /Activation of CLAS\/OC ZCL_DEMO: FAILED/)
  assert.match(r.text, /\[error\] Class ZCL_DEMO, Method RUN \(line 8, col 4\): Field "LV_UNKNOWN" is unknown/)
  assert.match(r.text, /\[warning\] Class ZCL_DEMO, Local test class LTC_DEMO \(testclasses line 3\)/)
  const activation = fake.find("POST", "/sap/bc/adt/activation")[0]
  assert.match(activation.body ?? "", new RegExp(`adtcore:uri="${fx.CLASS_URL}" adtcore:name="ZCL_DEMO"`))

  const ro = makeSystem(baseFake(), { readOnly: true })
  const roObj = await resolveObject(ro, { name: "ZCL_DEMO" })
  await assert.rejects(writeSource(ro, roObj, "x"), /read-only/)
})

test("syntaxCheck sends the include and main urls", async () => {
  const fake = baseFake().on("POST", "/sap/bc/adt/checkruns", fx.syntaxErrors)
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO", include: "testclasses" })
  const messages = await syntaxCheck(system, obj, "source")
  assert.equal(messages.length, 1)
  assert.equal(messages[0].line, 8)
  const body = fake.find("POST", "/sap/bc/adt/checkruns")[0].body ?? ""
  assert.match(body, new RegExp(`checkObject adtcore:uri="${fx.CLASS_TEST_URL}"`))
  assert.match(body, new RegExp(`chkrun:uri="${fx.CLASS_TEST_URL}"`))
})
