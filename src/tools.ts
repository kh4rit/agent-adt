import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Systems } from "./connection.js"
import { CLASS_INCLUDES, label, ObjectNotFoundError, packageOf, resolveObject, type ObjectSpec } from "./objects.js"
import { errorMessage, plural, truncate } from "./format.js"
import { applyEdits, createTestInclude, formatRevisions, formatSyntax, listRevisions, readMethod, readRevision, readSource, syntaxCheck, writeSource } from "./services/source.js"
import { lockStatus } from "./services/locks.js"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { activateInactive, activateObject, activateTogether, formatActivation, formatInactive, inactiveObjects } from "./services/activation.js"
import { createTransportFor, describeTransportInfo, listTransports, readTransport } from "./services/transports.js"
import { runSqlQuery, SQL_MAX_ROWS } from "./services/data.js"
import { odataMetadata } from "./services/odata.js"
import { createObject, PROCESSING_TYPES, setProcessingType, supportedCreateTypes, UPDATE_TASK_KINDS } from "./services/create.js"
import { findUsages, outline, packageContents, runUnitTests } from "./services/navigation.js"
import { deployUi5App, ui5AppInfo } from "./services/ui5.js"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const run = async (fn: () => Promise<string>): Promise<ToolResult> => {
  try {
    return { content: [{ type: "text", text: await fn() }] }
  } catch (e) {
    return { content: [{ type: "text", text: errorMessage(e) }], isError: true }
  }
}

const systemParam = z
  .string()
  .optional()
  .describe("Name of the configured SAP system (see abap_list_systems). Optional when only one system is configured.")

