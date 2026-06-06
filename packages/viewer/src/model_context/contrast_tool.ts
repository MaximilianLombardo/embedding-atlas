// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import * as SQL from "@uwdata/mosaic-sql";
import type { Coordinator } from "@uwdata/mosaic-core";
import type { MCPTool, ToolResponse } from "../app/mcp_server.js";
import type { ColumnDesc } from "../utils/database.js";

/**
 * Dependencies the `contrast_selection` tool needs from the host. Kept as
 * a small struct of getters so the tool always reads the *current*
 * coordinator / predicate / column config at call time (these change as the
 * user loads data or edits the cross-filter between turns) — same pattern as
 * RetrieveToolContext in retrieve_tool.ts.
 */
export interface ContrastToolContext {
  /** Mosaic coordinator; all SQL runs through `coordinator.query(...)`. */
  coordinator: Coordinator;
  /** Main data table name. */
  table: string;
  /** Row-id column name (for exemplar citation pills). */
  idColumn: string;
  /** Live column descriptors (name + type + jsType). */
  columns(): ColumnDesc[];
  /** The current cross-filter predicate as a SQL string, or null if no selection. */
  currentPredicate(): string | null;
}

// ---------------------------------------------------------------------------
// Tunable caps. Keep the result compact: the model narrates this, it doesn't
// need every value of every column. Queries stay cheap (aggregates + LIMITs).
// ---------------------------------------------------------------------------

/** Max columns of each kind (categorical / numeric) we profile by default. */
const DEFAULT_MAX_COLUMNS = 12;
/** Hard ceiling regardless of what the model asks for. */
const MAX_COLUMNS_CAP = 40;
/** Top over-/under-represented values reported per categorical column. */
const DEFAULT_MAX_VALUES = 5;
const MAX_VALUES_CAP = 20;
/** Exemplar row ids returned for citation pills. */
const DEFAULT_MAX_EXEMPLARS = 5;
const MAX_EXEMPLARS_CAP = 20;
/**
 * Skip categorical columns with more distinct values than this — free-text /
 * id-like columns (titles, abstracts, uuids) produce noise, not categories.
 * The per-value support floor below also filters most of these out.
 */
const MAX_DISTINCT_FOR_CATEGORICAL = 200;
/**
 * A value must cover at least this fraction of the selection to be reported as
 * "over-represented". Stops single rows in a high-cardinality column from
 * showing up as infinite-lift "distinctive" values.
 */
const MIN_SELECTION_SHARE = 0.02;

// ---------------------------------------------------------------------------
// Result shapes (also the JSON the tool serializes back to the model).
// ---------------------------------------------------------------------------

/** One over-represented (or under-represented) category value. */
export interface CategoricalValueStat {
  value: string | null;
  /** Count of this value within the selection. */
  selectionCount: number;
  /** Count of this value across the whole dataset. */
  totalCount: number;
  /** Share of the selection that has this value (selectionCount / selectionSize). */
  selectionShare: number;
  /** Share of the whole dataset that has this value (totalCount / datasetSize). */
  overallShare: number;
  /**
   * Lift = selectionShare / overallShare. >1 means over-represented in the
   * selection relative to the dataset; <1 under-represented. Capped/rounded.
   */
  lift: number;
}

/** Distinctiveness summary for one categorical column. */
export interface CategoricalColumnStat {
  column: string;
  kind: "categorical";
  /** Top values ordered by descending lift (most distinctive first). */
  topValues: CategoricalValueStat[];
}

/** Distinctiveness summary for one numeric column. */
export interface NumericColumnStat {
  column: string;
  kind: "numeric";
  selectionMean: number | null;
  complementMean: number | null;
  selectionMedian: number | null;
  complementMedian: number | null;
  /**
   * Standardized mean difference (Cohen's d, pooled SD):
   * (selectionMean - complementMean) / pooledStdDev. Positive = selection
   * runs higher than the rest. null when SD is 0 / undefined. Rounded.
   */
  standardizedMeanDifference: number | null;
}

export type ColumnStat = CategoricalColumnStat | NumericColumnStat;

