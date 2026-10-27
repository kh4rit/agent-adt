import { isAdtError, isHttpError } from "abap-adt-api"

const PROXY_HINT =
  "This usually comes from a proxy between this machine and SAP (HTTPS_PROXY): set noProxy: true for the system (SAP_NO_PROXY=true) or add the SAP host to NO_PROXY."

/** Guidance for SAP messages agents repeatedly misread, keyed by T100 message or text. */
export function adtHint(text: string, p: Record<string, string>): string | undefined {
  const key = `${p["T100KEY-ID"] ?? ""}/${p["T100KEY-NO"] ?? ""}`.toUpperCase()
  const vars = ["T100KEY-V1", "T100KEY-V2", "T100KEY-V3", "T100KEY-V4"].map(k => p[k]).filter(Boolean)
  if (key === "EU/510" || /currently editing|already being edited/i.test(text))
    return (
      "Hint: the object is locked by an editor session. If the user is the tool's own user, an earlier call's SAP session still holds the lock: " +
      "it is released when that session ends (usually within minutes) or by the user in SM12. Do not delete lock entries from ABAP. " +
      "Re-read the source before repeating a change: an earlier save may already have gone through."
    )
  if (key === "TK/572" || /locked in different requests|locked in request and separate task/i.test(text))
    return (
      `Hint: parts of the object are recorded in different transport requests${vars.length ? ` (${vars.join("; ")})` : ""}. ` +
      "A change needs them in one request: the owners have to merge the tasks or requests (SE09/SE10) or release one first. Read them with abap_read_transport; do not move objects between requests yourself."
    )
  if (/^FUNC_ADT\/0*15$/.test(key) || /declares no type/i.test(text))
    return "Hint: in the source based function module signature a TABLES parameter needs LIKE <table> or TYPE <table type>; STRUCTURE is not accepted there."
  return undefined
}

/** Turns any thrown value into a message an agent can act on. */
export function errorMessage(e: unknown): string {
  if (isAdtError(e)) {
    // abap-adt-api reports failures of the HTTP layer that are not HTTP answers (logon needed,
    // network) as "500 Unknown error" with the original error as text
    if (e.type === "Unknown error" && !e.localizedMessage) return `${e.message}`.replace(/^(\w*Error): /, "")
    const parts: string[] = []
    const status = e.err && e.err >= 100 ? `HTTP ${e.err}` : ""
    parts.push([status, e.type, e.message].filter(Boolean).join(" "))
    if (e.localizedMessage && e.localizedMessage !== e.message) parts.push(e.localizedMessage)
    const properties = (e.properties || {}) as Record<string, string>
    // LONGTEXT is the SAPscript long text as HTML (about 1 KB per message): the key is enough
    const props = Object.entries(properties)
      .filter(([k, v]) => v && k !== "LONGTEXT")
      .map(([k, v]) => `${k}=${v}`)
    if (props.length) parts.push(props.join(", "))
    const hint = adtHint(`${e.message} ${e.localizedMessage ?? ""}`, properties)
    return `ADT error: ${parts.join(" | ")}${hint ? `\n${hint}` : ""}`
  }
  if (isHttpError(e)) {
    if (e.status === 401 || e.status === 403)
      return `HTTP ${e.status}: logon to SAP failed. Check url, client, user and password (${e.message})`
    const proxy = e.status === 502 || /ERR_PROXY|proxy/i.test(e.message) ? `\n${PROXY_HINT}` : ""
    return `HTTP ${e.status || "error"}: ${e.message}${proxy}`
  }
  if (e instanceof Error && /ERR_PROXY|proxy tunnel/i.test(e.message)) return `${e.message}\n${PROXY_HINT}`
  if (e instanceof Error) return e.message
  return String(e)
}

/** Prefixes every line with its line number, right aligned. */
export function numbered(source: string, start = 1): string {
  const lines = source.split(/\r?\n/)
  const width = String(start + lines.length - 1).length
  return lines.map((l, i) => `${String(start + i).padStart(width, " ")}| ${l}`).join("\n")
}

export function truncate(text: string, max = 20000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... (${text.length - max} more characters truncated)`
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

export const line = (parts: (string | undefined | false)[], sep = "  ") =>
  parts.filter(p => p !== undefined && p !== false && p !== "").join(sep)
