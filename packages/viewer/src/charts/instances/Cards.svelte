<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Card view of records.

  Per D5 (design doc), the cards view is capped at the first 1000 rows.
  Cards is for rich per-record presentation of small N — at scale it's
  the table tab the user wants. We surface a "showing first 1000 of N"
  notice when there's more so the cap is visible, not surprising.

  We still consume the same WindowLoader as the table — `ensureRange(0,
  1000)` is called once on mount and the rendered set is whatever sits
  in the loaded window. No 2D virtualization for v1; deferred to the
  future Cards-at-scale workstream.
-->
<script lang="ts">
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

  const CARDS_CAP = 1000;

  let { loader, columnStyles, highlight, cardTemplate, onRowClick }: Props = $props();

  let highlightSet = $derived(new Set(highlight));
  let idMapper = new Map<RowID, Element>();

  let compiledTemplate = $derived(cardTemplate != null ? compileLiquidTemplate(cardTemplate) : undefined);

  // Pull the first CARDS_CAP rows from the loader. The loader's window
  // size may be smaller than CARDS_CAP, so we ask it to extend its
  // window — the loader caps that internally to a single window's
  // worth (windowSize). For v1 that's a known limitation: if a user
  // sets pageSize < 1000 in the spec, only that many cards render.
  // Cards-at-scale gets 2D virtualization in v2.
  $effect(() => {
    if (loader.totalCount > 0) loader.ensureRange(0, Math.min(CARDS_CAP, loader.totalCount));
  });

  let cards = $derived(loader.windowRows.slice(0, CARDS_CAP));

  // Exposed for the embedding-click reveal contract. Cards has no
  // virtualization so the row is always in the DOM if it's within the
  // 1000-row cap.
  // eslint-disable-next-line @typescript-eslint/require-await
  export async function getElementForId(id: RowID): Promise<Element | undefined> {
    return idMapper.get(id);
  }

  // No-op for spec compatibility with Table; Cards doesn't scroll-to-index.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export function scrollToIndex(_index: number, _align?: "start" | "center" | "end"): void {
    /* Cards: no virtualization, no programmatic scroll target. */
  }
</script>

<div class="w-full h-full overflow-auto p-2">
  {#if loader.totalCount > CARDS_CAP}
    <div class="mb-2 px-3 py-1.5 text-xs rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">
      Showing first {CARDS_CAP.toLocaleString()} of {loader.totalCount.toLocaleString()} rows. Refine your filter to see more.
    </div>
  {/if}
  <div class="grid gap-2" style:grid-template-columns="repeat(auto-fill, minmax(300px, 1fr))">
    {#each cards as row}
      {@const rowId = row.__id__}
      {@const values = Object.fromEntries(loader.columns.map((col) => [col, row[col]]))}
      {@const highlighted = highlightSet.has(rowId)}
      <div>
        <button
          bind:this={() => idMapper.get(rowId), (v) => {
            if (v) idMapper.set(rowId, v);
            else idMapper.delete(rowId);
          }}
          class="flex items-stretch flex-col border rounded-lg transition-all hover:shadow-md bg-white dark:bg-slate-800 overflow-hidden text-left w-full select-text appearance-none"
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
            <div class="w-full p-4">
              <TooltipContent values={values} columns={loader.columns} columnStyles={columnStyles} />
            </div>
          {/if}
        </button>
      </div>
    {/each}
  </div>
</div>
