// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Coordinator } from "@uwdata/mosaic-core";
import * as SQL from "@uwdata/mosaic-sql";

import type { Searcher } from "../api.js";
import type { RowID } from "../charts/chart.js";
import { connectEmbeddingWorker } from "../embedding/index.js";

// Default embedding model for hybrid search. 384-dim, ~22MB ONNX,
// general-purpose semantic similarity. Loaded lazily into the
// shared embedding worker on first hybrid query.
const DEFAULT_HYBRID_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Dot product. With normalized vectors (we use `normalize: true` in
 * the worker's transformers pipeline), this equals cosine similarity.
 */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Thin client for the embedding worker's session-style raw-embed RPC.
 * One instance per FullTextSearcher; lazy-loads the model on first
 * `embed` call. Vectors come back as a flat Float32Array with shape
 * (N, dim); we slice it into per-text views.
 */
class SearchEmbedder {
  private rpcPromise: ReturnType<typeof connectEmbeddingWorker> | null = null;
  private instance: string | null = null;
  private dim: number | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly model: string;

  constructor(model: string = DEFAULT_HYBRID_MODEL) {
    this.model = model;
  }

  /**
   * Idempotent. Concurrent callers share a single load promise so we
   * don't spin up the model twice on a burst of queries during cold
   * start.
   */
  ensureLoaded(onStatus?: (status: string) => void): Promise<void> {
    if (this.instance != null && this.dim != null) return Promise.resolve();
    if (this.loadPromise != null) return this.loadPromise;
    this.loadPromise = (async () => {
      onStatus?.("Loading embedder...");
      if (this.rpcPromise == null) this.rpcPromise = connectEmbeddingWorker();
      const rpc = await this.rpcPromise;
      this.instance = (await rpc("embedding.session_new", { model: this.model })) as string;
      // Probe dimension with a single dummy embed. Saves us from
      // hardcoding 384; future model swaps just work.
      const probe = (await rpc("embedding.session_embed", this.instance, ["test"])) as {
        data: Float32Array;
        dim: number;
      };
      this.dim = probe.dim;
    })();
    return this.loadPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureLoaded();
    const rpc = await this.rpcPromise!;
    const { data, dim } = (await rpc("embedding.session_embed", this.instance, texts)) as {
      data: Float32Array;
      dim: number;
    };
    if (dim !== this.dim) {
      throw new Error(`embedding dim drift: expected ${this.dim}, got ${dim}`);
    }
    // subarray gives zero-copy views; safe because the underlying
    // ArrayBuffer is owned by the postMessage-cloned response.
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(data.subarray(i * dim, (i + 1) * dim));
    }
    return result;
  }
}

class SearchWorkerAPI {
  worker: Worker;
  callbacks: Map<string, (data: any) => void>;

  constructor() {
    this.worker = new Worker(new URL("./search.worker.js", import.meta.url), { type: "module" });
    this.callbacks = new Map();
    this.worker.onmessage = (e) => {
      let cb = this.callbacks.get(e.data.identifier);
      if (cb != null) {
        this.callbacks.delete(e.data.identifier);
        cb(e.data);
      }
    };
  }

  rpc(message: any): Promise<any> {
    return new Promise((resolve, _) => {
      let identifier = new Date().getTime() + "-" + Math.random();
      this.callbacks.set(identifier, resolve);
      this.worker.postMessage({ ...message, identifier: identifier });
    });
  }

  async clear() {
    await this.rpc({ type: "clear" });
  }

  async addPoints(points: { id: string | number; text: string }[]) {
    await this.rpc({ type: "points", points: points });
  }

  async query(query: string, limit: number): Promise<string[]> {
    let data = await this.rpc({ type: "query", query: query, limit: limit });
    return data.result;
  }

  async queryWithText(query: string, limit: number): Promise<{ id: any; text: string }[]> {
    let data = await this.rpc({ type: "query", query: query, limit: limit, withText: true });
    return data.result;
  }
}

// Batch size for the warmup row-embedding pass. Tuned to match the
// existing projection-embedding batch size in embedding/index.ts (64),
// which has been validated on the same WebGPU/WASM path.
const ROW_EMBED_BATCH_SIZE = 64;

