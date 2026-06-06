// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";
import { centroid, cosineSimilarity, topKNearest } from "./latent_ops.js";
import type { RowID } from "../charts/chart.js";

const v = (...xs: number[]) => new Float32Array(xs);

describe("cosineSimilarity", () => {
  test("identical unit vectors → 1", () => {
    expect(cosineSimilarity(v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(1, 6);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBeCloseTo(0, 6);
  });

  test("opposite vectors → -1", () => {
    expect(cosineSimilarity(v(1, 0), v(-1, 0))).toBeCloseTo(-1, 6);
  });

  test("normalizes un-normalized inputs (scale-invariant)", () => {
    // Same direction, different magnitudes → still 1.
    expect(cosineSimilarity(v(3, 4), v(6, 8))).toBeCloseTo(1, 6);
  });

  test("zero vector → 0 (no defined direction)", () => {
    expect(cosineSimilarity(v(0, 0, 0), v(1, 2, 3))).toBe(0);
  });

  test("throws on length mismatch", () => {
    expect(() => cosineSimilarity(v(1, 2), v(1, 2, 3))).toThrow(/length mismatch/);
  });
});

describe("centroid", () => {
  const vectors = new Map<RowID, Float32Array>([
    ["a", v(1, 0)],
    ["b", v(0, 2)],
    ["c", v(3, 4)],
  ]);

  test("mean of selected ids", () => {
    const c = centroid(["a", "b"], vectors)!;
    expect(Array.from(c)).toEqual([0.5, 1]);
  });

  test("skips ids with no cached vector (does not pull toward origin)", () => {
    // "missing" contributes nothing → centroid is just the mean of a + c.
    const c = centroid(["a", "missing", "c"], vectors)!;
    expect(Array.from(c)).toEqual([2, 2]);
  });

  test("returns null when no ids resolve", () => {
    expect(centroid(["x", "y"], vectors)).toBeNull();
  });

  test("returns null for empty id set", () => {
    expect(centroid([], vectors)).toBeNull();
  });

  test("inherits dimensionality from first hit", () => {
    const c = centroid(["c"], vectors)!;
    expect(c.length).toBe(2);
    expect(Array.from(c)).toEqual([3, 4]);
  });
});

describe("topKNearest", () => {
  const vectors = new Map<RowID, Float32Array>([
    ["east", v(1, 0)],
    ["northeast", v(1, 1)],
    ["north", v(0, 1)],
    ["west", v(-1, 0)],
  ]);

  test("ranks by cosine similarity, best-first", () => {
    const hits = topKNearest(v(1, 0), 3, vectors);
    expect(hits.map((h) => h.id)).toEqual(["east", "northeast", "north"]);
    expect(hits[0].similarity).toBeCloseTo(1, 6);
    expect(hits[1].similarity).toBeCloseTo(Math.SQRT1_2, 6);
  });

  test("respects k (returns at most k hits)", () => {
    expect(topKNearest(v(1, 0), 2, vectors)).toHaveLength(2);
  });

  test("k larger than pool returns whole pool", () => {
    expect(topKNearest(v(1, 0), 99, vectors)).toHaveLength(4);
  });

  test("k <= 0 returns empty", () => {
    expect(topKNearest(v(1, 0), 0, vectors)).toEqual([]);
    expect(topKNearest(v(1, 0), -5, vectors)).toEqual([]);
  });

  test("restricts to candidateIds when provided", () => {
    const hits = topKNearest(v(1, 0), 10, vectors, ["north", "west"]);
    expect(hits.map((h) => h.id)).toEqual(["north", "west"]);
  });

  test("skips candidateIds with no cached vector", () => {
    const hits = topKNearest(v(1, 0), 10, vectors, ["east", "ghost", "north"]);
    expect(hits.map((h) => h.id)).toEqual(["east", "north"]);
  });

  test("deterministic tiebreak by stringified id", () => {
    const tied = new Map<RowID, Float32Array>([
      ["b", v(1, 0)],
      ["a", v(1, 0)],
      ["c", v(1, 0)],
    ]);
    const hits = topKNearest(v(1, 0), 3, tied);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  test("empty candidate pool returns empty", () => {
    expect(topKNearest(v(1, 0), 5, vectors, [])).toEqual([]);
    expect(topKNearest(v(1, 0), 5, new Map())).toEqual([]);
  });
});
