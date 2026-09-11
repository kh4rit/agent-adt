import { isAdtError, isHttpError } from "abap-adt-api"

/** Turns any thrown value into a message an agent can act on. */
export function errorMessage(e: unknown): string {
  if (isAdtError(e)) {
    const parts: string[] = []
    const status = e.err && e.err >= 100 ? `HTTP ${e.err}` : ""
    parts.push([status, e.type, e.message].filter(Boolean).join(" "))
    if (e.localizedMessage && e.localizedMessage !== e.message) parts.push(e.localizedMessage)
    const props = Object.entries(e.properties || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
    if (props.length) parts.push(props.join(", "))
    return `ADT error: ${parts.join(" | ")}`
  }
  if (isHttpError(e)) {
    if (e.status === 401 || e.status === 403)
      return `HTTP ${e.status}: logon to SAP failed. Check url, client, user and password (${e.message})`
    return `HTTP ${e.status || "error"}: ${e.message}`
  }
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
