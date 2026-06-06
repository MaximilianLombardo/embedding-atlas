// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";
import type { RowID } from "../charts/chart.js";
import type { SearchResultItem } from "../search/search.js";
import {
  computeAxis,
  normalizeVector,
  scoreRowsOntoAxis,
  shapeConceptAxisResult,
  type AxisScore,
} from "./concept_axis_tool.js";

const v = (...xs: number[]) => new Float32Array(xs);

describe("normalizeVector", () => {
  test("scales to unit length", () => {
    const u = normalizeVector(v(3, 4))!;
    expect(u[0]).toBeCloseTo(0.6, 6);
    expect(u[1]).toBeCloseTo(0.8, 6);
    expect(Math.hypot(u[0], u[1])).toBeCloseTo(1, 6);
  });

  test("already-unit vector is preserved", () => {
    const u = normalizeVector(v(0, 1))!;
    expect(Array.from(u)).toEqual([0, 1]);
  });

  test("zero vector → null (no direction)", () => {
    expect(normalizeVector(v(0, 0, 0))).toBeNull();
  });
});

describe("computeAxis", () => {
  test("axis points from left toward right pole", () => {
    // left = +x, right = +y → diff = (-1, 1) normalized.
    const { axis } = computeAxis(v(1, 0), v(0, 1))!;
    expect(axis[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(axis[1]).toBeCloseTo(Math.SQRT1_2, 6);
    // Unit length.
    expect(Math.hypot(axis[0], axis[1])).toBeCloseTo(1, 6);
  });

  test("normalizes poles first (magnitude carries no meaning)", () => {
    // Same directions as above but un-normalized magnitudes → same axis.
    const a = computeAxis(v(5, 0), v(0, 0.1))!;
    const b = computeAxis(v(1, 0), v(0, 1))!;
    expect(a.axis[0]).toBeCloseTo(b.axis[0], 6);
    expect(a.axis[1]).toBeCloseTo(b.axis[1], 6);
  });

  test("opposite poles → maximal separation (2) and poleCosine -1", () => {
    const { strength } = computeAxis(v(1, 0), v(-1, 0))!;
    expect(strength.separation).toBeCloseTo(2, 6);
    expect(strength.poleCosine).toBeCloseTo(-1, 6);
  });

  test("orthogonal poles → separation sqrt(2), poleCosine 0", () => {
    const { strength } = computeAxis(v(1, 0), v(0, 1))!;
    expect(strength.separation).toBeCloseTo(Math.SQRT2, 6);
    expect(strength.poleCosine).toBeCloseTo(0, 6);
  });

  test("identical poles → null (no axis direction)", () => {
    expect(computeAxis(v(1, 0), v(2, 0))).toBeNull(); // same unit direction
  });

  test("zero pole → null", () => {
    expect(computeAxis(v(0, 0), v(1, 0))).toBeNull();
  });

  test("throws on length mismatch", () => {
    expect(() => computeAxis(v(1, 0), v(1, 0, 0))).toThrow(/length mismatch/);
  });
});

describe("scoreRowsOntoAxis", () => {
  // Axis pointing toward +y (from -y pole conceptually).
  const axis = v(0, 1);
  const vectors = new Map<RowID, Float32Array>([
    ["up", v(0, 1)], // score +1 (right pole)
    ["diag", v(Math.SQRT1_2, Math.SQRT1_2)], // score ~0.707
    ["right", v(1, 0)], // score 0 (neutral)
    ["down", v(0, -1)], // score -1 (left pole)
  ]);

  test("scores = dot(row, axis), sorted descending", () => {
    const scored = scoreRowsOntoAxis(axis, vectors);
    expect(scored.map((s) => s.id)).toEqual(["up", "diag", "right", "down"]);
    expect(scored[0].score).toBeCloseTo(1, 6);
    expect(scored[1].score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(scored[2].score).toBeCloseTo(0, 6);
    expect(scored[3].score).toBeCloseTo(-1, 6);
  });

  test("restricts to candidateIds and skips uncached ids", () => {
    const scored = scoreRowsOntoAxis(axis, vectors, ["up", "ghost", "down"]);
    expect(scored.map((s) => s.id)).toEqual(["up", "down"]);
  });

  test("empty candidate pool → empty", () => {
    expect(scoreRowsOntoAxis(axis, vectors, [])).toEqual([]);
    expect(scoreRowsOntoAxis(axis, new Map())).toEqual([]);
  });

  test("deterministic id-stringification tiebreak on equal scores", () => {
    const tied = new Map<RowID, Float32Array>([
      ["b", v(0, 1)],
      ["a", v(0, 1)],
      ["c", v(0, 1)],
    ]);
    expect(scoreRowsOntoAxis(axis, tied).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("top and bottom slices recover the two poles", () => {
    // End-to-end: build axis from text-like poles, score, take extremes.
    const built = computeAxis(v(0, -1), v(0, 1))!; // axis ≈ +y
    const scored = scoreRowsOntoAxis(built.axis, vectors);
    expect(scored[0].id).toBe("up"); // nearest right pole
    expect(scored[scored.length - 1].id).toBe("down"); // nearest left pole
  });
});

describe("shapeConceptAxisResult", () => {
  const item = (id: RowID, text?: string): SearchResultItem => ({ id, fields: {}, text });
  const scoreById = new Map<RowID, number>([
    [1, 0.9],
    [2, 0.8],
    [9, -0.7],
    [8, -0.85],
  ]);

  test("keys ids under idColumn and attaches scores + snippets", () => {
    const out = shapeConceptAxisResult({
      poles: { left: { kind: "text", text: "cold" }, right: { kind: "text", text: "hot" } },
      strength: { separation: 1.9, poleCosine: -0.8 },
      scored: 100,
      predicate: "year > 2020",
      column: null,
      idColumn: "row_id",
      rightItems: [item(1, "very hot"), item(2, "warm")],
      leftItems: [item(8, "freezing"), item(9, "chilly")],
      scoreById,
    });

    expect(out.scored).toBe(100);
    expect(out.predicate).toBe("year > 2020");
    expect(out.column).toBeNull();
    expect(out.strength.poleCosine).toBeCloseTo(-0.8, 6);

    expect(out.right_exemplars[0]).toEqual({ row_id: 1, score: 0.9, text: "very hot" });
    expect(out.right_exemplars[1].row_id).toBe(2);
    // Left exemplars carry the most-extreme-first order they were passed in.
    expect(out.left_exemplars.map((r) => r.row_id)).toEqual([8, 9]);
    expect(out.left_exemplars[0].score).toBeCloseTo(-0.85, 6);
  });

  test("omits text when no snippet, defaults missing score to 0", () => {
    const out = shapeConceptAxisResult({
      poles: { left: { kind: "ids", resolvedIds: 3 }, right: { kind: "ids", resolvedIds: 2 } },
      strength: { separation: 0.1, poleCosine: 0.99 },
      scored: 5,
      predicate: null,
      column: null,
      idColumn: "id",
      rightItems: [item(42)], // no text
      leftItems: [],
      scoreById: new Map<RowID, number>(), // no scores
    });
    expect(out.right_exemplars[0]).toEqual({ id: 42, score: 0 });
    expect("text" in out.right_exemplars[0]).toBe(false);
    expect(out.poles.left).toEqual({ kind: "ids", resolvedIds: 3 });
  });
});

// Type-only guard: AxisScore shape is what scoreRowsOntoAxis returns.
const _typecheck: AxisScore = { id: "x", score: 0 };
void _typecheck;