// Skip the precompute-vectors path when the dataset is larger than this.
// At 384 dims × 4 bytes each, 100k rows = ~150MB resident — already
// pushing it; beyond that we'd starve the page. Above the cap, hybrid
// falls back to per-query embedding (slow but functional).
const MAX_ROWS_FOR_VECTOR_CACHE = 100_000;

export class FullTextSearcher implements Searcher {
  coordinator: Coordinator;
  table: string;
  columns: { text: string; id: string };

  backend: SearchWorkerAPI;
  embedder: SearchEmbedder;
  currentIndex: { predicate: string | null; promise: Promise<void> } | null = null;

  /**
   * Precomputed embedding per row, keyed by id. Populated during
   * `warmEmbedder` AFTER the model loads. While populated, hybridSearch
   * skips the per-query candidate-embedding step (which was the
   * dominant cost — ~10s for 100 candidates) in favor of a synchronous
   * Map lookup. The query text itself still embeds on demand (~50ms).
   *
   * Null = not yet populated; query will fall back to slow path.
   * Empty Map = warmup explicitly skipped (dataset too large or no
   * model available); same fallback.
   */
  private allRowVectors: Map<RowID, Float32Array> | null = null;
  private warmupPromise: Promise<void> | null = null;

  constructor(
    coordinator: Coordinator,
    table: string,
    columns: {
      text: string;
      id: string;
    },
  ) {
    this.coordinator = coordinator;
    this.table = table;
    this.columns = columns;
    this.currentIndex = null;
    this.backend = new SearchWorkerAPI();
    this.embedder = new SearchEmbedder();
  }

  /**
   * Pre-warm hybrid-search resources in the background:
   *   1. Load the embedder model (~22MB)
   *   2. Embed every row's text → populate `allRowVectors` cache
   *
   * After warmup completes, hybrid queries become ~50ms instead of
   * ~10s because we skip per-query candidate embedding.
   *
   * Callers (e.g. host on dataset-load) invoke this fire-and-forget.
   * Idempotent — concurrent calls share the same promise.
   */
  warmEmbedder(onStatus?: (status: string) => void): Promise<void> {
    if (this.warmupPromise != null) return this.warmupPromise;
    this.warmupPromise = (async () => {
      await this.embedder.ensureLoaded(onStatus);
      await this.precomputeAllRowVectors(onStatus);
    })();
    return this.warmupPromise;
  }

  /**
   * Pull every row's text, batch-embed via the worker, store in
   * `allRowVectors`. One-time cost per FullTextSearcher instance.
   * Cache survives filter changes (vectors are per-row, not
   * per-filter).
   */
  private async precomputeAllRowVectors(onStatus?: (status: string) => void): Promise<void> {
    // Fetch all (id, text). Read from the FULL table (no predicate) —
    // vectors must cover every row, since lexical candidates could be
    // any subset under any future filter.
    onStatus?.("Loading rows...");
    const result = await this.coordinator.query(`
      SELECT
        ${SQL.column(this.columns.id)} AS id,
        ${SQL.column(this.columns.text)} AS text
      FROM ${this.table}
    `);
    const rows = Array.from(result) as { id: any; text: string | null }[];

    if (rows.length > MAX_ROWS_FOR_VECTOR_CACHE) {
      // Mark as "intentionally empty" so hybridSearch knows to use the
      // slow path without re-attempting precompute.
      this.allRowVectors = new Map();
      onStatus?.("");
      return;
    }

    const vectors = new Map<RowID, Float32Array>();
    const total = rows.length;
    for (let start = 0; start < rows.length; start += ROW_EMBED_BATCH_SIZE) {
      const batch = rows.slice(start, start + ROW_EMBED_BATCH_SIZE);
      const texts = batch.map((r) => r.text ?? "");
      // Slice copy each Float32Array so we don't hold the whole batch
      // ArrayBuffer alive for one small view (the worker returns a
      // single contiguous buffer per batch).
      const batchVectors = await this.embedder.embed(texts);
      batch.forEach((r, i) => {
        vectors.set(r.id, new Float32Array(batchVectors[i]));
      });
      onStatus?.(`Embedding rows... ${Math.min(start + batch.length, total)} / ${total}`);
    }
    this.allRowVectors = vectors;
    onStatus?.("");
  }

  /**
   * Read-only view of the precomputed per-row embedding cache, for
   * latent-space helpers (see `latent_ops.ts`). Returns `null` until
   * warmup has populated it, and an empty Map when warmup was skipped
   * (dataset too large). Callers must treat the Map as immutable — it is
   * the live cache backing hybrid search.
   */
  getRowVectors(): Map<RowID, Float32Array> | null {
    return this.allRowVectors;
  }

