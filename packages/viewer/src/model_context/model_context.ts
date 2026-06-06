// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { mergeUpdates } from "@embedding-atlas/utils";
import * as SQL from "@uwdata/mosaic-sql";
import { validate } from "json-schema";
import type { MCPTool, ModelContextAPI, ToolResponse } from "../app/mcp_server.js";
import type { ChartContext, ChartDelegate } from "../charts/chart.js";
import { renderersList } from "../renderers/renderer_types.js";
import type { ColumnStyle } from "../renderers/types.js";
import {
  schemaBuiltinChartSpec,
  schemaBuiltinChartState,
  schemaColumnStyle,
  schemaDashboardLayoutState,
  schemaListLayoutState,
} from "../schemas.js";
import { findUnusedId } from "../utils/identifier.js";
import { screenshot, type ScreenshotOptions } from "../utils/screenshot.js";
import { validateChartSpec } from "./chart_spec_guard.js";
import { createRetrieveTool, type RetrieveToolContext } from "./retrieve_tool.js";
import { visionTools } from "./vision_tools.js";

/** Default name used by apply_filter when the model omits the `name` parameter. */
const DEFAULT_FILTER_NAME = "Chat Filter";

interface PredicateItem {
  name: string;
  predicate: string;
}

/**
 * Detect a 1D distribution layer: one axis is binned/plain field, the other
 * is a count/sum/etc aggregate, and there is no explicit range encoding.
 */
function isHistogramLayer(layer: any): "x" | "y" | null {
  if (!layer?.encoding) return null;
  const enc = layer.encoding;
  if (enc.y1 != null || enc.y2 != null || enc.x1 != null || enc.x2 != null) return null;
  const yIsAggregate = enc.y && "aggregate" in enc.y;
  const xIsAggregate = enc.x && "aggregate" in enc.x;
  if (yIsAggregate && !xIsAggregate) return "x"; // x is the binned/categorical axis
  if (xIsAggregate && !yIsAggregate) return "y";
  return null;
}

/**
 * Rewrite an eCDF layer that puts the field on x as a plain encoding (the
 * shape models tend to emit) into the canonical {x: ecdf-value, y: ecdf-rank}
 * pair. Without this, the layered runtime treats x as a grouping key and
 * draws a sawtooth that connects unrelated samples.
 *
 * Triggers when y has aggregate ecdf-rank and x is a plain field. Lifts the
 * field name from x onto x.aggregate = ecdf-value so the runtime computes
 * quantile_disc bounds for both axes against the same column.
 */
function normalizeEcdfLayer(layer: any): any {
  const enc = layer?.encoding;
  if (!enc) return layer;
  const yIsEcdfRank = enc.y && (enc.y as any).aggregate === "ecdf-rank";
  const xIsPlainField = enc.x && "field" in enc.x && !("aggregate" in enc.x) && (enc.x as any).bin == null;
  if (!yIsEcdfRank || !xIsPlainField) return layer;
  const xField = (enc.x as any).field;
  return {
    ...layer,
    encoding: {
      ...enc,
      x: { aggregate: "ecdf-value", field: xField },
    },
  };
}

/**
 * Apply safety nets to model-emitted inline-chart specs:
 *
 *   1. Rewrite layers that use mark: "rect" for a 1D distribution into
 *      mark: "bar". The Mosaic runtime renders rect marks using y1/y2; when
 *      only a single scalar y aggregate is provided every rect has height 0
 *      and the chart looks blank. Heatmaps (both axes are fields with a
 *      color aggregate) are untouched.
 *
 *   2. Rewrite a partial eCDF layer (y: ecdf-rank, x: plain field) to the
 *      canonical {x: ecdf-value, y: ecdf-rank} shape. Saves the user from
 *      the sawtooth garbage that results when x stays a grouping key.
 *
 *   3. Auto-inject a scale.type widget on the binned axis of histogram-
 *      shaped layers when the spec has no widgets defined. Models often
 *      omit `widgets`, so the user loses the linear/log/symlog dropdown
 *      they got on a previous turn for a structurally identical chart.
 *      Adding the widget at the entry point keeps the affordance reliable.
 */
