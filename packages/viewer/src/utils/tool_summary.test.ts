// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";
import { humanizeToolName, summarizeToolCall } from "./tool_summary.js";

describe("summarizeToolCall", () => {
  test("run_sql_query inlines the query, clipped", () => {
    expect(summarizeToolCall({ name: "run_sql_query", input: { query: "SELECT * FROM dataset" } })).toBe(
      "Ran SQL query — `SELECT * FROM dataset`",
    );
    // Multi-line SQL collapses to a single line.
    expect(summarizeToolCall({ name: "run_sql_query", input: { query: "SELECT id,\n  title\nFROM dataset" } })).toBe(
      "Ran SQL query — `SELECT id, title FROM dataset`",
    );
    // No query → generic summary.
    expect(summarizeToolCall({ name: "run_sql_query", input: {} })).toBe("Ran SQL query");
  });

  test("run_sql_query clips a long query with an ellipsis", () => {
    const long = "SELECT " + "a, ".repeat(40) + "z FROM dataset";
    const summary = summarizeToolCall({ name: "run_sql_query", input: { query: long } });
    expect(summary.startsWith("Ran SQL query — `SELECT ")).toBe(true);
    expect(summary.endsWith("…`")).toBe(true);
    // Backtick-wrapped clipped body is capped at the 60-char default.
    const body = summary.slice("Ran SQL query — `".length, -1);
    expect(body.length).toBeLessThanOrEqual(60);
  });

  test("apply_filter shows the predicate", () => {
    expect(summarizeToolCall({ name: "apply_filter", input: { predicate: "year > 2020" } })).toBe(
      "Filtered to `year > 2020`",
    );
    expect(
      summarizeToolCall({ name: "apply_filter", input: { predicate: "year > 2020 AND domain = 'protein_design'" } }),
    ).toBe("Filtered to `year > 2020 AND domain = 'protein_design'`");
    expect(summarizeToolCall({ name: "apply_filter", input: {} })).toBe("Applied a filter");
  });

  test("clear_filter names the predicate when given", () => {
    expect(summarizeToolCall({ name: "clear_filter", input: { name: "Antibodies" } })).toBe(
      'Cleared the "Antibodies" filter',
    );
    expect(summarizeToolCall({ name: "clear_filter", input: {} })).toBe("Cleared the filter");
  });

  test("retrieve quotes the query and appends the hit count from the result", () => {
    expect(
      summarizeToolCall({
        name: "retrieve",
        input: { query: "antibody design" },
        result: JSON.stringify({ count: 8, rows: [] }),
      }),
    ).toBe('Searched for "antibody design" — 8 hits');
    // Singular hit.
    expect(
      summarizeToolCall({
        name: "retrieve",
        input: { query: "X" },
        result: JSON.stringify({ count: 1 }),
      }),
    ).toBe('Searched for "X" — 1 hit');
  });

  test("retrieve falls back to rows.length when count is absent", () => {
    expect(
      summarizeToolCall({
        name: "retrieve",
        input: { query: "folding" },
        result: JSON.stringify({ rows: [{}, {}, {}] }),
      }),
    ).toBe('Searched for "folding" — 3 hits');
  });

  test("retrieve omits the count tail when the result is missing or unparseable", () => {
    // Pending call — no result yet.
    expect(summarizeToolCall({ name: "retrieve", input: { query: "folding" } })).toBe('Searched for "folding"');
    // Error/text result — not JSON.
    expect(
      summarizeToolCall({ name: "retrieve", input: { query: "folding" }, result: "retrieve failed: no text column" }),
    ).toBe('Searched for "folding"');
  });

  test("chart tools describe the viewer effect", () => {
    expect(summarizeToolCall({ name: "add_chart", input: { spec: {} } })).toBe("Added a chart");
    expect(summarizeToolCall({ name: "render_chart_in_chat", input: { spec: {} } })).toBe("Rendered a chart");
    expect(summarizeToolCall({ name: "set_chart_spec", input: { id: "1", spec: {} } })).toBe("Updated a chart");
    expect(summarizeToolCall({ name: "delete_chart", input: { id: "1" } })).toBe("Removed a chart");
  });

  test("layout and column tools describe the effect, naming the argument when present", () => {
    expect(summarizeToolCall({ name: "set_layout_type", input: { type: "dashboard" } })).toBe(
      "Switched to the dashboard layout",
    );
    expect(summarizeToolCall({ name: "set_layout_type", input: {} })).toBe("Switched the layout");
    expect(summarizeToolCall({ name: "set_column_style", input: { column: "year" } })).toBe(
      "Restyled the `year` column",
    );
  });

  test("vision tools summarize the capture, naming the coloring when present", () => {
    expect(summarizeToolCall({ name: "get_full_screenshot", input: {} })).toBe("Captured the app");
    expect(summarizeToolCall({ name: "get_region_screenshot", input: { bbox: {} } })).toBe(
      "Captured a region of the embedding",
    );
    expect(summarizeToolCall({ name: "render_embedding_view", input: {} })).toBe("Captured the embedding");
    expect(summarizeToolCall({ name: "render_embedding_view", input: { coloring: "domain" } })).toBe(
      "Captured the embedding colored by `domain`",
    );
  });

  test("unknown tools fall back to a humanized name", () => {
    expect(summarizeToolCall({ name: "some_new_tool", input: {} })).toBe("Some new tool");
    expect(summarizeToolCall({ name: "get_thing", input: { foo: 1 } })).toBe("Get thing");
  });

  test("malformed input is tolerated (null / non-object / wrong field types)", () => {
    expect(summarizeToolCall({ name: "run_sql_query", input: null })).toBe("Ran SQL query");
    expect(summarizeToolCall({ name: "apply_filter", input: "not an object" })).toBe("Applied a filter");
    expect(summarizeToolCall({ name: "apply_filter", input: { predicate: 42 } })).toBe("Applied a filter");
    // Whitespace-only string field is treated as absent.
    expect(summarizeToolCall({ name: "apply_filter", input: { predicate: "   " } })).toBe("Applied a filter");
  });
});

describe("humanizeToolName", () => {
  test("snake_case → capitalized phrase", () => {
    expect(humanizeToolName("run_sql_query")).toBe("Run sql query");
    expect(humanizeToolName("foo")).toBe("Foo");
  });

  test("empty name is a safe fallback", () => {
    expect(humanizeToolName("")).toBe("Tool call");
  });
});
