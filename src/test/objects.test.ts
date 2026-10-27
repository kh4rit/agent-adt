import { test } from "node:test"
import assert from "node:assert/strict"
import { AmbiguousObjectError, ObjectNotFoundError, distinctObjects, normalizeType, packageOf, resolveObject, splitUri, typeMatcher } from "../objects.js"
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

const ref = (uri: string, type: string, name: string, pkg = "ZDEMO") =>
  `<adtcore:objectReference adtcore:uri="${uri}" adtcore:type="${type}" adtcore:name="${name}" adtcore:packageName="${pkg}"/>`
const refs = (...r: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${r.join("")}</adtcore:objectReferences>`
const SEARCH = "/sap/bc/adt/repository/informationsystem/search"

test("typeMatcher: bare types match all subtypes, includes are interchangeable, aliases are exact", () => {
  assert.equal(typeMatcher("TABL")("TABL/DS"), true)
  assert.equal(typeMatcher("tabl")("TABL/DT"), true)
  assert.equal(typeMatcher("TABL/DT")("TABL/DS"), false)
  assert.equal(typeMatcher("STRUCTURE")("TABL/DS"), true)
  assert.equal(typeMatcher("PROG/I")("FUGR/I"), true)
  assert.equal(typeMatcher("FUGR/I")("PROG/I"), true)
  assert.equal(typeMatcher("INCLUDE")("FUGR/I"), true)
  assert.equal(typeMatcher("PROG/P")("PROG/I"), false)
  assert.equal(typeMatcher("FUNC")("FUGR/FF"), true)
  assert.equal(typeMatcher("FUNC")("FUGR/F"), false)
  assert.equal(typeMatcher(undefined)("ANY/X"), true)
})

test("distinctObjects drops the STOB entry of a CDS view but keeps a different object of the same name", () => {
  const ddls = "/sap/bc/adt/ddic/ddl/sources/zi_demo"
  const hits = [
    { "adtcore:uri": ddls, "adtcore:type": "DDLS/DF", "adtcore:name": "ZI_DEMO" },
    { "adtcore:uri": `${ddls}/source/main#name=zi_demo`, "adtcore:type": "STOB/DO", "adtcore:name": "ZI_DEMO" },
    { "adtcore:uri": "/sap/bc/adt/acm/dcl/sources/zi_demo", "adtcore:type": "DCLS/DL", "adtcore:name": "ZI_DEMO" }
  ] as any[]
  assert.deepEqual(
    distinctObjects(hits).map(h => h["adtcore:type"]),
    ["DDLS/DF", "DCLS/DL"]
  )
  // the STOB hit may come first
  assert.deepEqual(
    distinctObjects([hits[1], hits[0]]).map(h => h["adtcore:type"]),
    ["DDLS/DF"]
  )
})

test("a CDS view resolves by name although the search also returns its STOB entry", async () => {
  const ddls = "/sap/bc/adt/ddic/ddl/sources/zi_demo"
  const fake = new FakeHttp()
    .on("GET", SEARCH, refs(ref(ddls, "DDLS/DF", "ZI_DEMO"), ref(`${ddls}/source/main#name=zi_demo`, "STOB/DO", "ZI_DEMO")))
    .on("GET", ddls, fx.ddlsStructure)
  const obj = await resolveObject(makeSystem(fake), { name: "zi_demo" })
  assert.equal(obj.type, "DDLS/DF")
  assert.equal(obj.objectUrl, ddls)
})

test("type TABL finds a structure; PROG/I finds a function group include", async () => {
  const struct = "/sap/bc/adt/ddic/structures/zs_demo"
  const incl = "/sap/bc/adt/functions/groups/zdemo_fg/includes/lzdemo_fgtop"
  const fake = new FakeHttp()
    .on("GET", SEARCH, c => {
      if (`${c.qs.query}`.startsWith("ZS_DEMO")) return refs(ref(struct, "TABL/DS", "ZS_DEMO"))
      // a typed PROG search does not return function group includes
      if (`${c.qs.query}`.startsWith("LZDEMO_FGTOP") && !c.qs.objectType) return refs(ref(incl, "FUGR/I", "LZDEMO_FGTOP"))
      return fx.searchEmpty
    })
    .on("GET", struct, fx.structureStructure)
    .on("GET", incl, fx.includeStructure.replace('adtcore:type="PROG/I"', 'adtcore:type="FUGR/I"'))
  const system = makeSystem(fake)
  assert.equal((await resolveObject(system, { name: "ZS_DEMO", type: "TABL" })).objectUrl, struct)
  await assert.rejects(resolveObject(system, { name: "ZS_DEMO", type: "TABL/DT" }), ObjectNotFoundError)
  const include = await resolveObject(system, { name: "LZDEMO_FGTOP", type: "PROG/I" })
  assert.equal(include.objectUrl, incl)
  assert.equal(include.type, "FUGR/I")
})

test("name lookups stop at the first server error or timeout instead of running every fallback query", async () => {
  const failing = new FakeHttp()
  failing.intercept = c => (c.url === SEARCH ? { status: 500, statusText: "Internal Server Error", body: "", headers: {} } : undefined)
  await assert.rejects(resolveObject(makeSystem(failing), { name: "ZCL_DEMO", type: "CLAS" }))
  assert.equal(failing.find("GET", SEARCH).length, 1)

  const timeout = new FakeHttp()
  timeout.intercept = c => {
    if (c.url === SEARCH) throw new Error("timeout of 120000ms exceeded")
    return undefined
  }
  await assert.rejects(resolveObject(makeSystem(timeout), { name: "ZCL_DEMO" }), /timeout of 120000ms exceeded/)
  assert.equal(timeout.find("GET", SEARCH).length, 1)

  // an unsupported type filter (4xx) still falls back to the untyped search
  const typed = classFake()
  typed.intercept = c => (c.url === SEARCH && c.qs.objectType === "XYZW" ? { status: 400, statusText: "Bad Request", body: "", headers: {} } : undefined)
  await assert.rejects(resolveObject(makeSystem(typed), { name: "ZCL_DEMO", type: "XYZW" }), ObjectNotFoundError)
  assert.equal(typed.find("GET", SEARCH).length, 3)
})
