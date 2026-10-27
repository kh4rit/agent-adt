import type { QueryResult } from "abap-adt-api"
import type { AbapSystem } from "../connection.js"
import { plural, truncate } from "../format.js"

export const SQL_MAX_ROWS = 5000

export class SqlNotAllowedError extends Error {}

/** Removes ABAP / SQL comments so the statement keyword can be checked. */
const stripComments = (sql: string) =>
  sql
    .split(/\r?\n/)
    .filter(l => !/^\s*\*/.test(l))
    .map(l => l.replace(/(^|\s)(--|").*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()

/**
 * Checks a data preview query before it is sent. SAP's data preview itself only executes
 * SELECT statements; this check gives agents a clear answer without a round trip.
 */
export function checkQuery(sql: string): string {
  const code = stripComments(sql)
  if (!code) throw new SqlNotAllowedError("query must not be empty")
  if (!/^(SELECT|WITH)\b/i.test(code)) throw new SqlNotAllowedError("Only SELECT statements (ABAP SQL) can be run; the data preview is read-only.")
  // comments are only removed for the check: literals may contain comment characters
  return sql.trim().replace(/[.;]\s*$/, "")
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v)
  const flat = s.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "\\|")
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat
}

/** Formats a data preview result as a markdown style table. */
export function formatQueryResult(r: QueryResult, maxRows: number): string {
  const names = r.columns.map(c => c.name)
  const rows = r.values.map(v => names.map(n => cell((v as Record<string, unknown>)[n])))
  const more = rows.length >= maxRows ? ` (row limit ${maxRows} reached, more rows may exist: narrow the WHERE clause or raise maxRows)` : ""
  const head = `${plural(rows.length, "row")}${more}`
  if (!rows.length) return `${head}\n| ${names.join(" | ")} |`
  const lines = [`| ${names.join(" | ")} |`, `|${names.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`)]
  return `${head}\n${lines.join("\n")}`
}

/** Runs a read-only ABAP SQL query through ADT data preview (the SQL console of Eclipse ADT). */
export async function runSqlQuery(system: AbapSystem, sql: string, maxRows = 100): Promise<string> {
  if (system.config.allowSql === false)
    throw new SqlNotAllowedError(`SQL queries are switched off for system ${system.name} (allowSql: false in the configuration)`)
  const statement = checkQuery(sql)
  const rows = Math.min(Math.max(1, Math.floor(maxRows)), SQL_MAX_ROWS)
  const result = await system.reader.runQuery(statement, rows, false)
  return truncate(`${system.name} client ${system.config.client ?? "default"}: ${formatQueryResult(result, rows)}`, 60000)
}
