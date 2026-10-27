import https from "node:https"
import { readFileSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { ADTClient, isCsrfError, session_types } from "abap-adt-api"
import type { AdtLock, ClientOptions, HttpClient } from "abap-adt-api"
import { AxiosHttpClient } from "abap-adt-api/build/AxiosHttpClient.js"
import type { Config, SystemConfig } from "./config.js"
import { CookieAuthHttpClient, type CookieProvider } from "./cookieHttp.js"
import { BrowserSsoProvider, StaticCookieProvider } from "./sso.js"

export class SystemError extends Error {}

const log = (system: string) => (message: string) => console.error(`[${system}] ${message}`)

/** The system whose queue the current async context runs in (makes exclusive() re-entrant). */
const inQueue = new AsyncLocalStorage<AbapSystem>()

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
  /** true when reads and writes share one SAP session (cookie based logons) */
  readonly singleSession: boolean
  private queue: Promise<unknown> = Promise.resolve()
  /** problems releasing locks, reported with the result of the operation that held them */
  private unlockProblems: string[] = []

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
          waitSeconds: sso.waitSeconds ?? 45,
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

  /**
   * Runs `fn` after all previously queued operations of this system completed. Re-entrant:
   * calls from inside a queued operation run directly instead of waiting for themselves.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (inQueue.getStore() === this) return fn()
    const start = () => inQueue.run(this, fn)
    const run = this.queue.then(start, start)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Runs a whole tool call. With one shared SAP session (cookie logons) every call is queued:
   * a read running while another call holds a stateful lock session would otherwise run inside
   * that session or collide with its lock (EU510 "currently editing"), and the lock could
   * outlive the call. With separate sessions only the stateful parts are queued.
   */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.singleSession ? this.exclusive(fn) : fn()
  }

  /** Lock release problems since the last call, cleared on reading. */
  takeUnlockProblems(): string[] {
    const p = this.unlockProblems
    this.unlockProblems = []
    return p
  }

  /** Fetches a new CSRF token for an ADT session (after SAP rejected the current one). */
  async refreshCsrf(client: ADTClient = this.client) {
    const h = client.httpClient
    h.csrfToken = "fetch"
    await h.request("/sap/bc/adt/compatibility/graph")
  }

  /**
   * Runs `fn`; when SAP rejects the CSRF token (the request was refused before anything
   * changed), fetches a new token for `client` and runs `fn` once more.
   */
  async retryOnCsrf<T>(fn: () => Promise<T>, client: ADTClient = this.client): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (!isCsrfError(e)) throw e
      log(this.name)("CSRF token rejected, fetching a new one and repeating the operation")
      await this.refreshCsrf(client)
      return fn()
    }
  }

  /**
   * Locks an object in a stateful session, runs `fn`, then unlocks and drops the session.
   * The lock handle and the (stateful) client to use for the write are passed to `fn`.
   */
  withLock<T>(lockUrl: string, fn: (lock: AdtLock, client: ADTClient) => Promise<T>): Promise<T> {
    // a rejected CSRF token fails the lock request, before anything changed: safe to repeat
    return this.exclusive(() => this.retryOnCsrf(() => this.lockedRun(lockUrl, fn)))
  }

  private async lockedRun<T>(lockUrl: string, fn: (lock: AdtLock, client: ADTClient) => Promise<T>): Promise<T> {
    await this.login()
    this.client.stateful = session_types.stateful
    let lock: AdtLock
    try {
      lock = await this.client.lock(lockUrl)
    } catch (e) {
      try {
        await this.client.dropSession()
      } catch {
        this.client.stateful = session_types.stateless
      }
      throw e
    }
    try {
      return await fn(lock, this.client)
    } finally {
      let unlockError: unknown
      try {
        await this.client.unLock(lockUrl, lock.LOCK_HANDLE)
      } catch (e) {
        unlockError = e
      }
      try {
        // ending the stateful session releases its locks even when the unlock failed
        await this.client.dropSession()
      } catch (e) {
        this.client.stateful = session_types.stateless
        if (unlockError)
          this.unlockProblems.push(
            `The lock on ${lockUrl} may still be held: unlock failed (${messageOf(unlockError)}) and ending the SAP session failed (${messageOf(e)}). ` +
              `SAP releases it when the session times out; until then saving reports "currently editing".`
          )
      }
    }
  }
}

/** Registry of configured systems. */
export class Systems {
  private map = new Map<string, AbapSystem>()
  defaultName = ""

  constructor(
    public config: Config,
    private readonly factory: (c: SystemConfig) => AbapSystem = c => new AbapSystem(c)
  ) {
    this.update(config)
  }

  /**
   * Applies a new configuration (config file edited while the server runs). Systems whose
   * settings are unchanged keep their session; changed and new ones start fresh.
   */
  update(config: Config): { added: string[]; changed: string[]; removed: string[] } {
    const next = new Map<string, AbapSystem>()
    const added: string[] = []
    const changed: string[] = []
    for (const s of config.systems) {
      const key = s.name.toLowerCase()
      const prev = this.map.get(key)
      if (prev && JSON.stringify(prev.config) === JSON.stringify(s)) next.set(key, prev)
      else {
        next.set(key, this.factory(s))
        ;(prev ? changed : added).push(s.name)
      }
    }
    const removed = [...this.map.values()].filter(s => !next.has(s.name.toLowerCase())).map(s => s.name)
    this.map = next
    this.config = config
    this.defaultName = config.defaultSystem ?? config.systems[0]?.name ?? ""
    return { added, changed, removed }
  }

  /** Runs a tool call in the queue of the named (or default) system, see AbapSystem.serialize. */
  serialize<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
    let system: AbapSystem
    try {
      system = this.get(name)
    } catch {
      return fn() // the tool reports the unknown system itself
    }
    return system.serialize(fn)
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
