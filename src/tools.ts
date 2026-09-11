import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Systems } from "./connection.js"
import { CLASS_INCLUDES, label, packageOf, resolveObject, type ObjectSpec } from "./objects.js"
import { errorMessage, plural, truncate } from "./format.js"
import { applyEdits, formatSyntax, readSource, syntaxCheck, writeSource } from "./services/source.js"
import { activateInactive, activateObject, formatActivation, formatInactive, inactiveObjects } from "./services/activation.js"
import { createTransportFor, describeTransportInfo, listTransports } from "./services/transports.js"
import { createObject, supportedCreateTypes } from "./services/create.js"
import { findUsages, outline, packageContents, runUnitTests } from "./services/navigation.js"

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
      "ADT object type, used to disambiguate names: CLAS/OC class, INTF/OI interface, PROG/P program, PROG/I include, FUGR/FF function module, FUGR/F function group, FUGR/I function group include, DDLS/DF CDS view, TABL/DT table, DTEL/DE data element. Short forms (CLAS, PROG, FUNC ...) are accepted."
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

const spec = (a: ObjectSpec & { system?: string }): ObjectSpec => ({ name: a.name, type: a.type, uri: a.uri, include: a.include })

export function registerTools(server: McpServer, systems: Systems) {
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
          return `- ${c.name}${c.name === systems.defaultName ? " (default)" : ""}: ${c.url} client ${c.client ?? "default"} user ${c.username}${c.readOnly ? "  READ-ONLY" : ""}`
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
        "Reads the source code of an object (class, interface, program, include, function module, CDS view ...). Returns the inactive version when unsaved changes exist, otherwise the active one. For objects without ABAP source (tables, data elements) the XML definition is returned. Use startLine/endLine on big objects.",
      inputSchema: {
        ...objectParams,
        version: z.enum(["active", "inactive"]).optional().describe("Force the active or the inactive version."),
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
        "Replaces the complete source of an existing object: locks it, saves the new source as inactive version (recorded in a transport request when the package is transportable), unlocks it and runs a syntax check. Set activate=true to activate right away. For small changes prefer abap_edit_source. Transportable objects need `transport` unless they are already recorded in one of your requests.",
      inputSchema: {
        ...objectParams,
        source: z.string().describe("The complete new source code of the object / include."),
        transport: z.string().optional().describe("Transport request or task number, e.g. DEVK900123. Required for transportable objects that are not yet locked in a request."),
        activate: z.boolean().optional().describe("Activate after saving (default false)."),
        checkSyntax: z.boolean().optional().describe("Run a syntax check after saving (default true).")
      },
      annotations: writes
    },
    args =>
      run(async () => {
        const system = systems.get(args.system)
        const obj = await resolveObject(system, spec(args))
        const r = await writeSource(system, obj, args.source, { transport: args.transport, activate: args.activate, checkSyntax: args.checkSyntax })
        return r.text
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
          .array(z.object({ oldText: z.string().describe("Exact text to replace (must occur exactly once)."), newText: z.string().describe("Replacement text.") }))
          .min(1)
          .describe("Edits applied in order."),
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
        const { result, replaced } = applyEdits(current.source, args.edits)
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
        "Activates one or more objects (or, with all=true, every inactive object of the current user) and returns the activation log: errors with object, include, line and message text. Activation of a class include activates the whole class.",
      inputSchema: {
        objects: z
          .array(z.object({ name: objectParams.name, type: objectParams.type, uri: objectParams.uri }))
          .optional()
          .describe("Objects to activate, each by name (+type) or uri."),
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
        if (!args.objects?.length) throw new Error("Pass objects to activate or all=true")
        const out: string[] = []
        for (const o of args.objects) {
          const obj = await resolveObject(system, o)
          const summary = await activateObject(system, obj)
          out.push(formatActivation(`${obj.type} ${obj.lockName}`, summary))
        }
        return out.join("\n\n")
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
        "Tells whether changing an object requires a transport request, which request already locks it, and which of your modifiable requests could record it. Call this before abap_write_source when unsure about the transport.",
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
      description: "Lists the modifiable workbench transport requests (with tasks) of a user, default the logged-on user. Use the request or task number as `transport` when saving.",
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
      description: `Creates a new, empty repository object in a package (class, interface, program, include, function group, function module, CDS view ...). Supported types: ${supportedCreateTypes()}. Afterwards write its source with abap_write_source and activate it.`,
      inputSchema: {
        type: z.string().describe("Object type, e.g. CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, FUGR/FF, DDLS/DF."),
        name: z.string().describe("Name of the new object (customer namespace, e.g. ZCL_...)."),
        description: z.string().describe("Short description."),
        package: z.string().describe("Target package, e.g. $TMP for local objects."),
        parent: z.string().optional().describe("Function group name, required for FUGR/FF and FUGR/I."),
        transport: z.string().optional().describe("Transport request for transportable packages."),
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
}
