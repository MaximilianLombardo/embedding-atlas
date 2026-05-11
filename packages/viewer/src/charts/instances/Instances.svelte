<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Orchestrator for the table / cards view.

  Owns:
  - WindowLoader (lib/window_loader.svelte.ts) — single source of truth
    for total count, currently-loaded window, columns, and offsetForId.
    Replaces the two ad-hoc Mosaic clients the pre-rebuild orchestrator
    held inline.
  - View-mode toggle (table | cards).
  - SortOrderControl (drives spec.sort).
  - Highlight isolation (writes to context.highlight without bouncing
    back through external highlight subscribers — preserves the legacy
    contract).
  - animateToPoint(id) — embedding-click → table-row reveal. With
    virtualization this is offsetForId → scrollToIndex → wait for the
    row to render → scrollIntoView, since virtualizer.scrollToIndex is
    coarse-grained (centers on the index but doesn't guarantee the row
    is in DOM yet).
  - Detail-drawer state (detailRowId) — D3, populated on row double-click.

  Per D1, pagination is dropped: no PaginatorControls, no Next-Page
  button. spec.state.offset is repurposed as initial scroll-to row index
  on mount so user position survives reload.
-->
<script lang="ts">
  import { deepMemo } from "@embedding-atlas/utils";
  import { untrack } from "svelte";

  import ActionButton from "../../widgets/ActionButton.svelte";
  import SegmentedControl from "../../widgets/SegmentedControl.svelte";
  import Cards from "./Cards.svelte";
  import ColumnControls from "./ColumnControls.svelte";
  import DetailDrawer from "./DetailDrawer.svelte";
  import SortOrderControl from "./SortOrderControl.svelte";
  import Table from "./Table.svelte";

  import { IconCardView, IconDownload, IconTableSettings, IconTableView } from "../../assets/icons.js";
  import { predicateToString } from "../../utils/database.js";
  import { downloadBuffer } from "../../utils/download.js";
  import { exportMosaicSelection } from "../../utils/mosaic_exporter.js";
  import { isolatedWritable } from "../../utils/store.js";
  import type { ChartViewProps, RowID } from "../chart.js";
  import {
    loadStoredColumnState,
    saveStoredColumnState,
    type StoredColumnState,
  } from "./lib/use_column_state.svelte.js";
  import { WindowLoader } from "./lib/window_loader.svelte.js";
  import type { InstancesSpec, InstancesState } from "./types.js";

  let {
    context,
    spec,
    state: chartState,
    height,
    onSpecChange,
    onStateChange,
    registerDelegate,
  }: ChartViewProps<InstancesSpec, InstancesState> = $props();

  // svelte-ignore state_referenced_locally
  let { columnStyles: contextColumnStyles } = context;

  // Merge spec columnStyles with global ones (spec takes precedence)
  let columnStyles = $derived({ ...$contextColumnStyles, ...spec.columnStyles });

  // svelte-ignore state_referenced_locally
  let highlight = context.highlight;
  let isolatedHighlight = isolatedWritable(highlight);

  let viewMode = $derived((spec.viewMode ?? "table") as "table" | "cards");

  // pageSize is repurposed (D2) as a sliding-window size hint. If unset,
  // we autocompute from the typical viewport later when the loader
  // initializes; the constant here is a stable default for spec
  // round-tripping.
  let windowSize = $derived(spec.pageSize ?? 400);

  let contentView = $state.raw<Table | Cards | undefined>(undefined);

  // Default column widths: seeded by WindowLoader during prepare from a
  // 10-row sample. Local state keyed by column name; passed to Table to
  // seed table-core's columnSizing initial state.
  let defaultColumnWidths = $state.raw<Record<string, number>>({});

  // Detail-drawer state for D3. Populated on row double-click; surfaces
  // a side panel with all fields. Lives here so the drawer survives
  // table refetches. We hold the row record itself rather than just an
  // id — the table already had it on hand at click time, so re-fetching
  // would be wasted work.
  let detailRow = $state.raw<Record<string, any> | null>(null);

  // Combined column state (visibility / order / pinning). Owned here
  // so ColumnControls can write directly while Table reflects it into
  // table-core's controlled state. Initialized on the first time the
  // loader's column list arrives — see the $effect below.
  let columnState = $state<StoredColumnState>({ visibility: {}, order: [], pinning: { left: [] } });
  let columnStateSeeded = false;
  let columnStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Highlight subscription: legacy animateToPoint contract. When a
  // single new id enters the highlight set externally (e.g. an embedding
  // click), reveal it in the table.
  $effect.pre(() => {
    let isOnMount = true;
    let previousValue: RowID[] | null = null;
    return isolatedHighlight.subscribe((v) => {
      if (isOnMount) {
        isOnMount = false;
        previousValue = v;
        return;
      }
      const newIDs = v ?? [];
      const oldIDs = previousValue ?? [];
      const enteringIDs = newIDs.filter((x) => oldIDs.indexOf(x) < 0);
      if (enteringIDs.length === 1) {
        animateToPoint(enteringIDs[0]);
      }
      previousValue = v;
    });
  });

  // Loader lifecycle: rebuild on params change, destroy on cleanup.
  // deepMemo keeps the params object identity-stable across spec
  // patches that don't materially change the loader's inputs.
  let loaderParams = $derived.by(
    deepMemo(() => ({
      query: spec.query,
      columns: spec.columns,
      columnStyles,
      sort: spec.sort,
      windowSize,
    })),
  );

  let loader = $state.raw<WindowLoader | undefined>(undefined);

  // Declared before the $effect.pre that references it. Svelte 5 fires
  // $effect.pre eagerly during setup, and `let` bindings are in the
  // temporal dead zone until their declaration line runs — putting this
  // after the effect causes a "Cannot access before initialization"
  // ReferenceError on the first run.
  let didInitialScroll = false;

  $effect.pre(() => {
    const p = loaderParams;
    const newLoader = new WindowLoader({
      coordinator: context.coordinator,
      filter: context.filter,
      table: context.table,
      idColumn: context.id,
      query: p.query,
      columns: p.columns,
      columnStyles: p.columnStyles,
      sort: p.sort,
      windowSize: p.windowSize,
      onPrepared: ({ defaultColumnWidths: widths }) => {
        defaultColumnWidths = widths;
      },
      onTotalCountChange: () => {
        // Filter or schema change shifted the universe — back to top.
        // The Table component reads loader.windowOffset and the
        // virtualizer will scroll to the new beginning naturally.
        untrack(() => {
          newLoader.resetToTop();
          (contentView as any)?.scrollToIndex?.(0, "start");
        });
      },
    });
    loader = newLoader;
    // Params change (sort, columns, query, columnStyles, windowSize)
    // resets the user to top: the underlying universe of rows has been
    // re-sorted or re-filtered, so their old anchor is no longer
    // meaningful. Mirrors the pre-rebuild behavior.
    queueMicrotask(() => {
      (contentView as any)?.scrollToIndex?.(0, "start");
    });
    didInitialScroll = false; // re-allow chartState.offset on next mount
    return () => {
      newLoader.destroy();
    };
  });

  // Filter changes (cross-filter from another chart) reset to top too.
  // Even when totalCount stays the same, the rows displayed may not be
  // the same set — the user's row-5000 anchor is no longer the same
  // record. Matches the matrix's "brush-select another chart → resets
  // to top" expectation.
  $effect.pre(() => {
    const onFilterChange = () => {
      untrack(() => {
        loader?.resetToTop();
        (contentView as any)?.scrollToIndex?.(0, "start");
      });
    };
    context.filter.addEventListener("value", onFilterChange);
    return () => {
      context.filter.removeEventListener("value", onFilterChange);
    };
  });

  // Initial offset from chartState.offset (D1: persists scroll-to-on-mount).
  // Fires exactly once, when the loader has settled to a non-empty
  // totalCount and the Table has mounted (so contentView is bound).
  // Reading chartState.offset is intentionally NOT reactive past mount —
  // we don't want every offset patch to re-jump the user.
  $effect(() => {
    if (didInitialScroll) return;
    if (!loader || loader.totalCount === 0) return;
    if (!contentView) return;
    const idx = untrack(() => chartState.offset ?? 0);
    if (idx > 0) {
      (contentView as any).scrollToIndex?.(Math.min(idx, loader.totalCount - 1), "start");
    }
    didInitialScroll = true;
  });

  // Animate to a point. With virtualization the legacy "scroll if same
  // page, otherwise jump to that page" branch collapses to a single
  // path: ask the loader for the absolute index, scroll the
  // virtualizer there, then wait for the row to render before final
  // scrollIntoView.
  async function animateToPoint(id: RowID) {
    if (spec.query != null) return; // Custom-query mode: no reveal.
    if (!loader) return;
    const offset = await loader.offsetForId(id);
    if (offset == null) return;
    // ROW_NUMBER is 1-based; scrollToIndex is 0-based.
    const targetIndex = Math.max(0, offset - 1);
    (contentView as any)?.scrollToIndex?.(targetIndex, "center");
    // Wait for the row to land in the DOM, then scroll it into precise view.
    const el = await (contentView as any)?.getElementForId?.(id);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Persist the user's anchor so reloads land back here.
    onStateChange({ offset: targetIndex });
  }

  function handleRowClick(rowId: RowID | null | undefined, event: MouseEvent) {
    if (rowId == null) return;
    isolatedHighlight.update((value) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (value == null) return [rowId];
        if (value.indexOf(rowId) >= 0) return value.filter((x) => x !== rowId);
        return [...value, rowId];
      }
      if (value != null && value.length === 1 && value.indexOf(rowId) >= 0) return null;
      return [rowId];
    });
  }

  function handleRowDoubleClick(row: Record<string, any>) {
    if (row == null) return;
    detailRow = row;
  }

  // Seed columnState from localStorage once we know the column list.
  // Subsequent loader rebuilds (sort change, filter change) reuse the
  // already-seeded state so user toggles don't reset.
  $effect(() => {
    const cols = loader?.columns ?? [];
    if (columnStateSeeded || cols.length === 0) return;
    columnState = loadStoredColumnState(context.table, cols);
    columnStateSeeded = true;
  });

  // Persist columnState whenever it changes. Debounced because a flurry
  // of toggles (e.g. "uncheck 5 columns") would otherwise cause one
  // localStorage write per click. Important: read `columnState` BEFORE
  // any early-return so Svelte tracks it as a dep on the very first
  // run of this effect — otherwise the seeded guard would short the
  // body and the dep would never register.
  $effect(() => {
    const snapshot = columnState;
    if (!columnStateSeeded) return;
    if (columnStateSaveTimer != null) clearTimeout(columnStateSaveTimer);
    columnStateSaveTimer = setTimeout(() => {
      saveStoredColumnState(context.table, snapshot);
      columnStateSaveTimer = null;
    }, 100);
  });

  function handleToggleVisibility(column: string) {
    const next = { ...columnState.visibility };
    if (next[column] === false) delete next[column];
    else next[column] = false;
    columnState = { ...columnState, visibility: next };
  }

  function handleReorder(newOrder: string[]) {
    columnState = { ...columnState, order: newOrder };
  }

  function handleTogglePinLeft(column: string) {
    const left = columnState.pinning.left;
    const next = left.includes(column) ? left.filter((c) => c !== column) : [...left, column];
    columnState = { ...columnState, pinning: { left: next } };
  }

  // Per-column header filter state. Each column gets a stable source
  // object (Mosaic Selection identifies clauses by source identity)
  // held in this Map; reused on every popover open/close so the
  // clause survives popover lifecycle. columnFilters is the active
  // selection per column — empty array means no filter.
  const filterSources = new Map<string, object>();
  function sourceFor(column: string): object {
    let s = filterSources.get(column);
    if (!s) {
      s = { __columnFilter: column };
      filterSources.set(column, s);
    }
    return s;
  }
  let columnFilters = $state<Record<string, string[]>>({});
  function handleColumnFilterChange(column: string, values: string[]) {
    columnFilters = { ...columnFilters, [column]: values };
  }

  // Compute the rendered column order for the menu: stored order
  // first (for any columns still in the schema), then any
  // schema-but-not-stored columns appended. This gives the menu and
  // the table a single source of truth for "where does each column
  // appear right now."
  let orderedColumns = $derived.by(() => {
    const cols = loader?.columns;
    if (!cols) return [];
    const orderSet = new Set(columnState.order);
    const fromOrder = columnState.order.filter((c) => cols.includes(c));
    const remaining = cols.filter((c) => !orderSet.has(c));
    return [...fromOrder, ...remaining];
  });

  // CSV export — currently-filtered rows only. Reuses the same
  // exporter as the EmbeddingAtlas-level "Export selection" feature
  // (see app/FileViewer.svelte:159). Predicate string comes from
  // context.filter.predicate(null), which composes every active
  // selection clause across all charts. Custom-spec.query mode
  // (where predicate semantics differ) skips this — we hide the
  // menu item below.
  async function handleExportCsv() {
    const predicate = predicateToString(context.filter.predicate(null) as any);
    const [bytes, name] = await exportMosaicSelection(context.coordinator, context.table, predicate, "csv");
    downloadBuffer(bytes, name);
  }

  // Register a "Table" tab in the page-level settings modal. The
  // snippet below captures `orderedColumns`, `columnState`, and the
  // handlers via closure and stays in sync as the user adjusts
  // controls. `untrack` insulates the registration from
  // prop-identity churn (LayoutView's chartView snippet creates a
  // fresh `registerDelegate` arrow each frame during layout
  // transitions; tracking it would thrash the registration).
  $effect(() => {
    return untrack(() => {
      if (!registerDelegate) return;
      return registerDelegate({
        settingsTitle: "Table",
        settingsIcon: IconTableSettings,
        settingsContent: tableSettings,
      });
    });
  });