  /**
   * Embed arbitrary text(s) into the same space as `getRowVectors`, using
   * the searcher's in-browser embedder (lazy-loads the model on first
   * call). Vectors are L2-normalized (the worker uses `normalize: true`),
   * so dot product == cosine. Used by latent-space chat features (e.g. the
   * `concept_axis` tool) to embed text "poles". Returns owned copies, not
   * the worker's transferable subarray views, so callers can retain them.
   */
  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const vecs = await this.embedder.embed(texts);
    return vecs.map((v) => new Float32Array(v));
  }

  predicateString(predicate: any | null): string | null {
    if (predicate != null && predicate.toString() != "") {
      return predicate.toString();
    } else {
      return null;
    }
  }

  buildIndexIfNeeded(predicate: any | null): Promise<void> {
    let builder = async () => {
      let result: any;
      if (predicateString != null) {
        result = await this.coordinator.query(`
        SELECT
          ${SQL.column(this.columns.id)} AS id,
          ${SQL.column(this.columns.text)} AS text
        FROM ${this.table}
        WHERE ${predicateString}
      `);
      } else {
        result = await this.coordinator.query(`
        SELECT
          ${SQL.column(this.columns.id)} AS id,
          ${SQL.column(this.columns.text)} AS text
        FROM ${this.table}
      `);
      }
      await this.backend.clear();
      await this.backend.addPoints(Array.from(result));
    };

    let predicateString = this.predicateString(predicate);
    if (this.currentIndex != null) {
      if (this.currentIndex.predicate != predicateString) {
        let promise = this.currentIndex.promise.then(() => builder());
        this.currentIndex = { predicate: predicateString, promise: promise };
      }
    } else {
      let promise = builder();
      this.currentIndex = { predicate: predicateString, promise: promise };
    }
    return this.currentIndex.promise;
  }

  async fullTextSearch(
    query: string,
    options: { limit?: number; predicate?: any; onStatus?: (status: string) => void } = {},
  ): Promise<{ id: any }[]> {
    let limit = options.limit ?? 100;
    let predicate = options.predicate;
    options?.onStatus?.("Indexing...");
    await this.buildIndexIfNeeded(predicate);
    options?.onStatus?.("Searching...");
    let resultIDs = await this.backend.query(query, limit);
    return resultIDs.map((id) => ({ id: id }));
  }

  /**
   * Hybrid lexical + vector reranking. Pipeline:
   *   1. Orama lexical search → top-N candidates (with text, no extra SQL)
   *   2. Embed query + candidate texts in one batched worker call
   *   3. Cosine-similarity score each candidate against the query
   *   4. RRF-fuse lexical rank + vector rank (constant k=60)
   *   5. Return top-`limit` by fused score
   *
   * `distance` in the returned items is `1 - cosine` so smaller =
   * closer, matching the convention of `vectorSearch` callers.
   */
  async hybridSearch(
    query: string,
    options: { limit?: number; predicate?: any; onStatus?: (status: string) => void } = {},
  ): Promise<{ id: any; distance?: number }[]> {
    const finalLimit = options.limit ?? 100;
    // Pull a wider candidate set than we'll return — vector rerank only
    // gets to look at what lexical recall surfaces, so headroom matters.
    const candidateLimit = Math.max(100, finalLimit * 2);

    options.onStatus?.("Indexing...");
    await this.buildIndexIfNeeded(options.predicate);

    options.onStatus?.("Searching...");
    const candidates = await this.backend.queryWithText(query, candidateLimit);
    if (candidates.length === 0) return [];

    // The trimmed-empty case: query has only stopwords or punctuation.
    // The lexical backend already filters those, so this is a fallback.
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return candidates.slice(0, finalLimit).map((c) => ({ id: c.id }));
    }

    options.onStatus?.("Reranking...");
    // Fast path: precomputed row vectors available. Embed the query
    // text only (one short string) and cosine against cached
    // candidate vectors. ~50ms total instead of ~10s.
    //
    // Slow path: no cache yet (warmup didn't run or hasn't finished).
    // Batch-embed [query, ...candidate texts] in one worker call.
    let queryVec: Float32Array;
    let candidateVecs: Float32Array[];
    if (this.allRowVectors != null && this.allRowVectors.size > 0) {
      const [qv] = await this.embedder.embed([trimmed]);
      queryVec = qv;
      candidateVecs = candidates.map((c) => {
        const v = this.allRowVectors!.get(c.id);
        // Missing vector should be rare (only if the dataset grew
        // after warmup, which doesn't happen in practice). Return a
        // zero vector so cosine = 0 and the candidate falls back to
        // pure lexical ranking.
        return v ?? new Float32Array(queryVec.length);
      });
    } else {
      const allTexts = [trimmed, ...candidates.map((c) => c.text ?? "")];
      const vectors = await this.embedder.embed(allTexts);
      queryVec = vectors[0];
      candidateVecs = vectors.slice(1);
    }

    // Cosine similarity (vectors are L2-normalized in the worker).
    const vecScores = candidates.map((_, i) => dot(queryVec, candidateVecs[i]));

    // RRF fusion. Lexical rank = Orama's input order (BM25-sorted).
    // Vector rank = candidates re-sorted by cosine descending.
    const k = 60;
    const vecOrder = candidates.map((_, i) => i).sort((a, b) => vecScores[b] - vecScores[a]);
    const vecRank = new Map<number, number>();
    vecOrder.forEach((idx, rank) => vecRank.set(idx, rank + 1));

    const fused = candidates.map((c, i) => ({
      id: c.id,
      distance: 1 - vecScores[i],
      rrf: 1 / (k + (i + 1)) + 1 / (k + vecRank.get(i)!),
    }));
    fused.sort((a, b) => b.rrf - a.rrf);

    return fused.slice(0, finalLimit).map(({ id, distance }) => ({ id, distance }));
  }
}