function normalizeChartSpec(spec: any): any {
  if (!spec || !Array.isArray(spec.layers)) return spec;
  let changed = false;
  let histogramAxis: "x" | "y" | null = null;
  const layers = spec.layers.map((layer: any) => {
    const ecdfFixed = normalizeEcdfLayer(layer);
    if (ecdfFixed !== layer) {
      changed = true;
      layer = ecdfFixed;
    }
    const axis = isHistogramLayer(layer);
    if (axis != null) histogramAxis ??= axis;
    if (layer?.mark === "rect" && axis != null) {
      changed = true;
      return { ...layer, mark: "bar" };
    }
    return layer;
  });
  let result = changed ? { ...spec, layers } : spec;
  if (histogramAxis != null && (!result.widgets || result.widgets.length === 0)) {
    result = { ...result, widgets: [{ type: "scale.type", channel: histogramAxis }] };
  }
  return result;
}

/** Find the id of the singleton SQL Predicates panel chart, or null if none. */
function findPredicatesChartId(charts: Record<string, any>): string | null {
  for (const [id, spec] of Object.entries(charts)) {
    if (spec && (spec as any).type === "predicates") {
      return id;
    }
  }
  return null;
}

export interface ModelContextDelegate {
  context: ChartContext;
  charts: Record<string, any>;
  chartStates: Record<string, any>;
  layout: string;
  layoutStates: Record<string, any>;
  chartDelegates: Map<string, Set<ChartDelegate>>;
  container: HTMLDivElement;
  columnStyles: Record<string, ColumnStyle>;
  /**
   * Wiring for the `retrieve` content-retrieval tool (searcher +
   * coordinator + current predicate). See `retrieve_tool.ts`.
   */
  retrieve: RetrieveToolContext;
}

