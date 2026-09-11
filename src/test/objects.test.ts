import { test } from "node:test"
import assert from "node:assert/strict"
import { AmbiguousObjectError, ObjectNotFoundError, normalizeType, packageOf, resolveObject, splitUri } from "../objects.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

test("splitUri strips source suffixes and detects class includes", () => {
  assert.deepEqual(splitUri(fx.CLASS_SOURCE_URL), { objectUrl: fx.CLASS_URL, include: "main" })
  assert.deepEqual(splitUri(`${fx.CLASS_TEST_URL}#start=3,0`), { objectUrl: fx.CLASS_URL, include: "testclasses" })
  assert.deepEqual(splitUri(`${fx.PROG_URL}/source/main?version=active`), { objectUrl: fx.PROG_URL, include: undefined })
  assert.deepEqual(splitUri(fx.PROG_URL), { objectUrl: fx.PROG_URL, include: undefined })
  assert.throws(() => splitUri("https://example.com/foo"), ObjectNotFoundError)
})

test("normalizeType accepts aliases and full ids", () => {
  assert.deepEqual(normalizeType("clas"), { full: "CLAS/OC", short: "CLAS" })
  assert.deepEqual(normalizeType("PROG/I"), { full: "PROG/I", short: "PROG" })
  assert.deepEqual(normalizeType("func"), { full: "FUGR/FF", short: "FUGR" })
  assert.deepEqual(normalizeType("XYZW"), { full: undefined, short: "XYZW" })
  assert.deepEqual(normalizeType(undefined), {})
})

const classFake = () =>
  new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", c => (`${c.qs.query}`.startsWith("ZCL_DEMO") ? fx.searchClass : fx.searchEmpty))
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("POST", "/sap/bc/adt/repository/nodepath", fx.nodePath)

test("resolves a class by name with main and test includes", async () => {
  const fake = classFake()
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "zcl_demo" })
  assert.equal(obj.type, "CLAS/OC")
  assert.equal(obj.name, "ZCL_DEMO")
  assert.equal(obj.objectUrl, fx.CLASS_URL)
  assert.equal(obj.sourceUrl, fx.CLASS_SOURCE_URL)
  assert.equal(obj.lockUrl, fx.CLASS_URL)
  assert.equal(obj.include, "main")
  assert.equal(obj.version, "inactive")
  assert.equal(obj.package, "ZDEMO")
  assert.equal(obj.isClass, true)
  assert.equal(obj.hasSource, true)
  assert.deepEqual(
    obj.includes?.map(i => i.type),
    ["main", "testclasses"]
  )
  const tests = await resolveObject(system, { name: "ZCL_DEMO", type: "CLAS", include: "testclasses" })
  assert.equal(tests.sourceUrl, fx.CLASS_TEST_URL)
  assert.equal(tests.version, "active")
  assert.equal(tests.lockUrl, fx.CLASS_URL)
  await assert.rejects(resolveObject(system, { name: "ZCL_DEMO", include: "macros" }), /no macros include/)
  await assert.rejects(resolveObject(system, { name: "ZCL_DEMO", type: "PROG" }), ObjectNotFoundError)
  await assert.rejects(resolveObject(system, { name: "ZCL_NOPE" }), ObjectNotFoundError)
  await assert.rejects(resolveObject(system, {}), ObjectNotFoundError)
})

test("resolves by uri without searching and finds the package via node path", async () => {
  const fake = classFake()
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { uri: `${fx.CLASS_TEST_URL}#start=1,0` })
  assert.equal(obj.include, "testclasses")
  assert.equal(obj.sourceUrl, fx.CLASS_TEST_URL)
  assert.equal(fake.find("GET", "/sap/bc/adt/repository/informationsystem/search").length, 0)
  assert.equal(obj.package, undefined)
  assert.equal(await packageOf(system, obj), "ZDEMO")
  assert.equal(obj.package, "ZDEMO")
})

test("ambiguous names require a type", async () => {
  const fake = new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchAmbiguous)
    .on("GET", fx.PROG_URL, fx.programStructure)
  const system = makeSystem(fake)
  await assert.rejects(resolveObject(system, { name: "ZDEMO" }), AmbiguousObjectError)
  const prog = await resolveObject(system, { name: "ZDEMO", type: "PROG/P" })
  assert.equal(prog.type, "PROG/P")
  assert.equal(prog.sourceUrl, `${fx.PROG_URL}/source/main`)
  assert.equal(prog.isClass, false)
  assert.equal(prog.include, undefined)
})

test("includes get their main program for context", async () => {
  const fake = new FakeHttp().on("GET", fx.INCL_URL, fx.includeStructure).on("GET", `${fx.INCL_URL}/mainprograms`, fx.mainPrograms)
  const obj = await resolveObject(makeSystem(fake), { uri: fx.INCL_URL })
  assert.equal(obj.type, "PROG/I")
  assert.equal(obj.mainProgram, fx.PROG_URL)
})
