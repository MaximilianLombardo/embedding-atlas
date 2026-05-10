<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Inline left-side settings panel. The host (EmbeddingAtlas) owns
  panel-open state via panelKey; this component just renders the
  active section's content + a header + a footer. Section navigation
  lives in the AtlasIconStrip's tabs section — there is NO internal
  tab strip here.

  Layout:
    ┌──────────────────────────────────────┐
    │ Settings — <active section title>    │  ← header
    ├──────────────────────────────────────┤
    │                                       │
    │   [active section's content snippet]  │  ← body
    │                                       │
    ├──────────────────────────────────────┤
    │ ● MCP connected             v0.20.0  │  ← footer
    └──────────────────────────────────────┘

  - The panel stays mounted across open/close so contributed
    snippets keep their internal state. Visibility is animated by
    transitioning `width` from 0 to the target width and back.
  - `overflow-hidden` on the wrapper means setting `width: 0` cleanly
    clips the inner content (which has fixed sub-widths) instead of
    letting it spill into the next flex sibling.
  - ESC closes via the `onClose` callback (the parent decides what
    "close" means; typically: set panelKey to null).
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface PanelSection {
    key: string;
    title: string;
    content: Snippet;
  }

  interface Props {
    /** Current rendered width in px. The parent toggles open/close
     *  by animating this between 0 and the target width. */
    width: number;
    /** Called when the user presses ESC while the panel is open. */
    onClose: () => void;
    /** All available sections — Global, page-level, chart-level —
     *  flattened. Order is: [global, search, ...chartSettings]. */
    sections: PanelSection[];
    /** Caller-controlled active section key. */
    activeKey: string;
    /** MCP status for the footer. */
    mcpStatus?: string;
    /** Atlas version for the footer. */
    version: string;
  }

  let { width, onClose, sections, activeKey, mcpStatus, version }: Props = $props();

  let active = $derived(sections.find((s) => s.key === activeKey));

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
  <div class="h-12 flex-none px-3 flex items-center border-b border-slate-300 dark:border-slate-600">
    <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100 px-1">
      {#if active}
        Settings — {active.title}
      {:else}
        Settings
      {/if}
    </h2>
  </div>

  <!-- Body: just the active section's content. -->
  <div class="flex-1 overflow-y-auto p-4">
    {#if active}
      {@render active.content()}
    {/if}
  </div>

  <!-- Footer: MCP status (left) + version (right). Always visible
       regardless of selected section. When no MCP is configured,
       the indicator is rendered in a muted "off" state rather than
       hidden, so the footer always communicates atlas status. -->
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
