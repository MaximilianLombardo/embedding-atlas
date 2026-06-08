// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";
import { detectCitationColumns, shapeRetrieveResult } from "./retrieve_tool.js";
import type { SearchResultItem } from "../search/search.js";

const item = (over: Partial<SearchResultItem>): SearchResultItem => ({
  id: over.id ?? "row-1",
  fields: over.fields ?? {},
  ...over,
});

describe("shapeRetrieveResult", () => {
  test("keys each row id under the configured id column (cited-rows shape)", () => {
    const result = shapeRetrieveResult({
      query: "antibodies",
      k: 5,
      withinSelection: true,
      predicate: "year > 2020",
      idColumn: "paper_id",
      items: [
        item({ id: 42, text: "an antibody paper", distance: 0.1, x: 1, y: 2 }),
        item({ id: 43, text: "another one", distance: 0.2 }),
      ],
    });

    expect(result.query).toBe("antibodies");
    expect(result.k).toBe(5);
    expect(result.within_selection).toBe(true);
    expect(result.predicate).toBe("year > 2020");
    expect(result.count).toBe(2);

    // The id is keyed under `paper_id` so the backend's
    // `_extract_cited_rows` (which scans for the id column) picks it up.
    expect(result.rows[0].paper_id).toBe(42);
    expect(result.rows[0].text).toBe("an antibody paper");
    expect(result.rows[0].distance).toBe(0.1);
    expect(result.rows[0].x).toBe(1);
    expect(result.rows[0].y).toBe(2);
    expect(result.rows[1].paper_id).toBe(43);
  });

  test("the rows array is parseable by the cited-rows envelope contract", () => {
    // Mirror what the backend sees: JSON-serialized result, then look for
    // `{ rows: [{ <id>: ... }] }`. This guards the pill pipeline.
    const result = shapeRetrieveResult({
      query: "q",
      k: 2,
      withinSelection: false,
      predicate: null,
      idColumn: "id",
      items: [item({ id: "a", text: "x" })],
    });
    const round = JSON.parse(JSON.stringify(result));
    expect(Array.isArray(round.rows)).toBe(true);
    expect(round.rows[0]).toHaveProperty("id", "a");
  });

  test("omits text/x/y when absent rather than emitting nulls", () => {
    const result = shapeRetrieveResult({
      query: "q",
      k: 1,
      withinSelection: true,
      predicate: null,
      idColumn: "id",
      items: [item({ id: 1 })],
    });
    expect(result.rows[0]).not.toHaveProperty("text");
    expect(result.rows[0]).not.toHaveProperty("x");
    expect(result.rows[0]).not.toHaveProperty("y");
    expect(result.rows[0]).not.toHaveProperty("distance");
  });

  test("truncates long snippets with an ellipsis", () => {
    const long = "z".repeat(2000);
    const result = shapeRetrieveResult({
      query: "q",
      k: 1,
      withinSelection: true,
      predicate: null,
      idColumn: "id",
      items: [item({ id: 1, text: long })],
    });
    const snippet = result.rows[0].text as string;
    expect(snippet.length).toBeLessThan(long.length);
    expect(snippet.endsWith("…")).toBe(true);
  });

  test("surfaces hydrated citation fields onto each row", () => {
    const result = shapeRetrieveResult({
      query: "q",
      k: 1,
      withinSelection: true,
      predicate: null,
      idColumn: "paper_id",
      items: [
        item({
          id: 7,
          text: "snippet",
          fields: { title: "A Great Paper", doi: "10.1/abc", year: 2021 },
        }),
      ],
    });
    expect(result.rows[0].paper_id).toBe(7);
    expect(result.rows[0].title).toBe("A Great Paper");
    expect(result.rows[0].doi).toBe("10.1/abc");
    expect(result.rows[0].year).toBe(2021);
  });

  test("skips null/empty citation fields and never clobbers id/text", () => {
    const result = shapeRetrieveResult({
      query: "q",
      k: 1,
      withinSelection: true,
      predicate: null,
      idColumn: "id",
      items: [item({ id: "a", text: "real text", fields: { doi: null, title: "", text: "OOPS" } })],
    });
    expect(result.rows[0]).not.toHaveProperty("doi");
    expect(result.rows[0]).not.toHaveProperty("title");
    // The `text` snippet must win over a field also named "text".
    expect(result.rows[0].text).toBe("real text");
  });

  test("predicate null is echoed (whole-dataset retrieval)", () => {
    const result = shapeRetrieveResult({
      query: "q",
      k: 3,
      withinSelection: false,
      predicate: null,
      idColumn: "id",
      items: [],
    });
    expect(result.predicate).toBeNull();
    expect(result.within_selection).toBe(false);
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
  });
});

describe("detectCitationColumns", () => {
  test("picks known citation columns, case-insensitively, preserving casing", () => {
    const cols = ["paper_id", "Title", "DOI", "abstract", "year", "random"];
    expect(detectCitationColumns(cols, "paper_id", "abstract")).toEqual(["Title", "DOI", "year"]);
  });

  test("excludes the id and text columns", () => {
    // `title` is both a citation key and (here) the text column → excluded.
    expect(detectCitationColumns(["id", "title", "doi"], "id", "title")).toEqual(["doi"]);
  });

  test("returns empty when no citation columns exist", () => {
    expect(detectCitationColumns(["id", "x", "y", "cluster"], "id", null)).toEqual([]);
  });

  test("caps the number of surfaced columns", () => {
    const cols = ["doi", "paper_id", "arxiv_id", "pmid", "pmcid", "url", "title", "authors", "year"];
    expect(detectCitationColumns(cols, "row_id", null).length).toBeLessThanOrEqual(6);
  });
});
