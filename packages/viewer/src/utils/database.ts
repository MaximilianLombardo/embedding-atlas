// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { Coordinator, restConnector, socketConnector, wasmConnector, type Selection } from "@uwdata/mosaic-core";
import * as SQL from "@uwdata/mosaic-sql";

import { createDuckDB } from "./duckdb.js";

/** Initialize the database connector for a Mosaic coordinator */
export async function initializeDatabase(
  coordinator: Coordinator,
  type: "wasm" | "socket" | "rest",
  uri: string | null | undefined = undefined,
) {
  const db = await createDuckDB();
  if (type == "wasm") {
    const conn = await wasmConnector({ duckdb: db.duckdb, connection: db.connection });
    coordinator.databaseConnector(conn);
  } else if (type == "socket") {
    const conn = await socketConnector({ uri: uri ?? "" });
    coordinator.databaseConnector(conn);
  } else if (type == "rest") {
    const conn = await restConnector({ uri: uri ?? "" });
    coordinator.databaseConnector(conn);
  }
}

/** Convert a Mosaic predicate to SQL string */
export function predicateToString(predicate: ReturnType<Selection["predicate"]>): string | null {
  if (predicate == null) {
    return null;
  }
  if (predicate instanceof Array) {
    if (predicate.length == 0) {
      return null;
    }
    return SQL.and(predicate).toString().trim();
  }
  if (typeof predicate == "string") {
    return predicate.trim();
  }
  if (typeof predicate == "boolean") {
    return SQL.literal(predicate).toString();
  }
  return predicate.toString().trim();
}

export function resolveSQLTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$([a-zA-Z][a-zA-Z0-9\_]+)/g, (original, name) => {
    if (vars[name] != undefined) {
      return vars[name];
    } else {
      return original;
    }
  });
}

/** Column description */
export interface ColumnDesc {
  name: string;
  type: string;
  jsType: JSType | null;
}

export interface EmbeddingLegend {
  indexColumn: string;
  legend: {
    label: string;
    color: string;
    predicate: any;
    count: number;
  }[];
}

export async function columnDescriptions(coordinator: Coordinator, table: string): Promise<ColumnDesc[]> {
  let result = Array.from(await coordinator.query(`DESCRIBE ${table}`));
  return result.map((column) => ({
    name: column.column_name,
    type: column.column_type,
    jsType: jsTypeFromDBType(column.column_type),
  }));
}

export async function distinctCount(coordinator: Coordinator, table: string, column: string): Promise<number> {
  let r = await coordinator.query(`SELECT COUNT(DISTINCT ${SQL.column(column)}) AS count FROM ${table}`);
  return r.get(0).count;
}

/**
 * Batch version of {@link distinctCount}: computes COUNT(DISTINCT col) for many
 * columns in a single SQL pass over the table. DuckDB evaluates the
 * aggregations in one scan, so this is dramatically cheaper than calling
 * `distinctCount` per column on cold start (where ~20 columns × 50-70ms each
 * dominates the time-to-first-paint on small datasets, and scales linearly
 * with row count on large ones).
 *
 * Returns a map from input column name to its distinct count. Columns that
 * fail (e.g. due to a parser quirk on an unusual name) get omitted; the caller
 * should fall back to a default if a column is missing from the result.
 */
export async function distinctCounts(
  coordinator: Coordinator,
  table: string,
  columns: string[],
): Promise<Record<string, number>> {
  if (columns.length == 0) return {};
  const aliases = columns.map((_, i) => `c${i}`);
  const selects = columns
    .map((col, i) => `COUNT(DISTINCT ${SQL.column(col)}) AS "${aliases[i]}"`)
    .join(", ");
  const result = await coordinator.query(`SELECT ${selects} FROM ${table}`);
  const row = result.get(0);
  const out: Record<string, number> = {};
  for (let i = 0; i < columns.length; i++) {
    const v = row[aliases[i]];
    if (v != null) out[columns[i]] = Number(v);
  }
  return out;
}

export type JSType = "string" | "number" | "string[]" | "Date";

export function jsTypeFromDBType(dbType: string): JSType | null {
  if (numberTypes.has(dbType)) {
    return "number";
  } else if (stringTypes.has(dbType)) {
    return "string";
  } else if (dateTypes.has(dbType)) {
    return "Date";
  } else if (dbType.match(/^(VARCHAR|TEXT)\[\d*\]$/)) {
    return "string[]";
  } else if (dbType.startsWith("ENUM(")) {
    // ENUM is a typed VARCHAR with a fixed value set; for downstream
    // categorical coloring / dropdowns it behaves identically to a string.
    return "string";
  } else if (dbType === "UUID") {
    return "string";
  } else if (dbType.startsWith("DECIMAL(")) {
    // DECIMAL(p, s) — fixed-point numeric. Treat as number for binning.
    return "number";
  } else {
    return null;
  }
}

const numberTypes = new Set([
  "REAL",
  "FLOAT4",
  "FLOAT8",
  "FLOAT",
  "DOUBLE",
  "INT",
  "TINYINT",
  "INT1",
  "SMALLINT",
  "INT2",
  "SHORT",
  "INTEGER",
  "INT4",
  "INT",
  "SIGNED",
  "INT8",
  "LONG",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
]);

const stringTypes = new Set(["BOOLEAN", "VARCHAR", "CHAR", "BPCHAR", "TEXT", "STRING"]);

const dateTypes = new Set([
  "DATE",
  "TIME",
  "DATETIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITHOUT TIME ZONE",
]);
