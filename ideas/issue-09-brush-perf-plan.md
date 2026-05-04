# Issue #9 Fix Plan — Brush Selection Performance

Concrete implementation plan for #9 (brush fires 30+ slow queries, drops FPS to 44). Verified via code reading on 2026-05-04. **No functionality is removed.** All four behavior contracts below stay intact.

## Behavior contracts that stay intact

1. Brushing the embedding view filters every other chart (sidebar count plots, table, embedding category breakdown). The cross-filter sync is preserved.
2. The brush rectangle is drawn live during the drag (visual feedback follows the mouse).
3. Side-panel chart bars show both the unfiltered total and the brush-filtered subcount.
4. All current SQL semantics (NULL handling, ENUM normalization, list/UNNEST mode) stay byte-identical in their results.

The only user-visible change: side panel charts update **once on mouseup** instead of two-or-more times during the drag. Net effect is a smoother brush, not a less responsive one.

## Root causes (mapped to code)

### A. `update()` fires on every mousemove, not just on commit

`packages/component/src/lib/embedding_view/EmbeddingViewImpl.svelte:467`
```ts
return {
  move: (e2: CursorValue) => {
    // ...
    setRangeSelection({ xMin, yMin, xMax, yMax });   // ← fires per mousemove
  },
};
```

`packages/component/src/lib/embedding_view/EmbeddingViewMosaic.svelte:282–293`
```ts
$effect(() => {
  let value = effectiveRangeSelection;
  // ...
  captured.update(clause);    // ← broadcast: every subscribed client re-queries
  captured.activate(clause);  // ← hint: should be cheap, but is paired with update
});
```

Mosaic's `Selection` API distinguishes:
- `activate(clause)` — emit a hint event so clients can prefetch/cache predicates
- `update(clause)` — broadcast the new active clause; subscribed clients re-query

The current code calls **both** on every mousemove. Mosaic's internal dispatch queue (`emitQueueFilter`) coalesces some, which is why the playwright session saw ~2 fires per drag instead of 10. But on real-user drags (with natural pauses), each fire breaks through.

### B. CountPlot recomputes brush-independent totals on every brush

`packages/viewer/src/charts/basic/CountPlot.svelte:129–146`
```ts
query: (predicate) => {
  return SQL.Query.from(table)
    .select({
      value: expr,
      count: SQL.count(),                                      // ← BRUSH-INDEPENDENT, recomputed every brush
      countSelected: SQL.sum(SQL.cast(filterExprToExpr(predicate), "INT")),
      total: SQL.sql`(${SQL.Query.from(table).select({ count: SQL.count() })})`,           // ← BRUSH-INDEPENDENT, recomputed every brush
      totalSelected: SQL.sql`(${SQL.Query.from(table).select({ count: SQL.count() }).where(predicate)})`,
    })
    .groupby(expr)
    // ...
}
```

The `count` (per-bucket total) and `total` (grand total) values do not change with the brush. They depend only on the table contents. Today they're re-aggregated on every filter update because the whole query is one statement attached to a filter-subscribed client.

At 1M rows this dominates. `count(*) GROUP BY value` on a 1M-row column is ~50-100ms. Multiply by 13 sidebar plots and it's a serious bottleneck even before the brush filter math.

### C. Filtered subcount uses `SUM(predicate::INT)` instead of `WHERE predicate`

Same query as above. `sum((predicate)::int)` scans every row and evaluates the predicate per-row. `count(*) WHERE predicate` lets DuckDB short-circuit on rows that don't match.

For brush rects that select a small fraction of points (typical interaction), the WHERE form is dramatically faster — it can use the projection-coordinate range to skip whole row groups in parquet.

## Fix plan (no functionality removed)

### Fix 1 — Defer `update()` to mouseup; keep `activate()` and visual feedback live

**File:** `packages/component/src/lib/embedding_view/EmbeddingViewMosaic.svelte`

Split the existing single `$effect` (lines 272–303) into two:

- **Hint effect** (fires per mousemove): updates local `effectiveRangeSelection`, calls `captured.activate(clause)`. Mosaic clients can prefetch query plans, but no broadcast happens.
- **Commit effect** (fires on mouseup): calls `captured.update(clause)`. Single broadcast per gesture.

Detection of "is dragging" comes from `EmbeddingViewImpl`. Cleanest path: add a `commit?: boolean` flag on `effectiveRangeSelection`'s setter. The `move` callback in `EmbeddingViewImpl.onDrag` (line 459) sets without commit; the drag's natural end (when `move` callback chain completes) sets with commit. Or simpler: pass a separate `onRangeSelectionCommit` callback alongside `onRangeSelection`.

