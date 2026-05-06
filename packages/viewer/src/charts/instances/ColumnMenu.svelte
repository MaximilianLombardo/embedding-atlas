<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Per-table column menu. Triggered by an IconMenu button in the
  Instances toolbar. Shows every column with a visibility checkbox.
  Steps C/D will add drag-handles for reorder and pin/unpin toggles
  in this same panel.

  Visibility commits on click directly to a `onToggleVisibility(col)`
  callback — the parent owns column state, so we don't try to reach
  into it from here. Same for the Export CSV item: parent does the
  Mosaic call + download.
-->
<script lang="ts">
  import PopupButton from "../../widgets/PopupButton.svelte";

  import { IconCheck, IconExport, IconMenu } from "../../assets/icons.js";

  interface Props {
    /** All columns in their *current* (rendered) order. */
    columns: string[];
    /** Map of column → visibility (true = visible). Missing keys default to true. */
    visibility: Record<string, boolean>;
    /** Toggle a single column's visibility. */
    onToggleVisibility: (column: string) => void;
    /**
     * Trigger a CSV export of currently-filtered rows. Parent runs
     * the Mosaic COPY query and the browser download. When undefined,
     * the Export item is hidden (e.g. for custom-spec.query mode
     * where the predicate set isn't well-defined).
     */
    onExportCsv?: () => void;
  }

  let { columns, visibility, onToggleVisibility, onExportCsv }: Props = $props();

  function isVisible(col: string): boolean {
    return visibility[col] !== false;
  }
</script>

<PopupButton icon={IconMenu} title="Columns" anchor="left">
  <div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto min-w-48">
    <div class="text-xs font-medium text-slate-500 dark:text-slate-400 px-2 py-1">
      Columns ({columns.filter(isVisible).length}/{columns.length})
    </div>
    {#each columns as col (col)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <button
        type="button"
        class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-left text-sm text-slate-700 dark:text-slate-200"
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
    {/each}
    {#if onExportCsv}
      <div class="border-t border-slate-300 dark:border-slate-600 my-1"></div>
      <button
        type="button"
        class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-left text-sm text-slate-700 dark:text-slate-200"
        onclick={onExportCsv}
        title="Export rows matching the current filter as CSV"
      >
        <span class="inline-flex items-center justify-center w-4 h-4 flex-shrink-0 text-slate-500 dark:text-slate-400">
          <IconExport />
        </span>
        <span>Export CSV</span>
      </button>
    {/if}
  </div>
</PopupButton>
