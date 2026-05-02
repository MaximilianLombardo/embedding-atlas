<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  // The command palette opens above the rest of the viewer when the user
  // presses ⌘K. The body is the command list — chat lives in the tab next
  // to the table, not here. See `commands/builtin.ts` for the registry.
  import { Command } from "cmdk-sv";
  import { type Snippet } from "svelte";

  import { IconClose } from "../assets/icons.js";

  import { groupCommands, type Command as ViewerCommand } from "../commands/builtin.js";

  interface Props {
    open: boolean;
    onClose: () => void;
    commands: ViewerCommand[];
    /** Right-aligned status snippet (row count, predicate, MCP indicator). */
    statusBar?: Snippet;
  }

  let { open = $bindable(), onClose, commands, statusBar }: Props = $props();

  let query = $state("");

  function onPaletteKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
  }

  async function runCommand(cmd: ViewerCommand) {
    onClose();
    await cmd.run();
  }

  let groups = $derived(groupCommands(commands));

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
      style:max-height="60vh"
    >
      <Command.Root class="flex flex-col text-slate-800 dark:text-slate-200" shouldFilter={true} loop={true}>
        <div class="flex items-center gap-2 px-3 border-b border-slate-200 dark:border-slate-700">
          <span class="text-slate-400 dark:text-slate-500 select-none">›</span>
          <Command.Input
            bind:value={query}
            placeholder="Type a command…"
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

        <Command.List class="overflow-auto flex-1 min-h-0 py-1">
          <Command.Empty class="px-3 py-6 text-sm text-slate-500 dark:text-slate-400"
            >No matching commands.</Command.Empty
          >
          {#each groups as { group, items } (group)}
            <Command.Group heading={group} class="px-1 py-1">
              <div class="px-2 py-1 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 select-none">
                {group}
              </div>
              {#each items as cmd (cmd.id)}
                <Command.Item
                  value={cmd.label}
                  onSelect={() => runCommand(cmd)}
                  class="flex items-center justify-between px-3 py-2 text-sm rounded-md cursor-pointer aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
                >
                  <span>{cmd.label}</span>
                  {#if cmd.hint}
                    <span class="text-xs text-slate-400 dark:text-slate-500">{cmd.hint}</span>
                  {/if}
                </Command.Item>
              {/each}
            </Command.Group>
          {/each}
        </Command.List>
      </Command.Root>
    </div>
  </div>
{/if}
