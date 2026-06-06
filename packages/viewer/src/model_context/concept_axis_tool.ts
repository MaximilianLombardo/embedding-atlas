// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { MCPTool, ToolResponse } from "../app/mcp_server.js";
import type { RowID } from "../charts/chart.js";
import { centroid, cosineSimilarity } from "../search/latent_ops.js";
import { querySearchResultItems, type SearchResultItem } from "../search/search.js";
import type { RetrieveToolContext } from "./retrieve_tool.js";

/**
 * The `concept_axis` MCP tool: define an INTERPRETABLE direction in the
 * embedding space from two "poles", then project every cached row onto it
 * to get a signed, named scalar — turning 384-dim latent space into a
 * human-readable dial (see chat-roadmap Lens 3, "Concept Axis — flagship").
 *
 * Axis = normalize(centroid_right − centroid_left). Each pole is either a
 * text phrase (embedded via the in-browser MiniLM the searcher already
 * loaded) or a set of row ids (centroid over the precomputed row-vector
 * cache). Row score = dot(rowVector, axis); with L2-normalized vectors
 * this is the cosine of the row against the axis, in [-1, 1]: positive =
 * toward the right pole, negative = toward the left.
 *
 * The math here is pure + unit-tested (`concept_axis_tool.test.ts`); the
 * tool body wires it to the live searcher/coordinator and shapes a summary
 * (poles, axis strength, top/bottom exemplars with ids for citation
 * pills). Reuses the latent helpers in `latent_ops.ts` and the row-vector
 * cache + text embedder exposed on the `Searcher` (Wave-0 `getRowVectors`
 * + `embedTexts`).
 */

/** Hard cap on exemplars-per-end so a runaway arg can't hydrate the table. */
const MAX_EXEMPLARS = 25;
/** Default exemplars per end (top + bottom) when the model omits it. */
const DEFAULT_EXEMPLARS = 5;
/** Snippet length cap (chars) for exemplar text fed back to the model. */
const SNIPPET_MAX_LEN = 300;

/** A pole: a free-text phrase OR an explicit set of row ids (exactly one). */
export interface ConceptPole {
  /** Natural-language phrase describing this end of the axis. */
  text?: string;
  /** Row ids whose centroid defines this end of the axis. */
  ids?: RowID[];
}

/** One scored row: id + its signed projection onto the axis. */
export interface AxisScore {
  id: RowID;
  /** dot(rowVector, axis); in [-1, 1] for normalized inputs. */
  score: number;
}

/**
 * L2-normalize a vector to unit length. Returns `null` for the zero
 * vector (no defined direction) rather than dividing by zero — callers
 * decide how to surface "degenerate pole / axis".
 */