/** The full JSON payload `contrast_selection` returns. */
export interface ContrastResult {
  /** The predicate the selection was scoped to. */
  predicate: string;
  /** Rows matching the predicate (the selection). */
  selectionSize: number;
  /** Rows NOT matching the predicate (the complement / "the rest"). */
  complementSize: number;
  /** Per-column distinctiveness, most-distinctive columns first. */
  columns: ColumnStat[];
  /**
   * A few example row ids from the selection, keyed under the dataset's id
   * column so the chat backend's `_extract_cited_rows` lights up citation
   * pills. (Mirrors retrieve_tool's `rows` contract.)
   */
  exemplars: Array<{ [idColumn: string]: any }>;
}

// ---------------------------------------------------------------------------
// Pure helpers — no coordinator. Factored out so the stat/shaping logic is
// unit-testable without a live database (see contrast_tool.test.ts).
// ---------------------------------------------------------------------------

/** Round to a few significant figures so JSON stays compact and readable. */
export function round(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/** DuckDB returns counts/sums as BigInt; coerce to a JS number (null-safe). */
export function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Partition the host's column descriptors into the categorical and numeric
 * columns we want to profile, honoring an explicit `only` allow-list and a
 * column cap. The id column is excluded from categorical profiling (it's
 * unique by construction and carries no contrast signal). Date columns are
 * treated as numeric-ish only if they came through as a number jsType; we
 * keep this conservative and just handle `string` and `number`.
 */
export function pickColumns(
  columns: ColumnDesc[],
  idColumn: string,
  only: string[] | null,
  maxColumns: number,
): { categorical: ColumnDesc[]; numeric: ColumnDesc[] } {
  const allow = only && only.length > 0 ? new Set(only) : null;
  const eligible = columns.filter((c) => {
    if (allow) return allow.has(c.name);
    return true;
  });
  const categorical = eligible.filter((c) => c.jsType === "string" && c.name !== idColumn).slice(0, maxColumns);
  const numeric = eligible.filter((c) => c.jsType === "number").slice(0, maxColumns);
  return { categorical, numeric };
}

/**
 * Shape the raw per-value GROUP BY rows for one categorical column into the
 * ranked CategoricalValueStat list. Applies the support floor and lift
 * ranking. `rows` carries selectionCount + totalCount per value; sizes are the
 * partition totals. Exported for unit testing.
 */
export function shapeCategoricalColumn(args: {
  column: string;
  rows: Array<{ value: string | null; selectionCount: number; totalCount: number }>;
  selectionSize: number;
  datasetSize: number;
  maxValues: number;
}): CategoricalColumnStat {
  const { column, rows, selectionSize, datasetSize, maxValues } = args;
  const stats: CategoricalValueStat[] = [];
  for (const r of rows) {
    if (r.selectionCount <= 0) continue;
    const selectionShare = selectionSize > 0 ? r.selectionCount / selectionSize : 0;
    if (selectionShare < MIN_SELECTION_SHARE) continue;
    const overallShare = datasetSize > 0 ? r.totalCount / datasetSize : 0;
    // Guard against divide-by-zero: a value present in the selection always has
    // overallShare > 0, but be defensive.
    const lift = overallShare > 0 ? selectionShare / overallShare : Infinity;
    stats.push({
      value: r.value,
      selectionCount: r.selectionCount,
      totalCount: r.totalCount,
      selectionShare: round(selectionShare),
      overallShare: round(overallShare),
      lift: Number.isFinite(lift) ? round(lift, 3) : lift,
    });
  }
  // Most distinctive first (highest lift). Ties broken by selection count so
  // the bigger group wins.
  stats.sort((a, b) => (b.lift === a.lift ? b.selectionCount - a.selectionCount : b.lift - a.lift));
  return { column, kind: "categorical", topValues: stats.slice(0, maxValues) };
}

/**
 * Compute the standardized mean difference (Cohen's d, pooled SD) between the
 * selection and the complement. Returns null when the pooled SD is 0 or any
 * input is missing — a flat column has no meaningful effect size. Exported for
 * unit testing.
 */
export function standardizedMeanDifference(args: {
  selectionMean: number | null;
  complementMean: number | null;
  selectionStdDev: number | null;
  complementStdDev: number | null;
  selectionSize: number;
  complementSize: number;
}): number | null {
  const { selectionMean, complementMean, selectionStdDev, complementStdDev, selectionSize, complementSize } = args;
  if (selectionMean == null || complementMean == null) return null;
  if (selectionStdDev == null || complementStdDev == null) return null;
  const n1 = selectionSize;
  const n2 = complementSize;
  if (n1 + n2 - 2 <= 0) return null;
  // Pooled standard deviation.
  const pooledVar = ((n1 - 1) * selectionStdDev ** 2 + (n2 - 1) * complementStdDev ** 2) / (n1 + n2 - 2);
  const pooled = Math.sqrt(pooledVar);
  if (!Number.isFinite(pooled) || pooled === 0) return null;
  return round((selectionMean - complementMean) / pooled, 3);
}

/**
 * Order numeric column stats by descending absolute effect size so the most
 * distinctive shifts surface first; columns with no computable effect size
 * sink to the bottom. Exported for unit testing.
 */
export function rankNumericColumns(stats: NumericColumnStat[]): NumericColumnStat[] {
  return [...stats].sort((a, b) => {
    const ea = a.standardizedMeanDifference == null ? -1 : Math.abs(a.standardizedMeanDifference);
    const eb = b.standardizedMeanDifference == null ? -1 : Math.abs(b.standardizedMeanDifference);
    return eb - ea;
  });
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function jsonResponse(content: any): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(content) }] };
}

