# Table Rebuild — Virtualized, TanStack-Inspired

Status: **shipped on `feat/table-virtualized` (PR #24).** v1, Phase 2,
and the surrounding settings/perf/UX work that landed alongside are
all merged onto the branch. This doc started as a "measure twice"
plan; the planning sections below are preserved for context, with
an **As-built** summary at the top and a **Still open / deferred**
list at the bottom flagging what's loose.

## Goal

Replace `packages/viewer/src/charts/instances/Table.svelte` with a virtualized
table built natively in Svelte 5, inspired by — but not ported from — the
React TanStack table at `chanzuckerberg/biohub-research-atlas`
(`archive/viewer/src/components/flat-view/FlatTable.tsx`).

Two non-negotiable constraints frame everything below:

1. **Preserve every existing integration.** The table is wired to Mosaic
   crossfiltering, the embedding view's "click a point → reveal that row,"
   the highlight store, sort spec, custom-query mode, and the cards/table
   segmented control. Migration is silent if the user doesn't open the
   table tab; visible only as a smoother scroll experience when they do.
2. **Scale.** Drop the 100-row paginator. Virtualize against an unbounded
   row count, with SQL-driven windowing through Mosaic. Today's largest
   datasets are tens of thousands; the design must hold to millions.

The user explicitly preferred a **from-scratch Svelte rebuild** over porting
React patterns line-for-line. That's the right call: the React archive is a
shape we recognize, not source we copy.

## As-built (shipped Apr–May 2026)

What's on `feat/table-virtualized` today. The planning narrative below
is preserved for context, but this section is the source of truth for
"what does the code do right now."

### v1 — virtualized table (commits `0a19ef3..2f88a66`)

Steps 0–9 of the original plan. The table is fully virtualized and
silent-by-default for any caller who doesn't open the table tab.

- `packages/viewer/src/charts/instances/lib/table_core.svelte.ts` —
  thin Svelte 5 runes wrapper around `@tanstack/table-core`.
  Imperative `setState` / `setOptions`; reactive `getState()` overlay
  via a state rune so `$derived` reads pick up table-core mutations.
- `packages/viewer/src/charts/instances/lib/window_loader.svelte.ts` —
  Mosaic-backed sliding-window cache. Two clients (count + windowed
  data), both subscribed to `context.filter`. Defaults:
  `WINDOW_SIZE = 2000`, `OVERSCAN = 1000`, slide throttle 100 ms.
  Always-commit semantics in `queryResult` so flick-scrolls don't
  flash skeletons.
- `packages/viewer/src/charts/instances/lib/use_column_widths.svelte.ts`
  + `lib/use_column_state.svelte.ts` — localStorage persistence
  for column widths and combined visibility/order/pinning,
  cleanup-on-read for stale columns.
- `packages/viewer/src/charts/instances/Table.svelte` — virtualized
  via `@tanstack/svelte-virtual`, ROW_HEIGHT=32, padding-row spacers
  to preserve sticky-header z-ordering. `getElementForId` is async
  (mirrors the embedding-click-reveal contract).
- `packages/viewer/src/charts/instances/DetailDrawer.svelte` — D3
  click-to-open detail panel; reuses `TooltipContent`.
- `packages/viewer/src/charts/instances/Instances.svelte` — owns
  the loader, drives `animateToPoint`, mounts Table + DetailDrawer.
- 100-row paginator removed. `spec.state.offset` repurposed as
  initial scroll-to-row.
- Cards view dropped as a peer of Table (commit `68b484f`); the
  `Cards.svelte` file is kept dormant but unreferenced.

### Phase 2 — bells & whistles (commits `2a02e01..` ish)

- **Column visibility / order / pinning** — drag handle in
  `ColumnControls.svelte`, pin-left toggle, persistence via
  `use_column_state.svelte.ts`. table-core integration for
  `columnSizing` only; the rest is a parent-owned `columnState`
  rune that drives `visibleColumns` directly (avoids table-core's
  controlled-state plumbing for the parts we don't need).
- **Per-column header filters** — `HeaderFilterPopover.svelte`
  fetches top-100 distinct values for categorical columns,
  publishes a `column IN (values)` predicate to `context.filter`
  via a stable per-column source object. List columns
  (`jsType === "string[]"`) use `list_has_any`. Numeric/date
  defer to the predicates panel.
- **CSV export** — reuses `exportMosaicSelection`; predicate
  is the current cross-filter, computed at click time.
- **Cards 2D virtualization** — `Cards.svelte` rebuilt with
  `@tanstack/svelte-virtual`'s `lanes` API (currently dormant
  per the Cards-as-peer-of-Table removal, but the implementation
  is intact for future reuse).

### Settings reorganization (post-Phase-2)

- **`ChartDelegate` extended** with `settingsTitle`, `settingsIcon`,
  `settingsContent` (Snippet). `chart.ts` — backwards-compatible
  optional fields. Charts register a settings snippet via
  `registerDelegate`; the host renders them in the settings UI.
- **`SettingsDrawer.svelte`** — right-edge overlay, 400 px wide,
  vertical tab strip on the left + tab content + footer
  (MCP status + version). `Instances.svelte` registers a "Table"
  tab (`IconTable`); `Embedding.svelte` registers an "Embed" tab
  (`IconEmbeddingView`) holding the controls that previously
  lived in the embedding canvas's own gear popup. Active tab key
  persisted to localStorage.
- **The previous `PopupButton`-based settings menu was removed.**
  Top toolbar's right-hand pill (filter count / clear-X / export
  selection) was relocated: count + clear-X went into the
  embedding canvas's bottom-right `StatusBar` (extended with a
  `totalCount` prop in `@embedding-atlas/component`); Export
  Selection moved into the drawer's Global → Export section.

