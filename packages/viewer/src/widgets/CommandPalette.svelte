<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  // The command palette opens above the rest of the viewer when the user presses
  // ⌘K. For now it is a chat-only surface; the cmdk-sv list structure is kept so
  // synchronous commands (toggle layout, export, run SQL, …) can be appended
  // later as plain `<Command.Item>` children.
  import { Command } from "cmdk-sv";
  import { type Snippet } from "svelte";

  import { IconClose } from "../assets/icons.js";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Right-aligned status snippet (row count, predicate, MCP indicator). */
    statusBar?: Snippet;
    /** Body content; rendered below the input and replaces the empty list. */
    body?: Snippet<[{ query: string }]>;
  }

  let { open = $bindable(), onClose, statusBar, body }: Props = $props();

  let query = $state("");

  function onPaletteKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
  }

  // Reset the query when the palette is closed so the next open is fresh.
  $effect(() => {
    if (!open) {
      query = "";
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40 backdrop-blur-sm"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    onkeydown={onPaletteKeydown}
  >
    <div
      class="w-full max-w-2xl mx-4 rounded-lg shadow-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden flex flex-col"
      style:max-height="70vh"
    >
      <Command.Root class="flex flex-col h-full text-slate-800 dark:text-slate-200" shouldFilter={true}>
        <div class="flex items-center gap-2 px-3 border-b border-slate-200 dark:border-slate-700">
          <span class="text-slate-400 dark:text-slate-500 select-none">›</span>
          <Command.Input
            bind:value={query}
            placeholder="Ask Claude about your selection, or type a command…"
            class="flex-1 py-3 bg-transparent outline-none text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500"
            autofocus
          />
          {#if statusBar}
            <div class="text-xs text-slate-500 dark:text-slate-400 select-none">
              {@render statusBar()}
            </div>
          {/if}
          <button
            title="Close"
            onclick={onClose}
            class="rounded-md p-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <IconClose class="w-4 h-4" />
          </button>
        </div>

        <!-- min-h-0 unblocks the flex chain so the body's own overflow-auto
             actually scrolls instead of pushing the modal taller. -->
        <div class="flex-1 min-h-0 flex flex-col">
          {#if body}
            {@render body({ query })}
          {:else}
            <Command.List class="overflow-auto">
              <Command.Empty class="px-3 py-6 text-sm text-slate-500 dark:text-slate-400">
                No commands available yet.
              </Command.Empty>
            </Command.List>
          {/if}
        </div>
      </Command.Root>
    </div>
  </div>
{/if}
