import { CreatableTypes, objectPath } from "abap-adt-api"
import type { CreatableTypeIds, NewObjectOptions, PackageTypes, ValidateOptions } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { normalizeType } from "../objects.js"
import { candidates, TransportRequiredError } from "./transports.js"

export interface CreateOptions {
  type: string
  name: string
  description: string
  /** Target package; for DEVC/K the super package of the new package */
  package: string
  /** Function group for FUGR/FF and FUGR/I */
  parent?: string
  transport?: string
  /** DEVC/K only: software component, default the super package's */
  softwareComponent?: string
  /** DEVC/K only: transport layer, default the super package's */
  transportLayer?: string
  /** DEVC/K only: development (default), structure or main */
  packageType?: PackageTypes
}

export interface CreateResult {
  uri: string
  transport: string
  text: string
}

export function supportedCreateTypes(): string {
  return [...CreatableTypes.values()].map(t => `${t.typeId} (${t.label})`).join(", ")
}

/** Decides the transport request of a new object in `pkg`, like the ADT creation wizard. */
async function transportForNew(system: AbapSystem, uri: string, pkg: string, requested?: string): Promise<string> {
  const info = await system.reader.transportInfo(uri, pkg, "I")
  if (info.DLVUNIT === "LOCAL") return ""
  if (info.LOCKS?.HEADER?.TRKORR) return info.LOCKS.HEADER.TRKORR
  const transport = requested?.trim().toUpperCase() || ""
  if (!transport)
    throw new TransportRequiredError(
      `Package ${pkg} is transportable: pass the transport parameter or create a request with abap_create_transport (package: ${pkg}). Modifiable requests SAP proposes:\n` +
        candidates(info, system.user)
    )
  return transport
}