### Performance fixes (chrono late in the work)

These came up during animation testing of the chart show/hide toggle
and the slide transitions; documented here because the architecture
implications outlive the fixes.

- **`ChartView.svelte` screenshot delegate registration is `untrack`-wrapped.**
  `LayoutView.svelte`'s `chartView` snippet creates a fresh inline
  arrow for `registerDelegate` on every render. Without `untrack`,
  the screenshot effect re-fired ~60×/sec during layout transitions,
  cycling the SvelteMap of registered delegates and amplifying
  reactive churn through `chartSettingsGroups`.
- **`Instances.svelte`'s settings-delegate effect is also `untrack`-wrapped**
  for the same reason.
- **`ListLayout.svelte`'s table panel stays mounted** across the
  show/hide-table toggle. Was `{#if hasTable}` + `transition:slide`
  → mount/unmount cycle every toggle, which made every show pay
  the full WindowLoader + table-core + virtualizer + 40-column
  HeaderFilterPopover mount cost (~250 ms synchronous burst).
  Now CSS `grid-template-rows: 0fr ↔ 1fr` with the chart always in
  the DOM, paid mount cost once.
- **Two-layer wrapper for stable virtualizer height during the
  toggle.** Outer wrapper animates `height: 0px ↔ tableHeight`,
  inner wrapper holds `height: tableHeight` always. The
  `@tanstack/svelte-virtual` ResizeObserver only fires on
  content-rect changes, so the virtualizer never recomputes
  mid-animation and visible rows are pre-rendered before frame 0.
- **Column-state derived was originally backed by a manual `$state`
  tick** in `EmbeddingAtlas.svelte`. That created an infinite loop
  through the same prop-identity-churn → `chartSettingsGroups`
  derived → re-render path. Replaced with `SvelteMap` /
  `SvelteSet` for native reactivity. Lesson: adding reactivity
  downstream amplifies upstream churn that was previously harmless;
  insulate at the consumer with `untrack`.

### Surrounding UX cleanups

- **Dark mode** was reaching only the inner content wrapper of the
  atlas root, not the drawer (which is a sibling overlay). The
  `class:dark` toggle and `color-scheme` style now live on the
  `embedding-atlas-root` itself.
- **Embedding StatusBar count** is now filter-aware:
  `pointCount / totalCount points` when they differ; plain
  `pointCount points` when full. The `@embedding-atlas/component`
  package was rebuilt to ship the StatusBar prop change.



`Instances.svelte` is the orchestrator. It owns:

- Two Mosaic clients: a count client (`COUNT(*)`) and a window client
  (`SELECT … LIMIT pageSize OFFSET offset`). Both subscribe to
  `context.filter` (the global crossfilter `Selection`), so they re-fire
  automatically whenever any other chart changes the filter.
- A `prepare` step that runs `DESCRIBE` on the base query to discover
  column names, samples 10 rows to compute `defaultColumnWidths`, and
  honors `columnStyles[col].display === "hidden"`.
- An `offsetForId(id)` callback built from a `ROW_NUMBER() OVER (ORDER BY …)`
  query — used to find what page a given row lives on.
- An `animateToPoint(id)` flow: if the highlighted row is in the current
  page, scroll to it; otherwise change `offset` to its page, then scroll
  once new data lands. This is the embedding-view ↔ table reveal contract.
