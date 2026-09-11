import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { CookieProvider } from "./cookieHttp.js"

export interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  /** unix seconds; -1 for session cookies */
  expires: number
}

export interface CookieCache {
  system: string
  host: string
  /** ms since epoch */
  capturedAt: number
  cookies: StoredCookie[]
}

export interface SsoOptions {
  system: string
  baseUrl: string
  client?: string
  language?: string
  browser?: string
  profileDir?: string
  cacheFile?: string
  loginUrl?: string
  /** try a silent (headless) logon before opening a window, default true */
  headless?: boolean
  /** seconds to wait for the interactive logon, default 300 */
  timeoutSeconds?: number
  /** seconds to wait for the silent logon, default 30 */
  headlessTimeoutSeconds?: number
  /** hours after which the cache is considered stale, default 8 */
  maxAgeHours?: number
  log?: (message: string) => void
}

export class SsoError extends Error {}

export const dataDir = () => join(homedir(), ".abap-adt-mcp")
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_")

/** Cookies whose domain covers `host` (host-only or parent domain). */
export function cookiesForHost(cookies: StoredCookie[], host: string): StoredCookie[] {
  const h = host.toLowerCase()
  return cookies.filter(c => {
    const d = (c.domain ?? "").toLowerCase().replace(/^\./, "")
    return d === h || h.endsWith(`.${d}`)
  })
}

export const isSapSessionCookie = (name: string) => /^SAP_SESSIONID_/i.test(name) || /^MYSAPSSO2$/i.test(name)

export const hasSapSession = (cookies: StoredCookie[]) => cookies.some(c => isSapSessionCookie(c.name))

export const toCookieHeader = (cookies: StoredCookie[]) => cookies.map(c => `${c.name}=${c.value}`).join("; ")

/** A cache is stale when it is older than maxAge or a SAP session cookie has expired. */
export function isStale(cache: CookieCache, now: number, maxAgeMs: number): boolean {
  if (now - cache.capturedAt > maxAgeMs) return true
  const session = cache.cookies.filter(c => isSapSessionCookie(c.name))
  if (!session.length) return true
  return session.some(c => c.expires > 0 && c.expires * 1000 < now)
}

export function loadCache(file: string): CookieCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as CookieCache
    if (!raw || !Array.isArray(raw.cookies) || typeof raw.capturedAt !== "number") return undefined
    return raw
  } catch {
    return undefined
  }
}

export function saveCache(file: string, cache: CookieCache) {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: ACLs of the user profile apply
  }
}

/** Parses Chromium's DevToolsActivePort file: first line port, second line the browser websocket path. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } {
  const [portLine = "", pathLine = ""] = text.split(/\r?\n/)
  const port = Number(portLine.trim())
  if (!Number.isInteger(port) || port <= 0) throw new SsoError(`Unexpected DevToolsActivePort content: ${JSON.stringify(text)}`)
  return { port, path: pathLine.trim() }
}

function candidates(): string[] {
  const env = process.env
  if (process.platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((r): r is string => !!r)
    return roots.flatMap(r => [
      join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(r, "Google", "Chrome", "Application", "chrome.exe"),
      join(r, "Chromium", "Application", "chrome.exe")
    ])
  }
  if (process.platform === "darwin")
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ]
  const names = ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean)
  return names.flatMap(n => dirs.map(d => join(d, n)))
}

/** Locates a Chromium based browser executable. */
export function findBrowser(explicit?: string): string {
  if (explicit) {
    if (existsSync(explicit)) return explicit
    throw new SsoError(`Browser not found at ${explicit}`)
  }
  const found = candidates().find(p => existsSync(p))
  if (found) return found
  throw new SsoError(
    "No Microsoft Edge or Google Chrome installation found. Set sso.browser (or SAP_SSO_BROWSER) to the path of a Chromium based browser."
  )
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Minimal Chrome DevTools Protocol client on the built-in WebSocket. */
class Cdp {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  static connect(url: string): Promise<Cdp> {
    if (typeof WebSocket === "undefined")
      throw new SsoError("Browser SSO needs Node.js 22 or newer (global WebSocket). Please upgrade Node or use auth = cookie.")
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true })
      ws.addEventListener("error", () => reject(new SsoError(`Cannot connect to the browser DevTools endpoint ${url}`)), { once: true })
    })
  }

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", ev => {
      let msg: any
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const p = msg && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new SsoError(`CDP ${msg.error.message ?? "error"}`))
      else p.resolve(msg.result)
    })
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new SsoError("Browser connection closed"))
      this.pending.clear()
    })
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

async function waitForDevTools(profileDir: string, timeoutMs: number, child: ChildProcess): Promise<{ port: number; path: string }> {
  const file = join(profileDir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new SsoError(`The browser exited with code ${child.exitCode} before the logon could start`)
    if (existsSync(file)) {
      try {
        const parsed = parseDevToolsActivePort(readFileSync(file, "utf8"))
        if (parsed.path) return parsed
      } catch {
        // partially written, retry
      }
    }
    await sleep(200)
  }
  throw new SsoError(`The browser did not open its DevTools port within ${timeoutMs / 1000}s`)
}

async function waitExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode) return
  await Promise.race([new Promise<void>(r => child.once("exit", () => r())), sleep(timeoutMs)])
  if (child.exitCode === null && !child.signalCode) child.kill()
}

interface BrowserRun {
  exe: string
  profileDir: string
  url: string
  host: string
  headless: boolean
  timeoutMs: number
  log: (m: string) => void
}

