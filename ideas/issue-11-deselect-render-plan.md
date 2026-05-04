# Issue #11 — Deselect render long-task: investigation & plan

Status: read-only research, no code changes. References `main` (post PR #12 brush-perf has not yet merged here, so `main`'s `CountPlot.svelte` is still the single-client version; the branch fix is at `origin/feat/brush-perf` for reference).

## TL;DR

- **The hypothesis is mostly right, but incomplete.** The CountPlot bar fan-out is the single largest contributor by element count (~13 plots × ~13 buttons × 2 inner bar `<div>` = ~340 absolutely-positioned divs with simultaneous `style:width` writes), and the layout/paint cost will scale with that count. But two other surprises matter:
  1. `Layer.svelte` (the histogram path) **wholesale rebuilds its `<g>` on every result** via `container.replaceChildren(frag)` (`packages/viewer/src/charts/spec/Layer.svelte:114-122`). On deselect, all 5 histogram SVGs blow away their rect children and re-create them. That's a real source of style recalc / paint that isn't proportional to "did data change".
  2. `transition:slide` on the table panel + `animate:flip` on chart cards (`layouts/list/ListLayout.svelte:158, 198, 217-218`) are already armed — they don't fire on deselect, but any layout-shift-adjacent change in that subtree will engage Svelte's transition engine. Not the current bottleneck, but worth noting before any "batch the re-render" fix.
- **Recommended next step: ship Fix A (skip-no-op) layered on top of Fix 2 from PR #12.** A is small, eliminates the entire long task in the common "click-to-clear" case, and de-risks B/C. If the user is moving from a *real* selection to no-selection, A still incurs the cost — that's where B (rAF batching) helps. C (canvas) is over-investment for v1830-scale data.

## 1. Hypothesis check: what actually re-renders on deselect?

When `filter.update({...predicate:null})` fires after ESC/click, every Mosaic client subscribed to the cross-filter re-runs its query. On `main`, the relevant subscribers are:

| Subscriber | Re-query? | DOM change on result | Notes |
|---|---|---|---|
| ~13 × `CountPlot` (`charts/basic/CountPlot.svelte:114-237`) | yes (one client per plot, full GROUP BY) | replaces `chartData` → re-runs `{#each chartData.items}` block → rewrites `style:width` on every bar | dominates element count |
| ~5 × histogram via `Chart.svelte` → `runtime.ts buildLayer` → `Layer.svelte` | yes (one client per filtered layer) | `container.replaceChildren(frag)` rebuilds **all** SVG `<rect>` children unconditionally | unconditional even if data identical |
| 1 × `Embedding` canvas | yes (re-query for category column / point set) | WebGPU re-paint | already on its own thread mostly |
| 1 × `Instances` table | yes (page query) | `<tr>` re-render via `{#each data}` | bounded by visible rows (~30) |
| `Predicates`, `FilteredCount`, `Legend` | yes | small | negligible |

So the user's intuition is correct that **CountPlots dominate by raw element count**, but the histograms have a structural problem of their own: on `main` they cannot tell "data unchanged" because `Layer.svelte:114` is a plain `$effect` that always rebuilds the `<g>`. With ~5 histograms × ~20 rects each, that's ~100 SVG node creations + a `replaceChildren` per histogram per deselect — measurable, and it scales with `desiredCount` of bins (default 20).

**Caveat for the v1830 dataset:** since chart count is small (~13+5) and rows fit in cache, the *JS* work is genuinely bounded — matches your CDP profile (top JS function `OY` at 31ms, total < 100ms). The 983ms is overwhelmingly browser-internal layout/paint after the JS finishes, exactly because all those `style:width` writes and SVG mutations land in one synchronous flush.

### Why "moving from selection X to no-selection" is worse than "no-op deselect"

If the user had a real brush, then before and after deselect the bar `width:` strings differ on most rows. Layout is forced for every changed div. If the user clicked-to-clear without ever brushing (`selection: undefined → undefined`), the chartData identity changes (new `$state.raw` set) but the *rendered* widths are identical. Svelte 5 still re-runs the keyed `{#each}` body and re-applies `style:width="{px}px"` even when the string is the same — the browser dedupes the actual style mutation, but Svelte's update path still touches every element. **This second case is the big A-fix opportunity.**

## 2. Three candidate fixes ranked

### A. Skip no-op renders (RECOMMENDED FIRST)

**Mechanism.** In `CountPlot.svelte`'s `queryResult` (line 173), and analogously in `Layer.svelte`'s `$effect` (line 114), compare incoming data to the previously-emitted `chartData` / `layer.data`. If counts and value ordering are identical, return early and *don't* assign to the reactive cell. Use `deepEquals` from `@embedding-atlas/utils` (already imported in `runtime.ts:3`) or a hand-rolled shallow check on `(value, count)` pairs.

For `Layer.svelte` specifically, gate the `replaceChildren` behind a `deepEquals(layer, prevLayer)` check at the top of the effect.

**Effort.** 0.5–1 day. Two files, ~30 lines, plus a unit test for the equality predicate.

**Expected impact (v1830).** Eliminates the long task entirely in the click-without-brush flow (estimated ≥80% of "deselect" gestures in normal use). For genuine "had selection → cleared" flows, no improvement (A doesn't help when data really differs).

**Scaling.** Independent of dataset size — a constant-cost gate.

**Risks.**
- `chartData` consumers in CountPlot rely on identity for `maxCount` `$derived` (line 58). If we keep the previous reference, `maxCount` correctly stays cached. Safe.
- Hover/click on bars: `toggleSelection` reads `selection` and `chartData.items` — neither identity nor structure changes when we skip, so safe.
- The split-client architecture from `feat/brush-perf` (`origin/feat/brush-perf 0900dd5`) makes A even cleaner: the unfiltered client emits once and never again, and the filtered client can short-circuit on `predicate==null` (it already does — see the "When the cross-filter has no clauses" comment on the branch). A on top of that branch reduces to "skip-when-equal" on the filtered side only.
- One subtle risk: **list-typed CountPlots** (`isListData` true, see line 147) build an intermediate UNNEST table — equality check is still on the final rows, so unaffected.

### B. Batched / idle re-render

**Mechanism.** Wrap the assignment to `chartData` (and `Layer.svelte`'s `replaceChildren`) in a microtask coalescer: if multiple Mosaic clients fire `queryResult` in the same tick (which they do — Mosaic flushes its update queue together), only schedule one `requestAnimationFrame` per chart and apply the latest result. To break the long task across frames, stagger plots: the first plot updates on frame N, plots 2–4 on frame N+1, etc.

**Effort.** 1–2 days. Trickier than it sounds because:
- Mosaic owns the `queryResult` callback; you'd need the deferral inside the chart, not inside Mosaic.
- Need to reason about correctness when filter changes again before the rAF fires (must coalesce, not queue).
- The slide/flip transitions in `ListLayout.svelte:158,217` will compound visible jitter if charts update at different frames.

**Expected impact (v1830).** Doesn't reduce *total* main-thread time, but breaks the 983ms blob into ~6 × ~160ms tasks. INP and "felt smoothness" improve; total CPU does not. For a user staring at a fully-painted UI mid-interaction, this can actually feel *worse* (visible tearing as plots update at staggered frames) unless paired with `view-transition`-style cross-fade.

**Scaling.** Helps proportionally as chart count grows. Best for dashboards with 30+ charts.

**Risks.**
- Tearing — different plots showing pre/post-deselect state for one frame each.
- Hover/click latency increases (a click now races against the pending rAF).
- Interaction with `transition:slide`: if the table panel is mid-transition, layered animations get expensive fast.

### C. Canvas-based bars

**Mechanism.** Replace `CountPlotBar.svelte`'s absolute `<div>` strategy with a single `<canvas>` per CountPlot, drawn imperatively on `chartData` change. Histograms could similarly migrate from `Layer.svelte`'s SVG path to `LayerCanvas.svelte` (which already exists as the >2000-row fallback — see `Chart.svelte:34, svgLimit = 2000`).

**Effort.** 3–5 days. The DOM bars carry more than width: hover targets, click handlers per bar, the dashed separator hr, the marquee dashes (`CountPlotBar.svelte:31-37`), accessibility (each bar is a `<button>`), tooltip via `title` attr. A canvas rewrite has to re-implement hit-testing, focus management, screen-reader semantics. Non-trivial.

**Expected impact (v1830).** Probably modest gain (~30–50% of layout cost) because at 1.9K rows the SQL+JS is the dominant share of the small remaining cost. The win is shape, not slope.

**Scaling.** Best at 100K+ rows where you'd want >100 bars per plot. But CountPlot's `limit` defaults to 10 and caps at 100 (line 456), so the bar count never exceeds ~100 per plot regardless of dataset size. Canvas-vs-DOM matters less than expected for *this* widget. **Histograms scale better with C** because they're already canvas-fallback above 2000 rows; lowering `svgLimit` is essentially free C-for-histograms.

**Risks.**
- Lost: keyboard navigation between bars, focus rings, native button semantics, browser-level tooltip on `title`.
- Pixel snapping differences between DOM and canvas — the existing rounded corners (`rounded-sm`, line 27) and the marquee whitespace (lines 31-37) need re-implementation.
- Accessibility regression unless we keep an off-screen `<button>` shadow tree.

## 3. Recommendation

Order:

1. **Land A (skip-no-op) first.** Highest impact-per-effort. Eliminates the long task in the most common path (click-to-clear without ever brushing). Safe to ship before `feat/brush-perf` merges; even better after, because the split-client design narrows what A has to compare.
2. **Lower `Chart.svelte:34`'s `svgLimit` to ~500 OR add a deepEquals gate to `Layer.svelte:114` first.** Same cost gate as A, applied to histograms. Probably equivalent to A; do them as one PR.
3. **Defer B until we have a real >50-chart dashboard scenario.** rAF batching is a scaling fix without a current scaling problem.
4. **Defer C indefinitely.** Bar count caps at 100 by spec; canvas isn't worth the a11y cost. Only revisit if the histogram path shows up as dominant after fix 2.

## 4. Surprises found while reading

- **`Layer.svelte:114` always rebuilds the `<g>`.** This is the single highest-impact issue not yet on your radar. It's a `$effect` with no equality gate that does `container.replaceChildren(frag)` on every Mosaic queryResult. Tag for the same equality-gate fix as A.
- **`runtime.ts:266-268` sets outputs unconditionally.** `derived(allOutputs).subscribe` calls `outputs.set(chartOutputs(...))` with a freshly-built object every time, so even consumers that *would* have memoized get a new identity. If you add a chart-level memo, do it here, not at every consumer.
- **`Chart.svelte:42-44` constructs a `new ChartRuntime(context, ...)` in module-init position with `state_referenced_locally`.** It's flagged with the svelte-ignore comment, so this is intentional, but means runtime is per-component-instance — fine, but worth knowing if you ever try to share a runtime.
- **`ListLayout.svelte:158, 198, 217-218` arms `transition:slide` and `animate:flip` on the chart panel container and per-card.** They don't fire on deselect today, but if Fix B introduces staggered updates, FLIP will engage on every chart whose layout shifts and amplify cost dramatically. Be sure B disables animations during filter-change flushes.
- **CountPlot `chartData` is `$state.raw`** (line 53) — already opting out of deep proxying, good. The keyed `{#each chartData.items}` is doing a per-item identity comparison; if A swaps "skip when equal" to "reuse the previous chartData reference exactly", Svelte will short-circuit the `each` block entirely without per-item compares. **This is the cleanest A implementation: assign-only-on-actual-change, ref-equality wins for free.**
- **The split-client fix on `feat/brush-perf` already short-circuits the filtered client** when `predicate==null` (no-op clauses). That means once that branch merges, the "click without brush" case described in section 1 already won't re-query — but it *will* still emit a new `filteredData = null` reactive write, which still triggers the `chartData` `$derived` recompute and the `{#each}` re-render. So A is still needed on top of that branch; the gate just moves to a different layer.
- **`@uwdata/mosaic-core` `makeClient` calls without `selection:`** (the unfiltered client on the brush-perf branch) still subscribe to the coordinator's update tick. Confirm via Mosaic source that they don't queue spuriously on every filter change — if they do, A protects us anyway.

## 5. Test plan (when implementing)

- Re-run the same Playwright/CDP profile on `?profile=1` against the v1830 dataset, click-without-brush. Expect main-thread long task to drop from ~983ms to <50ms.
- Brush, then ESC. Compare deselect cost to current main; expect Layer.svelte gate to shave ~5×(SVG-rect-create cost) per histogram.
- Brush across two CountPlots in series (selection changes value, not just on/off). Expect no regression: equality gate must return false and a real re-render must happen.

## Files referenced

- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/basic/CountPlot.svelte` (lines 53, 58, 114-237, 396-431)
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/basic/CountPlotBar.svelte` (lines 21-42)
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/spec/Layer.svelte` (lines 114-122) — biggest surprise
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/spec/Chart.svelte` (lines 34, 42-57, 95-110)
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/spec/runtime.ts` (lines 266-268, 344-385)
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/charts/default_charts.ts` (lines 146-174)
- `/Users/mlombardo/Documents/dev/embedding-atlas/packages/viewer/src/layouts/list/ListLayout.svelte` (lines 158, 198, 217-218)
- `/Users/mlombardo/Documents/dev/embedding-atlas/ideas/profiling-playbook.md` (kit reference)
- `origin/feat/brush-perf` commits `00eae08`, `0900dd5` (split-client design context)
