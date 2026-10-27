import type { classIncludes, Revision, SyntaxCheckResult } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { label, resolveObject, type ResolvedObject } from "../objects.js"
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
  const more = end < lines.length ? `\n... ${plural(lines.length - end, "more line")}: continue with startLine=${end + 1}` : ""
  return { source, version, totalLines: lines.length, text: `${header}\n${body}${more}` }
}

/** Line range of METHOD name ... ENDMETHOD in a class source, 1-based; undefined when absent. */
export function findMethod(source: string, method: string): { start: number; end: number } | undefined {
  const lines = source.split(/\r?\n/)
  const name = method.trim().toLowerCase()
  const opens = (l: string) => {
    const m = l.match(/^\s*method\s+([\w~\/]+)(?=[\s.])/i)
    return !!m && m[1].toLowerCase() === name
  }
  const start = lines.findIndex(opens)
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && /^\s*endmethod\s*\./i.test(l))
  return { start: start + 1, end: end < 0 ? lines.length : end + 1 }
}

/** Reads one method implementation of a class include, with its line numbers in the include. */
export async function readMethod(system: AbapSystem, obj: ResolvedObject, method: string, options: ReadOptions = {}): Promise<string> {
  if (!obj.isClass) throw new Error(`${label(obj)} is not a class: the method parameter only applies to classes`)
  const full = await readSource(system, obj, { version: options.version })
  const range = findMethod(full.source, method)
  if (!range) {
    const names = [...full.source.matchAll(/^\s*method\s+([\w~\/]+)/gim)].map(m => m[1])
    throw new Error(`No METHOD ${method} in ${label(obj)} [${full.version}]. Implemented methods: ${names.join(", ") || "(none)"}`)
  }
  const r = await readSource(system, obj, { ...options, version: full.version, startLine: range.start, endLine: range.end, lineNumbers: options.lineNumbers ?? true })
  return r.text.replace(/\n\.\.\. \d+ more lines?: continue with startLine=\d+$/, "")
}

/** Object types whose definition is an XML document that can be written back (no ABAP source). */
export const XML_DEFINITION_TYPES = ["DOMA/DD", "DTEL/DE"]

/** Removes read-only parts of an ADT document before it is sent back. */
export const stripReadOnlyParts = (xml: string) => xml.replace(/\s*<atom:link\b[^>]*?(\/>|>[\s\S]*?<\/atom:link>)/g, "")

/** Saves the XML definition of a domain or data element (as returned by abap_read_source). */
async function writeDefinition(system: AbapSystem, obj: ResolvedObject, xml: string, requested?: string) {
  const doc = stripReadOnlyParts(xml.replace(/^\uFEFF/, "").trim())
  const root = doc.match(/<(?!\?)[\w:]+\b[^>]*>/)?.[0] ?? ""
  const name = root.match(/adtcore:name="([^"]*)"/)?.[1]
  if (!name) throw new Error(`The XML has no adtcore:name on its root element: pass the complete document as read with abap_read_source`)
  if (name.toUpperCase() !== obj.name.toUpperCase()) throw new Error(`The XML describes ${name}, not ${obj.name}; nothing was saved`)
  // send the document in the format SAP returned it in
  const current = await system.reader.httpClient.request(obj.objectUrl, { headers: { Accept: "application/*" } })
  const contentType = `${current.headers?.["content-type"] ?? "application/xml"}`.split(";")[0].trim()
  return system.withLock(obj.lockUrl, async (lock, client) => {
    const choice = await transportForLockedObject(client, obj, lock, requested)
    const qs: Record<string, string> = { lockHandle: lock.LOCK_HANDLE }
    if (choice.transport) qs.corrNr = choice.transport
    await client.httpClient.request(obj.objectUrl, { method: "PUT", body: doc, qs, headers: { "Content-Type": contentType, Accept: contentType } })
    return choice
  })
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
  const definition = !obj.hasSource && XML_DEFINITION_TYPES.includes(obj.type)
  if (!obj.hasSource && !definition)
    throw new Error(`${label(obj)} has no ABAP source that can be written with this tool (XML definitions can be written for ${XML_DEFINITION_TYPES.join(", ")})`)
  const normalized = source.replace(/\r\n/g, "\n")
  const { transport, note } = definition
    ? await writeDefinition(system, obj, normalized, options.transport)
    : await system.withLock(obj.lockUrl, async (lock, client) => {
        const choice = await transportForLockedObject(client, obj, lock, options.transport)
        await client.setObjectSource(obj.sourceUrl, normalized, lock.LOCK_HANDLE, choice.transport)
        return choice
      })
  // from here on the source is saved: later failures must not hide that
  const out: string[] = [`Saved ${label(obj)} (inactive version)${transport ? ` in transport ${transport}` : ""}${note ? ` - ${note}` : ""}.`]
  out.push(...system.takeUnlockProblems())
  const result: WriteResult = { transport, transportNote: note, text: "" }
  if (options.checkSyntax !== false && !definition) {
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

/**
 * Creates the local test class include of a class (abap_create_object creates classes without
 * one), recorded in the class's transport, and returns the class resolved to that include.
 */
export async function createTestInclude(system: AbapSystem, cls: ResolvedObject, requested?: string): Promise<{ obj: ResolvedObject; transport: string }> {
  system.assertWritable("creating the test class include")
  if (!cls.isClass) throw new Error(`${label(cls)} is not a class`)
  const { transport } = await system.withLock(cls.lockUrl, async (lock, client) => {
    const choice = await transportForLockedObject(client, cls, lock, requested)
    await client.createTestInclude(cls.name, lock.LOCK_HANDLE, choice.transport)
    return choice
  })
  const obj = await resolveObject(system, { uri: cls.objectUrl, include: "testclasses" })
  return { obj, transport }
}
