# Performance Hunt Playbook

How to use the profiling kit to identify viewer bottlenecks. Tracks issue #2.

## Setup

Append `?profile=1` to the dev URL:

```
http://localhost:5056/?profile=1
```

You should see a small overlay top-right showing:

- **fps** — instantaneous frame rate (last ~2s window). Goes red below 50.
- **Xms p95** — 95th-percentile frame time. Goes amber above 20ms.
- **N slow Q (Xms)** — count of queries exceeding 50ms. Last duration in parens. Goes amber when nonzero.

Slow queries also log to the browser console:

```
[profile] slow query 87ms SELECT count(*) FROM dataset WHERE ...
```

Failed queries log as errors with full SQL.

Zero overhead when `?profile=1` is absent — call sites short-circuit before any wrapping.

## Recording a session

Use Chrome DevTools (or equivalent):

1. DevTools → Performance tab
2. Click the round **Record** button
3. Perform one interaction from the list below
4. Stop after ~5s
5. Wide bars in the **Main** thread track are JS bottlenecks
6. Many short Layout / Recalculate Style entries = layout thrash
7. Any task > 50ms is a frame-budget burner

Save the recording as `.json` if you want to share. Don't commit recordings — they include browsing data.

## Interactions to record

Record one per session so each flame graph is interpretable.

1. **Brush selection on the embedding** (drag a rectangle). Watch the main thread + slow Q count.
2. **Click a single point** in the embedding (table reveal flow). Catches `animateToPoint` + ROW_NUMBER query.
3. **Scroll the table to the bottom** of a 10K+ row dataset. Catches Mosaic page-fetch latency.
4. **Recolor by changing the categorical column** in the embedding spec. Catches `makeCategoryColumn` + WebGPU re-upload.
5. **Add a histogram chart** for a numeric column. Catches Predicates + chart construction effects.
6. **Switch from list layout to dashboard layout**. Catches layout re-mount + chart re-construction cost.
7. **Type a multi-word message into the chat input**. Catches keystroke handler chains.

## Slow-query attribution

When the console logs a slow query, attribute it to a chart by inspecting:

- The `WHERE` clause — references the active crossfilter selection.
- The selected columns — usually identifies which chart owns the query.
- The `FROM` subquery — `instancesQuery` (table), `Query.from(table)` (most charts).

Common slow-query signatures to know:

| Signature | Likely owner |
|---|---|
| `SELECT count(*) FROM ...` | `clientTotal` in `Instances.svelte`, or other count clients |
| `SELECT __id__, ... LIMIT 100 OFFSET ...` | Table page client |
| `SELECT __ev_*_id, COUNT(*) ... GROUP BY ...` | Embedding category column |
| `SELECT ROW_NUMBER() OVER (ORDER BY ...) ...` | `offsetForId` in Instances → animateToPoint |
| `WITH binned AS (...)` | Density-mode embedding, or histogram |

## Hypotheses to verify (from static analysis, 2026-05-04)

A pre-hunt static analysis (background agent run) flagged these locations
as suspect. The hunt session should verify which actually matter at
runtime. Listed in rough order of expected impact.

### Effects that fire SQL queries

These dominate the slow-query log. Any of them firing more than once
per user action is a bug, not a feature.

- `Embedding.svelte:77` — `$effect.pre` fetches total point count without dependency guard.
- `Embedding.svelte:90` — `makeCategoryColumn` cache-wrapped query, fires on `categoryColumn` change.
- `Embedding.svelte:128` — `searchResult` subscriber runs `coordinator.query` inside async handler.
- `Embedding.svelte:163` — `coordinator.query` inside `animateToPoint`, per-selection.
- `EmbeddingViewMosaic.svelte:74,143–150` — `makeClient` re-init on coordinator/table/x/y/category change; tooltip Selection identity changes.

### Effects with object-identity dependencies

These re-fire when the *value* hasn't changed but the *reference* has —
classic Svelte 5 footgun.

- `EmbeddingAtlas.svelte:97` — `resolvedColumnStyles` derived from columnStyles object identity.
- `EmbeddingAtlas.svelte:213` — debounced search effect re-fires on `searchQuery`/`searchMode` string changes.
- `Instances.svelte:218–230` — `clientsParams` derived via `deepMemo` (already protected, but check).
- `Instances.svelte:51–70` — highlight-store subscriber with O(n) `indexOf` array compare.
- `EmbeddingViewImpl.svelte:247` — `renderer.setProps()` with 12+ derived prop spread; any upstream change forces re-render.
- `Legend.svelte:61–62` — nested `$effect.pre` reading arrays that allocate new Sets per fire.

### Cheap allocations on hot paths

Probably not the actual bottleneck, but easy wins if confirmed.

- `Cards.svelte:20`, `Table.svelte:39` — `$derived(new Set(highlight))` allocates on every highlight change.
- `Table.svelte:40` — `inferColumnFormatters(data, columns)` may walk all data rows; on every page change.

### Resource leaks (correctness, not perf, but check)

- `FilteredCount.svelte:17` — `makeClient` reassigned without destroying previous.

## What to do with the findings

1. After a hunt session, file each verified bottleneck as a follow-up
   issue with `perf` label, linking back to #2.
2. Each issue should include: the recording (or screenshot of the wide
   bar), the file:line of the suspected code, and a one-line
   "what to try" hypothesis.
3. Fix in a small PR per issue. Re-run the same recording after the fix
   to confirm the bar shrank.

Pre-fix recording vs. post-fix recording is the receipt. Keep them
together in PR descriptions.
