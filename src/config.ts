import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type AuthMode = "basic" | "sso" | "cookie" | "bearer"
export const AUTH_MODES: AuthMode[] = ["basic", "sso", "cookie", "bearer"]

/** Settings of the browser based single sign-on logon (auth = "sso"). */
export interface SsoConfig {
  /** Path of a Chromium based browser (Edge, Chrome). Auto-detected when omitted. */
  browser?: string
  /** Browser profile directory that keeps the identity provider session between logons. */
  profileDir?: string
  /** File the captured SAP cookies are cached in. */
  cacheFile?: string
  /** URL opened to trigger the logon; default: the ADT discovery document of the system. */
  loginUrl?: string
  /** Try a silent (headless) logon first, default true. */
  headless?: boolean
  /** Seconds to wait for an interactive logon, default 300. */
  timeout?: number
  /** Hours after which cached cookies are considered stale, default 8. */
  maxAgeHours?: number
}

/** Connection details for one SAP system. */
export interface SystemConfig {
  /** Short name used by the `system` tool parameter, e.g. "DEV". */
  name: string
  /** Base URL of the application server, e.g. https://sap-dev.example.com:44300 */
  url: string
  /** SAP user name. Also needed for sso/cookie/bearer logons (transport lists, display). */
  username: string
  /** How to log on: basic (user + password, default), sso (browser single sign-on), cookie (static cookie header), bearer (OAuth token). */
  auth?: AuthMode
  /** Password, required for auth = basic. */
  password?: string
  /** Cookie header value for auth = cookie, e.g. "MYSAPSSO2=...; SAP_SESSIONID_FD2_100=..." */
  cookie?: string
  /** OAuth bearer token for auth = bearer. */
  bearerToken?: string
  /** Browser single sign-on settings for auth = sso. */
  sso?: SsoConfig
  /** Bypass HTTP(S)_PROXY for this host by adding it to NO_PROXY. */
  noProxy?: boolean
  /** SAP client, e.g. "100". Optional: the server default is used when omitted. */
  client?: string
  /** Logon language, e.g. "EN". */
  language?: string
  /** Accept self-signed / untrusted TLS certificates. */
  allowSelfSigned?: boolean
  /** Path to a PEM file with additional trusted CA certificates. */
  caCert?: string
  /** HTTP timeout in milliseconds. */
  timeout?: number
  /** When true every tool that changes the system is disabled. */
  readOnly?: boolean
}

export interface Config {
  systems: SystemConfig[]
  /** Name of the system used when a tool call does not specify one. */
  defaultSystem?: string
}

export class ConfigError extends Error {}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Replaces `${env:NAME}` placeholders with environment variable values. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF, (_match, key: string) => {
    const v = env[key]
    if (v === undefined)
      throw new ConfigError(`Environment variable ${key} referenced in the config file is not set`)
    return v
  })
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "boolean") return v
  return /^(1|true|yes|x)$/i.test(String(v))
}

function optionalString(v: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  return expandEnvRefs(String(v), env)
}

function parseAuth(v: unknown, name: string): AuthMode {
  const mode = (v === undefined || v === "" ? "basic" : String(v)).toLowerCase()
  if (!AUTH_MODES.includes(mode as AuthMode))
    throw new ConfigError(`System ${name}: auth must be one of ${AUTH_MODES.join(", ")} (got "${v}")`)
  return mode as AuthMode
}

function optionalNumber(v: unknown, name: string, field: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ConfigError(`System ${name}: ${field} must be a number`)
  return n
}

function normalizeSso(raw: unknown, env: NodeJS.ProcessEnv, name: string): SsoConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  return {
    browser: optionalString(r.browser, env),
    profileDir: optionalString(r.profileDir, env),
    cacheFile: optionalString(r.cacheFile, env),
    loginUrl: optionalString(r.loginUrl, env),
    headless: parseBool(r.headless),
    timeout: optionalNumber(r.timeout, name, "sso.timeout"),
    maxAgeHours: optionalNumber(r.maxAgeHours, name, "sso.maxAgeHours")
  }
}

/** Checks that the credentials required by the auth mode are present. */
export function validateSystem(s: SystemConfig): SystemConfig {
  const mode = s.auth ?? "basic"
  if (mode === "basic" && !s.password)
    throw new ConfigError(`System ${s.name}: password is required for basic authentication (or set auth to sso)`)
  if (mode === "cookie" && !s.cookie) throw new ConfigError(`System ${s.name}: cookie is required for auth = cookie`)
  if (mode === "bearer" && !s.bearerToken) throw new ConfigError(`System ${s.name}: bearerToken is required for auth = bearer`)
  return s
}

function normalizeSystem(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): SystemConfig {
  const name = optionalString(raw.name, env)
  if (!name) throw new ConfigError("Every system in the config file needs a name")
  const url = optionalString(raw.url, env)
  const username = optionalString(raw.username ?? raw.user, env)
  if (!url) throw new ConfigError(`System ${name}: url is required`)
  if (!username) throw new ConfigError(`System ${name}: username is required`)
  const timeout = optionalNumber(raw.timeout, name, "timeout")
  return validateSystem({
    name,
    url: url.replace(/\/+$/, ""),
    username,
    auth: parseAuth(raw.auth, name),
    password: optionalString(raw.password, env),
    cookie: optionalString(raw.cookie, env),
    bearerToken: optionalString(raw.bearerToken, env),
    sso: normalizeSso(raw.sso, env, name),
    noProxy: parseBool(raw.noProxy),
    client: optionalString(raw.client, env),
    language: optionalString(raw.language, env),
    allowSelfSigned: parseBool(raw.allowSelfSigned),
    caCert: optionalString(raw.caCert, env),
    timeout,
    readOnly: parseBool(raw.readOnly)
  })
}

