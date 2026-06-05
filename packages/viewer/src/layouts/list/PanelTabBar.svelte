<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Right-panel tab strip. Hosts the Chat tab (when chat is available)
  plus N user-addable canvas tabs and a trailing "+" affordance.

  Interactions:
   - Click  → activate
   - Dbl-click on a renamable tab → inline rename (input, commit on
     blur/Enter, cancel on Esc)
   - Click the trailing × on a removable tab → delete
   - "+" button → add canvas

  Tabs that are not renamable or removable simply ignore those
  gestures. The Chat tab uses this to be permanent.

  Overflow: tabs use `flex-none` so they keep their width; the outer
  is `overflow-x-auto`, scrolling horizontally when the strip is
  wider than the panel.
-->
<script lang="ts">
  export interface PanelTabInfo {
    id: string;
    label: string;
    kind: "chat" | "canvas";
    renamable: boolean;
    removable: boolean;
  }

  /** Discriminator passed to `onAdd` so the host knows which kind to create. */
  export type AddKind = "chat" | "canvas";

  interface Props {
    tabs: PanelTabInfo[];
    activeId: string;
    onActivate: (id: string) => void;
    /**
     * Called when the user picks an item from the `+` popover.
     * When `chatAvailable` is false the popover collapses to a single
     * "New canvas" item; in that case `kind` is always "canvas".
     */
    onAdd?: (kind: AddKind) => void;
    onRename?: (id: string, name: string) => void;
    onDelete?: (id: string) => void;
    /** Hide the "New chat" item from the `+` popover when false. */
    chatAvailable?: boolean;
  }

  let { tabs, activeId, onActivate, onAdd, onRename, onDelete, chatAvailable = true }: Props = $props();

  // Which tab is currently being renamed inline (null = none).
  let editingId: string | null = $state(null);
  let editingDraft: string = $state("");

  // Add-popover state. Anchored to the `+` button by its DOM rect.
  let addOpen: boolean = $state(false);
  let addAnchor = $state<HTMLButtonElement | null>(null);

  function startEdit(tab: PanelTabInfo) {
    if (!tab.renamable) return;
    editingId = tab.id;
    editingDraft = tab.label;
  }

  function commitEdit() {
    if (editingId == null) return;
    const name = editingDraft.trim();
    const id = editingId;
    editingId = null;
    if (name.length > 0) onRename?.(id, name);
  }

  function cancelEdit() {
    editingId = null;
  }

  function pickAdd(kind: AddKind) {
    addOpen = false;
    onAdd?.(kind);
  }

  function toggleAdd() {
    // Skip the popover when only one option is available — collapses
    // to a plain "add canvas" button.
    if (!chatAvailable) {
      onAdd?.("canvas");
      return;
    }
    addOpen = !addOpen;
  }

  // Anchor position for the add popover, recomputed when it opens.
  let addRect = $derived(addOpen && addAnchor ? addAnchor.getBoundingClientRect() : null);

  // Dismiss the add popover when the user clicks anywhere or hits Escape.
  $effect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.("[data-panel-tabbar-add]")) return;
      addOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") addOpen = false;
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex items-center gap-1 overflow-x-auto overflow-y-hidden select-none scrollbar-thin"
  role="tablist"
>
  {#each tabs as tab (tab.id)}
    {@const isActive = tab.id === activeId}
    {@const isEditing = tab.id === editingId}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role="tab"
      aria-selected={isActive}
      tabindex="0"
      class="flex-none flex items-center gap-1.5 h-[26px] pl-2.5 pr-1.5 rounded-md text-xs border transition cursor-pointer group
        {isActive
          ? 'bg-white dark:bg-black border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-200 shadow-sm'
          : 'bg-slate-100 dark:bg-slate-800/60 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/60'}"
      onclick={() => onActivate(tab.id)}
      ondblclick={() => startEdit(tab)}
    >
      {#if isEditing}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="bg-transparent outline-none text-xs w-24 text-slate-800 dark:text-slate-200"
          bind:value={editingDraft}
          autofocus
          onblur={commitEdit}
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
        />
      {:else}
        <span class="truncate max-w-[140px]">{tab.label}</span>
      {/if}
      {#if tab.removable && !isEditing}
        <!-- Close button. Always rendered for layout stability; muted
             by default, opaque on hover or when the tab is active. -->
        <button
          type="button"
          class="flex-none flex items-center justify-center w-4 h-4 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition opacity-60 group-hover:opacity-100 {isActive
            ? 'opacity-100'
            : ''}"
          title="Close tab"
          aria-label="Close tab"
          onclick={(ev) => {
            ev.stopPropagation();
            onDelete?.(tab.id);
          }}
        >
          ×
        </button>
      {/if}
    </div>
  {/each}

  {#if onAdd}
    <button
      type="button"
      bind:this={addAnchor}
      data-panel-tabbar-add
      class="flex-none flex items-center justify-center h-[26px] w-[26px] rounded-md text-sm
             text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200
             hover:bg-slate-200/70 dark:hover:bg-slate-700/60 transition"
      title="Add tab"
      onclick={toggleAdd}
    >
      +
    </button>
  {/if}
</div>

{#if addOpen && addRect}
  <div
    data-panel-tabbar-add
    class="fixed z-[200] min-w-[140px] rounded-md border border-slate-200 dark:border-slate-700
           bg-white dark:bg-slate-900 shadow-lg py-1 text-xs"
    style:left="{addRect.left}px"
    style:top="{addRect.bottom + 4}px"
  >
    <button
      type="button"
      class="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300
             hover:bg-slate-100 dark:hover:bg-slate-800 transition"
      onclick={() => pickAdd("canvas")}
    >
      New canvas
    </button>
    {#if chatAvailable}
      <button
        type="button"
        class="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300
               hover:bg-slate-100 dark:hover:bg-slate-800 transition"
        onclick={() => pickAdd("chat")}
      >
        New chat
      </button>
    {/if}
  </div>
{/if}
