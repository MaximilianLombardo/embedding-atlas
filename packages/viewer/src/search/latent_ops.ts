// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { RowID } from "../charts/chart.js";

/**
 * Reusable latent-space helpers over the per-row embedding cache that
 * `FullTextSearcher` already populates (`allRowVectors`, ≤100k rows ×
 * 384 dims). These are the substrate for later "Concept Axis" /
 * contrastive features (see the chat roadmap): the full Concept-Axis
 * UX is NOT built here — just the small, pure, tested primitives those
 * features will compose.
 *
 * All vectors are assumed L2-normalized (the embedding worker uses
 * `normalize: true`), so dot product == cosine similarity. The helpers
 * do not re-normalize; callers that mix in synthetic vectors (e.g. a
 * `centroid` result) should normalize first if they need true cosine.
 */

/**
 * Cosine similarity between two equal-length vectors. For L2-normalized
 * inputs this is just the dot product; we divide by the norms anyway so
 * the function is correct for un-normalized inputs too (centroids,
 * difference vectors, …). Returns 0 when either vector is all-zeros
 * (degenerate — no defined direction).
 *
 * Throws on length mismatch: silently truncating to the shorter length
 * would mask a dimension-drift bug at the call site.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Mean vector of the rows identified by `ids`, looked up in `vectors`.
 * Ids with no cached vector are skipped (rather than treated as zero) so
 * a few missing rows don't drag the centroid toward the origin. The
 * result is the un-normalized arithmetic mean; normalize it yourself if
 * you intend to use it as a cosine query direction.
 *
 * Returns `null` when none of the ids resolve to a vector — there is no
 * meaningful centroid of the empty set, and returning a zero vector
 * would silently behave like "matches nothing" under cosine.
 */
export function centroid(ids: Iterable<RowID>, vectors: Map<RowID, Float32Array>): Float32Array | null {
  let sum: Float32Array | null = null;
  let count = 0;
  for (const id of ids) {
    const v = vectors.get(id);
    if (v == null) continue;
    if (sum == null) {
      // Seed from the first hit so we inherit its dimensionality
      // without hardcoding 384.
      sum = new Float32Array(v.length);
    } else if (v.length !== sum.length) {
      throw new Error(`centroid: vector length mismatch (${v.length} vs ${sum.length})`);
    }
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
    count += 1;
  }
  if (sum == null || count === 0) return null;
  for (let i = 0; i < sum.length; i++) sum[i] /= count;
  return sum;
}

/** One nearest-neighbor hit: the row id and its cosine similarity to the query. */
export interface NearestHit {
  id: RowID;
  /** Cosine similarity in [-1, 1]; higher = closer. */
  similarity: number;
}

/**
 * Top-`k` rows by cosine similarity to `query`, drawn from `vectors`.
 *
 * By default the whole cache is the candidate pool; pass `candidateIds`
 * to restrict the search to a subset (e.g. the current cross-filter
 * selection). Ids in `candidateIds` with no cached vector are skipped.
 *
 * Ties are broken by ascending id-stringification so the ordering is
 * deterministic across runs (useful for tests + reproducible UX). The
 * full candidate list is scored then sorted — fine for the ≤100k cache
 * we operate on; a heap would only help at much larger scale.
 *
 * Returns at most `k` hits (fewer if the candidate pool is smaller).
 * Returns `[]` for `k <= 0` or an empty candidate pool.
 */
export function topKNearest(
  query: Float32Array,
  k: number,
  vectors: Map<RowID, Float32Array>,
  candidateIds?: Iterable<RowID>,
): NearestHit[] {
  if (k <= 0) return [];

  const scored: NearestHit[] = [];
  const score = (id: RowID, v: Float32Array | undefined) => {
    if (v == null) return;
    scored.push({ id, similarity: cosineSimilarity(query, v) });
  };

  if (candidateIds != null) {
    for (const id of candidateIds) score(id, vectors.get(id));
  } else {
    for (const [id, v] of vectors) score(id, v);
  }

  scored.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    // Deterministic tiebreak; ids may be numbers or strings.
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  return scored.slice(0, k);
}
