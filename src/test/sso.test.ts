import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CookieAuthHttpClient, isSamlChallenge, parseCookieHeader, SessionExpiredError, type CookieProvider, type HttpOptions, type HttpResponse } from "../cookieHttp.js"
import { cookiesForHost, hasSapSession, isStale, loadCache, parseDevToolsActivePort, saveCache, StaticCookieProvider, toCookieHeader, type CookieCache } from "../sso.js"
import { bypassProxy } from "../connection.js"
import { parseConfigFile, systemFromEnv } from "../config.js"
import { resolveObject } from "../objects.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

const SAML_PAGE = `<!DOCTYPE html><html><body onload="document.forms[0].submit()"><form method="post" action="https://login.microsoftonline.com/tenant/saml2"><input type="hidden" name="SAMLRequest" value="PHNhbWw..."/><input type="hidden" name="RelayState" value="x"/></form></body></html>`
const html = { "content-type": "text/html; charset=utf-8" }
const ok = (body = "<ok/>", headers: Record<string, any> = {}): HttpResponse => ({ status: 200, statusText: "OK", body, headers })

/** Delegate replaying scripted responses and recording what it received. */
class Delegate {
  received: HttpOptions[] = []
  constructor(private script: (HttpResponse | Error)[]) {}
  async request(options: HttpOptions): Promise<HttpResponse> {
    this.received.push(options)
    const next = this.script.shift()
    if (!next) throw new Error("no scripted response left")
    if (next instanceof Error) throw next
    return next
  }
}

class Provider implements CookieProvider {
  readonly description = "test cookies"
  refreshes: string[] = []
  constructor(
    private current = "MYSAPSSO2=t1; SAP_SESSIONID_DEV_100=s1",
    private next = "MYSAPSSO2=t2; SAP_SESSIONID_DEV_100=s2"
  ) {}
  async cookieHeader() {
    return this.current
  }
  async refresh(reason: string) {
    this.refreshes.push(reason)
    this.current = this.next
    return this.current
  }
}

const unauthorized = () => Object.assign(new Error("Request failed with status code 401"), { status: 401 })

test("isSamlChallenge recognises the identity provider redirect page only", () => {
  assert.equal(isSamlChallenge({ status: 200, headers: html, body: SAML_PAGE }), true)
  assert.equal(isSamlChallenge({ status: 200, headers: {}, body: SAML_PAGE }), true)
  assert.equal(isSamlChallenge({ status: 200, headers: html, body: "<html><body>ABAP documentation</body></html>" }), false)
  assert.equal(isSamlChallenge({ status: 200, headers: { "content-type": "application/xml" }, body: "<a>SAMLRequest</a>" }), false)
  assert.equal(isSamlChallenge({ status: 302, headers: html, body: SAML_PAGE }), false)
})

test("cookie client strips credentials, sends provider cookies and keeps cookies SAP issues", async () => {
  const delegate = new Delegate([ok("<a/>", { "set-cookie": ["SAP_SESSIONID_DEV_100=fresh; path=/", "sap-usercontext=sap-client=100; path=/"] }), ok("<b/>")])
  const client = new CookieAuthHttpClient(delegate, new Provider())
  const r1 = await client.request({ url: "/sap/bc/adt/compatibility/graph", auth: { username: "u", password: "" }, headers: { Authorization: "Basic xyz", Cookie: "stale=1", Accept: "*/*" } } as HttpOptions)
  assert.equal(r1.body, "<a/>")
  const sent = delegate.received[0]
  assert.equal(sent.auth, undefined)
  assert.equal(sent.headers?.Authorization, undefined)
  assert.equal(sent.headers?.Accept, "*/*")
  assert.equal(sent.headers?.Cookie, "MYSAPSSO2=t1; SAP_SESSIONID_DEV_100=s1")
  await client.request({ url: "/sap/bc/adt/x" } as HttpOptions)
  const jar = parseCookieHeader(delegate.received[1].headers?.Cookie)
  assert.equal(jar.get("SAP_SESSIONID_DEV_100"), "fresh")
  assert.equal(jar.get("MYSAPSSO2"), "t1")
  assert.equal(jar.get("sap-usercontext"), "sap-client=100")
})

