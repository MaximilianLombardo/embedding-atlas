// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { makeCategoryColumn } from "../charts/embedding/category_column.js";
import { resolveChartTheme } from "../charts/common/theme.js";
import type { MCPTool, ToolResponse } from "../app/mcp_server.js";
import type { ScreenshotOptions } from "../utils/screenshot.js";
import type { ModelContextDelegate } from "./model_context.js";

/**
 * Vision substrate — targeted embedding rendering.
 *
 * The original `get_full_screenshot` captures the WHOLE app, which is the
 * wrong primitive for an agent that needs to *see the embedding*: it can't
 * crop to a cluster, can't isolate a coloring, and the surrounding chrome
 * (panels, toolbars, chat) distracts a VLM from the scatter it was asked
 * about. These tools target the embedding canvas specifically.
 *
 * Two tools live here:
 *
 *   - `get_region_screenshot` — the high-confidence win. It reuses the
 *     existing embedding screenshot path (which already forces a GPU
 *     render before reading `canvas.toDataURL`) and crops the result to a
 *     normalized bbox. No new render target, no live-view disruption.
 *
 *   - `render_embedding_view` — the headline. It returns a *structured
 *     legend JSON* (the thing VLMs reliably misread off a rendered swatch)
 *     for the embedding's current/requested coloring, alongside an image.
 *     The off-screen render-under-transient-config path is STUBBED (see
 *     the big TODO in the tool body) because it needs a second
 *     `EmbeddingRendererWebGPU` target wired to its own canvas + data
 *     upload — too large to land solidly without live GPU verification.
 *     Until then the tool captures the live embedding so the agent still
 *     gets a picture, and ALWAYS returns the legend so colorings can be
 *     read symbolically rather than guessed from pixels.
 */

/** A normalized crop rectangle, fractions in [0, 1] of the image's own dimensions. */
export interface NormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Integer pixel rectangle inside a raster image. */
export interface PixelRect {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

/**
 * Map a normalized bbox (fractions of the image, origin top-left) onto an
 * integer pixel rect clamped to the image bounds. Pure — no DOM — so it can
 * be unit tested directly. Returns null when the bbox collapses to zero
 * area after clamping (degenerate input), so callers can report an error
 * instead of asking the canvas to draw a 0×0 region.
 *
 * The bbox is normalized on purpose: the embedding is captured at
 * `pixelRatio: 2`, so a CSS-pixel bbox would silently halve. Fractions of
 * the returned image are the one coordinate space an agent can express
 * reliably after looking at a full embedding screenshot.
 */
export function computeCropRect(bbox: NormalizedBBox, imageWidth: number, imageHeight: number): PixelRect | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    return null;
  }
  // Clamp the normalized edges to [0, 1] before scaling so an over-eager
  // bbox (e.g. x: -0.1, width: 1.5) is trimmed to the visible image rather
  // than producing out-of-bounds source coordinates.
  let x0 = clamp01(bbox.x);
  let y0 = clamp01(bbox.y);
  let x1 = clamp01(bbox.x + bbox.width);
  let y1 = clamp01(bbox.y + bbox.height);
  if (x1 < x0) {
    [x0, x1] = [x1, x0];
  }
  if (y1 < y0) {
    [y0, y1] = [y1, y0];
  }
  let sx = Math.round(x0 * imageWidth);
  let sy = Math.round(y0 * imageHeight);
  let sWidth = Math.round((x1 - x0) * imageWidth);
  let sHeight = Math.round((y1 - y0) * imageHeight);
  if (sWidth <= 0 || sHeight <= 0) {
    return null;
  }
  // Guard against rounding pushing the rect past the image edge.
  sWidth = Math.min(sWidth, imageWidth - sx);
  sHeight = Math.min(sHeight, imageHeight - sy);
  if (sWidth <= 0 || sHeight <= 0) {
    return null;
  }
  return { sx, sy, sWidth, sHeight };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) {
    return 0;
  }
  return Math.max(0, Math.min(1, v));
}

