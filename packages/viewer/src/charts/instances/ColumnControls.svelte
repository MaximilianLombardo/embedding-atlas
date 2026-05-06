<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Per-table column controls list. Designed to be embedded inside the
  page-level settings popover (see EmbeddingAtlas.svelte). Per-row
  controls:
    - drag handle on the left to reorder
    - visibility checkbox
    - column name
    - pin / unpin (left only)

  Drag-reorder lives here (not on the table headers) because HTML5
  DnD on a flex list is tractable while DnD on `<th>` elements
  fights browser drop-position quirks. Headers display the order
  computed from this list.

  All edits flow through callbacks back to the parent (`Instances`),
  which owns columnState; we don't mutate state in place from here.
-->
<script lang="ts">
  import { IconCheck, IconPin, IconPinOff } from "../../assets/icons.js";

  interface Props {
    /** All columns in their *current* (rendered) order. */
    columns: string[];
    /** Map of column → visibility (true = visible). Missing keys default to true. */
    visibility: Record<string, boolean>;
    /** Set of columns pinned to the left (in pin order). */
    pinnedLeft: string[];
    /** Toggle a single column's visibility. */
    onToggleVisibility: (column: string) => void;
    /**
     * Called after a drag-drop reorder with the full new column order.
     * Parent updates its columnState; the table re-renders accordingly.
     */
    onReorder: (newOrder: string[]) => void;
    /** Pin / unpin a column on the left. */
    onTogglePinLeft: (column: string) => void;
  }

  let { columns, visibility, pinnedLeft, onToggleVisibility, onReorder, onTogglePinLeft }: Props = $props();

  function isVisible(col: string): boolean {
    return visibility[col] !== false;
  }
  function isPinnedLeft(col: string): boolean {
    return pinnedLeft.includes(col);
  }

  let draggingFrom = $state<number | null>(null);
  let draggingOver = $state<number | null>(null);

  function onDragStart(index: number, e: DragEvent) {
    draggingFrom = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", columns[index]);
    }
  }

  function onDragOver(index: number, e: DragEvent) {
    if (draggingFrom == null || index === draggingFrom) return;
    e.preventDefault();
    draggingOver = index;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function onDrop(index: number, e: DragEvent) {
    e.preventDefault();
    if (draggingFrom == null || index === draggingFrom) {
      draggingFrom = null;
      draggingOver = null;
      return;
    }
    const next = columns.slice();
    const [moved] = next.splice(draggingFrom, 1);
    next.splice(index, 0, moved);
    draggingFrom = null;
    draggingOver = null;
    onReorder(next);
  }

  function onDragEnd() {
    draggingFrom = null;
    draggingOver = null;
  }
</script>

<div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
  <div class="text-xs font-medium text-slate-500 dark:text-slate-400 px-1 py-0.5">
    Columns ({columns.filter(isVisible).length}/{columns.length})
  </div>
  {#each columns as col, i (col)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 group"
      class:opacity-50={draggingFrom === i}
      class:ring-1={draggingOver === i}
      class:ring-blue-500={draggingOver === i}
      draggable="true"
      ondragstart={(e) => onDragStart(i, e)}
      ondragover={(e) => onDragOver(i, e)}
      ondrop={(e) => onDrop(i, e)}
      ondragend={onDragEnd}
      role="listitem"
    >
      <span
        class="text-slate-400 dark:text-slate-600 cursor-grab select-none flex-shrink-0 px-1 leading-none text-sm"
        title="Drag to reorder">⋮⋮</span
      >
      <button
        type="button"
        class="flex items-center gap-2 flex-1 min-w-0 text-left text-sm text-slate-700 dark:text-slate-200"
        onclick={() => onToggleVisibility(col)}
      >
        <span
          class="inline-flex items-center justify-center w-4 h-4 rounded border flex-shrink-0"
          class:border-slate-400={isVisible(col)}
          class:bg-blue-500={isVisible(col)}
          class:dark:bg-blue-600={isVisible(col)}
          class:border-blue-500={isVisible(col)}
          class:dark:border-blue-600={isVisible(col)}
          class:border-slate-300={!isVisible(col)}
          class:dark:border-slate-600={!isVisible(col)}
        >
          {#if isVisible(col)}
            <span class="text-white text-xs leading-none">
              <IconCheck />
            </span>
          {/if}
        </span>
        <span class="truncate">{col}</span>
      </button>
      <button
        type="button"
        class="flex-shrink-0 p-1 rounded hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-400 dark:text-slate-500"
        class:text-blue-500={isPinnedLeft(col)}
        class:dark:text-blue-400={isPinnedLeft(col)}
        onclick={() => onTogglePinLeft(col)}
        title={isPinnedLeft(col) ? "Unpin from left" : "Pin to left"}
      >
        {#if isPinnedLeft(col)}
          <IconPin />
        {:else}
          <IconPinOff />
        {/if}
      </button>
    </div>
  {/each}
</div>
