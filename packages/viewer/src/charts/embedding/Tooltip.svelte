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
</script>

<div class="embedding-atlas-root">
  <div
    class="p-2 border flex flex-col gap-2 border-slate-300 dark:border-slate-600 shadow-md text-slate-700 dark:text-slate-300 rounded-md text-ellipsis overflow-x-hidden overflow-y-scroll bg-white/75 dark:bg-slate-800/75 backdrop-blur-sm"
    class:dark={colorScheme == "dark"}
    style:max-width="400px"
    style:max-height="300px"
  >
    {#if hasActions}
      <div class="flex flex-row gap-3 pb-2 border-b border-slate-200 dark:border-slate-700">
        {#if onNearestNeighborSearch}
          <button
            class="text-sm flex gap-1 items-center text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            onclick={() => onNearestNeighborSearch?.(tooltip.identifier)}
          >
            <IconSearch /> Neighbors
          </button>
        {/if}
        {#if onOpenDetail}
          <button
            class="text-sm flex gap-1 items-center text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            onclick={() => onOpenDetail?.(tooltip)}
          >
            <IconRight /> Open detail
          </button>
        {/if}
      </div>
    {/if}
    <TooltipContent values={tooltip.fields ?? {}} columnStyles={columnStyles ?? {}} />
  </div>
</div>
