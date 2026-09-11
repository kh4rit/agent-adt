import type { SyntaxCheckResult } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { label, type ResolvedObject } from "../objects.js"
import { numbered, plural } from "../format.js"
import { transportForLockedObject } from "./transports.js"
import { activateObject, formatActivation, type ActivationSummary } from "./activation.js"

export interface ReadOptions {
  version?: "active" | "inactive"
  startLine?: number
  endLine?: number
  lineNumbers?: boolean
}

export interface ReadResult {
  source: string
  version: "active" | "inactive"
  totalLines: number
  text: string
}

/** Reads the source of an object; the inactive version when one exists unless told otherwise. */
export async function readSource(system: AbapSystem, obj: ResolvedObject, options: ReadOptions = {}): Promise<ReadResult> {
  const version = options.version ?? (obj.version === "inactive" ? "inactive" : "active")
  const explicit = options.version !== undefined || version === "inactive"
  const source = await system.reader.getObjectSource(obj.sourceUrl, explicit ? { version } : undefined)
  const lines = source.split(/\r?\n/)
  const start = Math.max(1, options.startLine ?? 1)
  const end = Math.min(lines.length, options.endLine ?? lines.length)
  const slice = lines.slice(start - 1, end).join("\n")
  const header = `${label(obj)} [${version}]` + (start > 1 || end < lines.length ? ` lines ${start}-${end} of ${lines.length}` : ` ${plural(lines.length, "line")}`)
  const body = options.lineNumbers ? numbered(slice, start) : slice
  return { source, version, totalLines: lines.length, text: `${header}\n${body}` }
}

export interface Edit {
  oldText: string
  newText: string
}

export class EditError extends Error {}

/** Applies search/replace edits; every oldText must occur exactly once. */
export function applyEdits(source: string, edits: Edit[]): { result: string; replaced: number } {
  let result = source
  const normalize = (s: string) => s.replace(/\r\n/g, "\n")
  result = normalize(result)
  edits.forEach((edit, i) => {
    const oldText = normalize(edit.oldText)
    const newText = normalize(edit.newText)
    if (!oldText) throw new EditError(`Edit ${i + 1}: oldText must not be empty`)
    const first = result.indexOf(oldText)
    if (first < 0) throw new EditError(`Edit ${i + 1}: oldText not found in the current source:\n${oldText}`)
    const second = result.indexOf(oldText, first + oldText.length)
    if (second >= 0)
      throw new EditError(`Edit ${i + 1}: oldText occurs more than once; include more surrounding lines to make it unique:\n${oldText}`)
    result = result.slice(0, first) + newText + result.slice(first + oldText.length)
  })
  return { result, replaced: edits.length }
}

export function formatSyntax(messages: SyntaxCheckResult[], obj: ResolvedObject): string {
  if (!messages.length) return "Syntax check: no errors or warnings."
  const errors = messages.filter(m => /^[EAX]/i.test(m.severity))
  const head = `Syntax check: ${plural(errors.length, "error")}, ${plural(messages.length - errors.length, "warning/info")}`
  const lines = messages.map(m => {
    const where = m.uri && m.uri !== obj.sourceUrl ? ` in ${m.uri}` : ""
    return `  [${m.severity}] line ${m.line}, col ${m.offset}${where}: ${m.text}`
  })
  return [head, ...lines].join("\n")
}

/** Runs the ABAP syntax check against the given (unsaved) source. */
export async function syntaxCheck(system: AbapSystem, obj: ResolvedObject, source: string): Promise<SyntaxCheckResult[]> {
  const inclUrl = obj.isClass ? obj.sourceUrl : obj.objectUrl
  return system.reader.syntaxCheck(inclUrl, obj.sourceUrl, source, obj.mainProgram ?? "")
}

export interface WriteOptions {
  transport?: string
  activate?: boolean
  checkSyntax?: boolean
}

export interface WriteResult {
  transport: string
  transportNote?: string
  syntax?: SyntaxCheckResult[]
  activation?: ActivationSummary
  text: string
}

/** Locks, saves (recording the change in a transport when needed), unlocks, then checks / activates. */
export async function writeSource(
  system: AbapSystem,
  obj: ResolvedObject,
  source: string,
  options: WriteOptions = {}
): Promise<WriteResult> {
  system.assertWritable("saving source code")
  if (!obj.hasSource) throw new Error(`${label(obj)} has no ABAP source that can be written with this tool`)
  const normalized = source.replace(/\r\n/g, "\n")
  const { transport, note } = await system.withLock(obj.lockUrl, async (lock, client) => {
    const choice = await transportForLockedObject(client, obj, lock, options.transport)
    await client.setObjectSource(obj.sourceUrl, normalized, lock.LOCK_HANDLE, choice.transport)
    return choice
  })
  const out: string[] = [`Saved ${label(obj)} (inactive version)${transport ? ` in transport ${transport}` : ""}${note ? ` - ${note}` : ""}.`]
  const result: WriteResult = { transport, transportNote: note, text: "" }
  if (options.checkSyntax !== false) {
    try {
      result.syntax = await syntaxCheck(system, obj, normalized)
      out.push(formatSyntax(result.syntax, obj))
    } catch (e) {
      out.push(`Syntax check could not be run: ${(e as Error).message}`)
    }
  }
  if (options.activate) {
    result.activation = await activateObject(system, obj)
    out.push(formatActivation(`${obj.type} ${obj.lockName}`, result.activation))
  } else out.push("The object is saved but inactive. Call abap_activate to activate it.")
  result.text = out.join("\n")
  return result
}
