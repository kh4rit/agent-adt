import https from "node:https"
import { readFileSync } from "node:fs"
import { ADTClient, session_types } from "abap-adt-api"
import type { AdtLock, ClientOptions, HttpClient } from "abap-adt-api"
import { AxiosHttpClient } from "abap-adt-api/build/AxiosHttpClient.js"
import type { Config, SystemConfig } from "./config.js"
import { CookieAuthHttpClient, type CookieProvider } from "./cookieHttp.js"
import { BrowserSsoProvider, StaticCookieProvider } from "./sso.js"

export class SystemError extends Error {}

const log = (system: string) => (message: string) => console.error(`[${system}] ${message}`)

/** Adds the host to NO_PROXY so corporate proxies are bypassed for internal SAP systems. */
export function bypassProxy(url: string, env: NodeJS.ProcessEnv = process.env) {
  const host = new URL(url).hostname
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = (env[key] ?? "").split(",").map(s => s.trim()).filter(Boolean)
    if (!current.some(h => h.toLowerCase() === host.toLowerCase())) env[key] = [...current, host].join(",")
  }
}

/**
 * One SAP system: owns an ADT client used for stateful operations (lock / write / unlock)
 * and a stateless clone used for everything else, mirroring what the VS Code extension does.
 */
export class AbapSystem {
  readonly client: ADTClient
  /** set for auth = sso: allows the CLI to trigger / inspect the browser logon */
  readonly sso?: BrowserSsoProvider
  private readonly singleSession: boolean
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly config: SystemConfig,
    httpClient?: HttpClient
  ) {
    const options: ClientOptions = { timeout: config.timeout ?? 120000 }
    if (!httpClient && /^https:/i.test(config.url)) {
      options.httpsAgent = new https.Agent({
        rejectUnauthorized: !config.allowSelfSigned,
        ca: config.caCert ? readFileSync(config.caCert) : undefined,
        keepAlive: true
      })
    }
    if (config.noProxy) bypassProxy(config.url)

    let http = httpClient
    let password: string | (() => Promise<string>) = config.password ?? ""
    if (!http) {
      let provider: CookieProvider | undefined
      if (this.auth === "sso") {
        const sso = config.sso ?? {}
        this.sso = new BrowserSsoProvider({
          system: config.name,
          baseUrl: config.url,
          client: config.client,
          language: config.language,
          browser: sso.browser,
          profileDir: sso.profileDir,
          cacheFile: sso.cacheFile,
          loginUrl: sso.loginUrl,
          headless: sso.headless,
          timeoutSeconds: sso.timeout,
          maxAgeHours: sso.maxAgeHours,
          log: log(config.name)
        })
        provider = this.sso
      } else if (this.auth === "cookie") provider = new StaticCookieProvider(config.cookie ?? "")
      if (provider) {
        http = new CookieAuthHttpClient(new AxiosHttpClient(config.url, options), provider, log(config.name))
        password = ""
      } else if (this.auth === "bearer") {
        const token = config.bearerToken ?? ""
        password = async () => token
      }
    }
    this.client = new ADTClient(http ?? config.url, config.username, password, config.client ?? "", config.language ?? "", options)
    // cookie based logons share one SAP session between reads and writes: the library cannot
    // clone a client that uses an injected HTTP layer
    this.singleSession = !!http
  }

  get name() {
    return this.config.name
  }

  get auth() {
    return this.config.auth ?? "basic"
  }

  get user() {
    return this.config.username.toUpperCase()
  }

  get readOnly() {
    return !!this.config.readOnly
  }

  /** Client for read-only calls; never carries a stateful session. */
  get reader(): ADTClient {
    return this.singleSession ? this.client : this.client.statelessClone
  }

  assertWritable(action: string) {
    if (this.readOnly)
      throw new SystemError(
        `System ${this.name} is configured read-only: ${action} is not allowed`
      )
  }

  async login() {
    if (!this.client.loggedin) await this.client.login()
  }

  /** Runs `fn` after all previously queued stateful operations completed. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Locks an object in a stateful session, runs `fn`, then unlocks and drops the session.
   * The lock handle and the (stateful) client to use for the write are passed to `fn`.
   */
  withLock<T>(lockUrl: string, fn: (lock: AdtLock, client: ADTClient) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.login()
      this.client.stateful = session_types.stateful
      let lock: AdtLock
      try {
        lock = await this.client.lock(lockUrl)
      } catch (e) {
        this.client.stateful = session_types.stateless
        throw e
      }
      try {
        return await fn(lock, this.client)
      } finally {
        try {
          await this.client.unLock(lockUrl, lock.LOCK_HANDLE)
        } catch {
          // the session drop below releases the lock anyway
        }
        try {
          await this.client.dropSession()
        } catch {
          this.client.stateful = session_types.stateless
        }
      }
    })
  }
}

/** Registry of configured systems. */
export class Systems {
  private readonly map = new Map<string, AbapSystem>()
  readonly defaultName: string

  constructor(
    readonly config: Config,
    factory: (c: SystemConfig) => AbapSystem = c => new AbapSystem(c)
  ) {
    for (const s of config.systems) this.map.set(s.name.toLowerCase(), factory(s))
    this.defaultName = config.defaultSystem ?? config.systems[0]?.name ?? ""
  }

  list(): AbapSystem[] {
    return [...this.map.values()]
  }

  get(name?: string): AbapSystem {
    const key = (name?.trim() || this.defaultName).toLowerCase()
    const system = this.map.get(key)
    if (system) return system
    const names = this.list()
      .map(s => s.name)
      .join(", ")
    throw new SystemError(`Unknown system "${name}". Configured systems: ${names}`)
  }
}