/**
 * Crop a PNG/JPEG data URL to a normalized bbox and return a new PNG data
 * URL. Decodes the source via an <Image>, computes the pixel rect with
 * {@link computeCropRect}, and blits the region onto a fresh canvas. Returns
 * null when the bbox is degenerate or decoding/2D-context acquisition fails.
 */
async function cropImageDataUrl(dataUrl: string, bbox: NormalizedBBox): Promise<string | null> {
  const img = await loadImage(dataUrl);
  const rect = computeCropRect(bbox, img.naturalWidth, img.naturalHeight);
  if (rect == null) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = rect.sWidth;
  canvas.height = rect.sHeight;
  const ctx = canvas.getContext("2d");
  if (ctx == null) {
    return null;
  }
  ctx.drawImage(img, rect.sx, rect.sy, rect.sWidth, rect.sHeight, 0, 0, rect.sWidth, rect.sHeight);
  return canvas.toDataURL("image/png");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.decoding = "async";
    img.src = url;
  });
}

/** Find the id of the embedding chart, or null if the dashboard has none. */
function findEmbeddingChartId(charts: Record<string, any>): string | null {
  for (const [id, spec] of Object.entries(charts)) {
    if (spec && (spec as any).type === "embedding") {
      return id;
    }
  }
  return null;
}

/**
 * Capture the live embedding chart via its registered screenshot delegate.
 * Returns the data URL, or null when there is no embedding chart or it does
 * not (yet) expose a screenshot delegate. The delegate's screenshot path
 * runs the embedding's `canvas.toDataURL` override, which submits the GPU
 * render commands before reading pixels — so the capture reflects the
 * current frame, not a stale buffer.
 */
async function captureEmbedding(
  delegate: ModelContextDelegate,
  options: ScreenshotOptions,
): Promise<{ id: string; dataUrl: string } | null> {
  const id = findEmbeddingChartId(delegate.charts);
  if (id == null) {
    return null;
  }
  const items = delegate.chartDelegates.get(id);
  if (items != null) {
    for (const chart of items) {
      if (chart.screenshot) {
        const dataUrl = await chart.screenshot(options);
        return { id, dataUrl };
      }
    }
  }
  return null;
}

interface EmbeddingLegendJSON {
  column: string;
  entries: { label: string; color: string; count: number }[];
}

/**
 * Compute the structured legend for the embedding's coloring column. Reuses
 * the SAME cache key the live embedding chart uses (`embedding/category/…`)
 * so on a warm dashboard this is a cache hit and never re-runs the
 * table-mutating ALTER/UPDATE in `makeCategoryColumn`. Returns null when no
 * coloring column is set (the embedding is a single flat color).
 */
async function computeLegend(
  delegate: ModelContextDelegate,
  category: string | null | undefined,
): Promise<EmbeddingLegendJSON | null> {
  if (category == null) {
    return null;
  }
  const colorScheme = readColorScheme(delegate);
  const theme = resolveChartTheme(colorScheme, undefined);
  const result = await delegate.context.cache.value(`embedding/category/${category}`, () =>
    makeCategoryColumn(delegate.context.coordinator, delegate.context.table, category, theme),
  );
  if (result == null) {
    return null;
  }
  // `predicate` is a Mosaic SQL node and not useful (or serializable) to
  // the model — strip it; keep label/color/count, which is exactly the
  // {category_value: hex, count} mapping a VLM should not have to read off
  // the rendered swatches.
  return {
    column: category,
    entries: result.legend.map((e) => ({ label: e.label, color: e.color, count: e.count })),
  };
}

/** Read the current "light" | "dark" color scheme off the chart context store. */
function readColorScheme(delegate: ModelContextDelegate): "light" | "dark" {
  let value: "light" | "dark" = "light";
  // `colorScheme` is a Svelte Readable; subscribe fires synchronously with
  // the current value, then we immediately unsubscribe.
  const unsubscribe = delegate.context.colorScheme.subscribe((v) => {
    value = v;
  });
  unsubscribe();
  return value;
}

