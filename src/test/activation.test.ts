import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveObject } from "../objects.js"
import { activateObject, formatActivation, formatInactive, inactiveObjects } from "../services/activation.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

const fakeFor = (activation: string | ((n: number) => string)) => {
  let n = 0
  return new FakeHttp()
    .on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass)
    .on("GET", fx.CLASS_URL, fx.classStructure)
    .on("POST", "/sap/bc/adt/activation", () => (typeof activation === "string" ? activation : activation(n++)))
    .on("GET", "/sap/bc/adt/activation/inactiveobjects", fx.activationInactiveList)
}

test("activation failure is summarised with line, include and severity", async () => {
  const fake = fakeFor(fx.activationErrors)
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO", include: "testclasses" })
  const s = await activateObject(system, obj)
  assert.equal(s.success, false)
  assert.equal(s.messages.length, 2)
  assert.deepEqual(
    s.messages.map(m => [m.severity, m.line, m.include]),
    [
      ["error", 8, "main"],
      ["warning", 3, "testclasses"]
    ]
  )
  assert.equal(fake.find("POST", "/sap/bc/adt/activation").length, 1)
  const text = formatActivation("CLAS/OC ZCL_DEMO", s)
  assert.match(text, /1 error:/)
  assert.match(text, /1 other message:/)
  assert.match(text, new RegExp(`${fx.CLASS_SOURCE_URL}#start=8,4`))
})

test("activation retries with the objects SAP reports as inactive", async () => {
  const fake = fakeFor(n => (n === 0 ? fx.activationInactiveList : ""))
  const system = makeSystem(fake)
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  const s = await activateObject(system, obj)
  assert.equal(s.success, true)
  const posts = fake.find("POST", "/sap/bc/adt/activation")
  assert.equal(posts.length, 2)
  assert.match(posts[0].body ?? "", /adtcore:name="ZCL_DEMO"\/>/)
  assert.match(posts[1].body ?? "", new RegExp(`adtcore:type="CLAS/OC" adtcore:parentUri="${fx.CLASS_URL}"`))
  assert.match(formatActivation("CLAS/OC ZCL_DEMO", s), /SUCCESS/)
})

test("inactive objects are listed with their transport", async () => {
  const fake = fakeFor("")
  const system = makeSystem(fake)
  const records = await inactiveObjects(system)
  assert.equal(records.length, 1)
  const text = formatInactive(records, system)
  assert.match(text, /CLAS\/OC ZCL_DEMO {2}user DEVELOPER {2}transport NPLK900011/)
})
