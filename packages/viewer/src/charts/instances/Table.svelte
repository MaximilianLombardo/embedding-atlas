<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Virtualized table.

  Built on three pieces working in tandem:

  1. WindowLoader (lib/window_loader.svelte.ts) — owns a sliding 400-row
     window over Mosaic. Reads expose a virtual-length view (totalCount)
     plus rowAt(idx) which returns either an in-memory row or the
     sentinel "loading" for indices outside the loaded window.

  2. createSvelteTable (lib/table_core.svelte.ts) — table-core wrapped in
     Svelte 5 runes. Owns header rendering, multi-column sort state,
     column-resize state. We do NOT use its row models — Mosaic does the
     row work in SQL. manualSorting/manualFiltering/manualPagination
     turns those off.

  3. @tanstack/svelte-virtual — virtualizes against virtual length
     (loader.totalCount). On every range change the virtualizer's store
     re-emits; we mirror that into a $state and tell the loader the new
     visible range so it can slide the window.

  Padding-row pattern (rather than absolute positioning) keeps a sticky
  thead unambiguously above the rows during scroll — see the design doc
  risk note. Top/bottom spacer rows render with the appropriate height;
  visible rows render between them in document order.
-->
<script lang="ts">
  import type { ColumnDef, SortingState } from "@tanstack/table-core";
  import { createVirtualizer, type SvelteVirtualizer } from "@tanstack/svelte-virtual";
  import { untrack } from "svelte";

  import ContentRenderer from "../../renderers/ContentRenderer.svelte";

  import { IconSortDown, IconSortUp, IconSortUpDown } from "../../assets/icons.js";

  import type { ColumnStyle } from "../../renderers/types.js";
  import type { ColumnDesc } from "../../utils/database.js";
  import type { RowID } from "../chart.js";
  import { inferColumnFormatters } from "./infer_formatters.js";
  import { createSvelteTable } from "./lib/table_core.svelte.js";
  import { type StoredColumnState } from "./lib/use_column_state.svelte.js";
  import { loadStoredWidths, saveStoredWidths } from "./lib/use_column_widths.svelte.js";
  import { WindowLoader } from "./lib/window_loader.svelte.js";
  import type { SortOrder } from "./types.js";

  interface Props {
    loader: WindowLoader;
    columnDescs: ColumnDesc[];
    columnStyles: Record<string, ColumnStyle>;
    defaultColumnWidths: Record<string, number>;
    highlight: RowID[] | null;
    sort?: SortOrder;
    /**
     * Identifier for the table-being-shown. Used as the key for
     * localStorage-persisted column widths (D4). Pass the dataset
     * table name (e.g. `context.table`) so widths survive reloads
     * but reset cleanly across distinct datasets.
     */
    tableName: string;
    /**
     * Bidirectional column state (visibility / order / pinning).
     * Owner is the parent (`Instances.svelte`) — Table reflects it
     * into table-core's controlled state and writes user edits back
     * via the bind. localStorage persistence also lives in the parent.
     */
    columnState?: StoredColumnState;
    onRowClick: (rowId: RowID | null | undefined, event: MouseEvent) => void;
    /**
     * Fired on row double-click. Receives the full row record so the
     * detail drawer can render every field without refetching.
     */
    onRowDoubleClick: (row: Record<string, any>, event: MouseEvent) => void;
    onSortChange: (sort: SortOrder | undefined) => void;
  }

  let {
    loader,
    columnDescs,
    columnStyles,
    defaultColumnWidths,
    highlight,
    sort,
    tableName,
    columnState = $bindable({ visibility: {}, order: [], pinning: { left: [] } }),
    onRowClick,
    onRowDoubleClick,
    onSortChange,
  }: Props = $props();

  // Uniform row height. Tightening from the previous 44px makes the
  // virtualizer's index↔offset math O(1) and shows more rows per
  // viewport. Detail-drawer (D3) replaces in-place expand for long cells.
  const ROW_HEIGHT = 32;

  let highlightSet = $derived(new Set(highlight));
  let columnFormatters = $derived(inferColumnFormatters(loader.windowRows, loader.columns));

  // Column widths live in table-core's controlled `columnSizing` state
  // (seeded by defaultColumnWidths via `initialState` on the table
  // below). User drags fire onStateChange which the runes wrapper
  // mirrors into a $state rune; reads of `table.getState()` then
  // become reactive. Step 6 will layer localStorage persistence by
  // seeding from + writing to that same slice.
  let scrollEl = $state.raw<HTMLDivElement | undefined>(undefined);

  // Track which row id is rendered at which DOM element. Used by
  // animateToPoint via getElementForId. Map only tracks currently-rendered
  // rows (others are virtualized away), so getElementForId is async — it
  // waits up to a short budget for the row to render after a
  // scrollToIndex.
  const idMapper = new Map<RowID, Element>();

  // Render-time projection of the sort prop. Headers display sort
  // indicators based on this — table-core itself doesn't own sort state
  // here (we don't use sorted row models). Controlled-from-outside
  // semantics live in the prop, not in table-core's internal state.
  let sortingState = $derived<SortingState>(
    (sort ?? []).map((s) => ({ id: s.column, desc: s.direction === "descending" })),
  );

  // Right-aligned for numeric columns; matches the pre-rebuild rule.
  function getAlignment(column: string): string {
    const desc = columnDescs.find((c) => c.name === column);
    return desc?.jsType === "number" ? "text-right" : "text-left";
  }

  // Build a TanStack column def per logical column. accessorKey is
  // unused at render time (we read row[col] directly) but is required
  // for table-core to link headers to data.
  let tanstackColumns = $derived<ColumnDef<Record<string, any>>[]>(
    loader.columns.map((col) => ({
      id: col,
      header: col,
      accessorKey: col,
      enableResizing: true,
      enableSorting: true,
      enableHiding: true,
      size: defaultColumnWidths[col] ?? 150,
    })),
  );

  // Seed initial column sizing from defaults *and* localStorage
  // (cleanup-on-read prunes entries for columns that no longer exist
  // in this dataset). Defaults fill any column the user hasn't yet
  // resized; stored widths win where both are present.
  // svelte-ignore state_referenced_locally
  const initialColumnSizing: Record<string, number> = {
    ...defaultColumnWidths,
    ...loadStoredWidths(tableName, loader.columns),
  };

  const table = createSvelteTable<Record<string, any>>(() => ({
    data: loader.windowRows,
    columns: tanstackColumns,
    initialState: {
      columnSizing: initialColumnSizing,
    },
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  }));

  // Note: column visibility / order / pinning are driven by the
  // parent-owned `columnState` directly (see `visibleColumns` below).
  // table-core's matching state slices are unused — they require
  // controlled-state plumbing for reactivity that doesn't pay off
  // here, given we already have a clean Svelte 5 source of truth.

  // Live column width map. Kept as a $derived over table state so the
  // template can width-style cells reactively. Reads `table.getState()`
  // which the runes wrapper hooks into the state rune.
  let columnSizing = $derived<Record<string, number>>(table.getState().columnSizing ?? {});

  // Visible columns in render order. Driven directly off the
  // parent-owned `columnState` rather than going through table-core's
  // memoized `getVisibleLeafColumns` — the latter's reactivity through
  // our state override is best-effort, while reading `columnState`
  // here is unambiguously tracked by the $derived. Step C will layer
  // in `columnState.order` to reorder.
  let visibleColumns = $derived<string[]>(
    loader.columns.filter((c) => columnState.visibility[c] !== false),
  );

  // Persist widths to localStorage on change (D4). Debounced because
  // columnResizeMode "onChange" fires per drag-frame; localStorage
  // writes are cheap but writing 60×/sec is wasteful.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const sizing = columnSizing;
    if (Object.keys(sizing).length === 0) return;
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveStoredWidths(tableName, sizing);
      saveTimer = null;
    }, 200);
    return () => {
      if (saveTimer != null) {
        clearTimeout(saveTimer);
        // On unmount, flush whatever we had pending so a quick close
        // after a resize doesn't lose the last value.
        saveStoredWidths(tableName, sizing);
        saveTimer = null;
      }
    };
  });

  // Combined column state (visibility/order/pinning) persistence
  // happens in the parent (Instances.svelte). The $effect above keeps
  // `columnState` in sync with table-core, and the parent watches
  // that for write-through.

  // Virtualizer: wraps virtual-core in a Svelte store. Subscribe and
  // mirror into a $state so $effect/$derived can read it the runes way.
  // svelte-ignore state_referenced_locally
  const virtualizerStore = createVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: loader.totalCount,
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  // virtualizerStore emits the SAME Virtualizer instance on every range
  // change (the instance's internal state mutates in place). A
  // $state.raw rune compares by Object.is, so assigning the same
  // reference doesn't trigger reactivity. We use a tick counter
  // bumped on each emission to drive Svelte derivations off the
  // virtualizer's mutable state.
  let virtualizer: SvelteVirtualizer<HTMLDivElement, HTMLTableRowElement> | undefined;
  let virtualizerTick = $state(0);

  $effect(() => {
    return virtualizerStore.subscribe((v) => {
      // The subscriber may fire synchronously inside another effect's
      // body (e.g. when count-updating setOptions triggers store.set).
      // Without untrack, the read+write of `virtualizerTick` inside
      // that effect's tracking scope adds tick as a dep of the *outer*
      // effect, which then re-fires on every tick bump → infinite
      // update loop. untrack breaks the cross-dependency.
      untrack(() => {
        virtualizer = v;
        virtualizerTick++;
      });
    });
  });

  // Push count updates into the virtualizer when totalCount changes.
  // setOptions triggers an internal range recompute and re-emit on the
  // store, so virtualizerTick bumps via the subscribe path above.
  $effect(() => {
    const count = loader.totalCount;
    untrack(() => {
      virtualizer?.setOptions({ count });
    });
  });

  // Tell the loader the visible range — it slides the window if needed.
  // Wrap ensureRange in untrack so internal reads of loader state don't
  // become dependencies of *this* effect; only virtualizerTick should
  // re-fire it.
  $effect(() => {
    void virtualizerTick;
    untrack(() => {
      if (!virtualizer) return;
      const r = virtualizer.range;
      if (r) loader.ensureRange(r.startIndex, r.endIndex);
    });
  });

  // Visible items. Each carries {index, key, size, start, end, lane}.
  // The `void virtualizerTick` reads make these derivations track the
  // tick rune; without it, range changes (which mutate in place rather
  // than swapping the virtualizer instance) wouldn't re-fire the
  // derived.
  let virtualItems = $derived.by(() => {
    void virtualizerTick;
    return virtualizer?.getVirtualItems() ?? [];
  });
  let totalSize = $derived.by(() => {
    void virtualizerTick;
    return virtualizer?.getTotalSize() ?? 0;
  });
  // Padding-row spacers — keep the rendered rows in document order for
  // sticky-header z-ordering. Top spacer pushes the first visible row
  // down to its true Y; bottom spacer fills the remainder.
  let paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  let paddingBottom = $derived(
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0,
  );

  // Async row-element resolver. Used by animateToPoint after a scrollToIndex
  // — the row may not be in the DOM yet when called, since the virtualizer
  // schedules its render after the scroll commits. Resolve once the
  // idMapper sees the id, with a short polling budget.
  export async function getElementForId(id: RowID): Promise<Element | undefined> {
    if (idMapper.has(id)) return idMapper.get(id);
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (idMapper.has(id)) return resolve(idMapper.get(id));
        if (Date.now() - start > 1500) return resolve(undefined);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /** Imperative scroll target, used by animateToPoint and reset-on-sort. */
  export function scrollToIndex(index: number, align: "start" | "center" | "end" = "center"): void {
    // For index=0 we set scrollTop directly: when the loader is in
    // the middle of a rebuild (params change), totalCount may
    // momentarily be 0 and virtualizer.scrollToIndex would have
    // nothing to scroll to. The DOM scroll has no such constraint.
    if (index === 0 && align === "start") {
      if (scrollEl) scrollEl.scrollTop = 0;
      return;
    }
    virtualizer?.scrollToIndex(index, { align });
  }
</script>

<div class="w-full h-full overflow-auto" bind:this={scrollEl}>
  <table class="border-separate border-spacing-0 table-fixed w-full">
    <thead class="sticky top-0 z-10 bg-white dark:bg-black">
      <tr>
        {#each (table.getHeaderGroups()[0]?.headers ?? []).filter((h) => visibleColumns.includes(h.column.id)) as header (header.id)}
          {@const column = header.column.id}
          {@const sortDir = sortingState.find((s) => s.id === column)}
          {@const sortIsPrimary = sortingState[0]?.id === column}
          {@const width = columnSizing[column] ?? 150}
          <th
            class="px-4 py-1.5 font-normal text-slate-400 dark:text-slate-500 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap relative group {getAlignment(column)}"
            style:width="{width}px"
          >
            <div class="flex gap-2 items-center">
              <div class="flex-1 truncate">{column}</div>
              <button
                onclick={() => {
                  // Cycle: unsorted → ascending → descending → unsorted.
                  // We push directly through onSortChange (rather than
                  // table.toggleSorting) so multi-column sort semantics
                  // mirror the legacy behavior: a fresh click on a column
                  // promotes it to primary, leaving secondary sorts intact
                  // when the new direction is set.
                  const order = sortDir == undefined ? "ascending" : sortDir.desc ? undefined : "descending";
                  let newSort: SortOrder = [];
                  if (order != undefined) {
                    newSort = [
                      { column, direction: order },
                      ...(sort?.filter((x) => x.column != column) ?? []),
                    ];
                  } else {
                    newSort = sort?.filter((x) => x.column != column) ?? [];
                  }
                  onSortChange(newSort.length === 0 ? undefined : newSort);
                }}
              >
                <div
                  class:text-slate-300={!sortIsPrimary}
                  class:dark:text-slate-600={!sortIsPrimary}
                  class:text-slate-600={sortIsPrimary}
                  class:dark:text-slate-200={sortIsPrimary}
                >
                  {#if sortDir?.desc === false}
                    <IconSortUp />
                  {:else if sortDir?.desc === true}
                    <IconSortDown />
                  {:else}
                    <IconSortUpDown />
                  {/if}
                </div>
              </button>
            </div>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="absolute -right-[5px] top-0.5 bottom-0.5 w-[12px] cursor-col-resize flex items-center justify-center z-20"
              onmousedown={header.getResizeHandler()}
              ontouchstart={header.getResizeHandler()}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize column"
            >
              <div class="w-[2px] h-5 bg-slate-400 dark:bg-slate-500 opacity-20 rounded-sm"></div>
            </div>
          </th>
        {/each}
        <th class="border-b border-slate-200 dark:border-slate-800"></th>
      </tr>
    </thead>
    <tbody>
      {#if paddingTop > 0}
        <tr style:height="{paddingTop}px"><td colspan={visibleColumns.length + 1}></td></tr>
      {/if}
      {#each virtualItems as vRow (vRow.key)}
        {@const row = loader.rowAt(vRow.index)}
        {#if row === "loading" || row === undefined}
          <tr style:height="{vRow.size}px" class="bg-slate-50 dark:bg-slate-900/50 animate-pulse">
            <td colspan={visibleColumns.length + 1} class="px-4 text-xs text-slate-300 dark:text-slate-700">
              <!-- intentional empty content: skeleton row -->
            </td>
          </tr>
        {:else}
          {@const rowId = row.__id__}
          {@const isHL = highlightSet.has(rowId)}
          <tr
            class="{isHL
              ? 'bg-blue-100 dark:bg-blue-950'
              : vRow.index % 2 === 0
                ? 'bg-white dark:bg-black hover:bg-blue-50 dark:hover:bg-blue-950'
                : 'bg-slate-50 dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-blue-950'}"
            style:height="{vRow.size}px"
            onclick={(e) => onRowClick(rowId, e)}
            ondblclick={(e) => onRowDoubleClick(row, e)}
            onmousedown={(e) => {
              if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
            }}
            bind:this={() => idMapper.get(rowId), (v) => {
              if (v) idMapper.set(rowId, v);
              else idMapper.delete(rowId);
            }}
          >
            {#each visibleColumns as column (column)}
              <td
                class="px-4 py-1 text-slate-500 dark:text-slate-400 align-middle truncate {getAlignment(column)}"
                style:max-width="{columnSizing[column] ?? 150}px"
              >
                <ContentRenderer value={row[column]} style={columnStyles[column]} formatter={columnFormatters[column]} />
              </td>
            {/each}
            <td></td>
          </tr>
        {/if}
      {/each}
      {#if paddingBottom > 0}
        <tr style:height="{paddingBottom}px"><td colspan={visibleColumns.length + 1}></td></tr>
      {/if}
    </tbody>
  </table>
</div>