export function visionTools(delegate: ModelContextDelegate, screenshotOptions: ScreenshotOptions): MCPTool[] {
  return [
    {
      name: "get_region_screenshot",
      description: `Get a CROPPED screenshot of the embedding scatter plot. Captures just the embedding canvas (not the surrounding app chrome) and crops to a rectangular region you specify.

The bbox is in NORMALIZED coordinates — fractions in [0, 1] of the embedding image, origin at the TOP-LEFT. This is intentionally not pixels: the embedding is captured at 2× device pixel ratio, so pixel coordinates would be ambiguous. Express the region as fractions of what you'd see in a full embedding screenshot.

  - Full embedding (no crop): { x: 0, y: 0, width: 1, height: 1 }
  - Top-left quadrant:        { x: 0, y: 0, width: 0.5, height: 0.5 }
  - Center third:             { x: 0.33, y: 0.33, width: 0.34, height: 0.34 }
  - Right half:               { x: 0.5, y: 0, width: 0.5, height: 1 }

When to use:
  ✅ "zoom in on the cluster in the top-right", "what's in the lower-left corner of the embedding", "show me the dense blob in the middle" — anything spatial about a SUB-REGION of the scatter.
  ✅ As a follow-up after seeing a full embedding screenshot, to inspect one area in detail.
  ❌ Questions about the app layout, panels, or toolbars — use get_full_screenshot for that.
  ❌ Quantitative questions ("how many points", "which category dominates") — answer those from run_sql_query; pixels lie on dense scatters.

Returns the cropped PNG. Out-of-range bbox values are clamped to the image. A degenerate (zero-area) bbox returns a text error. If the dashboard has no embedding chart, returns a text error.`,
      inputSchema: {
        type: "object",
        properties: {
          bbox: {
            type: "object",
            description: "Normalized crop rectangle, fractions in [0,1] of the embedding image with origin top-left.",
            properties: {
              x: { type: "number", description: "Left edge, fraction in [0,1]." },
              y: { type: "number", description: "Top edge, fraction in [0,1]." },
              width: { type: "number", description: "Width, fraction in [0,1]." },
              height: { type: "number", description: "Height, fraction in [0,1]." },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
        },
        required: ["bbox"],
        additionalProperties: false,
      },
      execute: async (params: { bbox: NormalizedBBox }) => {
        const captured = await captureEmbedding(delegate, screenshotOptions);
        if (captured == null) {
          return textResponse(
            "get_region_screenshot failed: no embedding chart is present (or it does not support screenshots). Use list_charts to inspect the dashboard.",
          );
        }
        const cropped = await cropImageDataUrl(captured.dataUrl, params.bbox);
        if (cropped == null) {
          return textResponse(
            "get_region_screenshot failed: the bbox is degenerate (zero area after clamping to [0,1]). Provide a bbox with positive width and height, e.g. { x: 0, y: 0, width: 0.5, height: 0.5 }.",
          );
        }
        return imageResponse(cropped);
      },
    },
    {
      name: "render_embedding_view",
      description: `Render JUST the embedding scatter plot and return a PNG PLUS a structured legend JSON describing the coloring. The legend is the important part: VLMs reliably misread which color maps to which category off a rendered swatch, so this tool hands you the mapping as data: { column, entries: [{ label, color (hex), count }] }.

Use this when the user asks a SPATIAL/SHAPE question about the embedding as a whole ("where do the antibody papers sit", "is domain X clustered or scattered", "what does the embedding look like colored by year"). For QUANTITATIVE questions ("how many", "which is biggest") prefer run_sql_query — the legend's per-category counts are also exact and come from SQL.

Parameters (ALL optional; an empty {} renders the current live view):
  - coloring: a column name to color by, e.g. { coloring: "domain" }. Reported in the returned legend. (See the stub note below re: transient application.)
  - filter, width, height: reserved for the off-screen renderer — see the stub note.

STUB NOTE (be honest with the user): the off-screen render-under-transient-config path is not yet wired. Today this tool:
  • ALWAYS returns the legend JSON for the requested coloring (or the current coloring if none requested) — this part is solid and SQL-exact.
  • Returns an image of the CURRENT live embedding (same capture path as get_region_screenshot, uncropped).
It does NOT yet apply a transient coloring/filter/camera off-screen without touching the live view. If you need a *different* coloring rendered, ask the user (or use set_chart_spec to change the live embedding, then call this) — but note that mutates their view. The legend you get back already reflects the requested 'coloring' column regardless, so for "what colors map to what" you do not need the pixels.

Returns a text block with the legend JSON followed by an image block.`,
      inputSchema: {
        type: "object",
        properties: {
          coloring: {
            type: "string",
            description:
              "Column to color by and report in the legend. If omitted, the embedding's current coloring column is used.",
          },
          filter: {
            type: "string",
            description: "RESERVED (stubbed): a SQL predicate to transiently scope the off-screen render.",
          },
          width: { type: "number", description: "RESERVED (stubbed): off-screen render width in px." },
          height: { type: "number", description: "RESERVED (stubbed): off-screen render height in px." },
        },
        additionalProperties: false,
      },
      execute: async (params: { coloring?: string; filter?: string; width?: number; height?: number }) => {
        const embeddingId = findEmbeddingChartId(delegate.charts);
        if (embeddingId == null) {
          return textResponse(
            "render_embedding_view failed: no embedding chart is present. Use list_charts to inspect the dashboard.",
          );
        }
        const spec = delegate.charts[embeddingId] ?? {};
        // Which column to describe in the legend: the explicit request wins,
        // otherwise fall back to the live embedding's current coloring.
        const coloring = params.coloring ?? spec?.data?.category ?? null;

        let legend: EmbeddingLegendJSON | null = null;
        let legendError: string | null = null;
        try {
          legend = await computeLegend(delegate, coloring);
        } catch (e: any) {
          legendError = e?.message ?? String(e);
        }

        // Capture the current live embedding. TODO(vision-substrate):
        // replace this with an off-screen EmbeddingRendererWebGPU target so
        // `coloring` / `filter` / camera can be applied transiently without
        // disturbing the user's live view. That requires: (1) an offscreen
        // canvas + its own WebGPU context/device, (2) uploading the x/y/
        // category typed arrays (queryable via the coordinator the same way
        // EmbeddingViewMosaic does), (3) a viewport fit for bbox/cluster/
        // fitToSelection, and (4) a highlight overlay pass. Needs live-GPU
        // verification, so it is intentionally left out of this static PR.
        const captured = await captureEmbedding(delegate, screenshotOptions);

        const meta = {
          embeddingChartId: embeddingId,
          coloring: coloring,
          legend: legend,
          legendError: legendError,
          appliedTransiently: false,
          note: "Image is the CURRENT live embedding (off-screen transient render is stubbed). The legend reflects the requested coloring column and is SQL-exact. coloring/filter/camera were NOT applied to the pixels.",
          requested: {
            coloring: params.coloring ?? null,
            filter: params.filter ?? null,
            width: params.width ?? null,
            height: params.height ?? null,
          },
        };

        const content: ToolResponse["content"] = [{ type: "text", text: JSON.stringify(meta) }];
        if (captured != null) {
          const parsed = parseImageDataUrl(captured.dataUrl);
          if (parsed) {
            content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
          }
        }
        return { content };
      },
    },
  ];
}

// --- Local response helpers (kept here so this module is self-contained and
// model_context.ts needs only a single import + registration line). ---

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text: text.toString() }] };
}

function imageResponse(dataUrl: string): ToolResponse {
  const parsed = parseImageDataUrl(dataUrl);
  if (parsed) {
    return { content: [{ type: "image", data: parsed.data, mimeType: parsed.mimeType }] };
  }
  return textResponse("failed to take screenshot");
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }
  const metadata = dataUrl.substring(5, commaIndex);
  const base64Content = dataUrl.substring(commaIndex + 1);
  let mimeType: string;
  if (metadata.includes(";base64")) {
    mimeType = metadata.replace(";base64", "");
  } else if (metadata.includes(";")) {
    mimeType = metadata.split(";")[0];
  } else {
    mimeType = metadata;
  }
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    return null;
  }
  return { mimeType, data: base64Content };
}
