<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Card view of records, 2D-virtualized via @tanstack/svelte-virtual's
  `lanes` API.

  v1 (already shipped) capped at 1000 rows with a notice; this lifts
  the cap and renders against the full totalCount. The lane count is
  recomputed from the container width on resize, so the grid still
  feels responsive across viewport sizes.

  Architecture notes:
  - The virtualizer treats the dataset as 1D (count = totalCount) but
    distributes virtual items across `lanes` columns. Each item gets
    a `lane` index (0..lanes-1) and a `start` offset (Y).
  - We position each rendered card with absolute positioning +
    `transform: translate3d(...)` so the table-style padding-row
    pattern doesn't apply here (it's not document flow anyway).
  - Card height is fixed at 200px in v1. Variable height (per
    cardTemplate render shape) via `measureElement` is a follow-up;
    fixed gives us a clean O(1) virtualizer fast-path and matches
    the pre-2D Cards visual cadence.
-->
<script lang="ts">
  import { createVirtualizer, type SvelteVirtualizer } from "@tanstack/svelte-virtual";
  import { untrack } from "svelte";

  import TooltipContent from "../../views/TooltipContent.svelte";

  import type { ColumnStyle } from "../../renderers/types.js";
  import { compileLiquidTemplate } from "../../utils/html_template.js";
  import type { RowID } from "../chart.js";
  import type { WindowLoader } from "./lib/window_loader.svelte.js";

  interface Props {
    loader: WindowLoader;
    columnStyles: Record<string, ColumnStyle>;
    highlight: RowID[] | null;
    cardTemplate?: string;
    onRowClick: (rowId: RowID | null | undefined, event: MouseEvent) => void;
  }

  /** Card dimensions. Fixed for v1 — see comment block above. */
  const CARD_MIN_WIDTH = 300;
  const CARD_HEIGHT = 200;
  const GAP = 8;

  let { loader, columnStyles, highlight, cardTemplate, onRowClick }: Props = $props();

  let highlightSet = $derived(new Set(highlight));
  let idMapper = new Map<RowID, Element>();

  let compiledTemplate = $derived(cardTemplate != null ? compileLiquidTemplate(cardTemplate) : undefined);

  let scrollEl = $state.raw<HTMLDivElement | undefined>(undefined);
  let containerWidth = $state(0);

  // Lane count = max columns that fit at the current width. Updated by
  // a ResizeObserver on the scroll container so resizing the browser
  // smoothly reflows.
  let lanes = $derived(Math.max(1, Math.floor((containerWidth + GAP) / (CARD_MIN_WIDTH + GAP))));
  // Card width fills the column at the current lane count.
  let cardWidth = $derived(lanes > 0 ? (containerWidth - GAP * (lanes - 1)) / lanes : CARD_MIN_WIDTH);

  // Mirror Table.svelte's virtualizer-tick pattern: subscribe to the
  // store and bump a counter so $derived reads of getVirtualItems /
  // getTotalSize re-fire on range change.
  // svelte-ignore state_referenced_locally
  const virtualizerStore = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: loader.totalCount,
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => CARD_HEIGHT + GAP,
    overscan: 4,
    lanes: 1,
  });
  let virtualizer: SvelteVirtualizer<HTMLDivElement, HTMLDivElement> | undefined;
  let virtualizerTick = $state(0);

  $effect(() => {
    return virtualizerStore.subscribe((v) => {
      untrack(() => {
        virtualizer = v;
        virtualizerTick++;
      });
    });
  });

  // Push count + lanes into the virtualizer when they change. Wrap in
  // untrack so this effect's only deps are loader.totalCount and
  // lanes — no feedback loop through the tick.
  $effect(() => {
    const count = loader.totalCount;
    const l = lanes;
    untrack(() => {
      virtualizer?.setOptions({ count, lanes: l });
    });
  });

  // Tell the loader the visible range. With lanes=N, virtualizer.range
  // covers a Y-range of card rows; the actual *index* range is
  // startIndex..endIndex (already 1D).
  $effect(() => {
    void virtualizerTick;
    untrack(() => {
      if (!virtualizer) return;
      const r = virtualizer.range;
      if (r) loader.ensureRange(r.startIndex, r.endIndex);
    });
  });

  let virtualItems = $derived.by(() => {
    void virtualizerTick;
    return virtualizer?.getVirtualItems() ?? [];
  });
  let totalSize = $derived.by(() => {
    void virtualizerTick;
    return virtualizer?.getTotalSize() ?? 0;
  });

  // Track the scroll container's width via ResizeObserver. Drives the
  // lane recomputation above without depending on Svelte's clientWidth
  // bindings (which can lag during transitions).
  $effect(() => {
    if (!scrollEl) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w !== containerWidth) containerWidth = w;
    });
    ro.observe(scrollEl);
    return () => ro.disconnect();
  });

  // Exposed for the embedding-click reveal contract. Cards is now
  // virtualized — getElementForId is async and waits for the card to
  // land in the DOM after a scroll, mirroring the Table's contract.
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

  /** Spec-compatible imperative scroll. animateToPoint may target a
   * specific row via offsetForId — Cards now supports that too. */
  export function scrollToIndex(index: number, align: "start" | "center" | "end" = "center"): void {
    if (index === 0 && align === "start") {
      if (scrollEl) scrollEl.scrollTop = 0;
      return;
    }
    virtualizer?.scrollToIndex(index, { align });
  }
</script>

<div class="w-full h-full overflow-auto p-2" bind:this={scrollEl}>
  {#if containerWidth > 0 && totalSize > 0}
    <div class="relative" style:height="{totalSize}px">
      {#each virtualItems as vItem (vItem.key)}
        {@const row = loader.rowAt(vItem.index)}
        {@const rowId = typeof row === "object" && row != null ? (row as any).__id__ : null}
        {@const lane = vItem.lane ?? 0}
        <div
          class="absolute"
          style:transform="translate3d({lane * (cardWidth + GAP)}px, {vItem.start}px, 0)"
          style:width="{cardWidth}px"
          style:height="{CARD_HEIGHT}px"
        >
          {#if row === "loading" || row === undefined}
            <div
              class="w-full h-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 animate-pulse"
            ></div>
          {:else}
            {@const values = Object.fromEntries(loader.columns.map((col) => [col, row[col]]))}
            {@const highlighted = highlightSet.has(rowId)}
            <button
              bind:this={
                () => idMapper.get(rowId),
                (v) => {
                  if (v) idMapper.set(rowId, v);
                  else idMapper.delete(rowId);
                }
              }
              class="flex items-stretch flex-col border rounded-lg transition-all hover:shadow-md bg-white dark:bg-slate-800 text-left w-full h-full select-text appearance-none overflow-auto"
              class:border-slate-200={!highlighted}
              class:dark:border-slate-700={!highlighted}
              class:border-blue-500={highlighted}
              class:ring-1={highlighted}
              class:ring-blue-500={highlighted}
              onmousedown={(e) => {
                if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
              }}
              onclick={(e) => onRowClick(rowId, e)}
            >
              {#if compiledTemplate != null}
                {@html compiledTemplate(values)}
              {:else}
                <div class="w-full p-3">
                  <TooltipContent values={values} columns={loader.columns} columnStyles={columnStyles} />
                </div>
              {/if}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
