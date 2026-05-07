<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Right-edge overlay drawer that hosts the atlas-level settings.
  Replaces the previous `PopupButton`-based settings popover.

  Layout:
    ┌──────────────────────────────────────┐
    │ Settings                         [×] │  ← header
    ├──┬───────────────────────────────────┤
    │⊕ │                                   │
    │  │  Tab body                         │  ← tab strip (left,
    │⊞◀│                                   │     active=Table)
    │  │                                   │
    │◉ │                                   │
    ├──┴───────────────────────────────────┤
    │ ● MCP connected             v0.20.0  │  ← footer
    └──────────────────────────────────────┘

  Notable behaviors:
  - The drawer stays mounted across open/close so the contributed
    snippets keep their internal state (the same reason
    ListLayout.svelte's table panel is now always-mounted —
    avoiding the mount/unmount cost on every toggle). Visibility
    is animated by `transform: translateX(...)` on the wrapper.
  - No backdrop scrim. The drawer overlays the right edge of the
    atlas, but clicks elsewhere don't auto-close it; the user can
    leave it open while configuring and watch the chart react.
    Close via the X button or the ESC key.
  - Chart-scoped tab content is supplied by the host through
    `chartGroups`, which mirrors the previous popover's contract;
    the registration plumbing in `ChartDelegate.settingsContent`
    is unchanged. Each group's `key` is the host's chart id, used
    as the persisted active-tab token.
-->
<script lang="ts">
  import type { Component, Snippet } from "svelte";

  import { IconClose, IconSettings } from "../assets/icons.js";

  interface ChartGroup {
    key: string;
    title: string;
    /** Optional Svelte icon component for the tab strip. */
    icon?: Component<{ class?: string }> | undefined;
    content: Snippet;
  }

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Snippet for the always-present Global tab. */
    globalContent: Snippet;
    /** Chart-contributed groups, in registration (layout) order. */
    chartGroups: ChartGroup[];
    /** Caller-controlled active tab key. "global" or a chart key. */
    activeKey: string;
    onActiveKeyChange: (key: string) => void;
    /** MCP status for the footer. */
    mcpStatus?: string;
    /** Atlas version for the footer. */
    version: string;
  }

  let { open, onClose, globalContent, chartGroups, activeKey, onActiveKeyChange, mcpStatus, version }: Props = $props();

  // Keep activeKey valid. If a chart whose tab was selected leaves
  // the layout, fall back to Global so the body always has
  // something to render.
  let activeKeyValid = $derived(activeKey === "global" || chartGroups.some((g) => g.key === activeKey));
  $effect(() => {
    if (!activeKeyValid) onActiveKeyChange("global");
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="absolute top-0 right-0 bottom-0 z-30 w-[400px] flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-xl"
  style:transform={open ? "translateX(0)" : "translateX(calc(100% + 8px))"}
  style:transition="transform 220ms ease-out"
  style:pointer-events={open ? "auto" : "none"}
  aria-hidden={!open}
>
  <!-- Header -->
  <div
    class="h-12 flex-none px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-700"
  >
    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
    <button
      type="button"
      onclick={onClose}
      title="Close (Esc)"
      class="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-2 outline-blue-600 -outline-offset-1"
    >
      <IconClose class="w-5 h-5" />
    </button>
  </div>

  <!-- Body: vertical tab strip + tab content -->
  <div class="flex-1 flex min-h-0">
    <div
      class="w-16 flex-none bg-slate-50 dark:bg-slate-800/50 border-r border-slate-200 dark:border-slate-700 py-2 flex flex-col gap-0.5 overflow-y-auto"
    >
      <button
        type="button"
        onclick={() => onActiveKeyChange("global")}
        class="h-16 flex flex-col items-center justify-center gap-1 transition border-l-[3px]"
        class:bg-blue-50={activeKey === "global"}
        class:dark:bg-blue-900={activeKey === "global"}
        class:border-blue-500={activeKey === "global"}
        class:border-transparent={activeKey !== "global"}
        class:text-blue-700={activeKey === "global"}
        class:dark:text-blue-300={activeKey === "global"}
        class:text-slate-500={activeKey !== "global"}
        class:dark:text-slate-400={activeKey !== "global"}
        class:hover:text-slate-700={activeKey !== "global"}
        class:dark:hover:text-slate-200={activeKey !== "global"}
      >
        <IconSettings class="w-5 h-5" />
        <span class="text-[11px] font-medium leading-tight">Global</span>
      </button>
      {#each chartGroups as group (group.key)}
        {@const isActive = activeKey === group.key}
        {@const Icon = group.icon}
        <button
          type="button"
          onclick={() => onActiveKeyChange(group.key)}
          title={group.title}
          class="h-16 flex flex-col items-center justify-center gap-1 transition border-l-[3px] px-1"
          class:bg-blue-50={isActive}
          class:dark:bg-blue-900={isActive}
          class:border-blue-500={isActive}
          class:border-transparent={!isActive}
          class:text-blue-700={isActive}
          class:dark:text-blue-300={isActive}
          class:text-slate-500={!isActive}
          class:dark:text-slate-400={!isActive}
          class:hover:text-slate-700={!isActive}
          class:dark:hover:text-slate-200={!isActive}
        >
          {#if Icon}
            <Icon class="w-5 h-5" />
          {:else}
            <div class="w-1.5 h-1.5 rounded-full bg-current opacity-60"></div>
          {/if}
          <span class="text-[10px] font-medium leading-tight text-center max-w-[56px] truncate">
            {group.title}
          </span>
        </button>
      {/each}
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      {#if activeKey === "global"}
        {@render globalContent()}
      {:else}
        {@const group = chartGroups.find((g) => g.key === activeKey)}
        {#if group}
          {@render group.content()}
        {/if}
      {/if}
    </div>
  </div>

  <!-- Footer: MCP status (left) + version (right). Stays visible
       regardless of selected tab so atlas-level meta is always at
       hand. -->
  <div
    class="h-8 flex-none px-4 flex items-center justify-between border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30 text-xs"
  >
    <div class="flex items-center gap-1.5">
      {#if mcpStatus === "connecting"}
        <div class="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></div>
        <span class="text-slate-500 dark:text-slate-400">MCP connecting…</span>
      {:else if mcpStatus === "connected"}
        <div class="w-1.5 h-1.5 rounded-full bg-green-500"></div>
        <span class="text-slate-500 dark:text-slate-400">MCP connected</span>
      {:else if mcpStatus === "closed" || mcpStatus === "error"}
        <div class="w-1.5 h-1.5 rounded-full bg-red-500"></div>
        <span class="text-slate-500 dark:text-slate-400">MCP error</span>
      {/if}
    </div>
    <span class="text-slate-400 dark:text-slate-500">v{version}</span>
  </div>
</div>