export function normalizeVector(v: Float32Array): Float32Array | null {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** Diagnostics describing how well-separated the two poles are. */
export interface AxisStrength {
  /**
   * Euclidean distance between the two UNIT pole vectors, in [0, 2]. 0 =
   * the poles point the same way (no contrast → useless axis); 2 = exactly
   * opposite (maximal contrast). Equals sqrt(2 - 2·cosine).
   */
  separation: number;
  /**
   * Cosine similarity between the two poles, in [-1, 1]. Near +1 means the
   * poles are nearly synonymous (weak axis); near -1 means they are true
   * opposites (strong, interpretable axis).
   */
  poleCosine: number;
}

/** A computed concept axis: the unit direction plus separation diagnostics. */
export interface ConceptAxis {
  /** Unit vector = normalize(rightPole − leftPole). */
  axis: Float32Array;
  strength: AxisStrength;
}

/**
 * Build the concept axis from two pole vectors. Each pole vector is
 * normalized to a unit direction first (so a text phrase and a many-row
 * centroid are weighed equally — magnitude carries no meaning here), then
 * the axis is normalize(right − left).
 *
 * Returns `null` when either pole is a zero vector, or when the two poles
 * coincide (their difference is zero → no axis direction). The caller
 * turns `null` into an actionable error rather than a silent bad axis.
 */
export function computeAxis(leftPole: Float32Array, rightPole: Float32Array): ConceptAxis | null {
  if (leftPole.length !== rightPole.length) {
    throw new Error(`computeAxis: pole length mismatch (${leftPole.length} vs ${rightPole.length})`);
  }
  const left = normalizeVector(leftPole);
  const right = normalizeVector(rightPole);
  if (left == null || right == null) return null;

  const diff = new Float32Array(left.length);
  for (let i = 0; i < diff.length; i++) diff[i] = right[i] - left[i];
  const axis = normalizeVector(diff);
  if (axis == null) return null; // poles coincide → no direction.

  const poleCosine = cosineSimilarity(left, right);
  // ‖right − left‖ for unit vectors = sqrt(2 - 2·cos). Compute directly
  // from the un-normalized diff so we don't depend on the identity.
  let sep = 0;
  for (let i = 0; i < diff.length; i++) sep += diff[i] * diff[i];
  const separation = Math.sqrt(sep);

  return { axis, strength: { separation, poleCosine } };
}

/**
 * Project rows onto the axis: score_i = dot(vector_i, axis). With
 * L2-normalized row vectors and a unit axis this is a cosine in [-1, 1].
 *
 * By default every cached row is scored; pass `candidateIds` to restrict
 * to a subset (e.g. the current cross-filter selection). Ids with no
 * cached vector are skipped. Results are sorted by score descending with a
 * deterministic id-stringification tiebreak (matches `topKNearest`), so
 * the top is the right-pole end and the tail is the left-pole end.
 */
export function scoreRowsOntoAxis(
  axis: Float32Array,
  vectors: Map<RowID, Float32Array>,
  candidateIds?: Iterable<RowID>,
): AxisScore[] {
  const scored: AxisScore[] = [];
  const score = (id: RowID, v: Float32Array | undefined) => {
    if (v == null) return;
    // dot product; cosineSimilarity would re-normalize (axis + rows are
    // already unit), so do the plain dot here for speed + sign fidelity.
    let s = 0;
    const n = Math.min(v.length, axis.length);
    for (let i = 0; i < n; i++) s += v[i] * axis[i];
    scored.push({ id, score: s });
  };

  if (candidateIds != null) {
    for (const id of candidateIds) score(id, vectors.get(id));
  } else {
    for (const [id, v] of vectors) score(id, v);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return scored;
}

/** Echo of a resolved pole for the summary (what the axis was built from). */
export interface PoleSummary {
  kind: "text" | "ids";
  /** The phrase, when kind === "text". */
  text?: string;
  /** Count of ids that actually resolved to a cached vector, when kind === "ids". */
  resolvedIds?: number;
}

/** One exemplar row at an extreme of the axis, shaped for citation pills. */
export interface ExemplarRow {
  /** Row id keyed under the dataset's id column (see `shapeConceptAxisResult`). */
  [key: string]: any;
  /** This row's signed axis score. */
  score: number;
  /** Truncated text snippet, when a text column is configured. */
  text?: string;
}

/** The full JSON payload `concept_axis` returns. */
export interface ConceptAxisResult {
  /** Resolved description of each pole. */
  poles: { left: PoleSummary; right: PoleSummary };
  /** Axis separation diagnostics (how interpretable the dial is). */
  strength: AxisStrength;
  /** Number of rows scored. */
  scored: number;
  /** Active predicate the scoring was scoped to, or null. Echoed for transparency. */
  predicate: string | null;
  /** Whether the derived score column was materialized into the dataset. */
  column?: string | null;
  /**
   * Rows nearest the RIGHT pole (highest score), best-first. The id is
   * keyed under the dataset's id column so the chat backend's
   * `_extract_cited_rows` lights up citation pills automatically.
   */
  right_exemplars: ExemplarRow[];
  /** Rows nearest the LEFT pole (lowest score), most-extreme-first. */
  left_exemplars: ExemplarRow[];
}

function truncate(text: string | null | undefined, max: number): string | undefined {
  if (text == null) return undefined;
  const s = String(text);
  if (s.length === 0) return undefined;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function clampExemplars(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_EXEMPLARS;
  if (n < 1) return 1;
  if (n > MAX_EXEMPLARS) return MAX_EXEMPLARS;
  return n;
}

/**
 * Pure shaper: scores + hydrated exemplars → the `ConceptAxisResult` JSON.
 * Split out from the tool body so it can be unit-tested without a live
 * coordinator/searcher. `scoreById` maps each hydrated exemplar back to its
 * axis score; `idColumn` keys the id so citation pills pick it up.
 */
export function shapeConceptAxisResult(args: {
  poles: { left: PoleSummary; right: PoleSummary };
  strength: AxisStrength;
  scored: number;
  predicate: string | null;
  column: string | null;
  idColumn: string;
  rightItems: SearchResultItem[];
  leftItems: SearchResultItem[];
  scoreById: Map<RowID, number>;
}): ConceptAxisResult {
  const { poles, strength, scored, predicate, column, idColumn, rightItems, leftItems, scoreById } = args;
  const shape = (item: SearchResultItem): ExemplarRow => {
    const row: ExemplarRow = { [idColumn]: item.id, score: scoreById.get(item.id) ?? 0 };
    const snippet = truncate(item.text, SNIPPET_MAX_LEN);
    if (snippet != null) row.text = snippet;
    return row;
  };
  return {
    poles,
    strength,
    scored,
    predicate,
    column,
    right_exemplars: rightItems.map(shape),
    left_exemplars: leftItems.map(shape),
  };
}

/**
 * Resolve one pole to a (un-normalized) vector + its summary. Text poles
 * embed the phrase; id poles take the centroid over the row-vector cache.
 * Returns `{ error }` with an actionable message when the pole can't be
 * resolved (empty phrase, no ids resolved, …).
 */
async function resolvePole(
  pole: ConceptPole,
  side: "left" | "right",
  vectors: Map<RowID, Float32Array>,
  embedTexts: (texts: string[]) => Promise<Float32Array[]>,
): Promise<{ vector: Float32Array; summary: PoleSummary } | { error: string }> {
  const hasText = typeof pole?.text === "string" && pole.text.trim() !== "";
  const hasIds = Array.isArray(pole?.ids) && pole.ids.length > 0;
  if (hasText && hasIds) {
    return { error: `The "${side}" pole sets both \`text\` and \`ids\`; provide exactly one.` };
  }
  if (!hasText && !hasIds) {
    return { error: `The "${side}" pole is empty; provide either a \`text\` phrase or a non-empty \`ids\` array.` };
  }

  if (hasText) {
    const [vec] = await embedTexts([pole.text!.trim()]);
    if (vec == null) {
      return { error: `Failed to embed the "${side}" pole text.` };
    }
    return { vector: vec, summary: { kind: "text", text: pole.text!.trim() } };
  }

  // Id pole: centroid over the cached row vectors.
  const c = centroid(pole.ids!, vectors);
  if (c == null) {
    return {
      error: `None of the "${side}" pole ids resolved to a cached embedding. Check the ids belong to this dataset (and that embeddings have finished loading).`,
    };
  }
  // Count how many ids actually resolved, for transparency.
  let resolved = 0;
  for (const id of pole.ids!) if (vectors.has(id)) resolved += 1;
  return { vector: c, summary: { kind: "ids", resolvedIds: resolved } };
}

/**
 * Build the `concept_axis` MCP tool, wired to the host's searcher +
 * coordinator (reusing the `retrieve` tool's context — it already carries
 * everything we need: searcher, coordinator, table, id/text columns, and
 * the current predicate).
 */
export function createConceptAxisTool(ctx: RetrieveToolContext): MCPTool {
  return {
    name: "concept_axis",
    description: `Define an INTERPRETABLE direction ("concept axis") in the dataset's embedding space from two opposing POLES, then score every row onto it — turning the 384-dim latent space into a single human-readable dial. Each row gets a signed score in roughly [-1, 1]: positive = leans toward the RIGHT pole, negative = leans toward the LEFT pole, ~0 = neutral. Returns the axis strength plus the most extreme rows at each end (with ids → clickable citation pills).

Axis = normalize(centroid(right) − centroid(left)); each row's score = cosine of its embedding against that axis.

POLES — each of \`left\` and \`right\` is ONE of:
  • a \`text\` phrase (embedded on the fly with the in-browser model), or
  • an \`ids\` array (the centroid of those rows' embeddings).
Provide exactly one of \`text\`/\`ids\` per pole. You may mix kinds (e.g. left = text, right = ids).

WHEN TO USE:
  ✅ "Score papers from theoretical → experimental" → left:{text:"theoretical"}, right:{text:"experimental"}
  ✅ "Rank rows by how methodological vs. results-focused they are"
  ✅ "Make an axis from these two clusters" → left:{ids:[...]}, right:{ids:[...]} (e.g. ids from a prior selection/retrieve)
  ✅ "What's the spectrum between formal and informal tone here?"
WHEN NOT TO USE:
  ❌ Exact structured filters / counts / sorting by an existing column → run_sql_query.
  ❌ "Which rows are ABOUT X?" (single concept, not a contrast) → retrieve.
Rule of thumb: concept_axis answers "where does each row fall on the LEFT↔RIGHT spectrum?".

STRENGTH: the result reports \`separation\` (distance between unit poles, 0–2) and \`poleCosine\` (−1…1). Poles that are near-synonyms (poleCosine near +1, separation near 0) make a weak, uninterpretable axis — pick more contrasting phrases. True opposites (poleCosine near −1) make the strongest dial.

SELECTION SCOPING: by default (within_selection = true) only the user's current cross-filter selection is scored; set false to score the whole dataset.

Examples:
  Theoretical ↔ experimental spectrum:
    { "left": {"text": "theoretical analysis and proofs"}, "right": {"text": "experimental wet-lab results"} }
  Contrast two clusters by id:
    { "left": {"ids": [12, 88, 401]}, "right": {"ids": [7, 9, 230]} }

Returns JSON: { poles, strength:{separation,poleCosine}, scored, predicate, column, right_exemplars:[{<id>,score,text}], left_exemplars:[...] }. Exemplars are ranked outward from each pole and are pre-wired to citation pills.

Requires the dataset's embeddings to have finished loading in the browser (the same cache hybrid search uses); if they aren't ready yet the tool says so — retry shortly.`,
    inputSchema: {
      type: "object",
      properties: {
        left: {
          type: "object",
          description:
            "The LEFT (negative) pole. Exactly one of `text` (a phrase) or `ids` (row ids whose centroid defines the pole).",
          properties: {
            text: { type: "string", description: "Natural-language phrase for this pole." },
            ids: { type: "array", description: "Row ids whose embedding centroid defines this pole.", items: {} },
          },
          additionalProperties: false,
        },
        right: {
          type: "object",
          description: "The RIGHT (positive) pole. Exactly one of `text` or `ids` (see `left`).",
          properties: {
            text: { type: "string", description: "Natural-language phrase for this pole." },
            ids: { type: "array", description: "Row ids whose embedding centroid defines this pole.", items: {} },
          },
          additionalProperties: false,
        },
        exemplars: {
          type: "integer",
          description: `How many extreme rows to return at EACH end (top + bottom). Default ${DEFAULT_EXEMPLARS}, max ${MAX_EXEMPLARS}.`,
        },
        within_selection: {
          type: "boolean",
          description:
            "If true (default), score only the rows in the user's current cross-filter selection. Set false to score the entire dataset.",
        },
      },
      required: ["left", "right"],
      additionalProperties: false,
    },
    execute: async (params: {
      left?: ConceptPole;
      right?: ConceptPole;
      exemplars?: number;
      within_selection?: boolean;
    }): Promise<ToolResponse> => {
      const searcher = ctx.searcher;
      if (searcher.getRowVectors == null || searcher.embedTexts == null) {
        return jsonResponse({
          error:
            "concept_axis is unavailable: this dataset's searcher does not expose latent-space vectors. It requires the built-in hybrid searcher (a text column must be configured).",
        });
      }

      const vectors = searcher.getRowVectors();
      if (vectors == null) {
        return jsonResponse({
          error:
            "concept_axis is not ready yet: the per-row embeddings are still loading in the browser. Wait a few seconds and retry.",
        });
      }
      if (vectors.size === 0) {
        return jsonResponse({
          error:
            "concept_axis is unavailable: per-row embeddings were not precomputed for this dataset (it may be too large). Concept axes need the in-browser vector cache.",
        });
      }

      if (params?.left == null || params?.right == null) {
        return jsonResponse({ error: "concept_axis requires both a `left` and a `right` pole." });
      }

      // 1. Resolve each pole to a vector (embed text, or centroid ids).
      const [leftRes, rightRes] = await Promise.all([
        resolvePole(params.left, "left", vectors, searcher.embedTexts.bind(searcher)),
        resolvePole(params.right, "right", vectors, searcher.embedTexts.bind(searcher)),
      ]);
      if ("error" in leftRes) return jsonResponse({ error: `concept_axis: ${leftRes.error}` });
      if ("error" in rightRes) return jsonResponse({ error: `concept_axis: ${rightRes.error}` });

      // 2. Build the axis = normalize(right − left).
      let computed: ConceptAxis | null;
      try {
        computed = computeAxis(leftRes.vector, rightRes.vector);
      } catch (e: any) {
        return jsonResponse({ error: `concept_axis: ${e?.message ?? String(e)}` });
      }
      if (computed == null) {
        return jsonResponse({
          error:
            "concept_axis: the two poles are degenerate or identical, so no axis direction is defined. Pick two more contrasting poles.",
        });
      }

      // 3. Score the rows. Scope to the current selection unless opted out.
      const withinSelection = params?.within_selection !== false;
      const predicate = withinSelection ? ctx.currentPredicate() : null;
      // When scoped, restrict the candidate pool to the selection's ids so
      // the scores + exemplars match what the user is looking at. We pull
      // the selected ids from DuckDB once and intersect with the cache.
      let candidateIds: RowID[] | undefined;
      if (predicate != null) {
        candidateIds = await selectedRowIds(ctx, predicate);
      }
      const scores = scoreRowsOntoAxis(computed.axis, vectors, candidateIds);
      if (scores.length === 0) {
        return jsonResponse({
          error:
            "concept_axis: no rows to score (the current selection is empty or none of its rows have cached embeddings). Widen the selection or set within_selection=false.",
        });
      }

      // 4. Take exemplars from each end (already sorted desc by score).
      const nEx = clampExemplars(params?.exemplars);
      const top = scores.slice(0, nEx);
      const bottom = scores.slice(Math.max(0, scores.length - nEx)).reverse(); // most-extreme-first
      const scoreById = new Map<RowID, number>();
      for (const s of scores) scoreById.set(s.id, s.score);

      // 5. Hydrate exemplar text (+ id) for citation pills. One query per
      //    end; pass the predicate so hydration can't leak outside scope.
      const cols = { id: ctx.idColumn, text: ctx.textColumn ?? undefined };
      const [rightItems, leftItems] = await Promise.all([
        querySearchResultItems(ctx.coordinator, ctx.table, cols, null, predicate, top),
        querySearchResultItems(ctx.coordinator, ctx.table, cols, null, predicate, bottom),
      ]);

      const result = shapeConceptAxisResult({
        poles: { left: leftRes.summary, right: rightRes.summary },
        strength: computed.strength,
        scored: scores.length,
        predicate,
        // Materializing a true reactive DuckDB column (so the embedding /
        // histogram / filter UIs pick the axis up as a first-class
        // dimension) is deferred — see the note in the module header /
        // chat-roadmap. The scores + exemplars below are the live surface
        // today; `column` stays null until that registration lands.
        column: null,
        idColumn: ctx.idColumn,
        rightItems,
        leftItems,
        scoreById,
      });
      return jsonResponse(result);
    },
  };
}

/**
 * Fetch the row ids matching a predicate (the current selection), so axis
 * scoring can be restricted to what the user sees. Returns the id list;
 * `scoreRowsOntoAxis` skips any that aren't in the vector cache.
 */
async function selectedRowIds(ctx: RetrieveToolContext, predicate: string): Promise<RowID[]> {
  const r = await ctx.coordinator.query(`
    SELECT ${quoteIdent(ctx.idColumn)} AS id
    FROM ${ctx.table}
    WHERE ${predicate}
  `);
  return (Array.from(r) as { id: RowID }[]).map((x) => x.id);
}

/** Double-quote a SQL identifier, escaping embedded quotes. */
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function jsonResponse(content: any): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(content) }] };
}