</script>

<div
  class="w-full flex flex-col overflow-hidden rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
  style:height={`${height ?? spec.defaultHeight ?? 500}px`}
>
  <div class="flex items-center justify-between px-2 py-0.5 border-b border-slate-200 dark:border-slate-700 gap-4">
    <div class="flex items-center gap-4 flex-shrink-0">
      <SegmentedControl
        value={viewMode}
        onChange={(v) => onSpecChange({ viewMode: v as "table" | "cards" })}
        options={[
          { value: "table", icon: IconTableView, title: "Table view" },
          { value: "cards", icon: IconCardView, title: "Card view" },
        ]}
      />
      <!-- Column controls (visibility / order / pinning) + CSV export
           are registered as the "Table" tab of the settings modal via
           `registerDelegate` below. The dedicated inline popup-button
           that used to live here was removed when the modal became
           the single home for chart-scoped configuration. -->
      <SortOrderControl value={spec.sort} onChange={(value) => onSpecChange({ sort: value })} />
    </div>
    {#if loader}
      <div class="text-xs text-slate-400 dark:text-slate-500">
        {loader.totalCount.toLocaleString()} rows
      </div>
    {/if}
  </div>

  <div class="flex-1 min-h-0 overflow-hidden">
    {#if loader && loader.columns.length > 0}
      {#if viewMode === "table"}
        <Table
          bind:this={contentView}
          loader={loader}
          columnDescs={context.columns}
          columnStyles={columnStyles}
          defaultColumnWidths={defaultColumnWidths}
          highlight={$highlight}
          sort={spec.sort}
          tableName={context.table}
          bind:columnState={columnState}
          filterContext={spec.query == null ? {
            coordinator: context.coordinator,
            table: context.table,
            filter: context.filter,
            columnFilters,
            sourceFor,
            onChange: handleColumnFilterChange,
          } : undefined}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          onSortChange={(value) => onSpecChange({ sort: value })}
        />
      {:else}
        <Cards
          bind:this={contentView}
          loader={loader}
          columnStyles={columnStyles}
          highlight={$highlight}
          cardTemplate={spec.cardTemplate}
          onRowClick={handleRowClick}
        />
      {/if}
    {:else}
      <div class="flex items-center justify-center h-full">
        <div class="text-slate-500 dark:text-slate-400">Loading...</div>
      </div>
    {/if}
  </div>

  <DetailDrawer
    row={detailRow}
    columns={loader?.columns ?? []}
    columnStyles={columnStyles}
    onClose={() => (detailRow = null)}
  />
</div>

{#snippet tableSettings()}
  {#if loader && loader.columns.length > 0}
    <div class="flex flex-col gap-4">
      <ColumnControls
        columns={orderedColumns}
        visibility={columnState.visibility}
        pinnedLeft={columnState.pinning.left}
        onToggleVisibility={handleToggleVisibility}
        onReorder={handleReorder}
        onTogglePinLeft={handleTogglePinLeft}
      />
      {#if spec.query == null}
        <div>
          <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">
            EXPORT
          </div>
          <ActionButton
            icon={IconDownload}
            label="Export CSV"
            title="Export rows matching the current filter as CSV"
            class="w-48"
            onClick={handleExportCsv}
          />
        </div>
      {/if}
    </div>
  {/if}
{/snippet}
