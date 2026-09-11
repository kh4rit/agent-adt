import type { ADTClient, AdtLock, TransportInfo, TransportRequest, TransportTask } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { packageOf, type ResolvedObject } from "../objects.js"
import { line, plural } from "../format.js"

export class TransportRequiredError extends Error {}

function candidates(info: TransportInfo): string {
  const list = info.TRANSPORTS ?? []
  if (!list.length) return "  (no modifiable transport request of yours contains this package yet)"
  return list.map(t => `  - ${t.TRKORR}  ${t.AS4TEXT ?? ""}  (owner ${t.AS4USER}, status ${t.TRSTATUS})`).join("\n")
}

/**
 * Decides which transport request to use for a write on a locked object, following the
 * VS Code extension: local objects need none, an object already recorded in a request must
 * use that request, otherwise the caller has to supply one (or create one).
 */
export async function transportForLockedObject(
  client: ADTClient,
  obj: ResolvedObject,
  lock: AdtLock,
  requested?: string
): Promise<{ transport: string; note?: string }> {
  const wanted = requested?.trim().toUpperCase() || ""
  if (lock.IS_LOCAL) return { transport: "", note: "local object, no transport request needed" }
  const info = await client.transportInfo(obj.sourceUrl, "", "")
  const locked = info.LOCKS?.HEADER?.TRKORR || lock.CORRNR || ""
  if (info.DLVUNIT === "LOCAL" && !locked) return { transport: "", note: "local package, no transport request needed" }
  if (locked) {
    if (wanted && wanted !== locked && !info.LOCKS?.TASKS?.some(t => t.TRKORR === wanted))
      return {
        transport: locked,
        note: `object is already recorded in ${locked}; the requested transport ${wanted} was ignored`
      }
    return { transport: locked }
  }
  if (wanted) return { transport: wanted }
  throw new TransportRequiredError(
    `${obj.type} ${obj.name} is in transportable package ${info.DEVCLASS} and needs a transport request. ` +
      `Nothing was saved. Pass the transport parameter with one of your modifiable requests, or create one with abap_create_transport:\n` +
      candidates(info)
  )
}

/** Human readable transport situation of an object. */
export async function describeTransportInfo(system: AbapSystem, obj: ResolvedObject): Promise<string> {
  const pkg = await packageOf(system, obj)
  const info = await system.reader.transportInfo(obj.sourceUrl, "", "")
  const out: string[] = [`${obj.type} ${obj.name}  package ${info.DEVCLASS || pkg || "?"}  delivery unit ${info.DLVUNIT || "?"}`]
  if (info.DLVUNIT === "LOCAL") out.push("Local object: changes are saved without a transport request.")
  else out.push("Transportable object: a transport request is required for changes.")
  if (info.LOCKS?.HEADER)
    out.push(
      `Currently locked in transport ${info.LOCKS.HEADER.TRKORR} (${info.LOCKS.HEADER.AS4TEXT ?? ""})` +
        (info.LOCKS.TASKS?.length ? `, tasks: ${info.LOCKS.TASKS.map(t => t.TRKORR).join(", ")}` : "")
    )
  if (info.TRANSPORTS?.length) out.push("Your modifiable transport requests for this package:\n" + candidates(info))
  else if (info.DLVUNIT !== "LOCAL") out.push("You have no modifiable transport request for this package yet.")
  if (info.MESSAGES?.length) out.push(info.MESSAGES.map(m => `${m.SEVERITY}: ${m.TEXT}`).join("\n"))
  return out.join("\n")
}

const formatTask = (t: TransportTask, indent: string) =>
  line([`${indent}${t["tm:number"]}`, `${t["tm:desc"] ?? ""}`, `owner ${t["tm:owner"]}`, `status ${t["tm:status"]}`, t.objects?.length ? plural(t.objects.length, "object") : ""])

const formatRequest = (r: TransportRequest, withObjects: boolean): string => {
  const lines = [formatTask(r, "")]
  for (const t of r.tasks ?? []) lines.push(formatTask(t, "    task "))
  if (withObjects) {
    const objects = [...(r.objects ?? []), ...(r.tasks ?? []).flatMap(t => t.objects ?? [])]
    for (const o of objects) lines.push(`      ${o["tm:pgmid"]} ${o["tm:type"]} ${o["tm:name"]}`)
  }
  return lines.join("\n")
}

/** Lists the modifiable workbench requests of a user. */
export async function listTransports(system: AbapSystem, user?: string, withObjects = false): Promise<string> {
  const who = (user?.trim() || system.user).toUpperCase()
  const all = await system.reader.userTransports(who, true)
  const out: string[] = []
  for (const target of all.workbench) {
    if (!target.modifiable?.length) continue
    out.push(`Target ${target["tm:name"]} ${target["tm:desc"] ?? ""}`.trim())
    for (const r of target.modifiable) out.push(formatRequest(r, withObjects))
  }
  if (!out.length) return `${who} has no modifiable workbench transport requests.`
  return `Modifiable workbench transport requests of ${who}:\n${out.join("\n")}`
}

/** Creates a workbench transport request for an object or a package. */
export async function createTransportFor(
  system: AbapSystem,
  target: { obj?: ResolvedObject; pkg?: string },
  description: string
): Promise<string> {
  system.assertWritable("creating a transport request")
  let ref: string
  let devclass: string
  if (target.obj) {
    const info = await system.reader.transportInfo(target.obj.sourceUrl, "", "")
    if (info.DLVUNIT === "LOCAL")
      throw new Error(`${target.obj.type} ${target.obj.name} is local (package ${info.DEVCLASS}); local objects do not use transport requests`)
    ref = target.obj.sourceUrl
    devclass = info.DEVCLASS || (await packageOf(system, target.obj))
  } else if (target.pkg?.trim()) {
    devclass = target.pkg.trim().toUpperCase()
    ref = `/sap/bc/adt/packages/${encodeURIComponent(devclass.toLowerCase())}`
  } else throw new Error("Specify the object (name/uri) or the package the transport is for")
  const number = await system.exclusive(() => system.client.createTransport(ref, description, devclass))
  if (!number) throw new Error("SAP did not return a transport number")
  return number
}
