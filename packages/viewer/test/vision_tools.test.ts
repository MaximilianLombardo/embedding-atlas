// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, test } from "vitest";

import { computeCropRect } from "../src/model_context/vision_tools.js";

describe("computeCropRect", () => {
  test("full image maps to the whole raster", () => {
    expect(computeCropRect({ x: 0, y: 0, width: 1, height: 1 }, 800, 600)).toEqual({
      sx: 0,
      sy: 0,
      sWidth: 800,
      sHeight: 600,
    });
  });

  test("top-left quadrant", () => {
    expect(computeCropRect({ x: 0, y: 0, width: 0.5, height: 0.5 }, 800, 600)).toEqual({
      sx: 0,
      sy: 0,
      sWidth: 400,
      sHeight: 300,
    });
  });

  test("center region with non-zero origin", () => {
    expect(computeCropRect({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 1000, 800)).toEqual({
      sx: 250,
      sy: 400,
      sWidth: 500,
      sHeight: 200,
    });
  });

  test("clamps a bbox that overshoots the right/bottom edges", () => {
    // x + width = 1.5 → clamped to the image's right edge.
    expect(computeCropRect({ x: 0.5, y: 0.5, width: 1.0, height: 1.0 }, 400, 400)).toEqual({
      sx: 200,
      sy: 200,
      sWidth: 200,
      sHeight: 200,
    });
  });

  test("clamps negative origin", () => {
    expect(computeCropRect({ x: -0.5, y: -0.5, width: 0.75, height: 0.75 }, 400, 400)).toEqual({
      sx: 0,
      sy: 0,
      sWidth: 100,
      sHeight: 100,
    });
  });

  test("normalizes a flipped (negative-width) bbox", () => {
    // Right edge given before left edge — should be reordered, not dropped.
    expect(computeCropRect({ x: 0.75, y: 0.75, width: -0.5, height: -0.5 }, 400, 400)).toEqual({
      sx: 100,
      sy: 100,
      sWidth: 200,
      sHeight: 200,
    });
  });

  test("returns null for a zero-area bbox", () => {
    expect(computeCropRect({ x: 0.5, y: 0.5, width: 0, height: 0.5 }, 400, 400)).toBeNull();
  });

  test("returns null for non-positive image dimensions", () => {
    expect(computeCropRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 600)).toBeNull();
    expect(computeCropRect({ x: 0, y: 0, width: 1, height: 1 }, 800, 0)).toBeNull();
  });

  test("a non-finite bbox edge collapses to a zero-area region → null", () => {
    // clamp01(NaN) === 0, and clamp01(NaN + width) === 0 too, so both the
    // start and end edges land at 0 → no area. Degenerate input must not
    // produce a bogus rect; it returns null so the caller errors cleanly.
    expect(computeCropRect({ x: NaN, y: 0, width: 0.5, height: 0.5 }, 400, 400)).toBeNull();
  });
});
