import { ADTClient, isClassStructure } from "abap-adt-api"
import type { AbapObjectStructure, SearchResult } from "abap-adt-api"
import type { AbapSystem } from "./connection.js"

export const CLASS_INCLUDES = ["main", "definitions", "implementations", "macros", "testclasses"] as const
export type ClassInclude = (typeof CLASS_INCLUDES)[number]

/** How a tool call identifies an object. */
export interface ObjectSpec {
  name?: string
  type?: string
  uri?: string
  include?: ClassInclude
}

export interface ResolvedObject {
  type: string
  name: string
  description?: string
  package?: string
  /** Metadata URL, e.g. /sap/bc/adt/oo/classes/zcl_foo */
  objectUrl: string
  /** URL used to read and write the source (or XML for objects without ABAP source). */
  sourceUrl: string
  /** URL of the object that has to be locked (the class for class includes). */
  lockUrl: string
  /** Name of the object that is locked / activated. */
  lockName: string
  /** Class include addressed by sourceUrl, for classes only. */
  include?: ClassInclude
  /** Context main program, for includes. */
  mainProgram?: string
  /** "active" or "inactive" of the addressed source. */
  version?: string
  changedBy?: string
  changedAt?: string
  createdBy?: string
  hasSource: boolean
  isClass: boolean
  includes?: { type: string; url: string; version?: string }[]
  structure: AbapObjectStructure
}

export class ObjectNotFoundError extends Error {}
export class AmbiguousObjectError extends Error {}

const INCLUDE_SUFFIX = /\/includes\/(definitions|implementations|macros|testclasses|main)$/i
const SOURCE_SUFFIX = /\/source\/main$/i

