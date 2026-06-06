// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";
import {
  pickColumns,
  rankNumericColumns,
  round,
  shapeCategoricalColumn,
  standardizedMeanDifference,
  toNum,
  type NumericColumnStat,
} from "./contrast_tool.js";
import type { ColumnDesc } from "../utils/database.js";

const col = (name: string, jsType: ColumnDesc["jsType"], type = "X"): ColumnDesc => ({ name, type, jsType });

describe("toNum", () => {
  test("coerces BigInt counts (as DuckDB returns them) to numbers", () => {
    expect(toNum(42n)).toBe(42);
  });
  test("passes through finite numbers and null", () => {
    expect(toNum(3.5)).toBe(3.5);
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
  });
  test("returns null for non-finite / non-numeric input", () => {
    expect(toNum("not-a-number")).toBeNull();
  });
});

describe("round", () => {
  test("rounds to the requested significant digits", () => {
    expect(round(1.23456, 3)).toBe(1.235);
    expect(round(1.23456, 4)).toBe(1.2346);
  });
  test("leaves non-finite values alone", () => {
    expect(round(Infinity)).toBe(Infinity);
  });
});

describe("pickColumns", () => {
  const columns = [
    col("id", "string"),
    col("domain", "string"),
    col("primary_corpus", "string"),
    col("year", "number"),
    col("times_cited", "number"),
    col("created_at", "Date"),
    col("tags", "string[]"),
  ];

  test("partitions into categorical (string) and numeric, excluding the id column", () => {
    const { categorical, numeric } = pickColumns(columns, "id", null, 12);
    expect(categorical.map((c) => c.name)).toEqual(["domain", "primary_corpus"]);
    expect(numeric.map((c) => c.name)).toEqual(["year", "times_cited"]);
  });

  test("honors an explicit allow-list", () => {
    const { categorical, numeric } = pickColumns(columns, "id", ["domain", "year"], 12);
    expect(categorical.map((c) => c.name)).toEqual(["domain"]);
    expect(numeric.map((c) => c.name)).toEqual(["year"]);
  });

  test("applies the per-kind column cap", () => {
    const { categorical } = pickColumns(columns, "id", null, 1);
    expect(categorical).toHaveLength(1);
  });

  test("ignores non string/number jsTypes (Date, string[])", () => {
    const { categorical, numeric } = pickColumns(columns, "id", null, 12);
    const all = [...categorical, ...numeric].map((c) => c.name);
    expect(all).not.toContain("created_at");
    expect(all).not.toContain("tags");
  });
});

describe("shapeCategoricalColumn", () => {
  test("ranks by lift and reports counts + shares", () => {
    // selection = 100 rows, dataset = 1000 rows.
    // value A: 80/100 in selection (share .8), 200/1000 overall (share .2) -> lift 4
    // value B: 20/100 in selection (share .2), 800/1000 overall (share .8) -> lift .25
    const stat = shapeCategoricalColumn({
      column: "domain",
      rows: [
        { value: "A", selectionCount: 80, totalCount: 200 },
        { value: "B", selectionCount: 20, totalCount: 800 },
      ],
      selectionSize: 100,
      datasetSize: 1000,
      maxValues: 5,
    });
    expect(stat.column).toBe("domain");
    expect(stat.kind).toBe("categorical");
    expect(stat.topValues[0].value).toBe("A");
    expect(stat.topValues[0].lift).toBe(4);
    expect(stat.topValues[0].selectionCount).toBe(80);
    expect(stat.topValues[0].totalCount).toBe(200);
    expect(stat.topValues[0].selectionShare).toBe(0.8);
    expect(stat.topValues[0].overallShare).toBe(0.2);
    expect(stat.topValues[1].value).toBe("B");
    expect(stat.topValues[1].lift).toBe(0.25);
  });

  test("drops values below the selection-share support floor (2%)", () => {
    // value rare: 1/100 in selection = 1% share < 2% floor -> dropped.
    const stat = shapeCategoricalColumn({
      column: "domain",
      rows: [
        { value: "common", selectionCount: 99, totalCount: 100 },
        { value: "rare", selectionCount: 1, totalCount: 1 },
      ],
      selectionSize: 100,
      datasetSize: 1000,
      maxValues: 5,
    });
    expect(stat.topValues.map((v) => v.value)).toEqual(["common"]);
  });

  test("caps the number of values returned", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      value: `v${i}`,
      selectionCount: 30 - i,
      totalCount: 100,
    }));
    const stat = shapeCategoricalColumn({
      column: "c",
      rows,
      selectionSize: 1000,
      datasetSize: 10000,
      maxValues: 3,
    });
    expect(stat.topValues).toHaveLength(3);
  });

  test("breaks lift ties by selection count (bigger group first)", () => {
    const stat = shapeCategoricalColumn({
      column: "c",
      rows: [
        { value: "small", selectionCount: 10, totalCount: 20 },
        { value: "big", selectionCount: 40, totalCount: 80 },
      ],
      selectionSize: 100,
      datasetSize: 1000,
      maxValues: 5,
    });
    // both lift = 0.5/0.02... equal lift, bigger selectionCount wins.
    expect(stat.topValues[0].value).toBe("big");
  });

  test("preserves null values (missing category) as a contrast signal", () => {
    const stat = shapeCategoricalColumn({
      column: "c",
      rows: [{ value: null, selectionCount: 50, totalCount: 60 }],
      selectionSize: 100,
      datasetSize: 1000,
      maxValues: 5,
    });
    expect(stat.topValues[0].value).toBeNull();
  });
});

