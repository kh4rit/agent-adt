import type { HttpClient } from "abap-adt-api"
import { AbapSystem } from "../connection.js"
import type { SystemConfig } from "../config.js"

export type HttpOptions = Parameters<HttpClient["request"]>[0]
export type HttpResponse = Awaited<ReturnType<HttpClient["request"]>>

export interface Call {
  method: string
  url: string
  qs: Record<string, any>
  body?: string
  headers: Record<string, string>
}

type Reply = string | Partial<HttpResponse>
interface Route {
  method?: string
  match: string | RegExp
  reply: (call: Call) => Reply
}

/** In-memory replacement for the HTTP layer of abap-adt-api, replaying canned ADT responses. */
export class FakeHttp implements HttpClient {
  calls: Call[] = []
  private routes: Route[] = []
  /** optional hook answering a call before the routes are consulted */
  intercept?: (call: Call) => HttpResponse | undefined

  on(method: string | undefined, match: string | RegExp, reply: Reply | ((call: Call) => Reply)) {
    // later registrations win, so tests can override a default route
    this.routes.unshift({ method: method?.toUpperCase(), match, reply: typeof reply === "function" ? reply : () => reply })
    return this
  }

  find(method: string, url: string | RegExp) {
    return this.calls.filter(c => c.method === method.toUpperCase() && (typeof url === "string" ? c.url === url : url.test(c.url)))
  }

  async request(options: HttpOptions): Promise<HttpResponse> {
    const [path, query] = options.url.split("?")
    const qs: Record<string, any> = { ...(options.qs ?? {}) }
    for (const [k, v] of new URLSearchParams(query ?? "")) qs[k] = v
    const call: Call = {
      method: (options.method ?? "GET").toUpperCase(),
      url: path,
      qs,
      body: options.body,
      headers: (options.headers ?? {}) as Record<string, string>
    }
    this.calls.push(call)
    const intercepted = this.intercept?.(call)
    if (intercepted) return intercepted
    if (call.url === "/sap/bc/adt/compatibility/graph")
      return {
        status: 200,
        statusText: "OK",
        body: "",
        headers: { "x-csrf-token": "TOKEN", "set-cookie": ["SAP_SESSIONID_NPL_001=abc; path=/"] }
      }
    for (const r of this.routes) {
      if (r.method && r.method !== call.method) continue
      if (typeof r.match === "string" ? r.match !== call.url : !r.match.test(call.url)) continue
      const reply = r.reply(call)
      if (typeof reply === "string") return { status: 200, statusText: "OK", body: reply, headers: {} }
      return { status: 200, statusText: "OK", body: "", headers: {}, ...reply }
    }
    return { status: 404, statusText: `no fake route for ${call.method} ${call.url}`, body: "", headers: {} }
  }
}

export const testConfig: SystemConfig = { name: "TST", url: "http://fake", username: "developer", password: "secret", client: "001" }

export const makeSystem = (http: HttpClient, config: Partial<SystemConfig> = {}) => new AbapSystem({ ...testConfig, ...config }, http)
