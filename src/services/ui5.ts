import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { isCsrfError } from "abap-adt-api"
import type { ADTClient, TransportInfo } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { plural } from "../format.js"
import { collectFiles, createZip, formatSize, readZip, type ZipEntry } from "../zip.js"
import { candidates, TransportRequiredError } from "./transports.js"

/**
 * Deployment of SAPUI5 / Fiori applications to the SAPUI5 ABAP repository (BSP applications).
 *
 * The requests mirror what `fiori deploy` (@sap-ux/deploy-tooling via @sap-ux/axios-extension,
 * the `deploy-to-abap` task behind `npm run deploy` in Business Application Studio) sends:
 * one OData call to /sap/opu/odata/UI5/ABAP_REPOSITORY_SRV carrying the zipped build result,
 * with TestMode / SafeMode / TransportRequest as URL parameters. Only the authentication
 * differs: the calls go through the server's ADT session (basic, SSO cookies, bearer).
 */
export const REPOSITORY_SERVICE = "/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV"
type RequestOptions = NonNullable<Parameters<ADTClient["httpClient"]["request"]>[1]>
export const FILESTORE = "/sap/bc/adt/filestore/ui5-bsp/objects"

export interface SapMessage {
  severity: string
  code?: string
  text: string
}

interface RawResponse {
  status: number
  statusText?: string
  body?: string
  headers?: Record<string, unknown>
}

export interface Archive {
  zip: Buffer
  files: number
  /** sap.app/id of the manifest, when found */
  appId?: string
  origin: string
}

export interface DeployOptions {
  name: string
  source: string
  package?: string
  transport?: string
  description?: string
  exclude?: string[]
  /** default true: SAP checks the upload and returns the log without changing anything */
  testMode?: boolean
  /** undefined: SAP default (safe mode on, an app with a different sap.app/id is not overwritten) */
  safeMode?: boolean
}

export interface RepositoryInfo {
  exists: boolean
  package?: string
  description?: string
  token?: string
}

const repositoryUrl = (name: string) => `${REPOSITORY_SERVICE}/Repositories('${encodeURIComponent(name)}')`

const header = (headers: Record<string, unknown> | undefined, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== name) continue
    if (Array.isArray(v)) return v.length ? String(v[0]) : undefined
    return v === undefined || v === null ? undefined : String(v)
  }
  return undefined
}

const responseOf = (e: unknown): RawResponse | undefined => {
  const any = e as { response?: RawResponse; parent?: { response?: RawResponse } } | undefined
  const r = any?.response ?? any?.parent?.response
  return r && typeof r.status === "number" ? r : undefined
}

/**
 * Sends a request through the system's ADT session and returns the response for every HTTP
 * status except 401 (which is reported as a logon problem like everywhere else).
 */
async function call(system: AbapSystem, url: string, options: RequestOptions): Promise<RawResponse> {
  try {
    return await system.reader.httpClient.request(url, options)
  } catch (e) {
    const r = responseOf(e)
    if (r && r.status !== 401 && !isCsrfError(e)) return r
    if (isCsrfError(e)) throw Object.assign(e as Error, { csrf: true })
    throw e
  }
}