// ---------------------------------------------------------------------------
// The MCP tool. Compute-then-narrate: this tool returns structured stats only;
// the model writes the prose.
// ---------------------------------------------------------------------------

/**
 * Build the `contrast_selection` MCP tool: deterministically computes, in
 * DuckDB via the coordinator, what distinguishes the currently-selected rows
 * (the active cross-filter predicate, or an explicit one) from the rest of the
 * dataset, and returns compact structured stats for the model to narrate.
 */
export function createContrastTool(ctx: ContrastToolContext): MCPTool {
  return {
    name: "contrast_selection",
    description: `Compute, deterministically in SQL, WHAT DISTINGUISHES the currently-selected rows (the active cross-filter selection) from the REST of the dataset (the complement). Returns compact structured stats — over-represented category values and numeric distribution shifts per column, plus a few exemplar row ids — for you to NARRATE. This tool does NOT write prose; you turn its numbers into a sentence or two.

This is the "what's different about these rows?" / "characterize this cluster" tool. Use it when the user has a selection (lassoed a cluster, applied a filter) and asks what makes those rows special, what they have in common, how they differ from everything else, or to "describe / explain / summarize this cluster vs the rest".

WHEN TO USE contrast_selection:
  ✅ "What's different about these rows?" / "What distinguishes this cluster?"
  ✅ "Why is this group separate from the rest?" / "What do the selected papers have in common vs the others?"
  ✅ "Characterize my current selection compared to the dataset."

WHEN NOT TO USE:
  ❌ A plain count / aggregate of the selection ("how many are from 2023?") → run_sql_query.
  ❌ Content/meaning questions ("what do these say about X?") → retrieve.
  ❌ Comparing two explicit groups you both name — this tool is strictly selection-vs-complement (it can take ONE explicit predicate as the selection, the complement is always "everything else").

SELECTION SCOPING: by default the tool uses the user's CURRENT cross-filter selection (the same WHERE predicate every chart respects). If there is no active selection it errors — ask the user to select rows, or pass an explicit 'predicate' to define the group to contrast against the rest. Pass 'predicate' only when the user describes the group as a condition ("contrast year>2020 against the rest") rather than using their live selection.

For categorical columns it reports the most OVER-REPRESENTED values by lift (= selection share ÷ overall share; lift 3.0 means a value is 3× as common in the selection as in the dataset), with counts. For numeric columns it reports mean/median in the selection vs the complement plus a standardized mean difference (Cohen's d; positive = selection runs higher). Output is capped (top columns/values) to stay compact.

Returns JSON: { predicate, selectionSize, complementSize, columns: [{ column, kind: "categorical", topValues: [{ value, selectionCount, totalCount, selectionShare, overallShare, lift }] } | { column, kind: "numeric", selectionMean, complementMean, selectionMedian, complementMedian, standardizedMeanDifference }], exemplars: [{ <id> }] }. The 'exemplars' carry row ids already wired to citation pills — cite a couple when you narrate. Narrate the strongest signals (highest lift, largest |standardizedMeanDifference|); don't recite every column.`,
    inputSchema: {
      type: "object",
      properties: {
        predicate: {
          type: "string",
          description:
            "Optional DuckDB SQL boolean expression defining the SELECTION to contrast against the rest of the dataset (e.g. \"year > 2020 AND domain = 'protein_design'\"). If omitted, the user's current cross-filter selection is used; if there is no active selection and no predicate, the tool errors.",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional allow-list of column names to profile. If omitted, the tool auto-selects eligible categorical (string) and numeric columns. Use this to focus on columns the user cares about.",
        },
        max_columns: {
          type: "integer",
          description: `Max columns of each kind (categorical / numeric) to profile. Default ${DEFAULT_MAX_COLUMNS}, max ${MAX_COLUMNS_CAP}.`,
        },
        max_values: {
          type: "integer",
          description: `Top over-represented values to report per categorical column. Default ${DEFAULT_MAX_VALUES}, max ${MAX_VALUES_CAP}.`,
        },
        max_exemplars: {
          type: "integer",
          description: `How many exemplar row ids from the selection to return for citation pills. Default ${DEFAULT_MAX_EXEMPLARS}, max ${MAX_EXEMPLARS_CAP}.`,
        },
      },
      additionalProperties: false,
    },
    execute: async (params: {
      predicate?: string;
      columns?: string[];
      max_columns?: number;
      max_values?: number;
      max_exemplars?: number;
    }): Promise<ToolResponse> => {
      // 1. Resolve the selection predicate: explicit arg, else the live
      //    cross-filter predicate. No predicate at all → nothing to contrast.
      const explicit = typeof params?.predicate === "string" ? params.predicate.trim() : "";
      const predicate = explicit !== "" ? explicit : ctx.currentPredicate();
      if (predicate == null || predicate === "") {
        return jsonResponse({
          error:
            "contrast_selection: there is no active selection to contrast. Ask the user to select rows (lasso a region or apply a filter), or pass an explicit `predicate` describing the group to compare against the rest of the dataset.",
        });
      }

      const maxColumns = clampInt(params?.max_columns, DEFAULT_MAX_COLUMNS, 1, MAX_COLUMNS_CAP);
      const maxValues = clampInt(params?.max_values, DEFAULT_MAX_VALUES, 1, MAX_VALUES_CAP);
      const maxExemplars = clampInt(params?.max_exemplars, DEFAULT_MAX_EXEMPLARS, 1, MAX_EXEMPLARS_CAP);
      const only = Array.isArray(params?.columns) ? params.columns.filter((c) => typeof c === "string") : null;

      const table = ctx.table;
      const sel = `(${predicate})`; // selection membership flag

      // 2. Partition sizes in one pass. Validates the predicate as a side
      //    effect (a bad predicate throws here and we report it).
      let selectionSize = 0;
      let datasetSize = 0;
      try {
        const sizes = (
          await ctx.coordinator.query(`SELECT COUNT(*) FILTER (WHERE ${sel}) AS sel, COUNT(*) AS total FROM ${table}`)
        ).get(0);
        selectionSize = toNum(sizes.sel) ?? 0;
        datasetSize = toNum(sizes.total) ?? 0;
      } catch (e: any) {
        const detail = e?.message ?? e?.toString?.() ?? String(e);
        return jsonResponse({
          error: `contrast_selection: the predicate could not be evaluated as a DuckDB SQL boolean expression. Details: ${detail}. Use get_data_schema to confirm column names and types.`,
          predicate,
        });
      }
      const complementSize = datasetSize - selectionSize;
      if (selectionSize === 0) {
        return jsonResponse({
          error: "contrast_selection: the selection is empty (0 rows match the predicate); nothing to contrast.",
          predicate,
          selectionSize,
          complementSize,
        });
      }
      if (complementSize === 0) {
        return jsonResponse({
          error:
            "contrast_selection: the selection covers the ENTIRE dataset (the complement is empty); there is nothing to contrast it against. Narrow the selection.",
          predicate,
          selectionSize,
          complementSize,
        });
      }

      const { categorical, numeric } = pickColumns(ctx.columns(), ctx.idColumn, only, maxColumns);

      const columnStats: ColumnStat[] = [];

      // 3. Categorical columns: per-value selection/total counts via one
      //    grouped aggregate per column. Skip high-cardinality (free-text/id)
      //    columns up front so we don't scan a million distinct titles.
      for (const col of categorical) {
        const c = SQL.column(col.name).toString();
        try {
          const distinct = toNum(
            (await ctx.coordinator.query(`SELECT COUNT(DISTINCT ${c}) AS n FROM ${table}`)).get(0).n,
          );
          if (distinct == null || distinct > MAX_DISTINCT_FOR_CATEGORICAL) continue;

          // One pass: per value, count within selection and overall. Order by
          // selection count and cap the rows pulled back — lift ranking happens
          // in the (pure) shaper.
          const rows = (
            await ctx.coordinator.query(
              `SELECT ${c} AS value, COUNT(*) FILTER (WHERE ${sel}) AS sel_count, COUNT(*) AS total_count
               FROM ${table}
               GROUP BY ${c}
               HAVING COUNT(*) FILTER (WHERE ${sel}) > 0
               ORDER BY sel_count DESC
               LIMIT ${MAX_DISTINCT_FOR_CATEGORICAL}`,
            )
          ).toArray() as Array<{ value: any; sel_count: any; total_count: any }>;

          const shaped = shapeCategoricalColumn({
            column: col.name,
            rows: rows.map((r) => ({
              value: r.value == null ? null : String(r.value),
              selectionCount: toNum(r.sel_count) ?? 0,
              totalCount: toNum(r.total_count) ?? 0,
            })),
            selectionSize,
            datasetSize,
            maxValues,
          });
          // Only keep columns that actually carry a distinctive value
          // (lift > 1); a column whose top value matches the base rate adds
          // noise for the narrator.
          if (shaped.topValues.some((v) => v.lift > 1)) {
            columnStats.push(shaped);
          }
        } catch {
          // A column that fails to aggregate (odd type/name) is skipped rather
          // than failing the whole tool.
          continue;
        }
      }

      // 4. Numeric columns: mean/median/stddev for selection and complement in
      //    one grouped pass, then a pure effect-size computation.
      const numericStats: NumericColumnStat[] = [];
      for (const col of numeric) {
        const c = SQL.column(col.name).toString();
        try {
          const row = (
            await ctx.coordinator.query(
              `SELECT
                 AVG(${c}) FILTER (WHERE ${sel}) AS sel_mean,
                 AVG(${c}) FILTER (WHERE NOT ${sel}) AS comp_mean,
                 MEDIAN(${c}) FILTER (WHERE ${sel}) AS sel_median,
                 MEDIAN(${c}) FILTER (WHERE NOT ${sel}) AS comp_median,
                 STDDEV_SAMP(${c}) FILTER (WHERE ${sel}) AS sel_sd,
                 STDDEV_SAMP(${c}) FILTER (WHERE NOT ${sel}) AS comp_sd
               FROM ${table}`,
            )
          ).get(0);

          const selectionMean = toNum(row.sel_mean);
          const complementMean = toNum(row.comp_mean);
          const smd = standardizedMeanDifference({
            selectionMean,
            complementMean,
            selectionStdDev: toNum(row.sel_sd),
            complementStdDev: toNum(row.comp_sd),
            selectionSize,
            complementSize,
          });
          numericStats.push({
            column: col.name,
            kind: "numeric",
            selectionMean: selectionMean == null ? null : round(selectionMean),
            complementMean: complementMean == null ? null : round(complementMean),
            selectionMedian: (() => {
              const v = toNum(row.sel_median);
              return v == null ? null : round(v);
            })(),
            complementMedian: (() => {
              const v = toNum(row.comp_median);
              return v == null ? null : round(v);
            })(),
            standardizedMeanDifference: smd,
          });
        } catch {
          continue;
        }
      }
      // Most distinctive numeric shifts first.
      columnStats.push(...rankNumericColumns(numericStats));

      // 5. Exemplars: a handful of selection row ids for citation pills, keyed
      //    under the id column (same contract as retrieve_tool's `rows`).
      let exemplars: Array<{ [k: string]: any }> = [];
      try {
        const idc = SQL.column(ctx.idColumn).toString();
        const ex = (
          await ctx.coordinator.query(`SELECT ${idc} AS id FROM ${table} WHERE ${sel} LIMIT ${maxExemplars}`)
        ).toArray() as Array<{ id: any }>;
        exemplars = ex.map((r) => ({ [ctx.idColumn]: r.id }));
      } catch {
        exemplars = [];
      }

      const result: ContrastResult = {
        predicate,
        selectionSize,
        complementSize,
        columns: columnStats,
        exemplars,
      };
      return jsonResponse(result);
    },
  };
}
