import type { classIncludes, Revision, SyntaxCheckResult } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { label, type ResolvedObject } from "../objects.js"
import { errorMessage, numbered, plural } from "../format.js"
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

/** Number of a stored version ("00001") from its content URI. */
export const revisionNumber = (uri: string) => uri.match(/\/versions\/\d+\/(\d+)\/content$/)?.[1]

/** Stored versions of an object (or class include), newest first, as listed by SAP. */
export async function listRevisions(system: AbapSystem, obj: ResolvedObject): Promise<Revision[]> {
  if (!obj.hasSource) throw new Error(`${label(obj)} has no ABAP source, so it has no source versions`)
  try {
    return await system.reader.revisions(obj.structure, obj.isClass ? (obj.include as classIncludes) : undefined)
  } catch (e) {
    if (/Revision URL not found/.test(`${(e as Error).message}`)) throw new Error(`SAP offers no version history for ${label(obj)} through ADT`)
    throw e
  }
}

export function formatRevisions(obj: ResolvedObject, revisions: Revision[]): string {
  if (!revisions.length) return `${label(obj)} has no stored versions (it was never released in a transport or saved as a version).`
  const lines = revisions.map(r =>
    `- ${revisionNumber(r.uri) ?? "?"}  ${r.date.replace("T", " ").replace(/(:\d\d)(\.\d+)?Z$/, "$1")}  ${r.author}  ${r.version}  ${r.versionTitle}`
  )
  return `${plural(revisions.length, "stored version")} of ${label(obj)} (newest first; the current active/inactive source is read with abap_read_source without revision):\n${lines.join("\n")}`
}

/** Reads a stored version given by number ("00001", "1") or by its content URI. */
export async function readRevision(system: AbapSystem, obj: ResolvedObject, revision: string, options: Omit<ReadOptions, "version"> = {}): Promise<string> {
  const wanted = revision.trim()
  const revisions = await listRevisions(system, obj)
  const match = /^\/sap\/bc\/adt\//i.test(wanted)
    ? revisions.find(r => r.uri.toLowerCase() === wanted.toLowerCase())
    : /^\d+$/.test(wanted)
      ? revisions.find(r => revisionNumber(r.uri) === wanted.padStart(5, "0"))
      : undefined
  if (!match)
    throw new Error(`${label(obj)} has no stored version "${wanted}". ${formatRevisions(obj, revisions)}`)
  const source = await system.reader.getObjectSource(match.uri)
  const lines = source.split(/\r?\n/)
  const start = Math.max(1, options.startLine ?? 1)
  const end = Math.min(lines.length, options.endLine ?? lines.length)
  const slice = lines.slice(start - 1, end).join("\n")
  const range = start > 1 || end < lines.length ? ` lines ${start}-${end} of ${lines.length}` : ` ${plural(lines.length, "line")}`
  const header = `${label(obj)} [stored version ${revisionNumber(match.uri)}, ${match.date}, ${match.author}, ${match.version}]${range}`
  return `${header}\n${options.lineNumbers ? numbered(slice, start) : slice}`
}

export interface Edit {
  oldText: string
  newText: string
  /** 1-based occurrence to replace when oldText occurs more than once */
  occurrence?: number
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
    const positions: number[] = []
    for (let at = result.indexOf(oldText); at >= 0; at = result.indexOf(oldText, at + oldText.length)) positions.push(at)
    if (!positions.length) throw new EditError(`Edit ${i + 1}: oldText not found in the current source:\n${oldText}`)
    let at = positions[0]
    if (edit.occurrence !== undefined) {
      if (edit.occurrence > positions.length)
        throw new EditError(`Edit ${i + 1}: occurrence ${edit.occurrence} requested, but oldText occurs ${positions.length} time(s)`)
      at = positions[edit.occurrence - 1]
    } else if (positions.length > 1) {
      const lines = positions.map(p => result.slice(0, p).split("\n").length)
      throw new EditError(
        `Edit ${i + 1}: oldText occurs ${positions.length} times (lines ${lines.join(", ")}); include more surrounding lines to make it unique, or pass occurrence:\n${oldText}`
      )
    }
    result = result.slice(0, at) + newText + result.slice(at + oldText.length)
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
  // from here on the source is saved: later failures must not hide that
  const out: string[] = [`Saved ${label(obj)} (inactive version)${transport ? ` in transport ${transport}` : ""}${note ? ` - ${note}` : ""}.`]
  out.push(...system.takeUnlockProblems())
  const result: WriteResult = { transport, transportNote: note, text: "" }
  if (options.checkSyntax !== false) {
    try {
      result.syntax = await syntaxCheck(system, obj, normalized)
      out.push(formatSyntax(result.syntax, obj))
    } catch (e) {
      out.push(`Syntax check could not be run: ${errorMessage(e)}`)
    }
  }
  if (options.activate) {
    try {
      result.activation = await activateObject(system, obj)
      out.push(formatActivation(`${obj.type} ${obj.lockName}`, result.activation))
    } catch (e) {
      out.push(
        `Activation could not be run: ${errorMessage(e)}`,
        `The source IS saved as inactive version; do not repeat the save. Activate later with abap_activate.`
      )
    }
  } else out.push("The object is saved but inactive. Call abap_activate to activate it.")
  result.text = out.join("\n")
  return result
}