/** Starts the browser on the logon URL and polls its cookie store until SAP session cookies for `host` exist. */
export async function runBrowserLogon(run: BrowserRun): Promise<StoredCookie[] | undefined> {
  mkdirSync(run.profileDir, { recursive: true })
  rmSync(join(run.profileDir, "DevToolsActivePort"), { force: true })
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${run.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=Translate",
    ...(run.headless ? ["--headless=new", "--disable-gpu", "--window-size=1200,900"] : ["--new-window"]),
    run.url
  ]
  run.log(`${run.headless ? "silent" : "interactive"} logon: ${run.exe}`)
  const child = spawn(run.exe, args, { stdio: "ignore", windowsHide: run.headless })
  const spawnError = new Promise<never>((_, reject) => child.once("error", e => reject(new SsoError(`Cannot start browser ${run.exe}: ${e.message}`))))
  try {
    const { port, path } = await Promise.race([waitForDevTools(run.profileDir, 20000, child), spawnError])
    const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`)
    try {
      const deadline = Date.now() + run.timeoutMs
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new SsoError("The browser window was closed before the logon completed")
        const result = await cdp.send<{ cookies: any[] }>("Storage.getCookies")
        const stored: StoredCookie[] = (result.cookies ?? []).map(c => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain ?? ""),
          path: String(c.path ?? "/"),
          expires: typeof c.expires === "number" ? c.expires : -1
        }))
        const sap = cookiesForHost(stored, run.host)
        if (hasSapSession(sap)) return sap
        await sleep(750)
      }
      return undefined
    } finally {
      await cdp.send("Browser.close").catch(() => undefined)
      cdp.close()
    }
  } finally {
    await waitExit(child, 5000)
  }
}

/** Logs on through the browser and caches the SAP cookies; refreshes them when SAP rejects a call. */
export class BrowserSsoProvider implements CookieProvider {
  readonly description = "browser SSO session"
  private cache?: CookieCache
  private pending?: Promise<string>
  private lastLogon = 0
  readonly host: string
  readonly cacheFile: string
  readonly profileDir: string
  private readonly log: (m: string) => void

  constructor(private readonly o: SsoOptions) {
    this.host = new URL(o.baseUrl).hostname
    this.cacheFile = o.cacheFile ?? join(dataDir(), `${safeName(o.system)}.cookies.json`)
    this.profileDir = o.profileDir ?? join(dataDir(), "browser-profile")
    this.log = o.log ?? (() => {})
  }

  get loginUrl() {
    if (this.o.loginUrl) return this.o.loginUrl
    const qs = new URLSearchParams()
    if (this.o.client) qs.set("sap-client", this.o.client)
    if (this.o.language) qs.set("sap-language", this.o.language)
    const q = qs.toString()
    return `${this.o.baseUrl}/sap/bc/adt/discovery${q ? `?${q}` : ""}`
  }

  private get maxAgeMs() {
    return (this.o.maxAgeHours ?? 8) * 3600 * 1000
  }

  private header(cache: CookieCache) {
    return toCookieHeader(cookiesForHost(cache.cookies, this.host))
  }

  /** Cached cookies, if still valid. */
  cached(): CookieCache | undefined {
    if (!this.cache) this.cache = loadCache(this.cacheFile)
    if (this.cache && this.cache.host === this.host && !isStale(this.cache, Date.now(), this.maxAgeMs)) return this.cache
    return undefined
  }

  async cookieHeader(): Promise<string> {
    const cache = this.cached()
    if (cache) return this.header(cache)
    return this.refresh("no valid cached logon")
  }

  refresh(reason: string): Promise<string> {
    if (this.pending) return this.pending
    // a logon that just happened serves concurrent callers that failed with the old cookies
    if (this.cache && Date.now() - this.lastLogon < 15000) return Promise.resolve(this.header(this.cache))
    this.log(`browser logon to ${this.host} (${reason})`)
    this.pending = this.logon(false).finally(() => (this.pending = undefined))
    return this.pending
  }

  /** Runs the browser logon; `interactive` skips the silent attempt. */
  async logon(interactive: boolean): Promise<string> {
    const exe = findBrowser(this.o.browser)
    const common = { exe, profileDir: this.profileDir, url: this.loginUrl, host: this.host, log: this.log }
    let cookies: StoredCookie[] | undefined
    if (!interactive && this.o.headless !== false) {
      cookies = await runBrowserLogon({ ...common, headless: true, timeoutMs: (this.o.headlessTimeoutSeconds ?? 30) * 1000 })
      if (!cookies) this.log("silent logon did not complete, opening a browser window")
    }
    if (!cookies) cookies = await runBrowserLogon({ ...common, headless: false, timeoutMs: (this.o.timeoutSeconds ?? 300) * 1000 })
    if (!cookies) throw new SsoError(`No SAP session cookie for ${this.host} appeared within the logon timeout`)
    this.cache = { system: this.o.system, host: this.host, capturedAt: Date.now(), cookies }
    this.lastLogon = Date.now()
    saveCache(this.cacheFile, this.cache)
    this.log(`logged on; cached ${cookies.map(c => c.name).join(", ")} in ${this.cacheFile}`)
    return this.header(this.cache)
  }

  /** Removes cached cookies (they stay valid in SAP until they expire). */
  forget() {
    this.cache = undefined
    rmSync(this.cacheFile, { force: true })
  }
}

/** Cookies supplied by the user (auth = cookie). */
export class StaticCookieProvider implements CookieProvider {
  readonly description = "configured cookie"
  constructor(private readonly header: string) {}
  async cookieHeader() {
    return this.header
  }
}
