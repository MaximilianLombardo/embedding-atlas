// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Full-text search worker backed by @orama/orama (BM25 + fuzzy + typo
// tolerance), drop-in replacement for the prior FlexSearch-based
// implementation. Same message protocol, so SearchWorkerAPI in search.ts
// is unchanged.
//
// Why Orama:
//   - BM25 relevance ranking (FlexSearch's forward-prefix mode had no
//     score; results were token-order arbitrary).
//   - Typo tolerance via `tolerance` (Levenshtein) — "authntic" matches
//     "authentic", which FlexSearch's prefix tokenizer could not do.
//   - Schema-typed documents with stored non-schema fields, so we
//     preserve the original id (number or string) alongside Orama's
//     required string id.

import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";

// Schema: `text` is the searchable string. `id` is required by Orama
// and must be a string (we coerce). `pointId` carries the original id
// type (number or string) for round-trip back to the caller.
const schema = { text: "string" } as const;

function makeDb() {
  return create({
    schema,
    components: {
      // English stemmer + stopwords is a sensible default; covers the
      // Latin-script content the FlexSearch encoder previously targeted.
      // Future: detect language from data or expose as a Searcher option.
      tokenizer: { language: "english", stemming: true },
    },
  });
}

let db: AnyOrama = makeDb();

export interface ClearRequest {
  type: "clear";
  identifier: string;
}

export interface PointsRequest {
  type: "points";
  identifier: string;
  points: { id: string | number; text: string }[];
}

export interface QueryRequest {
  type: "query";
  identifier: string;
  query: string;
  limit: number;
  /**
   * When true, return `{ id, text }[]` instead of just `id[]`. Used by
   * the hybrid path to embed candidate texts without a separate SQL
   * roundtrip (the worker already stores text on each doc).
   */
  withText?: boolean;
}

self.onmessage = async (e: MessageEvent<ClearRequest | PointsRequest | QueryRequest>) => {
  switch (e.data.type) {
    case "clear":
      db = makeDb();
      postMessage({ identifier: e.data.identifier });
      break;
    case "points": {
      // Orama requires the doc's `id` field to be a string. Preserve
      // the original id (which may be number) in `pointId` so search
      // results round-trip with the right type into the caller's
      // SQL pipeline.
      const docs = e.data.points.map((p) => ({
        id: String(p.id),
        pointId: p.id,
        text: p.text,
      }));
      await insertMultiple(db as any, docs);
      postMessage({ identifier: e.data.identifier });
      break;
    }
    case "query": {
      const results = await search(db as any, {
        term: e.data.query,
        properties: ["text"],
        limit: e.data.limit,
        // Levenshtein typo tolerance: 2 edits per query token. Tolerance
        // 1 catches single substitutions/insertions/deletions but misses
        // transpositions ("protien" ↔ "protein" = 2 substitutions in
        // standard Levenshtein), which are the most common typo class.
        // 2 covers those + double-finger-slips without exploding the
        // candidate set noticeably on this scale (≤ low thousands of
        // rows in the index).
        tolerance: 2,
        threshold: 0,
      });
      // hit.document is the stored doc; pointId is the original id.
      if (e.data.withText) {
        const result = results.hits.map((h: any) => ({
          id: h.document.pointId,
          text: h.document.text,
        }));
        postMessage({ identifier: e.data.identifier, result });
      } else {
        const ids = results.hits.map((h: any) => h.document.pointId);
        postMessage({ identifier: e.data.identifier, result: ids });
      }
      break;
    }
  }
};
