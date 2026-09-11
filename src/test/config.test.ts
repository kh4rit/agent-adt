import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, expandEnvRefs, loadConfig, parseConfigFile, systemFromEnv } from "../config.js"

test("system from environment variables", () => {
  const s = systemFromEnv({ SAP_URL: "https://sap:44300/", SAP_USER: "dev", SAP_PASSWORD: "pw", SAP_CLIENT: "100", SAP_ALLOW_SELF_SIGNED: "true", SAP_READ_ONLY: "x" })
  assert.equal(s?.name, "default")
  assert.equal(s?.url, "https://sap:44300")
  assert.equal(s?.client, "100")
  assert.equal(s?.allowSelfSigned, true)
  assert.equal(s?.readOnly, true)
  assert.equal(systemFromEnv({}), undefined)
  assert.throws(() => systemFromEnv({ SAP_URL: "http://x" }), ConfigError)
})

test("config file with systems map and env references", () => {
  const text = JSON.stringify({
    defaultSystem: "QAS",
    systems: {
      DEV: { url: "http://dev:8000", username: "dev", password: "${env:DEV_PW}", client: "001" },
      QAS: { url: "http://qas:8000", username: "dev", password: "plain", readOnly: true }
    }
  })
  const cfg = parseConfigFile(text, { DEV_PW: "s3cret" })
  assert.equal(cfg.systems.length, 2)
  assert.equal(cfg.systems[0].password, "s3cret")
  assert.equal(cfg.systems[1].readOnly, true)
  assert.equal(cfg.defaultSystem, "QAS")
  assert.throws(() => parseConfigFile(text, {}), /DEV_PW/)
  assert.throws(() => parseConfigFile("{ nope", {}), ConfigError)
  assert.equal(expandEnvRefs("a-${env:X}-b", { X: "1" }), "a-1-b")
})

test("config file with systems array and single system shorthand", () => {
  const arr = parseConfigFile(JSON.stringify({ systems: [{ name: "A", url: "http://a", username: "u", password: "p" }] }), {})
  assert.equal(arr.systems[0].name, "A")
  const single = parseConfigFile(JSON.stringify({ url: "http://a", username: "u", password: "p" }), {})
  assert.equal(single.systems[0].name, "default")
  assert.throws(() => parseConfigFile(JSON.stringify({ systems: [{ name: "A", url: "http://a" }] }), {}), /username/)
})

test("loadConfig merges file and environment, validates default", () => {
  const dir = mkdtempSync(join(tmpdir(), "adt-cfg-"))
  const file = join(dir, "cfg.json")
  writeFileSync(file, JSON.stringify({ systems: { DEV: { url: "http://dev", username: "u", password: "p" } } }))
  const cfg = loadConfig(["--config", file], { SAP_URL: "http://env", SAP_USER: "e", SAP_PASSWORD: "p", SAP_SYSTEM_NAME: "ENV" })
  assert.deepEqual(
    cfg.systems.map(s => s.name),
    ["DEV", "ENV"]
  )
  assert.equal(cfg.defaultSystem, "DEV")
  const overridden = loadConfig([], { ABAP_ADT_CONFIG: file, SAP_URL: "http://env", SAP_USER: "e", SAP_PASSWORD: "p", SAP_SYSTEM_NAME: "dev" })
  assert.equal(overridden.systems.length, 1)
  assert.equal(overridden.systems[0].url, "http://env")
  assert.throws(() => loadConfig([], {}), /No SAP system configured/)
  assert.throws(() => loadConfig(["--config", file], { SAP_DEFAULT_SYSTEM: "NOPE" }), /Default system NOPE/)
  assert.throws(() => loadConfig(["--config", join(dir, "missing.json")], {}), /Cannot read/)
})
