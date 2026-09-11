import { inactiveObjectsInResults } from "abap-adt-api"
import type { ActivationResult, InactiveObject, InactiveObjectRecord } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import type { ResolvedObject } from "../objects.js"
import { plural } from "../format.js"

export interface ActivationMessage {
  severity: string
  text: string
  object: string
  include?: string
  line?: number
  column?: number
  uri?: string
}

export interface ActivationSummary {
  success: boolean
  messages: ActivationMessage[]
  /** objects still inactive after the attempt */
  inactive: string[]
}

const SEVERITY_LABEL: Record<string, string> = { E: "error", A: "error", X: "error", W: "warning", I: "info" }

function parseHref(href?: string): { uri?: string; line?: number; column?: number; include?: string } {
  if (!href) return {}
  const [uri, fragment] = href.split("#")
  const m = fragment?.match(/start=(\d+)(?:,(\d+))?/)
  const inc = uri.match(/\/includes\/([a-z]+)/i)?.[1] ?? (/\/oo\/classes\/.*\/source\/main/i.test(uri) ? "main" : undefined)
  return { uri, line: m ? Number(m[1]) : undefined, column: m?.[2] ? Number(m[2]) : undefined, include: inc }
}

export function summarize(result: ActivationResult): ActivationSummary {
  const messages: ActivationMessage[] = (result.messages ?? []).map(m => {
    const href = parseHref(m.href)
    const lineNo = typeof m.line === "number" && m.line > 0 ? m.line : href.line
    return {
      severity: SEVERITY_LABEL[`${m.type}`.toUpperCase()] ?? `${m.type}`,
      text: `${m.shortText ?? ""}`.trim(),
      object: `${m.objDescr ?? ""}`.trim(),
      include: href.include,
      line: lineNo,
      column: href.column,
      uri: href.uri
    }
  })
  const inactive = (result.inactive ?? [])
    .map(r => r.object)
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map(o => `${o["adtcore:type"]} ${o["adtcore:name"]}`)
  return { success: result.success, messages, inactive }
}

/** Activates one resolved object, retrying with the objects SAP reports as still inactive. */
export async function activateObject(system: AbapSystem, obj: ResolvedObject): Promise<ActivationSummary> {
  system.assertWritable("activation")
  const client = system.reader
  let result = await client.activate(obj.lockName, obj.lockUrl, obj.mainProgram)
  if (!result.success && result.inactive?.length && !result.messages?.some(m => /[EAX]/.test(`${m.type}`))) {
    const objects = inactiveObjectsInResults(result)
    if (objects.length) result = await client.activate(objects)
  }
  return summarize(result)
}

/** Activates a list of inactive objects (as returned by the inactive object list). */
export async function activateInactive(system: AbapSystem, objects: InactiveObject[]): Promise<ActivationSummary> {
  system.assertWritable("activation")
  if (!objects.length) return { success: true, messages: [], inactive: [] }
  return summarize(await system.reader.activate(objects))
}

export async function inactiveObjects(system: AbapSystem): Promise<InactiveObjectRecord[]> {
  const records = await system.reader.inactiveObjects()
  return records.filter(r => r.object)
}

export function formatInactive(records: InactiveObjectRecord[], system: AbapSystem): string {
  if (!records.length) return `No inactive objects in ${system.name}.`
  const lines = records.map(r => {
    const o = r.object!
    const tr = r.transport ? `  transport ${r.transport["adtcore:name"]}` : ""
    return `- ${o["adtcore:type"]} ${o["adtcore:name"]}  user ${o.user}${o.deleted ? "  (deleted)" : ""}${tr}  ${o["adtcore:uri"]}`
  })
  return `${plural(records.length, "inactive object")} in ${system.name}:\n${lines.join("\n")}`
}

export function formatActivation(target: string, s: ActivationSummary): string {
  const out: string[] = [`Activation of ${target}: ${s.success ? "SUCCESS" : "FAILED"}`]
  const errors = s.messages.filter(m => m.severity === "error")
  const others = s.messages.filter(m => m.severity !== "error")
  const fmt = (m: ActivationMessage) => {
    const where = [m.include && m.include !== "main" ? m.include : "", m.line ? `line ${m.line}${m.column ? `, col ${m.column}` : ""}` : ""]
      .filter(Boolean)
      .join(" ")
    return `  [${m.severity}] ${m.object}${where ? ` (${where})` : ""}: ${m.text}${m.uri ? `\n      ${m.uri}${m.line ? `#start=${m.line},${m.column ?? 0}` : ""}` : ""}`
  }
  if (errors.length) out.push(`${plural(errors.length, "error")}:`, ...errors.map(fmt))
  if (others.length) out.push(`${plural(others.length, "other message")}:`, ...others.map(fmt))
  if (s.inactive.length) out.push(`Still inactive: ${s.inactive.join(", ")}`)
  if (!s.success && !s.messages.length && !s.inactive.length)
    out.push("  SAP reported a failure without messages. Check the object in SAP GUI or retry.")
  if (s.success && !s.messages.length) out.push("  Object is active; no messages.")
  return out.join("\n")
}