test("SAML redirect page triggers exactly one re-logon and retry with the new cookies", async () => {
  const delegate = new Delegate([ok(SAML_PAGE, html), ok("<data/>")])
  const provider = new Provider()
  const messages: string[] = []
  const client = new CookieAuthHttpClient(delegate, provider, m => messages.push(m))
  const r = await client.request({ url: "/sap/bc/adt/repository/informationsystem/search" } as HttpOptions)
  assert.equal(r.body, "<data/>")
  assert.deepEqual(provider.refreshes, ["redirect to the identity provider"])
  assert.equal(delegate.received.length, 2)
  assert.equal(delegate.received[1].headers?.Cookie, "MYSAPSSO2=t2; SAP_SESSIONID_DEV_100=s2")
  assert.match(messages[0], /session expired/)
})

test("HTTP 401 triggers a re-logon; a second failure is surfaced", async () => {
  const delegate = new Delegate([unauthorized(), ok("<data/>")])
  const provider = new Provider()
  const client = new CookieAuthHttpClient(delegate, provider)
  assert.equal((await client.request({ url: "/x" } as HttpOptions)).body, "<data/>")
  assert.deepEqual(provider.refreshes, ["HTTP 401"])

  const twice = new CookieAuthHttpClient(new Delegate([unauthorized(), unauthorized()]), new Provider())
  await assert.rejects(twice.request({ url: "/x" } as HttpOptions), (e: any) => e.status === 401)
  const stillSaml = new CookieAuthHttpClient(new Delegate([ok(SAML_PAGE, html), ok(SAML_PAGE, html)]), new Provider())
  await assert.rejects(stillSaml.request({ url: "/x" } as HttpOptions), SessionExpiredError)
  const other = new CookieAuthHttpClient(new Delegate([Object.assign(new Error("boom"), { status: 500 })]), new Provider())
  await assert.rejects(other.request({ url: "/x" } as HttpOptions), /boom/)
})

test("static cookies cannot be refreshed and fail with guidance", async () => {
  const client = new CookieAuthHttpClient(new Delegate([ok(SAML_PAGE, html)]), new StaticCookieProvider("MYSAPSSO2=x"))
  await assert.rejects(client.request({ url: "/x" } as HttpOptions), /configured cookie .*expired/)
})

test("end to end: ADT client logs on through the cookie client and recovers from an expired session", async () => {
  const fake = new FakeHttp().on("GET", "/sap/bc/adt/repository/informationsystem/search", fx.searchClass).on("GET", fx.CLASS_URL, fx.classStructure)
  // SAP answers with the SAML page until the second generation of cookies arrives
  fake.intercept = call => (/SAP_SESSIONID_DEV_100=s1/.test(call.headers.Cookie ?? "") ? ok(SAML_PAGE, html) : undefined)
  const provider = new Provider()
  const system = makeSystem(new CookieAuthHttpClient(fake, provider), { auth: "sso", password: undefined })
  const obj = await resolveObject(system, { name: "ZCL_DEMO" })
  assert.equal(obj.name, "ZCL_DEMO")
  assert.deepEqual(provider.refreshes, ["redirect to the identity provider"])
  for (const call of fake.calls) {
    assert.equal(call.headers.Authorization, undefined)
    assert.equal((call as any).auth, undefined)
  }
  assert.ok(fake.calls.every(c => /MYSAPSSO2=/.test(c.headers.Cookie ?? "")))
  assert.equal(system.reader, system.client)
})

