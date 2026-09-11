import { CreatableTypes, objectPath } from "abap-adt-api"
import type { CreatableTypeIds, NewObjectOptions, ValidateOptions } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { normalizeType } from "../objects.js"
import { TransportRequiredError } from "./transports.js"

export interface CreateOptions {
  type: string
  name: string
  description: string
  package: string
  /** Function group for FUGR/FF and FUGR/I */
  parent?: string
  transport?: string
}

export function supportedCreateTypes(): string {
  return [...CreatableTypes.values()].map(t => `${t.typeId} (${t.label})`).join(", ")
}

/** Creates a new repository object (empty skeleton); write its source afterwards. */
export async function createObject(system: AbapSystem, o: CreateOptions): Promise<{ uri: string; transport: string; text: string }> {
  system.assertWritable("creating objects")
  const { full } = normalizeType(o.type)
  if (!full || !CreatableTypes.has(full as CreatableTypeIds))
    throw new Error(`Cannot create objects of type ${o.type}. Supported: ${supportedCreateTypes()}`)
  const objtype = full as CreatableTypeIds
  if (objtype === "DEVC/K") throw new Error("Creating packages is not supported by this tool")
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

  const info = await system.reader.transportInfo(uri, pkg, "I")
  let transport = o.transport?.trim().toUpperCase() || ""
  if (info.DLVUNIT === "LOCAL") transport = ""
  else if (info.LOCKS?.HEADER?.TRKORR) transport = info.LOCKS.HEADER.TRKORR
  else if (!transport)
    throw new TransportRequiredError(
      `Package ${pkg} is transportable: pass the transport parameter or create a request with abap_create_transport (package: ${pkg}). Your modifiable requests:\n` +
        (info.TRANSPORTS?.map(t => `  - ${t.TRKORR}  ${t.AS4TEXT ?? ""}`).join("\n") || "  (none)")
    )

  const options: NewObjectOptions = { objtype, name, parentName, description: o.description, parentPath, transport, responsible: system.user }
  await system.exclusive(() => system.client.createObject(options))
  const text = `Created ${objtype} ${name} in package ${pkg}${transport ? ` (transport ${transport})` : ""}.\nURI: ${uri}\nThe object is an empty, inactive skeleton: read it with abap_read_source, then write the full source with abap_write_source and activate.`
  return { uri, transport, text }
}
