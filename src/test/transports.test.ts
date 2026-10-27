import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveObject } from "../objects.js"
import { describeTransportInfo, listTransports } from "../services/transports.js"
import { createObject } from "../services/create.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

const SEARCH = "/sap/bc/adt/repository/informationsystem/search"
const CHECKS = "/sap/bc/adt/cts/transportchecks"

const classSystem = (checks: string) =>
  makeSystem(
    new FakeHttp()
      .on("GET", SEARCH, fx.searchClass)
      .on("GET", fx.CLASS_URL, fx.classStructure)
      .on("POST", CHECKS, checks)
  )

test("transport info names the owner of the locking request and whether the user has a task in it", async () => {
  const other = classSystem(fx.transportChecks("HOME", [], fx.objectLock("NPLK900040", "Fix of another developer", "OTHER", "NPLK900041", "OTHER")))
  const text = await describeTransportInfo(other, await resolveObject(other, { name: "ZCL_DEMO" }))
  assert.match(text, /Currently locked in transport NPLK900040 \(Fix of another developer, owner OTHER\), tasks: NPLK900041 \(OTHER\)/)
  assert.match(text, /Changes must go to NPLK900040: pass it as the transport parameter\. Saving records them in DEVELOPER's task/)
  assert.doesNotMatch(text, /Your modifiable/)

  const mine = classSystem(fx.transportChecks("HOME", [], fx.objectLock("NPLK900040", "Shared fix", "OTHER", "NPLK900042", "DEVELOPER")))
  assert.match(await describeTransportInfo(mine, await resolveObject(mine, { name: "ZCL_DEMO" })), /recorded in your task NPLK900042/)
})

test("transport info lists the proposed requests with their owners instead of calling them the user's", async () => {
  const system = classSystem(fx.transportChecks("HOME", [fx.request("NPLK900010", "Demo transport"), fx.request("NPLK900050", "Colleague's request", "OTHER")]))
  const text = await describeTransportInfo(system, await resolveObject(system, { name: "ZCL_DEMO" }))
  assert.match(text, /Modifiable transport requests SAP proposes for this package/)
  assert.match(text, /NPLK900010 {2}Demo transport {2}\(owner DEVELOPER, yours, status D\)/)
  assert.match(text, /NPLK900050 {2}Colleague's request {2}\(owner OTHER, status D\)/)

  const none = classSystem(fx.transportChecks("HOME", []))
  assert.match(await describeTransportInfo(none, await resolveObject(none, { name: "ZCL_DEMO" })), /SAP proposes no modifiable transport request .*abap_create_transport/)
})

test("listTransports rejects wildcard users", async () => {
  const fake = new FakeHttp()
  await assert.rejects(listTransports(makeSystem(fake), "*"), /does not support wildcards/)
  assert.equal(fake.calls.length, 0)
})

const packageFake = () =>
  new FakeHttp()
    .on("GET", "/sap/bc/adt/packages/zparent", fx.parentPackage)
    .on("POST", "/sap/bc/adt/packages/validation", fx.validationOk)
    .on("POST", CHECKS, fx.transportChecks())
    .on("POST", "/sap/bc/adt/packages", { status: 201, statusText: "Created", body: "" })

test("creates a package with the software component and transport layer of its super package", async () => {
  const fake = packageFake()
  const r = await createObject(makeSystem(fake), { type: "DEVC", name: "znew", description: "New <apps> & more", package: "zparent", transport: "NPLK900010" })
  assert.equal(r.uri, "/sap/bc/adt/packages/znew")
  assert.equal(r.transport, "NPLK900010")
  assert.match(r.text, /Created package ZNEW in super package ZPARENT \(development, software component HOME, transport layer ZNPL\), transport NPLK900010/)
  const validation = fake.find("POST", "/sap/bc/adt/packages/validation")[0]
  assert.equal(validation.qs.swcomp, "HOME")
  assert.equal(validation.qs.packagename, "ZPARENT")
  const [create] = fake.find("POST", "/sap/bc/adt/packages")
  assert.equal(create.qs.corrNr, "NPLK900010")
  assert.match(create.body!, /adtcore:name="ZNEW" adtcore:type="DEVC\/K"/)
  assert.match(create.body!, /<adtcore:packageRef adtcore:name="ZNEW"\/>/)
  assert.match(create.body!, /<pak:superPackage adtcore:name="ZPARENT"\/>/)
  assert.match(create.body!, /<pak:softwareComponent pak:name="HOME"\/>/)
  assert.match(create.body!, /<pak:transportLayer pak:name="ZNPL"\/>/)
  assert.match(create.body!, /adtcore:description="New &lt;apps&gt; &amp; more"/)
  assert.doesNotMatch(create.body!, /YMU_RAP/)
})

test("package creation: explicit settings skip the super package lookup; transport required; local packages", async () => {
  const explicit = packageFake()
  await createObject(makeSystem(explicit), { type: "DEVC/K", name: "ZNEW", description: "d", package: "ZPARENT", transport: "NPLK900010", softwareComponent: "home", transportLayer: "", packageType: "structure" })
  assert.equal(explicit.find("GET", "/sap/bc/adt/packages/zparent").length, 0)
  assert.match(explicit.find("POST", "/sap/bc/adt/packages")[0].body!, /pak:packageType="structure"/)

  const noTransport = packageFake()
  await assert.rejects(createObject(makeSystem(noTransport), { type: "DEVC", name: "ZNEW", description: "d", package: "ZPARENT" }), /transportable: pass the transport parameter[\s\S]*NPLK900010/)
  assert.equal(noTransport.find("POST", "/sap/bc/adt/packages").length, 0)

  const local = packageFake()
  const r = await createObject(makeSystem(local), { type: "DEVC", name: "$znew", description: "d", package: "$TMP" })
  assert.equal(r.transport, "")
  assert.equal(local.find("GET", /\/sap\/bc\/adt\/packages\//).length, 0)
  assert.equal(local.find("POST", CHECKS).length, 0)
  assert.match(local.find("POST", "/sap/bc/adt/packages")[0].body!, /<pak:softwareComponent pak:name="LOCAL"\/>/)

  await assert.rejects(createObject(makeSystem(packageFake(), { readOnly: true }), { type: "DEVC", name: "ZNEW", description: "d", package: "ZPARENT" }), /read-only/)
})
