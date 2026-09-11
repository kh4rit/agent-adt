import type { HttpClient } from "abap-adt-api"

export type HttpOptions = Parameters<HttpClient["request"]>[0]
export type HttpResponse = Awaited<ReturnType<HttpClient["request"]>>

/** Supplies the SAP cookies used instead of a password. */
export interface CookieProvider {
  /** Short description used in error messages, e.g. "browser SSO session". */
  readonly description: string
  /** Cookie header for the SAP host; logs on first when nothing valid is cached. */
  cookieHeader(): Promise<string>
  /** Discards the current cookies and logs on again. Missing for static cookies. */
  refresh?(reason: string): Promise<string>
}

export class SessionExpiredError extends Error {}

const SAML_MARKERS = /SAMLRequest|SAMLResponse|login\.microsoftonline\.com|name="saml/i

/** True when SAP answered an ADT call with the HTML page that starts the SAML logon. */
export function isSamlChallenge(resp: Pick<HttpResponse, "status" | "headers" | "body">): boolean {
  if (resp.status !== 200 || typeof resp.body !== "string") return false
  const contentType = String(resp.headers?.["content-type"] ?? "")
  const html = /text\/html/i.test(contentType) || /^\s*(<!DOCTYPE html|<html)/i.test(resp.body)
  return html && SAML_MARKERS.test(resp.body)
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i <= 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (name) jar.set(name, value)
  }
  return jar
}

export const serializeCookies = (jar: Map<string, string>) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")

const statusOf = (e: unknown): number | undefined =>
  e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined

/**
 * HTTP client that authenticates with SAP session cookies instead of a password:
 * strips the Basic/Bearer credentials abap-adt-api adds, sends the provider's cookies plus the
 * cookies SAP issued since, and on an expired session (401 or SAML redirect page) logs on
 * again through the provider and retries the call exactly once.
 */
export class CookieAuthHttpClient implements HttpClient {
  /** cookies SAP set on responses after the logon (e.g. a renewed SAP_SESSIONID) */
  private issued = new Map<string, string>()

  constructor(
    private readonly delegate: HttpClient,
    private readonly provider: CookieProvider,
    private readonly log: (message: string) => void = () => {}
  ) {}

  private prepare(options: HttpOptions, base: string): HttpOptions {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    for (const k of Object.keys(headers)) if (/^(authorization|cookie)$/i.test(k)) delete headers[k]
    const jar = parseCookieHeader(base)
    for (const [k, v] of this.issued) jar.set(k, v)
    const cookie = serializeCookies(jar)
    if (cookie) headers.Cookie = cookie
    const { auth: _auth, ...rest } = options
    return { ...rest, headers }
  }

  private remember(resp: HttpResponse) {
    const raw = resp.headers?.["set-cookie"]
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
    for (const sc of list) {
      const [pair] = sc.split(";")
      const i = pair.indexOf("=")
      if (i <= 0) continue
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      if (value) this.issued.set(name, value)
      else this.issued.delete(name)
    }
  }

  private async attempt(options: HttpOptions, base: string): Promise<{ response?: HttpResponse; unauthorized?: unknown }> {
    try {
      const response = await this.delegate.request(this.prepare(options, base))
      this.remember(response)
      return { response }
    } catch (e) {
      if (statusOf(e) === 401) return { unauthorized: e }
      throw e
    }
  }

  async request(options: HttpOptions): Promise<HttpResponse> {
    const base = await this.provider.cookieHeader()
    const first = await this.attempt(options, base)
    const reason = first.unauthorized ? "HTTP 401" : first.response && isSamlChallenge(first.response) ? "redirect to the identity provider" : undefined
    if (!reason) return first.response!
    if (!this.provider.refresh)
      throw new SessionExpiredError(
        `SAP rejected the ${this.provider.description} (${reason}). The cookies have expired: capture new ones and update the configuration.`
      )
    this.log(`SAP session expired (${reason}), logging on again through the ${this.provider.description}`)
    const fresh = await this.provider.refresh(reason)
    this.issued.clear()
    const second = await this.attempt(options, fresh)
    if (second.unauthorized) throw second.unauthorized
    if (isSamlChallenge(second.response!))
      throw new SessionExpiredError(
        `SAP still redirects to the identity provider right after a fresh logon. Check that the browser logon reached ${options.url} on the SAP host and that the captured cookies belong to that host.`
      )
    return second.response!
  }
}
