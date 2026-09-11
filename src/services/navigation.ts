import type { ADTClient, Node, UnitTestClass } from "abap-adt-api"

type StructureElement = Awaited<ReturnType<ADTClient["objectStructureElements"]>>[number]
import type { AbapSystem } from "../connection.js"
import { label, type ResolvedObject } from "../objects.js"
import { plural } from "../format.js"

/** Where-used list for an object or a position in its source. */
export async function findUsages(system: AbapSystem, obj: ResolvedObject, lineNo?: number, column?: number): Promise<string> {
  const url = lineNo ? obj.sourceUrl : obj.objectUrl
  const refs = await system.reader.usageReferences(url, lineNo, column ?? (lineNo ? 1 : undefined))
  const hits = refs.filter(r => r.isResult !== false || r.uri)
  if (!hits.length) return `No usages of ${label(obj)} found.`
  const lines = hits.map(r => {
    const pkg = r.packageRef?.["adtcore:name"] ? `  [${r.packageRef["adtcore:name"]}]` : ""
    const info = r.usageInformation ? `  ${r.usageInformation}` : ""
    return `- ${r["adtcore:type"] ?? ""} ${r["adtcore:name"] ?? r.objectIdentifier}${pkg}${info}  ${r.uri}`
  })
  return `${plural(hits.length, "usage")} of ${label(obj)}:\n${lines.join("\n")}`
}

/** Objects contained in a package (or a function group / program), grouped by type. */
export async function packageContents(system: AbapSystem, pkg: string): Promise<string> {
  const name = pkg.trim().toUpperCase()
  const tree = await system.reader.nodeContents("DEVC/K", name)
  const labels = new Map(tree.objectTypes.map(t => [t.OBJECT_TYPE, t.OBJECT_TYPE_LABEL]))
  const nodes = tree.nodes.filter(n => n.OBJECT_NAME && n.OBJECT_URI)
  if (!nodes.length) return `Package ${name} is empty or does not exist.`
  const groups = new Map<string, Node[]>()
  for (const n of nodes) groups.set(n.OBJECT_TYPE, [...(groups.get(n.OBJECT_TYPE) ?? []), n])
  const out: string[] = [`Package ${name}: ${plural(nodes.length, "object")}`]
  for (const [type, list] of [...groups.entries()].sort()) {
    out.push(`${type} ${labels.get(type) ?? ""}`.trim())
    for (const n of list.sort((a, b) => a.OBJECT_NAME.localeCompare(b.OBJECT_NAME)))
      out.push(`  - ${n.OBJECT_NAME}${n.DESCRIPTION ? `  ${n.DESCRIPTION}` : ""}  ${n.OBJECT_URI}`)
  }
  return out.join("\n")
}

const formatElement = (e: StructureElement, depth: number): string[] => {
  const flags = [e.visibility, e.level, e.constant ? "constant" : "", e.redefinition ? "redefinition" : "", e.testmethod ? "test" : "", e.final ? "final" : ""]
    .filter(Boolean)
    .join(" ")
  const lines = [`${"  ".repeat(depth)}- ${e.type} ${e.name}${flags ? ` (${flags})` : ""}${e.description ? `  ${e.description}` : ""}`]
  for (const c of e.children ?? []) lines.push(...formatElement(c, depth + 1))
  return lines
}

/** Components (attributes, methods, ...) of a class or interface. */
export async function outline(system: AbapSystem, obj: ResolvedObject): Promise<string> {
  const elements = await system.reader.objectStructureElements(obj.objectUrl)
  if (!elements.length) return `No outline available for ${label(obj)} (only classes and interfaces have one).`
  return `Outline of ${obj.type} ${obj.name}:\n${elements.flatMap(e => formatElement(e, 0)).join("\n")}`
}

function formatUnitClass(c: UnitTestClass): string[] {
  const lines = [`${c["adtcore:name"]}  (${c.testmethods.length} methods, risk ${c.riskLevel}, duration ${c.durationCategory})`]
  for (const a of c.alerts ?? []) lines.push(`  [${a.severity}] ${a.kind}: ${a.title}`, ...a.details.map(d => `      ${d}`))
  for (const m of c.testmethods) {
    const failed = m.alerts?.length
    lines.push(`  ${failed ? "FAIL" : "ok  "} ${m["adtcore:name"]}  (${m.executionTime}s)`)
    for (const a of m.alerts ?? []) {
      lines.push(`      [${a.severity}] ${a.kind}: ${a.title}`, ...a.details.map(d => `        ${d}`))
      const top = a.stack?.[0]
      if (top) lines.push(`        at ${top["adtcore:name"]} ${top["adtcore:uri"]}`)
    }
  }
  return lines
}

/** Runs the ABAP Unit tests of an object. */
export async function runUnitTests(system: AbapSystem, obj: ResolvedObject): Promise<string> {
  const classes = await system.reader.unitTestRun(obj.objectUrl)
  if (!classes.length) return `${label(obj)} has no unit tests (or none were executed).`
  const methods = classes.flatMap(c => c.testmethods)
  const failed = methods.filter(m => m.alerts?.length).length
  const head = `Unit tests of ${obj.type} ${obj.name}: ${methods.length - failed} passed, ${failed} failed`
  return [head, ...classes.flatMap(formatUnitClass)].join("\n")
}