/** Strips query/fragment and source suffixes from an ADT URI, detecting class includes. */
export function splitUri(uri: string, include?: ClassInclude): { objectUrl: string; include?: ClassInclude } {
  let objectUrl = uri.trim().replace(/[?#].*$/, "").replace(/\/+$/, "")
  const isClass = /\/oo\/classes\//i.test(objectUrl)
  const inc = objectUrl.match(INCLUDE_SUFFIX)
  if (isClass && inc) {
    objectUrl = objectUrl.replace(INCLUDE_SUFFIX, "")
    include = include ?? (inc[1].toLowerCase() as ClassInclude)
  } else if (SOURCE_SUFFIX.test(objectUrl)) {
    objectUrl = objectUrl.replace(SOURCE_SUFFIX, "")
    if (isClass) include = include ?? "main"
  }
  if (!/^\/sap\/bc\/adt\//i.test(objectUrl))
    throw new ObjectNotFoundError(`"${uri}" is not an ADT object URI (expected /sap/bc/adt/...)`)
  return { objectUrl, include }
}

/** Normalises user supplied types: "clas", "CLAS", "CLAS/OC" -> { full: "CLAS/OC"?, short: "CLAS" } */
export function normalizeType(type?: string): { full?: string; short?: string } {
  const t = type?.trim().toUpperCase()
  if (!t) return {}
  const short = t.split("/")[0]
  const aliases: Record<string, string> = {
    CLASS: "CLAS/OC",
    CLAS: "CLAS/OC",
    INTERFACE: "INTF/OI",
    INTF: "INTF/OI",
    PROGRAM: "PROG/P",
    REPORT: "PROG/P",
    PROG: "PROG/P",
    INCLUDE: "PROG/I",
    FUNCTION: "FUGR/FF",
    FUNC: "FUGR/FF",
    FM: "FUGR/FF",
    FUGR: "FUGR/F",
    CDS: "DDLS/DF",
    DDLS: "DDLS/DF",
    TABLE: "TABL/DT",
    TABL: "TABL/DT",
    STRUCTURE: "TABL/DS",
    PACKAGE: "DEVC/K",
    DEVC: "DEVC/K",
    DTEL: "DTEL/DE",
    DOMA: "DOMA/DD",
    TTYP: "TTYP/DA",
    MSAG: "MSAG/N"
  }
  const full = t.includes("/") ? t : aliases[t]
  return { full, short: full ? full.split("/")[0] : short }
}

const describe = (r: SearchResult) =>
  `${r["adtcore:type"]} ${r["adtcore:name"]}${r["adtcore:description"] ? ` (${r["adtcore:description"]})` : ""} ${r["adtcore:uri"]}`

async function searchExact(system: AbapSystem, name: string, type?: string): Promise<SearchResult[]> {
  const { full, short } = normalizeType(type)
  const searchType = short === "FUGR" && full === "FUGR/FF" ? "FUNC" : short
  const matches = (results: SearchResult[]) =>
    results.filter(r => {
      if (`${r["adtcore:name"]}`.toUpperCase() !== name) return false
      if (!type) return true
      const rt = r["adtcore:type"].toUpperCase()
      return full ? rt === full : rt.split("/")[0] === short
    })
  const tryQuery = async (q: string, t?: string) => {
    try {
      return matches(await system.reader.searchObject(q, t, 100))
    } catch {
      return []
    }
  }
  let hits = await tryQuery(name, searchType)
  if (!hits.length) hits = await tryQuery(`${name}*`, searchType)
  if (!hits.length && searchType) hits = await tryQuery(`${name}*`)
  return hits
}

function timestamp(ms: unknown): string | undefined {
  const n = typeof ms === "number" ? ms : Number(ms)
  return n > 0 ? new Date(n).toISOString() : undefined
}

/** Resolves a name or URI to the URLs needed to read, write, lock and activate an object. */
export async function resolveObject(system: AbapSystem, spec: ObjectSpec): Promise<ResolvedObject> {
  let objectUrl: string
  let include = spec.include
  let hit: SearchResult | undefined
  if (spec.uri?.trim()) {
    ;({ objectUrl, include } = splitUri(spec.uri, include))
  } else if (spec.name?.trim()) {
    const name = spec.name.trim().toUpperCase()
    const hits = await searchExact(system, name, spec.type)
    if (!hits.length)
      throw new ObjectNotFoundError(
        `No object named ${name}${spec.type ? ` of type ${spec.type}` : ""} found in ${system.name}. Use abap_search_objects with a wildcard (e.g. ${name}*) to look for candidates.`
      )
    const distinct = new Map(hits.map(h => [`${h["adtcore:type"]}|${h["adtcore:uri"]}`, h]))
    if (distinct.size > 1)
      throw new AmbiguousObjectError(
        `Several objects are named ${name}. Pass the type or uri parameter:\n` +
          [...distinct.values()].map(h => `  - ${describe(h)}`).join("\n")
      )
    hit = hits[0]
    objectUrl = hit["adtcore:uri"].replace(/[?#].*$/, "")
    if (/\/oo\/classes\//i.test(objectUrl)) {
      ;({ objectUrl, include } = splitUri(objectUrl, include))
    }
  } else throw new ObjectNotFoundError("Specify an object name or an ADT uri")

  const structure = await system.reader.objectStructure(objectUrl)
  const meta = structure.metaData
  const type = `${meta["adtcore:type"] || hit?.["adtcore:type"] || spec.type || ""}`
  const name = `${meta["adtcore:name"] || hit?.["adtcore:name"] || spec.name || ""}`
  const isClass = isClassStructure(structure)

  let sourceUrl: string
  let version: string | undefined = meta["adtcore:version"]
  let includes: ResolvedObject["includes"]
  if (isClass) {
    const map = ADTClient.classIncludes(structure)
    includes = structure.includes.map(i => ({
      type: i["class:includeType"],
      url: map.get(i["class:includeType"]) || "",
      version: i["adtcore:version"]
    }))
    include = include ?? "main"
    const url = map.get(include)
    if (!url)
      throw new ObjectNotFoundError(
        `Class ${name} has no ${include} include. Available: ${[...map.keys()].join(", ")}`
      )
    sourceUrl = url
    version = includes.find(i => i.type === include)?.version ?? version
  } else {
    if (include && include !== "main")
      throw new ObjectNotFoundError(`${type} ${name} is not a class: the include parameter only applies to classes`)
    include = undefined
    sourceUrl = ADTClient.mainInclude(structure, false)
  }
  const hasSource = sourceUrl !== objectUrl

  let mainProgram: string | undefined
  if (type === "PROG/I" || type === "FUGR/I") {
    try {
      const mains = await system.reader.mainPrograms(objectUrl)
      mainProgram = mains[0]?.["adtcore:uri"]
    } catch {
      // includes without a main program are checked without context
    }
  }

  return {
    type,
    name,
    description: meta["adtcore:description"] ?? hit?.["adtcore:description"],
    package: hit?.["adtcore:packageName"],
    objectUrl,
    sourceUrl,
    lockUrl: objectUrl,
    lockName: name,
    include,
    mainProgram,
    version,
    changedBy: meta["adtcore:changedBy"],
    changedAt: timestamp(meta["adtcore:changedAt"]),
    createdBy: meta["adtcore:responsible"],
    hasSource,
    isClass,
    includes,
    structure
  }
}

/** Determines the package of an object, using the repository node path when the search did not tell. */
export async function packageOf(system: AbapSystem, obj: ResolvedObject): Promise<string> {
  if (obj.package) return obj.package
  try {
    const steps = await system.reader.findObjectPath(obj.objectUrl)
    const pkg = [...steps].reverse().find(s => s["adtcore:type"] === "DEVC/K")
    if (pkg) {
      obj.package = pkg["adtcore:name"]
      return obj.package
    }
  } catch {
    // fall through
  }
  return ""
}

/** Short label such as "CLAS/OC ZCL_FOO (testclasses)". */
export function label(obj: ResolvedObject): string {
  const inc = obj.include && obj.include !== "main" ? ` (${obj.include})` : ""
  return `${obj.type} ${obj.name}${inc}`
}
