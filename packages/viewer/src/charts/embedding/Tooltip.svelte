<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import type { DataPoint } from "@embedding-atlas/component";

  import TooltipContent from "../../views/TooltipContent.svelte";

  import { IconRight, IconSearch } from "../../assets/icons.js";
  import type { ColumnStyle } from "../../renderers/types.js";

  interface Props {
    tooltip: DataPoint;
    columnStyles?: Record<string, ColumnStyle>;
    colorScheme: "light" | "dark";
    onNearestNeighborSearch?: (id: any) => void;
    onOpenDetail?: (point: DataPoint) => void;
  }

  let { tooltip, columnStyles, colorScheme, onNearestNeighborSearch, onOpenDetail }: Props = $props();

  let hasActions = $derived(onNearestNeighborSearch != null || onOpenDetail != null);

  const pillClass =
    "flex items-center gap-1 px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-600 " +
    "bg-white/60 dark:bg-slate-900/60 text-xs font-medium text-slate-600 dark:text-slate-300 " +
    "hover:bg-slate-100 dark:hover:bg-slate-700/60 hover:text-slate-900 dark:hover:text-slate-100 transition";
</script>

<div class="embedding-atlas-root">
  <div
    class="p-2 border flex flex-col gap-2 border-slate-300 dark:border-slate-600 shadow-md text-slate-700 dark:text-slate-300 rounded-md text-ellipsis overflow-x-hidden overflow-y-auto bg-white/85 dark:bg-slate-800/85 backdrop-blur-sm"
    class:dark={colorScheme == "dark"}
    style:max-width="380px"
    style:max-height="320px"
  >
    <TooltipContent values={tooltip.fields ?? {}} columnStyles={columnStyles ?? {}} mode="preview">
      {#snippet afterHeader()}
        {#if hasActions}
          <div class="flex flex-row gap-2 items-center">
            {#if onNearestNeighborSearch}
              <button
                type="button"
                class={pillClass}
                onclick={() => onNearestNeighborSearch?.(tooltip.identifier)}
                title="Search for nearest neighbors of this point"
              >
                <IconSearch class="w-3.5 h-3.5" />
                Neighbors
              </button>
            {/if}
            {#if onOpenDetail}
              <button
                type="button"
                class={pillClass}
                onclick={() => onOpenDetail?.(tooltip)}
                title="Open the full detail drawer for this row"
              >
                <IconRight class="w-3.5 h-3.5" />
                Open detail
              </button>
            {/if}
          </div>
        {/if}
      {/snippet}
    </TooltipContent>
  </div>
</div>
