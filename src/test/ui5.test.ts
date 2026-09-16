import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectFiles, createZip, readZip } from "../zip.js"
import { decideTransport, deployPayload, deployUi5App, loadArchive, parseSapMessages, REPOSITORY_SERVICE, ui5AppInfo } from "../services/ui5.js"
import { TransportRequiredError } from "../services/transports.js"
import { FakeHttp, makeSystem } from "./fake.js"
import * as fx from "./fixtures.js"

const APP = "ZDEMO_APP"
const APP_URL = `${REPOSITORY_SERVICE}/Repositories('${APP}')`
const NS_APP_URL = `${REPOSITORY_SERVICE}/Repositories('%2FDEMO%2FAPP')`
const json = { "content-type": "application/json; charset=utf-8", dataserviceversion: "2.0" }

const notFound = (token = "TOKEN2") => ({
  status: 404,
  statusText: "Not Found",
  headers: { ...json, "x-csrf-token": token },
  body: JSON.stringify({ error: { code: "/IWBEP/CM_MGW_RT/020", message: { lang: "en", value: "Resource not found for segment 'Repository'" } } })
})
const existing = (pkg = "ZDEMO") => ({
  status: 200,
  headers: { ...json, "x-csrf-token": "TOKEN2" },
  body: JSON.stringify({ d: { Name: APP, Package: pkg, Description: "Demo app", ZipArchive: "", Info: "" } })
})
const testModeAnswer = (details: { severity: string; message: string }[]) => ({
  status: 403,
  statusText: "Forbidden",
  headers: json,
  body: JSON.stringify({
    error: {
      code: "/UI5/ABAP_REPOSITORY_SRV/000",
      message: { lang: "en", value: "Test mode: the request was checked but not executed" },
      innererror: { errordetails: [{ code: "/UI5/ABAP_REPOSITORY_SRV/000", message: "Test mode: the request was checked but not executed", severity: "info" }, ...details.map(d => ({ code: "/UI5/UI5_REP/012", ...d }))] }
    }
  })
})

function appFolder(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ui5-app-"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ "sap.app": { id: "demo.app", type: "application" } }))
  writeFileSync(join(dir, "Component-preload.js"), "sap.ui.require.preload({});".repeat(50))
  mkdirSync(join(dir, "i18n"))
  writeFileSync(join(dir, "i18n", "i18n.properties"), "title=Demo")
  mkdirSync(join(dir, "test", "unit"), { recursive: true })
  writeFileSync(join(dir, "test", "unit", "AllTests.js"), "// tests")
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content)
  return dir
}

const baseFake = () =>
  new FakeHttp()
    .on("GET", APP_URL, notFound())
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("POST", `${REPOSITORY_SERVICE}/Repositories`, testModeAnswer([{ severity: "info", message: "File manifest.json will be created" }, { severity: "warning", message: "Application index will be updated" }]))