/** Creates a new repository object (empty skeleton); write its source afterwards. */
export async function createObject(system: AbapSystem, o: CreateOptions): Promise<CreateResult> {
  system.assertWritable("creating objects")
  const { full } = normalizeType(o.type)
  if (!full || !CreatableTypes.has(full as CreatableTypeIds))
    throw new Error(`Cannot create objects of type ${o.type}. Supported: ${supportedCreateTypes()}`)
  const objtype = full as CreatableTypeIds
  if (objtype === "DEVC/K") return createPackage(system, o)
  const name = o.name.trim().toUpperCase()
  const pkg = o.package.trim().toUpperCase()
  if (!name || !pkg) throw new Error("name and package are required")
  const needsGroup = objtype === "FUGR/FF" || objtype === "FUGR/I"
  const parentName = needsGroup ? (o.parent ?? "").trim().toUpperCase() : pkg
  if (needsGroup && !parentName) throw new Error(`${objtype} requires the parent function group`)
  const parentPath = needsGroup
    ? `/sap/bc/adt/functions/groups/${encodeURIComponent(parentName.toLowerCase())}`
    : `/sap/bc/adt/packages/${encodeURIComponent(pkg.toLowerCase())}`
  const uri = objectPath(objtype, name, parentName)

  const validation = (
    needsGroup
      ? { objtype, objname: name, fugrname: parentName, description: o.description }
      : { objtype, objname: name, packagename: pkg, description: o.description }
  ) as ValidateOptions
  await system.reader.validateNewObject(validation)

  const transport = await transportForNew(system, uri, pkg, o.transport)
  const options: NewObjectOptions = { objtype, name, parentName, description: o.description, parentPath, transport, responsible: system.user }
  await system.exclusive(() => system.retryOnCsrf(() => system.client.createObject(options)))
  const text = `Created ${objtype} ${name} in package ${pkg}${transport ? ` (transport ${transport})` : ""}.\nURI: ${uri}\nThe object is an empty, inactive skeleton: read it with abap_read_source, then write the full source with abap_write_source and activate.`
  return { uri, transport, text }
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const attr = (xml: string, element: string, attribute: string) =>
  xml.match(new RegExp(`<${element}\\b[^>]*\\b${attribute}="([^"]*)"`))?.[1]

/** Software component and transport layer of an existing package. */
export async function packageTransportSettings(system: AbapSystem, pkg: string): Promise<{ softwareComponent?: string; transportLayer?: string }> {
  const resp = await system.reader.httpClient.request(`/sap/bc/adt/packages/${encodeURIComponent(pkg.toLowerCase())}`, {
    headers: { Accept: "application/vnd.sap.adt.packages.v1+xml, application/xml" }
  })
  const xml = String(resp.body ?? "")
  return {
    softwareComponent: attr(xml, "pak:softwareComponent", "pak:name") || undefined,
    transportLayer: attr(xml, "pak:transportLayer", "pak:name") || undefined
  }
}

/** XML of a new package; abap-adt-api's own template carries a fixed package reference. */
export function packageXml(p: {
  name: string
  description: string
  superPackage: string
  responsible: string
  packageType: PackageTypes
  softwareComponent: string
  transportLayer: string
}): string {
  const a = (v: string) => xmlEscape(v)
  return `<?xml version="1.0" encoding="UTF-8"?>
<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${a(p.description)}" adtcore:name="${a(p.name)}" adtcore:type="DEVC/K" adtcore:version="active" adtcore:responsible="${a(p.responsible)}">
  <adtcore:packageRef adtcore:name="${a(p.name)}"/>
  <pak:attributes pak:packageType="${a(p.packageType)}"/>
  <pak:superPackage${p.superPackage ? ` adtcore:name="${a(p.superPackage)}"` : ""}/>
  <pak:applicationComponent/>
  <pak:transport>
    <pak:softwareComponent pak:name="${a(p.softwareComponent)}"/>
    <pak:transportLayer pak:name="${a(p.transportLayer)}"/>
  </pak:transport>
  <pak:translation/>
  <pak:useAccesses/>
  <pak:packageInterfaces/>
  <pak:subPackages/>
</pak:package>`
}

/**
 * Creates a package below `o.package` (the super package). Software component and transport
 * layer default to the super package's, as in the ADT wizard; local ($) packages use LOCAL.
 */
async function createPackage(system: AbapSystem, o: CreateOptions): Promise<CreateResult> {
  const name = o.name.trim().toUpperCase()
  const superPackage = o.package.trim().toUpperCase()
  if (!name) throw new Error("name is required")
  const local = name.startsWith("$")
  if (!superPackage && !local) throw new Error("package (the super package of the new package) is required")
  const packageType: PackageTypes = o.packageType ?? "development"
  let softwareComponent = o.softwareComponent?.trim().toUpperCase()
  let transportLayer = o.transportLayer?.trim().toUpperCase()
  if (local) {
    softwareComponent = softwareComponent || "LOCAL"
    transportLayer = transportLayer ?? ""
  } else if (!softwareComponent || transportLayer === undefined) {
    const inherited = await packageTransportSettings(system, superPackage)
    softwareComponent = softwareComponent || inherited.softwareComponent
    transportLayer = transportLayer ?? inherited.transportLayer ?? ""
  }
  if (!softwareComponent)
    throw new Error(`The software component of super package ${superPackage} could not be read: pass softwareComponent (e.g. HOME)`)

  await system.reader.validateNewObject({
    objtype: "DEVC/K",
    objname: name,
    description: o.description,
    packagename: superPackage,
    swcomp: softwareComponent,
    transportLayer,
    packagetype: packageType
  })

  const uri = `/sap/bc/adt/packages/${encodeURIComponent(name.toLowerCase())}`
  const transport = local ? "" : await transportForNew(system, uri, superPackage, o.transport)
  const body = packageXml({ name, description: o.description, superPackage, responsible: system.user, packageType, softwareComponent, transportLayer })
  await system.exclusive(() =>
    system.retryOnCsrf(() => system.client.httpClient.request("/sap/bc/adt/packages", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/vnd.sap.adt.packages.v1+xml", Accept: "application/vnd.sap.adt.packages.v1+xml, application/xml" },
      qs: transport ? { corrNr: transport } : {}
    }))
  )
  const text =
    `Created package ${name}${superPackage ? ` in super package ${superPackage}` : ""} (${packageType}, software component ${softwareComponent}` +
    `${transportLayer ? `, transport layer ${transportLayer}` : ""})${transport ? `, transport ${transport}` : ""}.\nURI: ${uri}`
  return { uri, transport, text }
}