describe("standardizedMeanDifference", () => {
  test("computes Cohen's d with pooled SD; positive when selection runs higher", () => {
    // equal SD of 2, means 10 vs 6 -> d = 4/2 = 2
    const d = standardizedMeanDifference({
      selectionMean: 10,
      complementMean: 6,
      selectionStdDev: 2,
      complementStdDev: 2,
      selectionSize: 50,
      complementSize: 50,
    });
    expect(d).toBe(2);
  });

  test("is negative when the selection runs lower", () => {
    const d = standardizedMeanDifference({
      selectionMean: 4,
      complementMean: 8,
      selectionStdDev: 2,
      complementStdDev: 2,
      selectionSize: 50,
      complementSize: 50,
    });
    expect(d).toBe(-2);
  });

  test("returns null when pooled SD is zero (flat column)", () => {
    expect(
      standardizedMeanDifference({
        selectionMean: 5,
        complementMean: 5,
        selectionStdDev: 0,
        complementStdDev: 0,
        selectionSize: 10,
        complementSize: 10,
      }),
    ).toBeNull();
  });

  test("returns null when a mean or SD is missing", () => {
    expect(
      standardizedMeanDifference({
        selectionMean: null,
        complementMean: 5,
        selectionStdDev: 1,
        complementStdDev: 1,
        selectionSize: 10,
        complementSize: 10,
      }),
    ).toBeNull();
  });

  test("returns null with too few rows to pool (n1 + n2 - 2 <= 0)", () => {
    expect(
      standardizedMeanDifference({
        selectionMean: 5,
        complementMean: 3,
        selectionStdDev: 1,
        complementStdDev: 1,
        selectionSize: 1,
        complementSize: 1,
      }),
    ).toBeNull();
  });
});

describe("rankNumericColumns", () => {
  const stat = (column: string, smd: number | null): NumericColumnStat => ({
    column,
    kind: "numeric",
    selectionMean: 0,
    complementMean: 0,
    selectionMedian: 0,
    complementMedian: 0,
    standardizedMeanDifference: smd,
  });

  test("orders by descending absolute effect size, nulls last", () => {
    const ranked = rankNumericColumns([stat("a", 0.3), stat("b", -1.5), stat("c", null), stat("d", 0.9)]);
    expect(ranked.map((s) => s.column)).toEqual(["b", "d", "a", "c"]);
  });

  test("does not mutate the input array", () => {
    const input = [stat("a", 0.1), stat("b", 0.9)];
    const snapshot = input.map((s) => s.column);
    rankNumericColumns(input);
    expect(input.map((s) => s.column)).toEqual(snapshot);
  });
});
