// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { MCPTool, ToolResponse } from "../app/mcp_server.js";
import type { Searcher } from "../api.js";
import { querySearchResultItems, type SearchResultItem } from "../search/search.js";

/**
 * Dependencies the `retrieve` tool needs from the host (EmbeddingAtlas).
 * Kept as getters so the tool always reads the *current* searcher /
 * predicate / column config at call time (these can change as the user
 * loads data or edits filters between turns).
 */
export interface RetrieveToolContext {
  /** The resolved searcher (must expose `hybridSearch` for retrieve to work). */
  searcher: Searcher;
  /** Mosaic coordinator, for hydrating hit text/x/y via querySearchResultItems. */
  coordinator: import("@uwdata/mosaic-core").Coordinator;
  /** Main data table name. */
  table: string;
  /** Row-id column name. */
  idColumn: string;
  /** Primary text column, or null if the dataset has no text column. */
  textColumn: string | null;
  /** Projection x column, if cheap to include. */
  xColumn?: string | null;
  /** Projection y column, if cheap to include. */
  yColumn?: string | null;
  /** The current cross-filter predicate as a SQL string, or null if no selection. */
  currentPredicate(): string | null;
}

/** Hard cap on `k` so a runaway argument can't try to hydrate the whole table. */
const MAX_K = 50;
/** Default `k` when the model omits it. Small enough to keep replies focused. */
const DEFAULT_K = 8;
/** Snippet length cap (chars) for the per-hit `text` we feed back to the model. */
const SNIPPET_MAX_LEN = 600;

/** One retrieved row, shaped for both the model and the citation-pill pipeline. */
export interface RetrieveRow {
  /** The row id, keyed under the dataset's id column (see `shapeRetrieveResult`). */
  [key: string]: any;
  /** Fused-rank distance (1 - cosine); smaller = closer. Omitted when unavailable. */
  distance?: number;
  /** Snippet of the row's text column (truncated). */
  text?: string;
  /** Projection x, when an x column was configured. */
  x?: number;
  /** Projection y, when a y column was configured. */
  y?: number;
}

/** The full JSON payload the tool returns. `rows` is the cited-rows surface. */
export interface RetrieveResult {
  query: string;
  k: number;
  within_selection: boolean;
  /** Active predicate the retrieval was scoped to, or null. Echoed for transparency. */
  predicate: string | null;
  /** Number of hits returned (== rows.length). */
  count: number;
  /**
   * Ranked hits. Each row carries the id under `idColumn` plus a text
   * snippet (and x/y). The chat backend's `_extract_cited_rows` parses
   * this array (envelope `{ rows: [...] }`) and lights up citation pills
   * automatically — no extra plumbing needed.
   */
  rows: RetrieveRow[];
}

function truncate(text: string | null | undefined, max: number): string | undefined {
  if (text == null) return undefined;
  const s = String(text);
  if (s.length === 0) return undefined;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Pure shaper: hydrated `SearchResultItem`s → the `RetrieveResult` JSON.
 * Split out from the tool body so it can be unit-tested without a live
 * coordinator/searcher. Keys each row's id under `idColumn` so the
 * backend's `_extract_cited_rows` (which looks for the configured id
 * column) picks it up.
 */
export function shapeRetrieveResult(args: {
  query: string;
  k: number;
  withinSelection: boolean;
  predicate: string | null;
  idColumn: string;
  items: SearchResultItem[];
}): RetrieveResult {
  const { query, k, withinSelection, predicate, idColumn, items } = args;
  const rows: RetrieveRow[] = items.map((item) => {
    const row: RetrieveRow = { [idColumn]: item.id };
    if (item.distance != null) row.distance = item.distance;
    const snippet = truncate(item.text, SNIPPET_MAX_LEN);
    if (snippet != null) row.text = snippet;
    if (item.x != null) row.x = item.x;
    if (item.y != null) row.y = item.y;
    return row;
  });
  return {
    query,
    k,
    within_selection: withinSelection,
    predicate,
    count: rows.length,
    rows,
  };
}

function clampK(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_K;
  if (n < 1) return 1;
  if (n > MAX_K) return MAX_K;
  return n;
}

/**
 * Build the `retrieve` MCP tool. Semantic + lexical content retrieval
 * over the dataset's text column, scoped (by default) to the user's
 * current selection. Wraps the existing `Searcher.hybridSearch`
 * (BM25 + cosine + RRF) and hydrates each hit's text/id/x/y, returning a
 * payload whose `rows` array doubles as the citation-pill source.
 */