const objectParams = {
  name: z
    .string()
    .optional()
    .describe("Object name, e.g. ZCL_MY_CLASS, ZMY_REPORT, Z_MY_FUNCTION_MODULE, ZI_MY_CDS_VIEW. Case-insensitive."),
  type: z
    .string()
    .optional()
    .describe(
      "ADT object type, used to disambiguate names: CLAS/OC class, INTF/OI interface, PROG/P program, PROG/I include, FUGR/FF function module, FUGR/F function group, FUGR/I function group include, DDLS/DF CDS view, TABL/DT table, TABL/DS structure, DTEL/DE data element. A bare type (TABL, PROG, DDLS ...) matches all its subtypes, e.g. TABL finds tables and structures; FUNC = function module. PROG/I and FUGR/I are interchangeable."
    ),
  uri: z
    .string()
    .optional()
    .describe("ADT URI of the object, e.g. /sap/bc/adt/oo/classes/zcl_my_class (as returned by abap_search_objects). Preferred over name when known."),
  include: z
    .enum(CLASS_INCLUDES)
    .optional()
    .describe(
      "Classes only: which include to address. main (default) = public class definition + method implementations; testclasses = local test classes; definitions = local class definitions; implementations = local class implementations; macros."
    ),
  system: systemParam
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const editSchema = z.object({
  oldText: z.string().describe("Exact text to replace. Must occur exactly once, unless occurrence is given."),
  newText: z.string().describe("Replacement text."),
  occurrence: z.number().int().min(1).optional().describe("Which occurrence of oldText to replace (1 = first) when it occurs more than once.")
})

/** Some models send nested arrays as a JSON string: accept that too. */
function parseEdits(edits: z.infer<typeof editSchema>[] | string): z.infer<typeof editSchema>[] {
  if (typeof edits !== "string") return edits
  let parsed: unknown
  try {
    parsed = JSON.parse(edits)
  } catch {
    throw new Error("edits must be an array of {oldText, newText} objects (got a string that is not JSON)")
  }
  const r = z.array(editSchema).min(1).safeParse(parsed)
  if (!r.success) throw new Error("edits must be an array of {oldText, newText} objects")
  return r.data
}

const spec = (a: ObjectSpec & { system?: string }): ObjectSpec => ({ name: a.name, type: a.type, uri: a.uri, include: a.include })

export function registerTools(mcp: McpServer, systems: Systems) {
  // every tool call runs in the queue of its system (see AbapSystem.serialize)
  const server = {
    registerTool: ((name: string, config: unknown, handler: (args: any, extra: unknown) => Promise<ToolResult>) =>
      mcp.registerTool(name, config as any, ((args: any, extra: unknown) =>
        name === "abap_list_systems" ? handler(args, extra) : systems.serialize(args?.system, () => handler(args, extra))) as any)) as McpServer["registerTool"]
  }
  server.registerTool(
    "abap_list_systems",
    {
      title: "List SAP systems",
      description: "Lists the configured SAP systems with url, client and user. Use the returned name as the `system` parameter of other tools.",
      inputSchema: {},
      annotations: readOnly
    },
    () =>
      run(async () => {
        const lines = systems.list().map(s => {
          const c = s.config
          return `- ${c.name}${c.name === systems.defaultName ? " (default)" : ""}: ${c.url} client ${c.client ?? "default"} user ${c.username} auth ${s.auth}${c.readOnly ? "  READ-ONLY" : ""}${c.allowSql === false ? "  SQL off" : ""}`
        })
        return `Configured systems:\n${lines.join("\n")}`
      })
  )

  server.registerTool(
    "abap_search_objects",
    {
      title: "Search ABAP objects",
      description:
        "Searches the ABAP repository by name pattern (like Ctrl+Shift+A in Eclipse ADT). Supports * wildcards; a trailing * is added automatically. Returns type, name, description, package and ADT uri of each hit. Use it to find classes, programs, function modules, CDS views, tables etc. before reading or changing them.",
      inputSchema: {
        query: z.string().describe("Name pattern, e.g. ZCL_INVOICE*, *PRICING*, Z_BAPI_ORDER_CREATE. Case-insensitive."),
        type: z
          .string()
          .optional()
          .describe("Restrict to one object type: CLAS, INTF, PROG, FUGR, FUNC (function modules), DDLS (CDS), TABL, DTEL, DOMA, DEVC (packages), ..."),
        maxResults: z.number().int().min(1).max(500).optional().describe("Maximum number of hits (default 50)."),
        system: systemParam
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        let query = args.query.trim().toUpperCase()
        if (!query) throw new Error("query must not be empty")
        if (!/[*?]/.test(query)) query += "*"
        const objType = args.type?.trim().toUpperCase().split("/")[0] || undefined
        const results = await system.reader.searchObject(query, objType, args.maxResults ?? 50)
        if (!results.length) return `No objects matching ${query}${objType ? ` of type ${objType}` : ""} in ${system.name}.`
        const lines = results.map(r => {
          const pkg = r["adtcore:packageName"] ? `  [${r["adtcore:packageName"]}]` : ""
          const desc = r["adtcore:description"] ? `  ${r["adtcore:description"]}` : ""
          return `- ${r["adtcore:type"]} ${r["adtcore:name"]}${desc}${pkg}  ${r["adtcore:uri"]}`
        })
        return `${plural(results.length, "object")} matching ${query} in ${system.name}:\n${lines.join("\n")}`
      })
  )

  server.registerTool(
    "abap_get_object",
    {
      title: "Get object details",
      description:
        "Returns metadata of one object: type, description, package, active/inactive state, last change, source URL, class includes and (for includes) the main program. Cheap way to check an object exists and whether it is inactive.",
      inputSchema: objectParams,
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        const pkg = await packageOf(system, obj)
        const out = [
          `${obj.type} ${obj.name}${obj.description ? `  ${obj.description}` : ""}`,
          `package: ${pkg || "?"}   version: ${obj.version ?? "?"}   changed by ${obj.changedBy ?? "?"} at ${obj.changedAt ?? "?"}   created by ${obj.createdBy ?? "?"}`,
          `object uri: ${obj.objectUrl}`,
          `source uri: ${obj.hasSource ? obj.sourceUrl : "(no ABAP source; read returns the XML definition)"}`
        ]
        if (obj.includes?.length) out.push(`class includes: ${obj.includes.map(i => `${i.type} [${i.version ?? "?"}]`).join(", ")}`)
        if (obj.mainProgram) out.push(`main program: ${obj.mainProgram}`)
        return out.join("\n")
      })
  )

  server.registerTool(
    "abap_read_source",
    {
      title: "Read source code",
      description:
        "Reads the source code of an object (class, interface, program, include, function module, CDS view ...). Returns the inactive version when unsaved changes exist, otherwise the active one. For objects without ABAP source (tables, data elements) the XML definition is returned. Use startLine/endLine on big objects. Pass `revision` to read a stored older version (see abap_list_versions), `method` to read one method of a class, `saveTo` to write the source to a local file instead of returning it.",
      inputSchema: {
        ...objectParams,
        version: z.enum(["active", "inactive"]).optional().describe("Force the active or the inactive version."),
        revision: z.string().optional().describe("Stored version to read instead of the current source: its number from abap_list_versions (e.g. 00001) or its uri."),
        method: z.string().optional().describe("Classes only: return just this method implementation (METHOD ... ENDMETHOD) with its line numbers, e.g. get_data or if_foo~bar."),
        saveTo: z.string().optional().describe("Local file path: write the complete source there (directories are created) and return only a summary. Use for large sources and downloads."),
        startLine: z.number().int().min(1).optional().describe("First line to return (1-based)."),
        endLine: z.number().int().min(1).optional().describe("Last line to return."),
        lineNumbers: z.boolean().optional().describe("Prefix every line with its line number (default false).")
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        if (args.saveTo) {
          const r = await readSource(system, obj, { version: args.version })
          const file = resolvePath(args.saveTo)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, r.source)
          return `${label(obj)} [${r.version}] ${plural(r.totalLines, "line")} saved to ${file}`
        }
        if (args.method) return readMethod(system, obj, args.method, { version: args.version, lineNumbers: args.lineNumbers })
        if (args.revision)
          return readRevision(system, obj, args.revision, { startLine: args.startLine, endLine: args.endLine, lineNumbers: args.lineNumbers })
        const r = await readSource(system, obj, {
          version: args.version,
          startLine: args.startLine,
          endLine: args.endLine,
          lineNumbers: args.lineNumbers
        })
        return r.text
      })
  )

  server.registerTool(
    "abap_write_source",
    {
      title: "Write source code",
      description:
        "Replaces the complete source of an existing object: locks it, saves the new source as inactive version (recorded in a transport request when the package is transportable), unlocks it and runs a syntax check. Set activate=true to activate right away. For small changes prefer abap_edit_source. Transportable objects need `transport` unless they are already recorded in one of your requests. Domains (DOMA) and data elements (DTEL) take their complete XML definition as read with abap_read_source. Writing the testclasses include of a class that has none creates it.",
      inputSchema: {
        ...objectParams,
        source: z.string().optional().describe("The complete new source code of the object / include (or XML definition for DOMA / DTEL)."),
        sourceFile: z.string().optional().describe("Local file with the complete new source, instead of source: keeps large sources out of the tool call."),
        transport: z.string().optional().describe("Transport request or task number, e.g. DEVK900123. Required for transportable objects that are not yet locked in a request."),
        activate: z.boolean().optional().describe("Activate after saving (default false)."),
        checkSyntax: z.boolean().optional().describe("Run a syntax check after saving (default true).")
      },
      annotations: writes
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        if ((args.source === undefined) === !args.sourceFile) throw new Error("Pass either source or sourceFile")
        const source = args.source ?? readFileSync(resolvePath(args.sourceFile!), "utf8").replace(/^\uFEFF/, "")
        let created = ""
        let obj
        try {
          obj = await resolveObject(system, spec(args))
        } catch (e) {
          if (!(e instanceof ObjectNotFoundError && args.include === "testclasses" && /has no testclasses include/.test(e.message))) throw e
          const cls = await resolveObject(system, { ...spec(args), include: "main" })
          const r = await createTestInclude(system, cls, args.transport)
          obj = r.obj
          created = `Created the test class include of ${cls.name}${r.transport ? ` in transport ${r.transport}` : ""}.\n`
        }
        const r = await writeSource(system, obj, source, { transport: args.transport, activate: args.activate, checkSyntax: args.checkSyntax })
        return created + r.text
      })
  )

  server.registerTool(
    "abap_edit_source",
    {
      title: "Edit source code",
      description:
        "Applies search-and-replace edits to the current source of an object and saves the result (same locking / transport / syntax check behaviour as abap_write_source). Each oldText must match exactly one place in the current source, so include enough surrounding lines. Cheaper than sending the whole source.",
      inputSchema: {
        ...objectParams,
        edits: z
          .union([z.array(editSchema).min(1), z.string()])
          .describe("Edits applied in order: an array of {oldText, newText} (a JSON string of that array is accepted too)."),
        transport: z.string().optional().describe("Transport request or task number, required for transportable objects not yet recorded in a request."),
        activate: z.boolean().optional().describe("Activate after saving (default false)."),
        checkSyntax: z.boolean().optional().describe("Run a syntax check after saving (default true).")
      },
      annotations: writes
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        const current = await readSource(system, obj)
        const { result, replaced } = applyEdits(current.source, parseEdits(args.edits))
        if (result === current.source.replace(/\r\n/g, "\n")) return `The edits did not change ${label(obj)}; nothing saved.`
        const r = await writeSource(system, obj, result, { transport: args.transport, activate: args.activate, checkSyntax: args.checkSyntax })
        return `Applied ${plural(replaced, "edit")} to the ${current.version} version.\n${r.text}`
      })
  )

  server.registerTool(
    "abap_syntax_check",
    {
      title: "Syntax check",
      description:
        "Runs the ABAP syntax check. With `source` the given (unsaved) code is checked in the context of the object, without touching the system; without it the current (inactive if present) source is checked. Returns errors and warnings with line numbers.",
      inputSchema: {
        ...objectParams,
        source: z.string().optional().describe("Source code to check instead of the saved one.")
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        const source = args.source ?? (await readSource(system, obj)).source
        const messages = await syntaxCheck(system, obj, source)
        return `${label(obj)}\n${formatSyntax(messages, obj)}`
      })
  )

  server.registerTool(
    "abap_activate",
    {
      title: "Activate objects",
      description:
        "Activates one object (name/type/uri), several objects (objects) or, with all=true, every inactive object of the current user, and returns the activation log: errors with object, include, line and message text. Several objects are activated together in one request, so SAP orders dependencies itself (e.g. a CDS interface view and its consumption view). Activation of a class include activates the whole class.",
      inputSchema: {
        name: objectParams.name,
        type: objectParams.type,
        uri: objectParams.uri,
        objects: z
          .array(z.object({ name: objectParams.name, type: objectParams.type, uri: objectParams.uri }))
          .optional()
          .describe("Objects to activate together, each by name (+type) or uri."),
        all: z.boolean().optional().describe("Activate all inactive objects of the current user instead of a list."),
        system: systemParam
      },
      annotations: writes
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        if (args.all) {
          const records = await inactiveObjects(system)
          const mine = records.filter(r => !r.object?.deleted)
          if (!mine.length) return `No inactive objects in ${system.name}.`
          const summary = await activateInactive(
            system,
            mine.map(r => r.object!)
          )
          return formatActivation(`${plural(mine.length, "inactive object")} (${mine.map(r => r.object!["adtcore:name"]).join(", ")})`, summary)
        }
        const list = args.objects?.length ? args.objects : args.name || args.uri ? [{ name: args.name, type: args.type, uri: args.uri }] : []
        if (!list.length) throw new Error("Pass the object (name/type or uri), objects for several, or all=true")
        const resolved = []
        for (const o of list) resolved.push(await resolveObject(system, o))
        if (resolved.length === 1) return formatActivation(`${resolved[0].type} ${resolved[0].lockName}`, await activateObject(system, resolved[0]))
        const summary = await activateTogether(system, resolved)
        return formatActivation(resolved.map(o => `${o.type} ${o.lockName}`).join(", "), summary)
      })
  )

  server.registerTool(
    "abap_inactive_objects",
    {
      title: "List inactive objects",
      description: "Lists the inactive (saved but not activated) objects of the current user, with the transport they are recorded in.",
      inputSchema: { system: systemParam },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return formatInactive(await inactiveObjects(system), system)
      })
  )

  server.registerTool(
    "abap_transport_info",
    {
      title: "Transport info of an object",
      description:
        "Tells whether changing an object requires a transport request, which request already locks it (with owner and tasks) and, if none does, which modifiable requests SAP proposes for its package (these may belong to other users). Call this before abap_write_source when unsure about the transport.",
      inputSchema: objectParams,
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return describeTransportInfo(system, obj)
      })
  )

  server.registerTool(
    "abap_list_transports",
    {
      title: "List transport requests",
      description: "Lists the modifiable workbench and customizing requests (with tasks) that a user owns or has a task in, default the logged-on user. Use the request or task number as `transport` when saving. Wildcards are not supported.",
      inputSchema: {
        user: z.string().optional().describe("SAP user name; default: the configured user."),
        withObjects: z.boolean().optional().describe("Also list the objects recorded in each request (default false)."),
        system: systemParam
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return listTransports(system, args.user, args.withObjects)
      })
  )

  server.registerTool(
    "abap_read_transport",
    {
      title: "Read transport request",
      description:
        "Reads one transport request or task by number, also of other owners and released ones: description, type, owner, status, target, tasks with owners and the recorded objects (R3TR/LIMU entries, customizing table keys as CDAT/TABU).",
      inputSchema: {
        number: z.string().describe("Request or task number, e.g. DEVK900123."),
        withObjects: z.boolean().optional().describe("List the recorded objects (default true)."),
        system: systemParam
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return truncate(await readTransport(system, args.number, args.withObjects ?? true), 60000)
      })
  )

  server.registerTool(
    "abap_create_transport",
    {
      title: "Create transport request",
      description: "Creates a new workbench transport request (with a task for the current user) for an existing object or for a package, and returns its number.",
      inputSchema: {
        description: z.string().describe("Short text of the transport request."),
        name: objectParams.name,
        type: objectParams.type,
        uri: objectParams.uri,
        package: z.string().optional().describe("Package the request is for, when no object is given."),
        system: systemParam
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = args.name || args.uri ? await resolveObject(system, spec(args)) : undefined
        const number = await createTransportFor(system, { obj, pkg: args.package }, args.description.trim())
        return `Created transport request ${number}: ${args.description.trim()}. Use it as the transport parameter when saving.`
      })
  )

  server.registerTool(
    "abap_create_object",
    {
      title: "Create object",
      description: `Creates a new, empty repository object in a package (class, interface, program, include, function group, function module, CDS view ...). Supported types: ${supportedCreateTypes()}. Afterwards write its source with abap_write_source and activate it. A package (DEVC/K) is created below the given super package with its software component and transport layer unless they are passed.`,
      inputSchema: {
        type: z.string().describe("Object type, e.g. CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, FUGR/FF, DDLS/DF."),
        name: z.string().describe("Name of the new object (customer namespace, e.g. ZCL_...)."),
        description: z.string().describe("Short description."),
        package: z.string().describe("Target package, e.g. $TMP for local objects. For a new package (DEVC/K): its super package."),
        parent: z.string().optional().describe("Function group name, required for FUGR/FF and FUGR/I."),
        transport: z.string().optional().describe("Transport request for transportable packages."),
        softwareComponent: z.string().optional().describe("DEVC/K only: software component; default the super package's (LOCAL for $ packages)."),
        transportLayer: z.string().optional().describe("DEVC/K only: transport layer; default the super package's."),
        packageType: z.enum(["development", "structure", "main"]).optional().describe("DEVC/K only: package type, default development."),
        processingType: z.enum(PROCESSING_TYPES).optional().describe("FUGR/FF only: normal (default), rfc (remote-enabled) or update (update module)."),
        updateTaskKind: z.enum(UPDATE_TASK_KINDS).optional().describe("FUGR/FF update modules only: startImmediate (V1, default), startDelayed (V2), immediateStartNoRestart, collectiveRun."),
        system: systemParam
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const r = await createObject(system, args)
        return r.text
      })
  )

  server.registerTool(
    "abap_find_usages",
    {
      title: "Where-used list",
      description: "Where-used list of an object, or of the symbol at a line/column of its source (e.g. a method). Returns the using objects with their ADT uris.",
      inputSchema: {
        ...objectParams,
        line: z.number().int().min(1).optional().describe("Line in the source to look up a specific symbol (1-based)."),
        column: z.number().int().min(0).optional().describe("Column of the symbol in that line (0-based).")
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return truncate(await findUsages(system, obj, args.line, args.column), 60000)
      })
  )

  server.registerTool(
    "abap_package_contents",
    {
      title: "Package contents",
      description: "Lists the objects of a package grouped by type, with descriptions and ADT uris.",
      inputSchema: { package: z.string().describe("Package name, e.g. ZFI_INVOICES or $TMP."), system: systemParam },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return truncate(await packageContents(system, args.package), 60000)
      })
  )

  server.registerTool(
    "abap_object_outline",
    {
      title: "Class / interface outline",
      description: "Lists the components (attributes, methods, events, types) of a class or interface with visibility, without returning the full source.",
      inputSchema: objectParams,
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return truncate(await outline(system, obj), 60000)
      })
  )

  server.registerTool(
    "abap_run_unit_tests",
    {
      title: "Run ABAP Unit tests",
      description: "Runs the ABAP Unit tests of a class, program or function group and returns passed/failed methods with failure details.",
      inputSchema: objectParams,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return truncate(await runUnitTests(system, obj), 60000)
      })
  )

  server.registerTool(
    "abap_list_versions",
    {
      title: "List stored versions",
      description:
        "Lists the stored versions (version management) of an object or class include: number, date, author, transport request and its text, newest first. Read one with abap_read_source and the revision parameter, e.g. to compare with the current source.",
      inputSchema: objectParams,
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return truncate(formatRevisions(obj, await listRevisions(system, obj)), 60000)
      })
  )

  server.registerTool(
    "abap_sql_query",
    {
      title: "Run ABAP SQL query (data preview)",
      description: `Runs a read-only ABAP SQL SELECT through ADT data preview (the SQL console of Eclipse ADT) and returns the rows as a table. Use it to read customizing and application tables, CDS views and DDIC metadata (e.g. TADIR, E070/E071, DD03L). Only SELECT is possible; SAP checks the user's authorizations, and client-dependent tables are read in the system's logon client. ABAP SQL syntax: comma separated field lists, literals in single quotes, joins with ~ (e070~trkorr); the row limit comes from maxRows, not UP TO. Do not query personal data beyond what the task needs.`,
      inputSchema: {
        query: z.string().describe("ABAP SQL SELECT statement, e.g. SELECT trkorr, as4text FROM e07t WHERE trkorr = 'DEVK900123'"),
        maxRows: z.number().int().min(1).max(SQL_MAX_ROWS).optional().describe(`Maximum number of rows (default 100, max ${SQL_MAX_ROWS}).`),
        system: systemParam
      },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return runSqlQuery(system, args.query, args.maxRows ?? 100)
      })
  )

  server.registerTool(
    "abap_odata_metadata",
    {
      title: "OData service metadata",
      description:
        "Fetches the $metadata (EDMX) of a Gateway OData V2 or V4 service with this server's SAP logon (works with SSO systems where curl or the Fiori tools cannot log on). Returns a summary of entity types with keys and properties, entity sets and actions/functions, or the raw XML; saveTo writes the complete document to a local file (e.g. for a Fiori app's localService mock data).",
      inputSchema: {
        service: z
          .string()
          .describe("Service path or URL, e.g. /sap/opu/odata4/sap/api_warehouse_order_task_2/srvd_a2x/sap/warehouseorder/0001/ or /sap/opu/odata/sap/API_PRODUCT_SRV. $metadata is appended."),
        format: z.enum(["summary", "xml"]).optional().describe("summary (default) or the raw XML (truncated to 60000 characters)."),
        saveTo: z.string().optional().describe("Local file path to write the complete $metadata to; directories are created."),
        system: systemParam
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return odataMetadata(system, args)
      })
  )

  server.registerTool(
    "abap_set_processing_type",
    {
      title: "Set function module processing type",
      description:
        "Changes the processing type of an existing function module: normal, rfc (remote-enabled) or update (update module, with updateTaskKind). Saved inactive in the function module's transport; activate afterwards.",
      inputSchema: {
        ...objectParams,
        processingType: z.enum(PROCESSING_TYPES).describe("normal, rfc or update."),
        updateTaskKind: z.enum(UPDATE_TASK_KINDS).optional().describe("For update: startImmediate (V1, default), startDelayed (V2), immediateStartNoRestart, collectiveRun."),
        transport: z.string().optional().describe("Transport request, required when the function module is not yet recorded in one.")
      },
      annotations: writes
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, { ...spec(args), type: args.type ?? (args.uri ? undefined : "FUNC") })
        return (await setProcessingType(system, obj, args.processingType, args.updateTaskKind, args.transport)).text
      })
  )

  server.registerTool(
    "abap_lock_status",
    {
      title: "Edit lock status",
      description:
        "Tells whether an object can be edited now or who holds its edit lock (e.g. after \"currently editing\" errors), by locking it and releasing it at once. ADT cannot release locks of other sessions; a lock of the tool's own user ends with its SAP session, otherwise the user deletes it in SM12.",
      inputSchema: objectParams,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        return lockStatus(system, obj)
      })
  )

  server.registerTool(
    "abap_deploy_ui5_app",
    {
      title: "Deploy SAPUI5 / Fiori app",
      description:
        "Uploads a built SAPUI5/Fiori application (the dist folder produced by `npm run build`, or a prepared zip) to the SAPUI5 ABAP repository as BSP application, through the same OData service `fiori deploy` / `npm run deploy` uses, but with this server's SAP session (works with SSO systems where the Fiori tools cannot log on). Parameters correspond to ui5-deploy.yaml: app.name, app.package, app.transport, app.description, exclude. testMode defaults to true: SAP checks the upload and returns its message log without changing anything; call again with testMode=false to deploy. Transportable packages need `transport`; the tool never creates one.",
      inputSchema: {
        name: z.string().describe("BSP application name (app.name in ui5-deploy.yaml), e.g. ZMY_APP or /NAMESPACE/MY_APP."),
        source: z.string().describe("Path of the built app: the dist folder after `npm run build` (zipped by the tool), or a .zip file whose root contains manifest.json."),
        package: z.string().optional().describe("ABAP package, e.g. ZMY_APPS or /NAMESPACE/PKG (app.package). Required for a new application; ignored for an existing one (its package cannot change)."),
        transport: z.string().optional().describe("Transport request or task, e.g. DEVK900123 (app.transport). Required for transportable packages; local packages ($TMP) need none."),
        description: z.string().optional().describe("Description of the BSP application (app.description). Default: the existing one, or 'Deployed with abap-adt-mcp'."),
        exclude: z.array(z.string()).optional().describe("Regular expressions of paths to leave out, tested against the path relative to the source folder with a leading slash, like `exclude` in ui5-deploy.yaml, e.g. [\"/test/\", \"\\\\.map$\"]."),
        testMode: z.boolean().optional().describe("true (default): SAP simulates the upload and returns the check log, nothing is changed. false: really deploy."),
        safeMode: z.boolean().optional().describe("false lets SAP overwrite an application that was built from a different sap.app/id (HTTP 412 otherwise). Default: SAP's safe mode."),
        system: systemParam
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return deployUi5App(system, args)
      })
  )

  server.registerTool(
    "abap_ui5_app_info",
    {
      title: "Deployed SAPUI5 app info",
      description:
        "Shows a deployed SAPUI5/Fiori application (BSP application in the SAPUI5 ABAP repository): package, description, URL and the file inventory with sizes, so the build result can be compared before deploying with abap_deploy_ui5_app.",
      inputSchema: { name: z.string().describe("BSP application name, e.g. ZMY_APP or /NAMESPACE/MY_APP."), system: systemParam },
      annotations: readOnly
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        return truncate(await ui5AppInfo(system, args.name), 60000)
      })
  )
}