export function provideModelContext(api: ModelContextAPI, delegate: ModelContextDelegate) {
  let screenshotOptions: ScreenshotOptions = { maxWidth: 1568, maxHeight: 1568, pixelRatio: 2 };

  let tools: MCPTool[] = [
    {
      name: "get_data_schema",
      description: "Get the table name and columns",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async () => {
        return jsonResponse({
          table: delegate.context.table,
          columns: delegate.context.columns,
        });
      },
    },
    {
      name: "run_sql_query",
      description: `Run a read-only SQL query against the dataset. Returns rows as JSON.

CITATION PILLS — when your query selects per-row data from the main table (rather than aggregates), **always include the row-id column "${delegate.context.id}" in your SELECT clause**. The chat UI uses these IDs to render clickable citation pills under the assistant's reply that let the user reveal the corresponding row in the embedding and the table. Without this column the answer is still valid but the user can't click through to verify.

Examples:
  ✅ SELECT "${delegate.context.id}", title, year FROM dataset ORDER BY times_cited DESC LIMIT 5
  ✅ SELECT "${delegate.context.id}", title FROM dataset WHERE domain = 'protein_design'
  ❌ SELECT title, year FROM dataset ORDER BY times_cited DESC LIMIT 5    (no row id → no pills)

For aggregate queries (COUNT, SUM, GROUP BY without per-row identity), there are no row IDs to cite — just write the aggregate, no need for "${delegate.context.id}".`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `A read-only SELECT or WITH statement. No trailing semicolon, no DDL, no writes. Include "${delegate.context.id}" in row-level SELECTs to enable citation pills.`,
          },
        },
        additionalProperties: false,
      },
      execute: async (params: { query: string }) => {
        const result = await delegate.context.coordinator.query(params.query);
        return jsonResponse(result.toArray());
      },
    },
    // Content / semantic retrieval over the text column (hybrid BM25 +
    // vector). Lives in its own module; returns rows shaped for the
    // citation-pill pipeline.
    createRetrieveTool(delegate.retrieve),
    {
      name: "list_renderers",
      description:
        "Get a list of value renderers to display values in the table, cards, or tooltip. Renderers can be set in ColumnStyle",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async () => {
        return jsonResponse(renderersList);
      },
    },
    {
      name: "get_column_styles",
      description: "Get column styles for all columns.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async () => {
        return jsonResponse(delegate.columnStyles);
      },
    },
    {
      name: "set_column_style",
      description: `Update specific fields of a column's style. Only fields you explicitly want to change should be included in 'style'; other fields will be preserved. To remove a field, set it to null.`,
      inputSchema: {
        type: "object",
        properties: {
          column: { type: "string" },
          style: {
            type: "object",
            description: `Patch to apply to the column style. Merged with the existing style. Schema: ${JSON.stringify(schemaColumnStyle)}. Use the list_renderers tool to get the list of renderers.`,
          },
        },
        additionalProperties: false,
      },
      execute: async (params: { column: string; style: any }) => {
        const current = delegate.columnStyles[params.column] ?? ({} as ColumnStyle);
        const merged = mergeUpdates(current, params.style) ?? current;
        delegate.columnStyles = { ...delegate.columnStyles, [params.column]: merged };
        return textResponse("success");
      },
    },
    {
      name: "list_charts",
      description: "List all charts in Embedding Atlas.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async () => {
        return jsonResponse(delegate.charts);
      },
    },
    {
      name: "add_chart",
      description: "Create a new chart with the specification, returns the id of the new chart.",
      inputSchema: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description: `
                The chart specification. Schema: ${JSON.stringify(schemaBuiltinChartSpec)}.
                Notes:
                - The data might be very large (>100k) points. Try not to create a chart that has no aggregation.
                - Add "filter": "$filter" to appropriate layers to make the chart respond to filters from other charts. The filter is a cross-filter.
                - When creating a chart, consider adding interactivity to it.
                - The plot size is determined by the chart container by default. Refrain from setting it directly.
                - Before adding a new chart, please list existing charts with list_charts at least once to ensure no duplication.
              `,
          },
        },
        additionalProperties: false,
      },
      execute: async (params: { spec: any }) => {
        // Security gate: reject unknown chart types, prototype-pollution keys,
        // and non-read-only embedded SQL before the schema (shape) check.
        const guard = validateChartSpec(params.spec);
        if (!guard.ok) {
          return jsonResponse({ error: "Spec rejected", details: guard.error });
        }
        // Validate schema.
        let validateResult = validate(params.spec, schemaBuiltinChartSpec);
        if (validateResult.valid) {
          let id = findUnusedId(delegate.charts);
          delegate.charts = { ...delegate.charts, [id]: params.spec };
          return jsonResponse({ id: id });
        } else {
          return jsonResponse({ error: "Spec is invalid", details: validateResult.errors });
        }
      },
    },
    {
      name: "render_chart_in_chat",
      description: `Render a chart INLINE in the chat conversation as a live, interactive Mosaic chart. The chart appears in the assistant's reply bubble; the user can hover/tooltip and the chart cross-filters with the rest of the dashboard. The chart is ephemeral by default (lives only in the chat history), but the user can click an "Add to panel" affordance on the chart to promote it to a persistent side-panel chart.

When to use:
  ✅ User asks a visual question best answered with a chart in-line ("show me the distribution of times_cited", "compare paper counts by domain", "what's the histogram of years?"). Use this so the answer is the chart itself.
  ❌ User asks to add a chart to their dashboard / side panel ("add a histogram of years to my dashboard", "create a chart of …"). For that, use add_chart instead — that tool mutates the side-panel chart list.

The 'spec' argument is the SAME shape add_chart accepts (full BuiltinChartSpec). Schema: ${JSON.stringify(schemaBuiltinChartSpec)}.

Mark choice (CRITICAL — wrong marks render as invisible 0-height shapes):
  - 1D distribution / histogram of a numeric field → mark: "bar" with encoding x: {field, bin: {desiredCount}}, y: {aggregate: "count"}.
  - Categorical counts → use {type: "count-plot", data: {field}} (the dedicated chart type, no layers needed).
  - 2D heatmap (x AND y both binned/categorical) → mark: "rect" with color: {aggregate: "count"}.
  - Line / time series → mark: "line".
  - Scatter / bubble → mark: "point".
  Do NOT use mark: "rect" for a 1D histogram — rects need x1/x2 or y1/y2 ranges; without them they render as 1-pixel marks. Use "bar" instead.

Examples:
  Histogram of times_cited:
    {"layers": [{"mark": "bar", "filter": "$filter", "encoding": {"x": {"field": "times_cited", "bin": {"desiredCount": 40}}, "y": {"aggregate": "count"}}}], "selection": {"brush": {"encoding": "x"}}}
  Count of papers per domain (categorical):
    {"type": "count-plot", "data": {"field": "domain"}}
  2D heatmap year × domain:
    {"layers": [{"mark": "rect", "filter": "$filter", "encoding": {"x": {"field": "year"}, "y": {"field": "domain"}, "color": {"aggregate": "count"}}}]}

Notes:
  - The data may be very large (>100k points). Prefer specs that aggregate (count-plot, histogram, heatmap) over per-row marks.
  - Add "filter": "$filter" to layers so the inline chart cross-filters with the rest of the dashboard. Highly recommended.
  - Do NOT set explicit width/height — the chat UI sizes the chart for the bubble.
  - On invalid spec the tool returns a textual error; no chart is rendered. Inspect schema and retry.
  - This tool does NOT add the chart to the side panel (use add_chart for that). The user can promote the inline chart manually if they want to keep it.`,
      inputSchema: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description:
              "The chart specification. Same shape as add_chart's spec. Prefer aggregating chart types (count-plot, histogram, heatmap). Wire layers to '$filter' so the chart cross-filters with the rest of the dashboard.",
          },
        },
        required: ["spec"],
        additionalProperties: false,
      },
      execute: async (params: { spec: any }) => {
        // Security gate: reject unknown chart types, prototype-pollution keys,
        // and non-read-only embedded SQL before shape validation / rendering.
        const guard = validateChartSpec(params.spec);
        if (!guard.ok) {
          return jsonResponse({
            error: "Spec rejected; no chart was rendered.",
            details: guard.error,
          });
        }
        const validateResult = validate(params.spec, schemaBuiltinChartSpec);
        if (!validateResult.valid) {
          return jsonResponse({
            error: "Spec is invalid; no chart was rendered.",
            details: validateResult.errors,
          });
        }
        // Normalize before emitting. The model frequently picks mark: "rect"
        // for 1D histograms; without y1/y2 those render as 0-height marks.
        // Rewrite the obvious "1D distribution" pattern to mark: "bar" so the
        // chart actually renders. Updated tool description is not enough —
        // the model habitually chooses rect even with explicit ❌ examples.
        const normalized = normalizeChartSpec(params.spec);
        // Emit a `chart` content block. The backend bridge passes this through
        // to the SSE stream verbatim (so the chat UI can mount InlineChartView)
        // and substitutes a text placeholder for the Anthropic tool_result
        // history (since the API only accepts text/image blocks).
        return { content: [{ type: "chart", spec: normalized }] };
      },
    },
    {
      name: "get_chart_spec",
      description: "Get the specification of a chart",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string; spec: any }) => {
        return jsonResponse(delegate.charts[params.id]);
      },
    },
    {
      name: "set_chart_spec",
      description: `Update specific fields of a chart's specification. Only fields you explicitly want to change should be included in 'spec'; other fields (mode, pointSize, title, etc.) will be preserved. To remove a field, set it to null. Example — recolor an embedding by a new column: { id: '1', spec: { data: { category: 'domain' } } }. Do NOT include fields the user did not ask to change.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          spec: { type: "object", description: "Patch to apply to the chart spec. Merged with the existing spec." },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string; spec: any }) => {
        const current = delegate.charts[params.id] ?? {};
        const merged = (mergeUpdates(current, params.spec) ?? current) as Record<string, any>;
        // Validate the merged result so partial patches are still type-checked
        // against the full chart spec schema.
        let validateResult = validate(merged, schemaBuiltinChartSpec);
        if (validateResult.valid) {
          delegate.charts = { ...delegate.charts, [params.id]: merged };
          return textResponse("success");
        } else {
          return jsonResponse({ error: "Resulting spec is invalid", details: validateResult.errors });
        }
      },
    },
    {
      name: "get_chart_state",
      description: "Get the state of a chart",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string }) => {
        return jsonResponse(delegate.chartStates[params.id] ?? {});
      },
    },
    {
      name: "set_chart_state",
      description: `Update specific fields of a chart's state. Only fields you explicitly want to change should be included in 'state'; other fields (viewport, brush, legend selection) will be preserved. To remove a field, set it to null. Schema: ${JSON.stringify(schemaBuiltinChartState)}.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          state: { type: "object", description: "Patch to apply to the chart state. Merged with the existing state." },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string; state: any }) => {
        const current = delegate.chartStates[params.id] ?? {};
        const merged = (mergeUpdates(current, params.state) ?? current) as Record<string, any>;
        delegate.chartStates = { ...delegate.chartStates, [params.id]: merged };
        return textResponse("success");
      },
    },
    {
      name: "clear_chart_state",
      description: "Clear the state of a chart",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string; state: any }) => {
        delegate.chartStates = { ...delegate.chartStates, [params.id]: {} };
        return textResponse("success");
      },
    },
    {
      name: "delete_chart",
      description: "Delete a chart",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string; spec: any }) => {
        delegate.charts = Object.fromEntries(Object.entries(delegate.charts).filter((x) => x[0] != params.id));
        delegate.chartStates = Object.fromEntries(
          Object.entries(delegate.chartStates).filter((x) => x[0] != params.id),
        );
        return textResponse("success");
      },
    },
    {
      name: "get_chart_screenshot",
      description: "Get a screenshot of a chart",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { id: string }) => {
        let items = delegate.chartDelegates.get(params.id);
        if (items != null) {
          for (let chart of items) {
            if (chart.screenshot) {
              let image = await chart.screenshot(screenshotOptions);
              return imageResponse(image);
            }
          }
        }
        return textResponse("chart does not support taking screenshot");
      },
    },
    {
      name: "get_layout_type",
      description: "Get the type of the current layout ('list' or 'dashboard')",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        return textResponse(delegate.layout);
      },
    },
    {
      name: "set_layout_type",
      description: "Set the type of the current layout ('list' or 'dashboard')",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (params: { type: string }) => {
        delegate.layout = params.type;
        return textResponse("success");
      },
    },
    {
      name: "get_layout_state",
      description: "Get the state of the current layout",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        return jsonResponse(delegate.layoutStates[delegate.layout] ?? {});
      },
    },
    {
      name: "set_layout_state",
      description: `Update specific fields of the current layout's state. Only fields you explicitly want to change should be included in 'state'; other fields will be preserved. To remove a field, set it to null.`,
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "object",
            description: `Patch to apply to the layout state. Merged with the existing state.
                Schema:
                - dashboard layout state: ${JSON.stringify(schemaDashboardLayoutState)}
                - list layout state: ${JSON.stringify(schemaListLayoutState)}
              `,
          },
        },
        additionalProperties: false,
      },
      execute: async (params: { state: any }) => {
        const current = delegate.layoutStates[delegate.layout] ?? {};
        const merged = (mergeUpdates(current, params.state) ?? current) as Record<string, any>;
        delegate.layoutStates = { ...delegate.layoutStates, [delegate.layout]: merged };
        return textResponse("success");
      },
    },
    {
      name: "apply_filter",
      description: `Scope the global cross-filter to rows matching a SQL boolean predicate. This adds (or updates) a labeled predicate in the SQL Predicates panel and activates it, so every chart wired to the cross-filter (the embedding, histograms, count plots) and the Instances table will scope to matching rows.

This is the ONLY filter tool available to the chat assistant — there is no way to invoke a brush, embedding lasso, or other interactive selection from chat. Use this tool whenever the user asks to "filter to", "show only", "narrow down to", "select", or otherwise restrict the view by a condition expressible as SQL.

The predicate is a DuckDB SQL boolean expression evaluated against the dataset's main table (use get_data_schema first if you are unsure about column names or types). Compound conditions go in a SINGLE predicate string joined with AND / OR — do NOT call apply_filter multiple times to add conditions; the second call will REPLACE the first when 'name' is the same. Examples:
  - "primary_corpus = 'biorxiv'"
  - "year > 2020 AND domain = 'protein_design'"
  - "list_contains(tools_used, 'ESM2') OR list_contains(tools_used, 'AlphaFold')"

The applied filter is VISIBLE to the user as a card in the SQL Predicates panel. The user can edit, toggle off (deactivate), or remove it via the panel UI — so the model and the user share a single, observable filter surface. Do not ask the user to add a predicate manually; just call this tool.

If 'name' is omitted, the predicate is stored under the default name "Chat Filter". Calling apply_filter again with the same name (or with no name) replaces the previous predicate. Pass an explicit 'name' only when you need to keep multiple distinct named filters around (rare; usually omit 'name').

CRITICAL — call this tool every time the user expresses filter intent, even if you think the same filter is already active from an earlier turn. The tool is safe to call repeatedly; applying the same predicate is a no-op visually. Never infer the current filter state from your own previous messages or tool results — the user may have edited or cleared the filter via the UI between turns. If you genuinely need to verify state before proceeding, call get_charts to inspect the predicates panel — but the simpler and correct path is to just call apply_filter and let it replace. Describing a filter without invoking this tool is a confabulation bug; the user has no way to know whether the action took effect.`,
      inputSchema: {
        type: "object",
        properties: {
          predicate: {
            type: "string",
            description:
              "A DuckDB SQL boolean expression that will be applied as a WHERE clause to the cross-filter (e.g., \"year > 2020 AND domain = 'antibody'\"). Combine multiple conditions with AND / OR in a single string.",
          },
          name: {
            type: "string",
            description:
              'Optional human-readable label shown on the predicate card. If omitted, the default "Chat Filter" is used and successive apply_filter calls overwrite each other.',
          },
        },
        required: ["predicate"],
        additionalProperties: false,
      },
      execute: async (params: { predicate: string; name?: string }) => {
        const rawPredicate = params?.predicate;
        if (typeof rawPredicate !== "string") {
          return textResponse(
            "apply_filter failed: 'predicate' must be a string containing a DuckDB SQL boolean expression (for example, \"year > 2020\").",
          );
        }
        const predicate = rawPredicate.trim();
        if (predicate === "") {
          return textResponse(
            'apply_filter failed: the predicate is empty. Provide a DuckDB SQL boolean expression such as "year > 2020" or "domain = \'antibody\'". Use get_data_schema to discover available columns.',
          );
        }
        const rawName = typeof params?.name === "string" ? params.name.trim() : "";
        const name = rawName === "" ? DEFAULT_FILTER_NAME : rawName;

        // Validate the predicate by running a cheap COUNT(*) WHERE <predicate>
        // against the dataset before mutating chart state. Mirrors the check
        // that Predicates.svelte performs on user-entered predicates.
        try {
          await delegate.context.coordinator.query(
            SQL.Query.from(delegate.context.table).select({ count: SQL.count() }).where(predicate),
          );
        } catch (e: any) {
          const detail = e?.message ?? e?.toString?.() ?? String(e);
          return textResponse(
            `apply_filter failed: the predicate could not be evaluated as a DuckDB SQL boolean expression. Details: ${detail}. Use get_data_schema to confirm column names and types, then retry with a corrected predicate.`,
          );
        }

        // Locate (or create) the SQL Predicates singleton chart.
        let predicatesId = findPredicatesChartId(delegate.charts);
        if (predicatesId == null) {
          predicatesId = findUnusedId(delegate.charts);
          delegate.charts = {
            ...delegate.charts,
            [predicatesId]: { type: "predicates", title: "SQL Predicates" },
          };
        }

        // Update the items list: replace existing item with same name, otherwise append.
        const currentSpec = (delegate.charts[predicatesId] ?? {}) as { items?: PredicateItem[] };
        const currentItems: PredicateItem[] = Array.isArray(currentSpec.items) ? [...currentSpec.items] : [];
        const existingIdx = currentItems.findIndex((it) => it && it.name === name);
        const newItem: PredicateItem = { name, predicate };
        if (existingIdx >= 0) {
          currentItems[existingIdx] = newItem;
        } else {
          currentItems.push(newItem);
        }
        delegate.charts = {
          ...delegate.charts,
          [predicatesId]: { ...currentSpec, items: currentItems },
        };

        // Activate this predicate as the panel's selection. Single-slot
        // semantics: the model expresses compound conditions inline, so we
        // replace whatever was selected before with just this predicate.
        const prevState = delegate.chartStates[predicatesId] ?? {};
        delegate.chartStates = {
          ...delegate.chartStates,
          [predicatesId]: { ...prevState, selection: [predicate] },
        };

        return jsonResponse({
          success: true,
          name,
          predicate,
          message: "Filter applied. Visible in the SQL Predicates panel.",
        });
      },
    },
    {
      name: "clear_filter",
      description: `Remove a labeled predicate from the SQL Predicates panel and deactivate it from the cross-filter.

If 'name' is omitted, the default-named filter ("Chat Filter") is removed — this is the common case when the chat assistant is undoing its own previous apply_filter call. Pass an explicit 'name' only when you want to remove a specific differently-named predicate the model previously created.

Other independent filter sources (the embedding brush, predicates the user added by hand via the panel UI) are NOT affected. Calling clear_filter when no matching predicate exists is a no-op.`,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Optional name of the predicate to remove. If omitted, the default-named "Chat Filter" is removed.',
          },
        },
        additionalProperties: false,
      },
      execute: async (params: { name?: string }) => {
        const rawName = typeof params?.name === "string" ? params.name.trim() : "";
        const name = rawName === "" ? DEFAULT_FILTER_NAME : rawName;

        const predicatesId = findPredicatesChartId(delegate.charts);
        if (predicatesId == null) {
          return jsonResponse({
            success: true,
            name,
            message: "No SQL Predicates panel found; nothing to clear.",
          });
        }

        const currentSpec = (delegate.charts[predicatesId] ?? {}) as { items?: PredicateItem[] };
        const currentItems: PredicateItem[] = Array.isArray(currentSpec.items) ? currentSpec.items : [];
        const target = currentItems.find((it) => it && it.name === name);
        if (!target) {
          return jsonResponse({
            success: true,
            name,
            message: `No predicate named "${name}" found; nothing to clear.`,
          });
        }

        const newItems = currentItems.filter((it) => it !== target);
        delegate.charts = {
          ...delegate.charts,
          [predicatesId]: { ...currentSpec, items: newItems },
        };

        const prevState = (delegate.chartStates[predicatesId] ?? {}) as { selection?: string[] };
        const prevSelection: string[] = Array.isArray(prevState.selection) ? prevState.selection : [];
        const newSelection = prevSelection.filter((p) => p !== target.predicate);
        delegate.chartStates = {
          ...delegate.chartStates,
          [predicatesId]: { ...prevState, selection: newSelection },
        };

        return jsonResponse({
          success: true,
          name,
          message: `Filter "${name}" removed from the SQL Predicates panel.`,
        });
      },
    },
    {
      name: "get_full_screenshot",
      description: `Get a full screenshot of the ENTIRE application (all panels, toolbars, chat, and the embedding together).

Use this ONLY for questions about app CHROME / LAYOUT — "what panels are open", "where is the settings button", "is the table visible", "what does the dashboard arrangement look like". It captures everything, so the embedding is small and surrounded by distracting UI.

For anything ABOUT THE EMBEDDING itself, prefer the targeted tools instead:
  - get_region_screenshot — a clean, cropped view of the embedding scatter (or a sub-region of it).
  - render_embedding_view — the embedding plus a structured legend JSON (colors → categories → counts).
Answer quantitative questions from run_sql_query, not from this screenshot.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      execute: async () => {
        let image = await screenshot(delegate.container, screenshotOptions);
        return imageResponse(image);
      },
    },
    // Vision substrate — targeted embedding rendering. Lives in its own
    // module (vision_tools.ts); registered here with a single line.
    ...visionTools(delegate, screenshotOptions),
  ];

  api.provideContext({ tools: tools });
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text: text.toString() }] };
}

function jsonResponse(content: any): ToolResponse {
  return textResponse(JSON.stringify(content));
}

function imageResponse(dataUrl: string): ToolResponse {
  let parsed = parseImageDataUrl(dataUrl);
  if (parsed) {
    return { content: [{ type: "image", data: parsed.data, mimeType: parsed.mimeType }] };
  }
  return textResponse("failed to take screenshot");
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  // Check if it's a valid data URL
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  // Find the comma that separates metadata from content
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  // Extract the metadata part (everything before the comma)
  const metadata = dataUrl.substring(5, commaIndex); // Skip "data:"

  // Extract the base64 content (everything after the comma)
  const base64Content = dataUrl.substring(commaIndex + 1);

  // Parse the metadata to extract MIME type
  let mimeType: string;

  if (metadata.includes(";base64")) {
    // Format: "image/png;base64" or "image/jpeg;base64"
    mimeType = metadata.replace(";base64", "");
  } else if (metadata.includes(";")) {
    // Handle other parameters (though base64 is most common)
    mimeType = metadata.split(";")[0];
  } else {
    // Just the MIME type without parameters
    mimeType = metadata;
  }

  // Validate that it's an image MIME type
  if (!mimeType.startsWith("image/")) {
    return null;
  }

  // Specifically check for PNG and JPEG
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    return null;
  }

  return { mimeType, data: base64Content };
}