export function createRetrieveTool(ctx: RetrieveToolContext): MCPTool {
  return {
    name: "retrieve",
    description: `Retrieve the most relevant ROWS from the dataset by MEANING for a natural-language query, using hybrid search (lexical BM25 + embedding-vector similarity, RRF-fused). Returns ranked rows with a text snippet + the row id, and lights up clickable citation pills under your reply so the user can jump to each cited row in the embedding and table.

WHEN TO USE retrieve (content / semantic questions):
  ✅ "What do these papers say about antibody design?"
  ✅ "Find rows discussing protein folding stability."
  ✅ "Which entries are most relevant to CRISPR off-target effects?"
  ✅ "Summarize the documents about diffusion models." (retrieve first, then summarize the snippets)
  ✅ Any question whose answer lives in the free-text content of rows, where exact keywords are unknown / fuzzy / synonym-laden.

WHEN NOT TO USE retrieve — use run_sql_query instead (aggregates / structure / exact filters):
  ❌ "How many rows are from 2023?" → run_sql_query (COUNT)
  ❌ "Top 5 most-cited papers" → run_sql_query (ORDER BY times_cited)
  ❌ "Rows where domain = 'protein_design'" → run_sql_query (exact column match)
  ❌ Counts, sums, group-bys, sorting by a numeric column, exact equality filters.
Rule of thumb: retrieve answers "which rows are ABOUT X?"; run_sql_query answers "which rows MATCH structured condition Y / what's the aggregate?".

SELECTION SCOPING: by default (within_selection = true) retrieval is restricted to the user's current cross-filter selection (the same WHERE predicate every chart respects), so results stay consistent with what the user is looking at. Set within_selection = false to search the WHOLE dataset, ignoring the current selection — do this only when the user explicitly asks to search everything / "ignore my filter".

Returns JSON: { query, k, within_selection, predicate, count, rows: [{ <id>, distance, text, x, y }, ...] } ranked best-first (smaller distance = closer). The rows are already wired to citation pills — you do NOT need to call run_sql_query afterward to "get the ids". Cite the returned snippets directly.

Not available when the dataset has no text column (this tool will report that); fall back to run_sql_query in that case.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Natural-language query describing the content you want to find (e.g. "papers about antibody affinity maturation"). Free text, not SQL.',
        },
        k: {
          type: "integer",
          description: `How many rows to return, best-first. Default ${DEFAULT_K}, max ${MAX_K}. Keep small (5–10) unless the user asks for a broad sweep.`,
        },
        within_selection: {
          type: "boolean",
          description:
            "If true (default), scope retrieval to the user's current cross-filter selection. Set false to search the entire dataset, ignoring the active filter.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (params: { query?: string; k?: number; within_selection?: boolean }): Promise<ToolResponse> => {
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      if (query === "") {
        return jsonResponse({
          error: "retrieve failed: `query` must be a non-empty natural-language string.",
        });
      }

      if (ctx.textColumn == null) {
        return jsonResponse({
          error:
            "retrieve is unavailable: this dataset has no text column to search. Use run_sql_query for structured questions.",
        });
      }
      if (ctx.searcher.hybridSearch == null) {
        return jsonResponse({
          error:
            "retrieve is unavailable: no hybrid searcher is configured for this dataset. Use run_sql_query instead.",
        });
      }

      const k = clampK(params?.k);
      // Default true; only false when the model explicitly opts out.
      const withinSelection = params?.within_selection !== false;
      const predicate = withinSelection ? ctx.currentPredicate() : null;

      // 1. Hybrid retrieval (BM25 + cosine + RRF), scoped to the predicate.
      const hits = await ctx.searcher.hybridSearch(query, {
        limit: k,
        predicate,
      });

      // 2. Hydrate id + text (+ x/y) for each hit. We pass the same
      //    predicate so hydration can't surface rows outside the
      //    selection even if the searcher ignored it.
      const items = await querySearchResultItems(
        ctx.coordinator,
        ctx.table,
        { id: ctx.idColumn, x: ctx.xColumn, y: ctx.yColumn, text: ctx.textColumn },
        null,
        predicate,
        hits,
      );

      // 3. Shape into the cited-rows-friendly payload.
      const result = shapeRetrieveResult({
        query,
        k,
        withinSelection,
        predicate,
        idColumn: ctx.idColumn,
        items,
      });
      return jsonResponse(result);
    },
  };
}

function jsonResponse(content: any): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(content) }] };
}