test("cookie cache helpers: host filter, staleness, persistence", () => {
  const now = Date.parse("2026-09-11T10:00:00Z")
  const cookies = [
    { name: "SAP_SESSIONID_DEV_100", value: "s", domain: "sap.example.com", path: "/", expires: -1 },
    { name: "MYSAPSSO2", value: "t", domain: ".example.com", path: "/", expires: now / 1000 + 3600 },
    { name: "ESTSAUTH", value: "e", domain: "login.microsoftonline.com", path: "/", expires: -1 }
  ]
  const sap = cookiesForHost(cookies, "SAP.example.com")
  assert.deepEqual(
    sap.map(c => c.name),
    ["SAP_SESSIONID_DEV_100", "MYSAPSSO2"]
  )
  assert.equal(hasSapSession(sap), true)
  assert.equal(hasSapSession(cookiesForHost(cookies, "other.host")), false)
  assert.equal(toCookieHeader(sap), "SAP_SESSIONID_DEV_100=s; MYSAPSSO2=t")
  const cache: CookieCache = { system: "DEV", host: "sap.example.com", capturedAt: now, cookies }
  assert.equal(isStale(cache, now + 60000, 8 * 3600000), false)
  assert.equal(isStale(cache, now + 9 * 3600000, 8 * 3600000), true, "older than max age")
  assert.equal(isStale(cache, now + 3601 * 1000, 8 * 3600000), true, "ticket expired")
  assert.equal(isStale({ ...cache, cookies: [cookies[2]] }, now, 8 * 3600000), true, "no SAP cookie")

  const dir = mkdtempSync(join(tmpdir(), "adt-sso-"))
  const file = join(dir, "nested", "dev.cookies.json")
  saveCache(file, cache)
  assert.deepEqual(loadCache(file), cache)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.match(readFileSync(file, "utf8"), /"capturedAt"/)
  assert.equal(loadCache(join(dir, "missing.json")), undefined)
  assert.deepEqual(parseDevToolsActivePort("54321\n/devtools/browser/abc-def\n"), { port: 54321, path: "/devtools/browser/abc-def" })
  assert.throws(() => parseDevToolsActivePort(""), /DevToolsActivePort/)
})

test("auth modes are validated in config file and environment", () => {
  const sso = parseConfigFile(JSON.stringify({ systems: { DEV: { url: "https://sap:443", username: "u", auth: "sso", sso: { headless: false, timeout: "120" } } } }), {})
  assert.equal(sso.systems[0].auth, "sso")
  assert.equal(sso.systems[0].password, undefined)
  assert.deepEqual(sso.systems[0].sso?.headless, false)
  assert.equal(sso.systems[0].sso?.timeout, 120)
  assert.throws(() => parseConfigFile(JSON.stringify({ systems: { A: { url: "https://sap", username: "u" } } }), {}), /password is required for basic/)
  assert.throws(() => parseConfigFile(JSON.stringify({ systems: { A: { url: "https://sap", username: "u", auth: "cookie" } } }), {}), /cookie is required/)
  assert.throws(() => parseConfigFile(JSON.stringify({ systems: { A: { url: "https://sap", username: "u", auth: "kerberos" } } }), {}), /auth must be one of/)
  const env = systemFromEnv({ SAP_URL: "https://sap", SAP_USER: "u", SAP_AUTH: "sso", SAP_SSO_BROWSER: "C:\\\\edge.exe", SAP_NO_PROXY: "true" })
  assert.equal(env?.auth, "sso")
  assert.equal(env?.sso?.browser, "C:\\\\edge.exe")
  assert.equal(env?.noProxy, true)
  const cookie = systemFromEnv({ SAP_URL: "https://sap", SAP_USER: "u", SAP_AUTH: "cookie", SAP_COOKIE: "MYSAPSSO2=x" })
  assert.equal(cookie?.cookie, "MYSAPSSO2=x")
  assert.throws(() => systemFromEnv({ SAP_URL: "https://sap", SAP_USER: "u", SAP_AUTH: "bearer" }), /bearerToken/)
})

test("bypassProxy adds the SAP host to NO_PROXY without duplicates", () => {
  const env: NodeJS.ProcessEnv = { NO_PROXY: "localhost, 127.0.0.1" }
  bypassProxy("https://sap-dev.example.com:44300/sap", env)
  bypassProxy("https://SAP-DEV.example.com/", env)
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,sap-dev.example.com")
  assert.equal(env.no_proxy, "sap-dev.example.com")
})