Pseudocode:

```ts
// EmbeddingViewMosaic.svelte
$effect(() => {
  let value = effectiveRangeSelection;
  let clause = makeClause(value);
  // Always activate (cheap)
  captured?.activate(clause);
});

$effect(() => {
  let value = committedRangeSelection;  // separate state, set on mouseup only
  let clause = makeClause(value);
  captured?.update(clause);  // broadcast only on commit
});
```

The brush rectangle visual stays live because `effectiveRangeSelection` still updates on every mousemove (and the renderer reads it directly).

**Estimated effect**: single drag fires 1 update broadcast instead of 2-10. ~50-90% reduction in re-query work per gesture.

### Fix 2 — Split CountPlot into cached unfiltered client + live filtered client

**File:** `packages/viewer/src/charts/basic/CountPlot.svelte`

Replace the single client (lines 126–237) with two:

**Client A — unfiltered totals (cached)**
```ts
let clientA = makeClient({
  coordinator,
  // No selection — never re-fires
  query: () => SQL.Query.from(table)
    .select({ value: expr, count: SQL.count() })
    .groupby(expr)
    .orderby(...)
    .limit(limit + 1),
  queryResult: (result) => {
    unfilteredCounts = result.toArray();
    // also stash grand total via a separate query or sum the buckets
  },
});
```

**Client B — filtered sub-counts (live)**
```ts
let clientB = makeClient({
  coordinator,
  selection: filter,
  query: (predicate) => SQL.Query.from(table)
    .select({ value: expr, countSelected: SQL.count() })
    .where(predicate)         // ← WHERE, not SUM(::INT)
    .groupby(expr),
  queryResult: (result) => {
    filteredCounts = mapByValue(result.toArray());
  },
});
```

The visible chart data is `$derived` from joining the two:
```ts
let chartData = $derived.by(() => {
  return unfilteredCounts.map(row => ({
    value: row.value,
    count: row.count,                                  // from A (cached)
    countSelected: filteredCounts.get(row.value) ?? 0, // from B (live)
  }));
});
```

UNNEST mode (list-data branch, lines 147–171) gets the same split.

**Estimated effect**: client A runs once per CountPlot lifecycle. Client B does only the work that depends on the brush, and uses WHERE which DuckDB can skip-scan. At 1M rows, ~5× faster brush. At 100K rows, the cached unfiltered eliminates ~half the per-brush work.

**Edge cases preserved**:
- NULL bucket inclusion (`isNotNull` ordering) — applies to both clients identically.
- ORDER BY arrays — apply post-merge in the derived chartData.
- `(other)` rollup logic — same, derived from sums.
- Selection-active highlighting — unchanged (selection is local chart state, not the cross-filter).

### Fix 3 — Optional: drop the redundant projection re-fetch on brush

**Possible site:** unclear from static reading; needs a runtime trace. The console log showed two `SELECT projection_x, projection_y` queries during brush. One is `EmbeddingViewMosaic.svelte:97-105` (the main client). The second appears to be redundant.

Defer this until #9 fix lands and we re-measure. Likely small impact compared to fixes 1 & 2.

## Validation

After the fix:

1. **Profiling kit run** with `?profile=1`. Brush the embedding once. Expect:
   - Slow query count delta ≤ 15 (was ~30 then ~60)
   - p95 frame time stays under 12ms throughout (was up to 16.7ms)
   - FPS stays above 100 during brush (was dropping to 44 on second brush)
2. **Visual check**: brush rectangle still draws live on the canvas, no lag.
3. **Crossfilter check**: every sidebar count plot updates correctly to match the brushed subset, with a single update on mouseup.
4. **Reset check**: clearing brush returns all charts to unfiltered state.

## Effort estimate

- Fix 1: ~3-4 hours. Localized to two Svelte components, mostly mechanical (split effect, add commit callback).
- Fix 2: ~half-day. CountPlot rewrite is touchy (NULL/other handling, ordering, list mode); needs careful review of existing tests/specs. Both list-mode and standard-mode branches need treatment.
- Total: ~1 day for both, plus a re-measurement pass with the profiling kit.

## What this does *not* do

- No change to the cross-filter graph topology.
- No change to which charts subscribe to which Selections.
- No change to the SQL output values (results are byte-identical).
- No change to the brush UX during drag (rectangle visual still live).
- No removal of any feature.

## What this defers (separate workstreams)

- Mosaic's pre-aggregation/data-cube optimization for very high cardinality (defer until 1M+ rows is the typical workload).
- Reducing the default sidebar count plot count (UX call, not a perf fix).
- Cold-start cardinality scan optimization (separate issue, #10).
