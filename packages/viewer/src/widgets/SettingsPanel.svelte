<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Inline left-side settings panel that hosts atlas-level settings.
  Counterpart to the right-side charts panel — a normal flex item
  the parent toggles by setting `width` (0 to collapse, target px
  to expand). Replaces the previous absolute-positioned overlay
  drawer (`SettingsDrawer.svelte`).

  Layout:
    ┌──────────────────────────────────────┐
    │ Settings                             │  ← header
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
  - The panel stays mounted across open/close so the contributed
    snippets keep their internal state. Visibility is animated by
    transitioning `width` from 0 to the target width and back.
  - `overflow-hidden` on the wrapper means setting `width: 0` cleanly
    clips the inner content (which has fixed sub-widths like the
    64px tab strip) instead of letting it spill into the next
    flex sibling.
  - The close-X button has moved out of the panel into the icon
    strip on the panel's left edge — the same gear button that
    opens the panel toggles it shut. ESC also closes via the
    `onClose` callback (the parent decides what "close" means;
    typically it sets width to 0).
  - Chart-scoped tab content is supplied by the host through
    `chartGroups`, which mirrors the previous popover's contract;
    the registration plumbing in `ChartDelegate.settingsContent`
    is unchanged. Each group's `key` is the host's chart id, used
    as the persisted active-tab token.
-->
<script lang="ts">
  import type { Component, Snippet } from "svelte";

  import { IconSettings } from "../assets/icons.js";

  interface ChartGroup {
    key: string;
    title: string;
    /** Optional Svelte icon component for the tab strip. */
    icon?: Component<{ class?: string }> | undefined;
    content: Snippet;
  }

  interface Props {
    /**
     * Current rendered width in px. The parent toggles open/close
     * by animating this between 0 and the target width.
     */
    width: number;
    /**
     * Called when the user presses ESC while the panel is open.
     * The parent decides what "close" means (typically: set width
     * to 0).
     */
    onClose: () => void;
    /** Snippet for the always-present Global tab. */
    globalContent: Snippet;
    /**
     * Page-level (host-owned) groups. Rendered in the tab strip
     * directly after Global, before any chart-contributed groups.
     * Used for atlas-scoped settings that aren't tied to a specific
     * chart — e.g. Search.
     */
    pageGroups?: ChartGroup[];
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

  let {
    width,
    onClose,
    globalContent,
    pageGroups = [],
    chartGroups,
    activeKey,
    onActiveKeyChange,
    mcpStatus,
    version,
  }: Props = $props();

  // Keep activeKey valid. If the tab whose key is selected disappears
  // (chart unmounts or a page group is removed), fall back to Global.
  let activeKeyValid = $derived(
    activeKey === "global" || pageGroups.some((g) => g.key === activeKey) || chartGroups.some((g) => g.key === activeKey),
  );
  $effect(() => {
    if (!activeKeyValid) onActiveKeyChange("global");
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && width > 0) {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="flex-none flex flex-col bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 overflow-hidden"
  style:width="{width}px"
  style:transition="width 220ms ease-out"
  aria-hidden={width === 0}
>
  <!-- Header -->
  <div
    class="h-12 flex-none px-3 flex items-center border-b border-slate-300 dark:border-slate-600"
  >
    <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100 px-1">Settings</h2>
  </div>

  <!-- Body: vertical tab strip + tab content -->
  <div class="flex-1 flex min-h-0">
    <div
      class="w-16 flex-none bg-slate-100 dark:bg-slate-800 border-r border-slate-300 dark:border-slate-600 py-2 flex flex-col gap-0.5 overflow-y-auto"
    >
      <button
        type="button"
        onclick={() => onActiveKeyChange("global")}
        class="h-16 flex flex-col items-center justify-center gap-1 transition border-l-[3px] focus-visible:outline-2 outline-blue-600 -outline-offset-1"
        class:bg-white={activeKey === "global"}
        class:dark:bg-slate-900={activeKey === "global"}
        class:border-blue-500={activeKey === "global"}
        class:border-transparent={activeKey !== "global"}
        class:text-blue-600={activeKey === "global"}
        class:dark:text-blue-400={activeKey === "global"}
        class:text-slate-500={activeKey !== "global"}
        class:dark:text-slate-400={activeKey !== "global"}
        class:hover:text-slate-700={activeKey !== "global"}
        class:dark:hover:text-slate-200={activeKey !== "global"}
      >
        <IconSettings class="w-5 h-5" />
        <span
          class="block text-[11px] font-medium leading-tight max-w-[56px] truncate"
        >
          Global
        </span>
      </button>
      {#each pageGroups as group (group.key)}
        {@render tabButton(group)}
      {/each}
      {#each chartGroups as group (group.key)}
        {@render tabButton(group)}
      {/each}
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      {#if activeKey === "global"}
        {@render globalContent()}
      {:else}
        {@const group =
          pageGroups.find((g) => g.key === activeKey) ?? chartGroups.find((g) => g.key === activeKey)}
        {#if group}
          {@render group.content()}
        {/if}
      {/if}
    </div>
  </div>

  <!-- Footer: MCP status (left) + version (right). Stays visible
       regardless of selected tab so atlas-level meta is always at
       hand. When no MCP is configured, the indicator is rendered
       in a muted "off" state rather than hidden, so the footer
       always communicates atlas status. -->
  <div
    class="h-8 flex-none px-3 flex items-center justify-between border-t border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50 text-xs"
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
      {:else}
        <div class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
        <span class="text-slate-400 dark:text-slate-500">MCP off</span>
      {/if}
    </div>
    <span class="text-slate-400 dark:text-slate-500">v{version}</span>
  </div>
</div>

{#snippet tabButton(group: ChartGroup)}
  {@const isActive = activeKey === group.key}
  {@const Icon = group.icon}
  <button
    type="button"
    onclick={() => onActiveKeyChange(group.key)}
    title={group.title}
    class="h-16 flex flex-col items-center justify-center gap-1 transition border-l-[3px] px-1 focus-visible:outline-2 outline-blue-600 -outline-offset-1"
    class:bg-white={isActive}
    class:dark:bg-slate-900={isActive}
    class:border-blue-500={isActive}
    class:border-transparent={!isActive}
    class:text-blue-600={isActive}
    class:dark:text-blue-400={isActive}
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
    <!-- block + truncate keeps long titles inside the 56px content
         box (parent button is 64px wide, px-1 strips 8px). Inline
         spans ignore max-width, so a bare span would let titles
         like "Embedding" overflow. -->
    <span class="block text-[10px] font-medium leading-tight text-center max-w-[56px] truncate">
      {group.title}
    </span>
  </button>
{/snippet}
