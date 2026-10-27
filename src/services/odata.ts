import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { AbapSystem } from "../connection.js"
import { truncate } from "../format.js"

const ODATA_PATH = /^\/sap\/opu\/odata4?\//i

/**
 * Turns a service URL or path into the $metadata path on the system's host. Only Gateway
 * OData services (/sap/opu/odata/..., /sap/opu/odata4/...) are accepted.
 */
export function metadataPath(system: AbapSystem, service: string): string {
  let path = service.trim()
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path)
    const host = new URL(system.config.url).host
    if (url.host.toLowerCase() !== host.toLowerCase())
      throw new Error(`${service} is not on the host of system ${system.name} (${host})`)
    path = url.pathname
  }
  path = path.replace(/[?#].*$/, "")
  if (!path.startsWith("/")) path = `/${path}`
  if (!ODATA_PATH.test(path))
    throw new Error(`"${service}" is not an OData service path: expected /sap/opu/odata/<namespace>/<SERVICE> or /sap/opu/odata4/<group>/<service>/<binding>/<version>/`)
  path = path.replace(/\/?\$metadata$/i, "").replace(/\/+$/, "")
  return `${path}/$metadata`
}

const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

/** Elements named `name` in `xml` with their attributes and inner XML. */
function elements(xml: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, "g")
  return [...xml.matchAll(re)].map(m => ({ attrs: attributes(m[1]), inner: m[2] ?? "" }))
}

const shortType = (t?: string) => (t ?? "").replace(/^Collection\((.*)\)$/, "[$1]").replace(/^[\w.]+\.(\w+)/, "$1").replace(/\[[\w.]+\.(\w+)\]/, "[$1]")

const param = (p: Record<string, string>) => `${p.Name}: ${shortType(p.Type)}`

/** Compact overview of an EDMX document: entity types with keys and properties, sets, operations. */
export function summarizeMetadata(xml: string): string {
  const version = xml.match(/<edmx:Edmx\b[^>]*Version="([^"]+)"/)?.[1] ?? "?"
  const out: string[] = []
  for (const schema of elements(xml, "Schema")) {
    out.push(`Schema ${schema.attrs.Namespace ?? ""}${schema.attrs.Alias ? ` (alias ${schema.attrs.Alias})` : ""}`)
    for (const et of elements(schema.inner, "EntityType")) {
      const keys = elements(et.inner, "PropertyRef").map(k => k.attrs.Name)
      const props = elements(et.inner, "Property").map(p => {
        const len = p.attrs.MaxLength ? `(${p.attrs.MaxLength})` : ""
        return `${p.attrs.Name}: ${shortType(p.attrs.Type)}${len}${keys.includes(p.attrs.Name) ? " key" : ""}`
      })
      const navs = elements(et.inner, "NavigationProperty").map(n => `${n.attrs.Name}${n.attrs.Type ? ` -> ${shortType(n.attrs.Type)}` : ""}`)
      out.push(`  EntityType ${et.attrs.Name}  keys: ${keys.join(", ") || "-"}`)
      out.push(`    properties: ${props.join(", ")}`)
      if (navs.length) out.push(`    navigation: ${navs.join(", ")}`)
    }
    for (const ct of elements(schema.inner, "ComplexType"))
      out.push(`  ComplexType ${ct.attrs.Name}: ${elements(ct.inner, "Property").map(p => param(p.attrs)).join(", ")}`)
    for (const kind of ["Action", "Function"]) {
      for (const op of elements(schema.inner, kind)) {
        const params = elements(op.inner, "Parameter").map(p => param(p.attrs))
        const ret = elements(op.inner, "ReturnType")[0]?.attrs.Type
        out.push(`  ${kind} ${op.attrs.Name}(${params.join(", ")})${ret ? ` -> ${shortType(ret)}` : ""}${op.attrs.IsBound === "true" ? "  [bound]" : ""}`)
      }
    }
    for (const container of elements(schema.inner, "EntityContainer")) {
      const sets = elements(container.inner, "EntitySet").map(s => `${s.attrs.Name} (${shortType(s.attrs.EntityType)})`)
      if (sets.length) out.push(`  EntitySets: ${sets.join(", ")}`)
      for (const fi of elements(container.inner, "FunctionImport")) {
        const params = elements(fi.inner, "Parameter").map(p => param(p.attrs))
        const method = fi.attrs["m:HttpMethod"] ? ` ${fi.attrs["m:HttpMethod"]}` : ""
        out.push(`  FunctionImport ${fi.attrs.Name}${method}(${params.join(", ")})${fi.attrs.ReturnType ? ` -> ${shortType(fi.attrs.ReturnType)}` : ""}`)
      }
    }
  }
  return `OData metadata, EDMX version ${version}\n${out.join("\n")}`
}

export interface MetadataOptions {
  service: string
  saveTo?: string
  format?: "summary" | "xml"
}

/** Fetches the $metadata document of a Gateway OData service with the system's logon. */
export async function odataMetadata(system: AbapSystem, o: MetadataOptions): Promise<string> {
  const path = metadataPath(system, o.service)
  let body: string
  try {
    // name the configured client instead of relying on the session cookies to select it
    const qs = system.config.client ? { "sap-client": system.config.client } : {}
    const resp = await system.reader.httpClient.request(path, { headers: { Accept: "application/xml" }, qs })
    body = String(resp.body ?? "")
  } catch (e) {
    const status = (e as { err?: number }).err ?? (e as { status?: number }).status
    if (status === 404 || status === 403)
      throw new Error(
        `HTTP ${status} for ${path}: the service is not published in this system or the path is wrong. ` +
          `OData V4 services are published as service groups (/IWFND/V4_ADMIN), V2 services in /IWFND/MAINT_SERVICE; ` +
          `the service binding (abap_read_source on the SRVB) shows whether it is published.`
      )
    throw e
  }
  if (!/<edmx:Edmx\b/.test(body)) throw new Error(`${path} did not return an EDMX document: ${truncate(body.replace(/\s+/g, " "), 300)}`)
  const saved = o.saveTo?.trim() ? resolve(o.saveTo.trim()) : undefined
  if (saved) {
    mkdirSync(dirname(saved), { recursive: true })
    writeFileSync(saved, body)
  }
  const note = saved ? `\nSaved the complete $metadata (${Math.round(body.length / 1024)} KB) to ${saved}.` : ""
  if (o.format === "xml") return truncate(body, 60000) + note
  return truncate(`${system.name} ${path}\n${summarizeMetadata(body)}`, 60000) + note
}
