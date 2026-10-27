import type { ADTClient, AdtLock, TransportInfo, TransportRequest, TransportTask } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { packageOf, type ResolvedObject } from "../objects.js"
import { line, plural } from "../format.js"

export class TransportRequiredError extends Error {}

/** Modifiable requests SAP proposes for the object's package; they may belong to other users. */
export function candidates(info: TransportInfo, user?: string): string {
  const list = info.TRANSPORTS ?? []
  if (!list.length) return "  (SAP proposes no modifiable transport request for this package)"
  const mine = (owner?: string) => !!user && owner?.toUpperCase() === user.toUpperCase()
  return list.map(t => `  - ${t.TRKORR}  ${t.AS4TEXT ?? ""}  (owner ${t.AS4USER}${mine(t.AS4USER) ? ", yours" : ""}, status ${t.TRSTATUS})`).join("\n")
}

/**
 * Decides which transport request to use for a write on a locked object, following the
 * VS Code extension: local objects need none, an object already recorded in a request must
 * use that request, otherwise the caller has to supply one (or create one).
 */
export async function transportForLockedObject(
  client: ADTClient,
  obj: Pick<ResolvedObject, "sourceUrl" | "type" | "name">,
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
      `Nothing was saved. Pass the transport parameter with one of the modifiable requests SAP proposes, or create one with abap_create_transport:\n` +
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
  const header = info.LOCKS?.HEADER
  if (header?.TRKORR) {
    const tasks = info.LOCKS?.TASKS ?? []
    const owner = header.AS4USER ? `, owner ${header.AS4USER}` : ""
    out.push(
      `Currently locked in transport ${header.TRKORR} (${header.AS4TEXT ?? ""}${owner})` +
        (tasks.length ? `, tasks: ${tasks.map(t => `${t.TRKORR}${t.AS4USER ? ` (${t.AS4USER})` : ""}`).join(", ")}` : "")
    )
    const myTask = tasks.find(t => t.AS4USER?.toUpperCase() === system.user)
    if (myTask) out.push(`Changes you save are recorded in your task ${myTask.TRKORR}.`)
    else
      out.push(
        `Changes must go to ${header.TRKORR}: pass it as the transport parameter. Saving records them in ${system.user}'s task of that request (SAP creates the task if there is none yet).`
      )
  } else if (info.TRANSPORTS?.length)
    out.push(`Modifiable transport requests SAP proposes for this package (pass one as the transport parameter):\n` + candidates(info, system.user))
  else if (info.DLVUNIT !== "LOCAL")
    out.push("SAP proposes no modifiable transport request for this package: create one with abap_create_transport.")
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

/** Lists the modifiable workbench and customizing requests of a user. */
export async function listTransports(system: AbapSystem, user?: string, withObjects = false): Promise<string> {
  const who = (user?.trim() || system.user).toUpperCase()
  if (/[*?%+]/.test(who))
    throw new Error(
      `user must be one SAP user name; ADT does not support wildcards ("${who}"). To see a request of another owner, read it by number with abap_read_transport; to find the request an object is recorded in, use abap_transport_info.`
    )
  const all =await system.reader.userTransports(who, true)
  const out: string[] = []
  for (const [kind, targets] of [
    ["Workbench", all.workbench],
    ["Customizing", all.customizing]
  ] as const) {
    for (const target of targets ?? []) {
      if (!target.modifiable?.length) continue
      out.push(`${kind} requests, target ${target["tm:name"]} ${target["tm:desc"] ?? ""}`.trim())
      for (const r of target.modifiable) out.push(formatRequest(r, withObjects))
    }
  }
  if (!out.length)
    return (
      `${who} has no modifiable transport requests (ADT lists the requests ${who} owns or has a task in). ` +
      `A request of another owner can be used when it is passed explicitly: check it with abap_transport_info, or list that owner's requests with the user parameter.`
    )
  return `Modifiable transport requests of ${who} (own requests and requests with a task of ${who}):\n${out.join("\n")}`
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
  const number = await system.exclusive(() => system.retryOnCsrf(() => system.client.createTransport(ref, description, devclass)))
  if (!number) throw new Error("SAP did not return a transport number")
  return number
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

/** Attributes of one start tag, keyed without namespace prefix. */
function tagAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w-]+):([\w-]+)="([^"]*)"/g)) out[m[2]] = decodeXml(m[3])
  return out
}