export interface SearchResultItem {
  id: any;
  fields: Record<string, any>;
  distance?: number;
  x?: number;
  y?: number;
  text?: string;
}

export async function querySearchResultItems(
  coordinator: Coordinator,
  table: string,
  columns: { id: string; x?: string | null; y?: string | null; text?: string | null },
  additionalFields: Record<string, any> | null,
  predicate: string | null,
  items: { id: any; distance?: number }[],
): Promise<SearchResultItem[]> {
  let fieldExpressions: string[] = [`${SQL.column(columns.id, table)} AS id`];
  if (columns.x) {
    fieldExpressions.push(`${SQL.column(columns.x, table)} AS x`);
  }
  if (columns.y) {
    fieldExpressions.push(`${SQL.column(columns.y, table)} AS y`);
  }
  if (columns.text) {
    fieldExpressions.push(`${SQL.column(columns.text, table)} AS text`);
  }
  let fields = additionalFields ?? {};
  for (let key in fields) {
    let spec = fields[key];
    if (typeof spec == "string") {
      fieldExpressions.push(`${SQL.column(spec, table)} AS "field_${key}"`);
    } else {
      fieldExpressions.push(`${SQL.sql(spec.sql)} AS "field_${key}"`);
    }
  }

  let ids = items.map((x) => x.id);
  let id2order = new Map<any, number>();
  let id2item = new Map<any, { id: any; distance?: number }>();
  for (let i = 0; i < ids.length; i++) {
    id2order.set(ids[i], i);
    id2item.set(ids[i], items[i]);
  }
  let r = await coordinator.query(`
    SELECT
      ${fieldExpressions.join(", ")}
    FROM (
      SELECT ${SQL.column(columns.id, table)} AS __search_result_id__
      FROM ${table}
      WHERE
        ${SQL.column(columns.id, table)} IN [${ids.map((x) => SQL.literal(x)).join(", ")}]
        ${predicate ? `AND (${predicate})` : ``}
    )
    LEFT JOIN ${table} ON ${SQL.column(columns.id, table)} = __search_result_id__
  `);

  let result = Array.from(r).map((x: any): any => {
    let r: Record<string, any> = { id: x.id, distance: id2item.get(x.id)?.distance, fields: {} };
    for (let key in x) {
      if (key.startsWith("field_")) {
        r.fields[key.substring(6)] = x[key];
      } else {
        r[key] = x[key];
      }
    }
    return r;
  });
  result = result.sort((a, b) => (id2order.get(a.id) ?? 0) - (id2order.get(b.id) ?? 0));
  return result;
}