test("zip archives round-trip and honour exclude patterns", () => {
  const dir = appFolder()
  const all = collectFiles(dir)
  assert.deepEqual(all.map(e => e.path).sort(), ["Component-preload.js", "i18n/i18n.properties", "manifest.json", "test/unit/AllTests.js"])
  const filtered = collectFiles(dir, [/\/test\//])
  assert.deepEqual(filtered.map(e => e.path).sort(), ["Component-preload.js", "i18n/i18n.properties", "manifest.json"])
  const zip = createZip(all, new Date(2026, 8, 16, 12, 30, 0))
  const entries = readZip(zip)
  assert.deepEqual(entries.map(e => e.path), ["Component-preload.js", "i18n/i18n.properties", "manifest.json", "test/unit/AllTests.js"])
  const preload = entries.find(e => e.path === "Component-preload.js")!
  assert.ok(preload.compressedSize < preload.size, "repetitive content is deflated")
  assert.equal(preload.data().toString(), "sap.ui.require.preload({});".repeat(50))
  assert.equal(entries.find(e => e.path === "i18n/i18n.properties")!.data().toString(), "title=Demo")
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
})

test("loadArchive insists on a UI5 build result and reads the app id", () => {
  const dir = appFolder()
  const a = loadArchive(dir, ["/test/"])
  assert.equal(a.files, 3)
  assert.equal(a.appId, "demo.app")
  const zipPath = join(dir, "..", `ui5-app-${Date.now()}.zip`)
  writeFileSync(zipPath, a.zip)
  const b = loadArchive(zipPath)
  assert.equal(b.files, 3)
  assert.equal(b.appId, "demo.app")
  const project = mkdtempSync(join(tmpdir(), "ui5-project-"))
  mkdirSync(join(project, "webapp"))
  writeFileSync(join(project, "webapp", "manifest.json"), "{}")
  assert.throws(() => loadArchive(project), /No manifest.json at the root .*dist folder/)
  assert.throws(() => loadArchive(join(project, "missing")), /does not exist/)
  const variant = appFolder({ "manifest.appdescr_variant": "{}" })
  assert.throws(() => loadArchive(variant), /adaptation project/)
  assert.throws(() => loadArchive(dir, ["("]), /Invalid exclude pattern/)
})

test("parseSapMessages merges the sap-message header and the OData error body without duplicates", () => {
  const messages = parseSapMessages({
    status: 200,
    headers: { "sap-message": JSON.stringify({ code: "/UI5/UI5_REP/001", message: "Application uploaded", severity: "success", details: [{ code: "/UI5/UI5_REP/002", message: "3 files created", severity: "info" }] }) },
    body: ""
  })
  assert.deepEqual(messages, [
    { severity: "success", code: "/UI5/UI5_REP/001", text: "Application uploaded" },
    { severity: "info", code: "/UI5/UI5_REP/002", text: "3 files created" }
  ])
  const answer = testModeAnswer([{ severity: "error", message: "Package ZNOPE does not exist" }])
  assert.deepEqual(
    parseSapMessages(answer).map(m => `${m.severity}: ${m.text}`),
    ["info: Test mode: the request was checked but not executed", "error: Package ZNOPE does not exist"]
  )
  assert.deepEqual(
    parseSapMessages(answer, false).map(m => `${m.severity}: ${m.text}`),
    ["info: Test mode: the request was checked but not executed", "error: Package ZNOPE does not exist"]
  )
  const bare = { ...answer, body: JSON.stringify({ error: { code: "X", message: { value: "Only top level" } } }) }
  assert.equal(parseSapMessages(bare, false).length, 0)
  assert.deepEqual(parseSapMessages(bare).map(m => m.text), ["Only top level"])
  assert.deepEqual(parseSapMessages({ status: 500, body: '<?xml version="1.0"?><error><code>X</code><message xml:lang="en">Boom</message></error>' }), [{ severity: "error", code: undefined, text: "Boom" }])
})

test("test mode deployment of a new app: POST with TestMode, transport and the zipped payload, log returned, nothing changed", async () => {
  const fake = baseFake()
  const system = makeSystem(fake)
  const text = await deployUi5App(system, { name: "zdemo_app", source: appFolder(), package: "zdemo", transport: "NPLK900010", exclude: ["/test/"] })
  const seq = fake.calls.filter(c => c.url !== "/sap/bc/adt/compatibility/graph").map(c => `${c.method} ${c.url}`)
  assert.deepEqual(seq, [`GET ${APP_URL}`, "POST /sap/bc/adt/cts/transportchecks", `POST ${REPOSITORY_SERVICE}/Repositories`])
  const info = fake.find("GET", APP_URL)[0]
  assert.equal(info.headers["x-csrf-token"], "fetch")
  const check = fake.find("POST", "/sap/bc/adt/cts/transportchecks")[0]
  assert.match(check.body!, /<DEVCLASS>ZDEMO<\/DEVCLASS>/)
  assert.match(check.body!, /<URI>\/sap\/bc\/adt\/filestore\/ui5-bsp\/objects\/ZDEMO_APP\/\$create<\/URI>/)
  const post = fake.find("POST", `${REPOSITORY_SERVICE}/Repositories`)[0]
  assert.deepEqual(post.qs, { CodePage: "'UTF8'", CondenseMessagesInHttpResponseHeader: "X", format: "json", TransportRequest: "NPLK900010", TestMode: true })
  assert.equal(post.headers["x-csrf-token"], "TOKEN2")
  assert.equal(post.headers["Content-Type"], "application/atom+xml")
  assert.equal(post.headers.type, "entry")
  assert.match(post.body!, /<d:Name>ZDEMO_APP<\/d:Name><d:Package>ZDEMO<\/d:Package><d:Description>Deployed with abap-adt-mcp<\/d:Description><d:ZipArchive>[A-Za-z0-9+/=]+<\/d:ZipArchive>/)
  const zip = Buffer.from(post.body!.match(/<d:ZipArchive>([^<]+)</)![1], "base64")
  assert.deepEqual(readZip(zip).map(e => e.path), ["Component-preload.js", "i18n/i18n.properties", "manifest.json"])
  assert.match(text, /^Test mode deployment of BSP application ZDEMO_APP to TST \(new application\)/)
  assert.match(text, /package ZDEMO, transport NPLK900010; source .*: 3 files, .* zipped, sap.app\/id demo.app/)
  assert.match(text, /Nothing was changed on TST \(HTTP 403 is the expected answer in test mode\)\. SAP reported no errors\./)
  assert.match(text, /\[info\] \/UI5\/UI5_REP\/012 File manifest.json will be created\n {2}\[warning\] \/UI5\/UI5_REP\/012 Application index will be updated/)
  assert.match(text, /testMode=false/)
})

test("test mode reports SAP errors as a failing check, real mode surfaces them as an error", async () => {
  const fake = baseFake().on("POST", `${REPOSITORY_SERVICE}/Repositories`, testModeAnswer([{ severity: "error", message: "Transport request NPLK900010 does not belong to user DEVELOPER" }]))
  const text = await deployUi5App(makeSystem(fake), { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010" })
  assert.match(text, /SAP reported errors: a real deployment would fail/)
  assert.match(text, /\[error\] .*Transport request NPLK900010 does not belong to user DEVELOPER/)

  const failing = baseFake().on("POST", `${REPOSITORY_SERVICE}/Repositories`, {
    status: 400,
    statusText: "Bad Request",
    headers: json,
    body: JSON.stringify({ error: { code: "/UI5/UI5_REP/020", message: { value: "Object locked by user OTHER" }, innererror: { errordetails: [{ code: "/UI5/UI5_REP/020", message: "Object locked by user OTHER", severity: "error" }, { code: "/UI5/UI5_REP/021", message: "<![CDATA[technical]]>", severity: "info" }], Error_Resolution: { SAP_Note: "See note 12345" } } } })
  })
  await assert.rejects(deployUi5App(makeSystem(failing), { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010", testMode: false }), (e: Error) => {
    assert.match(e.message, /Deployment failed with HTTP 400 Bad Request\. Nothing was changed on TST:/)
    assert.match(e.message, /\[error\] \/UI5\/UI5_REP\/020 Object locked by user OTHER/)
    assert.match(e.message, /\[info\] SAP_Note: See note 12345/)
    assert.doesNotMatch(e.message, /CDATA/)
    return true
  })
})

test("transport rules: required for transportable packages, never invented, locks respected", async () => {
  const fake = baseFake()
  const system = makeSystem(fake)
  await assert.rejects(deployUi5App(system, { name: APP, source: appFolder(), package: "ZDEMO" }), (e: Error) => {
    assert.ok(e instanceof TransportRequiredError)
    assert.match(e.message, /needs a transport request\. Nothing was uploaded/)
    assert.match(e.message, /NPLK900010 {2}Demo transport/)
    return true
  })
  assert.equal(fake.find("POST", `${REPOSITORY_SERVICE}/Repositories`).length, 0)
  assert.deepEqual(await decideTransport(system, APP, "$TMP"), { transport: "", note: "local package $TMP, no transport request needed" })
  const local = new FakeHttp().on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks("LOCAL"))
  assert.equal((await decideTransport(makeSystem(local), APP, "ZLOCAL", "NPLK900010")).transport, "")
  const unknown = await decideTransport(system, APP, "ZDEMO", "nplk900099")
  assert.equal(unknown.transport, "NPLK900099")
  assert.match(unknown.note!, /not among your modifiable requests/)

  const lockXml = fx
    .transportChecks()
    .replace("<LOCKS/>", `<LOCKS><CTS_OBJECT_LOCK><OBJECT_KEY><PGMID>R3TR</PGMID><OBJECT>WAPA</OBJECT><NAME>ZDEMO_APP</NAME></OBJECT_KEY><LOCK_HOLDER><REQ_HEADER><TRKORR>NPLK900020</TRKORR><AS4USER>DEVELOPER</AS4USER><AS4TEXT>Other transport</AS4TEXT></REQ_HEADER><TASK_HEADERS><CTS_TASK_HEADER><TRKORR>NPLK900021</TRKORR><AS4USER>DEVELOPER</AS4USER></CTS_TASK_HEADER></TASK_HEADERS></LOCK_HOLDER></CTS_OBJECT_LOCK></LOCKS>`)
  const locked = makeSystem(new FakeHttp().on("POST", "/sap/bc/adt/cts/transportchecks", lockXml))
  assert.deepEqual(await decideTransport(locked, APP, "ZDEMO"), { transport: "NPLK900020", note: "the application is already recorded in NPLK900020, which is used" })
  assert.deepEqual(await decideTransport(locked, APP, "ZDEMO", "NPLK900021"), { transport: "NPLK900021", note: undefined })
  await assert.rejects(decideTransport(locked, APP, "ZDEMO", "NPLK900010"), /already recorded in transport NPLK900020 \(Other transport\); SAP cannot record it in NPLK900010.*Pass NPLK900020 or one of its tasks \(NPLK900021\)/)
})

test("real deployment of an existing app: PUT without TestMode, existing package kept, success with sap-message log", async () => {
  const fake = new FakeHttp()
    .on("GET", APP_URL, existing("ZOTHER"))
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("PUT", APP_URL, { status: 200, headers: { ...json, "sap-message": JSON.stringify({ code: "/UI5/UI5_REP/001", message: "Application ZDEMO_APP updated", severity: "success", details: [{ message: "3 files updated", severity: "info" }] }) }, body: "" })
  const system = makeSystem(fake, { url: "https://sap-dev.example.com:44300", client: "100" })
  const text = await deployUi5App(system, { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010", testMode: false, safeMode: false, description: "Bug fix INC1" })
  const put = fake.find("PUT", APP_URL)[0]
  assert.deepEqual(put.qs, { CodePage: "'UTF8'", CondenseMessagesInHttpResponseHeader: "X", format: "json", TransportRequest: "NPLK900010", SafeMode: false })
  assert.match(put.body!, /<d:Package>ZOTHER<\/d:Package><d:Description>Bug fix INC1<\/d:Description>/)
  assert.match(put.body!, /xml:base="https:\/\/sap-dev.example.com:44300\/sap\/opu\/odata\/UI5\/ABAP_REPOSITORY_SRV"/)
  assert.match(fake.find("POST", "/sap/bc/adt/cts/transportchecks")[0].body!, /<DEVCLASS>ZOTHER<\/DEVCLASS>/)
  assert.match(text, /^Deployment of BSP application ZDEMO_APP to TST \(update of the existing application\)/)
  assert.match(text, /note: the application already exists in package ZOTHER; SAP cannot move it to ZDEMO/)
  assert.match(text, /Deployed successfully \(HTTP 200\), recorded in transport NPLK900010\. App URL: https:\/\/sap-dev.example.com:44300\/sap\/bc\/ui5_ui5\/sap\/zdemo_app\?sap-client=100/)
  assert.match(text, /\[success\] \/UI5\/UI5_REP\/001 Application ZDEMO_APP updated\n {2}\[info\] 3 files updated/)
})

test("safe mode conflicts, read-only systems, inactive service and namespaced names", async () => {
  const conflict = new FakeHttp()
    .on("GET", APP_URL, existing())
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("PUT", APP_URL, { status: 412, statusText: "Precondition Failed", headers: json, body: JSON.stringify({ error: { code: "/UI5/UI5_REP/030", message: { value: "Application id differs" } } }) })
  await assert.rejects(deployUi5App(makeSystem(conflict), { name: APP, source: appFolder(), transport: "NPLK900010", testMode: false }), /HTTP 412.*different sap.app\/id.*safeMode=false[\s\S]*\[error\] \/UI5\/UI5_REP\/030 Application id differs/)

  const readOnly = makeSystem(baseFake(), { readOnly: true })
  await assert.rejects(deployUi5App(readOnly, { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010", testMode: false }), /read-only/)
  assert.match(await deployUi5App(readOnly, { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010" }), /Nothing was changed/)

  const inactive = new FakeHttp().on("GET", APP_URL, { status: 404, statusText: "Not Found", headers: { "content-type": "text/html" }, body: "<html><body>Service cannot be reached</body></html>" })
  await assert.rejects(deployUi5App(makeSystem(inactive), { name: APP, source: appFolder(), package: "ZDEMO" }), /Could not read BSP application ZDEMO_APP from TST: HTTP 404 Not Found\n {2}Service cannot be reached\nThe SAPUI5 ABAP repository OData service .* must be active in SICF/)

  const ns = new FakeHttp()
    .on("GET", NS_APP_URL, notFound())
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("POST", `${REPOSITORY_SERVICE}/Repositories`, testModeAnswer([]))
  const text = await deployUi5App(makeSystem(ns, { url: "https://sap-dev.example.com" }), { name: "/demo/app", source: appFolder(), package: "/DEMO/PKG", transport: "NPLK900010" })
  assert.match(ns.find("POST", "/sap/bc/adt/cts/transportchecks")[0].body!, /<URI>\/sap\/bc\/adt\/filestore\/ui5-bsp\/objects\/%2FDEMO%2FAPP\/\$create<\/URI>/)
  assert.match(ns.find("POST", `${REPOSITORY_SERVICE}/Repositories`)[0].body!, /<d:Name>\/DEMO\/APP<\/d:Name><d:Package>\/DEMO\/PKG<\/d:Package>/)
  assert.match(text, /BSP application \/DEMO\/APP to TST \(new application\)/)
  assert.match(text, /SAP check log:\n {2}\[info\] .*Test mode: the request was checked but not executed/)
})

test("CSRF token: fetched from the service root when the info call did not return one, refreshed once when rejected", async () => {
  const fake = new FakeHttp()
    .on("GET", APP_URL, notFound(""))
    .on("GET", `${REPOSITORY_SERVICE}/`, c => ({ status: 200, headers: { ...json, "x-csrf-token": c.headers["x-csrf-token"] === "fetch" ? "ROOT" : "" }, body: "{}" }))
    .on("POST", "/sap/bc/adt/cts/transportchecks", fx.transportChecks())
    .on("POST", `${REPOSITORY_SERVICE}/Repositories`, c => (c.headers["x-csrf-token"] === "ROOT" ? testModeAnswer([]) : { status: 403, statusText: "Forbidden", headers: { "x-csrf-token": "Required" }, body: "CSRF token validation failed" }))
  const text = await deployUi5App(makeSystem(fake), { name: APP, source: appFolder(), package: "ZDEMO", transport: "NPLK900010" })
  assert.match(text, /Nothing was changed/)
  const uploads = fake.find("POST", `${REPOSITORY_SERVICE}/Repositories`)
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].headers["x-csrf-token"], "ROOT")
})

test("ui5AppInfo lists the deployed files from the downloaded archive, or through the ADT filestore", async () => {
  const zip = createZip(collectFiles(appFolder(), [/\/test\//]))
  const fake = new FakeHttp().on("GET", APP_URL, c =>
    c.qs.DownloadFiles ? { status: 200, headers: json, body: JSON.stringify({ d: { Name: APP, Package: "ZDEMO", Description: "Demo app", ZipArchive: zip.toString("base64") } }) } : existing()
  )
  const text = await ui5AppInfo(makeSystem(fake, { client: "001" }), APP)
  assert.match(text, /^BSP application ZDEMO_APP in TST: package ZDEMO, "Demo app"\nApp URL: http:\/\/fake\/sap\/bc\/ui5_ui5\/sap\/zdemo_app\?sap-client=001\n3 files, .*, sap.app\/id demo.app:\n {2}Component-preload.js {2}.*\n {2}i18n\/i18n.properties {2}10 B\n {2}manifest.json/)

  const feed = (entries: string) => `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="/sap/bc/adt/filestore/ui5-bsp/objects/">${entries}</atom:feed>`
  const entry = (id: string, term: string) => `<atom:entry><atom:id>${id}</atom:id><atom:category term="${term}" scheme="http://www.sap.com/adt/categories/filestore"/><atom:title>${id}</atom:title></atom:entry>`
  const old = new FakeHttp()
    .on("GET", APP_URL, existing())
    .on("GET", `/sap/bc/adt/filestore/ui5-bsp/objects/${APP}/content`, feed(entry(`${APP}%2fmanifest.json`, "file") + entry(`${APP}%2fi18n`, "folder")))
    .on("GET", `/sap/bc/adt/filestore/ui5-bsp/objects/${APP}%2fi18n/content`, feed(entry(`${APP}%2fi18n%2fi18n.properties`, "file")))
  const listing = await ui5AppInfo(makeSystem(old), APP)
  assert.match(listing, /2 files \(listed through the ADT filestore.*\):\n {2}ZDEMO_APP\/i18n\/i18n.properties\n {2}ZDEMO_APP\/manifest.json/)
  assert.equal(await ui5AppInfo(makeSystem(new FakeHttp().on("GET", APP_URL, notFound())), APP), "BSP application ZDEMO_APP does not exist in TST.")
})