const startTags = (xml: string, element: string) => [...xml.matchAll(new RegExp(`<tm:${element}\\b[^>]*>`, "g"))].map(m => tagAttributes(m[0]))

export interface TransportObject {
  pgmid: string
  type: string
  name: string
  info?: string
  description?: string
}

export interface TransportDetails {
  number: string
  owner: string
  description: string
  type: string
  status: string
  target?: string
  parent?: string
  changedAt?: string
  tasks: { number: string; owner: string; description: string; status: string; objects: TransportObject[] }[]
  objects: TransportObject[]
}

const toObject = (a: Record<string, string>): TransportObject => ({
  pgmid: a.pgmid,
  type: a.type,
  name: a.name,
  info: a.obj_info || undefined,
  description: a.obj_desc || undefined
})

/** Parses the transport organizer document of a request or task. */
export function parseTransport(xml: string): TransportDetails {
  const requestTag = startTags(xml, "request")[0]
  const tasks = [...xml.matchAll(/<tm:task\b[^>]*>[\s\S]*?<\/tm:task>|<tm:task\b[^>]*\/>/g)].map(m => {
    const a = tagAttributes(m[0].match(/^<tm:task\b[^>]*>/)![0])
    return {
      number: a.number,
      owner: a.owner,
      description: a.desc ?? "",
      status: a.status_text || a.status,
      objects: startTags(m[0], "abap_object").map(toObject)
    }
  })
  const head = requestTag ?? (tasks[0] ? startTags(xml, "task")[0] : undefined)
  if (!head?.number) throw new Error("SAP returned no transport request in the answer")
  const all = xml.match(/<tm:all_objects\b[\s\S]*?<\/tm:all_objects>/)?.[0]
  let objects = all ? startTags(all, "abap_object").map(toObject) : []
  if (!objects.length) {
    const seen = new Set<string>()
    objects = tasks.flatMap(t => t.objects).filter(o => !seen.has(`${o.pgmid} ${o.type} ${o.name}`) && !!seen.add(`${o.pgmid} ${o.type} ${o.name}`))
  }
  const stamp = head.lastchanged_timestamp?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  return {
    number: head.number,
    owner: head.owner,
    description: head.desc ?? "",
    type: head.type,
    status: head.status_text || head.status,
    target: head.target || undefined,
    parent: head.parent || undefined,
    changedAt: stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]} ${stamp[4]}:${stamp[5]}:${stamp[6]}` : undefined,
    tasks: requestTag ? tasks : tasks.slice(1),
    objects
  }
}

const REQUEST_TYPES: Record<string, string> = { K: "workbench request", W: "customizing request", T: "transport of copies", S: "development/correction", R: "repair", C: "relocation" }

const formatObject = (o: TransportObject) => line([`  ${o.pgmid} ${o.type} ${o.name}`, o.info && `(${o.info})`, o.description])

/** Reads a transport request or task by number, including tasks and objects of other users. */
export async function readTransport(system: AbapSystem, number: string, withObjects = true): Promise<string> {
  const nr = number.trim().toUpperCase()
  if (!/^[A-Z0-9]{3}K\d{6}$/.test(nr)) throw new Error(`"${number}" is not a transport request number (e.g. DEVK900123)`)
  const resp = await system.reader.httpClient.request(`/sap/bc/adt/cts/transportrequests/${nr}`, {
    headers: { Accept: "application/vnd.sap.adt.transportorganizer.v1+xml" }
  })
  const t = parseTransport(String(resp.body ?? ""))
  const out: string[] = []
  // SAP answers a task number with the document of its request
  if (t.number !== nr && t.tasks.some(task => task.number === nr)) out.push(`${nr} is a task of request ${t.number}.`)
  out.push(
    `${t.parent ? "Task" : "Request"} ${t.number}  ${t.description}`,
    line([
      REQUEST_TYPES[t.type] ?? t.type,
      `owner ${t.owner}`,
      `status ${t.status}`,
      t.target && `target ${t.target}`,
      t.parent && `request ${t.parent}`,
      t.changedAt && `last changed ${t.changedAt}`
    ])
  )
  if (t.tasks.length) {
    out.push(`Tasks (${t.tasks.length}):`)
    for (const task of t.tasks) out.push(line([`  ${task.number}`, `owner ${task.owner}`, task.status, plural(task.objects.length, "object")]))
  }
  out.push(t.objects.length ? `Objects (${t.objects.length}):` : "No objects recorded.")
  if (withObjects) out.push(...t.objects.map(formatObject))
  return out.join("\n")
}