- An `isolatedHighlight` writable that decouples row-click writes from
  external highlight reads (lets us update highlight without bouncing).
- The view-mode toggle (`table | cards`), the paginator, and the
  `SortOrderControl`.

`Table.svelte` is a pure presenter. It receives `data` (current page),
`columns`, `columnDescs`, `columnStyles`, `defaultColumnWidths`, `highlight`,
`sort` plus `onRowClick`/`onSortChange`. It owns:

- Resized `columnWidths` (overrides defaults, lost on remount).
- Per-row `expandedRows` (in-place clamp toggle for long cells).
- Hover state for the expand button.
- An `idMapper: Map<RowID, Element>` and a `getElementForId(id)` export
  used by `Instances.animateToPoint`.

`Cards.svelte` is the sibling presenter at the same level, sharing the
`getElementForId` contract.

## Public surface to preserve

These are contracts other parts of the viewer depend on.

| Contract | Where it shows up | Plan |
|---|---|---|
| `getElementForId(id): Element \| undefined` | `Instances.svelte:282–296` | Keep verbatim. Implementation changes (virtualizer scrollToIndex + rendered row lookup), signature does not. |
| `onRowClick(rowId, event)` with shift/ctrl/meta multi-select | `Instances.svelte:307–329` | Identical contract. |
| `onSortChange(sort)` | sort persists in `spec.sort` | Identical contract. Sort happens server-side via Mosaic ORDER BY (do **not** use TanStack's `getSortedRowModel`). |
| `highlight: RowID[] \| null` reactive prop | renders highlighted rows differently | Identical contract. |
| `columnStyles[col].display === "hidden"` | filtered in `prepare` | Identical. |
| Custom `spec.query` mode (no `__id__`, no `offsetForId`) | `query.ts`, `Instances.svelte:259–263` | Identical. Virtualization still works; row-reveal is just disabled in this mode (matches today's behavior). |
| ColumnDesc-driven cell alignment | `Table.svelte:51–57` | Same rule (`jsType === "number"` → right). |
| `ContentRenderer` per-cell with `columnStyles` + `columnFormatters` | `Table.svelte:192` | Unchanged. The rebuild shells `ContentRenderer` inside the virtualized cell. |
| Cards view as sibling | view-mode segmented control | Cards.svelte unchanged. v1 virtualizes only the table. |

## Library decision

**Use `@tanstack/table-core@8.21.3` directly + a thin Svelte 5 runes
wrapper. Use `@tanstack/svelte-virtual@3.13.24` as-is.**

Why not `@tanstack/svelte-table`:

- Latest stable peer-deps Svelte 3 or 4 only. v9 is alpha.
- The Svelte adapter is ~150 lines of subscribe-store glue; trivial to
  replace with a runes-native version using `$state` + `$derived`.
- Sidesteps any future churn when v9 stabilizes — we're not on the upgrade
  path of an adapter we don't need.
- Forces us to think clearly about what state TanStack owns vs. what
  Svelte owns — which is healthy for this rebuild.

Why use `@tanstack/svelte-virtual`:

- Officially supports Svelte 5 (`peerDependencies.svelte: "^3.48.0 || ^4.0.0 || ^5.0.0"`).
- Variable-row-height via `measureElement` is well-supported and we need
  it for the in-place expand feature.

## The hard problem: virtualization × Mosaic windowing

This is the part most likely to bite us if we don't think it through up
front. The naive translation — "TanStack-virtual driven by an in-memory
`data: Row[]` array" — only works if we eagerly fetch every row. That
caps us at maybe 50K rows before the browser tab is unhappy.

The real design is a **sliding window over a virtual length**:

```
virtualizer.count = totalCount        (e.g. 2_000_000)
virtualizer.range = [4500, 4720]      (visible rows)
window.offset    = 4400               (we hold 4400..4799)
window.size      = 400                (page-size analogue)
```

When `virtualizer.range` drifts past the window edge, we slide the window
and issue a new query. Rows in `[range.start..range.end]` outside the
window render as skeletons until data arrives.

### Concrete window strategy

- `WINDOW_SIZE = 400` (tunable; ≈ 4× a typical viewport at row-height 28).
- `OVERSCAN = 200` rows preloaded in scroll direction.
- Slide the window when `range.end > window.offset + WINDOW_SIZE - OVERSCAN`
  or `range.start < window.offset + OVERSCAN`. New offset =
  `range.start - WINDOW_SIZE/2`, clamped to `[0, totalCount - WINDOW_SIZE]`.
- Throttle window-slide queries (~100ms) so flick-scroll doesn't fire 30
  Mosaic queries. The throttle is a leading-trailing edge; head and rest
  position fire, intermediate scroll positions drop.
- Mosaic's `makeClient` debounces internally too, so this is belt-and-
  suspenders, but explicit is right here.
- Optional second-tier cache of `[offset → result]` LRU with cap 5 windows
  (~2K rows) for fast back-scroll. Defer to v2 if v1 feels fine.

### Skeleton rows

Show a row-shaped placeholder for rows in `range` not yet in `window`:

- Same height as a normal row (variable-height aware via `measureElement`
  with a known min size).
- Light shimmer or muted bg, no cell content.
- Crucially: clicking a skeleton is a no-op (don't fire `onRowClick` with
  `undefined`).

### Sort and filter changes invalidate the window

Today's `Instances.svelte` resets `offset` to 0 on filter change and on
`clientsParams` change (sort, columns, query, columnStyles, pageSize). The
rebuild does the same: any of those changes drops the window cache,
resets `virtualizer.scrollToIndex(0)`, refetches.

### `animateToPoint(id)` in the virtualized world

Today: find offset via `ROW_NUMBER`, change page, scroll on data load.

Rebuild:

1. Compute `targetIndex = await offsetForId(id) - 1`. (Subtract 1 because
   ROW_NUMBER is 1-based.)
2. `virtualizer.scrollToIndex(targetIndex, { align: "center" })` —
   triggers range change.
3. The range-change handler pulls the window if needed.
4. When the row's data lands and the row renders, the `idMapper` Map
   gets populated. A small `$effect` watches for `idMapper.has(id)` and
   calls `scrollIntoView` once available. (This handles the case where
   virtualizer's scrollToIndex lands close to but not exactly on the row.)

Edge case: if `id` is no longer in the filtered set (filter changed
between embedding-click and table-respond), `offsetForId` returns
`undefined`. Today's code silently no-ops; rebuild does the same.

## TanStack feature picks for this rebuild

The user asked which TanStack features beyond virtualization are worth
including. Triaged against what the table actually needs:

### Include in v1

| Feature | Source of value | Implementation note |
|---|---|---|
| **Virtualized rendering** | scale to millions | `@tanstack/svelte-virtual`, padding-row pattern. |
| **Multi-column sort state** | already exists, but TanStack's state model is cleaner | `manualSorting: true` — TanStack owns state, Mosaic does the actual ORDER BY. Connects to `spec.sort` via setSorting. |
| **Uniform row height (~32px)** | faster O(1) virtualizer math; simpler | Replaces in-place expand with click-to-open detail drawer (see D3). No `measureElement` needed. |
| **Column resizing** | already exists | Use TanStack's `columnResizeMode: "onChange"` + `getResizeHandler`. Persist to localStorage keyed by table identity (NEW vs. today's lost-on-remount). |

### Include in v2 (separate follow-up branch)

| Feature | Source of value | Notes |
|---|---|---|
| **Column visibility menu + localStorage** | real win — wide schemas need it | The archive's `useColumnVisibility` is a 30-line hook; port to a Svelte 5 rune helper. Honors `columnStyles[col].display === "hidden"` as a default-off rather than an absolute. |
| **Column pinning (left only)** | wide tables, keep id/title visible | TanStack v8 only tracks pin state, not pixel offsets. Compute offsets from the pinned columns' resolved widths (the archive does this manually too). |
| **Column reorder (drag)** | nice but secondary | Native HTML5 DnD or a small dnd lib. Not urgent. |
| **CSV export of visible-rows window or full** | utility | Easy: take current rows or run a fresh COPY query for full. |

### Defer indefinitely

| Feature | Why not |
|---|---|
| `getSortedRowModel` / `getFilteredRowModel` / `getPaginationRowModel` | We do all of this in SQL. Using TanStack's client-side row models would force eager-fetch and break scale. |
| Per-column header filter dropdowns + faceted counts | Crossfilter via embedding/predicates already does this view-wide. Adding column filters duplicates the mental model. |
| Row selection (checkbox column) | Couples to `context.filter` Selection — separate feature ("select a subset of points from the table"), worth its own design. The user did mention wanting this; file as `ideas/table-row-selection.md` after v1 ships. |
| Row pinning, grouping, aggregation | Not relevant to a flat record viewer. |
| Global search | Better surfaced via the chat or a Predicates chart. |

## Component layout after rebuild

```
Instances.svelte                           (orchestrator — light edits)
  └── Table.svelte                         (REWRITTEN — virtualized)
        ├── lib/table_core.svelte.ts       (NEW — table-core ↔ runes wrapper)
        ├── lib/window_loader.svelte.ts    (NEW — Mosaic window cache)
        └── lib/use_column_widths.svelte.ts (NEW — width state + persistence)
  └── Cards.svelte                         (light edits — D5: cap at 1000 rows)
```

`Instances.svelte` edits:

- The current `query`/`queryResult` builds a fixed page. The rebuild
  replaces this with a `windowed_loader` that takes `(offset, limit)` as
  reactive inputs from Table and runs the query through `makeClient`.
  Conceptually, `data: Data` becomes `loader: WindowLoader` exposing
  `loader.rowAt(index): Row | "loading"` and `loader.totalCount`.
- `offsetForId` stays — used by Table's `animateToPoint`.
- `defaultColumnWidths` computation stays.
- The "Next Page" button goes away.
- `PaginatorControls` go away (or are repurposed to show
  `range.start..range.end / totalCount`).

`Table.svelte` rewrite (sketch):

```ts
const tableCore = createTableCore({
  data: () => loader.rowsInWindow,         // reactive — only window rows
  columns,
  state: {
    sorting: () => sortStateFromSpec(sort),
    columnSizing: () => columnWidths,
    columnVisibility: () => visibility,    // v2
  },
  manualSorting: true,
  manualFiltering: true,
  manualPagination: true,
  enableColumnResizing: true,
  columnResizeMode: "onChange",
  onSortingChange: handleSort,
  onColumnSizingChange: handleResize,
});

const virtualizer = createVirtualizer({
  count: () => loader.totalCount,
  getScrollElement: () => scrollEl,
  estimateSize: () => 32,                  // tightened from today's 44
  measureElement: (el) => el.getBoundingClientRect().height,
  overscan: 10,
});

$effect(() => {
  const range = virtualizer.range;
  loader.ensureRange(range.start, range.end);
});
```

Note: `createTableCore` and `createVirtualizer` here are the runes-flavor
helpers we write — both wrap the framework-agnostic core libs.

## Detail drawer replaces in-place expand (D3)

Per D3, the "click ↘ to expand a clipped cell" feature is removed in
favor of a detail drawer:

1. Uniform row height (~32px). Cell text is clamped to one line with
   ellipsis (instead of today's 3-line clamp). Hover reveals tooltip
   with full content if clamped.
2. Double-click on a row opens a right-side drawer showing all fields
   for that row. Drawer body reuses `TooltipContent` (already used by
   Cards) with the same `columnStyles` and column ordering.
3. Single-click and modifier-click semantics unchanged from today
   (highlight management).
4. Drawer state lives in `Instances.svelte` (`detailRowId: $state`),
   not in Table — so the drawer survives table refetches.
5. Drawer close: ESC, click outside, or close button.

Why this is better than today's expand:

- All fields visible at once instead of one expanded cell.
- Long content rendered with full markdown / images / audio support
  (today's expand is just `whitespace: normal`).
- Virtualizer stays uniform-height fast path.
- Removes `expandedRows`, `hoveredCell`, the per-cell hover state, and
  the conditional `line-clamp-3`.

Net code reduction in Table.svelte from this change alone: ~30 lines.

## Migration risks (and how to detect them early)

### Risk: cell remount thrash on scroll

`ContentRenderer` per cell × ~30 columns × ~50 visible rows = 1500
component instances. If virtualizer recycles DOM nodes but Svelte
remounts ContentRenderer because `{#each}` keys aren't stable, that's bad.

**Detect early:** after step 3 below, profile a 10K-row table during
flick-scroll. If frame budget is blown, fix by keying `{#each}` on
`row.__id__` and having ContentRenderer be cheap to mount (it should be —
it's a small switch on `style.type`).

### Risk: query thrash from scroll-driven offset changes

Without throttling, fast scroll fires N queries, queries land out of
order, the user sees rows from window N+1 then briefly N (race).

**Detect early:** instrument `loader.ensureRange` to log query
fire/result times. Flick-scroll a long table; expect ≤ 3 queries fired
during a single fling. Mosaic has a request-id cancellation mechanism
(`requestQuery` returns a token); use it to drop superseded results.

### Risk: `columnSizing` state model conflicts with `defaultColumnWidths`

TanStack tracks one `columnSizing: Record<colId, number>` map. We have
two layers today (defaults from sample, overrides from drag).

**Resolution:** TanStack initialState seeds `columnSizing` from
`defaultColumnWidths`. Drag-resize updates `columnSizing` directly. On
columns change, recompute `defaultColumnWidths` and re-seed only the
unmodified columns. (User-resized columns sticky-survive a column
reshuffle.)

### Risk: variable-height + sticky-header z-index ordering

Sticky `<thead>` over absolutely-measured rows can produce z-fighting
during scroll (header momentarily under a row). The padding-row pattern
from the archive (rather than absolute positioning) avoids this entirely.

**Resolution:** use padding-row pattern, not absolute. Confirmed
compatible with `measureElement`.

### Risk: `getElementForId` race after scrollToIndex

After `virtualizer.scrollToIndex`, the row may not yet be in the DOM
(virtualizer schedules its render). Calling `getElementForId(id)`
immediately returns undefined.

**Resolution:** make `getElementForId` `async` — return a Promise that
resolves once `idMapper.has(id)`. Update `Instances.animateToPoint` to
await. Internal contract change, no external consumer impact.

### Risk: TanStack-table-core's reactive inputs don't memo well in Svelte 5

`table-core` expects React-style stable references between renders. In
runes mode, `$derived` returns new objects unless we're careful.

**Resolution:** the runes wrapper builds the table options once with
`new Table(options)` and pushes state changes via `setState`/`setOptions`
imperatively, not via re-construction. This is exactly how the React
adapter works; we copy that shape.

## Build sequence

After this plan is reviewed and signed off:

0. **Branch off main** (chat-mcp-bridge already merged): `feat/table-virtualized`.
1. **Spike: table-core ↔ runes wrapper.** ~80 lines. Build a smoke
   component that renders a static array with sorting + resizing using
   the wrapper. No virtualization yet, no Mosaic. Confirm the runes
   integration shape is right.
2. **Spike: window loader.** Standalone class, taking a Mosaic
   coordinator + base query + sort + filter, exposing
   `ensureRange(start, end)`, `rowAt(idx)`, `totalCount`. Test against the
   existing dev-server dataset (~2K rows) just to check semantics.
3. **Integrate: virtualized Table.svelte.** Rebuild Table to use both
   spikes. Wire into Instances. Keep a debug overlay during dev showing
   `range / window / totalCount`. Behind no flag — replacement is direct.
4. **Preserve animateToPoint.** Verify embedding-click → table-row reveal
   works end-to-end across window boundaries.
5. **Profile flick-scroll** at 10K, 100K, 1M rows (synthetic dataset is
   fine for profiling). Tune `WINDOW_SIZE`, `OVERSCAN`, throttle.
6. **Persist column widths to localStorage.** Keyed on table name +
   column-set hash so widths survive reload but reset when schema
   changes. (NEW behavior — improvement over today.)
7. **Variable-row-height + expand-rekey.** Migrate `expandedRows` to
   keyed by `RowID`, integrate `measureElement`.
8. **Manual verification matrix** (see below).
9. **Document.** Update this file with as-built notes; create v2 plan
   doc for column visibility + pinning.

Estimated size: 3-5 days of focused work for v1.

## Manual verification matrix

Run after step 8. The matrix is the user-facing acceptance test.

| Scenario | Expected | Today's behavior |
|---|---|---|
| Open table tab, scroll to row 8000 of 10K | smooth, no perceptual lag | clicks "Next page" 80× |
| Click point in embedding | table jumps to that row, animates into view | works today (across pages); should still work (across windows) |
| Brush-select in another chart while table is at row 5000 | table scrolls to top, refetches | matches today's reset-on-filter |
| Sort by a column | table scrolls to top, ORDER BY rebuilt | matches today |
| Custom `spec.query` mode | renders, paginates by virtualizer, no embedding-click reveal | matches today (reveal disabled) |
| Switch to Cards view, switch back | table view rehydrates at offset 0 | matches today |
| Drag column resize | width persists across tab-switch | NEW: persists across reload too |
| Click ↘ on a long cell | row expands, virtualizer reflows, neighboring rows still aligned | matches today (no virtualizer reflow before) |
| Shift-click rows | multi-highlight, embedding repaints | matches today |
| Wide schema (50+ columns) | horizontal scroll works, sticky header stays put | works today, must continue |

## Out of scope (deferrals captured for the record)

- Cards view 2D virtualization via lanes API (v2; v1 caps at 1000 rows per D5).
- Column visibility menu (v2).
- Column pinning (v2).
- Column reorder (v3).
- Row-checkbox selection that drives `context.filter` (separate workstream).
- Per-column header filter dropdowns (we have crossfilter; redundant).
- Inline editing.
- TanStack v9 migration when it stabilizes.

## Decisions confirmed (2026-05-04 review)

After a deeper audit of the integration surface and a question pass with
the user, these design points are locked:

### D1 — Pagination is dropped entirely

No "page X of Y" UI, no Next-Page button. Replacement is flick-scroll +
embedding-click row reveal. Keep `state.offset` semantically as "initial
scroll-to row index on mount" so user position survives reload.

The audit found no external consumers depending on the paginator
behavior. PaginatorControls and the load-next button are removed from
`Instances.svelte`.

### D2 — `spec.pageSize` accepted as window-size hint, autocompute default

Backwards-compatible: if `spec.pageSize` is supplied (no callers found in
the codebase, but it's part of the documented spec), use it as the
sliding-window size. If absent, autocompute = `clamp(viewportRows * 4,
200, 800)` — gives a sensibly tuned window for typical screens without
the user having to know.

This makes `pageSize` a perf hint, not a UX setting. The semantic shift
is silent because no current consumer sets it.

### D3 — In-place cell expand is replaced by click-to-open detail drawer

Variable-row-height is dropped. The virtualizer uses uniform row height,
which gets us a faster O(1) index→position path and removes
`measureElement` complexity entirely.

Interaction:

- Plain click on row → single-select highlight (unchanged from today).
- Shift/ctrl/meta click → multi-select toggle (unchanged from today).
- Double-click on row → open detail drawer.
- Optional: chevron affordance revealed on row hover for discoverability.

Detail drawer reuses `TooltipContent` (already used by Cards), shown in a
right-side panel or modal. All row fields visible, not just the clipped
column.

### D4 — Column-width localStorage: keyed by table-name with cleanup-on-read

Key = `widths:${tableName}` → `Record<colName, number>`.

On read, intersect stored map with current column set, drop missing-column
entries, write the pruned map back. Result: widths persist for unchanged
columns across schema changes; stale entries don't accumulate.

Rejected alternatives: hashing the column-set into the key (forces
*all* widths to reset on any schema change); name-only with no cleanup
(stale entries accumulate forever in localStorage).

### D5 — Cards view is capped at 1000 rows, no virtualization

Cards is a registered chart builder (`chart_types.ts:415-440`), so we
can't drop it. But the audit confirmed nobody scrolls 100K cards looking
for something — Cards is for rich per-record presentation of small N.

For v1: when in Cards mode, call `loader.ensureRange(0, 1000)` once and
render the result directly. If `totalCount > 1000`, show a small notice:
"showing first 1000 of N — refine your filter to see more." All existing
Cards features (auto-fill responsive grid, Liquid templates, hover/click
effects) are preserved unchanged.

If user feedback later requests scaled-up Cards, v2 brings 2D
virtualization via `@tanstack/svelte-virtual`'s `lanes` API — but that's
a real piece of work and defers cleanly.

## Comprehensive integration audit (post-plan-review)

These contracts were verified in the audit. Anything not listed here is
internal to the Table component and free to change.

### Public via `InstancesSpec`

- `viewMode: "table" | "cards"` — segmented-control toggle, also set by
  the two `chart_types.ts` builders. Both modes must continue to work.
- `query?: string` — custom-SQL mode with `$table` and `$filter`
  template substitution. Used by both table and cards builders. Must
  continue to work; embedding-click reveal stays disabled in this mode.
- `columns?: string[]` — column allowlist applied during `prepare`.
- `sort?: SortOrder` — multi-column sort, persisted in spec, executed
  via SQL `ORDER BY`. New: TanStack tracks the state, Mosaic does the
  ordering.
- `pageSize?: number` — see D2.
- `cardTemplate?: string` — Liquid template for cards. Cards-only.
- `columnStyles?: Record<string, ColumnStyle>` — per-column display
  config including `display: "hidden"` filter. Honored in `prepare`.
- `defaultHeight?: number` — for flexible-height containers.

### Public via `InstancesState`

- `offset?: number` — see D1. Repurposed as initial scroll-to index.

### Public via `ChartContext`

- `coordinator`, `table`, `id`, `columns`, `filter`, `colorScheme`,
  `theme`, `columnStyles`, `cache`, `persistentCache` — all read.
- `highlight: Writable<RowID[] | null>` — bidirectional. Click writes,
  external changes (from embedding click) drive `animateToPoint`.
- `searchResult` — declared in the type but **not used** by Instances
  today. No need to wire it.

### Internal (Table.svelte ↔ Instances.svelte)

- `getElementForId(id)` — only Instances calls it. Free to change
  signature (e.g. make async to handle virtualizer scrollToIndex →
  render race).
- `data: { data, columns, offset, offsetForId? }` — the prop shape.
  Will be replaced by a `loader: WindowLoader` reactive object exposing
  `loader.rowAt(index)`, `loader.totalCount`, `loader.ensureRange()`,
  `loader.offsetForId?(id)`. Only Instances reads these; signature is
  internal.
- `defaultColumnWidths` — still computed in Instances `prepare`. Becomes
  the seed for TanStack `columnSizing` initial state.

### Layout-side wiring (must not break)

- `layouts/dashboard/placement.ts:65` checks `type == "instances"` for
  table-section placement. Auto-handled by spec type.
- `layouts/list/ListLayout.svelte:13` (`findSection`) routes "instances"
  charts to the table section. Auto-handled.
- `layouts/list/ListLayout.svelte:154-178` renders the table section
  with chat-tab integration. The `chartView` macro is what mounts
  Instances — no changes needed here.

### Builder-side wiring (must not break)

- `chart_types.ts:405-413` — table builder, sets `viewMode: "table"`.
- `chart_types.ts:431-440` — cards builder, sets `viewMode: "cards"`,
  optional `cardTemplate`. Must continue to round-trip cleanly.

### Confirmed-not-applicable

- No `registerDelegate` usage in Instances → no screenshot delegate to
  add or preserve. (Embedding registers one; Instances does not.)
- No `context.searchResult` subscription in Instances → search-driven
  reveal flows through `context.highlight`, not searchResult.
- No external callers of `Table.svelte`'s exports beyond `Instances.svelte`.

> **Note:** the "no `registerDelegate` usage in Instances" assumption
> from the original plan no longer holds — Instances now registers a
> "Table" settings snippet via `registerDelegate` so its column
> controls / Export CSV land in the page-level `SettingsDrawer`. See
> the As-built section above. (Same with Embedding registering an
> "Embed" tab.)

## Still open / deferred

Things touched-on or mentioned in the work above but not finished.

### Layout reorganization (in design)

We started talking through moving the search bar below the embedding,
the top-toolbar buttons to a vertical left-edge icon strip, and the
settings drawer from a right-edge overlay to a left-side inline panel
(mirroring the existing right-side charts panel pattern). Open
decisions: search-bar placement (own row vs. overlay vs. inside the
existing bottom-status pill), settings panel as inline-with-resizer
vs. overlay, and where the List/Dashboard layout selector lands
(vertical icon buttons in strip vs. moved into Global tab vs. kept
in a thin top strip). The search-bar UX is informed by the fact
that today the search is purely an embedding-visualization tool —
matching IDs are highlighted in the embedding canvas, not filtered
into the table — so its physical placement should signal that scope.

### Drawer chrome polish

- **Tab labels overflow at small widths.** Solved for "Table"
  (short) and "Embed" (shortened from "Embedding"); future chart
  types will need to pick short labels or we'll need a different
  tab pattern (icon-only with tooltip?).
- **Tab strip styling** is hand-rolled Tailwind (slate palette,
  blue accents). When the design-system port lands, the drawer
  needs a re-skin against whatever tokens that brings.
- **Layout selector + theme toggle** still live on the top
  toolbar; if the layout reorg ships, they move.
- **Multi-instance disambiguation.** Today any chart registering
  `settingsTitle: "Table"` (or any duplicate title) will collide
  in the tab strip. Fine for one-table-per-atlas; needs revisit
  when dashboards routinely host >1 of the same chart type.

### Per-column header filters — numeric / date

Currently categorical-only (`jsType === "string"` /
`"string[]"`). Numeric and date columns get a "filter not
available" placeholder that points at the predicates panel.
A range slider / histogram brush in the popover would close
the gap.

### Row-checkbox-as-filter

Mentioned in the original plan as out of scope, never picked
up. Open question: row selection drives the cross-filter via a
union (selected rows OR existing predicates) or intersect
(narrow further). Each option has a different UX and
different ergonomics for "I want to drill into N rows I see."

### Cards 2D virtualization is dormant

`Cards.svelte` was rebuilt with the `lanes` API but the toggle
that exposed Cards as a peer of Table was removed. The file is
intact and could be reused as a record-list surface elsewhere
(e.g., a search-flyout-like context, or as the body of the
neighbors view). No active caller today.

### Documentation drift

`packages/docs/overview.md` and any user-facing docs predate
the table virtualization, the settings drawer, and the perf
work. Out of scope for this PR but worth a sweep before
the next release.

### Heatmap rect-band×band runtime bug (#64)

Pre-existing, unrelated to the table work, but flagged in
parallel. Captured in tasks.

### Area / cumulative-over-time inline charts (#65)

Same story — pre-existing inline-chart polish item, not table.
