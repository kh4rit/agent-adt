import { test } from "node:test"
import assert from "node:assert/strict"
import { adtHint, errorMessage } from "../format.js"
import { resolveObject } from "../objects.js"
import { formatInactive } from "../services/activation.js"
import { noProxyForLoopback } from "../sso.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

test("not found with a type names the types the object exists under", async () => {
  const incl = "/sap/bc/adt/functions/groups/zdemo_fg/includes/lzdemo_fgtop"
  const fake = new FakeHttp().on("GET", "/sap/bc/adt/repository/informationsystem/search", c =>
    c.qs.objectType
      ? fx.searchEmpty
      : `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="${incl}" adtcore:type="FUGR/I" adtcore:name="LZDEMO_FGTOP"/></adtcore:objectReferences>`
  )
  await assert.rejects(
    resolveObject(makeSystem(fake), { name: "LZDEMO_FGTOP", type: "CLAS" }),
    /No object named LZDEMO_FGTOP of type CLAS found in TST, but it exists as:\n {2}- FUGR\/I LZDEMO_FGTOP .*lzdemo_fgtop\nPass that type or the uri\./
  )
})

test("hints for lock, transport split and function module signature messages", () => {
  assert.match(adtHint("User X is currently editing Y", {}) ?? "", /earlier save may already have gone through/)
  assert.match(adtHint("Object components locked in different requests", { "T100KEY-ID": "TK", "T100KEY-NO": "572", "T100KEY-V2": "NPLK900010 (DEVELOPER)", "T100KEY-V3": "NPLK900020 (OTHER)" }) ?? "", /different transport requests \(NPLK900010 \(DEVELOPER\); NPLK900020 \(OTHER\)\).*abap_read_transport/)
  assert.match(adtHint("Parameter IT_LOG declares no type", { "T100KEY-ID": "FUNC_ADT", "T100KEY-NO": "015" }) ?? "", /LIKE <table> or TYPE <table type>/)
  assert.equal(adtHint("Syntax error", {}), undefined)
  const proxy = errorMessage(Object.assign(new Error("tunneling socket could not be established, ERR_PROXY_TUNNEL"), {}))
  assert.match(proxy, /noProxy: true/)
})

test("the inactive object list says that SAPUI5 repository entries are not covered", () => {
  assert.match(formatInactive([], makeSystem(new FakeHttp())), /No inactive objects in TST\.\nNot covered by this list: inactive SAPUI5 \/ BSP repository entries.*dwinactiv/)
})

test("the browser connection on loopback never goes through the proxy", () => {
  const env: NodeJS.ProcessEnv = { NO_PROXY: "sap.example.com" }
  noProxyForLoopback(env)
  assert.equal(env.NO_PROXY, "sap.example.com,127.0.0.1,localhost")
  assert.equal(env.no_proxy, "127.0.0.1,localhost")
  noProxyForLoopback(env)
  assert.equal(env.NO_PROXY, "sap.example.com,127.0.0.1,localhost")
})
