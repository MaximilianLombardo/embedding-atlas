<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Right-side detail drawer for a single row (D3 in the rebuild design).

  Replaces the pre-rebuild "click ↘ to expand a clipped cell" affordance:
  one click chevron showed only the column the user clicked on, often
  not the column they actually wanted to read. The drawer surfaces ALL
  fields of the row at once, formatted by the same `ColumnStyle` rules
  the table uses.

  State lives in `Instances.svelte` so the drawer survives table
  refetches (filter changes, sort changes, etc.). Nothing in the drawer
  drives Mosaic state — it's read-only.
-->
<script lang="ts">
  import TooltipContent from "../../views/TooltipContent.svelte";

  import { IconClose } from "../../assets/icons.js";
  import type { ColumnStyle } from "../../renderers/types.js";

  interface Props {
    /** Row record, e.g. `{ __id__: "...", title: "...", ... }`. Drawer is shown when non-null. */
    row: Record<string, any> | null;
    columns: string[];
    columnStyles: Record<string, ColumnStyle>;
    onClose: () => void;
  }

  let { row, columns, columnStyles, onClose }: Props = $props();

  // ESC-to-close. The handler is a window listener so it fires even
  // when the drawer's panel doesn't have keyboard focus (e.g. user
  // double-clicked a row and started reading without clicking inside
  // the drawer).
  $effect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Strip __id__ and other __-prefixed columns from the display set —
  // they're internal plumbing, not user-facing fields.
  let displayColumns = $derived(columns.filter((c) => !c.startsWith("__")));
</script>

{#if row != null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex justify-end"
    onclick={(e) => {
      // Close when clicking the backdrop, not the panel.
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/30 dark:bg-black/50"></div>

    <!-- Panel -->
    <div
      class="relative w-full max-w-md h-full bg-white dark:bg-slate-900 shadow-xl border-l border-slate-200 dark:border-slate-700 flex flex-col"
    >
      <div class="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-700">
        <div class="text-sm font-medium text-slate-700 dark:text-slate-200">Row details</div>
        <button
          class="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
          onclick={onClose}
          title="Close (Esc)"
        >
          <IconClose />
        </button>
      </div>
      <div class="flex-1 overflow-auto p-4">
        <TooltipContent values={row} columns={displayColumns} columnStyles={columnStyles} />
      </div>
    </div>
  </div>
{/if}
