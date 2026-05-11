<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Right-side detail drawer for a single row.

  Renders the row's content via DetailContent (sectioned, type-aware)
  rather than TooltipContent (curated preview). Both the table's row
  double-click and the embedding tooltip's "Open detail" button feed
  it through context.detailRow (lifted out of Instances.svelte).
-->
<script lang="ts">
  import { fade, slide } from "svelte/transition";

  import DetailContent from "../../views/DetailContent.svelte";

  import { IconClose, IconTable } from "../../assets/icons.js";
  import type { ColumnStyle } from "../../renderers/types.js";

  interface Props {
    /** Row record. Drawer is shown when non-null. */
    row: Record<string, any> | null;
    /** Row id column name — needed to compute the "Show in table" target id. */
    idColumn: string;
    columns: string[];
    columnStyles: Record<string, ColumnStyle>;
    onClose: () => void;
    /** "Show in table" callback — host scrolls table to the row id and
     *  closes the drawer. When omitted, the button isn't rendered. */
    onShowInTable?: (id: any) => void;
  }

  let { row, idColumn, columns, columnStyles, onClose, onShowInTable }: Props = $props();

  $effect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if row != null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex justify-end">
    <div
      class="absolute inset-0 bg-black/30 dark:bg-black/50"
      transition:fade={{ duration: 150 }}
      onclick={onClose}
    ></div>

    <div
      class="relative w-full max-w-lg h-full bg-white dark:bg-slate-900 shadow-xl border-l border-slate-200 dark:border-slate-700 flex flex-col"
      transition:slide={{ axis: "x", duration: 250 }}
    >
      <!-- Sticky header: stays visible as the body scrolls. Drops the
           redundant "Row details" label — the row's own title is the
           dominant element right below. Action buttons (Show-in-table,
           Close) sit on the right with matching bordered-pill chrome
           so they read as a coherent action set. -->
      <div
        class="sticky top-0 z-10 flex items-center justify-end gap-1 px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm"
      >
        {#if onShowInTable}
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition"
            onclick={() => onShowInTable?.(row?.[idColumn])}
            title="Scroll the table to this row"
          >
            <IconTable class="w-3.5 h-3.5" />
            Show in table
          </button>
        {/if}
        <button
          type="button"
          class="flex items-center gap-1 p-1 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition"
          onclick={onClose}
          title="Close (Esc)"
        >
          <IconClose class="w-3.5 h-3.5" />
        </button>
      </div>
      <div class="flex-1 overflow-auto p-4">
        <DetailContent values={row} columns={columns} columnStyles={columnStyles} />
      </div>
    </div>
  </div>
{/if}