const excerpt = (body: string | undefined, max = 600) => {
  const text = (body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * Extracts the SAP message log from the sap-message header and the OData error body.
 * `includeTopLevel` = false mirrors what fiori deploy does in test mode: the answer is a
 * pseudo error (HTTP 403) whose top level message only says "test mode", the log is in the
 * error details.
 */
export function parseSapMessages(resp: RawResponse, includeTopLevel = true): SapMessage[] {
  const out: SapMessage[] = []
  const seen = new Set<string>()
  const push = (m: { severity?: unknown; code?: unknown; message?: unknown } | undefined) => {
    if (!m) return
    const text = typeof m.message === "string" ? m.message : typeof (m.message as { value?: unknown })?.value === "string" ? ((m.message as { value: string }).value) : ""
    if (!text || text.startsWith("<![CDATA")) return
    if (seen.has(text)) return
    seen.add(text)
    out.push({ severity: String(m.severity ?? "info").toLowerCase(), code: typeof m.code === "string" && m.code ? m.code : undefined, text })
  }
  const sapMessage = header(resp.headers, "sap-message")
  if (sapMessage) {
    try {
      const j = JSON.parse(sapMessage)
      push(j)
      for (const d of j.details ?? []) push(d)
    } catch {
      push({ severity: "info", message: sapMessage })
    }
  }
  const body = resp.body ?? ""
  if (/^\s*\{/.test(body)) {
    try {
      const err = JSON.parse(body).error
      if (err) {
        for (const d of err.innererror?.errordetails ?? []) push(d)
        if (includeTopLevel) {
          push({ severity: "error", code: err.code, message: err.message })
          for (const [k, v] of Object.entries(err.innererror?.Error_Resolution ?? {})) push({ severity: "info", message: `${k}: ${v}` })
        }
      }
    } catch {
      // not JSON after all: reported through the excerpt below
    }
  } else if (/<message[^>]*>/i.test(body)) {
    const m = body.match(/<message[^>]*>([^<]*)<\/message>/i)
    if (m) push({ severity: "error", message: m[1].trim() })
  }
  return out
}

export const formatMessages = (messages: SapMessage[], indent = "  ") =>
  messages.map(m => `${indent}[${m.severity}]${m.code ? ` ${m.code}` : ""} ${m.text}`).join("\n")

const hasErrors = (messages: SapMessage[]) => messages.some(m => /^(error|e|a|x)$/.test(m.severity))

function serviceError(system: AbapSystem, resp: RawResponse, what: string): Error {
  const messages = parseSapMessages(resp)
  const detail = messages.length ? formatMessages(messages) : `  ${excerpt(resp.body) || "(empty response)"}`
  let hint = ""
  if (resp.status === 404 || resp.status === 403)
    hint = `\nThe SAPUI5 ABAP repository OData service (${REPOSITORY_SERVICE}, used by "fiori deploy") must be active in SICF on ${system.name} and the user needs the authorisation to use it.`
  return new Error(`${what}: HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}\n${detail}${hint}`)
}

const looksLikeOData = (resp: RawResponse) =>
  /^\s*\{/.test(resp.body ?? "") || !!header(resp.headers, "dataserviceversion") || /application\/json|application\/xml/i.test(header(resp.headers, "content-type") ?? "")

/** Existence, package and description of a BSP application; also collects a CSRF token. */
export async function repositoryInfo(system: AbapSystem, name: string): Promise<RepositoryInfo> {
  const resp = await call(system, repositoryUrl(name), {
    method: "GET",
    headers: { Accept: "application/json", "x-csrf-token": "fetch" },
    qs: { $format: "json" }
  })
  const token = header(resp.headers, "x-csrf-token")
  if (resp.status >= 200 && resp.status < 300) {
    let d: { Package?: string; Description?: string } = {}
    try {
      d = JSON.parse(resp.body ?? "{}").d ?? {}
    } catch {
      throw new Error(`Unexpected answer of ${REPOSITORY_SERVICE} for ${name}: ${excerpt(resp.body)}`)
    }
    return { exists: true, package: d.Package, description: d.Description, token }
  }
  if (resp.status === 404 && looksLikeOData(resp)) return { exists: false, token }
  throw serviceError(system, resp, `Could not read BSP application ${name} from ${system.name}`)
}

async function fetchToken(system: AbapSystem): Promise<string> {
  const resp = await call(system, `${REPOSITORY_SERVICE}/`, { method: "GET", headers: { Accept: "application/json", "x-csrf-token": "fetch" }, qs: { $format: "json" } })
  const token = header(resp.headers, "x-csrf-token")
  if (!token || token.toLowerCase() === "required") throw serviceError(system, resp, `Could not obtain a CSRF token from ${REPOSITORY_SERVICE} on ${system.name}`)
  return token
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string)

/** The Atom entry `fiori deploy` sends: name, package, description and the base64 zip. */
export function deployPayload(baseUrl: string, name: string, pkg: string, description: string, zip: Buffer, now = new Date()): string {
  const escapedName = escapeXml(name)
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"` +
    ` xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"` +
    ` xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"` +
    ` xml:base="${baseUrl}">` +
    `<id>${baseUrl}/Repositories('${escapedName}')</id>` +
    `<title type="text">Repositories('${escapedName}')</title>` +
    `<updated>${now.toISOString()}</updated>` +
    `<category term="/UI5/ABAP_REPOSITORY_SRV.Repository" scheme="http://schemas.microsoft.com/ado/2007/08/dataservices/scheme"/>` +
    `<link href="Repositories('${escapedName}')" rel="edit" title="Repository"/>` +
    `<content type="application/xml"><m:properties>` +
    `<d:Name>${escapedName}</d:Name>` +
    `<d:Package>${escapeXml(pkg.toUpperCase())}</d:Package>` +
    `<d:Description>${escapeXml(description)}</d:Description>` +
    `<d:ZipArchive>${zip.toString("base64")}</d:ZipArchive>` +
    `<d:Info/>` +
    `</m:properties></content></entry>`
  )
}

const compileExcludes = (patterns: string[] = []) =>
  patterns.map(p => {
    try {
      return new RegExp(p)
    } catch (e) {
      throw new Error(`Invalid exclude pattern ${JSON.stringify(p)}: ${(e as Error).message}`)
    }
  })

function appIdOf(manifest: Buffer | undefined): string | undefined {
  if (!manifest) return undefined
  try {
    return JSON.parse(manifest.toString("utf8").replace(/^﻿/, ""))?.["sap.app"]?.id
  } catch {
    return undefined
  }
}

function checkContents(paths: string[], hint: string) {
  if (paths.includes("manifest.appdescr_variant"))
    throw new Error("The source is an adaptation project (manifest.appdescr_variant). Those are deployed to the layered repository (LREP), which this tool does not support.")
  if (!paths.includes("manifest.json"))
    throw new Error(`No manifest.json at the root of the source (${hint}). Point source at the build result of the UI5 app (usually the dist folder after "npm run build"), not at the project or webapp folder.`)
}

/** Zips a built app folder or reads a prepared zip and checks that it looks like a UI5 app. */
export function loadArchive(source: string, exclude?: string[]): Archive {
  const path = resolve(source)
  if (!existsSync(path)) throw new Error(`Source ${path} does not exist`)
  if (statSync(path).isDirectory()) {
    const entries: ZipEntry[] = collectFiles(path, compileExcludes(exclude))
    if (!entries.length) throw new Error(`Source folder ${path} contains no files${exclude?.length ? " after applying the exclude patterns" : ""}`)
    const paths = entries.map(e => e.path)
    checkContents(paths, `found: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`)
    return { zip: createZip(entries), files: entries.length, appId: appIdOf(entries.find(e => e.path === "manifest.json")?.data), origin: path }
  }
  const zip = readFileSync(path)
  const listing = readZip(zip).filter(e => !e.directory)
  const paths = listing.map(e => e.path)
  checkContents(paths, `found: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`)
  if (exclude?.length) throw new Error("exclude patterns only apply when source is a folder; filter the zip before passing it")
  return { zip, files: listing.length, appId: appIdOf(listing.find(e => e.path === "manifest.json")?.data()), origin: path }
}

/**
 * Decides the transport request the same way saving source does: local packages need none,
 * an application already recorded in a request must use that request, otherwise the caller
 * has to supply one. A transport is never created automatically.
 */
export async function decideTransport(system: AbapSystem, name: string, pkg: string, requested?: string): Promise<{ transport: string; note?: string }> {
  const wanted = requested?.trim().toUpperCase() ?? ""
  if (pkg.startsWith("$")) return { transport: "", note: `local package ${pkg}, no transport request needed` }
  const info: TransportInfo = await system.reader.transportInfo(`${FILESTORE}/${encodeURIComponent(name)}/$create`, pkg, "I")
  const locked = info.LOCKS?.HEADER?.TRKORR
  if (info.DLVUNIT === "LOCAL" && !locked) return { transport: "", note: `local package ${pkg}, no transport request needed` }
  if (locked) {
    const tasks = info.LOCKS?.TASKS?.map(t => t.TRKORR) ?? []
    if (wanted && wanted !== locked && !tasks.includes(wanted))
      throw new TransportRequiredError(
        `BSP application ${name} is already recorded in transport ${locked}${info.LOCKS?.HEADER?.AS4TEXT ? ` (${info.LOCKS.HEADER.AS4TEXT})` : ""}; SAP cannot record it in ${wanted}. Nothing was uploaded. Pass ${locked}${tasks.length ? ` or one of its tasks (${tasks.join(", ")})` : ""} as transport, or release that request first.`
      )
    return { transport: wanted || locked, note: wanted ? undefined : `the application is already recorded in ${locked}, which is used` }
  }
  if (!wanted)
    throw new TransportRequiredError(
      `BSP application ${name} in transportable package ${pkg} needs a transport request. Nothing was uploaded. Pass the transport parameter with one of your modifiable requests, or create one with abap_create_transport (package ${pkg}):\n${candidates(info)}`
    )
  const known = (info.TRANSPORTS ?? []).some(t => t.TRKORR === wanted)
  return { transport: wanted, note: known || !info.TRANSPORTS?.length ? undefined : `${wanted} is not among your modifiable requests for package ${pkg}; SAP rejects the upload if it cannot record the change there` }
}

const appUrl = (system: AbapSystem, name: string) => {
  const path = `/sap/bc/ui5_ui5${name.startsWith("/") ? "" : "/sap/"}${name.toLowerCase()}`
  return `${system.config.url.replace(/\/+$/, "")}${path}${system.config.client ? `?sap-client=${system.config.client}` : ""}`
}

async function upload(system: AbapSystem, name: string, exists: boolean, payload: string, p: { transport: string; testMode: boolean; safeMode?: boolean }, token: string): Promise<RawResponse> {
  const qs: Record<string, unknown> = { CodePage: "'UTF8'", CondenseMessagesInHttpResponseHeader: "X", format: "json" }
  if (p.transport) qs.TransportRequest = p.transport
  if (p.testMode) qs.TestMode = true
  if (p.safeMode !== undefined) qs.SafeMode = p.safeMode
  const send = (csrf: string) =>
    call(system, exists ? repositoryUrl(name) : `${REPOSITORY_SERVICE}/Repositories`, {
      method: exists ? "PUT" : "POST",
      headers: { "Content-Type": "application/atom+xml", type: "entry", charset: "UTF8", Accept: "application/json", "x-csrf-token": csrf },
      qs,
      body: payload,
      timeout: Math.max(system.config.timeout ?? 120000, 600000)
    })
  try {
    return await send(token)
  } catch (e) {
    if ((e as { csrf?: boolean }).csrf) return send(await fetchToken(system))
    throw e
  }
}

/** Uploads a built UI5 app to the SAPUI5 ABAP repository, in test mode unless told otherwise. */
export async function deployUi5App(system: AbapSystem, o: DeployOptions): Promise<string> {
  const testMode = o.testMode !== false
  if (!testMode) system.assertWritable("deploying a UI5 application")
  const name = o.name.trim().toUpperCase()
  if (!name) throw new Error("name (BSP application) must not be empty")
  const archive = loadArchive(o.source, o.exclude)
  const info = await repositoryInfo(system, name)
  const requestedPkg = o.package?.trim().toUpperCase() || ""
  const notes: string[] = []
  const pkg = info.exists ? info.package || requestedPkg : requestedPkg
  if (!pkg) throw new Error(`BSP application ${name} does not exist in ${system.name} yet: pass the package parameter (ABAP package the application is created in).`)
  if (info.exists && requestedPkg && info.package && requestedPkg !== info.package)
    notes.push(`the application already exists in package ${info.package}; SAP cannot move it to ${requestedPkg}, the existing package is kept`)
  const { transport, note } = await decideTransport(system, name, pkg, o.transport)
  if (note) notes.push(note)
  const description = o.description?.trim() || info.description || "Deployed with abap-adt-mcp"
  const payload = deployPayload(system.config.url.replace(/\/+$/, "") + REPOSITORY_SERVICE, name, pkg, description, archive.zip)
  const token = info.token && info.token.toLowerCase() !== "required" ? info.token : await fetchToken(system)
  const resp = await upload(system, name, info.exists, payload, { transport, testMode, safeMode: o.safeMode }, token)
  const messages = parseSapMessages(resp, !testMode)
  const head = [
    `${testMode ? "Test mode deployment" : "Deployment"} of BSP application ${name} to ${system.name} (${info.exists ? "update of the existing application" : "new application"})`,
    `  package ${pkg}${transport ? `, transport ${transport}` : ", no transport"}; source ${archive.origin}: ${plural(archive.files, "file")}, ${formatSize(archive.zip.length)} zipped${archive.appId ? `, sap.app/id ${archive.appId}` : ""}`,
    ...notes.map(n => `  note: ${n}`)
  ]
  const ok = resp.status >= 200 && resp.status < 300
  if (testMode) {
    // SAP answers a test mode upload with HTTP 403 and the check log; fiori deploy treats that as the result
    if (!ok && resp.status !== 403) throw new Error(`${head.join("\n")}\nSAP rejected the test mode upload with HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}:\n${messages.length ? formatMessages(messages) : `  ${excerpt(resp.body) || "(empty response)"}`}`)
    const verdict = hasErrors(messages) ? "SAP reported errors: a real deployment would fail" : "SAP reported no errors"
    return [
      ...head,
      `Nothing was changed on ${system.name} (HTTP ${resp.status} is the expected answer in test mode). ${verdict}.`,
      messages.length ? `SAP check log:\n${formatMessages(messages)}` : `SAP returned no messages${resp.body ? `: ${excerpt(resp.body, 300)}` : ""}`,
      "Call again with testMode=false to deploy for real."
    ].join("\n")
  }
  if (!ok) {
    if (resp.status === 412)
      throw new Error(`${head.join("\n")}\nSAP refused the upload (HTTP 412): the existing application ${name} was built from a different sap.app/id (safe mode). Deploy with safeMode=false to overwrite it deliberately.\n${formatMessages(messages)}`)
    throw new Error(`${head.join("\n")}\nDeployment failed with HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}. Nothing was changed on ${system.name}:\n${messages.length ? formatMessages(messages) : `  ${excerpt(resp.body) || "(empty response)"}`}`)
  }
  return [
    ...head,
    `Deployed successfully (HTTP ${resp.status})${transport ? `, recorded in transport ${transport}` : ""}. App URL: ${appUrl(system, name)}`,
    messages.length ? `SAP messages:\n${formatMessages(messages)}` : ""
  ]
    .filter(Boolean)
    .join("\n")
}

interface FilestoreEntry {
  id: string
  type: string
}

function parseFeed(xml: string): FilestoreEntry[] {
  const out: FilestoreEntry[] = []
  for (const block of xml.split(/<atom:entry[\s>]/).slice(1)) {
    const id = block.match(/<atom:id>([^<]*)<\/atom:id>/)?.[1]
    const type = block.match(/<atom:category[^>]*term="([^"]*)"/)?.[1] ?? "file"
    if (id) out.push({ id, type })
  }
  return out
}

/** Recursive file listing through the ADT filestore (the API Eclipse uses), for older systems. */
async function filestoreListing(system: AbapSystem, name: string): Promise<string[]> {
  const files: string[] = []
  const queue = [encodeURIComponent(name)]
  let requests = 0
  while (queue.length && requests < 60) {
    const id = queue.shift()!
    requests++
    const resp = await call(system, `${FILESTORE}/${id}/content`, { method: "GET", headers: { Accept: "application/atom+xml,application/xml,*/*" } })
    if (resp.status !== 200) throw serviceError(system, resp, `Could not list the files of ${name} through ${FILESTORE}`)
    for (const e of parseFeed(resp.body ?? "")) {
      if (/folder/i.test(e.type)) queue.push(e.id)
      else files.push(decodeURIComponent(e.id))
    }
  }
  return files.sort()
}

/** Package, description and file inventory of a deployed BSP application. */
export async function ui5AppInfo(system: AbapSystem, rawName: string): Promise<string> {
  const name = rawName.trim().toUpperCase()
  const info = await repositoryInfo(system, name)
  if (!info.exists) return `BSP application ${name} does not exist in ${system.name}.`
  const out = [`BSP application ${name} in ${system.name}: package ${info.package ?? "?"}${info.description ? `, "${info.description}"` : ""}`, `App URL: ${appUrl(system, name)}`]
  const resp = await call(system, repositoryUrl(name), { method: "GET", headers: { Accept: "application/json" }, qs: { $format: "json", CodePage: "'UTF8'", DownloadFiles: "RUNTIME" } })
  let zipArchive = ""
  if (resp.status === 200) {
    try {
      zipArchive = JSON.parse(resp.body ?? "{}").d?.ZipArchive ?? ""
    } catch {
      zipArchive = ""
    }
  }
  if (zipArchive) {
    const entries = readZip(Buffer.from(zipArchive, "base64")).filter(e => !e.directory)
    const total = entries.reduce((n, e) => n + e.size, 0)
    const appId = appIdOf(entries.find(e => e.path === "manifest.json")?.data())
    out.push(`${plural(entries.length, "file")}, ${formatSize(total)}${appId ? `, sap.app/id ${appId}` : ""}:`)
    for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) out.push(`  ${e.path}  ${formatSize(e.size)}`)
    return out.join("\n")
  }
  const files = await filestoreListing(system, name)
  out.push(`${plural(files.length, "file")} (listed through the ADT filestore; the system does not return the archive for download):`)
  for (const f of files) out.push(`  ${f}`)
  return out.join("\n")
}

