// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Human-readable summaries for chat tool calls (Tier-1 "tool-call step cards").
//
// The chat agent drives the viewer through a ~22-tool MCP bridge (run_sql_query,
// apply_filter, add_chart, retrieve, the vision tools, …). The raw MCP payload
// (tool name + JSON input) is legible to a developer but opaque to a user, so
// each tool call in `ChatView.svelte` is rendered as a "step card" whose
// one-line header describes the *viewer effect* — "Filtered to `year > 2020`",
// "Searched for \"X\" — 8 hits" — rather than the wire payload.
//
// This module owns that name+input → summary templating. It is intentionally
// pure (no Svelte, no DOM) so it can be unit-tested in isolation. The detail
// drawer in ChatView still shows the raw input JSON and result for anyone who
// wants the underlying payload; this is only the headline.

/** The minimal view of a tool call this module needs to summarize it. */
export interface ToolSummaryInput {
  /** MCP tool name, e.g. "run_sql_query", "apply_filter". */
  name: string;
  /** The tool's input arguments (the `input` field of a tool_use block). */
  input: unknown;
  /**
   * The textual tool result, when available. Used only for opportunistic
   * enrichment (e.g. pulling the hit count out of a `retrieve` payload); the
   * summary is always meaningful without it, so callers may omit it while a
   * call is still pending.
   */
  result?: string | undefined;
}

/** Coerce an unknown input bag into a plain record for safe field access. */
function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A trimmed string field, or undefined when missing / non-string / empty. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Clip an arbitrary string for inline display in a one-line summary, adding an
 * ellipsis when truncated. Collapses internal whitespace/newlines first so a
 * multi-line SQL string renders as a single tidy clause.
 */
function clip(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Best-effort hit count from a `retrieve` tool result. The retrieve tool
 * returns `{ ..., count, rows: [...] }` as JSON; fall back to the rows length,
 * then to undefined when the result isn't parseable (e.g. an error string or a
 * still-pending call).
 */
function retrieveHitCount(result: string | undefined): number | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      const count = (parsed as Record<string, unknown>).count;
      if (typeof count === "number") return count;
      const rows = (parsed as Record<string, unknown>).rows;
      if (Array.isArray(rows)) return rows.length;
    }
  } catch {
    // Not JSON (error message, plain text) — no count to surface.
  }
  return undefined;
}

/**
 * A one-line, human-readable summary of a tool call describing its *effect on
 * the viewer*, keyed by tool name + input. Falls back to a humanized version of
 * the raw tool name for tools without a bespoke template, so a newly added MCP
 * tool still renders a sensible (if generic) card rather than breaking.
 */
export function summarizeToolCall({ name, input, result }: ToolSummaryInput): string {
  const args = asRecord(input);

  switch (name) {
    // — Data / retrieval —————————————————————————————————————————————
    case "run_sql_query": {
      const query = str(args, "query");
      return query ? `Ran SQL query — \`${clip(query)}\`` : "Ran SQL query";
    }
    case "retrieve": {
      const query = str(args, "query");
      const hits = retrieveHitCount(result);
      const tail = hits != null ? ` — ${hits} ${hits === 1 ? "hit" : "hits"}` : "";
      return query ? `Searched for "${clip(query, 40)}"${tail}` : `Searched the dataset${tail}`;
    }
    case "get_data_schema":
      return "Read the dataset schema";

    // — Cross-filter (the visible SQL Predicates panel) ———————————————
    case "apply_filter": {
      const predicate = str(args, "predicate");
      return predicate ? `Filtered to \`${clip(predicate)}\`` : "Applied a filter";
    }
    case "clear_filter": {
      const name = str(args, "name");
      return name ? `Cleared the "${name}" filter` : "Cleared the filter";
    }

    // — Charts ————————————————————————————————————————————————————————
    case "add_chart":
      return "Added a chart";
    case "render_chart_in_chat":
      return "Rendered a chart";
    case "set_chart_spec":
      return "Updated a chart";
    case "delete_chart":
      return "Removed a chart";
    case "set_chart_state":
    case "clear_chart_state":
      return "Adjusted a chart's view";
    case "list_charts":
      return "Listed the charts";
    case "get_chart_spec":
      return "Inspected a chart's spec";
    case "get_chart_state":
      return "Inspected a chart's view";

    // — Column styling ————————————————————————————————————————————————
    case "set_column_style": {
      const column = str(args, "column");
      return column ? `Restyled the \`${column}\` column` : "Restyled a column";
    }
    case "get_column_styles":
      return "Read the column styles";
    case "list_renderers":
      return "Listed the value renderers";

    // — Layout ————————————————————————————————————————————————————————
    case "set_layout_type": {
      const type = str(args, "type");
      return type ? `Switched to the ${type} layout` : "Switched the layout";
    }
    case "set_layout_state":
      return "Adjusted the layout";
    case "get_layout_type":
    case "get_layout_state":
      return "Inspected the layout";

    // — Vision / screenshots ——————————————————————————————————————————
    case "get_full_screenshot":
      return "Captured the app";
    case "get_chart_screenshot":
      return "Captured a chart";
    case "get_region_screenshot":
      return "Captured a region of the embedding";
    case "render_embedding_view": {
      const coloring = str(args, "coloring");
      return coloring ? `Captured the embedding colored by \`${coloring}\`` : "Captured the embedding";
    }

    default:
      return humanizeToolName(name);
  }
}

/**
 * Fallback for tools without a bespoke template: turn a snake_case tool name
 * into a capitalized phrase ("do_something" → "Do something"). Keeps unknown
 * future tools legible instead of dumping the raw identifier.
 */
export function humanizeToolName(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  if (words === "") return "Tool call";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