export function resolveSearcher(options: {
  coordinator: Coordinator;
  table: string;
  searcher?: Searcher | null;
  idColumn: string;
  textColumn?: string | null;
  neighborsColumn?: string | null;
}): Searcher {
  let { coordinator, table, idColumn, searcher, textColumn, neighborsColumn } = options;

  if (searcher === null) {
    return {};
  }

  let result: Searcher = {};

  if (searcher?.fullTextSearch != null) {
    result.fullTextSearch = searcher.fullTextSearch.bind(searcher);
    if (searcher?.hybridSearch != null) {
      result.hybridSearch = searcher.hybridSearch.bind(searcher);
    }
  } else if (textColumn != null) {
    // FullTextSearcher on the text column. Same instance backs both
    // full-text and hybrid modes — the lexical retrieval step is
    // identical, and the embedder lives inside FullTextSearcher.
    let fts = new FullTextSearcher(coordinator, table, { id: idColumn, text: textColumn });
    result.fullTextSearch = fts.fullTextSearch.bind(fts);
    result.hybridSearch = fts.hybridSearch.bind(fts);
    // Hybrid is heavy on first call (~22MB model download + WebGPU
    // init). Expose warmup so the host can kick off model load in the
    // background after the dataset settles.
    result.warmup = fts.warmEmbedder.bind(fts);
    // Latent-space capabilities (row-vector cache + text embedding) for
    // chat features like `concept_axis`. Only the built-in searcher
    // exposes these; a host-supplied custom searcher would have to
    // implement them itself to enable those tools.
    result.getRowVectors = fts.getRowVectors.bind(fts);
    result.embedTexts = fts.embedTexts.bind(fts);
  }

  if (searcher?.vectorSearch != null) {
    result.vectorSearch = searcher.vectorSearch.bind(searcher);
  }

  if (searcher?.nearestNeighbors != null) {
    result.nearestNeighbors = searcher.nearestNeighbors.bind(searcher);
  } else if (neighborsColumn != null) {
    // Search with pre-computed nearest neighbors.
    result.nearestNeighbors = async (id: any): Promise<{ id: any; distance: number }[]> => {
      let q = SQL.Query.from(table)
        .select({ knn: SQL.column(neighborsColumn) })
        .where(SQL.eq(SQL.column(idColumn), SQL.literal(id)));
      let result = await coordinator.query(q);
      let items: any[] = Array.from(result);
      if (items.length != 1) {
        return [];
      }
      let { distances, ids } = items[0].knn;
      let r = Array.from(ids)
        .map((nid, i) => {
          return { id: nid, distance: distances[i] };
        })
        .filter((x) => x.id != id);
      return r;
    };
  }

  return result;
}

export async function performSearch({
  searcher,
  predicate,
  query,
  mode,
  limit,
  onStatus,
}: {
  searcher: Searcher;
  predicate: string | null;
  query: any;
  mode: string;
  limit: number;
  onStatus: (status: string) => void;
}): Promise<{ id: any; distance?: number }[]> {
  onStatus("Searching...");

  let searcherResult: { id: any; distance?: number }[] = [];
  let highlight: string = "";
  let label = query.toString();

  if (mode == "full-text" && searcher.fullTextSearch != null) {
    query = query.trim();
    searcherResult = await searcher.fullTextSearch(query, {
      limit: limit,
      predicate: predicate,
      onStatus: onStatus,
    });
    highlight = query;
  } else if (mode == "hybrid" && searcher.hybridSearch != null) {
    query = query.trim();
    searcherResult = await searcher.hybridSearch(query, {
      limit: limit,
      predicate: predicate,
      onStatus: onStatus,
    });
    // Hybrid still highlights the literal query in the dropdown so
    // users see why a row matched lexically; the vector contribution
    // is invisible but reflected in the ordering.
    highlight = query;
  } else if (mode == "vector" && searcher.vectorSearch != null) {
    query = query.trim();
    searcherResult = await searcher.vectorSearch(query, {
      limit: limit,
      predicate: predicate,
      onStatus: onStatus,
    });
    highlight = query;
  } else if (mode == "neighbors" && searcher.nearestNeighbors != null) {
    label = "Neighbors of #" + query.toString();
    searcherResult = await searcher.nearestNeighbors(query, {
      limit: limit,
      predicate: predicate,
      onStatus: onStatus,
    });
  } else {
    return [];
  }

  return searcherResult;
}