/** Builds a system from the SAP_* environment variables, if SAP_URL is set. */
export function systemFromEnv(env: NodeJS.ProcessEnv): SystemConfig | undefined {
  const url = env.SAP_URL
  if (!url) return undefined
  const name = env.SAP_SYSTEM_NAME || "default"
  const username = env.SAP_USER ?? env.SAP_USERNAME
  if (!username) throw new ConfigError("SAP_URL is set but SAP_USER is missing")
  const sso: SsoConfig = {
    browser: env.SAP_SSO_BROWSER || undefined,
    profileDir: env.SAP_SSO_PROFILE_DIR || undefined,
    cacheFile: env.SAP_SSO_CACHE_FILE || undefined,
    loginUrl: env.SAP_SSO_LOGIN_URL || undefined,
    headless: parseBool(env.SAP_SSO_HEADLESS),
    timeout: optionalNumber(env.SAP_SSO_TIMEOUT, name, "SAP_SSO_TIMEOUT"),
    maxAgeHours: optionalNumber(env.SAP_SSO_MAX_AGE_HOURS, name, "SAP_SSO_MAX_AGE_HOURS")
  }
  return validateSystem({
    name,
    url: url.replace(/\/+$/, ""),
    username,
    auth: parseAuth(env.SAP_AUTH, name),
    password: env.SAP_PASSWORD || undefined,
    cookie: env.SAP_COOKIE || undefined,
    bearerToken: env.SAP_BEARER_TOKEN || undefined,
    sso: Object.values(sso).some(v => v !== undefined) ? sso : undefined,
    noProxy: parseBool(env.SAP_NO_PROXY),
    client: env.SAP_CLIENT || undefined,
    language: env.SAP_LANGUAGE || undefined,
    allowSelfSigned: parseBool(env.SAP_ALLOW_SELF_SIGNED),
    caCert: env.SAP_CA_CERT || undefined,
    timeout: optionalNumber(env.SAP_TIMEOUT, name, "SAP_TIMEOUT"),
    readOnly: parseBool(env.SAP_READ_ONLY)
  })
}

/**
 * Parses a JSON config file. `systems` may be an array of systems (each with a `name`)
 * or an object keyed by system name.
 */
export function parseConfigFile(text: string, env: NodeJS.ProcessEnv, fileName = "config"): Config {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(`Invalid JSON in ${fileName}: ${(e as Error).message}`)
  }
  if (!raw || typeof raw !== "object") throw new ConfigError(`${fileName} must contain a JSON object`)
  let entries: Record<string, unknown>[] = []
  if (Array.isArray(raw.systems)) entries = raw.systems
  else if (raw.systems && typeof raw.systems === "object")
    entries = Object.entries(raw.systems).map(([name, s]) => ({ name, ...(s as object) }))
  else if (raw.url) entries = [{ name: "default", ...raw }]
  const systems = entries.map(s => normalizeSystem(s, env))
  return { systems, defaultSystem: optionalString(raw.defaultSystem, env) }
}

export const CONFIG_HELP = `No SAP system configured.

Either set environment variables:
  SAP_URL=https://host:44300  SAP_USER=DEVELOPER  SAP_PASSWORD=secret
  or, for single sign-on through the browser: SAP_URL=... SAP_USER=DEVELOPER SAP_AUTH=sso
  (optional: SAP_CLIENT=100 SAP_LANGUAGE=EN SAP_ALLOW_SELF_SIGNED=true SAP_CA_CERT=/path/ca.pem SAP_NO_PROXY=true SAP_SYSTEM_NAME=DEV SAP_READ_ONLY=true)

or point ABAP_ADT_CONFIG (or --config <file>) to a JSON file such as:
  {
    "defaultSystem": "DEV",
    "systems": {
      "DEV": { "url": "https://sap-dev:44300", "client": "100", "username": "DEVELOPER", "auth": "sso" },
      "QAS": { "url": "https://sap-qas:44300", "client": "100", "username": "DEVELOPER", "password": "\${env:SAP_QAS_PASSWORD}", "readOnly": true }
    }
  }`

/** Loads the configuration from CLI arguments, ABAP_ADT_CONFIG and SAP_* variables. */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const systems: SystemConfig[] = []
  let defaultSystem: string | undefined
  const idx = argv.indexOf("--config")
  const file = idx >= 0 ? argv[idx + 1] : env.ABAP_ADT_CONFIG
  if (idx >= 0 && !file) throw new ConfigError("--config requires a file path")
  if (file) {
    const path = resolve(file)
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch (e) {
      throw new ConfigError(`Cannot read config file ${path}: ${(e as Error).message}`)
    }
    const parsed = parseConfigFile(text, env, path)
    systems.push(...parsed.systems)
    defaultSystem = parsed.defaultSystem
  }
  const fromEnv = systemFromEnv(env)
  if (fromEnv) {
    const existing = systems.findIndex(s => s.name.toLowerCase() === fromEnv.name.toLowerCase())
    if (existing >= 0) systems[existing] = fromEnv
    else systems.push(fromEnv)
  }
  if (!systems.length) throw new ConfigError(CONFIG_HELP)
  const names = new Set<string>()
  for (const s of systems) {
    const key = s.name.toLowerCase()
    if (names.has(key)) throw new ConfigError(`Duplicate system name ${s.name}`)
    names.add(key)
  }
  defaultSystem = env.SAP_DEFAULT_SYSTEM || defaultSystem || systems[0].name
  if (!names.has(defaultSystem.toLowerCase()))
    throw new ConfigError(`Default system ${defaultSystem} is not configured`)
  return { systems, defaultSystem }
}
